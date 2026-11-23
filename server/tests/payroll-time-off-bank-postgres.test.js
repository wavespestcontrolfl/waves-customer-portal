// Real PostgreSQL transactions (rolled back): the time-off bank. The migrated columns, a week that
// earns, a pay run that pays time off only from the bank (in full, in part, not at all), the day-90
// illness rule, a missing hire date, the review token, a void, the order guard across years, the
// warnings on a recorded day, the balance, and a technician with no bank (today's pay). All names
// are synthetic. DATABASE_URL-gated like the other *-postgres suites.
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
const bank = require('../services/payroll-time-off-bank');
const timeTracking = require('../services/time-tracking');
const approval = require('../services/timesheet-approval');
const { PAYROLL_LOCK_NS } = require('../services/payroll-lock');
const { finalRunClosesWeeks } = require('../services/payroll-paid-line-weeks');
const { etDateString } = require('../utils/datetime-et');
const { addStaffWorkDays } = require('../utils/staff-time-work-date');

jest.setTimeout(60000);

// Finished staff weeks in 2026 (Monday dates). Pay dates default to the Friday after.
const W1 = '2026-09-14';
const W2 = '2026-09-21';
const W3 = '2026-09-28';
const W4 = '2026-10-05';
// Hired long before the weeks above: every day is past day 90.
const LONG_AGO = '2026-01-05';
// Why time off was not paid, as the server words it.
const SHORT = (hours) => `${hours} hours of time off are not paid, because the time-off bank does not hold them.`;
const RULE = (hours) => `${hours} hours of time off are not paid, because up to day 90 the time-off bank pays only illness days, up to 16 hours.`;
const BEFORE_HIRE = (hours) => `${hours} hours of time off are not paid, because the time off is before the hire date.`;

