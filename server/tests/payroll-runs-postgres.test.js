// Real PostgreSQL transactions (rolled back): pay runs from approved timesheets,
// the blocked and waiting lists, finalize rules and the review token, void and
// re-draft, the finalized-check trigger, year-to-date across runs, the stub, the
// timesheet unlock guard, and the admin routes (gate off writes nothing).
// All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
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
const { parseETDateTime } = require('../utils/datetime-et');
const timeTracking = require('../services/time-tracking');
const approval = require('../services/timesheet-approval');
const router = require('../routes/admin-payroll');
const payrollRuns = require('../services/payroll-runs');

jest.setTimeout(60000);

// Finished staff weeks in 2026 (Monday dates). Pay dates default to the Friday after.
const W1 = '2026-09-14'; // pay Fri 2026-09-25
const W2 = '2026-09-21'; // pay Fri 2026-10-02
const W3 = '2026-09-28'; // pay Fri 2026-10-09

postgres('payroll pay runs', () => {
  let database;
  let holderDb;
  let callerDb;
  let trx;
  let server;
  let baseUrl;
  const OLD_GATE = process.env.GATE_PAYROLL;
  const OLD_LUNCH = process.env.GATE_AUTO_LUNCH;
  const OLD_SHIFT_CLOSE = process.env.GATE_SHIFT_CLOSE_REVIEW;
  const ADMIN_ID = randomUUID();

  const technician = async (patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name: 'Sample Employee', employment_type: 'w2', employment_status: 'active', pay_rate: '22.00', ...patch,
    });
    return id;
  };
  const w4For = (technicianId, patch = {}) => trx('payroll_w4_elections').insert({
    technician_id: technicianId, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02', ...patch,
  });
  // A W-2 technician with a W-4 on file and a pay rate: ready to be paid.
  const readyTech = async (name, patch = {}) => {
    const id = await technician({ name, ...patch });
    await w4For(id);
    return id;
  };
  const approvedWeek = (technicianId, weekStart, regular = '2400.00', overtime = '0.00') => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: regular, overtime_minutes: overtime,
  });
  const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const workedDay = (technicianId, workDate) => trx('time_entry_daily_summary').insert({
    technician_id: technicianId, work_date: workDate, total_shift_minutes: 480,
  });
  const refused = async (work) => {
    await trx.raw('SAVEPOINT attempt');
    let error;
    try { await work(); } catch (err) { error = err; }
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    return error;
  };
  const api = async (method, path, { body, role, admin = ADMIN_ID, raw = false } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': admin, ...(role ? { 'x-test-role': role } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: response.status, headers: response.headers, text: await response.text() };
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const draft = async (weekStart, body = {}) => api('POST', '/runs', { body: { weekStart, ...body } });
  const finalize = async (runId) => {
    const shown = await api('GET', `/runs/${runId}`);
    return api('POST', `/runs/${runId}/finalize`, { body: { token: shown.body.run.token } });
  };
  const draftAndFinalize = async (weekStart, body) => {
    const created = await draft(weekStart, body);
    expect(created.status).toBe(201);
    const done = await finalize(created.body.run.id);
    expect(done.status).toBe(200);
    return done.body.run;
  };
  const count = async (table) => Number((await trx(table).count('* as n').first()).n);
  const byName = (run, name) => run.checks.find((c) => c.name === name);

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    // Two more real connections for the lock tests: one holds the lock, one calls the service.
    holderDb = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    callerDb = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/payroll', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/payroll`;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_PAYROLL = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_PAYROLL; else process.env.GATE_PAYROLL = OLD_GATE;
    if (OLD_LUNCH === undefined) delete process.env.GATE_AUTO_LUNCH; else process.env.GATE_AUTO_LUNCH = OLD_LUNCH;
    if (OLD_SHIFT_CLOSE === undefined) delete process.env.GATE_SHIFT_CLOSE_REVIEW; else process.env.GATE_SHIFT_CLOSE_REVIEW = OLD_SHIFT_CLOSE;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
    if (holderDb) await holderDb.destroy();
    if (callerDb) await callerDb.destroy();
  });

  describe('drafting a run', () => {
    it('reads the 4x10 week with auto lunch as 40 regular hours and pays it', async () => {
      process.env.GATE_AUTO_LUNCH = 'true';
      const id = await readyTech('Sample Alpha');
      // Mon..Thu, 07:30 to 18:00 ET: 10.5 hours on the clock, 30 minutes of it unpaid lunch.
      for (let i = 0; i < 4; i += 1) {
        const day = addDays(W1, i);
        await trx('time_entries').insert({
          id: randomUUID(), technician_id: id, entry_type: 'shift', status: 'completed',
          clock_in: parseETDateTime(`${day}T07:30`), clock_out: parseETDateTime(`${day}T18:00`), duration_minutes: 630,
        });
      }
      for (let i = 0; i < 7; i += 1) await timeTracking.computeDailySummary(id, addDays(W1, i));
      await timeTracking.computeWeeklySummary(id, W1);
      await trx('time_weekly_summary').where({ technician_id: id, week_start: W1 }).update({ status: 'approved' });

      const created = await draft(W1);
      expect(created.status).toBe(201);
      const check = byName(created.body.run, 'Sample Alpha');
      expect(check).toMatchObject({ regularHours: '40.00', overtimeHours: '0.00', grossCents: 88000, status: 'draft' });
      expect(created.body.run.payDate).toBe('2026-09-25');
    });

    it('drafts from an approved week with every figure from the calculator and a snapshot', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '2400.00', '120.00');
      const created = await draft(W1);
      expect(created.status).toBe(201);
      const { run } = created.body;
      expect(run).toMatchObject({ weekStart: W1, weekEnd: '2026-09-20', payDate: '2026-09-25', status: 'draft', blocked: [], waiting: [], stale: false });
      const check = byName(run, 'Sample Alpha');
      expect(check).toMatchObject({
        regularHours: '40.00', overtimeHours: '2.00', hourlyRate: '22.00', regularPayCents: 88000, overtimePayCents: 6600,
        grossCents: 94600, socialSecurityCents: 5865, medicareCents: 1372, payMethod: 'check', ytdGrossBeforeCents: 0,
      });
      expect(check.netCents).toBe(94600 - check.federalIncomeTaxCents - 5865 - 1372);
      expect(run.totals).toEqual({
        checkCount: 1, grossCents: 94600, employeeTaxesCents: check.federalIncomeTaxCents + 5865 + 1372,
        netCents: check.netCents, employerTaxesCents: 5865 + 1372 + 568 + 2554,
      });
      const row = await trx('payroll_checks').where({ id: check.id }).first();
      expect(row.calc_snapshot.withholdingWorksheet).toBeTruthy();
      expect(row.employee_name).toBe('Sample Alpha');
      const w4 = await trx('payroll_w4_elections').where({ technician_id: id }).first('id');
      expect(row.w4_election_id).toBe(w4.id);
      const audit = await trx('audit_log').where({ action: 'payroll.run_drafted', resource_id: run.id }).first();
      expect(audit.metadata).toEqual({ run_id: run.id });
    });

    it('takes a typed pay date, and leaves out contractors and approved weeks with no hours', async () => {
      const id = await readyTech('Sample Alpha');
      const contractor = await readyTech('Sample Contractor', { employment_type: '1099' });
      const idle = await readyTech('Sample Idle');
      const former = await readyTech('Sample Former', { employment_status: 'inactive' });
      await approvedWeek(id, W1);
      await approvedWeek(contractor, W1);
      await approvedWeek(idle, W1, '0.00', '0.00');
      await approvedWeek(former, W1, '600.00');
      const created = await draft(W1, { payDate: '2026-09-28' });
      expect(created.body.run.payDate).toBe('2026-09-28');
      expect(created.body.run.checks.map((c) => c.name).sort()).toEqual(['Sample Alpha', 'Sample Former']);
    });

    it('lists a technician with time but no approved week as waiting', async () => {
      const ready = await readyTech('Sample Alpha');
      const pending = await readyTech('Sample Pending');
      const unsummarized = await readyTech('Sample Unsummarized');
      await approvedWeek(ready, W1);
      await workedDay(pending, addDays(W1, 1));
      await trx('time_weekly_summary').insert({ technician_id: pending, week_start: W1, week_end: addDays(W1, 6), status: 'pending', regular_minutes: 480 });
      await trx('time_entries').insert({
        id: randomUUID(), technician_id: unsummarized, entry_type: 'shift', status: 'completed',
        clock_in: parseETDateTime(`${addDays(W1, 2)}T08:00`), clock_out: parseETDateTime(`${addDays(W1, 2)}T16:00`), duration_minutes: 480,
      });
      const { run } = (await draft(W1)).body;
      expect(run.checks.map((c) => c.name)).toEqual(['Sample Alpha']);
      expect(run.waiting.map((w) => w.name).sort()).toEqual(['Sample Pending', 'Sample Unsummarized']);
      expect(run.waiting[0].reason).toMatch(/not approved/);
    });

    it('lists blocked technicians with the reason and gives them no check', async () => {
      const ok = await readyTech('Sample Alpha');
      const noW4 = await technician({ name: 'Sample NoW4' });
      const noRate = await technician({ name: 'Sample NoRate', pay_rate: null });
      await w4For(noRate);
      await approvedWeek(ok, W1);
      await approvedWeek(noW4, W1);
      await approvedWeek(noRate, W1);
      const { run } = (await draft(W1)).body;
      expect(run.checks.map((c) => c.name)).toEqual(['Sample Alpha']);
      expect(Object.fromEntries(run.blocked.map((b) => [b.name, b.reason]))).toEqual({
        'Sample NoW4': 'No Form W-4 on file',
        'Sample NoRate': 'No pay rate set',
      });
      expect(await count('payroll_checks')).toBe(1);
    });

    it('holds a technician whose week has an unreviewed automatic clock-out, only while GATE_SHIFT_CLOSE_REVIEW is on', async () => {
      const flagged = await readyTech('Sample Alpha');
      const clean = await readyTech('Sample Beta');
      await approvedWeek(flagged, W1);
      await approvedWeek(clean, W1);
      const day = addDays(W1, 1);
      const shiftId = randomUUID();
      await trx('time_entries').insert({
        id: shiftId, technician_id: flagged, entry_type: 'shift', status: 'completed',
        clock_in: parseETDateTime(`${day}T07:30`), clock_out: parseETDateTime(`${day}T17:00`), duration_minutes: 570,
        auto_closed_at: parseETDateTime(`${day}T23:00`), auto_close_reason: 'cron_11pm',
      });

      // Gate off: the flag is ignored, both are paid as before.
      delete process.env.GATE_SHIFT_CLOSE_REVIEW;
      const created = (await draft(W1)).body.run;
      expect(created.checks.map((c) => c.name)).toEqual(['Sample Alpha', 'Sample Beta']);
      expect(created.blocked).toEqual([]);

      // Gate on: the draft shows the technician as blocked, finalize is refused.
      process.env.GATE_SHIFT_CLOSE_REVIEW = 'true';
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      expect(shown.blocked).toEqual([{ technicianId: flagged, name: 'Sample Alpha', reason: 'An automatic clock-out needs a real time' }]);
      await api('POST', `/runs/${created.id}/recompute`);
      const held = (await api('GET', `/runs/${created.id}`)).body.run;
      expect(held.checks.map((c) => c.name)).toEqual(['Sample Beta']);
      const refusal = await api('POST', `/runs/${created.id}/finalize`, { body: { token: held.token } });
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toMatch(/Sample Alpha: An automatic clock-out needs a real time/);

      // An admin confirms it: the line is paid and the run finalizes.
      await trx('time_entries').where({ id: shiftId }).update({ auto_close_reviewed_at: new Date(), auto_close_reviewed_by: ADMIN_ID });
      await api('POST', `/runs/${created.id}/recompute`);
      const released = (await api('GET', `/runs/${created.id}`)).body.run;
      expect(released.blocked).toEqual([]);
      expect(released.checks.map((c) => c.name)).toEqual(['Sample Alpha', 'Sample Beta']);
      expect((await finalize(created.id)).status).toBe(200);
    });

    it('blocks everyone when the pay date is in a year with no tables', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const { run } = (await draft(W1, { payDate: '2027-01-08' })).body;
      expect(run.checks).toEqual([]);
      expect(run.blocked).toEqual([{ technicianId: id, name: 'Sample Alpha', reason: 'No federal withholding tables for 2027 yet' }]);
    });

    it('uses the W-4 in force on the pay date', async () => {
      const id = await technician({ name: 'Sample Alpha' });
      await w4For(id, { filing_status: 'single', effective_on: '2026-01-02' });
      await w4For(id, { filing_status: 'married_jointly', effective_on: '2026-09-26', signed_on: '2026-09-20' });
      await approvedWeek(id, W1);
      const early = (await draft(W1, { payDate: '2026-09-25' })).body.run;
      const marriedId = (await trx('payroll_w4_elections').where({ technician_id: id, filing_status: 'married_jointly' }).first('id')).id;
      const singleId = (await trx('payroll_w4_elections').where({ technician_id: id, filing_status: 'single' }).first('id')).id;
      expect((await trx('payroll_checks').where({ id: early.checks[0].id }).first()).w4_election_id).toBe(singleId);
      await api('POST', `/runs/${early.id}/void`, { body: { reason: 'Pay date moved' } });
      const late = (await draft(W1, { payDate: '2026-09-28' })).body.run;
      expect((await trx('payroll_checks').where({ id: late.checks[0].id }).first()).w4_election_id).toBe(marriedId);
    });

    it('refuses a week that is not finished, not a Monday, or has no hours, and writes nothing', async () => {
      expect((await draft('2099-01-05')).status).toBe(409);
      expect((await draft('2026-09-15')).status).toBe(400);
      expect((await draft(W1)).body.error).toBe('No W-2 hours to pay for that week.');
      expect(await count('payroll_runs')).toBe(0);
    });

    it('allows one live run per week', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      expect((await draft(W1)).status).toBe(201);
      const again = await draft(W1);
      expect(again.status).toBe(409);
      expect(again.body.error).toMatch(/already has a pay run/);
      expect(await count('payroll_runs')).toBe(1);
    });
  });

  describe('recompute', () => {
    it('replaces the draft checks from current data, and shows a stale draft first', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const first = (await draft(W1)).body.run;
      await trx('technicians').where({ id }).update({ pay_rate: '25.00' });
      const stale = (await api('GET', `/runs/${first.id}`)).body.run;
      expect(stale.stale).toBe(true);
      expect(stale.checks[0].hourlyRate).toBe('22.00');
      const fresh = await api('POST', `/runs/${first.id}/recompute`);
      expect(fresh.status).toBe(200);
      expect(fresh.body.run.checks[0]).toMatchObject({ hourlyRate: '25.00', grossCents: 100000 });
      expect(fresh.body.run.stale).toBe(false);
      expect(await count('payroll_checks')).toBe(1);
    });

    it('refuses a finalized run', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const run = await draftAndFinalize(W1);
      expect((await api('POST', `/runs/${run.id}/recompute`)).status).toBe(409);
    });
  });

  describe('finalize', () => {
    it('is refused while a technician is blocked or waiting, and changes nothing', async () => {
      const ok = await readyTech('Sample Alpha');
      const noW4 = await technician({ name: 'Sample NoW4' });
      const waiting = await readyTech('Sample Waiting');
      await approvedWeek(ok, W1);
      await approvedWeek(noW4, W1);
      await workedDay(waiting, addDays(W1, 0));
      const { run } = (await draft(W1)).body;
      const refusal = await api('POST', `/runs/${run.id}/finalize`, { body: { token: run.token } });
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toMatch(/Sample Waiting: Timesheet for this week is not approved yet/);
      expect(refusal.body.error).toMatch(/Sample NoW4: No Form W-4 on file/);
      expect((await trx('payroll_runs').where({ id: run.id }).first()).status).toBe('draft');
      expect(await trx('payroll_checks').where({ run_id: run.id, status: 'finalized' }).count('* as n').first()).toMatchObject({ n: '0' });
      // Fix both problems, and the same run finalizes.
      await w4For(noW4);
      await trx('time_weekly_summary').insert({ technician_id: waiting, week_start: W1, week_end: addDays(W1, 6), status: 'approved', regular_minutes: 480 });
      await trx('time_entry_daily_summary').where({ technician_id: waiting }).del();
      await api('POST', `/runs/${run.id}/recompute`);
      expect((await finalize(run.id)).status).toBe(200);
    });

    it('needs the token of the shown numbers: a stale token gets 409 and the new numbers', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const { run } = (await draft(W1)).body;
      await trx('time_weekly_summary').where({ technician_id: id, week_start: W1 }).update({ regular_minutes: '2460.00' });
      const mismatch = await api('POST', `/runs/${run.id}/finalize`, { body: { token: run.token } });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body.error).toBe('Hours or settings changed. Review the new numbers.');
      const shown = (await api('GET', `/runs/${run.id}`)).body.run;
      expect(shown.status).toBe('draft');
      expect(shown.checks[0].regularHours).toBe('41.00');
      expect(shown.token).not.toBe(run.token);
      expect((await api('POST', `/runs/${run.id}/finalize`, { body: {} })).status).toBe(400);
      const done = await api('POST', `/runs/${run.id}/finalize`, { body: { token: shown.token } });
      expect(done.status).toBe(200);
      expect(done.body.run).toMatchObject({ status: 'finalized', finalizedAt: expect.any(String) });
      expect(done.body.run.checks[0].status).toBe('finalized');
      const audit = await trx('audit_log').where({ action: 'payroll.run_finalized', resource_id: run.id }).first();
      expect(audit.metadata).toEqual({ run_id: run.id });
    });

    it('refuses an empty run and a second finalize', async () => {
      const id = await readyTech('Sample Alpha');
      const noW4 = await technician({ name: 'Sample NoW4' });
      await approvedWeek(noW4, W1);
      const { run: onlyBlocked } = (await draft(W1)).body;
      expect(onlyBlocked.checks).toEqual([]);
      expect((await api('POST', `/runs/${onlyBlocked.id}/finalize`, { body: { token: onlyBlocked.token } })).status).toBe(409);
      await approvedWeek(id, W2);
      const done = await draftAndFinalize(W2);
      expect((await api('POST', `/runs/${done.id}/finalize`, { body: { token: done.token } })).body.error).toBe('This pay run is already finalized.');
    });
  });

  describe('void', () => {
    it('voids a finalized run, frees the week and keeps the evidence', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const run = await draftAndFinalize(W1);
      expect((await api('POST', `/runs/${run.id}/void`, { body: {} })).status).toBe(400);
      const voided = await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Wrong hours' } });
      expect(voided.status).toBe(200);
      expect(voided.body.run).toMatchObject({ status: 'voided', voidReason: 'Wrong hours' });
      expect(voided.body.run.checks[0].status).toBe('voided');
      expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Again' } })).status).toBe(409);
      // A new draft for that week is allowed; the voided check stays.
      const again = await draft(W1);
      expect(again.status).toBe(201);
      expect(await count('payroll_checks')).toBe(2);
      expect(await trx('payroll_checks').where({ status: 'voided' }).count('* as n').first()).toMatchObject({ n: '1' });
      const audit = await trx('audit_log').where({ action: 'payroll.run_voided', resource_id: run.id }).first();
      expect(audit.metadata).toEqual({ run_id: run.id });
      expect(JSON.stringify(audit.metadata)).not.toMatch(/Wrong hours/);
    });

    it('voids a draft', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const { run } = (await draft(W1)).body;
      expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Started by mistake' } })).body.run.status).toBe('voided');
      expect((await draft(W1)).status).toBe(201);
    });
  });

  describe('finalized checks are evidence', () => {
    const finalCheck = async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const run = await draftAndFinalize(W1);
      return { run, check: run.checks[0] };
    };

    it('blocks DELETE of a finalized check and of a finalized run', async () => {
      const { run, check } = await finalCheck();
      expect((await refused(() => trx('payroll_checks').where({ id: check.id }).del())).message).toMatch(/cannot be deleted/);
      expect((await refused(() => trx('payroll_runs').where({ id: run.id }).del())).message).toMatch(/cannot be deleted/);
    });

    it.each([
      ['gross', { gross_cents: 1 }],
      ['the hourly rate', { hourly_rate: '99.00' }],
      ['the calculation snapshot', { calc_snapshot: JSON.stringify({}) }],
      ['the pay method', { pay_method: 'bank_transfer' }],
      ['the week', { week_start: '2026-09-07' }],
      ['back to draft', { status: 'draft' }],
    ])('blocks changing %s', async (_name, patch) => {
      const { check } = await finalCheck();
      const error = await refused(() => trx('payroll_checks').where({ id: check.id }).update(patch));
      expect(error.message).toMatch(/cannot be edited|can only be voided/);
    });

    it('lets a finalized check take a check number and be voided, nothing else', async () => {
      const { check } = await finalCheck();
      await trx('payroll_checks').where({ id: check.id }).update({ check_number: '1001' });
      expect((await trx('payroll_checks').where({ id: check.id }).first()).check_number).toBe('1001');
      expect((await refused(() => trx('payroll_checks').where({ id: check.id }).update({ status: 'voided', check_number: '1002' }))).message).toMatch(/cannot be edited/);
      await trx('payroll_checks').where({ id: check.id }).update({ status: 'voided' });
      expect((await refused(() => trx('payroll_checks').where({ id: check.id }).update({ check_number: '1003' }))).message).toMatch(/voided paycheck cannot be changed/);
      expect((await refused(() => trx('payroll_checks').where({ id: check.id }).del())).message).toMatch(/cannot be deleted/);
    });

    it('lets a finalized run only be voided', async () => {
      const { run } = await finalCheck();
      expect((await refused(() => trx('payroll_runs').where({ id: run.id }).update({ pay_date: '2026-10-30' }))).message).toMatch(/can only be voided/);
      expect((await refused(() => trx('payroll_runs').where({ id: run.id }).update({ status: 'draft' }))).message).toMatch(/can only be voided/);
    });

    it('lets a draft run and its draft checks be deleted', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const { run } = (await draft(W1)).body;
      await trx('payroll_runs').where({ id: run.id }).del();
      expect(await count('payroll_checks')).toBe(0);
    });

    it('holds the table rules', async () => {
      const { run, check } = await finalCheck();
      const row = await trx('payroll_checks').where({ id: check.id }).first();
      const { id: _id, ...copy } = row;
      const again = { ...copy, calc_snapshot: JSON.stringify(copy.calc_snapshot), run_id: run.id };
      // One live check per technician and week, even in a second draft run.
      expect((await refused(() => trx('payroll_checks').insert(again))).message).toMatch(/payroll_checks_one_live_week/);
      expect(await refused(() => trx('payroll_runs').insert({ week_start: '2026-09-15', pay_date: '2026-09-25' }))).toBeTruthy();
      expect(await refused(() => trx('payroll_runs').insert({ week_start: '2026-09-07', pay_date: '2026-09-13' }))).toBeTruthy();
      expect(await refused(() => trx('payroll_runs').insert({ week_start: '2026-09-07', pay_date: '2026-09-18', status: 'paid' }))).toBeTruthy();
      expect(await refused(() => trx('payroll_runs').insert({ week_start: '2026-09-07', pay_date: '2026-09-18', void_reason: 'x'.repeat(501) }))).toBeTruthy();
      expect(await refused(() => trx('payroll_checks').where({ id: check.id }).update({ check_number: 'x'.repeat(31) }))).toBeTruthy();
      expect(await refused(() => trx('technicians').where({ id: row.technician_id }).del())).toBeTruthy();
    });
  });

  describe('year to date', () => {
    it('carries gross across two finalized runs into the next check and the stub', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await approvedWeek(id, W2);
      const first = await draftAndFinalize(W1);
      const secondDraft = (await draft(W2)).body.run;
      expect(secondDraft.checks[0].ytdGrossBeforeCents).toBe(88000);
      const second = (await finalize(secondDraft.id)).body.run;
      const firstStub = (await api('GET', `/checks/${first.checks[0].id}/stub`)).body.stub;
      const secondStub = (await api('GET', `/checks/${second.checks[0].id}/stub`)).body.stub;
      expect(firstStub.ytd).toMatchObject({ grossCents: 88000, netCents: first.checks[0].netCents });
      expect(secondStub.ytd).toEqual({
        grossCents: 176000,
        federalIncomeTaxCents: first.checks[0].federalIncomeTaxCents + second.checks[0].federalIncomeTaxCents,
        socialSecurityCents: 2 * 5456,
        medicareCents: 2 * 1276,
        additionalMedicareCents: 0,
        netCents: first.checks[0].netCents + second.checks[0].netCents,
      });
    });

    it('does not count a draft or a voided run, and stops FUTA once the year total passes $7,000', async () => {
      const id = await readyTech('Sample Alpha');
      for (const week of [W1, W2, W3]) await approvedWeek(id, week);
      const voided = await draftAndFinalize(W1);
      await api('POST', `/runs/${voided.id}/void`, { body: { reason: 'Redo' } });
      await draft(W2); // stays a draft
      const third = (await draft(W3)).body.run;
      expect(third.checks[0].ytdGrossBeforeCents).toBe(0);
      // Nine finalized weeks of $880: the 8th check reaches the $7,000 base, the 9th owes no FUTA.
      const beta = await readyTech('Sample Beta');
      const weeks = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];
      for (const week of weeks) await approvedWeek(beta, week);
      const runs = [];
      for (const week of weeks) runs.push(await draftAndFinalize(week));
      const snapshotOf = async (run) => (await trx('payroll_checks').where({ id: byName(run, 'Sample Beta').id }).first()).calc_snapshot;
      expect(byName(runs[7], 'Sample Beta').ytdGrossBeforeCents).toBe(7 * 88000);
      expect((await snapshotOf(runs[7])).futaCents).toBe(504);
      expect(byName(runs[8], 'Sample Beta').ytdGrossBeforeCents).toBe(8 * 88000);
      expect((await snapshotOf(runs[8])).futaCents).toBe(0);
    });

    it('refuses to finalize or void a run while a later final run exists', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await approvedWeek(id, W2);
      const earlier = (await draft(W1)).body.run;
      const later = await draftAndFinalize(W2);
      const blocked = await api('POST', `/runs/${earlier.id}/finalize`, { body: { token: earlier.token } });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/later pay run is already final/);
      // Void the later run, finalize in order, and voiding the earlier one is then refused again.
      await api('POST', `/runs/${later.id}/void`, { body: { reason: 'Order' } });
      expect((await finalize(earlier.id)).status).toBe(200);
      const redo = await draftAndFinalize(W2);
      const voidEarlier = await api('POST', `/runs/${earlier.id}/void`, { body: { reason: 'Late fix' } });
      expect(voidEarlier.status).toBe(409);
      expect(redo.status).toBe('finalized');
    });
  });

  describe('check number', () => {
    it('is set on a finalized paper check only', async () => {
      const paper = await readyTech('Sample Alpha');
      const bank = await readyTech('Sample Beta');
      await trx('technicians').where({ id: bank }).update({ pay_method: 'bank_transfer', pay_method_consent_on: '2026-09-01' });
      await approvedWeek(paper, W1);
      await approvedWeek(bank, W1);
      const created = (await draft(W1)).body.run;
      const draftCheck = byName(created, 'Sample Alpha');
      expect((await api('PUT', `/checks/${draftCheck.id}/check-number`, { body: { checkNumber: '1001' } })).status).toBe(409);
      const run = (await finalize(created.id)).body.run;
      const paperCheck = byName(run, 'Sample Alpha');
      const bankCheck = byName(run, 'Sample Beta');
      expect(bankCheck.payMethod).toBe('bank_transfer');
      const set = await api('PUT', `/checks/${paperCheck.id}/check-number`, { body: { checkNumber: ' 1001 ' } });
      expect(set).toMatchObject({ status: 200, body: { check: { id: paperCheck.id, checkNumber: '1001' } } });
      expect((await api('PUT', `/checks/${paperCheck.id}/check-number`, { body: { checkNumber: '1002' } })).body.check.checkNumber).toBe('1002');
      expect((await api('PUT', `/checks/${bankCheck.id}/check-number`, { body: { checkNumber: '1003' } })).status).toBe(409);
      expect((await api('PUT', `/checks/${paperCheck.id}/check-number`, { body: { checkNumber: 'x'.repeat(31) } })).status).toBe(400);
      expect((await api('PUT', `/checks/${paperCheck.id}/check-number`, { body: {} })).status).toBe(400);
      expect((await api('PUT', `/checks/${randomUUID()}/check-number`, { body: { checkNumber: '1' } })).status).toBe(404);
      const audit = await trx('audit_log').where({ action: 'payroll.check_number_set', resource_id: paperCheck.id });
      expect(audit).toHaveLength(2);
      expect(audit[0].metadata).toEqual({ check_id: paperCheck.id, run_id: run.id });
      await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } });
      expect((await api('PUT', `/checks/${paperCheck.id}/check-number`, { body: { checkNumber: '1004' } })).status).toBe(409);
    });
  });

  describe('stub', () => {
    it('shows the employee view with the SSN last 4 only, and no employer taxes', async () => {
      const id = await readyTech('Sample Alpha', { ssn_last4: '4321' });
      const plain = await readyTech('Sample Beta');
      await approvedWeek(id, W1, '2400.00', '120.00');
      await approvedWeek(plain, W1);
      const run = await draftAndFinalize(W1);
      await api('PUT', `/checks/${byName(run, 'Sample Alpha').id}/check-number`, { body: { checkNumber: '2001' } });
      const stub = (await api('GET', `/checks/${byName(run, 'Sample Alpha').id}/stub`)).body.stub;
      expect(stub).toMatchObject({
        employer: { name: 'Waves Pest Control, LLC', addressLine: '13649 Luxe Ave #110, Bradenton, FL 34211' },
        employee: { name: 'Sample Alpha', ssnLast4: '4321' },
        payPeriod: { start: W1, end: '2026-09-20' },
        payDate: '2026-09-25',
        hours: { regular: '40.00', overtime: '2.00' },
        hourlyRate: '22.00',
        earnings: { regularPayCents: 88000, overtimePayCents: 6600, grossCents: 94600 },
        payMethod: 'check',
        checkNumber: '2001',
      });
      expect(stub.taxes.totalCents).toBe(94600 - stub.netCents);
      expect(stub.ytd.grossCents).toBe(94600);
      expect(JSON.stringify(stub)).not.toMatch(/employer(Social|Medicare)|futa|reemployment/i);
      const other = (await api('GET', `/checks/${byName(run, 'Sample Beta').id}/stub`)).body.stub;
      expect(other.employee.ssnLast4).toBeNull();
      expect(other.employee).toEqual({ name: 'Sample Beta', ssnLast4: null });
    });

    it('refuses a draft, a voided check and an unknown check', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const created = (await draft(W1)).body.run;
      expect((await api('GET', `/checks/${created.checks[0].id}/stub`)).status).toBe(409);
      const done = (await finalize(created.id)).body.run;
      await api('POST', `/runs/${done.id}/void`, { body: { reason: 'Redo' } });
      expect((await api('GET', `/checks/${done.checks[0].id}/stub`)).body.error).toBe('This paycheck was voided.');
      expect((await api('GET', `/checks/${randomUUID()}/stub`)).status).toBe(404);
      expect((await api('GET', '/checks/nope/stub')).status).toBe(404);
    });
  });

  describe('runs list and CSV', () => {
    it('lists runs newest week first with totals, and exports one CSV row per check', async () => {
      const id = await readyTech('=Sample Alpha');
      await approvedWeek(id, W1);
      await approvedWeek(id, W2);
      const first = await draftAndFinalize(W1);
      const second = await draftAndFinalize(W2);
      const list = (await api('GET', '/runs')).body.runs;
      expect(list.map((r) => r.weekStart)).toEqual([W2, W1]);
      expect(list[0]).toMatchObject({ status: 'finalized', totals: { checkCount: 1, grossCents: 88000 } });
      const csv = await api('GET', `/runs/${first.id}/export.csv`, { raw: true });
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
      expect(csv.headers.get('content-disposition')).toBe(`attachment; filename="pay-run-${W1}.csv"`);
      const lines = csv.text.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1].startsWith("'=Sample Alpha,40.00,0.00,22.00,880.00,")).toBe(true);
      await api('POST', `/runs/${second.id}/void`, { body: { reason: 'Redo' } });
      expect((await api('GET', `/runs/${second.id}/export.csv`, { raw: true })).status).toBe(409);
    });
  });

  describe('timesheet unlock guard', () => {
    const unlock = async (technicianId, weekStart) => {
      const weekly = await trx('time_weekly_summary').where({ technician_id: technicianId, week_start: weekStart }).first();
      const reviewToken = approval._test.reviewSnapshotToken({ weekly, dailies: [], entries: [] });
      return approval.unlockWeek({ technicianId, weekStart, adminId: ADMIN_ID, reason: 'Fix a punch', reviewToken });
    };

    it('refuses to unlock a week with a finalized paycheck, and allows it after the void', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const run = await draftAndFinalize(W1);
      await expect(unlock(id, W1)).rejects.toMatchObject({ statusCode: 409, message: 'Void the pay run for this week first.' });
      expect((await trx('time_weekly_summary').where({ technician_id: id, week_start: W1 }).first()).status).toBe('approved');
      await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Hours were wrong' } });
      await unlock(id, W1);
      expect((await trx('time_weekly_summary').where({ technician_id: id, week_start: W1 }).first()).status).toBe('pending');
    });

    it('does not block a week that only has a draft', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await draft(W1);
      await unlock(id, W1);
      expect((await trx('time_weekly_summary').where({ technician_id: id, week_start: W1 }).first()).status).toBe('pending');
    });
  });

  describe('payroll mutation lock (separate connections)', () => {
    // The service runs on its own connection with a lock timeout, so a held lock shows up as a
    // timeout (55P03) and a free one as the ordinary 404 for a run that does not exist.
    const callerWith = (timeout) => ({
      transaction: (work) => callerDb.transaction(async (t) => {
        await t.raw(`SET LOCAL lock_timeout = '${timeout}'`);
        return work(t);
      }),
    });
    const takeLock = async () => {
      const holder = await holderDb.transaction();
      await holder.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [payrollRuns.PAYROLL_LOCK_NS, payrollRuns.PAYROLL_LOCK_KEY]);
      return holder;
    };
    const calls = {
      finalizeRun: (conn) => payrollRuns.finalizeRun(randomUUID(), { token: 'x' }, ADMIN_ID, conn),
      voidRun: (conn) => payrollRuns.voidRun(randomUUID(), { reason: 'Redo' }, ADMIN_ID, conn),
    };

    it.each(Object.keys(calls))('%s waits while another connection holds the lock, then answers 404', async (name) => {
      const holder = await takeLock();
      try {
        const timedOut = await calls[name](callerWith('300ms')).catch((err) => err);
        expect(timedOut.code).toBe('55P03');
        expect(timedOut.status).toBeUndefined();
      } finally {
        await holder.commit();
      }
      await expect(calls[name](callerWith('300ms'))).rejects.toMatchObject({ status: 404, message: 'Pay run not found.' });
    });

    it.each(Object.keys(calls))('%s goes on by itself once the holder commits', async (name) => {
      const holder = await takeLock();
      let pending;
      try {
        pending = calls[name](callerWith('10s')).catch((err) => err);
        let settled = false;
        pending.then(() => { settled = true; });
        await new Promise((resolve) => { setTimeout(resolve, 400); });
        expect(settled).toBe(false);
      } finally {
        await holder.commit();
      }
      expect(await pending).toMatchObject({ status: 404, message: 'Pay run not found.' });
    });

    it('does not make draft or recompute wait', async () => {
      const holder = await takeLock();
      try {
        await expect(payrollRuns.recomputeRun(randomUUID(), ADMIN_ID, callerWith('300ms')))
          .rejects.toMatchObject({ status: 404 });
      } finally {
        await holder.commit();
      }
    });

    // GATE_PAYROLL_PAY_LINES: a draft's evaluation locks pay lines and earlier weeks'
    // timesheets, rows drafts for different weeks share, so drafts take the lock too.
    it('makes draft and recompute wait while GATE_PAYROLL_PAY_LINES is on', async () => {
      const old = process.env.GATE_PAYROLL_PAY_LINES;
      process.env.GATE_PAYROLL_PAY_LINES = 'true';
      const holder = await takeLock();
      try {
        const recomputed = await payrollRuns.recomputeRun(randomUUID(), ADMIN_ID, callerWith('300ms')).catch((err) => err);
        expect(recomputed.code).toBe('55P03');
        const drafted = await payrollRuns.draftRun({ weekStart: W1 }, ADMIN_ID, callerWith('300ms')).catch((err) => err);
        expect(drafted.code).toBe('55P03');
      } finally {
        await holder.commit();
        if (old === undefined) delete process.env.GATE_PAYROLL_PAY_LINES; else process.env.GATE_PAYROLL_PAY_LINES = old;
      }
      await expect(payrollRuns.recomputeRun(randomUUID(), ADMIN_ID, callerWith('300ms'))).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('admin routes', () => {
    it('answers 404 with the gate off and writes nothing', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      delete process.env.GATE_PAYROLL;
      const before = { runs: await count('payroll_runs'), checks: await count('payroll_checks'), audits: await count('audit_log') };
      expect(await draft(W1)).toEqual({ status: 404, body: { enabled: false } });
      for (const [method, path, body] of [
        ['GET', '/runs'], ['GET', `/runs/${randomUUID()}`], ['POST', `/runs/${randomUUID()}/recompute`],
        ['POST', `/runs/${randomUUID()}/finalize`, { token: 'x' }], ['POST', `/runs/${randomUUID()}/void`, { reason: 'x' }],
        ['GET', `/runs/${randomUUID()}/export.csv`], ['PUT', `/checks/${randomUUID()}/check-number`, { checkNumber: '1' }],
        ['GET', `/checks/${randomUUID()}/stub`],
      ]) {
        expect((await api(method, path, { body, raw: true })).status).toBe(404);
      }
      expect({ runs: await count('payroll_runs'), checks: await count('payroll_checks'), audits: await count('audit_log') }).toEqual(before);
    });

    it('is admin only', async () => {
      expect((await api('GET', '/runs', { role: 'technician' })).status).toBe(403);
      expect((await api('POST', '/runs', { role: 'technician', body: { weekStart: W1 } })).status).toBe(403);
      expect((await api('GET', `/checks/${randomUUID()}/stub`, { role: 'technician' })).status).toBe(403);
    });

    it('answers 404 for a run that does not exist', async () => {
      expect((await api('GET', `/runs/${randomUUID()}`)).status).toBe(404);
      expect((await api('GET', '/runs/not-an-id')).status).toBe(404);
    });
  });
});
