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
  const stop = async (technicianId, date, price) => {
    const customerId = await customer();
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, technician_id: technicianId, scheduled_date: date, service_type: 'General Pest Control',
      status: 'completed', completed_at: noon(date), estimated_price: price == null ? null : price,
    });
    await trx('service_records').insert({
      customer_id: customerId, technician_id: technicianId, service_date: date, service_type: 'General Pest Control',
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