postgres('payroll time-off bank', () => {
  let database;
  let server;
  let baseUrl;
  let trx;
  const OLD_GATE = process.env.GATE_PAYROLL;
  const OLD_OFF = process.env.GATE_PAYROLL_TIME_OFF;
  const OLD_LINES = process.env.GATE_PAYROLL_PAY_LINES;
  const ADMIN_ID = randomUUID();

  const addDays = (ymd, n) => addStaffWorkDays(ymd, n);
  // A W-2 technician with a W-4 on file. With `hours`, a time-off bank that earns them in a year of full weeks.
  const tech = async (name, { hours = null, hired = LONG_AGO, ...patch } = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '22.00',
      pto_hours_per_year: hours, hire_date: hired, ...patch,
    });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const worked = (technicianId, weekStart, hours = 40) => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: (hours * 60).toFixed(2), overtime_minutes: '0.00',
  });
  const offDay = (technicianId, workDate, hours, patch = {}) => trx('payroll_time_off').insert({
    technician_id: technicianId, work_date: workDate, kind: 'pto', minutes: (hours * 60).toFixed(2), ...patch,
  });
  const refused = async (work) => {
    await trx.raw('SAVEPOINT attempt');
    let error;
    try { await work(); } catch (err) { error = err; }
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    return error;
  };
  const api = async (method, path, { body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const draft = (weekStart, body = {}) => api('POST', '/runs', { body: { weekStart, ...body } });
  const finalize = async (runId) => {
    const shown = await api('GET', `/runs/${runId}`);
    return api('POST', `/runs/${runId}/finalize`, { body: { token: shown.body.run.token } });
  };
  const draftAndFinalize = async (weekStart) => {
    const created = await draft(weekStart);
    expect(created.status).toBe(201);
    const done = await finalize(created.body.run.id);
    expect(done.status).toBe(200);
    return done.body.run;
  };
  // A finished full week: the technician's bank gains one full week of hours.
  const fullWeek = async (technicianId, weekStart) => {
    await worked(technicianId, weekStart);
    return draftAndFinalize(weekStart);
  };
  const byName = (run, name) => run.checks.find((c) => c.name === name);
  const balanceOf = async (technicianId) => (await api('GET', `/time-off/balance?technicianId=${technicianId}`)).body.balance;

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
    jest.clearAllMocks();
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
    if (OLD_LINES === undefined) delete process.env.GATE_PAYROLL_PAY_LINES; else process.env.GATE_PAYROLL_PAY_LINES = OLD_LINES;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  describe('migrated schema', () => {
    it('lets only a paid-time-off day be an illness day', async () => {
      const id = await tech('Sample Alpha');
      await offDay(id, '2026-09-15', 8, { illness: true });
      const error = await refused(() => offDay(id, '2026-09-16', 8, { kind: 'holiday', illness: true }));
      expect(error.message).toMatch(/payroll_time_off_illness_check/);
      await offDay(id, '2026-09-17', 8);
      expect((await trx('payroll_time_off').where({ technician_id: id, work_date: '2026-09-17' }).first('illness')).illness).toBe(false);
    });

    it('stores the hours a check earned, refuses a negative number, and protects them once final', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await worked(id, W1);
      const created = (await draft(W1)).body.run;
      const row = (run) => trx('payroll_checks').where({ id: run.checks[0].id });
      expect((await row(created).first('pto_earned_minutes')).pto_earned_minutes).toBe('92.40');
      expect((await refused(() => row(created).update({ pto_earned_minutes: -1 }))).message).toMatch(/payroll_checks_pto_earned_check/);
      // Finalize writes the checks again, so the final check has its own id.
      const done = (await finalize(created.id)).body.run;
      expect(await row(done).first('pto_earned_minutes', 'pto_early_illness_minutes')).toEqual({ pto_earned_minutes: '92.40', pto_early_illness_minutes: '0.00' });
      expect((await refused(() => row(done).update({ pto_earned_minutes: '0.00' }))).message).toMatch(/cannot be edited/);
      expect((await refused(() => row(done).update({ pto_early_illness_minutes: '1.00' }))).message).toMatch(/cannot be edited/);
    });

    it('keeps the time off a run did not pay as a list only', async () => {
      const plain = await tech('Sample Bravo');
      await worked(plain, W1);
      const created = (await draft(W1)).body.run;
      const kept = (value) => refused(() => trx('payroll_runs').where({ id: created.id }).update({ unpaid_time_off: JSON.stringify(value) }));
      expect((await kept({ technicianId: plain })).message).toMatch(/payroll_runs_unpaid_time_off_check/);
      expect(await kept([])).toBeUndefined();
    });

    it('keeps the early illness minutes within the paid time off of a check that holds a bank', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const plain = await tech('Sample Bravo');
      await worked(id, W1);
      await worked(plain, W1);
      const created = (await draft(W1)).body.run;
      const of = (name) => trx('payroll_checks').where({ id: byName(created, name).id });
      // More early illness than the check paid, a negative number, and a number on a check with no bank.
      for (const [name, patch] of [['Sample Alpha', { pto_early_illness_minutes: '1.00' }], ['Sample Alpha', { pto_early_illness_minutes: -1 }], ['Sample Bravo', { pto_early_illness_minutes: 0 }]]) {
        expect((await refused(() => of(name).update(patch))).message).toMatch(/payroll_checks_pto_early_illness_check/);
      }
    });
  });

  describe('rolling the migration back', () => {
    it('refuses while bank data exists, and locks the three tables before it looks', async () => {
      const migration = require('../models/migrations/20261121110000_payroll_time_off_bank');
      const down = async () => {
        const seen = [];
        const onQuery = (query) => seen.push(query.sql);
        database.on('query', onQuery);
        try { return { error: await refused(() => migration.down(trx)), seen }; } finally { database.removeListener('query', onQuery); }
      };
      // A final run that kept time off it did not pay, with no check.
      const id = await tech('Sample Alpha', { hours: '80' });
      await offDay(id, addDays(W1, 1), 10);
      await draftAndFinalize(W1);
      const first = await down();
      expect(first.error.message).toMatch(/payroll_runs holds time off that was not paid/);
      // A finalize that commits between a check and the DROP would lose what it wrote: the lock comes first.
      expect(first.seen[first.seen.indexOf('SAVEPOINT attempt') + 1]).toBe('LOCK TABLE payroll_checks, payroll_runs, payroll_time_off IN ACCESS EXCLUSIVE MODE');
      // An illness day.
      await offDay(await tech('Sample Bravo'), addDays(W2, 1), 8, { illness: true });
      expect((await down()).error.message).toMatch(/payroll_time_off holds illness days/);
      // Hours a check earned.
      await fullWeek(id, W2);
      expect((await down()).error.message).toMatch(/payroll_checks holds time-off bank hours/);
      expect(await trx.schema.hasColumn('payroll_checks', 'pto_earned_minutes')).toBe(true);
    });
  });

  describe('a technician with no yearly hours has no bank', () => {
    it('pays every recorded hour as before, and the check and the run carry no bank', async () => {
      const id = await tech('Sample Alpha');
      await worked(id, W1, 30);
      await offDay(id, addDays(W1, 3), 10);
      const run = await draftAndFinalize(W1);
      const check = byName(run, 'Sample Alpha');
      expect(check).toMatchObject({ ptoHours: '10.00', ptoPayCents: 22000 });
      expect(check).not.toHaveProperty('timeOffBank');
      expect(run).not.toHaveProperty('unpaidTimeOff');
      expect(await trx('payroll_checks').where({ id: check.id }).first('pto_earned_minutes', 'pto_early_illness_minutes'))
        .toEqual({ pto_earned_minutes: null, pto_early_illness_minutes: null });
      expect((await api('GET', `/checks/${check.id}/stub`)).body.stub).not.toHaveProperty('timeOffBank');
      expect(await balanceOf(id)).not.toHaveProperty('bank');
    });

    it('leaves a bank technician alone while GATE_PAYROLL_TIME_OFF is off', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await worked(id, W1);
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const run = (await draft(W1)).body.run;
      expect(run.checks[0]).not.toHaveProperty('timeOffBank');
      expect((await trx('payroll_checks').where({ id: run.checks[0].id }).first('pto_earned_minutes')).pto_earned_minutes).toBeNull();
    });
  });

  describe('earning', () => {
    it('adds 1.54 hours for a full week and half of that for a 20 hour week, and shows it on the check, the stub and the balance', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const first = await fullWeek(id, W1);
      expect(byName(first, 'Sample Alpha').timeOffBank).toEqual({ earnedHours: '1.54', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '1.54' });
      await worked(id, W2, 20);
      const second = await draftAndFinalize(W2);
      const check = byName(second, 'Sample Alpha');
      expect(check.timeOffBank).toEqual({ earnedHours: '0.77', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '2.31' });
      expect((await api('GET', `/checks/${check.id}/stub`)).body.stub.timeOffBank).toEqual(check.timeOffBank);
      expect((await balanceOf(id)).bank).toEqual({
        balanceHours: '2.31', waitingHours: '0.00', fullWeekHours: '1.54', capHours: 120, usableFrom: addDays(LONG_AGO, 90),
      });
    });

    it('gives the hours back when the run is voided', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const run = await fullWeek(id, W1);
      expect((await balanceOf(id)).bank.balanceHours).toBe('1.54');
      expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect((await balanceOf(id)).bank.balanceHours).toBe('0.00');
    });

    it('reads every figure of the balance in one read-only snapshot, so a finalize between two reads cannot split the bank from the waiting hours', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W1);
      // Here the snapshot is a savepoint inside the suite's transaction, which takes no isolation level. So the
      // options are checked as passed, and every table read is checked to go through that one transaction.
      const [inside, outside, options] = [[], [], []];
      const recording = (conn, seen, extra = {}) => new Proxy(conn, {
        apply: (target, _self, args) => { seen.push(String(args[0])); return target(...args); },
        get: (target, key) => (key in extra ? extra[key] : target[key]),
      });
      mockConnection = recording(trx, outside, {
        transaction: (work, config) => { options.push({ ...config }); return trx.transaction((inner) => work(recording(inner, inside)), config); },
      });
      let balance;
      try { balance = await balanceOf(id); } finally { mockConnection = trx; }
      expect(balance.bank).toMatchObject({ balanceHours: '1.54', waitingHours: '0.00' });
      expect(options).toEqual([{ isolationLevel: 'repeatable read', readOnly: true }]);
      expect(outside).toEqual([]);
      for (const table of ['technicians', 'payroll_checks', 'payroll_time_off']) expect(inside.join(' | ')).toContain(table);
    });
  });

  describe('paying time off from the bank', () => {
    // 400 hours a year: a full week earns 7.69 hours, so two weeks hold more than one 10 hour day.
    it('pays a day the bank holds in full, at the straight rate, and the week still earns as a full week', async () => {
      const id = await tech('Sample Alpha', { hours: '400' });
      await fullWeek(id, W1);
      await fullWeek(id, W2);
      await worked(id, W3, 30);
      await offDay(id, addDays(W3, 3), 10);
      const run = await draftAndFinalize(W3);
      const check = byName(run, 'Sample Alpha');
      expect(check).toMatchObject({ regularHours: '30.00', overtimeHours: '0.00', ptoHours: '10.00', ptoPayCents: 22000, grossCents: 88000 });
      expect(check.timeOffBank).toEqual({ earnedHours: '7.69', usedHours: '10.00', unpaidHours: '0.00', balanceHours: '13.07' });
      expect(run).not.toHaveProperty('unpaidTimeOff');
    });

    it('pays only the hours the bank holds, lists the rest as not paid, and earns on the paid hours only', async () => {
      const id = await tech('Sample Alpha', { hours: '400' });
      await fullWeek(id, W1);
      await worked(id, W2, 30);
      await offDay(id, addDays(W2, 3), 10);
      const created = (await draft(W2)).body.run;
      const check = byName(created, 'Sample Alpha');
      // 7.69 hours at $22.00 = $169.18; 30 worked hours = $660.00.
      expect(check).toMatchObject({ ptoHours: '7.69', ptoPayCents: 16918, grossCents: 82918 });
      expect(check.timeOffBank).toEqual({ earnedHours: '7.25', usedHours: '7.69', unpaidHours: '2.31', balanceHours: '7.25' });
      expect(created.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '2.31', reason: SHORT('2.31') }]);
      // A day of a week that is only drafted still waits for a pay run.
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '7.69', waitingHours: '10.00' });
      // The stored snapshot keeps the bank figures of the check.
      const stored = await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot', 'pto_minutes', 'pto_earned_minutes');
      expect([stored.pto_minutes, stored.pto_earned_minutes]).toEqual(['461.40', '435.00']);
      expect(stored.calc_snapshot.ptoBank).toEqual({
        earnedMinutes: 435, earlyIllnessMinutes: 0, unpaidMinutes: 138.6, unpaidRuleMinutes: 0, unpaidBeforeHireMinutes: 0, beforeMinutes: 461.4, afterMinutes: 435,
        // What the bank paid on each date: pay earned by date reads it (the Tech Rewards scoreboard).
        paidDays: [{ workDate: addDays(W2, 3), minutes: 461.4 }],
      });
      expect((await finalize(created.id)).status).toBe(200);
      // Once its week is final the day waits no longer: the unpaid part stays unpaid.
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '7.25', waitingHours: '0.00' });
    });

    it('at zero, a day off on a worked week is unpaid and the check pays the worked hours', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await worked(id, W1, 30);
      await offDay(id, addDays(W1, 3), 10);
      const run = (await draft(W1)).body.run;
      expect(byName(run, 'Sample Alpha')).toMatchObject({ regularHours: '30.00', ptoHours: '0.00', ptoPayCents: 0, grossCents: 66000 });
      expect(run.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '10.00', reason: SHORT('10.00') }]);
    });

    it('closes a week of unpaid time off alone with a pay run that has no paycheck', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const [{ id: entryId }] = await offDay(id, addDays(W1, 1), 10).returning('id');
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '0.00', waitingHours: '10.00' });
      const notPaid = [{ technicianId: id, name: 'Sample Alpha', hours: '10.00', reason: SHORT('10.00') }];
      const created = await draft(W1);
      expect(created.status).toBe(201);
      expect(created.body.run).toMatchObject({ status: 'draft', checks: [], blocked: [], unpaidTimeOff: notPaid });
      // Finalizing it closes the week: the decision is kept, no paycheck is made, and the hours stop waiting.
      const done = await finalize(created.body.run.id);
      expect(done.status).toBe(200);
      expect(done.body.run).toMatchObject({ status: 'finalized', checks: [], unpaidTimeOff: notPaid });
      expect(await trx('payroll_checks').where({ run_id: created.body.run.id })).toEqual([]);
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '0.00', waitingHours: '0.00' });
      // The run decided the week for this technician with no check (the December gift reads this), and for nobody else.
      const other = await tech('Sample Bravo', { hours: '80' });
      expect(await bank.unpaidDecisionWeeks(trx, id, [W1, W2])).toEqual([W1]);
      expect(await bank.unpaidDecisionWeeks(trx, id.toUpperCase(), [W1])).toEqual([W1]);
      expect([await bank.unpaidDecisionWeeks(trx, other, [W1, W2]), await bank.unpaidDecisionWeeks(trx, id, [W2]), await bank.unpaidDecisionWeeks(trx, id, [])])
        .toEqual([[], [], []]);
      const change = await api('PUT', `/time-off/${entryId}`, { body: { kind: 'pto', hours: 4 } });
      expect([change.status, change.body.error]).toEqual([409, "This week's pay run is final. Void it first to change its pay."]);
      // A void opens the week again.
      expect((await api('POST', `/runs/${created.body.run.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect((await balanceOf(id)).bank).toMatchObject({ waitingHours: '10.00' });
      expect(await bank.unpaidDecisionWeeks(trx, id, [W1])).toEqual([]);
      // A run with no paycheck and no time off left unpaid closes nothing: it is not finalized.
      const again = await draft(W1);
      expect(again.status).toBe(201);
      await trx('payroll_time_off').where({ id: entryId }).del();
      const empty = await finalize(again.body.run.id);
      expect([empty.status, empty.body.error]).toEqual([409, 'There are no paychecks to finalize.']);
      // And a week with nothing in it gets no run, as before.
      const nothing = await draft(W2);
      expect([nothing.status, nothing.body.error]).toEqual([409, 'No W-2 hours to pay for that week.']);
    });

    it('lets no shift hours enter or change in the week of a final pay run for a W-2 employee, with or without a check on it', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      const contractor = await tech('Sample Contractor', { employment_type: '1099' });
      await offDay(id, addDays(W1, 1), 10);
      const run = await draftAndFinalize(W1);
      expect(run.checks).toEqual([]);
      const add = (technicianId, week = W1) => timeTracking.adminAddEntry({
        technician_id: technicianId, clock_in: `${addDays(week, 2)}T14:00:00Z`, clock_out: `${addDays(week, 2)}T22:00:00Z`,
        edit_reason: 'Missed punch', edited_by: ADMIN_ID,
      });
      const unlock = async () => {
        const weekly = await trx('time_weekly_summary').where({ technician_id: id, week_start: W1 }).first();
        const reviewToken = approval._test.reviewSnapshotToken({ weekly, dailies: [], entries: [] });
        return approval.unlockWeek({ technicianId: id, weekStart: W1, adminId: ADMIN_ID, reason: 'Fix a punch', reviewToken });
      };
      const CLOSED = { statusCode: 409, message: "This week's pay run is final. Void it before changing its entries." };
      // The run left the time off of Alpha unpaid and made no check: hours cannot be added to the week.
      await expect(add(id)).rejects.toMatchObject(CLOSED);
      // The id in capitals is the same technician: the endpoint takes it, and the week stays closed.
      await expect(add(id.toUpperCase())).rejects.toMatchObject(CLOSED);
      // Bravo is not on the run at all. One run pays a week, so hours that enter it now could never be paid:
      // a new shift, and a shift moved in from another week.
      await expect(add(other)).rejects.toMatchObject(CLOSED);
      expect(await trx('time_entries').whereIn('technician_id', [id, other])).toEqual([]);
      // A pay run does not pay a contractor, and a week with no final run is open.
      await add(contractor);
      const later = await add(other, W2);
      await expect(timeTracking.adminEditEntry(later.id, {
        clock_in: `${addDays(W1, 3)}T14:00:00Z`, clock_out: `${addDays(W1, 3)}T22:00:00Z`, edit_reason: 'Wrong day', edited_by: ADMIN_ID,
      })).rejects.toMatchObject(CLOSED);
      // Shift hours inside the week cannot change either: the times of a shift, and an entry turned into a shift.
      const [inside, job] = [randomUUID(), randomUUID()];
      await trx('time_entries').insert([
        { id: inside, technician_id: other, entry_type: 'shift', status: 'completed', approval_status: 'pending',
          clock_in: `${addDays(W1, 4)}T14:00:00Z`, clock_out: `${addDays(W1, 4)}T22:00:00Z`, duration_minutes: 480 },
        { id: job, technician_id: other, entry_type: 'job', status: 'completed', approval_status: 'pending',
          clock_in: `${addDays(W1, 5)}T14:00:00Z`, clock_out: `${addDays(W1, 5)}T15:00:00Z`, duration_minutes: 60 },
      ]);
      await expect(timeTracking.adminEditEntry(inside, { clock_out: `${addDays(W1, 4)}T23:00:00Z`, edit_reason: 'Stayed late', edited_by: ADMIN_ID }))
        .rejects.toMatchObject(CLOSED);
      await expect(timeTracking.adminEditEntry(job, { entry_type: 'shift', edit_reason: 'Wrong type', edited_by: ADMIN_ID })).rejects.toMatchObject(CLOSED);
      // What adds no payable hours stays open to a technician the run did not pay, as before: a change of an
      // entry that is not a shift, and a void.
      await timeTracking.adminEditEntry(job, { notes: 'Sample note', edit_reason: 'Note', edited_by: ADMIN_ID });
      expect(await trx('time_entries').where({ id: job }).first('entry_type', 'notes')).toEqual({ entry_type: 'job', notes: 'Sample note' });
      await expect(timeTracking.voidEntry(inside, { reason: 'Duplicate', voided_by: ADMIN_ID })).resolves.toMatchObject({ status: 'voided' });
      // Hours approved after the close cannot be unlocked either.
      await worked(id, W1);
      await expect(unlock()).rejects.toMatchObject({ statusCode: 409, message: 'Void the pay run for this week first.' });
      expect(await finalRunClosesWeeks(trx, id, [W1])).toBe(true);
      expect(await finalRunClosesWeeks(trx, id, [W2, W1])).toBe(true);
      expect(await finalRunClosesWeeks(trx, id, [W2])).toBe(false);
      expect(await finalRunClosesWeeks(trx, id, [])).toBe(false);
      expect(await finalRunClosesWeeks(trx, contractor, [W1])).toBe(false);
      // A void opens the week again.
      expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect(await finalRunClosesWeeks(trx, id, [W1])).toBe(false);
      await unlock();
      await add(id);
      await add(other);
      expect(await trx('time_entries').where({ technician_id: id }).pluck('source')).toEqual(['admin_added']);
    });

    it('takes the payroll lock before the technician row when an admin adds a shift, the order a finalize uses', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const seen = [];
      const onQuery = (query) => seen.push(query.sql);
      database.on('query', onQuery);
      try {
        await timeTracking.adminAddEntry({
          technician_id: id, clock_in: `${addDays(W1, 2)}T14:00:00Z`, clock_out: `${addDays(W1, 2)}T22:00:00Z`,
          edit_reason: 'Missed punch', edited_by: ADMIN_ID,
        });
      } finally {
        database.removeListener('query', onQuery);
      }
      const payrollLock = seen.findIndex((sql) => /pg_advisory_xact_lock_shared/.test(sql));
      const technicianRow = seen.findIndex((sql) => /from "technicians"/.test(sql) && /for update/i.test(sql));
      expect(payrollLock).toBeGreaterThanOrEqual(0);
      expect(technicianRow).toBeGreaterThan(payrollLock);
    });

    it('takes the payroll lock for a draft and a recompute before the week rows and the technician rows they lock', async () => {
      process.env.GATE_PAYROLL_PAY_LINES = 'false';
      const id = await tech('Sample Alpha', { hours: '80' });
      await worked(id, W1);
      const order = async (work) => {
        const seen = [];
        const onQuery = (query) => seen.push(query);
        database.on('query', onQuery);
        try { await work(); } finally { database.removeListener('query', onQuery); }
        return {
          payrollLock: seen.findIndex((q) => /pg_advisory_xact_lock\(/.test(q.sql) && (q.bindings || []).includes(PAYROLL_LOCK_NS)),
          weekRows: seen.findIndex((q) => /from "time_weekly_summary"[\s\S]*for update/i.test(q.sql)),
          technicianRows: seen.findIndex((q) => /from "technicians"[\s\S]*for share/i.test(q.sql)),
        };
      };
      // A manual shift entry takes the payroll lock, then its technician row, then reads the week. A draft that
      // locked the week rows and then waited for the technician row with no payroll lock could deadlock with it.
      let created;
      const drafted = await order(async () => { created = (await draft(W1)).body.run; });
      const recomputed = await order(() => api('POST', `/runs/${created.id}/recompute`));
      for (const seen of [drafted, recomputed]) {
        expect(seen.payrollLock).toBeGreaterThanOrEqual(0);
        expect(seen.weekRows).toBeGreaterThan(seen.payrollLock);
        expect(seen.technicianRows).toBeGreaterThan(seen.weekRows);
      }
    });

    it('puts the bank on a check made for a pay line alone, also when the time off of that week is unpaid', async () => {
      process.env.GATE_PAYROLL_PAY_LINES = 'true';
      const id = await tech('Sample Alpha', { hours: '400' });
      const quiet = await tech('Sample Bravo', { hours: '400' });
      await fullWeek(id, W1);
      // Week 2: a bonus line and no hours for both. Alpha also has a 10 hour day off; the bank holds 7.69 of it.
      for (const technicianId of [id, quiet]) {
        const line = await api('POST', '/pay-lines', { body: { kind: 'review_bonus', technicianId, amountCents: 3000, earnedWeekStart: W2 } });
        expect(line.status).toBe(201);
      }
      await offDay(id, addDays(W2, 1), 10);
      const run = (await draft(W2)).body.run;
      expect(byName(run, 'Sample Alpha')).toMatchObject({ regularHours: '0.00', ptoHours: '7.69', reviewBonusCents: 3000 });
      expect(byName(run, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '7.69', unpaidHours: '2.31' });
      // No hours and no time off: the check is for the line alone, and it still shows the bank (nothing earned).
      expect(byName(run, 'Sample Bravo').timeOffBank).toEqual({ earnedHours: '0.00', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '0.00' });
      // With an empty bank the day is unpaid in full, and the line still makes the check, with the unpaid hours on it.
      await trx('payroll_time_off').where({ technician_id: id }).del();
      await offDay(quiet, addDays(W2, 1), 10);
      const again = (await api('POST', `/runs/${run.id}/recompute`)).body.run;
      expect(byName(again, 'Sample Bravo')).toMatchObject({ ptoHours: '0.00', reviewBonusCents: 3000 });
      expect(byName(again, 'Sample Bravo').timeOffBank).toMatchObject({ usedHours: '0.00', unpaidHours: '10.00', balanceHours: '0.00' });
      expect(again.unpaidTimeOff).toEqual([{ technicianId: quiet, name: 'Sample Bravo', hours: '10.00', reason: SHORT('10.00') }]);
    });

    it('still pays a holiday in full: a holiday is not bank time', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await worked(id, W1, 30);
      await offDay(id, addDays(W1, 0), 10, { kind: 'holiday' });
      const check = byName((await draft(W1)).body.run, 'Sample Alpha');
      expect(check).toMatchObject({ holidayHours: '10.00', holidayPayCents: 22000 });
      expect(check.timeOffBank).toEqual({ earnedHours: '1.54', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '1.54' });
    });
  });

  describe('up to day 90', () => {
    // Hired 2026-09-01: the bank opens on 2026-11-30, after every week here.
    const HIRED = '2026-09-01';

    it('pays an illness day only, from the hours the bank holds, up to 16 hours in all', async () => {
      const id = await tech('Sample Alpha', { hours: '400', hired: HIRED });
      await fullWeek(id, W1);
      await worked(id, W2, 30);
      await offDay(id, addDays(W2, 2), 10);
      const created = (await draft(W2)).body.run;
      expect(byName(created, 'Sample Alpha')).toMatchObject({ ptoHours: '0.00' });
      // The bank holds 7.69 hours: the rule is the reason, not the bank.
      expect(created.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '10.00', reason: RULE('10.00') }]);
      // Marked as illness, the same day is paid from the 7.69 hours the bank holds.
      await trx('payroll_time_off').where({ technician_id: id }).update({ illness: true });
      expect((await api('GET', `/runs/${created.id}`)).body.run.stale).toBe(true);
      const again = (await api('POST', `/runs/${created.id}/recompute`)).body.run;
      expect(byName(again, 'Sample Alpha').timeOffBank).toEqual({ earnedHours: '7.25', usedHours: '7.69', unpaidHours: '2.31', balanceHours: '7.25' });
      expect((await finalize(created.id)).status).toBe(200);
      // A full week later the bank holds 14.94 hours, but only 16 - 7.69 = 8.31 illness hours are left.
      await fullWeek(id, W3);
      await worked(id, W4, 30);
      await offDay(id, addDays(W4, 1), 10, { illness: true });
      const last = (await draft(W4)).body.run;
      expect(byName(last, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '8.31', unpaidHours: '1.69' });
      expect(last.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '1.69', reason: RULE('1.69') }]);
      const stored = await trx('payroll_checks').where({ id: byName(last, 'Sample Alpha').id }).first('pto_minutes', 'pto_early_illness_minutes');
      expect(stored).toEqual({ pto_minutes: '498.60', pto_early_illness_minutes: '498.60' });
    });

    it('warns when a recorded illness day goes past the 16 hours, with the hours the pay run will not pay', async () => {
      const id = await tech('Sample Alpha', { hours: '400', hired: HIRED });
      await fullWeek(id, W1);
      await worked(id, W2, 30);
      await offDay(id, addDays(W2, 2), 10, { illness: true });
      await draftAndFinalize(W2);
      await fullWeek(id, W3);
      // The bank holds 14.94 hours, and 7.69 of the 16 illness hours are paid: 8.31 are left.
      const sick = addDays(W4, 1);
      await offDay(id, sick, 10, { illness: true });
      // Not counted against the 16 hours: a day that is not an illness day, a day before the hire date and a
      // day from the first open date.
      await offDay(id, addDays(W4, 2), 4);
      await offDay(id, addDays(HIRED, -3), 2, { illness: true });
      await offDay(id, addDays(HIRED, 92), 5, { illness: true });
      const entry = await trx('payroll_time_off').where({ technician_id: id, work_date: sick }).first('id');
      const change = async (hours) => (await api('PUT', `/time-off/${entry.id}`, { body: { kind: 'pto', hours } })).body.warning;
      expect(await change(10)).toBe(
        `Until ${addDays(HIRED, 90)} the time-off bank pays illness days up to 16 hours in all. Sample Alpha has 8.31 of those hours left and 10.00 hours of illness days waiting for a pay run, so 1.69 hours are unpaid. `
        + 'Sample Alpha has 14.94 hours in the time-off bank today and 21.00 hours of paid time off waiting for a pay run. A pay run pays only the hours the bank holds then. The day is saved.',
      );
      // 8 hours fit in the 8.31 that are left: only the bank line stays.
      expect(await change(8)).toBe('Sample Alpha has 14.94 hours in the time-off bank today and 19.00 hours of paid time off waiting for a pay run. A pay run pays only the hours the bank holds then. The day is saved.');
      // The pay run pays what the warning said: 8.31 of the 10 hours.
      await change(10);
      await trx('payroll_time_off').where({ technician_id: id }).whereNot({ work_date: sick }).whereNot({ work_date: addDays(W2, 2) }).del();
      await worked(id, W4, 30);
      const run = (await draft(W4)).body.run;
      expect(run.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '1.69', reason: RULE('1.69') }]);
    });

    it('does not void a check whose illness hours left a later sick day unpaid in a final run with no check', async () => {
      const id = await tech('Sample Alpha', { hours: '400', hired: HIRED });
      const other = await tech('Sample Bravo');
      // Three full weeks: the bank holds 23.07 hours.
      await fullWeek(id, '2026-09-07');
      await fullWeek(id, W1);
      await fullWeek(id, W2);
      // Week 3 pays the 16 illness hours of the first 90 days.
      await worked(id, W3, 24);
      await offDay(id, addDays(W3, 1), 8, { illness: true });
      await offDay(id, addDays(W3, 2), 8, { illness: true });
      const third = await draftAndFinalize(W3);
      expect(byName(third, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '16.00', unpaidHours: '0.00' });
      // Week 4: one more sick day and no work. The 16 hours are used, so it is unpaid and Alpha gets no check.
      await offDay(id, addDays(W4, 1), 8, { illness: true });
      await worked(other, W4);
      const fourth = await draftAndFinalize(W4);
      expect(fourth.checks.map((c) => c.name)).toEqual(['Sample Bravo']);
      expect(fourth.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '8.00', reason: RULE('8.00') }]);
      // Voiding week 3 would give the 16 hours back, and week 4 is closed with that day unpaid.
      const voidRun = (runId) => api('POST', `/runs/${runId}/void`, { body: { reason: 'Redo' } });
      const held = await voidRun(third.id);
      expect([held.status, held.body.error]).toEqual([409, 'A later pay run is already final. Void it first.']);
      expect((await voidRun(fourth.id)).status).toBe(200);
      expect((await voidRun(third.id)).status).toBe(200);
    });

    it('pays no day before the hire date, also on a late pay date when the bank holds hours', async () => {
      // Hired on the Monday of week 2. Week 2 is paid first and puts 7.69 hours in the bank.
      const id = await tech('Sample Alpha', { hours: '400', hired: W2 });
      await fullWeek(id, W2);
      // Week 1 is before the hire date. It is paid late, on a pay date after week 2's, so the bank holds hours.
      await offDay(id, addDays(W1, 4), 4, { illness: true });
      const late = await draft(W1, { payDate: '2026-10-09' });
      expect(late.status).toBe(201);
      expect(late.body.run.checks).toEqual([]);
      expect(late.body.run.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '4.00', reason: BEFORE_HIRE('4.00') }]);
      // The hire date itself is day 1 of the job: an illness day on it is paid.
      await trx('technicians').where({ id }).update({ hire_date: addDays(W1, 4) });
      const dayOne = (await api('POST', `/runs/${late.body.run.id}/recompute`)).body.run;
      expect(byName(dayOne, 'Sample Alpha')).toMatchObject({ ptoHours: '4.00' });
      expect(dayOne).not.toHaveProperty('unpaidTimeOff');
    });

    it('does not count a vacation day paid on an earlier pay date against the 16 illness hours', async () => {
      // Hired 2026-06-22: the bank opens on 2026-09-20, the Sunday of week 1. Week 2 is open, week 1 is not.
      const id = await tech('Sample Alpha', { hours: '400', hired: '2026-06-22' });
      await fullWeek(id, '2026-08-31');
      await fullWeek(id, '2026-09-07');
      // Week 2 is paid first: a 10 hour vacation day, which is not early illness.
      await worked(id, W2, 30);
      await offDay(id, addDays(W2, 2), 10);
      const vacation = await draftAndFinalize(W2);
      expect(byName(vacation, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '10.00', balanceHours: '13.07' });
      // Week 1 is paid late, on a pay date after week 2's: a 10 hour illness day in the first 90 days.
      await worked(id, W1, 30);
      await offDay(id, addDays(W1, 1), 10, { illness: true });
      const late = await draft(W1, { payDate: '2026-10-09' });
      expect(late.status).toBe(201);
      expect(byName(late.body.run, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '10.00', unpaidHours: '0.00' });
      expect(late.body.run).not.toHaveProperty('unpaidTimeOff');
    });

    it('holds the check when a week has paid time off and no hire date is on file, and earns without one', async () => {
      const id = await tech('Sample Alpha', { hours: '80', hired: null });
      const first = await fullWeek(id, W1);
      expect(byName(first, 'Sample Alpha').timeOffBank.balanceHours).toBe('1.54');
      await worked(id, W2, 30);
      await offDay(id, addDays(W2, 1), 1);
      const run = (await draft(W2)).body.run;
      expect(run.checks).toEqual([]);
      expect(run.blocked).toEqual([{ technicianId: id, name: 'Sample Alpha', reason: bank.NO_HIRE_DATE_REASON }]);
      expect((await finalize(run.id)).status).toBe(409);
      await trx('technicians').where({ id }).update({ hire_date: LONG_AGO });
      const fixed = (await api('POST', `/runs/${run.id}/recompute`)).body.run;
      expect(byName(fixed, 'Sample Alpha')).toMatchObject({ ptoHours: '1.00' });
    });
  });

  describe('the review token and the order of runs', () => {
    it('makes a draft stale when the yearly hours change, and finalize shows the new numbers first', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await worked(id, W1);
      const created = (await draft(W1)).body.run;
      expect(created.stale).toBe(false);
      expect((await api('PUT', `/technicians/${id}/pto-allowance`, { body: { hoursPerYear: '120' } })).status).toBe(200);
      expect((await api('GET', `/runs/${created.id}`)).body.run.stale).toBe(true);
      const stale = await api('POST', `/runs/${created.id}/finalize`, { body: { token: created.token } });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('Hours or settings changed. Review the new numbers.');
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      expect(byName(shown, 'Sample Alpha').timeOffBank.earnedHours).toBe('2.31');
      expect((await finalize(created.id)).status).toBe(200);
    });

    it('makes a draft stale when only the unpaid hours change: the pay is the same, the note is not', async () => {
      const id = await tech('Sample Alpha', { hours: '400' });
      await fullWeek(id, W1);
      await worked(id, W2, 30);
      await offDay(id, addDays(W2, 3), 10);
      const created = (await draft(W2)).body.run;
      expect(byName(created, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '7.69', unpaidHours: '2.31' });
      await trx('payroll_time_off').where({ technician_id: id }).update({ minutes: '720.00' });
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      expect(shown.stale).toBe(true);
      expect(shown.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '4.31', reason: SHORT('4.31') }]);
      const refusedOnce = await api('POST', `/runs/${created.id}/finalize`, { body: { token: created.token } });
      expect(refusedOnce.status).toBe(409);
      const fresh = (await api('GET', `/runs/${created.id}`)).body.run;
      expect(byName(fresh, 'Sample Alpha')).toMatchObject({ ptoHours: '7.69', grossCents: 82918 });
      expect(byName(fresh, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '7.69', unpaidHours: '4.31' });
    });

    it('makes a draft stale when a paid day off moves to another date of the week: every total is the same, the dates the bank paid are not', async () => {
      const id = await tech('Sample Alpha', { hours: '400' });
      await fullWeek(id, W1);
      await worked(id, W2, 30);
      await offDay(id, addDays(W2, 1), 4);
      const created = (await draft(W2)).body.run;
      expect(byName(created, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '4.00', unpaidHours: '0.00' });
      await trx('payroll_time_off').where({ technician_id: id }).update({ work_date: addDays(W2, 2) });
      // Pay earned by date (the Tech Rewards season bonus base) reads the dates, so the owner reviews the run again.
      expect((await api('GET', `/runs/${created.id}`)).body.run.stale).toBe(true);
      const old = await api('POST', `/runs/${created.id}/finalize`, { body: { token: created.token } });
      expect([old.status, old.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      const stored = await trx('payroll_checks').where({ run_id: created.id }).first('calc_snapshot');
      expect(stored.calc_snapshot.ptoBank.paidDays).toEqual([{ workDate: addDays(W2, 2), minutes: 240 }]);
      expect((await finalize(created.id)).status).toBe(200);
    });

    it('asks for a new review when time off with no check changes after the draft was viewed', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      await worked(other, W1);
      const created = (await draft(W1)).body.run;
      expect(created).not.toHaveProperty('unpaidTimeOff');
      // A day off for Alpha, whose bank is empty: no check changes, only the list of time off not paid.
      await offDay(id, addDays(W1, 1), 10);
      const old = await api('POST', `/runs/${created.id}/finalize`, { body: { token: created.token } });
      expect([old.status, old.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      expect(shown.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '10.00', reason: SHORT('10.00') }]);
      expect(shown.token).not.toBe(created.token);
      // The hours change again after that view: the token of the view no longer finalizes.
      await trx('payroll_time_off').where({ technician_id: id }).update({ minutes: '480.00' });
      expect((await api('POST', `/runs/${created.id}/finalize`, { body: { token: shown.token } })).status).toBe(409);
      expect((await finalize(created.id)).status).toBe(200);
    });

    it('does not finalize an earlier week whose hours a later final run needed, also when that run made no check', async () => {
      const id = await tech('Sample Alpha', { hours: '400' });
      const other = await tech('Sample Bravo');
      // Week 2 first: Alpha's day off is unpaid (the bank is empty) and Alpha gets no check. Bravo is paid.
      await worked(other, W2);
      await offDay(id, addDays(W2, 1), 5);
      const second = await draftAndFinalize(W2);
      expect(second.checks.map((c) => c.name)).toEqual(['Sample Bravo']);
      // The final run keeps what it did not pay, with the reason, and the row cannot be changed after.
      const kept = [{ technicianId: id, name: 'Sample Alpha', hours: '5.00', reason: SHORT('5.00') }];
      expect(second.unpaidTimeOff).toEqual(kept);
      expect((await trx('payroll_runs').where({ id: second.id }).first('unpaid_time_off')).unpaid_time_off).toEqual(kept);
      expect((await refused(() => trx('payroll_runs').where({ id: second.id }).update({ unpaid_time_off: null }))).message).toMatch(/can only be voided/);
      // The guard reads that kept list: for the technician it names, from an earlier run, in any year.
      const yearBefore = { id: randomUUID(), pay_date: '2025-12-26', week_start: '2025-12-15' };
      expect(await bank.laterUnpaidDecisionExists(trx, yearBefore, [id])).toBe(true);
      expect(await bank.laterUnpaidDecisionExists(trx, yearBefore, [other])).toBe(false);
      expect(await bank.laterUnpaidDecisionExists(trx, yearBefore, [])).toBe(false);
      expect(await bank.laterUnpaidDecisionExists(trx, { id: second.id, pay_date: second.payDate, week_start: W2 }, [id])).toBe(false);
      expect(await bank.laterUnpaidDecisionExists(trx, { id: randomUUID(), pay_date: '2027-01-08', week_start: '2026-12-28' }, [id])).toBe(false);
      // Week 1 would now add hours that week 2 should have paid from: it waits for week 2 to be voided.
      await worked(id, W1);
      const first = (await draft(W1)).body.run;
      const held = await finalize(first.id);
      expect([held.status, held.body.error]).toEqual([409, 'A later pay run is already final. Void it first, then finalize this one.']);
      const voided = await api('POST', `/runs/${second.id}/void`, { body: { reason: 'Redo after week 1' } });
      expect(voided.status).toBe(200);
      expect(voided.body.run.unpaidTimeOff).toEqual(kept);
      const done = await finalize(first.id);
      expect(done.status).toBe(200);
      // A run that paid all its time off keeps no list.
      expect(done.body.run).not.toHaveProperty('unpaidTimeOff');
      expect((await trx('payroll_runs').where({ id: first.id }).first('unpaid_time_off')).unpaid_time_off).toBeNull();
      const redone = (await draft(W2)).body.run;
      expect(byName(redone, 'Sample Alpha')).toMatchObject({ ptoHours: '5.00' });
    });

    it('lets an earlier week be finalized under a later final run that left no time off of its technicians unpaid', async () => {
      // Week 2 was finalized while time off was turned off: Alpha's day off in it was never read, Alpha got no
      // check, and the run kept no list. A day booked in a later week is not a bank decision by itself.
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      await worked(other, W2);
      await offDay(id, addDays(W2, 1), 5);
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const second = await draftAndFinalize(W2);
      process.env.GATE_PAYROLL_TIME_OFF = 'true';
      expect(second.checks.map((c) => c.name)).toEqual(['Sample Bravo']);
      expect((await trx('payroll_runs').where({ id: second.id }).first('unpaid_time_off')).unpaid_time_off).toBeNull();
      await worked(id, W1);
      const first = (await draft(W1)).body.run;
      expect(byName(first, 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '1.54' });
      expect((await finalize(first.id)).status).toBe(200);
    });

    it('makes a later draft stale when an earlier week is finalized after it was drafted', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await worked(id, W1);
      await worked(id, W2);
      const early = (await draft(W1)).body.run;
      const late = (await draft(W2)).body.run;
      expect(byName(late, 'Sample Alpha').timeOffBank.balanceHours).toBe('1.54');
      expect((await finalize(early.id)).status).toBe(200);
      const shown = (await api('GET', `/runs/${late.id}`)).body.run;
      expect(shown.stale).toBe(true);
    });

    it('does not count a later final check in the draft of an earlier week, and does not finalize under it', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W2);
      await worked(id, W1);
      const early = (await draft(W1)).body.run;
      expect(byName(early, 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '1.54', balanceHours: '1.54' });
      const done = await finalize(early.id);
      expect([done.status, done.body.error]).toEqual([409, 'A later pay run is already final. Void it first, then finalize this one.']);
    });

    // Only 2026 has tax tables, so two years of real runs cannot be made here: the guard's answer is set instead.
    it('refuses to finalize or void a run when a later check already read the bank', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const plain = await tech('Sample Bravo');
      await worked(id, W1);
      await worked(plain, W1);
      const created = (await draft(W1)).body.run;
      const later = jest.spyOn(bank, 'laterBankCheckExists');
      try {
        later.mockResolvedValueOnce(true);
        const held = await finalize(created.id);
        expect([held.status, held.body.error]).toEqual([409, 'A later pay run is already final. Void it first, then finalize this one.']);
        // Asked about the technicians whose check holds a bank, not the others.
        expect(later.mock.calls[0][2]).toEqual([id]);
        expect((await finalize(created.id)).status).toBe(200);
        later.mockClear();
        later.mockResolvedValueOnce(true);
        const voided = await api('POST', `/runs/${created.id}/void`, { body: { reason: 'Redo' } });
        expect([voided.status, voided.body.error]).toEqual([409, 'A later pay run is already final. Void it first.']);
        expect(later.mock.calls[0][2]).toEqual([id]);
        expect((await api('POST', `/runs/${created.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      } finally {
        later.mockRestore();
      }
    });

    it('knows a later finalized bank check in any year, and only for a technician with a bank', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const plain = await tech('Sample Bravo');
      await worked(plain, W1);
      const run = await fullWeek(id, W1);
      // A run of the year before: year-to-date resets at the new year, the bank does not.
      const yearBefore = { id: randomUUID(), pay_date: '2025-12-26', week_start: '2025-12-15' };
      expect(await bank.laterBankCheckExists(trx, yearBefore, [id])).toBe(true);
      expect(await bank.laterBankCheckExists(trx, yearBefore, [plain])).toBe(false);
      expect(await bank.laterBankCheckExists(trx, yearBefore, [])).toBe(false);
      // Not later than itself, and not later than a run after it.
      expect(await bank.laterBankCheckExists(trx, { id: run.id, pay_date: run.payDate, week_start: W1 }, [id])).toBe(false);
      expect(await bank.laterBankCheckExists(trx, { id: randomUUID(), pay_date: '2027-01-08', week_start: '2026-12-28' }, [id])).toBe(false);
      expect(await bank.bankTechniciansOfRun(trx, run.id)).toEqual([id]);
    });
  });

  describe('recording a day', () => {
    const today = etDateString();
    const day = (n) => addDays(today, n);
    const post = (body) => api('POST', '/time-off', { body: { kind: 'pto', hours: 8, ...body } });

    it('saves the illness mark, changes it, and refuses it on a holiday', async () => {
      const id = await tech('Sample Alpha');
      const created = await post({ technicianId: id, workDate: day(5), illness: true });
      expect(created.status).toBe(201);
      expect(created.body.entry).toMatchObject({ kind: 'pto', illness: true });
      const change = (body) => api('PUT', `/time-off/${created.body.entry.id}`, { body });
      // A screen loaded before the mark existed sends no illness field: the mark stays.
      const kept = await change({ kind: 'pto', hours: 6, note: 'Flu' });
      expect(kept.body.entry).toMatchObject({ hours: '6.00', illness: true });
      expect((await change({ kind: 'pto', hours: 6, illness: false })).body.entry.illness).toBe(false);
      expect((await change({ kind: 'pto', hours: 6 })).body.entry.illness).toBe(false);
      expect((await change({ kind: 'pto', hours: 6, illness: true })).body.entry.illness).toBe(true);
      const holiday = await post({ technicianId: id, workDate: day(6), kind: 'holiday', illness: true });
      expect([holiday.status, holiday.body.error]).toEqual([400, 'Only a paid time off day can be marked as illness']);
      expect((await change({ kind: 'holiday', hours: 8, illness: true })).status).toBe(400);
      // A holiday has no mark: the change of kind clears it, with no field sent.
      const toHoliday = await change({ kind: 'holiday', hours: 8 });
      expect([toHoliday.status, toHoliday.body.entry.kind, toHoliday.body.entry.illness]).toEqual([200, 'holiday', false]);
      const listed = (await api('GET', `/time-off?from=${day(0)}&to=${day(30)}`)).body.entries;
      expect(listed.map((entry) => entry.illness)).toEqual([false]);
    });

    it('never warns for a technician with no bank, and a contractor has no bank whatever the setting says', async () => {
      const id = await tech('Sample Alpha', { hired: null });
      expect((await post({ technicianId: id, workDate: day(5), hours: 24 })).body.warning).toBeNull();
      const contractor = await tech('Sample Contractor', { hours: '80', employment_type: '1099' });
      expect(await balanceOf(contractor)).not.toHaveProperty('bank');
      expect((await bank.bankTechnicians(trx, [id, contractor])).size).toBe(0);
    });

    it('warns when the bank does not hold the waiting hours, and saves the day', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W1);
      // Exactly what the bank holds: no warning.
      const first = await post({ technicianId: id, workDate: day(5), hours: 1.54 });
      expect([first.status, first.body.warning]).toEqual([201, null]);
      const second = await post({ technicianId: id, workDate: day(6), hours: 8 });
      expect(second.status).toBe(201);
      expect(second.body.warning).toBe('Sample Alpha has 1.54 hours in the time-off bank today and 9.54 hours of paid time off waiting for a pay run. A pay run pays only the hours the bank holds then. The day is saved.');
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '1.54', waitingHours: '9.54' });
      // The id in capitals is the same technician: the same bank, and the same kind of warning.
      expect((await balanceOf(id.toUpperCase())).bank).toMatchObject({ balanceHours: '1.54', waitingHours: '9.54' });
      const capitals = await post({ technicianId: id.toUpperCase(), workDate: day(8), hours: 1 });
      expect([capitals.status, capitals.body.warning]).toEqual([201, 'Sample Alpha has 1.54 hours in the time-off bank today and 10.54 hours of paid time off waiting for a pay run. A pay run pays only the hours the bank holds then. The day is saved.']);
      // A holiday is not bank time: no warning.
      expect((await post({ technicianId: id, workDate: day(7), kind: 'holiday' })).body.warning).toBeNull();
    });

    it('warns about a day in the first 90 days that is not an illness day, and about a missing hire date', async () => {
      const id = await tech('Sample Alpha', { hours: '80', hired: day(-10) });
      const opens = addDays(day(-10), 90);
      const plain = await post({ technicianId: id, workDate: day(5), hours: 8 });
      expect(plain.body.warning).toBe(
        `This day is in the first 90 days of the job. Until ${opens} the time-off bank pays only illness days, up to 16 hours, so this day is unpaid. `
        + 'Sample Alpha has 0.00 hours in the time-off bank today and 8.00 hours of paid time off waiting for a pay run. A pay run pays only the hours the bank holds then. The day is saved.',
      );
      const sick = await api('PUT', `/time-off/${plain.body.entry.id}`, { body: { kind: 'pto', hours: 8, illness: true } });
      expect(sick.body.warning).not.toMatch(/first 90 days/);
      // A day before the hire date is unpaid whatever its mark.
      const notYet = await tech('Sample Charlie', { hours: '80', hired: day(20) });
      const early = await post({ technicianId: notYet, workDate: day(5), hours: 8, illness: true });
      expect(early.body.warning).toMatch(/^This day is before the hire date of Sample Charlie\. The time-off bank does not pay it, so this day is unpaid\. /);
      expect(early.body.warning).not.toMatch(/first 90 days/);
      const noDate = await tech('Sample Bravo', { hours: '80', hired: null });
      expect((await post({ technicianId: noDate, workDate: day(5), hours: 8 })).body.warning)
        .toMatch(/^Add the hire date of Sample Bravo in Time Tracking, Team\. The pay run needs it to pay time off\./);
      expect((await balanceOf(noDate)).bank.usableFrom).toBeNull();
    });
  });
});
