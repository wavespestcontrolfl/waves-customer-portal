// Real PostgreSQL transactions (rolled back): the time-off bank. The migrated columns, a week that
// earns, a pay run that pays time off only from the bank (in full, in part, not at all), the day-90
// illness rule, a missing hire date, the review token, a void, the order guard across years, the
// warnings on a recorded day, the balance, the payout at leaving, and a technician with no bank (today's pay). All names
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
const PAID_OUT_SHORT = (hours) => `${hours} hours of time off are not paid, because the time-off bank was paid out before this paycheck, with every hour it held.`;
const PAID_OUT_LATER = "A later pay run is already final, and it paid out the time-off bank of an employee on this pay run. Void it first, then finalize this one. If its payment was sent, make this pay run again with a pay date after that pay run's.";
const RULE = (hours) => `${hours} hours of time off are not paid, because up to day 90 the time-off bank pays only illness days, up to 16 hours.`;
const BEFORE_HIRE = (hours) => `${hours} hours of time off are not paid, because the time off is before the hire date.`;
// Why a pay run holds a row around a bank payout, as the server words it.
const SET_ELSEWHERE = (name, week) => `This pay run paid out the time-off bank of ${name}, and a payout of that bank is now set for the week of ${week}. Press "Do not pay out" for that week first (Time off, owner account), then void this pay run. Set that payout again after this week is paid again.`;
const WEEK_FIRST = (week) => `A time-off bank payout is set for this week, but the week of ${week} holds work or time off that no final pay run has paid. Pay that week first, or press "Do not pay out" (Time off, owner account)`;
const LATER_FINAL = 'A later pay run is already final. Void it first.';
const WEEK_PASSED = 'This employee already has a final paycheck or bank payout in a later week. Pick a week after it.';
const PAYOUT_FIRST = (week) => `A time-off bank payout is set for the week of ${week}, and that week has no final pay run. Finalize that pay run first, or press "Do not pay out" and pick this week or a later one (Time off, owner account)`;

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
  const api = async (method, path, { body, email } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID, ...(email ? { 'x-test-email': email } : {}) },
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
        balanceHours: '2.31', waitingHours: '0.00', fullWeekHours: '1.54', capHours: 120, usableFrom: addDays(LONG_AGO, 90), payout: null,
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
        earnedMinutes: 435, payoutMinutes: 0, earlyIllnessMinutes: 0, unpaidMinutes: 138.6, unpaidRuleMinutes: 0, unpaidBeforeHireMinutes: 0, beforeMinutes: 461.4, afterMinutes: 435,
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

  describe('paying out the bank when the technician leaves', () => {
    // The owner account's login (the default of IB_FULL_ACCESS_EMAILS); any other admin is refused.
    const OWNER = 'contact@wavespestcontrol.com';
    const payoutWeekOf = async (technicianId) => {
      const row = await trx('technicians').where({ id: technicianId }).first(trx.raw("to_char(pto_payout_week_start, 'YYYY-MM-DD') as week"));
      return row ? row.week : null;
    };
    // What a page that was just read shows of the payout: its week, and its state from the pay run of that week.
    const shownOf = async (technicianId) => {
      const week = await payoutWeekOf(technicianId);
      if (!week) return { shownWeekStart: null, shownState: 'none' };
      const done = await trx('payroll_runs').where({ week_start: week, status: 'finalized' }).first('bank_payouts');
      if (!done) return { shownWeekStart: week, shownState: 'set' };
      const kept = (done.bank_payouts || []).some((row) => row.technicianId === technicianId);
      return { shownWeekStart: week, shownState: kept ? 'paid' : 'missed' };
    };
    // As a page that was just read: it sends the payout it shows.
    const payOut = async (technicianId, weekStart, email = OWNER) => api('PUT', `/technicians/${technicianId}/pto-payout-week`, {
      body: { weekStart, ...(await shownOf(technicianId)) }, email,
    });
    const FINAL_WEEK = "That week's pay run is final. Void it first, or pick a later pay run.";

    it('pays out every hour the bank holds on the pay run the owner picked, the hours that week earned included', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W1);
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '1.54', payout: null });
      const set = await payOut(id, W2);
      expect([set.status, set.body]).toEqual([200, { technician: { id, ptoPayoutWeekStart: W2 } }]);
      expect((await balanceOf(id)).bank.payout).toEqual({ weekStart: W2, final: false });
      await worked(id, W2);
      // A second technician leaves in the same week, with half the yearly hours and no earlier week.
      const second = await tech('Sample Bravo', { hours: '40' });
      expect((await payOut(second, W2)).status).toBe(200);
      await worked(second, W2);
      const run = await draftAndFinalize(W2);
      const check = byName(run, 'Sample Alpha');
      // 1.54 hours from week 1 and the 1.54 hours week 2 earned, at $22.00: $67.76 on top of the 40 worked hours.
      expect(check).toMatchObject({ regularHours: '40.00', ptoHours: '3.08', ptoPayCents: 6776, grossCents: 94776 });
      expect(check.timeOffBank).toEqual({ earnedHours: '1.54', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '0.00', paidOutHours: '3.08' });
      expect((await api('GET', `/checks/${check.id}/stub`)).body.stub.timeOffBank).toEqual(check.timeOffBank);
      const stored = await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot', 'pto_minutes', 'pto_earned_minutes');
      expect([stored.pto_minutes, stored.pto_earned_minutes]).toEqual(['184.80', '92.40']);
      expect(stored.calc_snapshot.ptoBank).toMatchObject({ payoutMinutes: 184.8, beforeMinutes: 92.4, afterMinutes: 0, paidDays: [] });
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '0.00', payout: { weekStart: W2, final: true, hours: '3.08' } });
      // The other technician the run paid out reads their own hours, not the first row of the run's list.
      expect((await balanceOf(second)).bank).toMatchObject({ balanceHours: '0.00', payout: { weekStart: W2, final: true, hours: '0.77' } });
      // The final run keeps the payouts it decided, and the row cannot be changed after.
      const kept = [{ technicianId: id, name: 'Sample Alpha', hours: '3.08' }, { technicianId: second, name: 'Sample Bravo', hours: '0.77' }];
      expect(run.bankPayouts).toEqual(kept);
      // The stored row also keeps the yearly hours each payout used (a catch-up check reads them); the view does not show them.
      expect((await trx('payroll_runs').where({ id: run.id }).first('bank_payouts')).bank_payouts)
        .toEqual([{ ...kept[0], hoursPerYear: 80 }, { ...kept[1], hoursPerYear: 40 }]);
      expect((await refused(() => trx('payroll_runs').where({ id: run.id }).update({ bank_payouts: null }))).message).toMatch(/can only be voided/);
      expect((await refused(() => trx('payroll_runs').insert({ week_start: W4, pay_date: addDays(W4, 11), bank_payouts: JSON.stringify({ technicianId: id }) }))).message)
        .toMatch(/payroll_runs_bank_payouts_check/);
    });

    it('pays the time off of the week first: the paid-out hours are not time off used, and earn nothing', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W1);
      await payOut(id, W2);
      await worked(id, W2, 30);
      await offDay(id, addDays(W2, 3), 10);
      const run = await draftAndFinalize(W2);
      const check = byName(run, 'Sample Alpha');
      // The bank pays 1.54 of the 10 hours off. The week earns on 31.54 paid hours: 1.21, and that is paid out.
      expect(check.timeOffBank).toEqual({ earnedHours: '1.21', usedHours: '1.54', unpaidHours: '8.46', balanceHours: '0.00', paidOutHours: '1.21' });
      expect(check).toMatchObject({ ptoHours: '2.75', ptoPayCents: 6050 });
      expect(run.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '8.46', reason: SHORT('8.46') }]);
      const stored = await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot');
      expect(stored.calc_snapshot.ptoBank.paidDays).toEqual([{ workDate: addDays(W2, 3), minutes: 92.4 }]);
    });

    it('makes a check for the payout alone in a week with no hours and no time off, and none for an empty bank', async () => {
      const alpha = await tech('Sample Alpha', { hours: '80' });
      const bravo = await tech('Sample Bravo', { hours: '80' });
      const charlie = await tech('Sample Charlie', { hours: '80' });
      await worked(alpha, W1);
      await worked(charlie, W1);
      await draftAndFinalize(W1);
      // Alpha and Bravo leave; Bravo's bank is empty. Charlie holds hours and has no payout.
      await payOut(alpha, W2);
      await payOut(bravo, W2);
      const run = await draftAndFinalize(W2);
      expect(run.checks.map((c) => c.name)).toEqual(['Sample Alpha']);
      expect(run.checks[0]).toMatchObject({ regularHours: '0.00', ptoHours: '1.54', ptoPayCents: 3388, grossCents: 3388 });
      expect(run.checks[0].timeOffBank).toEqual({ earnedHours: '0.00', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '0.00', paidOutHours: '1.54' });
      expect((await balanceOf(charlie)).bank).toMatchObject({ balanceHours: '1.54', payout: null });
    });

    it('makes a run with no paycheck for a week whose only decision is the payout of an empty bank, and finalizing it settles the payout', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      // Nobody has hours in week 2 and no payout is set: there is nothing to run.
      const none = await draft(W2);
      expect([none.status, none.body.error]).toEqual([409, 'No W-2 hours to pay for that week.']);
      expect((await payOut(id, W2)).status).toBe(200);
      const created = await draft(W2);
      const kept = [{ technicianId: id, name: 'Sample Alpha', hours: '0.00' }];
      expect([created.status, created.body.run.checks, created.body.run.bankPayouts]).toEqual([201, [], kept]);
      const done = await finalize(created.body.run.id);
      expect([done.status, done.body.run.status, done.body.run.checks, done.body.run.bankPayouts]).toEqual([200, 'finalized', [], kept]);
      expect((await balanceOf(id)).bank.payout).toEqual({ weekStart: W2, final: true, hours: '0.00' });
      // In another such week the payout is taken back under the open draft: nothing is left to finalize.
      expect((await payOut(id, W3)).status).toBe(200);
      const open = (await draft(W3)).body.run;
      expect((await payOut(id, null)).status).toBe(200);
      const empty = await finalize(open.id);
      expect([empty.status, empty.body.error]).toEqual([409, 'There are no paychecks to finalize.']);
    });

    it('does not let the yearly hours be cleared under a payout that is set and not paid', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W1);
      const setHours = (hoursPerYear) => api('PUT', `/technicians/${id}/pto-allowance`, { body: { hoursPerYear } });
      expect((await payOut(id, W2)).status).toBe(200);
      const held = await setHours(null);
      expect([held.status, held.body.error]).toEqual([409,
        'A time-off bank payout is set for this employee. Take it back first ("Do not pay out", owner account), then clear the yearly hours.']);
      expect((await trx('technicians').where({ id }).first('pto_hours_per_year')).pto_hours_per_year).not.toBeNull();
      // Another number leaves the bank in place: the payout stands.
      expect((await setHours(40)).status).toBe(200);
      // Taken back, nothing holds the hours.
      expect((await payOut(id, null)).status).toBe(200);
      expect((await setHours(null)).status).toBe(200);
      // Paid: the payout run is final, and the employee who has left can lose the setting.
      expect((await setHours(80)).status).toBe(200);
      expect((await payOut(id, W2)).status).toBe(200);
      await fullWeek(id, W2);
      expect((await balanceOf(id)).bank.payout).toMatchObject({ weekStart: W2, final: true });
      expect((await setHours(null)).status).toBe(200);
    });

    it('holds the pay run when the bank of a payout is gone, so the payout never disappears without a word', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      await fullWeek(id, W1);
      expect((await payOut(id, W2)).status).toBe(200);
      await worked(other, W2);
      const gone = [{ technicianId: id, name: 'Sample Alpha', reason: bank.NO_BANK_FOR_PAYOUT_REASON, payoutWeek: W2 }];
      // The staff profile makes them a contractor: the pay run has no row for them.
      await trx('technicians').where({ id }).update({ employment_type: '1099' });
      const shown = (await draft(W2)).body.run;
      expect([shown.checks.map((c) => c.name), shown.waiting, shown.blocked]).toEqual([['Sample Bravo'], [], gone]);
      expect(shown).not.toHaveProperty('bankPayouts');
      const held = await finalize(shown.id);
      expect(held.status).toBe(409);
      expect(held.body.error).toContain('Sample Alpha');
      // The contractor also has a time entry in the week. The run shows no waiting row for a contractor, so only
      // the rows on screen count: the run still holds.
      await trx('time_entry_daily_summary').insert({ technician_id: id, work_date: addDays(W2, 1), total_shift_minutes: 480, unpaid_meal_minutes: 0 });
      const withEntry = (await api('GET', `/runs/${shown.id}`)).body.run;
      expect([withEntry.waiting, withEntry.blocked]).toEqual([[], gone]);
      expect((await finalize(shown.id)).status).toBe(409);
      await trx('time_entry_daily_summary').where({ technician_id: id }).del();
      // A writer that is not the yearly-hours save clears the hours, and they worked the week: the run works their
      // check out and still waits.
      await trx('technicians').where({ id }).update({ employment_type: 'w2', pto_hours_per_year: null });
      await worked(id, W2);
      const again = (await api('GET', `/runs/${shown.id}`)).body.run;
      expect(again.blocked).toEqual(gone);
      expect((await finalize(shown.id)).status).toBe(409);
      // With the bank back, the run pays it out (the draft is worked out again first: it has a new check).
      await trx('technicians').where({ id }).update({ pto_hours_per_year: '80' });
      expect((await api('POST', `/runs/${shown.id}/recompute`)).body.run.blocked).toEqual([]);
      const paid = (await finalize(shown.id)).body.run;
      expect([paid.status, paid.blocked, paid.bankPayouts]).toEqual(['finalized', [], [{ technicianId: id, name: 'Sample Alpha', hours: '3.08' }]]);
      // A week with no payout set asks nothing of a technician without a bank.
      await trx('technicians').where({ id }).update({ pto_hours_per_year: null });
      await worked(other, W3);
      expect((await draft(W3)).body.run.blocked).toEqual([]);
      // With the gate off the pay run reads no payout, so it holds nothing for one either.
      await trx('technicians').where({ id }).update({ pto_payout_week_start: W4 });
      await worked(other, W4);
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      expect((await draft(W4)).body.run.blocked).toEqual([]);
    });

    it('takes a payout back whatever the employee is now, and sets one only for an employee with a bank', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      expect((await payOut(id, W2)).status).toBe(200);
      await worked(other, W2);
      await trx('technicians').where({ id }).update({ employment_type: '1099' });
      const shown = (await draft(W2)).body.run;
      expect(shown.blocked.map((row) => [row.name, row.payoutWeek])).toEqual([['Sample Alpha', W2]]);
      // Another week cannot be set for an employee with no bank. The payout is still taken back: that lets the run go.
      const moved = await payOut(id, W3);
      expect([moved.status, moved.body.error]).toEqual([409, 'This employee has no time-off bank.']);
      expect((await payOut(id, null, 'office@example.test')).status).toBe(403);
      expect((await payOut(id, null)).status).toBe(200);
      expect((await trx('technicians').where({ id }).first('pto_payout_week_start')).pto_payout_week_start).toBeNull();
      expect((await api('GET', `/runs/${shown.id}`)).body.run.blocked).toEqual([]);
      expect((await finalize(shown.id)).status).toBe(200);
    });

    it('pays out on the picked week only: an earlier and a later pay run pay no bank out', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await payOut(id, W2);
      const before = await fullWeek(id, W1);
      const first = byName(before, 'Sample Alpha');
      expect(first.timeOffBank).toEqual({ earnedHours: '1.54', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '1.54' });
      expect(byName(await fullWeek(id, W2), 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '3.08', balanceHours: '0.00' });
      const after = await fullWeek(id, W3);
      const third = byName(after, 'Sample Alpha');
      expect(third.timeOffBank).toEqual({ earnedHours: '1.54', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '1.54' });
      // A run that pays a bank check and no payout keeps no payout decision.
      for (const run of [before, after]) {
        expect(run).not.toHaveProperty('bankPayouts');
        expect((await trx('payroll_runs').where({ id: run.id }).first('bank_payouts')).bank_payouts).toBeNull();
      }
    });

    it('makes an open draft stale when the payout is set and when it is taken back, and finalize shows the new numbers first', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W1);
      await worked(id, W2);
      const created = (await draft(W2)).body.run;
      expect(byName(created, 'Sample Alpha').timeOffBank).not.toHaveProperty('paidOutHours');
      expect((await payOut(id, W2)).status).toBe(200);
      expect((await api('GET', `/runs/${created.id}`)).body.run.stale).toBe(true);
      const stale = await api('POST', `/runs/${created.id}/finalize`, { body: { token: created.token } });
      expect([stale.status, stale.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      expect([shown.stale, byName(shown, 'Sample Alpha').timeOffBank.paidOutHours]).toEqual([false, '3.08']);
      // The owner takes the payout back before the run is final: the draft with the payout is out of date.
      const back = await payOut(id, null);
      expect([back.status, back.body.technician.ptoPayoutWeekStart]).toEqual([200, null]);
      expect((await balanceOf(id)).bank.payout).toBeNull();
      expect((await api('GET', `/runs/${created.id}`)).body.run.stale).toBe(true);
      expect((await api('POST', `/runs/${created.id}/finalize`, { body: { token: shown.token } })).status).toBe(409);
      const done = await finalize(created.id);
      expect(done.status).toBe(200);
      expect(byName(done.body.run, 'Sample Alpha').timeOffBank).toEqual({ earnedHours: '1.54', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '3.08' });
    });

    it('gives the hours back when the payout run is voided, pays them out again on its redo, and lets a later week be picked after it', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W1);
      await payOut(id, W2);
      const paid = await fullWeek(id, W2);
      // A final pay run does not read the setting again: its week cannot be picked, by this technician or another.
      const other = await tech('Sample Bravo', { hours: '80' });
      for (const who of [id, other]) {
        const again = await payOut(who, W2);
        expect([again.status, again.body.error]).toEqual([409, FINAL_WEEK]);
      }
      expect((await api('POST', `/runs/${paid.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '1.54', payout: { weekStart: W2, final: false } });
      const redo = await draftAndFinalize(W2);
      expect(byName(redo, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '3.08', balanceHours: '0.00' });
      // Hired again later, the technician leaves a second time: the payout moves to that week.
      expect((await payOut(id, W4)).status).toBe(200);
      await fullWeek(id, W3);
      expect(byName(await fullWeek(id, W4), 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '1.54', paidOutHours: '3.08', balanceHours: '0.00' });
    });

    it('does not finalize an earlier week under a final run that paid out an empty bank, also after the payout moved to another week', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      // Week 2 is Alpha's payout week. Alpha has no hours in it and the bank is empty: no check. Bravo is paid.
      expect((await payOut(id, W2)).status).toBe(200);
      await worked(other, W2);
      const shown = (await draft(W2)).body.run;
      const kept = [{ technicianId: id, name: 'Sample Alpha', hours: '0.00' }];
      // The draft lists the payout it decides, also one of no hours, and no paycheck shows it.
      expect([shown.checks.map((c) => c.name), shown.bankPayouts]).toEqual([['Sample Bravo'], kept]);
      const second = (await finalize(shown.id)).body.run;
      expect(second.bankPayouts).toEqual(kept);
      expect((await trx('payroll_runs').where({ id: second.id }).first('bank_payouts')).bank_payouts).toEqual(kept.map((row) => ({ ...row, hoursPerYear: 80 })));
      expect((await balanceOf(id)).bank.payout).toEqual({ weekStart: W2, final: true, hours: '0.00' });
      // The guard reads that kept list: for the technician it names, from an earlier run, in any year.
      const yearBefore = { id: randomUUID(), pay_date: '2025-12-26', week_start: '2025-12-15' };
      expect(await bank.laterPayoutDecisionExists(trx, yearBefore, [id])).toBe(true);
      expect(await bank.laterPayoutDecisionExists(trx, yearBefore, [other])).toBe(false);
      expect(await bank.laterPayoutDecisionExists(trx, yearBefore, [])).toBe(false);
      expect(await bank.laterPayoutDecisionExists(trx, { id: second.id, pay_date: second.payDate, week_start: W2 }, [id])).toBe(false);
      expect(await bank.laterPayoutDecisionExists(trx, { id: randomUUID(), pay_date: '2027-01-08', week_start: '2026-12-28' }, [id])).toBe(false);
      // Hired again, the technician leaves a second time: the payout week moves. Week 2 keeps what it decided.
      expect((await payOut(id, W4)).status).toBe(200);
      expect(await bank.laterPayoutDecisionExists(trx, yearBefore, [id])).toBe(true);
      // Week 1 would now add hours that the payout of week 2 should have paid: it waits for week 2 to be voided.
      await worked(id, W1);
      const first = (await draft(W1)).body.run;
      const held = await finalize(first.id);
      expect([held.status, held.body.error]).toEqual([409, PAID_OUT_LATER]);
      // The void puts the payout of week 2 back, so it waits while that payout is set for week 4.
      const undo = () => api('POST', `/runs/${second.id}/void`, { body: { reason: 'Redo after week 1' } });
      const waits = await undo();
      expect([waits.status, waits.body.error, await payoutWeekOf(id)]).toEqual([409, SET_ELSEWHERE('Sample Alpha', W4), W4]);
      expect((await payOut(id, null)).status).toBe(200);
      const voided = await undo();
      expect([voided.status, voided.body.run.bankPayouts]).toEqual([200, kept]);
      // A voided run decided nothing.
      expect(await bank.laterPayoutDecisionExists(trx, yearBefore, [id])).toBe(false);
      expect((await finalize(first.id)).status).toBe(200);
      // The void put the payout back on week 2: its redo pays out what week 1 earned.
      expect(await payoutWeekOf(id)).toBe(W2);
      const redo = await draftAndFinalize(W2);
      expect(byName(redo, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '1.54', balanceHours: '0.00' });
      expect(redo.bankPayouts).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '1.54' }]);
    });

    it('pays a week recorded after a sent payout on a later pay date: a catch-up check that pays the wages only and shows the hours, with the payout run untouched', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo', { hours: '80' });
      const undone = await tech('Sample Charlie', { hours: '80' });
      // Week 2 is Alpha's payout week and is paid first: the 1.54 hours it earns are paid out.
      expect((await payOut(id, W2)).status).toBe(200);
      const second = await fullWeek(id, W2);
      expect(byName(second, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '1.54', balanceHours: '0.00' });
      // Charlie's payout of week 3 was final for a while: its pay run is voided and the payout taken back.
      expect((await payOut(undone, W3)).status).toBe(200);
      const third = await fullWeek(undone, W3);
      expect((await api('POST', `/runs/${third.id}/void`, { body: { reason: 'Stays' } })).status).toBe(200);
      expect((await payOut(undone, null)).status).toBe(200);
      // The payment of Alpha's payout check was sent: that pay run cannot be voided any more.
      await trx('payroll_payments').insert({
        id: randomUUID(), check_id: byName(second, 'Sample Alpha').id, attempt: 1, state: 'sent', idempotency_key: randomUUID(),
        note: 'waves-pay:sent', amount_cents: 100, recipient_id: 'r', account_id: randomUUID(),
      });
      const undo = await api('POST', `/runs/${second.id}/void`, { body: { reason: 'Late hours' } });
      expect([undo.status, undo.body.error]).toEqual([409, 'A Mercury payment for this run is not settled. Reject it in Mercury first, or record that the money came back.']);
      // A shift of week 1 is recorded late for each of them.
      for (const one of [id, other, undone]) await worked(one, W1);
      // On the pay date a week-1 run has by default, the week comes BEFORE the payout in the bank's order: the
      // check is an ordinary one, and the run cannot be made final under the payout.
      const early = (await draft(W1)).body.run;
      expect(early.payDate < second.payDate).toBe(true);
      expect(byName(early, 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '1.54', balanceHours: '1.54' });
      expect(byName(early, 'Sample Alpha').timeOffBank).not.toHaveProperty('paidOutHours');
      // The refusal names the way that needs no void.
      const held = await finalize(early.id);
      expect([held.status, held.body.error]).toEqual([409, PAID_OUT_LATER]);
      expect((await api('POST', `/runs/${early.id}/void`, { body: { reason: 'Later pay date' } })).status).toBe(200);
      // On a pay date after the payout's, the week comes after the payout: the check pays the wages only, and shows
      // the 1.54 hours the week would have earned for the office to pay by hand. The bank stays empty.
      const LATE = '2026-10-16';
      expect(second.payDate < LATE).toBe(true);
      const late = (await draft(W1, { payDate: LATE })).body.run;
      const finalized = await finalize(late.id);
      expect(finalized.status).toBe(200);
      const done = finalized.body.run;
      expect(byName(done, 'Sample Alpha').timeOffBank).toEqual({ earnedHours: '0.00', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '0.00', notPaidOutHours: '1.54' });
      expect(byName(done, 'Sample Alpha').ptoHours).toBe('0.00');
      // Not for an employee whose bank was never paid out, and not under a payout run that was voided.
      for (const name of ['Sample Bravo', 'Sample Charlie']) {
        expect(byName(done, name).timeOffBank).toMatchObject({ earnedHours: '1.54', balanceHours: '1.54' });
        expect(byName(done, name).timeOffBank).not.toHaveProperty('paidOutHours');
        expect(byName(done, name).timeOffBank).not.toHaveProperty('notPaidOutHours');
      }
      // The run decided no payout of its own, and the sent payout is as it was.
      expect(done).not.toHaveProperty('bankPayouts');
      expect((await api('GET', `/runs/${second.id}`)).body.run.status).toBe('finalized');
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '0.00', payout: { weekStart: W2, final: true, hours: '1.54' } });
      // The guard's query: the run that kept the payout is later in the bank's order (the pay date, then the pay week).
      const ask = (payDate, weekStart) => bank.laterPayoutDecisionExists(trx, { id: randomUUID(), pay_date: payDate, week_start: weekStart }, [id]);
      expect([await ask(LATE, W1), await ask(second.payDate, W1), await ask(addDays(second.payDate, -1), W3), await ask(second.payDate, W3), await ask(LATE, W3)])
        .toEqual([false, true, true, false, false]);
      // Alpha comes back: a week after the payout week is an ordinary check, and the bank starts again.
      const fourth = await fullWeek(id, W4);
      expect(byName(fourth, 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '1.54', balanceHours: '1.54' });
      expect(byName(fourth, 'Sample Alpha').timeOffBank).not.toHaveProperty('paidOutHours');
    });

    it('shows the hours of a catch-up check after the yearly hours were cleared, at the yearly hours the payout kept', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      expect((await payOut(id, W2)).status).toBe(200);
      const second = await fullWeek(id, W2);
      expect(byName(second, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '1.54', balanceHours: '0.00' });
      // The run keeps the yearly hours the payout was worked out with.
      expect((await trx('payroll_runs').where({ id: second.id }).first('bank_payouts')).bank_payouts)
        .toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '1.54', hoursPerYear: 80 }]);
      // The payout is final, so the owner may clear the yearly hours (the employee leaves the Time off list).
      expect((await api('PUT', `/technicians/${id}/pto-allowance`, { body: { hoursPerYear: null } })).status).toBe(200);
      // 32 hours of work and 8 hours off of week 1 are recorded late, and paid on a pay date after the payout's.
      await worked(id, W1, 32);
      await offDay(id, addDays(W1, 1), 8);
      const late = (await draft(W1, { payDate: '2026-10-16' })).body.run;
      const done = await finalize(late.id);
      expect(done.status).toBe(200);
      // The 8 hours are not paid again: the payout paid every hour the bank held. The 32 hours would have earned
      // 1.23 hours at the 80 hours a year the payout used: shown, not paid.
      expect(byName(done.body.run, 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '0.00', usedHours: '0.00', balanceHours: '0.00', notPaidOutHours: '1.23' });
      expect(done.body.run.unpaidTimeOff).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '8.00', reason: PAID_OUT_SHORT('8.00') }]);
      expect((await bank.paidOutInLaterWeek(trx, [id], { weekStart: addDays(W1, -7), payDate: '2026-10-23' })).get(id)).toEqual({ hoursPerYear: 80 });
    });

    it('pays two late weeks the wages only, and shows the hours of each: the bank of the employee who left stays empty', async () => {
      const id = await tech('Sample Alpha', { hours: '400' });
      // 15 full weeks: 115.35 hours. The payout week has 40 hours off: 83.04 paid out.
      for (let n = 16; n >= 2; n -= 1) await fullWeek(id, addDays(W1, -7 * n));
      for (let day = 0; day < 5; day += 1) await offDay(id, addDays(W2, day), 8);
      expect((await payOut(id, W2)).status).toBe(200);
      expect(byName(await draftAndFinalize(W2), 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '83.04' });
      // Two missed weeks are recorded late and paid after the payout, in any order.
      await worked(id, addDays(W1, -7));
      await worked(id, W1);
      for (const [week, payDate] of [[W1, '2026-10-16'], [addDays(W1, -7), '2026-10-23']]) {
        const late = await finalize((await draft(week, { payDate })).body.run.id);
        expect(late.status).toBe(200);
        const shown = byName(late.body.run, 'Sample Alpha');
        expect(shown.timeOffBank).toEqual({ earnedHours: '0.00', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '0.00', notPaidOutHours: '7.69' });
        expect(shown.ptoHours).toBe('0.00');
      }
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '0.00' });
    });

    it('does not void a plain check under a later empty payout: its redo on the same pay date could not be made final', async () => {
      const id = await tech('Sample Alpha');
      const other = await tech('Sample Bravo');
      // Week 1: a plain check (no bank yet). Then Alpha gets a bank and leaves: the payout of week 2 is empty.
      await worked(id, W1);
      const first = await draftAndFinalize(W1);
      expect(byName(first, 'Sample Alpha').timeOffBank).toBeUndefined();
      expect((await api('PUT', `/technicians/${id}/pto-allowance`, { body: { hoursPerYear: 80 } })).status).toBe(200);
      expect((await payOut(id, W2)).status).toBe(200);
      await worked(other, W2);
      expect((await draftAndFinalize(W2)).bankPayouts).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '0.00' }]);
      const undo = await api('POST', `/runs/${first.id}/void`, { body: { reason: 'Redo' } });
      expect([undo.status, undo.body.error]).toEqual([409, 'A later pay run is already final. Void it first.']);
    });

    it('does not finalize a plain check of an earlier week under an empty payout after the yearly hours were cleared', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      // The payout of week 2 is of an empty bank: no check of Alpha.
      expect((await payOut(id, W2)).status).toBe(200);
      await worked(other, W2);
      const second = await draftAndFinalize(W2);
      expect([second.checks.map((c) => c.name), second.bankPayouts]).toEqual([['Sample Bravo'], [{ technicianId: id, name: 'Sample Alpha', hours: '0.00' }]]);
      expect((await api('PUT', `/technicians/${id}/pto-allowance`, { body: { hoursPerYear: null } })).status).toBe(200);
      // A day off of week 1 is recorded late. On week 1's own pay date it is before the payout: refused.
      await worked(id, W1, 32);
      await offDay(id, addDays(W1, 1), 8);
      const early = (await draft(W1)).body.run;
      expect(early.payDate < second.payDate).toBe(true);
      const held = await finalize(early.id);
      expect([held.status, held.body.error]).toEqual([409, PAID_OUT_LATER]);
    });

    it('does not hold a payout for a week whose pay run is final: time off alone, made final with the gate off', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      // Week 1: a day off of Alpha only. The gate is off when week 1 is made final, so the run has no check of
      // Alpha and keeps no decision. No other run can pay week 1 now.
      await offDay(id, addDays(W1, 1), 8);
      await worked(other, W1);
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const first = await draftAndFinalize(W1);
      process.env.GATE_PAYROLL_TIME_OFF = 'true';
      expect(first.checks.map((c) => c.name)).toEqual(['Sample Bravo']);
      // The payout of week 2 does not wait for week 1.
      expect((await payOut(id, W2)).status).toBe(200);
      await worked(other, W2);
      const second = (await draft(W2)).body.run;
      expect(second.blocked).toEqual([]);
      expect((await finalize(second.id)).status).toBe(200);
    });

    it('refuses a payout change from a page that shows another payout, or the same payout in another state', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const put = (weekStart, shownWeekStart, shownState) => api('PUT', `/technicians/${id}/pto-payout-week`, { body: { weekStart, shownWeekStart, shownState }, email: OWNER });
      const refusal = async (answer) => { const { status, body } = await answer; return [status, body.error]; };
      const CHANGED = [409, 'The bank payout of this employee changed after this page was read. Check it, then press again.'];
      const PAID = [409, 'That bank payout is paid: its pay run is final. Void that pay run to change it.'];
      const SHOWN = [400, 'Send the bank payout the page shows (shownWeekStart, empty for none, and shownState)'];
      // The page must say which payout it shows: the week (empty for none) and the state.
      expect(await refusal(put(W2))).toEqual(SHOWN);
      expect(await refusal(put(W2, null))).toEqual(SHOWN);
      expect(await refusal(put(W2, undefined, 'none'))).toEqual(SHOWN);
      expect(await refusal(put(W2, null, 'final'))).toEqual(SHOWN);
      expect(await refusal(put(W2, addDays(W2, 1), 'set'))).toEqual([400, 'Pick the first day of a pay week (YYYY-MM-DD)']);
      expect(await payoutWeekOf(id)).toBeNull();
      expect((await put(W2, '', 'none')).status).toBe(200);
      // One tab moves the payout to week 3. Another tab still shows week 2, or none: its buttons change nothing.
      // The same for a page that shows week 3 in a state it is not in.
      expect((await put(W3, W2, 'set')).status).toBe(200);
      for (const stale of [[null, W2, 'set'], [W4, W2, 'set'], [W4, null, 'none'], [null, null, 'none'], [null, W3, 'missed'], [W4, W3, 'paid'], [null, W3, 'none']]) {
        expect(await refusal(put(...stale))).toEqual(CHANGED);
      }
      expect(await payoutWeekOf(id)).toBe(W3);
      // The page that shows week 3 takes it back. A second press from a page that still shows week 3 is refused.
      expect((await put(null, W3, 'set')).status).toBe(200);
      expect(await refusal(put(null, W3, 'set'))).toEqual(CHANGED);
      expect(await payoutWeekOf(id)).toBeNull();
      // The pay run of the payout week is made final. A page read before that still shows "Do not pay out".
      expect((await put(W2, null, 'none')).status).toBe(200);
      const run = await fullWeek(id, W2);
      expect(await refusal(put(null, W2, 'set'))).toEqual(CHANGED);
      // No page offers a take-back of a paid payout, and a request for one is refused: only a void changes it.
      expect(await refusal(put(null, W2, 'paid'))).toEqual(PAID);
      expect((await balanceOf(id)).bank.payout).toEqual({ weekStart: W2, final: true, hours: '1.54' });
      // That run is voided. A page read before the void shows week 2 as paid and offers a payout for another
      // week: it would take week 2's payout away from the redo.
      expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect(await refusal(put(W3, W2, 'paid'))).toEqual(CHANGED);
      expect(await payoutWeekOf(id)).toBe(W2);
      // The redo pays the bank out again. Another week can then be set (the employee leaves a second time), and
      // that one is taken back.
      await draftAndFinalize(W2);
      expect((await put(W3, W2, 'paid')).status).toBe(200);
      expect((await put(null, W3, 'set')).status).toBe(200);
      // Only the six changes that were made are in the audit log.
      expect(await trx('audit_log').where({ action: 'payroll.pto_payout_week_changed', resource_id: id })).toHaveLength(6);
    });

    it('does not settle a payout with no check while a final check on a later pay date holds bank hours', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      // Week 1 is paid late: its check, on a pay date after week 2's, puts 1.54 hours in the bank.
      const LATE = '2026-10-09';
      await worked(id, W1);
      const late = await draft(W1, { payDate: LATE });
      expect((await finalize(late.body.run.id)).status).toBe(200);
      expect((await balanceOf(id)).bank.balanceHours).toBe('1.54');
      // Week 2 is Alpha's payout week, on its own earlier pay date, and Alpha has no hours in it. In the bank's
      // order week 1's check comes later, so this run reads an empty bank: no check, a payout of nothing.
      expect((await payOut(id, W2)).status).toBe(200);
      await worked(other, W2);
      const shown = (await draft(W2)).body.run;
      expect(shown.payDate < LATE).toBe(true);
      expect([shown.checks.map((c) => c.name), shown.bankPayouts]).toEqual([['Sample Bravo'], [{ technicianId: id, name: 'Sample Alpha', hours: '0.00' }]]);
      const held = await finalize(shown.id);
      expect([held.status, held.body.error]).toEqual([409, 'A later pay run is already final. Void it first, then finalize this one.']);
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '1.54', payout: { weekStart: W2, final: false } });
      // On a pay date not before week 1's, the run reads the bank with those hours and pays them out.
      expect((await api('POST', `/runs/${shown.id}/void`, { body: { reason: 'Pay date' } })).status).toBe(200);
      const again = await draft(W2, { payDate: LATE });
      expect(again.status).toBe(201);
      const done = (await finalize(again.body.run.id)).body.run;
      expect(byName(done, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '1.54', balanceHours: '0.00' });
      expect(done.bankPayouts).toEqual([{ technicianId: id, name: 'Sample Alpha', hours: '1.54' }]);
    });

    it('does not pay out on a week before a week whose check is already final, also on a later pay date', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo', { hours: '80' });
      // Week 2 is paid first: ordinary checks that earn 1.54 hours each.
      await worked(other, W2);
      await fullWeek(id, W2);
      // The owner picks week 1 for Alpha's payout and pays it late, after week 2's pay date. In the bank's order
      // week 2's hours are in the bank by then: this payout would pay out hours earned after its own week.
      // The setter refuses that week now. The pay run does not trust the setting either: it is written here as
      // another writer would.
      const LATE = '2026-10-09';
      expect((await payOut(id, W1)).status).toBe(409);
      await trx('technicians').where({ id }).update({ pto_payout_week_start: W1 });
      await worked(id, W1);
      const shown = (await draft(W1, { payDate: LATE })).body.run;
      expect(byName(shown, 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '1.54', paidOutHours: '3.08' });
      const held = await finalize(shown.id);
      expect([held.status, held.body.error]).toEqual([409, 'A later pay run is already final. Void it first, then finalize this one.']);
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '1.54', payout: { weekStart: W1, final: false } });
      // The guard's query: a final check of this technician that holds a bank, for a later week only.
      const ask = (weekStart, ids = [id]) => bank.laterWeekBankCheckExists(trx, { id: randomUUID(), week_start: weekStart }, ids);
      expect([await ask(W1), await ask(W2), await ask(W3)]).toEqual([true, false, false]);
      expect([await ask(W1, []), await ask(W1, [randomUUID()]), await ask(W1, [other])]).toEqual([false, false, true]);
      // A voided check holds nothing.
      const gone = await tech('Sample Charlie', { hours: '80' });
      const fourth = await fullWeek(gone, W4);
      expect(await ask(W1, [gone])).toBe(true);
      expect((await api('POST', `/runs/${fourth.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect(await ask(W1, [gone])).toBe(false);
      // A final payout of a later week counts too, also of an empty bank (a kept decision with no check).
      const left = await tech('Sample Delta', { hours: '80' });
      expect((await payOut(left, W4)).status).toBe(200);
      expect((await draftAndFinalize(W4)).bankPayouts.map((row) => row.name)).toEqual(['Sample Delta']);
      expect([await ask(W1, [left]), await ask(W4, [left]), await ask(addDays(W4, 7), [left]), await ask(W1, [randomUUID()])]).toEqual([true, false, false, false]);
      // The payout goes on a later week. Week 1 is then an ordinary check, and the later run pays out both weeks.
      expect((await payOut(id, W3)).status).toBe(200);
      const changed = await finalize(shown.id);
      expect([changed.status, changed.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      const first = (await finalize(shown.id)).body.run;
      expect(byName(first, 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '1.54', balanceHours: '3.08' });
      expect(byName(first, 'Sample Alpha').timeOffBank).not.toHaveProperty('paidOutHours');
      const third = await draft(W3, { payDate: '2026-10-16' });
      expect(third.status).toBe(201);
      const done = (await finalize(third.body.run.id)).body.run;
      expect(byName(done, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '3.08', balanceHours: '0.00' });
    });

    it('keeps time off recorded after a final payout as not paid when its week is paid on a later pay date, and pays it in order when the payout run is voided first', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      // Week 1 puts 1.54 hours in the bank. Week 3 is the payout week and is paid before week 2 is processed.
      await fullWeek(id, W1);
      expect((await payOut(id, W3)).status).toBe(200);
      const third = await fullWeek(id, W3);
      expect(byName(third, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '3.08', balanceHours: '0.00' });
      // Week 2 has one hour of time off and no work, and is paid late. It reads the bank after the payout: empty.
      // No check for Alpha, only the decision that the hour is not paid, when the bank held it before the payout.
      await offDay(id, addDays(W2, 1), 1);
      const LATE = '2026-10-16';
      expect(third.payDate < LATE).toBe(true);
      const unpaid = [{ technicianId: id, name: 'Sample Alpha', hours: '1.00', reason: PAID_OUT_SHORT('1.00') }];
      const second = (await draft(W2, { payDate: LATE })).body.run;
      expect([second.checks, second.unpaidTimeOff]).toEqual([[], unpaid]);
      // The run can be made final as it is, with no run voided (the payout's payment may be sent): the payout
      // already paid every hour the bank held, this hour among them, so the run keeps it as not paid.
      const closed = await finalize(second.id);
      expect([closed.status, closed.body.run.checks, closed.body.run.unpaidTimeOff]).toEqual([200, [], unpaid]);
      // While the payout run can still be voided, the owner can pay the weeks in order instead: this run is
      // voided, then the payout run. Week 2 then pays the hour from the bank, and the payout run made again on a
      // pay date not before it pays out what is left.
      expect((await api('POST', `/runs/${second.id}/void`, { body: { reason: 'In order' } })).status).toBe(200);
      expect((await api('POST', `/runs/${third.id}/void`, { body: { reason: 'Week 2 first' } })).status).toBe(200);
      const redone = await draft(W2, { payDate: LATE });
      expect(redone.status).toBe(201);
      const paid = (await finalize(redone.body.run.id)).body.run;
      expect(byName(paid, 'Sample Alpha')).toMatchObject({ ptoHours: '1.00' });
      expect(paid).not.toHaveProperty('unpaidTimeOff');
      const again = await draft(W3, { payDate: LATE });
      expect(again.status).toBe(201);
      const redo = (await finalize(again.body.run.id)).body.run;
      const settled = byName(redo, 'Sample Alpha').timeOffBank;
      expect(settled.balanceHours).toBe('0.00');
      expect(Number(settled.paidOutHours)).toBeGreaterThan(2);
      expect(Number(settled.paidOutHours)).toBeLessThan(3.08);
    });

    it('holds a payout while an earlier week of the technician still needs its paycheck, also the payout of an empty bank', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const empty = await tech('Sample Bravo', { hours: '80' });
      const off = await tech('Sample Charlie', { hours: '80' });
      // Week 1 holds approved hours of Alpha and Bravo and a day off of Charlie. No pay run has paid it.
      await worked(id, W1);
      await worked(empty, W1);
      await offDay(off, addDays(W1, 1), 8);
      // All three payouts are set for week 2. Only Alpha works that week: Bravo has the payout alone, and Charlie
      // the payout and a day off, of a bank that holds nothing yet. Paid now, each payout would miss what week 1
      // earns, and week 1 could not be made final after it. The run decides nothing for a held row: it lists no
      // payout and no time off as not paid.
      for (const one of [id, empty, off]) expect((await payOut(one, W2)).status).toBe(200);
      await worked(id, W2);
      await offDay(off, addDays(W2, 1), 8);
      const held = [[id, 'Sample Alpha'], [empty, 'Sample Bravo'], [off, 'Sample Charlie']]
        .map(([technicianId, name]) => ({ technicianId, name, reason: WEEK_FIRST(W1) }));
      const second = (await draft(W2)).body.run;
      expect([second.checks, second.blocked]).toEqual([[], held]);
      expect(second).not.toHaveProperty('bankPayouts');
      expect(second).not.toHaveProperty('unpaidTimeOff');
      const stopped = await finalize(second.id);
      expect(stopped.status).toBe(409);
      expect(stopped.body.error).toContain(`Sample Bravo: ${WEEK_FIRST(W1)}`);
      // Week 1 is paid: two checks, and Charlie's day off is kept as not paid (the bank held nothing), which
      // settles the week for Charlie with no check.
      const first = await draftAndFinalize(W1);
      expect([first.checks.map((c) => c.name), first.unpaidTimeOff.map((row) => row.name)]).toEqual([['Sample Alpha', 'Sample Bravo'], ['Sample Charlie']]);
      // The payouts go on, with what week 1 earned in them.
      expect((await api('GET', `/runs/${second.id}`)).body.run.blocked).toEqual([]);
      const changed = await finalize(second.id);
      expect([changed.status, changed.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      const done = (await finalize(second.id)).body.run;
      expect(done.bankPayouts).toEqual([
        { technicianId: id, name: 'Sample Alpha', hours: '3.08' },
        { technicianId: empty, name: 'Sample Bravo', hours: '1.54' },
        { technicianId: off, name: 'Sample Charlie', hours: '0.00' },
      ]);
      expect(done.unpaidTimeOff).toEqual([{ technicianId: off, name: 'Sample Charlie', hours: '8.00', reason: SHORT('8.00') }]);
    });

    it('asks a payout for the weeks from the hire date on, and for every week with no hire date or after an earlier stay on pay runs', async () => {
      // Alpha came back. The hire date on file is in week 3, week 1 of the first stay was paid by a pay run, and
      // week 2 of that stay was approved and never paid. The pay run of week 2 still pays it: the payout waits.
      const id = await tech('Sample Alpha', { hours: '80', hired: addDays(W3, 2) });
      await fullWeek(id, W1);
      await worked(id, W2);
      // Bravo has no hire date and no paycheck on file: every earlier week is asked. (Week 1 has a final pay run
      // now, so no run can pay it: an approved week there is no wait. Week 2 has no final run.)
      const undated = await tech('Sample Bravo', { hours: '80', hired: null });
      await worked(undated, W2);
      // Charlie was a contractor before the hire date in week 2. The contractor week on file was paid outside pay
      // runs, and no pay run of theirs holds a check: it is not asked, or it would hold every payout for good.
      const former = await tech('Sample Charlie', { hours: '80', hired: addDays(W2, 2) });
      await worked(former, addDays(W1, -7));
      // Delta was hired on the same day and worked that week: the week of the hire date is asked whole.
      const hiredThen = await tech('Sample Delta', { hours: '80', hired: addDays(W2, 2) });
      await worked(hiredThen, W2);
      for (const one of [id, undated, former, hiredThen]) {
        await worked(one, W3);
        expect((await payOut(one, W3)).status).toBe(200);
      }
      const shown = (await draft(W3)).body.run;
      expect(shown.checks.map((c) => c.name)).toEqual(['Sample Charlie']);
      expect(shown.blocked).toEqual([
        { technicianId: id, name: 'Sample Alpha', reason: WEEK_FIRST(W2) },
        { technicianId: undated, name: 'Sample Bravo', reason: WEEK_FIRST(W2) },
        { technicianId: hiredThen, name: 'Sample Delta', reason: WEEK_FIRST(W2) },
      ]);
      expect(shown.bankPayouts).toEqual([{ technicianId: former, name: 'Sample Charlie', hours: '1.54' }]);
      // A week with nothing on file is no wait, and the payout's own week is never asked of itself.
      await trx('time_weekly_summary').where({ technician_id: undated, week_start: W2 }).del();
      expect((await api('GET', `/runs/${shown.id}`)).body.run.blocked.map((row) => row.name)).toEqual(['Sample Alpha', 'Sample Delta']);
    });

    it('lets a paycheck only widen the weeks a payout asks: a draft or a paycheck of a later week hides no earlier week', async () => {
      // Alpha has no hire date. Week 1 was approved and never paid, and the draft of week 3 is made BEFORE the
      // payout is set, so it holds a draft check of theirs for week 3.
      const drafted = await tech('Sample Alpha', { hours: '80', hired: null });
      // Bravo has no hire date either. Week 1 was never paid, and week 2 has a final paycheck.
      const undated = await tech('Sample Bravo', { hours: '80', hired: null });
      // Charlie was hired in week 1. Week 1 was never paid, and their first paycheck is the one of week 2.
      const hired = await tech('Sample Charlie', { hours: '80', hired: addDays(W1, 2) });
      // Delta was a contractor in week 1 and an employee from week 2 on, paid by the pay run of week 2: a paycheck
      // of the week of the hire date is no earlier stay, so the contractor week is not asked.
      const former = await tech('Sample Delta', { hours: '80', hired: addDays(W2, 2) });
      const plain = await tech('Sample Echo');
      // Foxtrot was a contractor in week 1 too, an employee in week 2, and came back since: the hire date on
      // file is in week 3. The earlier stay is asked from its first paycheck on, not the contractor week before it.
      const back = await tech('Sample Foxtrot', { hours: '80', hired: addDays(W3, 2) });
      for (const one of [drafted, undated, hired, former, back]) await worked(one, W1);
      for (const one of [undated, hired, former, back]) await worked(one, W2);
      await draftAndFinalize(W2);
      for (const one of [drafted, plain]) await worked(one, W3);
      const open = (await draft(W3)).body.run;
      expect(open.checks.map((c) => c.name)).toEqual(['Sample Alpha', 'Sample Echo']);
      for (const one of [drafted, undated, hired, former, back]) expect((await payOut(one, W3)).status).toBe(200);
      const shown = (await api('POST', `/runs/${open.id}/recompute`)).body.run;
      expect(shown.blocked).toEqual([
        { technicianId: drafted, name: 'Sample Alpha', reason: WEEK_FIRST(W1) },
        { technicianId: undated, name: 'Sample Bravo', reason: WEEK_FIRST(W1) },
        { technicianId: hired, name: 'Sample Charlie', reason: WEEK_FIRST(W1) },
      ]);
      expect(shown.checks.map((c) => c.name)).toEqual(['Sample Delta', 'Sample Echo', 'Sample Foxtrot']);
      expect(shown.bankPayouts).toEqual([
        { technicianId: former, name: 'Sample Delta', hours: '1.54' },
        { technicianId: back, name: 'Sample Foxtrot', hours: '1.54' },
      ]);
    });

    it('asks every earlier week of an employee who came back once a pay run holds a paycheck of the earlier stay: an open draft, or a run that was final once', async () => {
      // Alpha came back: the hire date on file is in week 3. Week 1 is on file from before it, and no pay run
      // has touched it. Nothing tells it from work paid outside pay runs: the payout does not wait for it.
      const id = await tech('Sample Alpha', { hours: '80', hired: addDays(W3, 2) });
      await worked(id, W1);
      await worked(id, W3);
      const open = (await draft(W3)).body.run;
      expect((await payOut(id, W3)).status).toBe(200);
      const recompute = async () => (await api('POST', `/runs/${open.id}/recompute`)).body.run;
      const held = [{ technicianId: id, name: 'Sample Alpha', reason: WEEK_FIRST(W1) }];
      expect(await recompute()).toMatchObject({ blocked: [], bankPayouts: [{ technicianId: id, name: 'Sample Alpha', hours: '1.54' }] });
      // The owner drafts the pay run of week 1: a pay run is about to pay that week, so the payout waits for it.
      const first = (await draft(W1)).body.run;
      expect((await recompute()).blocked).toEqual(held);
      // The draft is taken back: no pay run holds the week any more.
      expect((await api('POST', `/runs/${first.id}/void`, { body: { reason: 'Not this week' } })).status).toBe(200);
      expect((await recompute()).blocked).toEqual([]);
      // Week 1 is paid by a pay run: nothing waits, and the payout holds the hours that week earned.
      const paid = await draftAndFinalize(W1);
      expect(await recompute()).toMatchObject({ blocked: [], bankPayouts: [{ technicianId: id, name: 'Sample Alpha', hours: '3.08' }] });
      // That run is voided: week 1 needs its paycheck again, and a run that was final once is an earlier stay.
      expect((await api('POST', `/runs/${paid.id}/void`, { body: { reason: 'Correction' } })).status).toBe(200);
      expect((await recompute()).blocked).toEqual(held);
    });

    it('puts a paid payout back on its week when its pay run is voided, and refuses the void while the owner has that payout set for another week', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const empty = await tech('Sample Bravo', { hours: '80' });
      const moved = await tech('Sample Charlie', { hours: '80' });
      const kept = await tech('Sample Delta', { hours: '80' });
      await fullWeek(id, W1);
      // Week 2 pays the four banks out: Alpha's with hours, the others with none (no check).
      for (const one of [id, empty, moved, kept]) expect((await payOut(one, W2)).status).toBe(200);
      await worked(id, W2);
      const second = await draftAndFinalize(W2);
      expect(byName(second, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '3.08', balanceHours: '0.00' });
      // The owner sets a later week for three of them, then takes Alpha's and Bravo's back: they have no payout
      // week now. Charlie's stays on week 4. Delta's was never touched: it is still on week 2.
      for (const one of [id, empty, moved]) expect((await payOut(one, W4)).status).toBe(200);
      // A void names the first of them, in name order.
      expect((await api('POST', `/runs/${second.id}/void`, { body: { reason: 'Correction' } })).body.error).toBe(SET_ELSEWHERE('Sample Alpha', W4));
      for (const one of [id, empty]) expect((await payOut(one, null)).status).toBe(200);
      const weeks = async () => Promise.all([id, empty, moved, kept].map(payoutWeekOf));
      expect(await weeks()).toEqual([null, null, W4, W2]);
      // Week 2 is voided for a correction. The void cannot put Charlie's payout back while it is set for week 4:
      // the run made again would pay week 2 with no payout, and week 4 would pay those hours out at its own rate.
      const refused = await api('POST', `/runs/${second.id}/void`, { body: { reason: 'Correction' } });
      expect(refused).toMatchObject({ status: 409, body: { error: SET_ELSEWHERE('Sample Charlie', W4) } });
      expect(await weeks()).toEqual([null, null, W4, W2]);
      expect((await api('GET', `/runs/${second.id}`)).body.run.status).toBe('finalized');
      // The owner takes the week-4 payout back. The void now puts the three payouts back on week 2, so the run
      // made again does not pay the wages alone.
      expect((await payOut(moved, null)).status).toBe(200);
      expect((await api('POST', `/runs/${second.id}/void`, { body: { reason: 'Correction' } })).status).toBe(200);
      expect(await weeks()).toEqual([W2, W2, W2, W2]);
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '1.54', payout: { weekStart: W2, final: false } });
      // The audit row names the payouts the void put back, not the one that was still set for week 2.
      const logged = await trx('audit_log').where({ action: 'payroll.run_voided', resource_id: second.id }).first('metadata');
      expect(logged.metadata.bank_payouts_reopened).toEqual([id, empty, moved].sort());
      const again = await draftAndFinalize(W2);
      expect(byName(again, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '3.08', balanceHours: '0.00' });
      expect(again.bankPayouts.map((row) => row.name)).toEqual(['Sample Alpha', 'Sample Bravo', 'Sample Charlie', 'Sample Delta']);
      // A void that puts nothing back says nothing of it.
      const third = await fullWeek(await tech('Sample Echo'), W3);
      expect((await api('POST', `/runs/${third.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      const plain = await trx('audit_log').where({ action: 'payroll.run_voided', resource_id: third.id }).first('metadata');
      expect(plain.metadata).not.toHaveProperty('bank_payouts_reopened');
    });

    it('reads an earlier stay from what a pay run kept with no paycheck, and from a day off on file', async () => {
      // The first stay of three employees left no paycheck. Bravo's bank was paid out empty in week 1, Charlie
      // took a day off in week 1 that the empty bank did not pay, and Delta has a day off on file in week 2.
      const paidOut = await tech('Sample Bravo', { hours: '80' });
      const unpaid = await tech('Sample Charlie', { hours: '80' });
      const dayOff = await tech('Sample Delta', { hours: '80' });
      const plain = await tech('Sample Echo');
      expect((await payOut(paidOut, W1)).status).toBe(200);
      await offDay(unpaid, addDays(W1, 1), 8);
      await offDay(dayOff, addDays(W2, 3), 8);
      const first = await fullWeek(plain, W1);
      expect(first.bankPayouts.map((row) => row.name)).toEqual(['Sample Bravo']);
      expect(first.unpaidTimeOff.map((row) => row.name)).toEqual(['Sample Charlie']);
      expect(first.checks.map((c) => c.name)).toEqual(['Sample Echo']);
      // The first fact of each: the pay week of the run that kept a decision, or the day off. A paycheck is none.
      const facts = async () => Object.fromEntries(await bank.firstBankFactDays(trx, [paidOut, unpaid, dayOff, plain]));
      const expected = { [paidOut]: W1, [unpaid]: W1, [dayOff]: addDays(W2, 3) };
      expect(await facts()).toEqual(expected);
      expect(await bank.firstBankFactDays(trx, [])).toEqual(new Map());
      // A run that was final once still tells of the stay after a void.
      expect((await api('POST', `/runs/${first.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect(await facts()).toEqual(expected);
      await draftAndFinalize(W1);
      // Each worked week 2 and was never paid for it. They come back: the hire date on file is now in week 3.
      for (const one of [paidOut, unpaid, dayOff]) await worked(one, W2);
      await trx('technicians').whereIn('id', [paidOut, unpaid, dayOff]).update({ hire_date: addDays(W3, 2) });
      await worked(plain, W3);
      for (const one of [paidOut, unpaid, dayOff]) expect((await payOut(one, W3)).status).toBe(200);
      const shown = (await draft(W3)).body.run;
      expect(shown.checks.map((c) => c.name)).toEqual(['Sample Echo']);
      expect(shown.blocked).toEqual([
        { technicianId: paidOut, name: 'Sample Bravo', reason: WEEK_FIRST(W2) },
        { technicianId: unpaid, name: 'Sample Charlie', reason: WEEK_FIRST(W2) },
        { technicianId: dayOff, name: 'Sample Delta', reason: WEEK_FIRST(W2) },
      ]);
    });

    it('does not set a payout for a week before a final bank paycheck or a final payout of the employee', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo', { hours: '80' });
      const plain = await tech('Sample Charlie');
      // Week 2 is final with a bank check of Alpha. No pay run of week 1 could pay the bank out after it, and the
      // payout would hold Alpha's next paychecks.
      await worked(plain, W2);
      const second = await fullWeek(id, W2);
      const early = await payOut(id, W1);
      expect([early.status, early.body.error, await payoutWeekOf(id)]).toEqual([409, WEEK_PASSED, null]);
      // The question: a final check of THIS employee that holds a bank, for a later week only.
      const ask = (technicianId, weekStart) => bank.laterWeekBankUseExists(trx, weekStart, technicianId);
      expect([await ask(id, W1), await ask(id, W2), await ask(id, W3), await ask(other, W1), await ask(plain, W1)])
        .toEqual([true, false, false, false, false]);
      expect((await payOut(other, W1)).status).toBe(200);
      expect((await payOut(other, null)).status).toBe(200);
      // A voided check does not count.
      expect((await api('POST', `/runs/${second.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect(await ask(id, W1)).toBe(false);
      // A final payout of a later week counts too, also of an empty bank (a kept decision with no check).
      expect((await payOut(other, W3)).status).toBe(200);
      const third = (await draft(W3)).body.run;
      expect((await finalize(third.id)).body.run.bankPayouts).toEqual([{ technicianId: other, name: 'Sample Bravo', hours: '0.00' }]);
      expect([await ask(other, W2), await ask(other, W3), await ask(other, W4), await ask(id, W2)]).toEqual([true, false, false, false]);
      const back = await payOut(other, W2);
      expect([back.status, back.body.error, await payoutWeekOf(other)]).toEqual([409, WEEK_PASSED, W3]);
      // A later week can still be set: the employee comes back and leaves again.
      expect((await payOut(other, W4)).status).toBe(200);
      expect((await payOut(other, null)).status).toBe(200);
      // A voided payout run does not count: its row still holds the list it kept. The void put the payout back
      // on week 3, and the owner can now move it to week 2.
      expect((await api('POST', `/runs/${third.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect([await ask(other, W2), await payoutWeekOf(other)]).toEqual([false, W3]);
      expect((await payOut(other, W2)).status).toBe(200);
    });

    it('does not void a pay run that paid out an empty bank under a later paycheck of the employee, with the gate off too', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      // Week 1 pays out Alpha's bank, which holds nothing: a kept decision with no check.
      expect((await payOut(id, W1)).status).toBe(200);
      const first = (await draft(W1)).body.run;
      expect([first.checks, first.bankPayouts]).toEqual([[], [{ technicianId: id, name: 'Sample Alpha', hours: '0.00' }]]);
      expect((await finalize(first.id)).status).toBe(200);
      expect(await bank.keptPayoutsOfRun(trx, first.id)).toEqual([id]);
      // Alpha comes back, and week 2 pays them: a new bank.
      const second = await fullWeek(id, W2);
      // A void of week 1 would open the payout again under that check: it could never be made final, and it
      // would hold Alpha's next paychecks. The later run goes first.
      const undo = (runId) => api('POST', `/runs/${runId}/void`, { body: { reason: 'Redo' } });
      const held = await undo(first.id);
      expect([held.status, held.body.error]).toEqual([409, LATER_FINAL]);
      // The run's row is read, not the gate: a kept decision counts either way.
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      expect((await undo(first.id)).status).toBe(409);
      process.env.GATE_PAYROLL_TIME_OFF = 'true';
      // The list the run kept is read, not the payout week of today: the owner has set another week since.
      expect((await payOut(id, W4)).status).toBe(200);
      expect((await undo(first.id)).body.error).toBe(LATER_FINAL);
      expect((await undo(second.id)).status).toBe(200);
      // With no later run in the way, the void still waits: it puts the payout back on week 1, and that payout
      // is set for week 4 now. The owner takes week 4 back first.
      const waits = await undo(first.id);
      expect([waits.status, waits.body.error]).toEqual([409, SET_ELSEWHERE('Sample Alpha', W4)]);
      expect((await payOut(id, null)).status).toBe(200);
      expect((await undo(first.id)).status).toBe(200);
      expect((await balanceOf(id)).bank.payout).toEqual({ weekStart: W1, final: false });
    });

    it('voids and makes again a pay run that kept time off as not paid under a later payout of the employee: it changed nothing in the bank', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      // Week 1: one hour off of Alpha that the empty bank does not pay. Kept as not paid, with no check of theirs.
      await offDay(id, addDays(W1, 1), 1);
      await worked(other, W1);
      const first = await draftAndFinalize(W1);
      const unpaid = [{ technicianId: id, name: 'Sample Alpha', hours: '1.00', reason: SHORT('1.00') }];
      expect([first.checks.map((c) => c.name), first.unpaidTimeOff]).toEqual([['Sample Bravo'], unpaid]);
      expect(await bank.keptPayoutsOfRun(trx, first.id)).toEqual([]);
      // Week 2 pays out Alpha's bank (nothing).
      expect((await payOut(id, W2)).status).toBe(200);
      const second = (await draft(W2)).body.run;
      expect((await finalize(second.id)).status).toBe(200);
      // Week 1 is voided for a correction of Bravo's check and made again, with the payout run left as it is:
      // the hour is decided from the bank before the payout, as the first time.
      expect((await api('POST', `/runs/${first.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      const again = await draftAndFinalize(W1);
      expect([again.checks.map((c) => c.name), again.unpaidTimeOff]).toEqual([['Sample Bravo'], unpaid]);
      expect((await api('GET', `/runs/${second.id}`)).body.run.status).toBe('finalized');
    });

    it('does not void a pay run whose week holds a missed payout under a later paycheck of that employee', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      // The payout is set for week 1, and the gate is off when week 1 is made final: the run reads no payout and
      // keeps none. Alpha has no hours that week, so the run holds no check of theirs either.
      expect((await payOut(id, W1)).status).toBe(200);
      await worked(other, W1);
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const first = await draftAndFinalize(W1);
      process.env.GATE_PAYROLL_TIME_OFF = 'true';
      expect((await balanceOf(id)).bank.payout).toEqual({ weekStart: W1, final: false, missed: true });
      // The missed payout holds nothing: week 2 pays Alpha an ordinary check.
      const second = await fullWeek(id, W2);
      expect(byName(second, 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '1.54', balanceHours: '1.54' });
      // A void of week 1 would make that payout live again under week 2's check. The later run goes first.
      const undo = (runId) => api('POST', `/runs/${runId}/void`, { body: { reason: 'Redo' } });
      const held = await undo(first.id);
      expect([held.status, held.body.error]).toEqual([409, LATER_FINAL]);
      expect((await undo(second.id)).status).toBe(200);
      expect((await undo(first.id)).status).toBe(200);
    });

    it('asks a void the order of the pay weeks too, for a payout week another writer set', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      // Week 2 is final first, with a bank check of Alpha (pay date Oct 2). The setter refuses week 1 after that,
      // so the payout week is written as another writer would.
      await fullWeek(id, W2);
      await trx('technicians').where({ id }).update({ pto_payout_week_start: W1 });
      await worked(id, W1);
      // The gate is off when week 1 is made final on a later pay date: a plain check, and no payout kept.
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const created = await draft(W1, { payDate: '2026-10-09' });
      expect((await finalize(created.body.run.id)).status).toBe(200);
      process.env.GATE_PAYROLL_TIME_OFF = 'true';
      // In the bank's order (the pay date) week 2's check is EARLIER than this run. Only the order of the pay
      // weeks shows that a void would make the payout live under a check of a later week.
      const held = await api('POST', `/runs/${created.body.run.id}/void`, { body: { reason: 'Redo' } });
      expect([held.status, held.body.error]).toEqual([409, LATER_FINAL]);
    });

    it('holds a paycheck of a later week while the payout set for an earlier week is not final', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo', { hours: '80' });
      await fullWeek(id, W1);
      // The payout is set for week 2, whose pay run is not made yet. Week 3 comes up for payment first. Final now,
      // Alpha's week 3 check would stand after the payout's week, and the payout could never be made final.
      expect((await payOut(id, W2)).status).toBe(200);
      await worked(id, W2);
      await worked(id, W3);
      await worked(other, W3);
      const waitsFor = [{ technicianId: id, name: 'Sample Alpha', reason: PAYOUT_FIRST(W2) }];
      const third = (await draft(W3)).body.run;
      expect([third.checks.map((c) => c.name), third.blocked]).toEqual([['Sample Bravo'], waitsFor]);
      const stopped = await finalize(third.id);
      expect(stopped.status).toBe(409);
      expect(stopped.body.error).toContain(`Sample Alpha: ${PAYOUT_FIRST(W2)}`);
      // The question, by week: a payout set for an earlier week, never the payout's own week or a week before it.
      const techs = await bank.bankTechnicians(trx, [id, other]);
      const open = async (weekStart) => [...await bank.payoutsNotFinal(trx, techs, weekStart)];
      expect([await open(W1), await open(W2), await open(W3), await open(W4)]).toEqual([[], [], [[id, W2]], [[id, W2]]]);
      // A draft of week 2 decides nothing, and a voided run neither: only a final run pays the bank out.
      const tried = (await draft(W2)).body.run;
      expect(await open(W3)).toEqual([[id, W2]]);
      expect((await api('POST', `/runs/${tried.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect((await api('GET', `/runs/${third.id}`)).body.run.blocked).toEqual(waitsFor);
      // Week 2 is made final and pays the bank out. Week 3 then starts a new bank.
      const second = await draftAndFinalize(W2);
      expect(byName(second, 'Sample Alpha').timeOffBank).toMatchObject({ paidOutHours: '3.08', balanceHours: '0.00' });
      expect(await open(W3)).toEqual([]);
      expect((await api('GET', `/runs/${third.id}`)).body.run.blocked).toEqual([]);
      const changed = await finalize(third.id);
      expect([changed.status, changed.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      const done = (await finalize(third.id)).body.run;
      expect(byName(done, 'Sample Alpha').timeOffBank).toMatchObject({ earnedHours: '1.54', balanceHours: '1.54' });
    });

    it('holds a later week of time off alone too, and lets it go when the owner moves the payout or takes it back', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W1);
      expect((await payOut(id, W2)).status).toBe(200);
      // Week 3 holds one hour off of Alpha and nothing else. Week 2 holds only the payout, and has no pay run.
      await offDay(id, addDays(W3, 1), 1);
      const third = (await draft(W3)).body.run;
      expect([third.checks, third.blocked]).toEqual([[], [{ technicianId: id, name: 'Sample Alpha', reason: PAYOUT_FIRST(W2) }]]);
      expect(third).not.toHaveProperty('unpaidTimeOff');
      // Moved to week 3: this run pays the hour from the bank and pays the rest out. Week 2 holds nothing to pay.
      expect((await payOut(id, W3)).status).toBe(200);
      const moved = (await api('POST', `/runs/${third.id}/recompute`)).body.run;
      expect(moved.blocked).toEqual([]);
      expect(byName(moved, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '1.00', balanceHours: '0.00' });
      expect(moved.bankPayouts.map((row) => row.name)).toEqual(['Sample Alpha']);
      // Taken back: an ordinary check, and the bank keeps the rest.
      expect((await payOut(id, null)).status).toBe(200);
      const plain = (await api('POST', `/runs/${third.id}/recompute`)).body.run;
      expect(plain.blocked).toEqual([]);
      expect(byName(plain, 'Sample Alpha').timeOffBank).toMatchObject({ usedHours: '1.00' });
      expect(byName(plain, 'Sample Alpha').timeOffBank).not.toHaveProperty('paidOutHours');
      expect(plain).not.toHaveProperty('bankPayouts');
    });

    it('reads a paid payout by the id as the row spells it when the address has the id in capitals', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      expect((await payOut(id, W2)).status).toBe(200);
      await fullWeek(id, W2);
      const CAPS = id.toUpperCase();
      expect(CAPS).not.toBe(id);
      const put = (weekStart) => api('PUT', `/technicians/${CAPS}/pto-payout-week`, { body: { weekStart, shownWeekStart: W2, shownState: 'paid' }, email: OWNER });
      // The pay run kept the payout under the id in small letters. It reads as paid, not as missed: the take-back
      // is refused for that reason, and the yearly hours can be cleared.
      const paid = await put(null);
      expect([paid.status, paid.body.error]).toEqual([409, 'That bank payout is paid: its pay run is final. Void that pay run to change it.']);
      const hours = (hoursPerYear) => api('PUT', `/technicians/${CAPS}/pto-allowance`, { body: { hoursPerYear } });
      expect((await hours(null)).status).toBe(200);
      expect((await hours(80)).status).toBe(200);
      // A change answers, and is logged, with the id as the row spells it.
      const moved = await put(W3);
      expect([moved.status, moved.body.technician]).toEqual([200, { id, ptoPayoutWeekStart: W3 }]);
      const logged = await trx('audit_log').where({ action: 'payroll.pto_payout_week_changed' }).select('resource_id', 'metadata');
      expect(logged.map((row) => [row.resource_id, row.metadata.technician_id])).toEqual([[id, id], [id, id]]);
    });

    it('makes a draft stale when a payout of an empty bank is set after it: no paycheck changes, the decision the run keeps does', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      await worked(other, W2);
      const created = (await draft(W2)).body.run;
      expect(created).not.toHaveProperty('bankPayouts');
      expect((await payOut(id, W2)).status).toBe(200);
      const old = await api('POST', `/runs/${created.id}/finalize`, { body: { token: created.token } });
      expect([old.status, old.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      const fresh = (await api('GET', `/runs/${created.id}`)).body.run;
      expect([fresh.stale, fresh.bankPayouts]).toEqual([false, [{ technicianId: id, name: 'Sample Alpha', hours: '0.00' }]]);
      expect((await api('POST', `/runs/${created.id}/finalize`, { body: { token: fresh.token } })).status).toBe(200);
    });

    it('decides no payout for a technician with no paycheck worked out: one who waits for approval, one who is blocked', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const other = await tech('Sample Bravo');
      const noRate = await tech('Sample Charlie', { hours: '80', pay_rate: null });
      await fullWeek(id, W1);
      expect((await payOut(id, W2)).status).toBe(200);
      expect((await payOut(noRate, W2)).status).toBe(200);
      await worked(other, W2);
      // Charlie has approved hours and no pay rate: the bank step reads the row, and no paycheck comes of it.
      await worked(noRate, W2);
      // Alpha worked in week 2 and the timesheet is not approved: no paycheck is worked out, so no payout either.
      await trx('time_entry_daily_summary').insert({ technician_id: id, work_date: addDays(W2, 1), total_shift_minutes: 480, unpaid_meal_minutes: 0 });
      const shown = (await draft(W2)).body.run;
      expect(shown.waiting.map((row) => row.name)).toEqual(['Sample Alpha']);
      expect(shown.blocked.map((row) => [row.name, row.reason])).toEqual([['Sample Charlie', 'No pay rate set']]);
      expect(shown).not.toHaveProperty('bankPayouts');
    });

    it('says a payout was missed when the week was finalized with the gate off, and the owner takes it back', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      await fullWeek(id, W1);
      expect((await payOut(id, W2)).status).toBe(200);
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const run = await fullWeek(id, W2);
      expect(byName(run, 'Sample Alpha')).not.toHaveProperty('timeOffBank');
      process.env.GATE_PAYROLL_TIME_OFF = 'true';
      // That run is final and paid no bank out: the hours are still in the bank, and the instruction is not "final".
      expect((await balanceOf(id)).bank).toMatchObject({ balanceHours: '1.54', payout: { weekStart: W2, final: false, missed: true } });
      expect((await payOut(id, null)).status).toBe(200);
      expect((await balanceOf(id)).bank.payout).toBeNull();
    });

    it('lists an employee who has left and still has a bank setting only for the time-off panel', async () => {
      const left = await tech('Sample Alpha', { hours: '80', employment_status: 'inactive' });
      const leftNoBank = await tech('Sample Bravo', { employment_status: 'inactive' });
      const here = await tech('Sample Charlie', { hours: '80' });
      const idsOf = async (path) => (await api('GET', path)).body.technicians.map((row) => row.id).filter((rowId) => [left, leftNoBank, here].includes(rowId));
      expect(await idsOf('/technicians')).toEqual([here]);
      expect(await idsOf('/technicians?formerBank=1')).toEqual([left, here]);
      expect((await api('GET', '/technicians?formerBank=1')).body.technicians.find((row) => row.id === left)).toMatchObject({ employmentStatus: 'inactive', ptoHoursPerYear: 80 });
      // The bank of an employee who has left is still paid out.
      expect((await payOut(left, W2)).status).toBe(200);
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      expect(await idsOf('/technicians?formerBank=1')).toEqual([here]);
    });

    // A run that holds a bank check under a later payout run cannot be made with real runs: the payout run would hold
    // a check too, and the check guards answer first. The guard's answer is set instead.
    it('refuses to void a run under a later final run that paid out the bank of its technician', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const plain = await tech('Sample Bravo');
      await worked(plain, W1);
      const run = await fullWeek(id, W1);
      const later = jest.spyOn(bank, 'laterPayoutDecisionExists');
      try {
        later.mockResolvedValueOnce(true);
        const voided = await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } });
        expect([voided.status, voided.body.error]).toEqual([409, 'A later pay run is already final. Void it first.']);
        // Asked about every technician with a check here, as finalize asks: a plain check too.
        expect([...later.mock.calls[0][2]].sort()).toEqual([id, plain].sort());
        expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      } finally {
        later.mockRestore();
      }
    });

    it('takes a pay week only, for a W-2 employee with a bank, and writes each change to the audit log', async () => {
      const id = await tech('Sample Alpha', { hours: '80' });
      const noBank = await tech('Sample Bravo');
      const contractor = await tech('Sample Charlie', { hours: '80', employment_type: '1099' });
      for (const who of [noBank, contractor]) {
        const answer = await payOut(who, W2);
        expect([answer.status, answer.body.error]).toEqual([409, 'This employee has no time-off bank.']);
      }
      expect((await payOut(randomUUID(), W2)).status).toBe(404);
      // Any other admin login is refused, to set it and to take it back; a login with no email too.
      for (const email of ['office@example.test', undefined]) {
        for (const weekStart of [W2, null]) {
          const answer = await api('PUT', `/technicians/${id}/pto-payout-week`, { body: { weekStart }, email });
          expect([answer.status, answer.body.error]).toEqual([403, 'This action is limited to the owner account.']);
        }
      }
      const PICK = 'Pick the first day of a pay week (YYYY-MM-DD)';
      for (const weekStart of [addDays(W2, 1), '2026-02-31', 'next week', 20260921]) {
        const answer = await payOut(id, weekStart);
        expect([answer.status, answer.body.error]).toEqual([400, PICK]);
      }
      const none = await api('PUT', `/technicians/${id}/pto-payout-week`, { body: {}, email: OWNER });
      expect([none.status, none.body.error]).toEqual([400, PICK]);
      expect((await trx('technicians').where({ id }).first('pto_payout_week_start')).pto_payout_week_start).toBeNull();
      // The column takes a Monday only, also from a writer that is not this route.
      const midweek = await refused(() => trx('technicians').where({ id }).update({ pto_payout_week_start: addDays(W2, 1) }));
      expect(midweek && midweek.message).toMatch(/technicians_pto_payout_week_monday_check/);
      expect((await payOut(id, W2)).status).toBe(200);
      expect((await payOut(id, '')).status).toBe(200);
      const logged = await trx('audit_log').where({ action: 'payroll.pto_payout_week_changed' }).orderBy('created_at').select('actor_id', 'resource_id', 'metadata');
      expect(logged.map((row) => [row.actor_id, row.resource_id, row.metadata])).toEqual([
        [ADMIN_ID, id, { technician_id: id, week_start: W2 }],
        [ADMIN_ID, id, { technician_id: id, week_start: null }],
      ]);
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const off = await payOut(id, W2);
      expect([off.status, off.body]).toEqual([404, { enabled: false }]);
    });

    it('refuses to roll the payout columns back while a payout week is set or a run keeps a payout', async () => {
      const migration = require('../models/migrations/20261121120500_payroll_bank_payout');
      const id = await tech('Sample Alpha', { hours: '80' });
      await payOut(id, W2);
      const set = await refused(() => migration.down(trx));
      expect(set && set.message).toMatch(/holds a time-off bank payout week/);
      // The payout run is final and the instruction is gone (moved to another week, then taken back): the run
      // still keeps its record.
      await fullWeek(id, W2);
      await payOut(id, W3);
      await payOut(id, null);
      expect(await payoutWeekOf(id)).toBeNull();
      const kept = await refused(() => migration.down(trx));
      expect(kept && kept.message).toMatch(/payroll_runs holds time-off bank payouts/);
      // The tables are locked before the first check, so nothing can commit between a check and the DROP.
      const statements = [];
      const spy = { raw: (sql) => { statements.push(sql); throw new Error('stop'); } };
      await expect(migration.down(spy)).rejects.toThrow('stop');
      expect(statements).toEqual(['LOCK TABLE technicians, payroll_runs IN ACCESS EXCLUSIVE MODE']);
    });

    it('rolls the payout columns back when nothing holds a payout', async () => {
      const migration = require('../models/migrations/20261121120500_payroll_bank_payout');
      await trx.raw('SAVEPOINT rollback_check');
      await migration.down(trx);
      expect([await trx.schema.hasColumn('technicians', 'pto_payout_week_start'), await trx.schema.hasColumn('payroll_runs', 'bank_payouts')]).toEqual([false, false]);
      await trx.raw('ROLLBACK TO SAVEPOINT rollback_check');
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
