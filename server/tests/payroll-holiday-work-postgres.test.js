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
const { parseETDateTime } = require('../utils/datetime-et');
const { readBonusPay } = require('../services/tech-rewards-scoreboard');

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
  // A completed shift with clock times (Eastern wall times) and the day row the weekly pay is summed from.
  const shift = async (technicianId, fromWall, toWall, { meal = 0 } = {}) => {
    const from = parseETDateTime(fromWall);
    const to = parseETDateTime(toWall);
    const minutes = (to - from) / 60000;
    await trx('time_entries').insert({
      technician_id: technicianId, entry_type: 'shift', status: 'completed', clock_in: from, clock_out: to, duration_minutes: minutes.toFixed(2),
    });
    const workDate = fromWall.slice(0, 10);
    const existing = await trx('time_entry_daily_summary').where({ technician_id: technicianId, work_date: workDate }).first('id', 'total_shift_minutes');
    if (existing) {
      await trx('time_entry_daily_summary').where({ id: existing.id }).update({ total_shift_minutes: Number(existing.total_shift_minutes) + minutes, unpaid_meal_minutes: meal });
    } else {
      await day(technicianId, workDate, minutes / 60, meal);
    }
  };

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

  it('a 10 PM to 2 AM shift earns the 2 hours inside the holiday whichever night it starts on', async () => {
    // Alpha starts Tuesday 10 PM (the night before the Wednesday holiday); Bravo starts Wednesday 10 PM. Both: 2 h, $22.00.
    const alpha = await tech('Sample Alpha');
    const bravo = await tech('Sample Bravo');
    await approved(alpha, W1, 4);
    await approved(bravo, W1, 4);
    await shift(alpha, `${addDays(W1, 1)}T22:00`, `${WED}T02:00`);
    await shift(bravo, `${WED}T22:00`, `${addDays(W1, 3)}T02:00`);
    await offDay(alpha, WED, 10);
    await offDay(bravo, WED, 10);
    const created = (await draft(W1)).body.run;
    expect(byName(created, 'Sample Alpha')).toMatchObject({ holidayWorkHours: '2.00', holidayWorkPremiumCents: 2200 });
    expect(byName(created, 'Sample Bravo')).toMatchObject({ holidayWorkHours: '2.00', holidayWorkPremiumCents: 2200 });
  });

  it('takes the meal that falls inside the holiday off, and keeps the days frozen on the check for Tech Rewards', async () => {
    // Wed 08:00-18:00 with 30 minutes of automatic meal: 570 paid minutes on the holiday.
    const id = await tech('Sample Alpha');
    await approved(id, W1, 9.5);
    await shift(id, `${WED}T08:00`, `${WED}T18:00`, { meal: 30 });
    await offDay(id, WED, 10);
    const created = (await draft(W1)).body.run;
    expect(byName(created, 'Sample Alpha')).toMatchObject({ holidayWorkHours: '9.50', holidayWorkPremiumCents: 10450 });
    const done = (await finalize(created.id)).body.run;
    const stored = await trx('payroll_checks').where({ id: byName(done, 'Sample Alpha').id })
      .first(trx.raw("calc_snapshot->'holidayWorkDays' AS days"));
    expect(stored.days).toEqual([{ workDate: WED, minutes: 570 }]);
    // frozen once final
    const checkId = byName(done, 'Sample Alpha').id;
    expect(await refused(() => trx('payroll_checks').where({ id: checkId }).update({ calc_snapshot: JSON.stringify({}) }))).toBeDefined();
  });

  it('Tech Rewards dates the premium by the holiday worked: a bonus window ending that Monday holds all of it', async () => {
    // Monday holiday, worked 4 h: regular 88.00 + holiday pay 220.00 + premium 44.00, all earned on the Monday.
    const id = await tech('Sample Alpha');
    await approved(id, W1, 4);
    await shift(id, `${W1}T08:00`, `${W1}T12:00`);
    await offDay(id, W1, 10);
    const created = (await draft(W1)).body.run;
    expect(byName(created, 'Sample Alpha')).toMatchObject({ holidayWorkPremiumCents: 4400, grossCents: 8800 + 22000 + 4400 });
    await finalize(created.id);
    // window ends Monday: the whole check, premium included (a flat seven-day spread would hold only 629 of its 4400)
    expect((await readBonusPay(trx, id, W1, W1)).cents).toBe(35200);
    // a window starting Tuesday holds none of it
    expect((await readBonusPay(trx, id, addDays(W1, 1), addDays(W1, 6), W1)).cents).toBe(0);
  });

  it('a week that straddles the cutoff splits the premium by the minutes worked on each holiday', async () => {
    // Monday and Tuesday are both holidays: 4 h worked each. Window ends Monday: wages, holiday pay and premium split in half.
    const id = await tech('Sample Alpha');
    await approved(id, W1, 8);
    await shift(id, `${W1}T08:00`, `${W1}T12:00`);
    await shift(id, `${addDays(W1, 1)}T08:00`, `${addDays(W1, 1)}T12:00`);
    await offDay(id, W1, 10);
    await offDay(id, addDays(W1, 1), 10);
    const created = (await draft(W1)).body.run;
    expect(byName(created, 'Sample Alpha')).toMatchObject({ holidayWorkPremiumCents: 8800, grossCents: 17600 + 44000 + 8800 });
    await finalize(created.id);
    expect((await readBonusPay(trx, id, W1, W1)).cents).toBe((17600 + 44000 + 8800) / 2);
  });

  it('a Sunday 10 PM to Monday 2 AM shift is paid its 2 holiday hours on the Sunday week, dated Monday, once, even with no other shift in the holiday week', async () => {
    const W0 = addDays(W1, -7);
    const id = await tech('Sample Alpha');
    // the only shift of W0 is Sunday night; the holiday is the Monday of W1, which has no shift at all (holiday pay only)
    await approved(id, W0, 4);
    await shift(id, `${addDays(W0, 6)}T22:00`, `${W1}T02:00`);
    await offDay(id, W1, 10);
    const prior = (await draft(W0)).body.run;
    expect(byName(prior, 'Sample Alpha')).toMatchObject({ regularHours: '4.00', holidayWorkHours: '2.00', holidayWorkPremiumCents: 2200 });
    // the holiday week is a holiday pay check and pays no premium for that shift
    const holidayWeek = (await draft(W1)).body.run;
    expect(byName(holidayWeek, 'Sample Alpha')).toMatchObject({ holidayHours: '10.00', grossCents: 22000 });
    expect(byName(holidayWeek, 'Sample Alpha')).not.toHaveProperty('holidayWorkPremiumCents');
    // the premium is dated by the Monday it was earned on, frozen with the check
    const done = (await finalize(prior.id)).body.run;
    const stored = await trx('payroll_checks').where({ id: byName(done, 'Sample Alpha').id }).first(trx.raw("calc_snapshot->'holidayWorkDays' AS days"));
    expect(stored.days).toEqual([{ workDate: W1, minutes: 120 }]);
    // Tech Rewards: a window that starts on the holiday Monday holds the premium of the week before
    expect((await readBonusPay(trx, id, W1, W1)).cents).toBe(2200);
    // a window that ends the Sunday before holds none of it
    expect((await readBonusPay(trx, id, W0, addDays(W0, 6))).cents).toBe(byName(done, 'Sample Alpha').grossCents - 2200);
  });

  it('a corrected shift from Monday 11 PM to Wednesday 1 AM earns Tuesday and Wednesday, each by its own minutes', async () => {
    const id = await tech('Sample Alpha');
    await approved(id, W1, 26);
    await shift(id, `${W1}T23:00`, `${WED}T01:00`);
    await offDay(id, addDays(W1, 1), 10);
    await offDay(id, WED, 10);
    const created = (await draft(W1)).body.run;
    // Tuesday 24 h + Wednesday 1 h = 25 h of premium at $11.00
    expect(byName(created, 'Sample Alpha')).toMatchObject({ regularHours: '26.00', holidayWorkHours: '25.00', holidayWorkPremiumCents: 27500 });
    const done = (await finalize(created.id)).body.run;
    const stored = await trx('payroll_checks').where({ id: byName(done, 'Sample Alpha').id }).first(trx.raw("calc_snapshot->'holidayWorkDays' AS days"));
    expect(stored.days).toEqual([{ workDate: addDays(W1, 1), minutes: 1440 }, { workDate: WED, minutes: 60 }]);
  });

  it('reads holidays up to the day the shifts actually end, and Tech Rewards reads the frozen holiday dates however far back the check is', async () => {
    // A shift that starts on W0's Sunday night and ends 9 days later holds the whole of a holiday two weeks after its own week.
    const W0 = addDays(W1, -7);
    const holiday = addDays(W0, 15);
    const id = await tech('Sample Alpha');
    const minutes = 9 * 24 * 60 + 3 * 60;
    await approved(id, W0, minutes / 60);
    await shift(id, `${addDays(W0, 6)}T23:00`, `${addDays(W0, 16)}T02:00`);
    await offDay(id, holiday, 10);
    const created = (await draft(W0)).body.run;
    expect(byName(created, 'Sample Alpha')).toMatchObject({ holidayWorkHours: '24.00', holidayWorkPremiumCents: 26400 });
    await finalize(created.id);
    // a window that starts on that holiday: the check is two weeks back, and its own frozen date puts it in
    expect((await readBonusPay(trx, id, holiday, holiday, addDays(holiday, 6))).cents).toBe(26400);
    // a window that starts the day after it holds none
    expect((await readBonusPay(trx, id, addDays(holiday, 1), addDays(holiday, 8), addDays(holiday, 1))).cents).toBe(0);
  });

  describe('a holiday edit that would change a final check', () => {
    const W0 = addDays(W1, -7);
    const post = (technicianId, workDate, kind = 'holiday') => api('POST', '/time-off', { body: { technicianId, workDate, kind, hours: 10 } });
    // W0's only shift runs Sunday 10 PM to the Monday that opens W1, and W0's run is final.
    const finalWeek = async (id) => {
      await approved(id, W0, 4);
      await shift(id, `${addDays(W0, 6)}T22:00`, `${W1}T02:00`);
      return (await finalize((await draft(W0)).body.run.id)).body.run;
    };

    it('refuses a holiday added on a date a final check\'s shift runs into, and takes it once that pay run is void', async () => {
      const id = await tech('Sample Alpha');
      const done = await finalWeek(id);
      const refusedAdd = await post(id, W1);
      expect([refusedAdd.status, refusedAdd.body.error]).toEqual([409, 'A final pay run already paid a shift that runs into that day. Void that pay run first to change its pay.']);
      expect(await trx('payroll_time_off').where({ technician_id: id })).toHaveLength(0);
      expect((await api('POST', `/runs/${done.id}/void`, { body: { reason: 'Sample correction' } })).status).toBe(200);
      expect((await post(id, W1)).status).toBe(201);
    });

    it('refuses to change or take off such a holiday once the shift is paid by a final check', async () => {
      const id = await tech('Sample Alpha');
      await approved(id, W0, 4);
      await shift(id, `${addDays(W0, 6)}T22:00`, `${W1}T02:00`);
      const entry = (await post(id, W1)).body.entry;
      expect(entry.workDate).toBe(W1);
      await finalize((await draft(W0)).body.run.id);
      const changed = await api('PUT', `/time-off/${entry.id}`, { body: { kind: 'pto', hours: 10 } });
      expect([changed.status, changed.body.error]).toEqual([409, 'A final pay run already paid a shift that runs into that day. Void that pay run first to change its pay.']);
      const removed = await api('DELETE', `/time-off/${entry.id}`);
      expect([removed.status, removed.body.error]).toEqual([409, 'A final pay run already paid a shift that runs into that day. Void that pay run first to change its pay.']);
      expect(await trx('payroll_time_off').where({ id: entry.id })).toHaveLength(1);
    });

    it('refuses to void or move a Monday meal break inside the paid Sunday holiday shift, and allows it once that run is void', async () => {
      const { voidEntry, adminEditEntry } = require('../services/time-tracking');
      const id = await tech('Sample Alpha');
      await approved(id, W0, 8);
      await shift(id, `${addDays(W0, 6)}T20:00`, `${W1}T04:00`, { meal: 30 });
      const [meal] = await trx('time_entries').insert({
        technician_id: id, entry_type: 'break', status: 'completed', clock_in: parseETDateTime(`${W1}T01:00`), clock_out: parseETDateTime(`${W1}T01:30`), duration_minutes: '30.00',
      }).returning('id');
      expect((await post(id, W1)).status).toBe(201);
      const done = (await finalize((await draft(W0)).body.run.id)).body.run;
      expect(byName(done, 'Sample Alpha')).toMatchObject({ holidayWorkHours: '3.50' });
      const message = 'A final pay run paid a holiday shift that this break falls in. Void that pay run before changing this break.';
      await expect(voidEntry(meal.id, { reason: 'Sample', voided_by: null })).rejects.toMatchObject({ statusCode: 409, message });
      await expect(adminEditEntry(meal.id, {
        clock_in: parseETDateTime(`${W1}T05:00`).toISOString(), clock_out: parseETDateTime(`${W1}T05:30`).toISOString(), edit_reason: 'Sample', edited_by: null,
      })).rejects.toMatchObject({ statusCode: 409, message });
      expect(await trx('time_entries').where({ id: meal.id }).first('status')).toEqual({ status: 'completed' });
      expect((await api('POST', `/runs/${done.id}/void`, { body: { reason: 'Sample correction' } })).status).toBe(200);
      await expect(voidEntry(meal.id, { reason: 'Sample', voided_by: null })).resolves.toBeTruthy();
    });

    it('does not refuse a break edit when no final check pays a holiday shift around it', async () => {
      const { paidWeeksReadingBreak } = require('../services/payroll-holiday-work');
      const id = await tech('Sample Alpha');
      await approved(id, W0, 8);
      await shift(id, `${addDays(W0, 6)}T20:00`, `${W1}T04:00`);
      const interval = [{ clockIn: parseETDateTime(`${W1}T01:00`), clockOut: parseETDateTime(`${W1}T01:30`) }];
      // final, but no holiday on the Monday: no premium reads the break
      await finalize((await draft(W0)).body.run.id);
      expect(await paidWeeksReadingBreak(trx, id, interval, W1)).toEqual([]);
      // a break in its own week's shift is never this guard's
      expect(await paidWeeksReadingBreak(trx, id, interval, W0)).toEqual([]);
    });

    it('does not refuse a holiday with no such shift, or a pto day, or a holiday the final week\'s shift does not reach', async () => {
      const id = await tech('Sample Alpha');
      await approved(id, W0, 10);
      await shift(id, `${addDays(W0, 1)}T08:00`, `${addDays(W0, 1)}T18:00`);
      await finalize((await draft(W0)).body.run.id);
      // W0 is final but no shift of it touches W1's Monday
      expect((await post(id, W1)).status).toBe(201);
      // paid time off on a day a final week's shift runs into is not a holiday: no premium is decided by it
      const other = await tech('Sample Bravo');
      await approved(other, W0, 4);
      await shift(other, `${addDays(W0, 6)}T22:00`, `${W1}T02:00`);
      expect((await post(other, W1, 'pto')).status).toBe(201);
    });
  });

  it('the fallback is per work date: a holiday summary with no shift entries still pays beside a measured shift', async () => {
    const id = await tech('Sample Alpha');
    await approved(id, W1, 12);
    await shift(id, `${addDays(W1, 1)}T08:00`, `${addDays(W1, 1)}T16:00`);
    await day(id, WED, 4);
    await offDay(id, WED, 10);
    expect(byName((await draft(W1)).body.run, 'Sample Alpha')).toMatchObject({ holidayWorkHours: '4.00', holidayWorkPremiumCents: 4400 });
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
