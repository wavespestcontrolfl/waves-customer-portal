// Real PostgreSQL transactions (rolled back): the production share PAY LINE (payroll-production-share.js, PR 2). A draft pays
// the share on the check for its own pay week, the overtime it causes rides on the same check, finalize freezes the figure
// and its credit snapshot, a changed credit makes the draft stale, a stop that needs review pays $0 and is named on the draft,
// and the statement, CSV, W-2 package and Tech Rewards pay base carry it. All names are synthetic. DATABASE_URL-gated.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = req.headers['x-test-admin'] || null;
    req.techRole = req.headers['x-test-role'] || 'admin';
    // The login's own email: the owner-account predicate reads it (ib-access.js).
    req.technician = { email: req.headers['x-test-email'] || '' };
    next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-payroll');
const { addStaffWorkDays } = require('../utils/staff-time-work-date');
const { getYearStatement } = require('../services/tech-rewards-year-statement');
const { loadFinalizedW2Checks } = require('../services/tax-package-w2');
const { w2PayrollToCSV } = require('../services/csv-generators');
const { readBonusPay } = require('../services/tech-rewards-scoreboard');
const productionSharePay = require('../services/payroll-production-share');
const productionShare = require('../services/production-share');

jest.setTimeout(60000);

const W1 = '2026-09-14'; // Monday; pay Friday 2026-09-25
const LONG_AGO = '2026-01-05';
const noon = (date) => `${date}T16:00:00Z`;

