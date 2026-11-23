// Real PostgreSQL transactions (rolled back): the minimum paid week (payroll-week-minimum.js). A short week topped up
// on its own line (stub, CSV, frozen once final), rule *a* (the minimum less unpaid time off), the first week from the
// hire date, the payout week up to the last recorded day, a technician with no minimum unchanged, and the owner-only
// setting. All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
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
const { NO_LAST_DAY } = require('../services/payroll-week-minimum');
const { addStaffWorkDays } = require('../utils/staff-time-work-date');

jest.setTimeout(60000);

const W1 = '2026-09-14'; // Monday; pay Fri 2026-09-25
const LONG_AGO = '2026-01-05';
const OWNER = 'contact@wavespestcontrol.com';

postgres('payroll minimum paid week', () => {
  let database;
  let server;
  let baseUrl;
  let trx;
  const OLD_GATE = process.env.GATE_PAYROLL;
  const OLD_OFF = process.env.GATE_PAYROLL_TIME_OFF;
  const ADMIN_ID = randomUUID();
  const addDays = (ymd, n) => addStaffWorkDays(ymd, n);

  const tech = async (name, { minimum = '40', hours = null, hired = LONG_AGO, ...patch } = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '22.00',
      pto_hours_per_year: hours, hire_date: hired, paid_week_minimum_hours: minimum, ...patch,
    });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const worked = (technicianId, weekStart, hours) => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: (hours * 60).toFixed(2), overtime_minutes: '0.00',
  });
  const offDay = (technicianId, workDate, hours, kind = 'pto') => trx('payroll_time_off').insert({
    technician_id: technicianId, work_date: workDate, kind, minutes: (hours * 60).toFixed(2),
  });
  const refused = async (work) => {
    await trx.raw('SAVEPOINT attempt');
    let error;
    try { await work(); } catch (err) { error = err; }
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    return error;
  };
  const api = async (method, path, { body, email, raw = false } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID, ...(email ? { 'x-test-email': email } : {}) },
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

  it('tops a 30-hour week up to 40 on its own line, shows it on the stub and the CSV, and freezes it once final', async () => {
    const id = await tech('Sample Alpha');
    const plain = await tech('Sample Bravo', { minimum: null });
    await worked(id, W1, 30);
    await worked(plain, W1, 30);
    const created = (await draft(W1)).body.run;
    expect(byName(created, 'Sample Alpha')).toMatchObject({
      regularHours: '30.00', overtimeHours: '0.00', minimumWeekHours: '10.00',
      regularPayCents: 66000, overtimePayCents: 0, minimumWeekPayCents: 22000, grossCents: 88000,
    });
    // No minimum: exactly the earlier check, no minimum keys.
    const other = byName(created, 'Sample Bravo');
    expect(other.grossCents).toBe(66000);
    expect(other).not.toHaveProperty('minimumWeekHours');
    expect(created.totals).toMatchObject({ grossCents: 154000, minimumWeekPayCents: 22000 });

    const done = (await finalize(created.id)).body.run;
    const checkId = byName(done, 'Sample Alpha').id;
    const stub = (await api('GET', `/checks/${checkId}/stub`)).body.stub;
    expect(stub.hours).toMatchObject({ regular: '30.00', minimumWeek: '10.00' });
    expect(stub.earnings).toMatchObject({ regularPayCents: 66000, minimumWeekPayCents: 22000, grossCents: 88000 });

    const csv = (await api('GET', `/runs/${done.id}/export.csv`, { raw: true })).text.split('\n');
    expect(csv[0].endsWith(',Holiday Pay,Minimum Week Hours,Minimum Week Pay')).toBe(true);
    expect(csv.find((line) => line.startsWith('Sample Alpha,')).endsWith(',10.00,220.00')).toBe(true);
    expect(csv.find((line) => line.startsWith('Sample Bravo,')).endsWith(',0.00,0.00')).toBe(true);

    const error = await refused(() => trx('payroll_checks').where({ id: checkId }).update({ minimum_week_pay_cents: 0 }));
    expect(error).toBeDefined();
  });

  it('paid time off and holidays count toward the minimum', async () => {
    const id = await tech('Sample Alpha');
    await worked(id, W1, 30);
    await offDay(id, addDays(W1, 3), 10, 'holiday');
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    expect(check).toMatchObject({ holidayHours: '10.00', minimumWeekHours: '0.00', minimumWeekPayCents: 0, grossCents: 88000 });
  });

  it('rule a: the minimum less the time off the bank could not pay', async () => {
    // An empty bank pays none of the 10 h of time off: minimum 40 - 10 = 30, worked 20, so 10 h added.
    const id = await tech('Sample Alpha', { hours: '80' });
    await worked(id, W1, 20);
    await offDay(id, addDays(W1, 2), 10);
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    expect(check).toMatchObject({ ptoHours: '0.00', regularHours: '20.00', minimumWeekHours: '10.00', grossCents: 66000 });
  });

  it('the first week counts the scheduled days from the hire date', async () => {
    // Hired Wednesday: Wed + Thu of Mon-Thu = 20 h minimum; worked 12 h, so 8 h added.
    const id = await tech('Sample Alpha', { hired: addDays(W1, 2) });
    await worked(id, W1, 12);
    expect(byName((await draft(W1)).body.run, 'Sample Alpha')).toMatchObject({ minimumWeekHours: '8.00', grossCents: 44000 });
  });

  it('the week the bank is paid out counts the scheduled days up to the last recorded day', async () => {
    // Last shift Tuesday: Mon + Tue = 20 h minimum; 15 h worked, so 5 h added (25 h in any other week).
    const id = await tech('Sample Alpha', { hours: '80', pto_payout_week_start: W1 });
    await worked(id, W1, 15);
    await trx('time_entries').insert({
      id: randomUUID(), technician_id: id, entry_type: 'shift', status: 'completed', approval_status: 'approved',
      clock_in: `${addDays(W1, 1)}T12:00:00Z`, clock_out: `${addDays(W1, 1)}T20:00:00Z`, duration_minutes: 480,
    });
    const check = byName((await draft(W1)).body.run, 'Sample Alpha');
    expect(check).toMatchObject({ regularHours: '15.00', minimumWeekHours: '5.00' });
  });

  it('an employee who left with no bank: the last week counts the days up to the last daily summary with work', async () => {
    // Inactive, no bank, nothing after the week; worked Mon + Tue per the daily summaries: 20 h minimum, 15 worked.
    const id = await tech('Sample Alpha', { employment_status: 'inactive' });
    await worked(id, W1, 15);
    await trx('time_entry_daily_summary').insert([
      { technician_id: id, work_date: W1, total_shift_minutes: 480 },
      { technician_id: id, work_date: addDays(W1, 1), total_shift_minutes: 420 },
    ]);
    expect(byName((await draft(W1)).body.run, 'Sample Alpha')).toMatchObject({ regularHours: '15.00', minimumWeekHours: '5.00' });
  });

  it('an inactive employee with work after the week: the week is not the last one, the full minimum applies', async () => {
    const id = await tech('Sample Alpha', { employment_status: 'inactive' });
    await worked(id, W1, 15);
    await trx('time_entry_daily_summary').insert([
      { technician_id: id, work_date: W1, total_shift_minutes: 900 },
      { technician_id: id, work_date: addDays(W1, 8), total_shift_minutes: 480 },
    ]);
    expect(byName((await draft(W1)).body.run, 'Sample Alpha')).toMatchObject({ minimumWeekHours: '25.00' });
  });

  it('a later weekly timesheet with worked minutes means the week is not the last one', async () => {
    const id = await tech('Sample Alpha', { employment_status: 'inactive' });
    await worked(id, W1, 15);
    await worked(id, addDays(W1, 7), 8);
    await trx('time_entry_daily_summary').insert({ technician_id: id, work_date: addDays(W1, 1), total_shift_minutes: 900 });
    expect(byName((await draft(W1)).body.run, 'Sample Alpha')).toMatchObject({ minimumWeekHours: '25.00' });
  });

  it('lists an employee who has left while a minimum is set, so it can be cleared', async () => {
    const id = await tech('Sample Alpha', { employment_status: 'inactive' });
    const gone = await tech('Sample Bravo', { employment_status: 'inactive', minimum: null });
    const listed = (await api('GET', '/technicians')).body.technicians.map((row) => row.id);
    expect(listed).toContain(id);
    expect(listed).not.toContain(gone);
  });

  it('holds a last week with paid hours and no dated day on file, with a reason', async () => {
    const id = await tech('Sample Alpha', { employment_status: 'inactive' });
    await worked(id, W1, 15);
    const run = (await draft(W1)).body.run;
    expect(run.checks).toEqual([]);
    expect(run.blocked).toEqual([{ technicianId: id, name: 'Sample Alpha', reason: NO_LAST_DAY }]);
  });

  it('a week with no work and no time off on file gets no check from the minimum', async () => {
    await tech('Sample Alpha');
    const created = await draft(W1);
    expect((created.body.run?.checks || []).length).toBe(0);
  });

  it('the setting: owner account only, 0 to 40 hours, empty clears it, and a draft read before it goes stale', async () => {
    const id = await tech('Sample Alpha', { minimum: null });
    await worked(id, W1, 30);
    const created = (await draft(W1)).body.run;
    const shown = (await api('GET', `/runs/${created.id}`)).body.run;
    expect((await api('PUT', `/technicians/${id}/week-minimum`, { body: { hours: '40' } })).status).toBe(403);
    expect((await api('PUT', `/technicians/${id}/week-minimum`, { body: { hours: '41' }, email: OWNER })).status).toBe(400);
    expect((await api('PUT', `/technicians/${id}/week-minimum`, { body: { hours: '0' }, email: OWNER })).status).toBe(400);
    const set = await api('PUT', `/technicians/${id}/week-minimum`, { body: { hours: '40' }, email: OWNER });
    expect([set.status, set.body]).toEqual([200, { technician: { id, paidWeekMinimumHours: 40 } }]);
    const stale = await api('POST', `/runs/${created.id}/finalize`, { body: { token: shown.token } });
    expect(stale.status).toBe(409);
    const listed = (await api('GET', '/technicians')).body.technicians.find((row) => row.id === id);
    expect(listed.paidWeekMinimumHours).toBe(40);
    const cleared = await api('PUT', `/technicians/${id}/week-minimum`, { body: { hours: '' }, email: OWNER });
    expect(cleared.body.technician.paidWeekMinimumHours).toBe(null);
    const audit = await trx('audit_log').where({ action: 'payroll.week_minimum_changed', resource_id: id }).count('* as n').first();
    expect(Number(audit.n)).toBe(2);
  });
});
