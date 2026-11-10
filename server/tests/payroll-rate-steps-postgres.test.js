// Real PostgreSQL transactions (rolled back): the pay rate step table (CHECKs, the unique open date, up and
// down), applyDueSteps (applies once, stores the previous rate, one audit event), the admin routes
// (create, duplicate 409, cancel, applied 409, the day-90 suggestion) and pay runs that read the steps: a week
// before an applied step keeps the earlier rate even when drafted later, the step week gets the new rate, and
// with no step the check is the technician's pay rate. All names are synthetic.
// DATABASE_URL-gated like the other *-postgres suites.
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
const steps = require('../services/payroll-rate-steps');
const migration = require('../models/migrations/20261109120000_payroll_rate_steps');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { staffWeekStartForWorkDate, addStaffWorkDays } = require('../utils/staff-time-work-date');

jest.setTimeout(60000);

const W1 = '2026-09-14'; // pay Fri 2026-09-25
const W2 = '2026-09-21'; // pay Fri 2026-10-02

postgres('payroll pay rate steps', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD_GATE = process.env.GATE_PAYROLL;
  const ADMIN_ID = randomUUID();

  const technician = async (patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name: 'Sample Employee', employment_type: 'w2', employment_status: 'active', pay_rate: '23.00', ...patch,
    });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const step = async (technicianId, patch = {}) => (await trx('payroll_rate_steps').insert({
    technician_id: technicianId, effective_on: W2, hourly_rate: '25.00', created_by: ADMIN_ID, ...patch,
  }).returning('*'))[0];
  const approvedWeek = (technicianId, weekStart) => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addStaffWorkDays(weekStart, 6), status: 'approved',
    regular_minutes: '2400.00', overtime_minutes: '0.00',
  });
  const refused = async (work) => {
    await trx.raw('SAVEPOINT attempt');
    let error;
    try { await work(); } catch (err) { error = err; }
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    return error;
  };
  const api = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const draft = async (weekStart) => {
    const created = await api('POST', '/runs', { weekStart });
    expect(created.status).toBe(201);
    return created.body.run;
  };
  const checkRate = async (run) => (await trx('payroll_checks').where({ run_id: run.id }).first('hourly_rate')).hourly_rate;
  const rateAudits = (technicianId) => trx('audit_log').where({ action: 'payroll.pay_rate_changed', resource_id: technicianId });

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
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_PAYROLL; else process.env.GATE_PAYROLL = OLD_GATE;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  describe('the table', () => {
    it('refuses a day that is not Monday, a rate of 0, a note over 500 characters and a step both applied and cancelled', async () => {
      const id = await technician();
      expect(await refused(() => step(id, { effective_on: '2026-09-22' }))).toBeTruthy();
      expect(await refused(() => step(id, { hourly_rate: '0' }))).toBeTruthy();
      expect(await refused(() => step(id, { note: 'x'.repeat(501) }))).toBeTruthy();
      expect(await refused(() => step(id, { applied_at: new Date(), cancelled_at: new Date(), cancelled_by: ADMIN_ID }))).toBeTruthy();
      expect(await refused(() => step(id, { cancelled_at: new Date() }))).toBeTruthy();
      expect(await refused(() => step(id))).toBeUndefined();
    });

    it('allows one open step a day for a technician; a cancelled one frees the day', async () => {
      const id = await technician();
      const first = await step(id);
      expect(await refused(() => step(id))).toMatchObject({ code: '23505' });
      const other = await technician();
      expect(await refused(() => step(other))).toBeUndefined();
      await trx('payroll_rate_steps').where({ id: first.id }).update({ cancelled_at: new Date(), cancelled_by: ADMIN_ID });
      expect(await refused(() => step(id))).toBeUndefined();
    });

    it('rolls back and forward; a rollback is refused while an applied step exists', async () => {
      const id = await technician();
      await step(id);
      await migration.down(trx);
      expect((await trx.raw("SELECT to_regclass('payroll_rate_steps') AS t")).rows[0].t).toBeNull();
      await migration.up(trx);
      expect((await trx.raw("SELECT to_regclass('payroll_rate_steps') AS t")).rows[0].t).toBe('payroll_rate_steps');
      await step(id, { applied_at: new Date(), previous_rate: '23.00' });
      await expect(migration.down(trx)).rejects.toThrow(/applied steps/);
    });
  });

  describe('applyDueSteps', () => {
    it('applies a due step once: stores the previous rate, changes the pay rate, audits it', async () => {
      const id = await technician();
      const due = await step(id);
      const later = await step(id, { effective_on: '2026-09-28', hourly_rate: '27.00' });
      expect(await steps.applyDueSteps(trx, { today: W2 })).toEqual([due.id]);
      expect(await steps.applyDueSteps(trx, { today: W2 })).toEqual([]);
      const row = await trx('payroll_rate_steps').where({ id: due.id }).first();
      expect(row.applied_at).toBeTruthy();
      expect(row.previous_rate).toBe('23.00');
      expect((await trx('technicians').where({ id }).first('pay_rate')).pay_rate).toBe('25.00');
      expect((await trx('payroll_rate_steps').where({ id: later.id }).first()).applied_at).toBeNull();
      const audits = await rateAudits(id);
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toEqual({ technician_id: id, old_pay_rate: 23, new_pay_rate: 25, rate_step_id: due.id });
    });

    it('catches up: a step from a missed week applies in date order on the next run', async () => {
      const id = await technician();
      const one = await step(id);
      const two = await step(id, { effective_on: '2026-09-28', hourly_rate: '27.00' });
      expect(await steps.applyDueSteps(trx, { today: '2026-10-05' })).toEqual([one.id, two.id]);
      expect((await trx('technicians').where({ id }).first('pay_rate')).pay_rate).toBe('27.00');
      expect((await trx('payroll_rate_steps').where({ id: two.id }).first()).previous_rate).toBe('25.00');
    });
  });

  describe('routes', () => {
    const nextMonday = () => {
      const monday = staffWeekStartForWorkDate(etDateString(addETDays(new Date(), 1)));
      return monday > etDateString() ? monday : addStaffWorkDays(monday, 7);
    };

    it('records a step, refuses the same date twice, lists it with the day-90 Monday, and cancels it', async () => {
      const id = await technician({ hire_date: '2027-01-04' });
      const day = nextMonday();
      const created = await api('POST', `/technicians/${id}/rate-steps`, { effectiveOn: day, hourlyRate: '25', note: 'Day 90' });
      expect(created.status).toBe(201);
      expect(created.body.step).toMatchObject({ effectiveOn: day, hourlyRate: '25.00', status: 'scheduled', note: 'Day 90' });
      expect((await api('POST', `/technicians/${id}/rate-steps`, { effectiveOn: day, hourlyRate: '26' })).status).toBe(409);
      expect((await api('POST', `/technicians/${id}/rate-steps`, { effectiveOn: day, hourlyRate: '14' })).status).toBe(400);
      const listed = await api('GET', `/technicians/${id}/rate-steps`);
      expect(listed.body).toMatchObject({ suggestedDay90Monday: '2027-04-05', steps: [{ id: created.body.step.id, status: 'scheduled' }] });
      const cancelled = await api('DELETE', `/rate-steps/${created.body.step.id}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.step.status).toBe('cancelled');
      expect((await api('DELETE', `/rate-steps/${created.body.step.id}`)).status).toBe(409);
      const audit = await trx('audit_log').whereIn('action', ['payroll.rate_step_created', 'payroll.rate_step_cancelled']).orderBy('created_at');
      expect(audit.map((r) => r.action).sort()).toEqual(['payroll.rate_step_cancelled', 'payroll.rate_step_created']);
      // The same date can be recorded again once the first was cancelled.
      expect((await api('POST', `/technicians/${id}/rate-steps`, { effectiveOn: day, hourlyRate: '26' })).status).toBe(201);
    });

    it('refuses to cancel an applied step, a contractor, and a missing technician; the list has no suggestion without a hire date', async () => {
      const id = await technician();
      const applied = await step(id, { applied_at: new Date(), previous_rate: '23.00' });
      const refusal = await api('DELETE', `/rate-steps/${applied.id}`);
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toMatch(/already changed the pay rate/);
      const contractor = await technician({ employment_type: '1099' });
      expect((await api('POST', `/technicians/${contractor}/rate-steps`, { effectiveOn: nextMonday(), hourlyRate: '25' })).status).toBe(409);
      expect((await api('GET', `/technicians/${randomUUID()}/rate-steps`)).status).toBe(404);
      expect((await api('GET', `/technicians/${id}/rate-steps`)).body.suggestedDay90Monday).toBeNull();
    });
  });

  describe('pay runs', () => {
    it('drafted after the step is applied: the week before keeps the earlier rate, the step week pays the new one', async () => {
      const id = await technician();
      await step(id); // effective W2, due (today is later), not applied yet: the draft applies it
      await approvedWeek(id, W1);
      await approvedWeek(id, W2);
      const before = await draft(W1);
      expect((await trx('technicians').where({ id }).first('pay_rate')).pay_rate).toBe('25.00');
      expect(await checkRate(before)).toBe('23.00');
      const onStep = await draft(W2);
      expect(await checkRate(onStep)).toBe('25.00');
      // The draft screen reads the same numbers without recomputing.
      const viewed = await api('GET', `/runs/${before.id}`);
      expect(viewed.body.run).toMatchObject({ stale: false, checks: [{ hourlyRate: '23.00' }] });
      const recomputed = await api('POST', `/runs/${before.id}/recompute`);
      expect(recomputed.status).toBe(200);
      expect(await checkRate(before)).toBe('23.00');
    });

    it('the draft screen prices a due step that is not applied yet, so a draft made before it shows as out of date', async () => {
      const id = await technician();
      await approvedWeek(id, W2);
      const run = await draft(W2);
      expect((await api('GET', `/runs/${run.id}`)).body.run.stale).toBe(false);
      await step(id);
      expect((await api('GET', `/runs/${run.id}`)).body.run.stale).toBe(true);
      expect((await trx('technicians').where({ id }).first('pay_rate')).pay_rate).toBe('23.00');
      await api('POST', `/runs/${run.id}/recompute`);
      expect(await checkRate(run)).toBe('25.00');
    });

    it('a manual pay rate edit after the step wins for later weeks and never reprices the week before', async () => {
      const id = await technician();
      await step(id);
      await steps.applyDueSteps(trx, { today: W2 });
      await trx('technicians').where({ id }).update({ pay_rate: '26.00' });
      await approvedWeek(id, W1);
      await approvedWeek(id, '2026-09-28');
      expect(await checkRate(await draft(W1))).toBe('23.00');
      expect(await checkRate(await draft('2026-09-28'))).toBe('26.00');
    });

    it('with no step the check pays the technician pay rate and no pay rate audit is written', async () => {
      const id = await technician({ pay_rate: '22.00' });
      await approvedWeek(id, W1);
      expect(await checkRate(await draft(W1))).toBe('22.00');
      expect(await rateAudits(id)).toHaveLength(0);
    });

    it('a cancelled step changes nothing', async () => {
      const id = await technician();
      await step(id, { cancelled_at: new Date(), cancelled_by: ADMIN_ID });
      await approvedWeek(id, W2);
      expect(await checkRate(await draft(W2))).toBe('23.00');
      expect((await trx('technicians').where({ id }).first('pay_rate')).pay_rate).toBe('23.00');
    });
  });
});
