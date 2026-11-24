// Real PostgreSQL transactions (rolled back): the holiday work premium (payroll-runs.js holidayWorkByTechnician,
// payroll-calc.js). Hours worked on a date with a holiday time-off row earn the extra half on a line of their own (stub,
// CSV, frozen once final); no holiday row, a holiday with no work, paid time off, and a gate that is off add nothing;
// an overtime week pays both. All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
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

jest.setTimeout(60000);

const W1 = '2026-09-14'; // Monday; pay Fri 2026-09-25
const LONG_AGO = '2026-01-05';

postgres('payroll holiday work premium', () => {
  let database;
  let server;
  let baseUrl;
  let trx;
  const OLD_GATE = process.env.GATE_PAYROLL;
  const OLD_OFF = process.env.GATE_PAYROLL_TIME_OFF;
  const ADMIN_ID = randomUUID();
  const addDays = (ymd, n) => addStaffWorkDays(ymd, n);

  const tech = async (name, { minimum = null, hired = LONG_AGO } = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '22.00',
      hire_date: hired, paid_week_minimum_hours: minimum,
    });
    if (minimum != null) await trx('payroll_week_minimum_changes').insert({ technician_id: id, from_week: '2020-01-06', hours: minimum });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  // The approved week: regular and overtime minutes the pay run pays (the daily rows below are what the premium reads).
  const approved = (technicianId, weekStart, regularHours, overtimeHours = 0) => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: (regularHours * 60).toFixed(2), overtime_minutes: (overtimeHours * 60).toFixed(2),
  });
  const day = (technicianId, workDate, hours, mealMinutes = 0) => trx('time_entry_daily_summary').insert({
    technician_id: technicianId, work_date: workDate, total_shift_minutes: hours * 60, unpaid_meal_minutes: mealMinutes,
  });
  const offDay = (technicianId, workDate, hours, kind = 'holiday') => trx('payroll_time_off').insert({
    technician_id: technicianId, work_date: workDate, kind, minutes: (hours * 60).toFixed(2),
  });
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
  const finalize = async (runId) => {
    const shown = await api('GET', `/runs/${runId}`);
    return api('POST', `/runs/${runId}/finalize`, { body: { token: shown.body.run.token } });
  };
  const byName = (run, name) => run.checks.find((c) => c.name === name);
  const WED = addDays(W1, 2);

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
    process.env.GATE_PAYROLL = 'true';
    process.env.GATE_PAYROLL_TIME_OFF = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_PAYROLL; else process.env.GATE_PAYROLL = OLD_GATE;
    if (OLD_OFF === undefined) delete process.env.GATE_PAYROLL_TIME_OFF; else process.env.GATE_PAYROLL_TIME_OFF = OLD_OFF;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  // Mon 10 h, Tue 10 h, Wed (the holiday) 4 h, Thu 10 h = 34 h worked, holiday pay 10 h.
  const holidayWeek = async (id) => {
    await approved(id, W1, 34);
    await day(id, W1, 10);
    await day(id, addDays(W1, 1), 10);
    await day(id, WED, 4);
    await day(id, addDays(W1, 3), 10);
    await offDay(id, WED, 10);
  };

  it('a holiday worked 4 h at $22.00 adds $44.00 on its own line, on the stub and the CSV, and freezes once final', async () => {
    const id = await tech('Sample Alpha');
    const plain = await tech('Sample Bravo');
    await holidayWeek(id);
    await approved(plain, W1, 10);
    await day(plain, W1, 10);
    const created = (await draft(W1)).body.run;
    // 34 h at $22.00 = 748.00, holiday 10 h = 220.00, premium 4 h x $11.00 = 44.00.
    expect(byName(created, 'Sample Alpha')).toMatchObject({
      regularHours: '34.00', overtimeHours: '0.00', holidayHours: '10.00',
      regularPayCents: 74800, holidayPayCents: 22000,
      holidayWorkHours: '4.00', holidayWorkMinutes: 240, holidayWorkPremiumCents: 4400, grossCents: 101200,
    });
    // Another technician: the earlier check, with no premium keys.
    const other = byName(created, 'Sample Bravo');
    expect(other.grossCents).toBe(22000);
    expect(other).not.toHaveProperty('holidayWorkHours');
    expect(other).not.toHaveProperty('holidayWorkPremiumCents');
    expect(created.totals).toMatchObject({ grossCents: 123200, holidayWorkPremiumCents: 4400 });

    const done = (await finalize(created.id)).body.run;
    const checkId = byName(done, 'Sample Alpha').id;
    const stub = (await api('GET', `/checks/${checkId}/stub`)).body.stub;
    expect(stub.hours).toMatchObject({ regular: '34.00', holiday: '10.00', holidayWork: '4.00' });
    expect(stub.earnings).toMatchObject({ regularPayCents: 74800, holidayPayCents: 22000, holidayWorkPremiumCents: 4400, grossCents: 101200 });

    const csv = (await api('GET', `/runs/${done.id}/export.csv`, { raw: true })).text.split('\n');
    expect(csv[0].endsWith(',Holiday Pay,Holiday Work Hours,Holiday Work Premium')).toBe(true);
    expect(csv.find((line) => line.startsWith('Sample Alpha,')).endsWith(',4.00,44.00')).toBe(true);
    expect(csv.find((line) => line.startsWith('Sample Bravo,')).endsWith(',0.00,0.00')).toBe(true);

    // The row is frozen: the minutes and the pay cannot change on a final check.
    expect(await refused(() => trx('payroll_checks').where({ id: checkId }).update({ holiday_work_premium_cents: 0 }))).toBeDefined();
    expect(await refused(() => trx('payroll_checks').where({ id: checkId }).update({ holiday_work_minutes: '0.00' }))).toBeDefined();
  });

  it('no holiday row on the day: the same hours add nothing', async () => {
    const id = await tech('Sample Alpha');
    await approved(id, W1, 34);
    await day(id, W1, 10);
    await day(id, addDays(W1, 1), 10);
    await day(id, WED, 4);
    await day(id, addDays(W1, 3), 10);
    const created = (await draft(W1)).body.run;
    const check = byName(created, 'Sample Alpha');
    expect(check).toMatchObject({ regularHours: '34.00', grossCents: 74800 });
    expect(check).not.toHaveProperty('holidayWorkPremiumCents');
    expect(created.totals).not.toHaveProperty('holidayWorkPremiumCents');
    const done = (await finalize(created.id)).body.run;
    const csv = (await api('GET', `/runs/${done.id}/export.csv`, { raw: true })).text;
    expect(csv).not.toContain('Holiday Work');
  });

  it('paid time off on the day, and a holiday on another day, add nothing', async () => {
    const id = await tech('Sample Alpha');
    await approved(id, W1, 34);
    await day(id, W1, 10);
    await day(id, addDays(W1, 1), 10);
    await day(id, WED, 4);
    await day(id, addDays(W1, 3), 10);
    // Paid time off is not a holiday; the holiday falls on Friday, a day with no work.
    await offDay(id, WED, 4, 'pto');
    await offDay(id, addDays(W1, 4), 10, 'holiday');
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    expect(check).toMatchObject({ regularHours: '34.00', holidayHours: '10.00', holidayPayCents: 22000 });
    expect(check).not.toHaveProperty('holidayWorkPremiumCents');
  });

  it('a holiday with no work on it: holiday pay only', async () => {
    const id = await tech('Sample Alpha');
    await approved(id, W1, 30);
    await day(id, W1, 10);
    await day(id, addDays(W1, 1), 10);
    await day(id, addDays(W1, 3), 10);
    await offDay(id, WED, 10);
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    expect(check).toMatchObject({ holidayHours: '10.00', grossCents: 66000 + 22000 });
    expect(check).not.toHaveProperty('holidayWorkPremiumCents');
  });

  it('a holiday week with no hours worked makes a holiday pay check and no premium', async () => {
    const id = await tech('Sample Alpha');
    await offDay(id, WED, 10);
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    expect(check).toMatchObject({ holidayHours: '10.00', grossCents: 22000 });
    expect(check).not.toHaveProperty('holidayWorkPremiumCents');
  });

  it('an overtime week pays both: overtime at 1.5 on every hour past 40, and the premium on top', async () => {
    // Mon 10, Tue 10, Wed (holiday) 8, Thu 10, Fri 10 = 48 h: 40 regular + 8 overtime. Holiday pay 10 h.
    const id = await tech('Sample Alpha');
    await approved(id, W1, 40, 8);
    await day(id, W1, 10);
    await day(id, addDays(W1, 1), 10);
    await day(id, WED, 8);
    await day(id, addDays(W1, 3), 10);
    await day(id, addDays(W1, 4), 10);
    await offDay(id, WED, 10);
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    // 40 h x 22.00 = 880.00; 8 h x 33.00 = 264.00; holiday 220.00; premium 8 h x 11.00 = 88.00.
    expect(check).toMatchObject({
      regularPayCents: 88000, overtimePayCents: 26400, holidayPayCents: 22000,
      holidayWorkHours: '8.00', holidayWorkPremiumCents: 8800, grossCents: 88000 + 26400 + 22000 + 8800,
    });
  });

  it('reads the paid minutes of the day: the unpaid meal comes off, and never more than the week pays', async () => {
    const id = await tech('Sample Alpha');
    await approved(id, W1, 20);
    await day(id, W1, 10);
    // Wednesday: 5 h on the clock less a 1 h unpaid meal = 4 paid hours.
    await day(id, addDays(W1, 1), 5, 60);
    await day(id, WED, 5, 60);
    await offDay(id, WED, 10);
    await offDay(id, addDays(W1, 1), 10);
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    // Tuesday and Wednesday are both holidays here: 4 h + 4 h of paid minutes, premium 8 h x $11.00.
    expect(check).toMatchObject({ holidayWorkHours: '8.00', holidayWorkPremiumCents: 8800 });
  });

  it('never pays the premium on more minutes than the week pays as worked', async () => {
    // The week pays 2 h worked; the day row holds 4 h (a day edited after approval): the premium reads 2 h.
    const capped = await tech('Sample Bravo');
    await approved(capped, W1, 2);
    await day(capped, WED, 4);
    await offDay(capped, WED, 10);
    expect(byName((await draft(W1)).body.run, 'Sample Bravo')).toMatchObject({ holidayWorkHours: '2.00', holidayWorkPremiumCents: 2200 });
  });

  it('is not hours: the minimum paid week still tops up the worked and holiday hours, and the premium comes on top', async () => {
    // Minimum 40 h. Worked 24 h (4 of them on the holiday) + holiday pay 10 h = 34 h: the minimum adds 6 h.
    const id = await tech('Sample Alpha', { minimum: '40' });
    await approved(id, W1, 24);
    await day(id, W1, 10);
    await day(id, addDays(W1, 1), 10);
    await day(id, WED, 4);
    await offDay(id, WED, 10);
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    expect(check).toMatchObject({
      minimumWeekHours: '6.00', minimumWeekPayCents: 13200, holidayWorkPremiumCents: 4400,
      grossCents: 52800 + 22000 + 13200 + 4400,
    });
  });

  it('a draft goes stale when the holiday or the day changes after drafting', async () => {
    const id = await tech('Sample Alpha');
    await approved(id, W1, 34);
    await day(id, W1, 10);
    await day(id, addDays(W1, 1), 10);
    await day(id, WED, 4);
    await day(id, addDays(W1, 3), 10);
    const created = (await draft(W1)).body.run;
    expect(created.stale).toBe(false);
    await offDay(id, WED, 10);
    const shown = (await api('GET', `/runs/${created.id}`)).body.run;
    expect(shown.stale).toBe(true);
    expect(byName(created, 'Sample Alpha')).not.toHaveProperty('holidayWorkPremiumCents');
  });

  it('with time off turned off the check is the earlier one, no premium', async () => {
    delete process.env.GATE_PAYROLL_TIME_OFF;
    const id = await tech('Sample Alpha');
    await holidayWeek(id);
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    expect(check).toMatchObject({ regularHours: '34.00', grossCents: 74800 });
    expect(check).not.toHaveProperty('holidayWorkPremiumCents');
  });

  it('the two columns are both set or both empty, and never negative', async () => {
    const id = await tech('Sample Alpha');
    await holidayWeek(id);
    const created = (await draft(W1)).body.run;
    const checkId = byName(created, 'Sample Alpha').id;
    expect(await refused(() => trx('payroll_checks').where({ id: checkId }).update({ holiday_work_premium_cents: null }))).toBeDefined();
    expect(await refused(() => trx('payroll_checks').where({ id: checkId }).update({ holiday_work_minutes: '-1.00' }))).toBeDefined();
    expect(await refused(() => trx('payroll_checks').where({ id: checkId }).update({ holiday_work_premium_cents: -1 }))).toBeDefined();
  });
});
