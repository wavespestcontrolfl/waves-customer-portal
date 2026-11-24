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
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID, 'x-test-email': 'contact@wavespestcontrol.com' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: response.status, text: await response.text() };
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  // The conflict state the preview shows for a stop (what the page sends with a credit); '' when it cannot be read.
  const shownBasis = async ({ technicianId, visitId, weekStart }) => {
    try {
      const shown = await api('GET', `/production-share/preview?technicianId=${technicianId}&weekStart=${weekStart}`);
      return (shown.body.stops.find((row) => row.visitId === visitId) || {}).stopRevision || '';
    } catch { return ''; }
  };
  // A page sends the state it saw: the helper reads it from the preview unless the test says what to send.
  const override = async (body) => api('PUT', '/production-share/stop-override', {
    body: { ...body, ...(body.stopRevision === undefined ? { stopRevision: await shownBasis(body) } : {}) },
  });
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

  describe('the credit the owner sets for a stop (stop override)', () => {
    // The revision of the credit stored for a stop and week (what the preview shows as the stop's overrideRevision).
    const revisionOf = async (visitId, week = W1) => (await productionShare.overridesOf(trx, week)).get(visitId).revision;
    const clear = async (key, patch = {}) => api('DELETE', '/production-share/stop-override', { body: { ...key, revision: await revisionOf(key.visitId, key.weekStart), ...patch } });
    const world = async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      await worked(id, W1, 40);
      await stop(id, W1, '1260.00');
      await stop(id, addDays(W1, 1), '1260.00');
      const unpriced = await stop(id, addDays(W1, 2), null); // no price on file: review, $0
      return { id, unpriced, key: { technicianId: id, visitId: unpriced, weekStart: W1 } };
    };

    it('a review stop credits what the owner set: the share, the snapshot and the stale draft follow, and a paid week refuses a change', async () => {
      const { id, unpriced, key } = await world();
      const created = (await draft(W1)).body.run;
      expect(byName(created, 'Sample Alpha').productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 252000 });
      expect(byName(created, 'Sample Alpha').productionShareCents).toBe(0);
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      const set = await override({ ...key, creditCents: 126000, reason: 'Checked the invoice by hand' });
      expect(set.status).toBe(200);
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced })).toEqual([
        expect.objectContaining({ technician_id: id, credit_cents: '126000', reason: 'Checked the invoice by hand', created_by: ADMIN_ID }),
      ]);
      expect(await trx('audit_log').where({ action: 'payroll.production_share_stop_override_set' })).toHaveLength(1);
      // the draft read before the change is stale, and finalize with its token is refused
      expect((await api('GET', `/runs/${created.id}`)).body.run.stale).toBe(true);
      expect((await finalize(created.id, shown.token)).status).toBe(409);
      const fresh = byName((await api('GET', `/runs/${created.id}`)).body.run, 'Sample Alpha');
      // 3 shifts: $3,780.00 - $2,700.00 = $1,080.00 above; 15% = $162.00
      expect(fresh).toMatchObject({ productionShareCents: 16200 });
      expect(fresh.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 378000 });
      const snapshot = (await trx('payroll_checks').where({ id: fresh.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === unpriced)).toMatchObject({ kind: 'owner_set', creditCents: 126000, needsReview: false });
      expect((await finalize(created.id)).body.run.status).toBe('finalized');
      // the week is paid: neither a change nor a clear is accepted
      expect((await override({ ...key, creditCents: 1, reason: 'late', revision: await revisionOf(key.visitId) })).status).toBe(409);
      expect((await clear(key)).status).toBe(409);
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced }).first('credit_cents')).toMatchObject({ credit_cents: '126000' });
    });

    it('a cleared credit sends the stop back to the rules; overtime follows the share the credit makes', async () => {
      const { key } = await world();
      await override({ ...key, creditCents: 126000, reason: 'Checked' });
      expect((await clear(key)).status).toBe(200);
      expect(await trx('audit_log').where({ action: 'payroll.production_share_stop_override_cleared' })).toHaveLength(1);
      expect((await api('DELETE', `/production-share/stop-override?${new URLSearchParams(key)}`)).status).toBe(404); // nothing left to clear
      const back = byName((await draft(W1)).body.run, 'Sample Alpha');
      expect(back.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 252000 });
    });

    it('refuses what is not a completed stop of that technician and week, a bad credit and a missing reason', async () => {
      const { id, key } = await world();
      const other = await tech('Sample Bravo');
      expect((await override({ ...key, technicianId: other, creditCents: 100, reason: 'x' })).status).toBe(400);
      expect((await override({ ...key, weekStart: addDays(W1, 7), creditCents: 100, reason: 'x' })).status).toBe(400);
      expect((await override({ ...key, weekStart: addDays(W1, 1), creditCents: 100, reason: 'x' })).status).toBe(400); // not a Monday
      expect((await override({ ...key, creditCents: -1, reason: 'x' })).status).toBe(400);
      expect((await override({ ...key, creditCents: 10.5, reason: 'x' })).status).toBe(400);
      expect((await override({ ...key, creditCents: 100, reason: '   ' })).status).toBe(400);
      expect((await override({ ...key, technicianId: randomUUID(), creditCents: 100, reason: 'x', stopRevision: 'abc' })).status).toBe(404);
      expect(await trx('production_share_stop_overrides').where({ technician_id: id })).toEqual([]);
    });

    it('AUDIT :1047: under the lock a new credit is refused once the stop no longer needs review; an existing one can still be changed', async () => {
      const { unpriced, key } = await world();
      // the office prices the stop after the owner's page was loaded
      await trx('scheduled_services').where({ id: unpriced }).update({ estimated_price: '1260.00' });
      const refusal = await override({ ...key, creditCents: 5000, reason: 'late' });
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toContain('no longer needs review');
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced })).toEqual([]);
      // a credit the owner already set on a stop can be changed, whatever the rules say now
      await trx('scheduled_services').where({ id: unpriced }).update({ estimated_price: null });
      expect((await override({ ...key, creditCents: 5000, reason: 'first' })).status).toBe(200);
      await trx('scheduled_services').where({ id: unpriced }).update({ estimated_price: '1260.00' });
      expect((await override({ ...key, creditCents: 6000, reason: 'second', revision: await revisionOf(unpriced) })).status).toBe(200);
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced }).first('credit_cents')).toMatchObject({ credit_cents: '6000' });
    });

    it('AUDIT :1047: a stop with no closeout record (its work cannot be known) cannot be credited by hand', async () => {
      const { id, key } = await world();
      const bare = randomUUID();
      await trx('scheduled_services').insert({
        id: bare, customer_id: await customer(), technician_id: id, scheduled_date: addDays(W1, 3), service_type: 'General Pest Control',
        status: 'completed', completed_at: noon(addDays(W1, 3)), estimated_price: '100.00',
      });
      const refusal = await override({ ...key, visitId: bare, creditCents: 5000, reason: 'unknown work' });
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toContain('cannot be credited by hand');
    });

    it('AUDIT :902: a package follow-up the owner credits keeps its slot: a replacement follow-up cannot take it again', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7), addDays(W1, 14)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      // a package priced on nothing (no root price): its visits need review
      const root = await stop(id, W1, null, customerId, pkg);
      const followUp = await stop(id, weeks[1], '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
      expect((await override({ technicianId: id, visitId: followUp, weekStart: weeks[1], creditCents: 100000, reason: 'Checked' })).status).toBe(200);
      const week2 = (await draft(weeks[1])).body.run;
      const row = (await trx('payroll_checks').where({ run_id: week2.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops.find((r) => r.visitId === followUp);
      expect(row).toMatchObject({ kind: 'owner_set', creditCents: 100000, bases: [{ basisType: 'job', basisId: root, totalCents: null, sold: 2, slot: 2 }] });
      await finalize(week2.id);
      // the follow-up is cancelled and replaced: the slot is taken
      await trx('scheduled_services').where({ id: followUp }).update({ status: 'cancelled' });
      const replacement = await stop(id, weeks[2], '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
      const check = byName((await draft(weeks[2])).body.run, 'Sample Alpha');
      const stops = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops;
      expect(stops.find((r) => r.visitId === replacement)).toMatchObject({ kind: 'basis_exhausted', creditCents: 0, needsReview: true });
    });

    it('AUDIT :884: a credit the owner set is ignored once the stop closeout is declined or removed', async () => {
      const { unpriced, key } = await world();
      expect((await override({ ...key, creditCents: 126000, reason: 'Checked' })).status).toBe(200);
      const stopRow = async (run) => (await trx('payroll_checks').where({ run_id: run.id }).first('calc_snapshot'))
        .calc_snapshot.productionShare.stops.find((row) => row.visitId === unpriced);
      // the closeout is declined after the credit was set
      await trx('service_records').where({ scheduled_service_id: unpriced }).update({ status: 'incomplete' });
      const declined = (await draft(W1)).body.run;
      expect(await stopRow(declined)).toMatchObject({ kind: 'owner_override_closeout_changed', creditCents: 0, needsReview: true });
      await api('POST', `/runs/${declined.id}/void`, { body: { reason: 'test' } });
      // the closeout record is removed altogether
      await trx('service_records').where({ scheduled_service_id: unpriced }).del();
      const removed = (await draft(W1)).body.run;
      expect(await stopRow(removed)).toMatchObject({ kind: 'owner_override_closeout_changed', creditCents: 0, needsReview: true });
    });

    it('AUDIT :1172: a stored credit is cleared or replaced only by the page that saw it (its revision)', async () => {
      const { unpriced, key } = await world();
      expect((await override({ ...key, creditCents: 126000, reason: 'Checked' })).status).toBe(200);
      const first = await revisionOf(unpriced);
      // the preview shows it on the stop
      const shown = await api('GET', `/production-share/preview?technicianId=${key.technicianId}&weekStart=${W1}`);
      expect(shown.body.stops.find((row) => row.visitId === unpriced)).toMatchObject({ kind: 'owner_set', overrideRevision: first });
      // a clear or a replace with no revision, or with another one, is refused and changes nothing
      expect((await api('DELETE', '/production-share/stop-override', { body: key })).status).toBe(409);
      expect((await api('DELETE', '/production-share/stop-override', { body: { ...key, revision: 'stale' } })).status).toBe(409);
      expect((await override({ ...key, creditCents: 5, reason: 'blind replace' })).status).toBe(409);
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced })).toHaveLength(1);
      // another session replaces the credit: the first page's revision is now old
      expect((await override({ ...key, creditCents: 130000, reason: 'Second look', revision: first })).status).toBe(200);
      const second = await revisionOf(unpriced);
      expect(second).not.toBe(first);
      expect((await api('DELETE', '/production-share/stop-override', { body: { ...key, revision: first } })).status).toBe(409);
      expect((await api('DELETE', '/production-share/stop-override', { body: { ...key, revision: second } })).status).toBe(200);
    });

    it('AUDIT :1271: finalize judges the gate under the lock: off discards the earlier read, on without one reads under the lock', async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      await worked(id, W1, 40);
      await threeShifts(id);
      // the gate is turned OFF after finalize read its inputs and before it took the lock: no share is frozen
      const created = (await draft(W1)).body.run;
      expect(byName(created, 'Sample Alpha').productionShareCents).toBe(16200);
      const shownToken = (await api('GET', `/runs/${created.id}`)).body.run.token;
      const real = productionSharePay.readInputs;
      jest.spyOn(productionSharePay, 'readInputs').mockImplementation(async (...args) => {
        const inputs = await real(...args);
        process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'false';
        return inputs;
      });
      const refusal = await finalize(created.id, shownToken);
      jest.restoreAllMocks();
      process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
      expect(refusal.status).toBe(409); // the share is gone from the numbers: the draft's token is stale
      expect((await trx('payroll_checks').where({ run_id: created.id }).first('production_share_cents')).production_share_cents).toBeNull();
      expect((await api('GET', `/runs/${created.id}`)).body.run.status).toBe('draft');
    });

    it('AUDIT :1271: the gate turned ON after the early read finalizes from a read under the lock, with no retry', async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      await worked(id, W1, 40);
      await threeShifts(id);
      const created = (await draft(W1)).body.run;
      expect(id).toBeTruthy();
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      // the early read answers nothing (the gate was off then); the lock-time read must produce the share itself
      const early = jest.spyOn(productionSharePay, 'readInputs').mockImplementation(async () => null);
      const under = jest.spyOn(productionSharePay, 'readInputsUnderLock');
      const done = await finalize(created.id, shown.token);
      expect(done.status).toBe(200);
      expect(byName(done.body.run, 'Sample Alpha').productionShareCents).toBe(16200);
      expect(under).toHaveBeenCalledTimes(2); // the read the checks are made from, and the second read that confirms it
      expect(early).toHaveBeenCalledTimes(1); // only the early read: nothing read apart under the lock
    });

    it('AUDIT :913: a credit set against no conflict is ignored, as review, once the stop invoice is paid elsewhere', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const first = await stop(id, W1, '1000.00', customerId);
      const unpriced = await stop(id, weeks[1], null, customerId); // review: no price
      expect((await override({ technicianId: id, visitId: unpriced, weekStart: weeks[1], creditCents: 50000, reason: 'Checked' })).status).toBe(200);
      expect((await trx('production_share_stop_overrides').where({ visit_id: unpriced }).first('conflict_basis')).conflict_basis).toBe('[]');
      // week 1 is paid with an invoice that is, from now on, ALSO linked to the unpriced stop of week 2
      const invoiceId = (await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '1000.00', discount_amount: '0.00', tax_amount: '0.00', total: '1000.00', scheduled_service_id: first,
      }).returning('id'))[0].id;
      await finalize((await draft(W1)).body.run.id);
      await trx('invoices').where({ id: invoiceId }).update({ scheduled_service_id: unpriced });
      const check = byName((await draft(weeks[1])).body.run, 'Sample Alpha');
      const row = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops.find((r) => r.visitId === unpriced);
      expect(row).toMatchObject({ kind: 'owner_override_conflict_changed', creditCents: 0, needsReview: true });
      // clear is offered with the revision the preview shows
      const shown = await api('GET', `/production-share/preview?technicianId=${id}&weekStart=${weeks[1]}`);
      const showing = shown.body.stops.find((r) => r.visitId === unpriced);
      expect(showing).toMatchObject({ kind: 'owner_override_conflict_changed', overrideRevision: expect.any(String) });
      expect((await api('DELETE', '/production-share/stop-override', { body: { technicianId: id, visitId: unpriced, weekStart: weeks[1], revision: showing.overrideRevision } })).status).toBe(200);
    });

    it('AUDIT :313: overtime hours with the coverage not set block the check whatever the share; once set, the qualified overtime is stored', async () => {
      const id = await tech('Sample Alpha', { flsa_overtime_covered: null });
      await settings(id);
      await worked(id, W1, 40, 5);
      await stop(id, W1, '100.00'); // far under the bar: a $0 share
      const blocked = (await draft(W1)).body.run;
      expect(JSON.stringify(blocked.blocked)).toContain('Set the overtime coverage first');
      expect((await api('PUT', `/technicians/${id}/flsa-coverage`, { body: { covered: true } })).status).toBe(200);
      const fresh = (await api('POST', `/runs/${blocked.id}/recompute`)).body.run;
      expect(fresh.blocked).toEqual([]);
      const stored = await trx('payroll_checks').where({ run_id: blocked.id }).first('qualified_overtime_cents', 'production_share_cents');
      expect(stored.production_share_cents).toBe('0');
      expect(Number(stored.qualified_overtime_cents)).toBeGreaterThan(0); // the half-time premium of the 5 overtime hours
    });

    it('AUDIT :306: the overtime coverage editor opens with only the production share gate on, and a share waits until it is set', async () => {
      process.env.GATE_PAYROLL_PAY_LINES = 'false';
      const id = await tech('Sample Alpha', { flsa_overtime_covered: null });
      await settings(id);
      await worked(id, W1, 40);
      await threeShifts(id);
      const listed = await api('GET', '/technicians');
      expect(listed.body.technicians.find((t) => t.id === id)).toHaveProperty('flsaOvertimeCovered', null);
      const blocked = (await draft(W1)).body.run;
      expect(blocked.blocked.map((b) => b.name || b.technicianId)).toEqual(expect.arrayContaining([expect.anything()]));
      expect(JSON.stringify(blocked.blocked)).toContain('Set the overtime coverage first');
      const set = await api('PUT', `/technicians/${id}/flsa-coverage`, { body: { covered: true } });
      expect(set.status).toBe(200);
      // neither gate: the route stays dark
      delete process.env.GATE_PAYROLL_PRODUCTION_SHARE;
      expect((await api('PUT', `/technicians/${id}/flsa-coverage`, { body: { covered: false } })).status).toBe(404);
      process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
      const created = (await api('POST', `/runs/${blocked.id}/recompute`)).body.run;
      expect(byName(created, 'Sample Alpha').productionShareCents).toBe(16200);
    });

    it('AUDIT :1212: a credit is saved only against the stop state the page showed (conflict state), checked under the lock', async () => {
      const { unpriced, key } = await world();
      const shown = await shownBasis(key);
      expect(shown).toMatch(/^[0-9a-f]{16}$/);
      const put = (body) => api('PUT', '/production-share/stop-override', { body: { ...key, creditCents: 5000, reason: 'x', ...body } });
      expect((await put({})).status).toBe(400); // the revision of the stop must be sent
      expect((await put({ stopRevision: 'deadbeefdeadbeef' })).status).toBe(409);
      expect((await put({ stopRevision: 'deadbeefdeadbeef' })).body.error).toContain('changed since you opened it');
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced })).toEqual([]);
      expect((await put({ stopRevision: shown })).status).toBe(200);
    });

    it('AUDIT :1045: the root of the package paid on its own in another week, with no invoice link, is a conflict for a credit set earlier', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const root = await stop(id, W1, '1000.00', customerId);
      const followUp = await stop(id, weeks[1], '0.00', customerId, { followup_included: true, followup_source_service_id: root });
      // the follow-up's package is a review row (the visits it was sold with cannot be known): the owner credits it, root not yet paid
      expect((await override({ technicianId: id, visitId: followUp, weekStart: weeks[1], creditCents: 40000, reason: 'Checked' })).status).toBe(200);
      expect((await trx('production_share_stop_overrides').where({ visit_id: followUp }).first('conflict_basis')).conflict_basis).toBe('[]');
      // week 1 is paid with the root as a plain visit (the follow-up is out of the job while it is cancelled), then the follow-up comes back
      await trx('scheduled_services').where({ id: followUp }).update({ status: 'cancelled' });
      await finalize((await draft(W1)).body.run.id);
      await trx('scheduled_services').where({ id: followUp }).update({ status: 'completed' });
      const check = byName((await draft(weeks[1])).body.run, 'Sample Alpha');
      const row = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops.find((r) => r.visitId === followUp);
      expect(row).toMatchObject({ kind: 'owner_override_conflict_changed', creditCents: 0, needsReview: true });
    });

    it('AUDIT :952: a LATER payment of the same invoice changes the conflict state even when the earliest week stays the same', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const [w1, w2, w3] = [W1, addDays(W1, 7), addDays(W1, 14)];
      for (const week of [w1, w2, w3]) await worked(id, week, 40);
      const customerId = await customer();
      const v1 = await stop(id, w1, '1000.00', customerId);
      const invoiceId = (await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '1000.00', discount_amount: '0.00', tax_amount: '0.00', total: '1000.00', scheduled_service_id: v1,
      }).returning('id'))[0].id;
      await finalize((await draft(w1)).body.run.id); // week 1 pays visit 1 and records the invoice
      const relink = (visitId) => trx('invoices').where({ id: invoiceId }).update({ scheduled_service_id: visitId });
      // the invoice moves to a visit of week 3: a conflict, which the owner knowingly credits against
      const third = await stop(id, w3, null, customerId);
      await relink(third);
      const first = { technicianId: id, visitId: third, weekStart: w3 };
      expect((await override({ ...first, creditCents: 30000, reason: 'Checked' })).status).toBe(200);
      // what it was set against: the one paid row of week 1 that recorded the invoice (the tuples themselves are stored)
      expect(JSON.parse((await trx('production_share_stop_overrides').where({ visit_id: third }).first('conflict_basis')).conflict_basis)).toHaveLength(1);
      // then it moves to a visit of week 2, which the owner also credits: week 2 pays and records the same invoice
      const second = await stop(id, w2, null, customerId);
      await relink(second);
      expect((await override({ technicianId: id, visitId: second, weekStart: w2, creditCents: 20000, reason: 'Checked' })).status).toBe(200);
      await finalize((await draft(w2)).body.run.id);
      // back on the visit of week 3: the earliest week of the invoice is still week 1, but it was paid again in week 2
      await relink(third);
      const check = byName((await draft(w3)).body.run, 'Sample Alpha');
      const row = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops.find((r) => r.visitId === third);
      expect(row).toMatchObject({ kind: 'owner_override_conflict_changed', creditCents: 0, needsReview: true });
    });

    it('AUDIT :741: a REVIEW row keeps its invoice members: a visit of its invoice credited elsewhere later changes the conflict state', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      // one invoice covers two visits, one of them with no price: the invoice cannot be split, so BOTH are review rows
      const mine = await stop(id, weeks[1], '1000.00', customerId);
      const other = await stop(id, W1, null, customerId);
      const invoiceId = (await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '2000.00', discount_amount: '0.00', tax_amount: '0.00', total: '2000.00',
      }).returning('id'))[0].id;
      const [visit] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: 'k-741', created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: visit.id, idempotency_key: 'k-741', request_hash: 'h', payload: {} }).returning('id');
      for (const visitId of [mine, other]) {
        await trx('visit_completion_packet_items').insert({ packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `k-741-${visitId}`, invoice_id: invoiceId });
      }
      const shown = await api('GET', `/production-share/preview?technicianId=${id}&weekStart=${weeks[1]}`);
      expect(shown.body.stops.find((row) => row.visitId === mine)).toMatchObject({ needsReview: true, stopRevision: expect.any(String) });
      expect((await override({ technicianId: id, visitId: mine, weekStart: weeks[1], creditCents: 100000, reason: 'Checked' })).status).toBe(200);
      // the other visit of that invoice is credited by the owner in week 1 and paid: a paid row that names the invoice and that visit
      expect((await override({ technicianId: id, visitId: other, weekStart: W1, creditCents: 100000, reason: 'Checked' })).status).toBe(200);
      await finalize((await draft(W1)).body.run.id);
      const check = byName((await draft(weeks[1])).body.run, 'Sample Alpha');
      const row = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops.find((r) => r.visitId === mine);
      expect(row).toMatchObject({ kind: 'owner_override_conflict_changed', creditCents: 0, needsReview: true });
    });

    it('AUDIT :973: a package slot paid again in another week changes the conflict state (every paid row, with its week and run)', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7), addDays(W1, 14)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const root = await stop(id, W1, '2000.00', customerId, pkg);
      await finalize((await draft(W1)).body.run.id); // slot 1 of the package paid in week 1
      // a chain of three visits for a package sold with two: every visit after the first is a review row
      const extra = await stop(id, weeks[1], '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
      const followUp = await stop(id, weeks[2], '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: extra });
      // a review row (the package's invoice is shared with an outside visit)
      const outside = await stop(id, weeks[2], '300.00', await customer());
      const invoiceId = (await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '2300.00', discount_amount: '0.00', tax_amount: '0.00', total: '2300.00',
      }).returning('id'))[0].id;
      const [visit] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: 'k-973', created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: visit.id, idempotency_key: 'k-973', request_hash: 'h', payload: {} }).returning('id');
      for (const visitId of [root, outside]) {
        await trx('visit_completion_packet_items').insert({ packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `k-973-${visitId}`, invoice_id: invoiceId });
      }
      const key = { technicianId: id, visitId: followUp, weekStart: weeks[2] };
      expect((await override({ ...key, creditCents: 100000, reason: 'Checked' })).status).toBe(200);
      // the package's week 1 payment is already part of what the owner looked at
      expect(JSON.parse((await trx('production_share_stop_overrides').where({ visit_id: followUp }).first('conflict_basis')).conflict_basis)).toHaveLength(1);
      // another visit of the package is credited by the owner in week 2 and paid: a paid row with the package's basis
      expect((await override({ technicianId: id, visitId: extra, weekStart: weeks[1], creditCents: 50000, reason: 'Checked' })).status).toBe(200);
      await finalize((await draft(weeks[1])).body.run.id);
      const check = byName((await draft(weeks[2])).body.run, 'Sample Alpha');
      const row = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops.find((r) => r.visitId === followUp);
      expect(row).toMatchObject({ kind: 'owner_override_conflict_changed', creditCents: 0, needsReview: true });
    });

    it('AUDIT P1: a former employee with approved hours in an open run stays on the Payroll settings roster so the coverage can be set', async () => {
      const id = await tech('Sample Former', { employment_status: 'inactive', flsa_overtime_covered: null });
      await settings(id);
      await worked(id, W1, 40);
      const names = async () => (await api('GET', '/technicians')).body.technicians.map((t) => t.name);
      expect(await names()).not.toContain('Sample Former'); // no open run
      const draftRun = (await draft(W1)).body.run;
      expect(draftRun.status).toBe('draft');
      expect(await names()).toContain('Sample Former'); // an open (draft) run covers a week of their approved hours
      expect((await api('PUT', `/technicians/${id}/flsa-coverage`, { body: { covered: true } })).status).toBe(200);
      await api('POST', `/runs/${draftRun.id}/void`, { body: { reason: 'test' } });
      expect(await names()).not.toContain('Sample Former'); // the run is closed again
    });

    it('AUDIT :1210: a stop reclassified to a callback after the page opened is refused under the lock (the stop revision covers its pricing facts)', async () => {
      const { unpriced, key } = await world();
      const opened = await shownBasis(key);
      // the visit is reclassified as a callback after the owner opened the page: the rules now give it another kind
      await trx('scheduled_services').where({ id: unpriced }).update({ is_callback: true, service_type: 'General Pest Control Re-Service' });
      const refusal = await api('PUT', '/production-share/stop-override', { body: { ...key, creditCents: 5000, reason: 'x', stopRevision: opened } });
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toContain('changed since you opened it');
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced })).toEqual([]);
      // the page that reloads sees the new revision, and the credit is accepted against it
      expect((await shownBasis(key))).not.toBe(opened);
      expect((await override({ ...key, creditCents: 5000, reason: 'x' })).status).toBe(200);
    });

    it('AUDIT :996: the stop revision follows the invoice totals and the weights of the stop invoices', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      await worked(id, W1, 40);
      const customerId = await customer();
      const mine = await stop(id, W1, '1000.00', customerId);
      const other = await stop(id, W1, '1000.00', customerId);
      const invoiceId = (await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '2000.00', discount_amount: '0.00', tax_amount: '0.00', total: '2000.00',
      }).returning('id'))[0].id;
      const [visit] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: 'k-996', created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: visit.id, idempotency_key: 'k-996', request_hash: 'h', payload: {} }).returning('id');
      for (const visitId of [mine, other]) {
        await trx('visit_completion_packet_items').insert({ packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `k-996-${visitId}`, invoice_id: invoiceId });
      }
      const key = { technicianId: id, visitId: mine, weekStart: W1 };
      const opened = await shownBasis(key);
      expect(await shownBasis(key)).toBe(opened); // stable while nothing changes
      // the invoice total is edited: another revision
      await trx('invoices').where({ id: invoiceId }).update({ subtotal: '2400.00', total: '2400.00' });
      const afterTotal = await shownBasis(key);
      expect(afterTotal).not.toBe(opened);
      // a member's weight (its price) is edited: another revision
      await trx('scheduled_services').where({ id: other }).update({ estimated_price: '1500.00' });
      expect(await shownBasis(key)).not.toBe(afterTotal);
    });

    it('AUDIT P1 :788: for an invoice that cannot be split the revision follows its lines, setup fee, discount and member weights', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      await worked(id, W1, 40);
      const customerId = await customer();
      const mine = await stop(id, W1, '1000.00', customerId);
      const lines = (setup, discount) => JSON.stringify([
        { description: 'General pest control', amount: 100 },
        { description: 'Setup fee', amount: setup },
        { description: 'Courtesy discount', amount: -discount },
      ]);
      // a discount tied to no line beside a setup fee line: what it took off the visit cannot be established (review)
      const invoiceId = (await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '150.00', discount_amount: '0.00', tax_amount: '0.00', total: '130.00', scheduled_service_id: mine, line_items: lines(50, 20),
      }).returning('id'))[0].id;
      const key = { technicianId: id, visitId: mine, weekStart: W1 };
      const shown = await api('GET', `/production-share/preview?technicianId=${id}&weekStart=${W1}`);
      expect(shown.body.stops.find((row) => row.visitId === mine)).toMatchObject({ needsReview: true });
      const opened = await shownBasis(key);
      const edit = (update) => trx('invoices').where({ id: invoiceId }).update(update);
      await edit({ line_items: lines(60, 20) }); // the setup fee line changes
      const afterFee = await shownBasis(key);
      expect(afterFee).not.toBe(opened);
      await edit({ line_items: lines(60, 30), total: '130.00' }); // the discount changes
      const afterDiscount = await shownBasis(key);
      expect(afterDiscount).not.toBe(afterFee);
      await edit({ line_items: lines(60, 30), tax_amount: '5.00' }); // the amounts around the lines change
      expect(await shownBasis(key)).not.toBe(afterDiscount);
    });

    it('AUDIT P1 :1012: a stop priced on its own that only TOUCHES a paid invoice depends on no run', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const first = await stop(id, W1, '1000.00', customerId);
      const invoiceId = (await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '1000.00', discount_amount: '0.00', tax_amount: '0.00', total: '1000.00', scheduled_service_id: first,
      }).returning('id'))[0].id;
      const runA = (await draft(W1)).body.run;
      await finalize(runA.id); // week 1 pays the first visit and records the invoice
      // a second visit of week 2 is priced on its own, with a DRAFT invoice (no charge) that is the same invoice's id family: link it to the paid invoice's visit set
      const second = await stop(id, weeks[1], '1000.00', customerId);
      await trx('invoices').where({ id: invoiceId }).update({ status: 'draft', scheduled_service_id: second });
      const runB = (await draft(weeks[1])).body.run;
      const row = (await trx('payroll_checks').where({ run_id: runB.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops.find((r) => r.visitId === second);
      // credited from its own price; the paid row of run A touches it (the invoice) but did not decide its credit
      expect(row).toMatchObject({ kind: 'priced', creditCents: 100000 });
      expect(row).not.toHaveProperty('dependsOnRuns');
      expect((await finalize(runB.id)).body.run.status).toBe('finalized');
      // so voiding run A is not held up by this stop (the later-run rule of the same technician still applies, so void B first)
      expect((await api('POST', `/runs/${runB.id}/void`, { body: { reason: 'sample' } })).status).toBe(200);
      expect((await api('POST', `/runs/${runA.id}/void`, { body: { reason: 'sample' } })).status).toBe(200);
    });

    it('AUDIT :1115: a revision with no stored credit is refused; a credit is created only with neither', async () => {
      const { unpriced, key } = await world();
      expect((await override({ ...key, creditCents: 5000, reason: 'x', revision: 'abc123' })).status).toBe(409);
      expect((await api('DELETE', '/production-share/stop-override', { body: { ...key, revision: 'abc123' } })).status).toBe(409);
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced })).toEqual([]);
      expect((await override({ ...key, creditCents: 5000, reason: 'x' })).status).toBe(200);
      // cleared by someone else meanwhile: the page's own clear, with the revision it saw, is refused
      const seenRevision = await revisionOf(unpriced);
      expect((await clear(key)).status).toBe(200);
      expect((await api('DELETE', '/production-share/stop-override', { body: { ...key, revision: seenRevision } })).status).toBe(409);
      expect((await override({ ...key, creditCents: 6000, reason: 'again', revision: seenRevision })).status).toBe(409);
      expect((await api('DELETE', '/production-share/stop-override', { body: key })).status).toBe(404); // no revision, nothing stored
    });

    it('AUDIT :1007: a credit belongs to the technician who held the stop: after a reassignment the stop is review, and clearing works for the new holder', async () => {
      const { unpriced, key } = await world();
      const other = await tech('Sample Bravo');
      await settings(other);
      await worked(other, W1, 40);
      expect((await override({ ...key, creditCents: 126000, reason: 'Checked' })).status).toBe(200);
      await trx('scheduled_services').where({ id: unpriced }).update({ technician_id: other });
      await trx('service_records').where({ scheduled_service_id: unpriced }).update({ technician_id: other });
      const created = (await draft(W1)).body.run;
      const check = byName(created, 'Sample Bravo');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === unpriced)).toMatchObject({ kind: 'owner_override_reassigned', creditCents: 0, needsReview: true });
      // Alpha no longer holds it: her two priced stops are all she is credited, and the owner's credit is paid to nobody
      expect(byName(created, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 252000, needsReviewCount: 0 });
      // the new holder cannot reuse the old credit as a new one (the stop does not need review by the rules), but can clear it
      expect((await clear({ ...key, technicianId: other })).status).toBe(200);
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced })).toEqual([]);
    });

    it('AUDIT :1076: a clear checks the paid week of the technician stored with the credit, not the one the caller names', async () => {
      const { unpriced, key } = await world();
      const other = await tech('Sample Bravo');
      expect((await override({ ...key, creditCents: 126000, reason: 'Checked' })).status).toBe(200);
      await finalize((await draft(W1)).body.run.id); // Alpha's week is paid with the credit
      await trx('scheduled_services').where({ id: unpriced }).update({ technician_id: other });
      const refusal = await clear({ ...key, technicianId: other });
      expect(refusal.status).toBe(409);
      expect(await trx('production_share_stop_overrides').where({ visit_id: unpriced })).toHaveLength(1);
      // an unknown stop is a 404 whoever is named
      expect((await api('DELETE', '/production-share/stop-override', { body: { ...key, visitId: randomUUID() } })).status).toBe(404);
    });

    it('never beats a visit a pay run already paid: that stays already paid', async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      await worked(id, W1, 40);
      await threeShifts(id);
      await finalize((await draft(W1)).body.run.id);
      const paidVisit = (await trx('scheduled_services').where({ technician_id: id }).first('id')).id;
      // the same visit comes up in another week with a credit the owner set there: the paid week still wins
      const direct = productionShare.applyLedger(
        [{ visitId: paidVisit, workDate: addDays(W1, 8), kind: 'priced', creditCents: 100, needsReview: false, ledger: null, linkedInvoices: [] }],
        { visits: new Map([[paidVisit, { weekStart: W1, root: null }]]), invoices: new Map(), jobs: new Map() },
        new Map([[paidVisit, { creditCents: 5000, reason: 'try' }]]),
      );
      expect(direct[0]).toMatchObject({ kind: 'already_paid', creditCents: 0, needsReview: true });
    });
  });

  it('AUDIT :874: a visit that was the root of a package a pay run fixed, and is no longer a package, cannot take a standalone credit', async () => {
    const id = await tech('Sample Alpha');
    await settings(id, { bar_cents: 10000 });
    const weeks = [W1, addDays(W1, 7)];
    for (const week of weeks) await worked(id, week, 40);
    const customerId = await customer();
    const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
    // week 1: the package's FOLLOW-UP is completed first and fixes the package basis (root R, $2,000.00 total)
    const root = await stop(id, weeks[1], '2000.00', customerId, pkg);
    await stop(id, W1, '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
    await trx('scheduled_services').where({ id: root }).update({ status: 'confirmed' });
    await finalize((await draft(W1)).body.run.id);
    // the root is done later and its package link is gone: it is a plain priced visit now
    await trx('scheduled_services').where({ id: root }).update({ status: 'completed', service_type: 'General Pest Control', service_key_snapshot: 'pest_control' });
    await trx('scheduled_services').where({ followup_source_service_id: root }).update({ followup_source_service_id: null, followup_included: false });
    const check = byName((await draft(weeks[1])).body.run, 'Sample Alpha');
    expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
    const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
    expect(snapshot.stops.find((row) => row.visitId === root)).toMatchObject({ kind: 'package_paid_elsewhere', creditCents: 0, needsReview: true });
  });

  describe('AUDIT :977: the preview of one employee is not broken by another employee', () => {
    const world = async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      await worked(id, W1, 40);
      await threeShifts(id);
      await settings(await tech('Sample Bravo'));
      return id;
    };
    // The connection the service reads through, with its transaction() refusing the first `times` calls whose callback mentions `marker`,
    // at any depth (the transaction a callback receives refuses the same way).
    const failing = (marker, times) => {
      let left = times;
      const wrap = (connection) => new Proxy(connection, {
        get: (target, key) => (key === 'transaction'
          ? (work, ...rest) => (typeof work === 'function' && work.toString().includes(marker) && left-- > 0
            ? Promise.reject(new Error('another employee cannot be read'))
            : target.transaction((inner) => work(wrap(inner)), ...rest))
          : Reflect.get(target, key)),
      });
      mockConnection = wrap(trx);
    };

    it('another employee whose settings cannot be read is left out of the preview', async () => {
      const id = await world();
      failing('settingsFor', 99); // every read of ANY employee's settings in the loop fails; the selected one is read before it
      const shown = await api('GET', `/production-share/preview?technicianId=${id}&weekStart=${W1}`);
      expect(shown.status).toBe(200);
      expect(shown.body).toMatchObject({ creditedCents: 378000, shareCents: 16200 });
    });

    it('AUDIT :1046: a draft built from the per-technician retry is marked, and finalize never accepts it', async () => {
      const id = await world();
      failing('loadCreditFacts', 1); // the shared read fails once; the retry reads each employee alone
      const created = (await draft(W1)).body.run;
      mockConnection = trx;
      const check = byName(created, 'Sample Alpha');
      expect(check.productionShareCents).toBe(16200);
      const snapshotOf = async () => (await trx('payroll_checks').where({ run_id: created.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(await snapshotOf()).toMatchObject({ degraded: true });
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      expect((await finalize(created.id, shown.token)).status).toBe(409);
      // the refused finalize leaves the draft re-read under the lock, without the mark; that one finalizes
      expect(await snapshotOf()).not.toHaveProperty('degraded');
      const done = await finalize(created.id);
      expect(done.status).toBe(200);
      expect(byName(done.body.run, 'Sample Alpha').productionShareCents).toBe(16200);
      expect(id).toBeTruthy();
    });

    it('AUDIT :1046: finalize reads the credits under the lock without the retry: a failed shared read blocks the run', async () => {
      const id = await world();
      const created = (await draft(W1)).body.run;
      failing('loadCreditFacts', 99);
      const refusal = await finalize(created.id);
      mockConnection = trx;
      expect(refusal.status).not.toBe(200);
      expect((await api('GET', `/runs/${created.id}`)).body.run.status).toBe('draft');
      // the read under the lock itself: the shared read fails once, and nobody is retried
      failing('loadCreditFacts', 1);
      const inputs = await productionSharePay.readInputsUnderLock(mockConnection, W1);
      mockConnection = trx;
      expect([...inputs.values()].every((input) => input.error)).toBe(true);
      expect(inputs.has(id)).toBe(true);
      // the same failure in a draft is retried and marked
      failing('loadCreditFacts', 1);
      const retried = await productionSharePay.readInputs(mockConnection, W1);
      mockConnection = trx;
      expect(retried.get(id)).toMatchObject({ degraded: true });
      expect(productionSharePay.revisionOf(retried)).not.toBe(productionSharePay.revisionOf(await productionSharePay.readInputsUnderLock(trx, W1)));
    });

    it('AUDIT :990: an owner-set credit on a package review row takes the package total a pay run fixed', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const root = await stop(id, W1, '2000.00', customerId, pkg);
      await finalize((await draft(W1)).body.run.id); // the package total $2,000.00 is fixed with slot 1
      const followUp = await stop(id, weeks[1], '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
      // the package's invoice is now shared with a visit outside it: the follow-up is a review row
      const outside = await stop(id, weeks[1], '300.00', await customer());
      const invoiceId = await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '2300.00', discount_amount: '0.00', tax_amount: '0.00', total: '2300.00',
      }).returning('id').then((rows) => rows[0].id);
      const [visit] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: 'k-990', created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: visit.id, idempotency_key: 'k-990', request_hash: 'h', payload: {} }).returning('id');
      for (const visitId of [root, outside]) {
        await trx('visit_completion_packet_items').insert({ packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `k-990-${visitId}`, invoice_id: invoiceId });
      }
      expect((await override({ technicianId: id, visitId: followUp, weekStart: weeks[1], creditCents: 100000, reason: 'Checked' })).status).toBe(200);
      const check = byName((await draft(weeks[1])).body.run, 'Sample Alpha');
      const row = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare.stops.find((r) => r.visitId === followUp);
      expect(row).toMatchObject({ kind: 'owner_set', bases: [{ basisType: 'job', basisId: root, totalCents: 200000, sold: 2, slot: 2 }] });
    });

    it('AUDIT :1047: credits that change while finalize runs are caught by the second read: 409, nothing saved, still a draft', async () => {
      const id = await world();
      const created = (await draft(W1)).body.run;
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      const real = productionSharePay.readInputsUnderLock;
      let reads = 0;
      jest.spyOn(productionSharePay, 'readInputsUnderLock').mockImplementation(async (...args) => {
        const inputs = await real(...args);
        reads += 1;
        // a billing edit lands after the read the checks are made from and before the confirming read
        if (reads === 1) await trx('scheduled_services').where({ technician_id: id }).whereNotNull('estimated_price').update({ estimated_price: '1270.00' });
        return inputs;
      });
      const refusal = await finalize(created.id, shown.token);
      jest.restoreAllMocks();
      expect(reads).toBe(2);
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toContain('changed while this run was being finalized');
      expect((await api('GET', `/runs/${created.id}`)).body.run.status).toBe('draft');
      // nothing was saved by the refused finalize: the draft's check still holds the share it was drafted with
      expect((await trx('payroll_checks').where({ run_id: created.id }).first('production_share_cents', 'status'))).toMatchObject({ production_share_cents: '16200', status: 'draft' });
    });

    it('AUDIT :1052: finalize reads only the technicians this run can pay a share to, and still splits a shared invoice with an outside technician', async () => {
      const id = await world();
      const bravo = (await trx('technicians').where({ name: 'Sample Bravo' }).first('id')).id; // settings, but no approved hours
      const [first] = await trx('scheduled_services').where({ technician_id: id }).orderBy('scheduled_date').select('id', 'customer_id');
      const theirs = await stop(bravo, W1, '1260.00');
      const customerId = first.customer_id;
      const invoiceId = (await trx('invoices').insert({
        token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
        subtotal: '2520.00', discount_amount: '0.00', tax_amount: '0.00', total: '2520.00',
      }).returning('id'))[0].id;
      const [visit] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: 'k-1052', created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: visit.id, idempotency_key: 'k-1052', request_hash: 'h', payload: {} }).returning('id');
      for (const visitId of [first.id, theirs]) {
        await trx('visit_completion_packet_items').insert({ packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `k-1052-${visitId}`, invoice_id: invoiceId });
      }
      const created = (await draft(W1)).body.run;
      expect(byName(created, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 378000 }); // $1,260.00 of the shared invoice + 2 own stops
      const real = productionSharePay.readInputsUnderLock;
      const seen = [];
      jest.spyOn(productionSharePay, 'readInputsUnderLock').mockImplementation(async (conn, week, ids) => {
        const inputs = await real(conn, week, ids);
        seen.push({ ids, keys: [...inputs.keys()] });
        return inputs;
      });
      const done = await finalize(created.id);
      jest.restoreAllMocks();
      expect(done.status).toBe(200);
      expect(seen.length).toBeGreaterThan(0);
      for (const call of seen) {
        expect(call.ids).toEqual([id]);
        expect(call.keys).toEqual([id]);
      }
      expect(byName(done.body.run, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 378000 });
    });

    it('AUDIT :992: when the shared facts cannot be read, only the technician whose own facts fail is an error; the others keep their rows', async () => {
      const id = await world();
      const bravo = (await trx('technicians').where({ name: 'Sample Bravo' }).first('id')).id;
      await stop(bravo, addDays(W1, 1), '500.00');
      const have = new Map([[id, await productionShare.settingsFor(trx, id, W1)], [bravo, await productionShare.settingsFor(trx, bravo, W1)]]);
      failing('loadCreditFacts', 2); // the grouped read, then the first technician's own read
      const credits = await productionShare.weekCreditsFor(mockConnection, have, W1);
      const states = [...credits.values()].map((one) => (one.error ? 'error' : 'rows')).sort();
      expect(states).toEqual(['error', 'rows']);
      const rows = [...credits.values()].find((one) => one.rows).rows;
      expect(rows.length).toBeGreaterThan(0);
    });

    it('facts that cannot be read for everyone fall back to the selected employee alone, instead of failing the preview', async () => {
      const id = await world();
      failing('loadCreditFacts', 1); // the grouped read fails once; the selected employee is read alone
      const shown = await api('GET', `/production-share/preview?technicianId=${id}&weekStart=${W1}`);
      expect(shown.status).toBe(200);
      expect(shown.body).toMatchObject({ creditedCents: 378000, shareCents: 16200 });
    });
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

  it('AUDIT :861: a run whose paid rows an EARLIER final check of another technician was worked out against cannot be voided until that run is voided', async () => {
    const alpha = await tech('Sample Alpha');
    const bravo = await tech('Sample Bravo');
    await settings(alpha);
    await settings(bravo);
    const W2 = addDays(W1, 7);
    await worked(alpha, W2, 40);
    await worked(bravo, W1, 40);
    // run B (week 2) pays Alpha's visit V
    const moved = await stop(alpha, W2, '3000.00');
    const runB = (await draft(W2)).body.run;
    expect(byName(runB, 'Sample Alpha').productionShareCents).toBeGreaterThan(0);
    expect((await finalize(runB.id)).body.run.status).toBe('finalized');
    // the A to B move: V is reassigned to Bravo and its completion moves into week 1, where Bravo's check shows it already paid
    await trx('scheduled_services').where({ id: moved }).update({ technician_id: bravo, completed_at: `${W1}T16:00:00Z`, scheduled_date: W1 });
    await trx('service_records').where({ scheduled_service_id: moved }).update({ technician_id: bravo, service_date: W1 });
    await stop(bravo, addDays(W1, 1), '200.00');
    const runA = (await draft(W1)).body.run;
    expect((await finalize(runA.id)).body.run.status).toBe('finalized');
    const snapshot = (await trx('payroll_checks').where({ run_id: runA.id }).first('calc_snapshot')).calc_snapshot.productionShare;
    expect(snapshot.stops.find((row) => row.visitId === moved)).toMatchObject({ kind: 'already_paid', dependsOnRuns: [runB.id] });
    // voiding run B would hand V back: refused, naming the dependent check; nothing changes
    const refusal = await api('POST', `/runs/${runB.id}/void`, { body: { reason: 'sample' } });
    expect(refusal.status).toBe(409);
    expect(refusal.body.error).toContain(`Sample Bravo, week of ${W1}`);
    expect((await trx('payroll_runs').where({ id: runB.id }).first('status')).status).toBe('finalized');
    // void the dependent run first, then B
    expect((await api('POST', `/runs/${runA.id}/void`, { body: { reason: 'sample' } })).status).toBe(200);
    expect((await api('POST', `/runs/${runB.id}/void`, { body: { reason: 'sample' } })).status).toBe(200);
  });

  it('AUDIT P1 :311: with pay lines off and the share gate on, a week under the bar of an uncovered employee stores 0 qualified overtime, not NULL', async () => {
    const id = await tech('Sample Alpha', { flsa_overtime_covered: false });
    await settings(id);
    await worked(id, W1, 40);
    await stop(id, W1, '100.00'); // far under the $900.00 bar: share $0
    const created = (await draft(W1)).body.run;
    expect(byName(created, 'Sample Alpha')).toMatchObject({ productionShareCents: 0 });
    const stored = await trx('payroll_checks').where({ run_id: created.id }).first('qualified_overtime_cents', 'production_share_cents');
    expect(stored.production_share_cents).toBe('0');
    expect(stored.qualified_overtime_cents).toBe('0');
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

  describe('the credit ledger of earlier finalized weeks', () => {
    // One invoice over two visits priced $1,000.00 each: V1 in week 1 (paid, share above $0), V2 in week 2.
    const invoiceFor = async (customerId, total, patch = {}) => (await trx('invoices').insert({
      token: randomUUID().slice(0, 32), invoice_number: `S-${randomUUID().slice(0, 8)}`, customer_id: customerId, status: 'sent',
      subtotal: total, discount_amount: '0.00', tax_amount: '0.00', total, ...patch,
    }).returning('id'))[0].id;
    const shareInvoice = async (customerId, invoiceId, visitIds, key) => {
      const [visit] = await trx('service_visits').insert({ customer_id: customerId, scheduled_date: W1, stop_base_key: key, created_by: 'test' }).returning('id');
      const [packet] = await trx('visit_completion_packets').insert({ visit_id: visit.id, idempotency_key: key, request_hash: 'h', payload: {} }).returning('id');
      const link = (visitId) => trx('visit_completion_packet_items').insert({
        packet_id: packet.id, scheduled_service_id: visitId, derived_idempotency_key: `${key}-${visitId}`, invoice_id: invoiceId });
      for (const visitId of visitIds) await link(visitId);
      return { link, unlink: (visitId) => trx('visit_completion_packet_items').where({ scheduled_service_id: visitId }).del() };
    };
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
        const prepayInvoice = await invoiceFor(customerId, '400.00', { status: 'paid' });
        const [term] = await trx('annual_prepay_terms').insert({
          customer_id: customerId, term_start: '2026-09-01', term_end: '2027-08-31', status: 'active', prepay_amount: '400.00',
          prepay_invoice_id: prepayInvoice, coverage_visit_count: 4,
        }).returning('id');
        await trx('scheduled_services').where({ id: v2 }).update({ annual_prepay_term_id: term.id, prepaid_amount: '400.00', prepaid_method: 'annual_prepay_invoice' });
      }
      const inv = await invoiceFor(customerId, total);
      const links = await shareInvoice(customerId, inv, linkSecond ? [v1, v2] : [v1], 'k-share');
      return { id, v1, v2, inv, W2, joinSecond: () => links.link(v2), unlinkSecond: () => links.unlink(v2) };
    };
    const reprice = (world, first, second) => Promise.all([
      trx('scheduled_services').where({ id: world.v1 }).update({ estimated_price: first }),
      trx('scheduled_services').where({ id: world.v2 }).update({ estimated_price: second }),
    ]);
    const week2Stop = async (world) => {
      // a second look at the same week works the draft out again
      const open = await trx('payroll_runs').where({ week_start: world.W2 }).whereNot({ status: 'voided' }).first('id');
      const run = open ? (await api('POST', `/runs/${open.id}/recompute`)).body.run : (await draft(world.W2)).body.run;
      const check = byName(run, 'Sample Alpha');
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      return { check, stop: snapshot.stops.find((row) => row.visitId === world.v2) };
    };
    const snapshotStops = async (runId) => (await trx('payroll_checks').where({ run_id: runId }).first('calc_snapshot')).calc_snapshot.productionShare.stops;

    it('records the invoices linked to a paid stop; a later week of ANOTHER visit of that invoice is $0 + review (set by hand)', async () => {
      const world = await sharedWorld();
      const week1 = (await draft(W1)).body.run;
      // V1 is credited $1,000.00 (half the invoice, live: V2 is not paid); 1 shift, bar $900.00: share $15.00
      expect(byName(week1, 'Sample Alpha')).toMatchObject({ productionShareCents: 1500 });
      await finalize(week1.id);
      const stopsOf1 = await snapshotStops(week1.id);
      expect(stopsOf1[0].invoices).toEqual([world.inv]);
      const { check, stop: row } = await week2Stop(world);
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      expect(row).toMatchObject({ kind: 'invoice_paid_elsewhere', creditCents: 0, needsReview: true });
      expect(row).not.toHaveProperty('invoices');
    });

    it('an invoice whose visits are ALL in the week splits live, as always', async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      await worked(id, W1, 40);
      const customerId = await customer();
      const v1 = await stop(id, W1, '1000.00', customerId);
      const v2 = await stop(id, addDays(W1, 1), '1000.00', customerId);
      const inv = await invoiceFor(customerId, '2000.00');
      await shareInvoice(customerId, inv, [v1, v2], 'k-all');
      const check = byName((await draft(W1)).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 200000 });
    });

    it('AUDIT :854: a LATE invoice covering a visit already credited from its estimate, and another visit, gives the other visit nothing without a review', async () => {
      const id = await tech('Sample Alpha');
      await settings(id);
      const W2 = addDays(W1, 7);
      await worked(id, W1, 40);
      await worked(id, W2, 40);
      const customerId = await customer();
      const a = await stop(id, W1, '1000.00', customerId); // credited from its own $1,000.00 estimate: no invoice exists yet
      const b = await stop(id, W2, '1000.00', customerId);
      const week1 = (await draft(W1)).body.run;
      expect(byName(week1, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 100000 });
      await finalize(week1.id);
      // the invoice comes late, for both visits
      const inv = await invoiceFor(customerId, '2000.00');
      await shareInvoice(customerId, inv, [a, b], 'k-late');
      const check = byName((await draft(W2)).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === b)).toMatchObject({ kind: 'invoice_paid_elsewhere', creditCents: 0, needsReview: true });
    });

    it('the whole invoice repriced or its visits repriced after week 1 changes nothing: the visit of another week is review either way', async () => {
      const world = await sharedWorld();
      await finalize((await draft(W1)).body.run.id);
      await reprice(world, '1500.00', '500.00');
      expect((await week2Stop(world)).check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      await trx('invoices').where({ id: world.inv }).update({ subtotal: '1200.00', total: '1200.00' });
      expect((await week2Stop(world)).check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
    });

    it('a visit that joins an invoice that was paid whole earlier is $0 + review', async () => {
      const world = await sharedWorld({ linkSecond: false });
      const week1 = (await draft(W1)).body.run;
      await finalize(week1.id);
      expect((await snapshotStops(week1.id))[0].invoices).toEqual([world.inv]);
      await world.joinSecond();
      const { check, stop: row } = await week2Stop(world);
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      expect(row).toMatchObject({ kind: 'invoice_paid_elsewhere', creditCents: 0, needsReview: true });
    });

    it('a credit that is NOT priced from an invoice (a prepaid slice) keeps its own credit', async () => {
      const world = await sharedWorld({ stampSecond: true });
      await finalize((await draft(W1)).body.run.id);
      const { check, stop: row } = await week2Stop(world);
      expect(check.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 40000 });
      expect(row).toMatchObject({ kind: 'prepaid_plan', creditCents: 40000 });
      expect(row).not.toHaveProperty('bases');
    });

    it('the paid ledger is read by visit id, by invoice id and by package root, from other weeks only', async () => {
      const world = await sharedWorld();
      await finalize((await draft(W1)).body.run.id);
      const byInvoice = await productionShare.paidLedger(trx, [world.v2], [world.inv], [], world.W2);
      expect(byInvoice.invoices.get(world.inv)).toEqual([expect.objectContaining({ weekStart: W1, visitId: world.v1, root: null })]);
      expect(byInvoice.visits.size).toBe(0);
      const byVisit = await productionShare.paidLedger(trx, [world.v1], [], [], world.W2);
      expect(byVisit.visits.get(world.v1)).toEqual({ weekStart: W1, root: null, runId: expect.any(String) });
      expect(byVisit.invoices.get(world.inv)).toEqual([expect.objectContaining({ weekStart: W1 })]);
      // the week itself is never counted
      const own = await productionShare.paidLedger(trx, [world.v1], [world.inv], [], W1);
      expect([own.visits.size, own.invoices.size]).toEqual([0, 0]);
    });

    it('voiding the run that paid releases it: the later visit credits from the live split', async () => {
      const world = await sharedWorld();
      const week1 = (await draft(W1)).body.run;
      await finalize(week1.id);
      await reprice(world, '1500.00', '500.00');
      const run2 = (await draft(world.W2)).body.run;
      expect(byName(run2, 'Sample Alpha').productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      expect((await api('POST', `/runs/${week1.id}/void`, { body: { reason: 'sample' } })).status).toBe(200);
      const again = byName((await api('POST', `/runs/${run2.id}/recompute`)).body.run, 'Sample Alpha');
      expect(again.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 50000 });
    });

    it('a visit with an invoice paid elsewhere and its own separate invoice is review as a whole (set by hand)', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 5000 });
      const W2 = addDays(W1, 7);
      await worked(id, W1, 40);
      await worked(id, W2, 40);
      const customerId = await customer();
      const v1 = await stop(id, W1, '100.00', customerId);
      const v2 = await stop(id, W2, '100.00', customerId);
      const shared = await invoiceFor(customerId, '200.00');
      await shareInvoice(customerId, shared, [v1, v2], 'k-pi');
      const week1 = (await draft(W1)).body.run;
      expect(byName(week1, 'Sample Alpha').productionShareCents).toBeGreaterThan(0);
      await finalize(week1.id);
      await invoiceFor(customerId, '50.00', { scheduled_service_id: v2 });
      const check = byName((await draft(W2)).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
    });

    const packageWorld = async ({ price = '2000.00' } = {}) => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7), addDays(W1, 14)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const root = await stop(id, W1, price, customerId, pkg);
      return { id, customerId, pkg, root, weeks };
    };
    const followUpOf = (world, week, status = 'completed') => stop(world.id, week, '0.00', world.customerId, {
      ...world.pkg, followup_included: true, followup_source_service_id: world.root, status });

    it('PACKAGE: the total is FIXED at the first paid row: the root repriced $2,000 -> $1,200 after half was paid still gives the follow-up $1,000.00', async () => {
      const world = await packageWorld();
      const week1 = (await draft(W1)).body.run;
      expect(byName(week1, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 100000 });
      expect(byName(week1, 'Sample Alpha').productionShareCents).toBeGreaterThan(0);
      await finalize(week1.id);
      expect((await snapshotStops(week1.id))[0].bases).toEqual([{ basisType: 'job', basisId: world.root, totalCents: 200000, sold: 2, slot: 1 }]);
      await trx('scheduled_services').where({ id: world.root }).update({ estimated_price: '1200.00' });
      const followUp = await followUpOf(world, world.weeks[1]);
      const week2 = byName((await draft(world.weeks[1])).body.run, 'Sample Alpha');
      expect(week2.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
      const snapshot = (await trx('payroll_checks').where({ id: week2.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === followUp)).toMatchObject({
        kind: 'multi_visit_job', creditCents: 100000, bases: [{ basisType: 'job', basisId: world.root, totalCents: 200000, sold: 2, slot: 2 }],
      });
    });

    it('a package not repriced: the follow-up credits the second half', async () => {
      const world = await packageWorld();
      await finalize((await draft(W1)).body.run.id);
      await followUpOf(world, world.weeks[1]);
      expect(byName((await draft(world.weeks[1])).body.run, 'Sample Alpha').productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
    });

    it('THREE-CREDIT CASE: a two-visit package paid in two weeks (root, then follow-up) cannot credit a replacement follow-up a third time', async () => {
      const world = await packageWorld();
      await finalize((await draft(W1)).body.run.id);
      const followUp = await followUpOf(world, world.weeks[1]);
      const week2 = (await draft(world.weeks[1])).body.run;
      expect(byName(week2, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 100000 });
      await finalize(week2.id);
      // the follow-up is cancelled and replaced by another one, done in week 3: the package was sold with two visits
      await trx('scheduled_services').where({ id: followUp }).update({ status: 'cancelled' });
      const replacement = await followUpOf(world, world.weeks[2]);
      const check = byName((await draft(world.weeks[2])).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === replacement)).toMatchObject({ kind: 'basis_exhausted', creditCents: 0, needsReview: true });
    });

    it('AUDIT CASE: a package that fails its own checks stays a review row, whatever was paid from it', async () => {
      const world = await packageWorld();
      await finalize((await draft(W1)).body.run.id);
      // a follow-up whose first visit cannot be found: the job cannot be validated
      const orphan = await stop(world.id, world.weeks[1], '0.00', world.customerId, { ...world.pkg, followup_included: true, followup_source_service_id: null });
      const check = byName((await draft(world.weeks[1])).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      expect(check.productionShare.needsReview.map((row) => row.visitId)).toEqual([orphan]);
    });

    it('AUDIT :616: a follow-up credits from the fixed total, and keeps its slot checks, even when the root price is cleared to $0 after week 1', async () => {
      const world = await packageWorld();
      await finalize((await draft(W1)).body.run.id);
      await trx('scheduled_services').where({ id: world.root }).update({ estimated_price: '0.00' });
      const followUp = await followUpOf(world, world.weeks[1]);
      const week2 = byName((await draft(world.weeks[1])).body.run, 'Sample Alpha');
      expect(week2.productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
      const snapshot = (await trx('payroll_checks').where({ id: week2.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === followUp)).toMatchObject({
        kind: 'multi_visit_job', creditCents: 100000, bases: [{ basisType: 'job', basisId: world.root, totalCents: 200000, sold: 2, slot: 2 }],
      });
    });

    it('AUDIT :876: a package whose root was already paid on its own in another week (no package basis) is review as a whole', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      // week 1: a plain visit, paid from its own price
      const standalone = await stop(id, W1, '300.00', customerId, { service_type: 'General Pest Control', service_key_snapshot: 'pest_control' });
      await finalize((await draft(W1)).body.run.id);
      expect((await snapshotStops((await trx('payroll_runs').where({ week_start: W1 }).first('id')).id))[0].bases || []).toEqual([]);
      // the same visit later turns out to be the first visit of a package: its follow-up is done in week 2
      await trx('scheduled_services').where({ id: standalone }).update(pkg);
      await stop(id, weeks[1], '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: standalone });
      const check = byName((await draft(weeks[1])).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops[0]).toMatchObject({ kind: 'package_paid_elsewhere', creditCents: 0, needsReview: true });
    });

    it('AUDIT :726: a package priced on an invoice that a paid row OUTSIDE the package recorded is review', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const plain = await stop(id, W1, '300.00', customerId, { service_type: 'General Pest Control', service_key_snapshot: 'pest_control' });
      const invoiceId = await invoiceFor(customerId, '300.00', { scheduled_service_id: plain });
      await finalize((await draft(W1)).body.run.id);
      // the invoice is relinked to a package that is first done in week 2
      await trx('invoices').where({ id: invoiceId }).update({ scheduled_service_id: null });
      const root = await stop(id, weeks[1], '0.00', customerId, pkg);
      await trx('invoices').where({ id: invoiceId }).update({ scheduled_service_id: root });
      const check = byName((await draft(weeks[1])).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
    });

    it('AUDIT :537: a draft invoice linked to a paid stop is in its invoice history, and never in its dollars', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const first = await stop(id, W1, '1000.00', customerId);
      const second = await stop(id, weeks[1], '1000.00', customerId);
      const invoiceId = await invoiceFor(customerId, '300.00', { scheduled_service_id: first, status: 'draft' });
      const week1 = (await draft(W1)).body.run;
      // the dollars come from the visit's own price, not from the draft
      expect(byName(week1, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 100000 });
      await finalize(week1.id);
      expect((await snapshotStops(week1.id))[0].invoices).toEqual([invoiceId]);
      // the draft is issued later and moves to the other visit: that visit is review, the invoice was paid with the first
      await trx('invoices').where({ id: invoiceId }).update({ status: 'sent', scheduled_service_id: second });
      const check = byName((await draft(weeks[1])).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
    });

    it('AUDIT :500: an invoice with no status stays in the invoice history and never in the dollars', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const first = await stop(id, W1, '1000.00', customerId);
      const second = await stop(id, weeks[1], '1000.00', customerId);
      const invoiceId = await invoiceFor(customerId, '300.00', { scheduled_service_id: first });
      await trx('invoices').where({ id: invoiceId }).update({ status: null });
      const week1 = (await draft(W1)).body.run;
      expect(byName(week1, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 100000 });
      await finalize(week1.id);
      expect((await snapshotStops(week1.id))[0].invoices).toEqual([invoiceId]);
      await trx('invoices').where({ id: invoiceId }).update({ status: 'sent', scheduled_service_id: second });
      expect(byName((await draft(weeks[1])).body.run, 'Sample Alpha').productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
    });

    it('AUDIT :514: the invoice links, amounts, member visits and weights are read in ONE statement', async () => {
      const id = await tech('Sample Alpha');
      const customerId = await customer();
      const first = await stop(id, W1, '1000.00', customerId);
      const second = await stop(id, addDays(W1, 1), '1000.00', customerId);
      const invoiceId = await invoiceFor(customerId, '2000.00');
      await shareInvoice(customerId, invoiceId, [first, second], 'k-514');
      const sql = [];
      const spy = new Proxy(trx, { get: (target, key) => (key === 'raw' ? (text, ...rest) => { sql.push(String(text)); return target.raw(text, ...rest); } : Reflect.get(target, key)) });
      const facts = await productionShare.loadCreditFacts(spy, await productionShare.weekStops(trx, [id], W1));
      const reads = sql.filter((text) => /FROM invoices i/.test(text));
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatch(/WITH links AS[\s\S]*members AS/);
      // and the split still works from that one read: $1,000.00 each
      expect(facts.billed.get(first).billedCents).toBe(100000);
      expect(facts.billed.get(second).billedCents).toBe(100000);
    });

    it('AUDIT :507: an archived invoice linked to a paid stop is in its invoice history and never in its dollars', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const first = await stop(id, W1, '1000.00', customerId);
      const second = await stop(id, weeks[1], '1000.00', customerId);
      const invoiceId = await invoiceFor(customerId, '300.00', { scheduled_service_id: first });
      await trx('invoices').where({ id: invoiceId }).update({ archived_at: trx.fn.now() });
      const week1 = (await draft(W1)).body.run;
      expect(byName(week1, 'Sample Alpha').productionShare).toMatchObject({ creditedCents: 100000 });
      await finalize(week1.id);
      expect((await snapshotStops(week1.id))[0].invoices).toEqual([invoiceId]);
      await trx('invoices').where({ id: invoiceId }).update({ archived_at: null, scheduled_service_id: second });
      expect(byName((await draft(weeks[1])).body.run, 'Sample Alpha').productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
    });

    it('AUDIT :894: an invoice shared with the root of a package a pay run fixed makes the stop outside that package review', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const weeks = [W1, addDays(W1, 7)];
      for (const week of weeks) await worked(id, week, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      // week 1: only the package's follow-up is completed; it fixes the package basis (root R)
      const root = await stop(id, weeks[1], '2000.00', customerId, { ...pkg, status: 'confirmed' });
      await stop(id, W1, '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
      await finalize((await draft(W1)).body.run.id);
      // week 2: R is done, and one invoice covers R and another stop that is no part of the package
      await trx('scheduled_services').where({ id: root }).update({ status: 'completed' });
      const other = await stop(id, weeks[1], '500.00', await customer());
      const invoiceId = await invoiceFor(customerId, '2500.00');
      await shareInvoice(customerId, invoiceId, [root, other], 'k-894');
      const check = byName((await draft(weeks[1])).body.run, 'Sample Alpha');
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === other)).toMatchObject({ kind: 'package_paid_elsewhere', creditCents: 0, needsReview: true });
    });

    it('AUDIT :602: an invoice linked only to the package is the package price ONCE: $2,000.00 invoice = $1,000.00 + $1,000.00', async () => {
      const world = await packageWorld({ price: '0.00' });
      // the root and its follow-up are both on the $2,000.00 invoice; the root's own estimate is not the price
      const followUp = await followUpOf(world, world.weeks[1]);
      const invoiceId = await invoiceFor(world.customerId, '2000.00');
      await shareInvoice(world.customerId, invoiceId, [world.root, followUp], 'k-in');
      const week1 = (await draft(W1)).body.run;
      expect(byName(week1, 'Sample Alpha').productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
      await finalize(week1.id);
      const first = (await snapshotStops(week1.id))[0];
      expect(first.bases).toEqual([{ basisType: 'job', basisId: world.root, totalCents: 200000, sold: 2, slot: 1 }]);
      expect(first.invoices).toEqual([invoiceId]);
      expect(byName((await draft(world.weeks[1])).body.run, 'Sample Alpha').productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
    });

    it('a package on its own sole-visit invoice: its link removed after the first payment changes nothing (the total is fixed)', async () => {
      const world = await packageWorld();
      const invoiceId = await invoiceFor(world.customerId, '2000.00');
      const links = await shareInvoice(world.customerId, invoiceId, [world.root], 'k-pl');
      const week1 = (await draft(W1)).body.run;
      await finalize(week1.id);
      expect((await snapshotStops(week1.id))[0].bases).toEqual([{ basisType: 'job', basisId: world.root, totalCents: 200000, sold: 2, slot: 1 }]);
      await links.unlink(world.root);
      await followUpOf(world, world.weeks[1]);
      expect(byName((await draft(world.weeks[1])).body.run, 'Sample Alpha').productionShare).toMatchObject({ needsReviewCount: 0, creditedCents: 100000 });
    });

    it('AUDIT :904: a package invoice RELINKED to another visit after the package was paid: that visit is $0 + review', async () => {
      const world = await packageWorld();
      const invoiceId = await invoiceFor(world.customerId, '2000.00');
      const links = await shareInvoice(world.customerId, invoiceId, [world.root], 'k-rl');
      const week1 = (await draft(W1)).body.run;
      await finalize(week1.id);
      // the invoice moves from the package root to a plain visit of week 2
      const x = await stop(world.id, world.weeks[1], '1000.00', world.customerId);
      await links.unlink(world.root);
      await links.link(x);
      const check = byName((await draft(world.weeks[1])).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === x)).toMatchObject({ kind: 'invoice_paid_elsewhere', creditCents: 0 });
    });

    it('AUDIT CASE (nested): a package priced on an invoice SHARED with a visit outside it is $0 + needs review for every visit of the package', async () => {
      const id = await tech('Sample Alpha');
      await settings(id, { bar_cents: 10000 });
      const W2 = addDays(W1, 7);
      await worked(id, W1, 40);
      await worked(id, W2, 40);
      const customerId = await customer();
      const pkg = { service_type: 'Cockroach Treatment', service_key_snapshot: 'cockroach_control' };
      const root = await stop(id, W1, '1000.00', customerId, pkg);
      const other = await stop(id, W1, '1000.00', customerId);
      const followUp = await stop(id, W2, '0.00', customerId, { ...pkg, followup_included: true, followup_source_service_id: root });
      const invoiceId = await invoiceFor(customerId, '2000.00');
      await shareInvoice(customerId, invoiceId, [root, other], 'k-nest');
      const run1 = (await draft(W1)).body.run;
      const week1 = byName(run1, 'Sample Alpha');
      // the root is review, $0: only the other visit of the invoice credits (its live $1,000.00 share)
      expect(week1.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 100000 });
      expect(week1.productionShare.needsReview).toEqual([{ visitId: root, workDate: W1 }]);
      await finalize(run1.id);
      const check = byName((await draft(W2)).body.run, 'Sample Alpha');
      expect(check.productionShare).toMatchObject({ needsReviewCount: 1, creditedCents: 0 });
      const snapshot = (await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot')).calc_snapshot.productionShare;
      expect(snapshot.stops.find((row) => row.visitId === followUp)).toMatchObject({ kind: 'multi_visit_job', creditCents: 0, needsReview: true });
      const locked = await productionSharePay.readInputsUnderLock(trx, W2);
      expect(locked.get(id).stops.find((row) => row.visitId === followUp).reason).toContain('set its credit in the production share preview');
    });

    it('AUDIT :86: the draft (grouped read in one snapshot), the read under the lock and the preview compute the same rows for two technicians sharing an invoice', async () => {
      const a = await tech('Sample Alpha');
      const b = await tech('Sample Bravo');
      await settings(a, { bar_cents: 10000 });
      await settings(b, { bar_cents: 10000 });
      const W2 = addDays(W1, 7);
      for (const who of [a, b]) { await worked(who, W1, 40); await worked(who, W2, 40); }
      const customerId = await customer();
      const v1 = await stop(a, W1, '1000.00', customerId);
      const v2 = await stop(b, W2, '1000.00', customerId);
      const v3 = await stop(a, W2, '1000.00', customerId);
      const invoiceId = await invoiceFor(customerId, '3000.00');
      await shareInvoice(customerId, invoiceId, [v1, v2, v3], 'k-two');
      const week1 = (await draft(W1)).body.run;
      await finalize(week1.id);
      await reprice({ v1, v2 }, '1000.00', '3000.00');
      const run = (await draft(W2)).body.run;
      // the same data read the two ways: one revision, so finalize never refuses a draft of unchanged data
      const early = await productionSharePay.readInputs(trx, W2);
      const locked = await productionSharePay.readInputsUnderLock(trx, W2);
      expect(productionSharePay.revisionOf(early)).toBe(productionSharePay.revisionOf(locked));
      expect((await finalize(run.id)).body.run.status).toBe('finalized');
      // the invoice was paid for V1 in week 1: its other visits are review, for both technicians, the same in every read
      const total = [a, b].reduce((sum, who) => sum + locked.get(who).stops.reduce((s2, row) => s2 + row.creditCents, 0), 0);
      expect(total).toBe(0);
      expect(locked.get(a).stops[0].kind).toBe('invoice_paid_elsewhere');
      expect(locked.get(b).stops[0].kind).toBe('invoice_paid_elsewhere');
      // and the preview shows each technician the rows the pay run drew
      for (const who of [a, b]) {
        const preview = await productionShare.previewWeek(who, W2, trx);
        expect(preview.stops.map((row) => [row.visitId, row.creditCents])).toEqual(locked.get(who).stops.map((row) => [row.visitId, row.creditCents]));
      }
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
    const real = productionShare.weekCreditsFor;
    // conn.transaction calls inside weekCreditsFor: 1 = the shared facts, then one per technician in id order; the failing one is b's
    const failing = [a, b].sort().indexOf(b) + 2;
    const spy = jest.spyOn(productionShare, 'weekCreditsFor').mockImplementation((conn, settingsById, week) => {
      let calls = 0;
      const wrapped = new Proxy(conn, {
        get(target, key) {
          if (key !== 'transaction') return Reflect.get(target, key);
          return (handler) => {
            calls += 1;
            const at = calls;
            return target.transaction(async (sp) => { if (at === failing) await sp.raw('SELECT 1/0'); return handler(sp); });
          };
        },
      });
      return real(wrapped, settingsById, week);
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