postgres('production share pay line', () => {
  let database;
  let server;
  let baseUrl;
  let trx;
  let phone = 5550900;
  const OLD = {};
  const GATES = ['GATE_PAYROLL', 'GATE_PAYROLL_PRODUCTION_SHARE', 'GATE_PAYROLL_PAY_LINES', 'GATE_PAYROLL_TIME_OFF'];
  const ADMIN_ID = randomUUID();
  const addDays = (ymd, n) => addStaffWorkDays(ymd, n);

  const tech = async (name, patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '20.00', hire_date: LONG_AGO, flsa_overtime_covered: true, ...patch,
    });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const worked = (technicianId, weekStart, regularHours, overtimeHours = 0) => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: (regularHours * 60).toFixed(2), overtime_minutes: (overtimeHours * 60).toFixed(2),
  });
  const customer = async () => {
    const id = randomUUID();
    phone += 1;
    await trx('customers').insert({ id, first_name: 'Sample', phone: `+1941${phone}` });
    return id;
  };
  // One completed route stop priced by the visit ('priced' credit); `price` null = no price on file (needs review).
  const stop = async (technicianId, date, price, sameCustomer = null, patch = {}) => {
    const customerId = sameCustomer || await customer();
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, technician_id: technicianId, scheduled_date: date, service_type: 'General Pest Control',
      status: 'completed', completed_at: noon(date), estimated_price: price == null ? null : price, ...patch,
    });
    await trx('service_records').insert({
      customer_id: customerId, technician_id: technicianId, service_date: date, service_type: patch.service_type || 'General Pest Control',
      scheduled_service_id: id, status: 'completed', structured_notes: JSON.stringify({ visitOutcome: 'completed' }),
    });
    return id;
  };
  const settings = (technicianId, patch = {}) => trx('production_share_settings').insert({
    technician_id: technicianId, from_week: '2026-01-05', rate_bps: 1500, bar_type: 'per_shift', bar_cents: 90000,
    callback_stop_value_cents: 9500, ...patch,
  });
  // Three shifts of one $1,260.00 stop each: $3,780.00 credited, bar 3 x $900 = $2,700.00, $1,080.00 above, 15% = $162.00.
  const threeShifts = async (id) => {
    for (const n of [0, 1, 2]) await stop(id, addDays(W1, n), '1260.00');
  };
  const refused = async (work) => {
    await trx.raw('SAVEPOINT attempt');
    let error;
    try { await work(); } catch (err) { error = err; }
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    return error;
  };
  const api = async (method, path, { body, raw = false } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: response.status, text: await response.text() };
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const draft = (weekStart) => api('POST', '/runs', { body: { weekStart } });
  const finalize = async (runId, token) => {
    const shown = token ? null : await api('GET', `/runs/${runId}`);
    return api('POST', `/runs/${runId}/finalize`, { body: { token: token || shown.body.run.token } });
  };
  const byName = (run, name) => run.checks.find((c) => c.name === name);

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/payroll', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/payroll`;
  });
  beforeEach(async () => {
    for (const name of GATES) OLD[name] = process.env[name];
    process.env.GATE_PAYROLL = 'true';
    process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
    delete process.env.GATE_PAYROLL_PAY_LINES;
    delete process.env.GATE_PAYROLL_TIME_OFF;
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await trx.rollback();
    for (const name of GATES) { if (OLD[name] === undefined) delete process.env[name]; else process.env[name] = OLD[name]; }
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  it('pays the share on the check for its own week, shows the breakdown on the stub, the CSV and the totals, and freezes it', async () => {
    const id = await tech('Sample Alpha');
    const plain = await tech('Sample Bravo');
    await settings(id);
    await worked(id, W1, 40);
    await worked(plain, W1, 40);
    await threeShifts(id);
    const created = (await draft(W1)).body.run;
    const check = byName(created, 'Sample Alpha');
    expect(check).toMatchObject({ regularPayCents: 80000, productionShareCents: 16200, grossCents: 96200, lineOvertimePremiumCents: 0 });
    expect(check.productionShare).toMatchObject({
      creditedCents: 378000, barCents: 270000, aboveBarCents: 108000, rateBps: 1500, barType: 'per_shift', shifts: 3, needsReviewCount: 0, stopCount: 3,
    });
    // No settings: exactly the check it always was, no share keys.
    const other = byName(created, 'Sample Bravo');
    expect(other.grossCents).toBe(80000);
    expect(other).not.toHaveProperty('productionShareCents');
    expect(created.totals).toMatchObject({ grossCents: 176200, productionShareCents: 16200 });
    expect(created).not.toHaveProperty('productionShareNotes');
    // The stored row holds the frozen credit: one row per stop, no customer data.
    const row = await trx('payroll_checks').where({ id: check.id }).first('production_share_cents', 'calc_snapshot');
    expect(Number(row.production_share_cents)).toBe(16200);
    expect(row.calc_snapshot.productionShare.stops).toHaveLength(3);
    expect(row.calc_snapshot.productionShare.stops[0]).toEqual({
      visitId: expect.any(String), workDate: W1, kind: 'priced', creditCents: 126000, needsReview: false,
    });

    const done = (await finalize(created.id)).body.run;
    expect(done.status).toBe('finalized');
    const checkId = byName(done, 'Sample Alpha').id;
    const stub = (await api('GET', `/checks/${checkId}/stub`)).body.stub;
    expect(stub.earnings).toMatchObject({ productionShareCents: 16200, grossCents: 96200 });
    expect(stub.earnings.productionShare).toEqual({
      creditedCents: 378000, barCents: 270000, aboveBarCents: 108000, rateBps: 1500, barType: 'per_shift', shifts: 3, shareCents: 16200,
    });
    // a check with no share has no share key on its stub
    expect((await api('GET', `/checks/${byName(done, 'Sample Bravo').id}/stub`)).body.stub.earnings).not.toHaveProperty('productionShareCents');

    const csv = (await api('GET', `/runs/${done.id}/export.csv`, { raw: true })).text.split('\n');
    expect(csv[0].endsWith(',Production Share')).toBe(true);
    expect(csv[0].split(',')).toContain('Overtime On Additional Earnings');
    expect(csv.find((line) => line.startsWith('Sample Alpha,')).endsWith(',162.00')).toBe(true);
    expect(csv.find((line) => line.startsWith('Sample Bravo,')).endsWith(',0.00')).toBe(true);

    // finalized: the figure and the snapshot cannot change
    expect(await refused(() => trx('payroll_checks').where({ id: checkId }).update({ production_share_cents: 0 }))).toBeDefined();
    expect(await refused(() => trx.raw("UPDATE payroll_checks SET calc_snapshot = calc_snapshot || '{\"productionShare\": null}'::jsonb WHERE id = ?", [checkId]))).toBeDefined();
    // later credit changes do not touch a finalized check
    await stop(id, addDays(W1, 3), '500.00');
    expect(byName((await api('GET', `/runs/${done.id}`)).body.run, 'Sample Alpha')).toMatchObject({ productionShareCents: 16200, grossCents: 96200 });
  });

  it('puts the overtime the share causes on the same check (45 h, $162.00 share: $9.00 more)', async () => {
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40, 5);
    await threeShifts(id);
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    // hourly: 40 x $20.00 + 5 x $30.00 = $950.00; share $162.00; premium 1/2 x ($162.00 / 45 h) x 5 h = $9.00
    expect(check).toMatchObject({
      regularPayCents: 80000, overtimePayCents: 15000, productionShareCents: 16200, lineOvertimePremiumCents: 900, grossCents: 112100,
    });
    const row = await trx('payroll_checks').where({ id: check.id }).first('qualified_overtime_cents', 'line_overtime_premium_cents', 'calc_snapshot');
    expect(Number(row.line_overtime_premium_cents)).toBe(900);
    expect(row.calc_snapshot.lineOvertimeWeeks).toEqual([expect.objectContaining({ weekStart: W1, allocatedCents: 16200, premiumCents: 900 })]);
    // the premium on the hourly pay (5 h x $10.00) plus the premium the share caused
    expect(Number(row.qualified_overtime_cents)).toBe(5000 + 900);
  });

  it('pays the share next to the other pay lines of the week with one regular rate', async () => {
    process.env.GATE_PAYROLL_PAY_LINES = 'true';
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40, 5);
    await threeShifts(id);
    await trx('payroll_pay_lines').insert({
      technician_id: id, kind: 'commission', amount_cents: 10001, earned_week_start: W1, status: 'open', note: 'sample',
    });
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    // (16200 + 10001) x 5 / (2 x 45) = 1455.6 -> $14.56 on the two lines together
    expect(check).toMatchObject({ productionShareCents: 16200, commissionCents: 10001, lineOvertimePremiumCents: 1456 });
    expect(check.payLines).toHaveLength(1);
  });

  it('a week at or under the bar stores $0 with the snapshot; a technician with no settings gets no line; the gate off pays nothing', async () => {
    const low = await tech('Sample Alpha');
    const none = await tech('Sample Bravo');
    await settings(low);
    await worked(low, W1, 40);
    await worked(none, W1, 40);
    await stop(low, W1, '500.00');
    await stop(none, W1, '5000.00');
    const created = (await draft(W1)).body.run;
    expect(byName(created, 'Sample Alpha')).toMatchObject({ productionShareCents: 0, grossCents: 80000 });
    expect(byName(created, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 50000, barCents: 90000, aboveBarCents: 0 });
    expect(byName(created, 'Sample Bravo')).not.toHaveProperty('productionShareCents');
    expect(created.totals).not.toHaveProperty('productionShareCents');

    await settings(none);
    process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'false';
    const re = (await api('POST', `/runs/${created.id}/recompute`)).body.run;
    expect(byName(re, 'Sample Bravo')).toMatchObject({ grossCents: 80000 });
    expect(byName(re, 'Sample Bravo')).not.toHaveProperty('productionShareCents');
    expect(byName(re, 'Sample Alpha')).not.toHaveProperty('productionShareCents');
    expect(re.totals).not.toHaveProperty('productionShareCents');
  });

  it('a week at or under the bar still shows the breakdown on the stub and a $0 row on the statement; no earning row', async () => {
    const id = await tech('Sample Alpha');
    const plain = await tech('Sample Bravo');
    await settings(id);
    await worked(id, W1, 40);
    await worked(plain, W1, 40);
    await stop(id, W1, '500.00');
    const created = (await draft(W1)).body.run;
    const done = (await finalize(created.id)).body.run;
    const stub = (await api('GET', `/checks/${byName(done, 'Sample Alpha').id}/stub`)).body.stub;
    expect(stub.earnings).not.toHaveProperty('productionShareCents');
    expect(stub.earnings.productionShare).toEqual({
      creditedCents: 50000, barCents: 90000, aboveBarCents: 0, rateBps: 1500, barType: 'per_shift', shifts: 1, shareCents: 0,
    });
    // no settings: no breakdown either
    const bravo = (await api('GET', `/checks/${byName(done, 'Sample Bravo').id}/stub`)).body.stub;
    expect(bravo.earnings).not.toHaveProperty('productionShare');
    const now = new Date('2026-12-01T12:00:00Z');
    expect((await getYearStatement(id, '2026', { now })).pay).toHaveProperty('productionShareCents', 0);
    // the year of a technician whose checks stored no share keeps its earlier keys
    expect((await getYearStatement(plain, '2026', { now })).pay).not.toHaveProperty('productionShareCents');
  });

  it('a stop that needs review pays $0, is named on the draft, and does not block the run', async () => {
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await stop(id, W1, '1000.00');
    await stop(id, addDays(W1, 1), null); // no price on file
    await stop(id, addDays(W1, 2), null);
    const created = (await draft(W1)).body.run;
    const check = byName(created, 'Sample Alpha');
    // 3 shifts: credited $1,000.00 (the two unpriced stops credit $0) against a $2,700.00 bar: no share, and the note is there
    expect(check).toMatchObject({ productionShareCents: 0 });
    expect(check.productionShare).toMatchObject({ needsReviewCount: 2, stopCount: 3, creditedCents: 100000 });
    expect(check.productionShare.needsReview.map((s) => s.workDate)).toEqual([addDays(W1, 1), addDays(W1, 2)]);
    expect(created.productionShareNotes).toEqual([expect.stringContaining('Sample Alpha: 2 stops need review for the production share. They pay $0')]);
    expect(created.blocked).toEqual([]);
    const done = (await finalize(created.id)).body.run;
    expect(done.status).toBe('finalized');
    // a finalized run no longer shows the hold note
    expect(done).not.toHaveProperty('productionShareNotes');
  });

  it('a credit that changes after drafting makes the draft stale, and finalize with the old token keeps the new numbers', async () => {
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await threeShifts(id);
    const created = (await draft(W1)).body.run;
    expect(byName(created, 'Sample Alpha').productionShareCents).toBe(16200);
    const shown = (await api('GET', `/runs/${created.id}`)).body.run;
    expect(shown.stale).toBe(false);
    // a fourth shift is completed late: +$500.00 of credit over a $900.00 bar for the extra shift
    await stop(id, addDays(W1, 3), '500.00');
    const stale = (await api('GET', `/runs/${created.id}`)).body.run;
    expect(stale.stale).toBe(true);
    const refusal = await finalize(created.id, shown.token);
    expect(refusal.status).toBe(409);
    const fresh = (await api('GET', `/runs/${created.id}`)).body.run;
    expect(fresh.status).toBe('draft');
    expect(fresh.stale).toBe(false);
    // 4 shifts: $4,280.00 - $3,600.00 = $680.00 above; 15% = $102.00
    expect(byName(fresh, 'Sample Alpha').productionShareCents).toBe(10200);
    expect((await finalize(created.id)).body.run.status).toBe('finalized');
  });

  it('a stop that moves to another price with the same share still makes the draft stale', async () => {
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await threeShifts(id);
    const created = (await draft(W1)).body.run;
    const shown = (await api('GET', `/runs/${created.id}`)).body.run;
    // two stops trade $10.00 of price: credited and share are unchanged, the rows are not
    const [first, second] = await trx('scheduled_services').where({ technician_id: id }).orderBy('scheduled_date').select('id');
    await trx('scheduled_services').where({ id: first.id }).update({ estimated_price: '1270.00' });
    await trx('scheduled_services').where({ id: second.id }).update({ estimated_price: '1250.00' });
    const stale = (await api('GET', `/runs/${created.id}`)).body.run;
    expect(stale.stale).toBe(true);
    // finalize with the token of the earlier view is refused
    expect((await finalize(created.id, shown.token)).status).toBe(409);
  });

  it('flows to the yearly statement, the W-2 package and the Tech Rewards pay base', async () => {
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await threeShifts(id);
    const created = (await draft(W1)).body.run;
    await finalize(created.id);
    const statement = await getYearStatement(id, '2026', { now: new Date('2026-12-01T12:00:00Z') });
    expect(statement.pay).toMatchObject({ regularPayCents: 80000, productionShareCents: 16200, otherCents: 0, grossCents: 96200 });

    const checks = await loadFinalizedW2Checks(trx, '2026-01-01', '2026-12-31');
    const csv = w2PayrollToCSV(checks).split('\n');
    expect(csv.find((line) => line.startsWith('Sample Alpha,'))).toContain('962.00');
    expect(csv[csv.length - 1]).toContain('962.00');

    // Earned by work. The wages of the week have no day records here, so they fall on the week (days in window / 7); the share is
    // earned evenly over its 3 shift days (Mon to Wed): $54.00 each.
    const wholeWeek = await readBonusPay(trx, id, W1, addDays(W1, 6), W1);
    expect(wholeWeek.cents).toBe(96200);
    // Mon-Tue: 2/7 of $800.00 wages + 2 of the 3 shift days of the share
    expect((await readBonusPay(trx, id, W1, addDays(W1, 1), W1)).cents).toBe(Math.round(80000 * 2 / 7) + 10800);
    // Thu-Sun: 4/7 of the wages and none of the share
    expect((await readBonusPay(trx, id, addDays(W1, 3), addDays(W1, 6), W1)).cents).toBe(Math.round(80000 * 4 / 7));
  });

  it('finalize reads the credits again under the payroll lock: a credit edited after its first read is never frozen, the run answers 409', async () => {
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await threeShifts(id);
    const created = (await draft(W1)).body.run;
    expect(byName(created, 'Sample Alpha').productionShareCents).toBe(16200);
    const shown = (await api('GET', `/runs/${created.id}`)).body.run;
    // The first read (before the lock) is the real one; the credit is edited, committed, before the read under the lock.
    const real = productionSharePay.readInputsUnderLock;
    let reads = 0;
    const spy = jest.spyOn(productionSharePay, 'readInputsUnderLock').mockImplementation(async (conn, week) => {
      reads += 1;
      await trx('scheduled_services').where({ technician_id: id }).update({ estimated_price: '1360.00' });
      return real(conn, week);
    });
    let refused409;
    try {
      refused409 = await api('POST', `/runs/${created.id}/finalize`, { body: { token: shown.token } });
    } finally { spy.mockRestore(); }
    expect(reads).toBe(1);
    expect(refused409.status).toBe(409);
    const fresh = (await api('GET', `/runs/${created.id}`)).body.run;
    expect(fresh.status).toBe('draft');
    // 3 x $1,360.00 = $4,080.00 - $2,700.00 = $1,380.00 above; 15% = $207.00: the draft now holds the new credit
    expect(byName(fresh, 'Sample Alpha').productionShareCents).toBe(20700);
    expect(fresh.stale).toBe(false);
    expect((await finalize(created.id)).body.run.status).toBe('finalized');
  });

  it('a visit a finalized run already paid is not credited again when its completion moves into another week; voiding that run frees it', async () => {
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await threeShifts(id);
    const week1 = (await draft(W1)).body.run;
    expect((await finalize(week1.id)).body.run.status).toBe('finalized');
    // a time-on-site correction moves one visit's completion a week later
    const W2 = addDays(W1, 7);
    const [moved] = await trx('scheduled_services').where({ technician_id: id }).orderBy('scheduled_date').select('id');
    await trx('scheduled_services').where({ id: moved.id }).update({ completed_at: `${W2}T16:00:00Z`, scheduled_date: W2 });
    await worked(id, W2, 40);
    await stop(id, addDays(W2, 1), '300.00');
    const week2 = (await draft(W2)).body.run;
    const check = byName(week2, 'Sample Alpha');
    // the moved visit pays $0 and is named; only the $300.00 stop is credited (1 shift of the 2: bar $1,800 -> no share)
    expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 30000, stopCount: 2 });
    expect(check.productionShare.needsReview).toEqual([{ visitId: moved.id, workDate: W2 }]);
    expect(week2.productionShareNotes).toEqual([expect.stringContaining('1 stop needs review')]);
    const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
    expect(snapshot.stops.find((row) => row.visitId === moved.id)).toMatchObject({ kind: 'already_paid', creditCents: 0, needsReview: true });
    // the read under the lock sees the same
    const locked = await productionSharePay.readInputsUnderLock(trx, W2);
    expect(locked.get(id).stops.find((row) => row.visitId === moved.id)).toMatchObject({ kind: 'already_paid', creditCents: 0, needsReview: true });
    expect(locked.get(id).stops.find((row) => row.visitId === moved.id).reason).toContain(`Already paid in the week of ${W1}`);
    // voiding the run that paid it releases the visit: the next recompute credits it
    expect((await api('POST', `/runs/${week1.id}/void`, { body: { reason: 'sample' } })).status).toBe(200);
    const again = byName((await api('POST', `/runs/${week2.id}/recompute`)).body.run, 'Sample Alpha');
    expect(again.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 156000 });
  });

  it('a visit that moves out of a finalized week that paid NO share is not "already paid": it earns in the week it moved to', async () => {
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    const W2 = addDays(W1, 7);
    await worked(id, W2, 40);
    // week 1: one $500.00 stop, one shift against a $900.00 bar: the share is $0, and that week is finalized
    const moving = await stop(id, W1, '500.00');
    const week1 = (await draft(W1)).body.run;
    expect(byName(week1, 'Sample Alpha').productionShareCents).toBe(0);
    expect((await finalize(week1.id)).body.run.status).toBe('finalized');
    // a time-on-site correction moves the visit into week 2, which has $1,800.00 of other production on another day
    await trx('scheduled_services').where({ id: moving }).update({ completed_at: `${addDays(W2, 2)}T16:00:00Z`, scheduled_date: addDays(W2, 2) });
    await stop(id, addDays(W2, 1), '1800.00');
    const check = byName((await draft(W2)).body.run, 'Sample Alpha');
    // 2 shifts: $2,300.00 - $1,800.00 bar = $500.00 above; 15% = $75.00 (the $500.00 visit counts: nothing paid it)
    expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 230000, aboveBarCents: 50000 });
    expect(check.productionShareCents).toBe(7500);
  });

  describe('the first finalized payment freezes the credit basis of every visit in it', () => {
    // One invoice over two visits priced $1,000.00 each: V1 in week 1 (paid, share above $0), V2 in week 2.
    const sharedWorld = async ({ linkSecond = true, stampSecond = false, total = '2000.00', bar = null } = {}) => {
      const id = await tech('Sample Alpha');
      await settings(id, bar == null ? {} : { bar_cents: bar });
      const W2 = addDays(W1, 7);
      await worked(id, W1, 40);
      await worked(id, W2, 40);
      const customerId = await customer();
      const v1 = await stop(id, W1, '1000.00', customerId);
      const v2 = await stop(id, W2, '1000.00', customerId);
      if (stampSecond) {
        // V2 is a prepaid-plan visit (its credit is the prepaid slice, not the shared invoice)
        const [prepayInvoice] = await trx('invoices').insert({
          token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'paid',
          subtotal: '400.00', discount_amount: '0.00', tax_amount: '0.00', total: '400.00',
        }).returning('id');
        const [term] = await trx('annual_prepay_terms').insert({
          customer_id: customerId, term_start: '2026-09-01', term_end: '2027-08-31', status: 'active', prepay_amount: '400.00',
          prepay_invoice_id: prepayInvoice.id, coverage_visit_count: 4,
        }).returning('id');
        await trx('scheduled_services').where({ id: v2 }).update({ annual_prepay_term_id: term.id, prepaid_amount: '400.00', prepaid_method: 'annual_prepay_invoice' });
      }
      const [inv] = await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: total, discount_amount: '0.00', tax_amount: '0.00', total,
      }).returning('id');
      const [visit] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: 'k-share', created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: visit.id, idempotency_key: 'k-share', request_hash: 'h', payload: {} }).returning('id');
      const link = (visitId) => trx('visit_completion_packet_items').insert({
        packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `k-share-${visitId}`, invoice_id: inv.id });
      await link(v1);
      if (linkSecond) await link(v2);
      return { id, v1, v2, inv: inv.id, W2, joinSecond: () => link(v2), unlinkSecond: () => trx('visit_completion_packet_items').where({ scheduled_service_id: v2 }).del() };
    };
    const reprice = (world, first, second) => Promise.all([
      trx('scheduled_services').where({ id: world.v1 }).update({ estimated_price: first }),
      trx('scheduled_services').where({ id: world.v2 }).update({ estimated_price: second }),
    ]);
    const week2Stop = async (world) => {
      const check = byName((await draft(world.W2)).body.run, 'Sample Alpha');
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      return { check, stop: snapshot.stops.find((row) => row.visitId === world.v2) };
    };

    it('freezes the invoice and the split of ALL its visits on the stop, and a later week with the same split credits the same', async () => {
      const world = await sharedWorld();
      const week1 = (await draft(W1)).body.run;
      // V1 is credited $1,000.00 (half the invoice); 1 shift, bar $900.00: share $15.00
      expect(byName(week1, 'Sample Alpha')).toMatchObject({ productionShareCents: 1500 });
      await finalize(week1.id);
      const frozen = (await trx('payroll_checks').where({ run_id: week1.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops[0];
      expect(frozen.bases).toEqual([{ basisType: 'invoice', basisId: world.inv, totalCents: 200000, allocation: { [world.v1]: 100000, [world.v2]: 100000 } }]);
      const { check } = await week2Stop(world);
      expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
    });

    it('AUDIT CASE: the invoice moved to $1,500.00 / $500.00 after week 1 was paid: V2 still credits its frozen $1,000.00', async () => {
      const world = await sharedWorld();
      await finalize((await draft(W1)).body.run.id);
      await reprice(world, '1500.00', '500.00');
      const { check, stop: row } = await week2Stop(world);
      expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
      expect(row).toMatchObject({ kind: 'frozen_basis', creditCents: 100000, needsReview: false });
    });

    it('the split moved the other way, to $500.00 / $1,500.00: also the frozen $1,000.00 (never over the invoice, never under it)', async () => {
      const world = await sharedWorld();
      await finalize((await draft(W1)).body.run.id);
      await reprice(world, '500.00', '1500.00');
      expect((await week2Stop(world)).check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
    });

    it('AUDIT CASE: V2 loses its invoice link after a $1,200.00 split (V1 paid $600.00): it credits the frozen $600.00, not its own $1,000.00 price', async () => {
      const world = await sharedWorld({ total: '1200.00', bar: 10000 });
      const week1 = (await draft(W1)).body.run;
      expect(byName(week1, 'Sample Alpha').productionShareCents).toBeGreaterThan(0);
      await finalize(week1.id);
      await world.unlinkSecond();
      const { check, stop: row } = await week2Stop(world);
      expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 60000 });
      expect(row).toMatchObject({ kind: 'frozen_basis', creditCents: 60000 });
    });

    it('a visit that JOINS the invoice after it was paid whole is $0 and named (it is not in the split that week froze)', async () => {
      const world = await sharedWorld({ linkSecond: false });
      const week1 = (await draft(W1)).body.run;
      await finalize(week1.id);
      // week 1 paid the whole $2,000.00 invoice to V1; the frozen split is V1 alone
      const frozen = (await trx('payroll_checks').where({ run_id: week1.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops[0];
      expect(frozen.bases).toEqual([{ basisType: 'invoice', basisId: world.inv, totalCents: 200000, allocation: { [world.v1]: 200000 } }]);
      await world.joinSecond();
      const { check, stop: row } = await week2Stop(world);
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      expect(row).toMatchObject({ kind: 'joined_basis', creditCents: 0, needsReview: true });
    });

    it('a credit that is NOT price-derived (a prepaid slice) keeps its own credit although it is listed in the frozen split', async () => {
      const world = await sharedWorld({ stampSecond: true });
      await finalize((await draft(W1)).body.run.id);
      const { check, stop: row } = await week2Stop(world);
      expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 40000 });
      expect(row).toMatchObject({ kind: 'prepaid_plan', creditCents: 40000 });
      expect(row).not.toHaveProperty('bases');
    });

    it('the frozen bases are read by visit id from other weeks only', async () => {
      const world = await sharedWorld();
      await finalize((await draft(W1)).body.run.id);
      const found = await productionShare.frozenBases(trx, [world.v2], [], world.W2);
      expect(found).toEqual([{ weekStart: W1, basis: { basisType: 'invoice', basisId: world.inv, totalCents: 200000, allocation: { [world.v1]: 100000, [world.v2]: 100000 } } }]);
      expect(await productionShare.frozenBases(trx, [world.v2], [], W1)).toEqual([]);
      expect(await productionShare.frozenBases(trx, [randomUUID()], [], world.W2)).toEqual([]);
    });

    it('voiding the run that froze the basis releases it: the later visit credits from the live split', async () => {
      const world = await sharedWorld();
      const week1 = (await draft(W1)).body.run;
      await finalize(week1.id);
      await reprice(world, '1500.00', '500.00');
      const run2 = (await draft(world.W2)).body.run;
      expect(byName(run2, 'Sample Alpha').productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
      expect((await api('POST', `/runs/${week1.id}/void`, { body: { reason: 'sample' } })).status).toBe(200);
      const again = byName((await api('POST', `/runs/${run2.id}/recompute`)).body.run, 'Sample Alpha');
      expect(again.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 50000 });
    });

    it('PER INVOICE: a visit with a frozen shared invoice ($100.00) and its own separate $50.00 invoice credits $150.00, and the snapshot keeps both', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 5000 });
      const W2 = addDays(W1, 7);
      await worked(id, W1, 40);
      await worked(id, W2, 40);
      const customerId = await customer();
      const v1 = await stop(id, W1, '100.00', customerId);
      const v2 = await stop(id, W2, '100.00', customerId);
      const invoiceFor = async (total, patch = {}) => (await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: total, discount_amount: '0.00', tax_amount: '0.00', total, ...patch,
      }).returning('id'))[0].id;
      const shared = await invoiceFor('200.00');
      const [sv] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: 'k-pi', created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: sv.id, idempotency_key: 'k-pi', request_hash: 'h', payload: {} }).returning('id');
      for (const visitId of [v1, v2]) {
        await trx('visit_completion_packet_items').insert({ packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `k-pi-${visitId}`, invoice_id: shared });
      }
      const week1 = (await draft(W1)).body.run;
      expect(byName(week1, 'Sample Alpha').productionShareCents).toBeGreaterThan(0); // $100.00 credited over a $50.00 bar
      await finalize(week1.id);
      // V2 also gets its own $50.00 invoice, and the shared invoice is repriced to $150.00 / $50.00 after week 1 was paid
      const own = await invoiceFor('50.00', { scheduled_service_id: v2 });
      await reprice({ v1, v2 }, '150.00', '50.00');
      const check = byName((await draft(W2)).body.run, 'Sample Alpha');
      // frozen $100.00 of the shared invoice + the live $50.00 of its own invoice
      expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 15000 });
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      const row = snapshot.stops.find((one) => one.visitId === v2);
      expect(row).toMatchObject({ kind: 'frozen_basis', creditCents: 15000 });
      expect(row.bases.map((basis) => [basis.basisId, basis.allocation[v2]])).toEqual([[shared, 10000], [own, 5000]]);
    });

    it('a package paid first also freezes the invoice allocation under its root: the other visit of that invoice credits its frozen cents', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const W2 = addDays(W1, 7);
      await worked(id, W1, 40);
      await worked(id, W2, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const root = await stop(id, W1, '1000.00', customerId, pkg);
      const other = await stop(id, W2, '1000.00', customerId);
      const [inv] = await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '2000.00', discount_amount: '0.00', tax_amount: '0.00', total: '2000.00',
      }).returning('id');
      const [sv] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: 'k-pj', created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: sv.id, idempotency_key: 'k-pj', request_hash: 'h', payload: {} }).returning('id');
      for (const visitId of [root, other]) {
        await trx('visit_completion_packet_items').insert({ packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `k-pj-${visitId}`, invoice_id: inv.id });
      }
      const week1 = (await draft(W1)).body.run;
      // the root is priced $1,000.00 from the shared invoice, and the package splits it in two: $500.00 now
      expect(byName(week1, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 50000 });
      await finalize(week1.id);
      const frozen = (await trx('payroll_checks').where({ run_id: week1.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops[0];
      expect(frozen.bases.map((basis) => basis.basisType)).toEqual(['job', 'invoice']);
      expect(frozen.bases[1].allocation).toEqual({ [root]: 100000, [other]: 100000 });
      // the invoice split moves, and the other visit still credits the frozen $1,000.00
      await reprice({ v1: root, v2: other }, '3000.00', '1000.00');
      const check = byName((await draft(W2)).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
    });

    it('a package root priced from a frozen shared invoice credits its part of the FROZEN amount, not the whole amount', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const W2 = addDays(W1, 7);
      await worked(id, W1, 40);
      await worked(id, W2, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const other = await stop(id, W1, '1000.00', customerId);
      const root = await stop(id, W2, '1000.00', customerId, pkg);
      const [inv] = await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '2000.00', discount_amount: '0.00', tax_amount: '0.00', total: '2000.00',
      }).returning('id');
      const [sv] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: 'k-pk', created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: sv.id, idempotency_key: 'k-pk', request_hash: 'h', payload: {} }).returning('id');
      for (const visitId of [other, root]) {
        await trx('visit_completion_packet_items').insert({ packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `k-pk-${visitId}`, invoice_id: inv.id });
      }
      await finalize((await draft(W1)).body.run.id);
      // the root's price moves on the invoice ($1,500.00 now); $1,000.00 of it was frozen with week 1
      await reprice({ v1: other, v2: root }, '500.00', '1500.00');
      const check = byName((await draft(W2)).body.run, 'Sample Alpha');
      // half of the frozen $1,000.00, not the whole $1,000.00 and not half of the live $1,500.00
      expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 50000 });
    });

    it('THREE-CREDIT CASE: a two-visit package paid in two weeks (root, then follow-up) cannot credit a replacement follow-up a third time', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const W2 = addDays(W1, 7);
      const W3 = addDays(W1, 14);
      for (const week of [W1, W2, W3]) await worked(id, week, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const root = await stop(id, W1, '2000.00', customerId, pkg);
      await finalize((await draft(W1)).body.run.id);
      // week 2 pays the follow-up (slot 2 of the frozen $2,000.00 package)
      const followUp = await stop(id, W2, '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
      const week2 = (await draft(W2)).body.run;
      expect(byName(week2, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 100000 });
      await finalize(week2.id);
      // the follow-up is cancelled and replaced by another one, done in week 3: the package was sold with two visits
      await trx('scheduled_services').where({ id: followUp }).update({ status: 'cancelled' });
      const replacement = await stop(id, W3, '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
      const check = byName((await draft(W3)).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === replacement)).toMatchObject({ kind: 'joined_basis', creditCents: 0, needsReview: true });
      // the merged frozen job holds both paid slots, with the price the first payment fixed
      const merged = await productionShare.frozenBases(trx, [replacement], [root], W3);
      expect(merged).toHaveLength(1);
      expect(merged[0].basis).toMatchObject({ basisType: 'job', totalCents: 200000, sold: 2, slots: { [root]: 1, [followUp]: 2 }, allocation: { [root]: 100000, [followUp]: 100000 } });
    });

    it('AUDIT CASE: a package whose root is repriced $2,000 -> $1,200 after half was paid: the follow-up still credits $1,000.00', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const W2 = addDays(W1, 7);
      await worked(id, W1, 40);
      await worked(id, W2, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const root = await stop(id, W1, '2000.00', customerId, pkg);
      const week1 = (await draft(W1)).body.run;
      // the first treatment of a two-treatment $2,000.00 package: half, $1,000.00
      expect(byName(week1, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 100000 });
      expect(byName(week1, 'Sample Alpha').productionShareCents).toBeGreaterThan(0);
      await finalize(week1.id);
      const frozen = (await trx('payroll_checks').where({ run_id: week1.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops[0];
      expect(frozen.bases).toEqual([{ basisType: 'job', basisId: root, totalCents: 200000, sold: 2, allocation: { [root]: 100000 }, slots: { [root]: 1 } }]);
      // the root is repriced; the follow-up is then booked and done in week 2
      await trx('scheduled_services').where({ id: root }).update({ estimated_price: '1200.00' });
      const followUp = await stop(id, W2, '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
      const week2 = byName((await draft(W2)).body.run, 'Sample Alpha');
      expect(week2.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
      const snapshot = (await trx('payroll_checks').where({ id: week2.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === followUp)).toMatchObject({ kind: 'frozen_basis', creditCents: 100000 });
    });
  });

  it('a credit that did not change under the lock finalizes with the snapshot it read first', async () => {
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await threeShifts(id);
    const created = (await draft(W1)).body.run;
    const done = (await finalize(created.id)).body.run;
    expect(done.status).toBe('finalized');
    expect(byName(done, 'Sample Alpha').productionShareCents).toBe(16200);
  });

  it('one technician whose read fails (a statement error) does not abort the reads of the others', async () => {
    process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
    const a = await tech('Sample Alpha');
    const b = await tech('Sample Bravo');
    await settings(a);
    await settings(b);
    await threeShifts(a);
    const real = productionShare.weekCredits;
    const spy = jest.spyOn(productionShare, 'weekCredits').mockImplementation(async (conn, id, week, options) => {
      if (id === b) await conn.raw('SELECT 1/0');
      return real(conn, id, week, options);
    });
    let inputs;
    try { inputs = await productionSharePay.readInputs(trx, W1); } finally { spy.mockRestore(); }
    expect(inputs.get(a).stops).toHaveLength(3);
    expect(inputs.get(b).error).toMatch(/could not be worked out.*division by zero/);
    // the transaction is still usable: the failure was rolled back to its savepoint
    expect((await trx.raw('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    const shares = productionSharePay.sharesFor(inputs, [a, b], W1);
    expect(shares.get(a).shareCents).toBe(16200);
    expect(shares.get(b).error).toBeDefined();
  });

  it('the down guard takes the payroll_checks table lock first and holds it while it drops the column', async () => {
    const guard = require('../models/migrations/20261124130000_payroll_production_share_down_guard');
    await trx.raw('SAVEPOINT lockcheck');
    await guard.down(trx);
    const held = await trx.raw(`SELECT l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      WHERE c.relname = 'payroll_checks' AND l.pid = pg_backend_pid() AND l.granted`);
    expect(held.rows.map((row) => row.mode)).toContain('AccessExclusiveLock');
    const column = await trx.raw("SELECT 1 FROM information_schema.columns WHERE table_name = 'payroll_checks' AND column_name = 'production_share_cents'");
    expect(column.rows).toHaveLength(0);
    await trx.raw('ROLLBACK TO SAVEPOINT lockcheck');
  });

  it('the guard up restores the column and its constraint after a single-step rollback of the guard alone', async () => {
    const guard = require('../models/migrations/20261124130000_payroll_production_share_down_guard');
    await trx.raw('SAVEPOINT stepback');
    await guard.down(trx);
    await guard.up(trx);
    const column = await trx.raw("SELECT 1 FROM information_schema.columns WHERE table_name = 'payroll_checks' AND column_name = 'production_share_cents'");
    const constraint = await trx.raw("SELECT 1 FROM pg_constraint WHERE conname = 'payroll_checks_production_share_check'");
    expect(column.rows).toHaveLength(1);
    expect(constraint.rows).toHaveLength(1);
    // the constraint is the real one: a negative figure is refused
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await threeShifts(id);
    await draft(W1);
    const [runRow] = await trx('payroll_runs').select('id');
    expect(await refused(() => trx('payroll_checks').where({ run_id: runRow.id }).update({ production_share_cents: -1 }))).toBeDefined();
    // and running up again on a database that has everything changes nothing
    await expect(guard.up(trx)).resolves.toBeUndefined();
    await trx.raw('ROLLBACK TO SAVEPOINT stepback');
  });

  it('a rollback runs the guard down first and the older down after it, with no column left and no error', async () => {
    const guard = require('../models/migrations/20261124130000_payroll_production_share_down_guard');
    const older = require('../models/migrations/20261124070000_payroll_production_share');
    await trx.raw('SAVEPOINT rollback');
    await guard.down(trx);
    await expect(older.down(trx)).resolves.toBeUndefined();
    const left = await trx.raw(`SELECT 1 FROM information_schema.columns WHERE table_name = 'payroll_checks' AND column_name = 'production_share_cents'
      UNION ALL SELECT 1 FROM pg_constraint WHERE conname = 'payroll_checks_production_share_check'`);
    expect(left.rows).toHaveLength(0);
    await trx.raw('ROLLBACK TO SAVEPOINT rollback');
  });

  it('the guard down refuses while a check holds a share figure, and drops nothing', async () => {
    const guard = require('../models/migrations/20261124130000_payroll_production_share_down_guard');
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await threeShifts(id);
    await draft(W1);
    const error = await refused(() => guard.down(trx));
    expect(error && error.message).toMatch(/production share figures/);
    const column = await trx.raw("SELECT 1 FROM information_schema.columns WHERE table_name = 'payroll_checks' AND column_name = 'production_share_cents'");
    expect(column.rows).toHaveLength(1);
  });

  it('the migration refuses to go down while a check holds a share figure', async () => {
    const migration = require('../models/migrations/20261124070000_payroll_production_share');
    const id = await tech('Sample Alpha');
    await settings(id);
    await worked(id, W1, 40);
    await threeShifts(id);
    await draft(W1);
    const error = await refused(() => migration.down(trx));
    expect(error && error.message).toMatch(/production share figures/);
    // the constraint refuses a negative figure
    const [runRow] = await trx('payroll_runs').select('id');
    const negative = await refused(() => trx('payroll_checks').where({ run_id: runRow.id }).update({ production_share_cents: -1 }));
    expect(negative).toBeDefined();
  });
});
