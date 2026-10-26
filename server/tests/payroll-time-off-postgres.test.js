// Real PostgreSQL transactions (rolled back): payroll time off. The migrated
// schema and its constraints, a finalized check staying immutable with the new
// columns, the full flow (worked week + holiday, finalize, stub, CSV), a week of
// time off alone, a waiting technician, the review token, the lock once a week is
// paid (a void frees it), audit rows, the balance, the allowance, and the gate
// off. All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
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
const timeOff = require('../services/payroll-time-off');
const payrollRuns = require('../services/payroll-runs');
const timeTracking = require('../services/time-tracking');
const { etDateString } = require('../utils/datetime-et');
const { addStaffWorkDays } = require('../utils/staff-time-work-date');

jest.setTimeout(60000);

// Finished staff weeks in 2026 (Monday dates). Pay dates default to the Friday after.
const W1 = '2026-09-14'; // pay Fri 2026-09-25
const W2 = '2026-09-21'; // pay Fri 2026-10-02

postgres('payroll time off', () => {
  let database;
  let holderDb;
  let callerDb;
  let server;
  let baseUrl;
  let trx;
  const OLD_GATE = process.env.GATE_PAYROLL;
  const OLD_OFF = process.env.GATE_PAYROLL_TIME_OFF;
  const ADMIN_ID = randomUUID();

  const addDays = (ymd, n) => addStaffWorkDays(ymd, n);
  const technician = async (patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name: 'Sample Employee', employment_type: 'w2', employment_status: 'active', pay_rate: '22.00', ...patch,
    });
    return id;
  };
  const readyTech = async (name, patch = {}) => {
    const id = await technician({ name, ...patch });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const approvedWeek = (technicianId, weekStart, regular = '2400.00', overtime = '0.00') => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: regular, overtime_minutes: overtime,
  });
  const offDay = (technicianId, workDate, kind, minutes) => trx('payroll_time_off').insert({
    technician_id: technicianId, work_date: workDate, kind, minutes,
  });
  const refused = async (work) => {
    await trx.raw('SAVEPOINT attempt');
    let error;
    try { await work(); } catch (err) { error = err; }
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    return error;
  };
  const api = async (method, path, { body, role, raw = false } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID, ...(role ? { 'x-test-role': role } : {}) },
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
  const draftAndFinalize = async (weekStart) => {
    const created = await draft(weekStart);
    expect(created.status).toBe(201);
    const done = await finalize(created.body.run.id);
    expect(done.status).toBe(200);
    return done.body.run;
  };
  const byName = (run, name) => run.checks.find((c) => c.name === name);
  const auditActions = async () => (await trx('audit_log').orderBy('created_at').select('action', 'resource_id'))
    .filter((row) => /^payroll\.(time_off|pto)/.test(row.action));

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
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
    if (holderDb) await holderDb.destroy();
    if (callerDb) await callerDb.destroy();
  });

  describe('migrated schema', () => {
    it('refuses what the table constraints refuse', async () => {
      const id = await technician();
      const bad = [
        ['a kind outside pto and holiday', { kind: 'sick', minutes: 60 }],
        ['zero minutes', { kind: 'pto', minutes: 0 }],
        ['more than 24 hours', { kind: 'pto', minutes: '1440.01' }],
        ['a note over 500 characters', { kind: 'pto', minutes: 60, note: 'x'.repeat(501) }],
        ['no work date', { kind: 'pto', minutes: 60, work_date: null }],
      ];
      for (const [name, patch] of bad) {
        const error = await refused(() => trx('payroll_time_off').insert({ technician_id: id, work_date: '2026-09-16', ...patch }));
        expect([name, Boolean(error)]).toEqual([name, true]);
      }
      await trx('payroll_time_off').insert({ technician_id: id, work_date: '2026-09-16', kind: 'pto', minutes: 1440, note: 'x'.repeat(500) });
      expect((await refused(() => offDay(id, '2026-09-16', 'holiday', 60))).message).toMatch(/payroll_time_off_tech_date_unique/);
      expect((await refused(() => trx('technicians').where({ id }).del())).message).toMatch(/payroll_time_off_technician_id_foreign/);
      const row = await trx('payroll_time_off').where({ technician_id: id }).first();
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.created_at).toBeTruthy();
      expect(row.updated_at).toBeNull();
    });

    it('bounds the allowance at 0 to 400 hours or null', async () => {
      const id = await technician();
      for (const ok of [null, '0', '80', '400', '12.25']) {
        await trx('technicians').where({ id }).update({ pto_hours_per_year: ok });
      }
      expect((await trx('technicians').where({ id }).first('pto_hours_per_year')).pto_hours_per_year).toBe('12.25');
      for (const bad of ['-0.01', '400.01']) {
        expect((await refused(() => trx('technicians').where({ id }).update({ pto_hours_per_year: bad }))).message).toMatch(/technicians_pto_hours_per_year_check/);
      }
      // A technician with no allowance set reads NULL.
      const fresh = await technician({ name: 'Sample Fresh' });
      expect((await trx('technicians').where({ id: fresh }).first('pto_hours_per_year')).pto_hours_per_year).toBeNull();
    });

    it('defaults the new check columns to zero and refuses a negative one', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const run = (await draft(W1)).body.run;
      const row = await trx('payroll_checks').where({ id: run.checks[0].id }).first();
      expect([row.pto_minutes, row.holiday_minutes, row.pto_pay_cents, row.holiday_pay_cents]).toEqual(['0.00', '0.00', '0', '0']);
      for (const column of ['pto_minutes', 'holiday_minutes', 'pto_pay_cents', 'holiday_pay_cents']) {
        const error = await refused(() => trx('payroll_checks').where({ id: row.id }).update({ [column]: -1 }));
        expect(error.message).toMatch(/payroll_checks_time_off_check/);
      }
    });
  });

  describe('a finalized check with time off is evidence', () => {
    const finalHoliday = async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '1800.00');
      await offDay(id, addDays(W1, 2), 'holiday', '600.00');
      const run = await draftAndFinalize(W1);
      return { id, run, check: byName(run, 'Sample Alpha') };
    };

    it.each([
      ['time off minutes', { pto_minutes: '60.00' }],
      ['holiday minutes', { holiday_minutes: '0.00' }],
      ['time off pay', { pto_pay_cents: 1 }],
      ['holiday pay', { holiday_pay_cents: 0 }],
    ])('blocks changing %s, so the new columns are protected too', async (_name, patch) => {
      const { check } = await finalHoliday();
      const error = await refused(() => trx('payroll_checks').where({ id: check.id }).update(patch));
      expect(error.message).toMatch(/cannot be edited/);
    });

    it('still lets a finalized check take a check number and be voided', async () => {
      const { check, run } = await finalHoliday();
      await trx('payroll_checks').where({ id: check.id }).update({ check_number: '1001' });
      const voided = await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } });
      expect(voided.status).toBe(200);
    });
  });

  describe('paying the week', () => {
    it('adds a 10 hour holiday to a 30 hour week on one check, with no overtime, and shows it on the stub and the CSV', async () => {
      const id = await readyTech('Sample Alpha', { ssn_last4: '4321' });
      await approvedWeek(id, W1, '1800.00');
      await offDay(id, addDays(W1, 3), 'holiday', '600.00');
      const created = (await draft(W1)).body.run;
      const check = byName(created, 'Sample Alpha');
      expect(check).toMatchObject({
        regularHours: '30.00', overtimeHours: '0.00', ptoHours: '0.00', holidayHours: '10.00',
        regularPayCents: 66000, overtimePayCents: 0, ptoPayCents: 0, holidayPayCents: 22000, grossCents: 88000,
      });
      expect(created.totals).toMatchObject({ grossCents: 88000, holidayPayCents: 22000, ptoPayCents: 0 });
      const { calc_snapshot: snapshot } = await trx('payroll_checks').where({ id: check.id }).first('calc_snapshot');
      expect(snapshot).toMatchObject({ holidayPayCents: 22000, ptoPayCents: 0, grossPayCents: 88000, overtimePayCents: 0 });

      const done = (await finalize(created.id)).body.run;
      const stub = (await api('GET', `/checks/${byName(done, 'Sample Alpha').id}/stub`)).body.stub;
      expect(stub.hours).toEqual({ regular: '30.00', overtime: '0.00', pto: '0.00', holiday: '10.00' });
      expect(stub.earnings).toEqual({
        regularPayCents: 66000, overtimePayCents: 0, ptoPayCents: 0, holidayPayCents: 22000, grossCents: 88000,
      });
      expect(stub.ytd.grossCents).toBe(88000);

      const csv = (await api('GET', `/runs/${done.id}/export.csv`, { raw: true })).text.split('\n');
      expect(csv[0].endsWith(',Check Number,PTO Hours,PTO Pay,Holiday Hours,Holiday Pay')).toBe(true);
      expect(csv[1].endsWith(',Paper check,,0.00,0.00,10.00,220.00')).toBe(true);
    });

    it('pays paid time off and holiday on the same week as separate lines', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '1200.00');
      await offDay(id, addDays(W1, 1), 'pto', '480.00');
      await offDay(id, addDays(W1, 2), 'pto', '240.00');
      await offDay(id, addDays(W1, 4), 'holiday', '480.00');
      const check = byName((await draft(W1)).body.run, 'Sample Alpha');
      expect(check).toMatchObject({ ptoHours: '12.00', holidayHours: '8.00', ptoPayCents: 26400, holidayPayCents: 17600, regularPayCents: 44000, grossCents: 88000 });
    });

    it('ignores days outside the week, and technicians who are not W-2', async () => {
      const id = await readyTech('Sample Alpha');
      const other = await technician({ name: 'Sample Contractor', employment_type: '1099' });
      await approvedWeek(id, W1);
      await offDay(id, addDays(W1, -1), 'pto', '480.00');
      await offDay(id, addDays(W1, 7), 'pto', '480.00');
      await offDay(other, addDays(W1, 2), 'pto', '480.00');
      const run = (await draft(W1)).body.run;
      expect(run.checks).toHaveLength(1);
      expect(byName(run, 'Sample Alpha')).toMatchObject({ ptoHours: '0.00', grossCents: 88000 });
    });

    it('makes a check for a week of time off alone, and Sunday counts as the last day', async () => {
      const id = await readyTech('Sample Alpha');
      await offDay(id, addDays(W1, 0), 'pto', '480.00');
      await offDay(id, addDays(W1, 6), 'holiday', '480.00');
      const created = await draft(W1);
      expect(created.status).toBe(201);
      const check = byName(created.body.run, 'Sample Alpha');
      expect(check).toMatchObject({ regularHours: '0.00', ptoHours: '8.00', holidayHours: '8.00', grossCents: 35200 });
      expect((await finalize(created.body.run.id)).status).toBe(200);
    });

    it('also makes the time-off-only check when the approved week has zero hours', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '0.00', '0.00');
      await offDay(id, addDays(W1, 1), 'pto', '480.00');
      expect(byName((await draft(W1)).body.run, 'Sample Alpha')).toMatchObject({ grossCents: 17600 });
    });

    it('leaves a technician with unapproved worked time waiting; time off never bypasses the timesheet', async () => {
      const waiting = await readyTech('Sample Pending');
      const ready = await readyTech('Sample Ready');
      await trx('time_entry_daily_summary').insert({ technician_id: waiting, work_date: addDays(W1, 1), total_shift_minutes: 480 });
      await offDay(waiting, addDays(W1, 2), 'holiday', '480.00');
      await approvedWeek(ready, W1);
      const created = await draft(W1);
      const run = created.body.run;
      expect(run.waiting.map((w) => w.name)).toEqual(['Sample Pending']);
      expect(run.checks.map((c) => c.name)).toEqual(['Sample Ready']);
      const refusal = await finalize(run.id);
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toMatch(/Sample Pending: Timesheet for this week is not approved yet/);
    });

    it('turns a time-off-only draft into the old answer when nothing at all is to pay', async () => {
      const result = await draft(W1);
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('No W-2 hours to pay for that week.');
    });

    it('marks a draft stale when time off changes, and finalize with the old token reloads the numbers', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '1800.00');
      const entry = (await offDay(id, addDays(W1, 3), 'holiday', '600.00').returning('id'))[0];
      const created = (await draft(W1)).body.run;
      expect(created.stale).toBe(false);
      await trx('payroll_time_off').where({ id: entry.id || entry }).update({ minutes: '480.00' });
      const shown = (await api('GET', `/runs/${created.id}`)).body.run;
      expect(shown.stale).toBe(true);
      const old = await api('POST', `/runs/${created.id}/finalize`, { body: { token: created.token } });
      expect(old.status).toBe(409);
      expect(old.body.error).toMatch(/Hours or settings changed/);
      const fresh = (await api('GET', `/runs/${created.id}`)).body.run;
      expect(byName(fresh, 'Sample Alpha')).toMatchObject({ holidayHours: '8.00', grossCents: 66000 + 17600 });
      expect((await finalize(created.id)).status).toBe(200);
    });

    it('counts finalized time off pay in the next check\'s year-to-date', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '1800.00');
      await offDay(id, addDays(W1, 3), 'holiday', '600.00');
      await draftAndFinalize(W1);
      await approvedWeek(id, W2);
      const second = (await draft(W2)).body.run;
      expect(byName(second, 'Sample Alpha').ytdGrossBeforeCents).toBe(88000);
    });
  });

  describe('gate off', () => {
    it('is today: time off is not read, no new keys, no new columns, new routes answer 404', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '2400.00');
      await offDay(id, addDays(W1, 3), 'holiday', '600.00');
      for (const value of [undefined, 'false']) {
        if (value === undefined) delete process.env.GATE_PAYROLL_TIME_OFF; else process.env.GATE_PAYROLL_TIME_OFF = value;
        const created = await draft(W1);
        expect(created.status).toBe(201);
        const run = created.body.run;
        expect(Object.keys(run.checks[0]).sort()).toEqual([
          'additionalMedicareCents', 'checkNumber', 'employerMedicareCents', 'employerSocialSecurityCents', 'federalIncomeTaxCents',
          'flReemploymentCents', 'futaCents', 'grossCents', 'hourlyRate', 'id', 'medicareCents', 'name', 'netCents', 'overtimeHours',
          'overtimeMinutes', 'overtimePayCents', 'payMethod', 'regularHours', 'regularMinutes', 'regularPayCents', 'socialSecurityCents',
          'status', 'technicianId', 'ytdGrossBeforeCents',
        ].sort());
        expect(Object.keys(run.totals).sort()).toEqual(['checkCount', 'employeeTaxesCents', 'employerTaxesCents', 'grossCents', 'netCents']);
        expect(run.checks[0].grossCents).toBe(88000);
        const stored = await trx('payroll_checks').where({ id: run.checks[0].id }).first('calc_snapshot');
        expect(Object.keys(stored.calc_snapshot)).not.toContain('ptoPayCents');
        const csv = (await api('GET', `/runs/${run.id}/export.csv`, { raw: true })).text.split('\n');
        expect(csv[0].endsWith('Pay Method,Check Number')).toBe(true);
        await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } });
      }
      const requests = [
        ['GET', '/time-off?from=2026-09-01&to=2026-09-30'],
        ['POST', '/time-off'], ['PUT', `/time-off/${randomUUID()}`], ['DELETE', `/time-off/${randomUUID()}`],
        ['GET', `/time-off/balance?technicianId=${id}`], ['PUT', `/technicians/${id}/pto-allowance`],
      ];
      for (const [method, path] of requests) {
        const response = await api(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} });
        expect([method, path, response.status, response.body]).toEqual([method, path, 404, { enabled: false }]);
      }
      expect(await trx('payroll_time_off').count('* as n').first().then((r) => Number(r.n))).toBe(1);
      expect(await auditActions()).toEqual([]);
    });

    it('does not select the new columns of the technician list', async () => {
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      await readyTech('Sample Alpha');
      const list = (await api('GET', '/technicians')).body.technicians;
      expect(list[0]).not.toHaveProperty('ptoHoursPerYear');
    });

    it('a time-off-only week makes no check', async () => {
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const id = await readyTech('Sample Alpha');
      await offDay(id, addDays(W1, 3), 'holiday', '600.00');
      expect((await draft(W1)).status).toBe(409);
    });

    it('answers 403 to a non-admin and 404 to everyone with GATE_PAYROLL off', async () => {
      expect((await api('GET', '/time-off?from=2026-09-01&to=2026-09-30', { role: 'technician' })).status).toBe(403);
      process.env.GATE_PAYROLL = 'false';
      expect((await api('GET', '/time-off?from=2026-09-01&to=2026-09-30')).body).toEqual({ enabled: false });
    });
  });

  describe('recording time off', () => {
    const today = etDateString();
    const day = (n) => addDays(today, n);

    it('records, lists, changes and removes a day, and audits each write with ids', async () => {
      const id = await readyTech('Sample Alpha');
      const created = await api('POST', '/time-off', { body: { technicianId: id, workDate: day(10), kind: 'pto', hours: '8', note: ' Vacation ' } });
      expect(created.status).toBe(201);
      expect(created.body.entry).toMatchObject({ technicianId: id, name: 'Sample Alpha', workDate: day(10), kind: 'pto', hours: '8.00', note: 'Vacation' });
      expect(created.body.warning).toBeNull();
      const stored = await trx('payroll_time_off').where({ id: created.body.entry.id }).first();
      expect(stored).toMatchObject({ minutes: '480.00', kind: 'pto', created_by: ADMIN_ID });

      const listed = await api('GET', `/time-off?from=${day(0)}&to=${day(30)}`);
      expect(listed.body.entries.map((e) => e.id)).toEqual([created.body.entry.id]);

      const changed = await api('PUT', `/time-off/${created.body.entry.id}`, { body: { kind: 'holiday', hours: 7.75, note: '' } });
      expect(changed.status).toBe(200);
      expect(changed.body.entry).toMatchObject({ kind: 'holiday', hours: '7.75', note: null });
      expect(await trx('payroll_time_off').where({ id: created.body.entry.id }).first()).toMatchObject({ minutes: '465.00', updated_by: ADMIN_ID });

      expect((await api('DELETE', `/time-off/${created.body.entry.id}`)).body).toEqual({ deleted: true });
      expect((await api('DELETE', `/time-off/${created.body.entry.id}`)).status).toBe(404);
      expect((await api('PUT', `/time-off/${created.body.entry.id}`, { body: { kind: 'pto', hours: 1 } })).status).toBe(404);

      const actions = await auditActions();
      // One transaction, one timestamp: compare as a set, not by order.
      expect(actions.map((a) => a.action).sort()).toEqual(['payroll.time_off_added', 'payroll.time_off_changed', 'payroll.time_off_removed']);
      expect(actions.every((a) => a.resource_id === created.body.entry.id)).toBe(true);
      const meta = (await trx('audit_log').where({ action: 'payroll.time_off_added' }).first('metadata')).metadata;
      expect(JSON.stringify(meta)).not.toMatch(/Vacation|Sample Alpha/);
    });

    it('refuses a technician who is not a W-2 employee, an unknown one, and a second entry for the date', async () => {
      const id = await readyTech('Sample Alpha');
      const contractor = await technician({ name: 'Sample Contractor', employment_type: '1099' });
      const post = (body) => api('POST', '/time-off', { body: { workDate: day(5), kind: 'pto', hours: 8, ...body } });
      const noW2 = await post({ technicianId: contractor });
      expect(noW2.status).toBe(409);
      expect(noW2.body.error).toBe('Paid time off is for W-2 employees.');
      expect((await post({ technicianId: randomUUID() })).status).toBe(404);
      expect((await post({ technicianId: id })).status).toBe(201);
      const again = await post({ technicianId: id, kind: 'holiday' });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatch(/already has time off recorded for that date/);
      expect(Number((await trx('payroll_time_off').count('* as n').first()).n)).toBe(1);
      // The refused attempt leaves no audit row of its own.
      expect((await auditActions()).map((a) => a.action)).toEqual(['payroll.time_off_added']);
    });

    it('refuses hours and dates outside the rules with a plain message', async () => {
      const id = await readyTech('Sample Alpha');
      const post = (body) => api('POST', '/time-off', { body: { technicianId: id, workDate: day(5), kind: 'pto', hours: 8, ...body } });
      expect((await post({ hours: 0 })).body.error).toMatch(/more than 0/);
      expect((await post({ hours: 24.5 })).body.error).toMatch(/24 or fewer/);
      expect((await post({ hours: '2.555' })).body.error).toMatch(/2 decimal/);
      expect((await post({ kind: 'sick' })).body.error).toMatch(/paid time off or holiday/);
      expect((await post({ workDate: '2026-02-30' })).body.error).toMatch(/real date/);
      expect((await post({ workDate: day(401) })).body.error).toMatch(/within 400 days/);
      expect((await post({ workDate: day(-401) })).body.error).toMatch(/within 400 days/);
      expect((await post({ workDate: day(400), hours: 24 })).status).toBe(201);
      expect((await post({ workDate: day(-400), hours: '0.01' })).status).toBe(201);
      expect(await trx('payroll_time_off').where({ technician_id: id, minutes: '0.60' }).first()).toBeTruthy();
      expect((await api('GET', `/time-off?from=${day(-100)}&to=${day(301)}`)).status).toBe(400);
    });

    it('warns past the allowance, still saves the day, and counts only paid time off, per calendar year', async () => {
      const id = await readyTech('Sample Alpha');
      expect((await api('PUT', `/technicians/${id}/pto-allowance`, { body: { hoursPerYear: '16' } })).body.technician).toEqual({ id, ptoHoursPerYear: 16 });
      const year = day(1).slice(0, 4);
      const inYear = (n) => `${year}-12-${String(n).padStart(2, '0')}`;
      const a = await api('POST', '/time-off', { body: { technicianId: id, workDate: inYear(20), kind: 'pto', hours: 8 } });
      const b = await api('POST', '/time-off', { body: { technicianId: id, workDate: inYear(21), kind: 'pto', hours: 4 } });
      const c = await api('POST', '/time-off', { body: { technicianId: id, workDate: inYear(22), kind: 'pto', hours: 8 } });
      expect([a.body.warning, b.body.warning]).toEqual([null, null]);
      expect(c.status).toBe(201);
      expect(c.body.warning).toBe(`Sample Alpha now has 20.00 hours of paid time off booked in ${year}. The yearly allowance is 16 hours. The day is saved.`);
      expect(await trx('payroll_time_off').where({ id: c.body.entry.id }).first('id')).toBeTruthy();
      // A holiday does not count against the allowance.
      const holiday = await api('POST', '/time-off', { body: { technicianId: id, workDate: inYear(25), kind: 'holiday', hours: 8 } });
      expect(holiday.body.warning).toBeNull();
      const bal = (await api('GET', `/time-off/balance?technicianId=${id}&year=${year}`)).body.balance;
      expect(bal).toMatchObject({ allowanceHours: 16, ptoHoursBooked: '20.00', ptoHoursPaid: '0.00', holidayDaysBooked: 1, year: Number(year) });
      // A change that stays over the allowance warns too; one that gets under it does not.
      expect((await api('PUT', `/time-off/${c.body.entry.id}`, { body: { kind: 'pto', hours: 5 } })).body.warning).toMatch(/17.00 hours/);
      expect((await api('PUT', `/time-off/${c.body.entry.id}`, { body: { kind: 'pto', hours: 4 } })).body.warning).toBeNull();
    });

    it('sets and clears the allowance, W-2 only, and audits it without the number', async () => {
      const id = await readyTech('Sample Alpha');
      const contractor = await technician({ name: 'Sample Contractor', employment_type: '1099' });
      const put = (techId, body) => api('PUT', `/technicians/${techId}/pto-allowance`, { body });
      expect((await put(id, { hoursPerYear: 80 })).body.technician.ptoHoursPerYear).toBe(80);
      expect((await api('GET', '/technicians')).body.technicians[0].ptoHoursPerYear).toBe(80);
      expect((await put(id, { hoursPerYear: null })).body.technician.ptoHoursPerYear).toBeNull();
      expect((await put(id, { hoursPerYear: 401 })).status).toBe(400);
      expect((await put(id, {})).status).toBe(400);
      expect((await put(contractor, { hoursPerYear: 80 })).status).toBe(409);
      expect((await put(randomUUID(), { hoursPerYear: 80 })).status).toBe(404);
      const rows = await trx('audit_log').where({ action: 'payroll.pto_allowance_changed' }).select('metadata');
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.metadata)).toEqual([{ technician_id: id }, { technician_id: id }]);
      expect((await api('GET', `/time-off/balance?technicianId=${id}`)).body.balance.allowanceHours).toBeNull();
    });

    it('reports hours booked and hours paid for a year, from finalized checks by pay date', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '1800.00');
      await offDay(id, addDays(W1, 1), 'pto', '600.00');
      await offDay(id, '2026-12-24', 'pto', '480.00');
      await offDay(id, '2027-01-04', 'pto', '240.00');
      await offDay(id, '2026-12-25', 'holiday', '480.00');
      const draftBal = (await api('GET', `/time-off/balance?technicianId=${id}&year=2026`)).body.balance;
      expect(draftBal).toMatchObject({ ptoHoursBooked: '18.00', ptoHoursPaid: '0.00', holidayDaysBooked: 1 });
      await draftAndFinalize(W1);
      const after = (await api('GET', `/time-off/balance?technicianId=${id}&year=2026`)).body.balance;
      expect(after).toMatchObject({ allowanceHours: null, ptoHoursBooked: '18.00', ptoHoursPaid: '10.00' });
      expect((await api('GET', `/time-off/balance?technicianId=${id}&year=2027`)).body.balance).toMatchObject({ ptoHoursBooked: '4.00', ptoHoursPaid: '0.00', holidayDaysBooked: 0 });
      expect((await api('GET', `/time-off/balance?technicianId=${randomUUID()}`)).status).toBe(404);
    });
  });

  describe('the lock once a week is paid', () => {
    const LOCK = "This week's pay run is final. Void it first to change its pay.";

    it('refuses change and delete after finalize, and allows them again after a void', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '1800.00');
      const row = (await offDay(id, addDays(W1, 3), 'holiday', '600.00').returning('id'))[0];
      const entryId = row.id || row;
      const run = await draftAndFinalize(W1);

      const put = await api('PUT', `/time-off/${entryId}`, { body: { kind: 'holiday', hours: 4 } });
      expect([put.status, put.body.error]).toEqual([409, LOCK]);
      const del = await api('DELETE', `/time-off/${entryId}`);
      expect([del.status, del.body.error]).toEqual([409, LOCK]);
      expect(await trx('payroll_time_off').where({ id: entryId }).first('minutes')).toEqual({ minutes: '600.00' });

      expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect((await api('PUT', `/time-off/${entryId}`, { body: { kind: 'holiday', hours: 4 } })).status).toBe(200);
      const redone = (await draft(W1)).body.run;
      expect(byName(redone, 'Sample Alpha')).toMatchObject({ holidayHours: '4.00', grossCents: 66000 + 8800 });
      expect((await finalize(redone.id)).status).toBe(200);
      expect((await api('DELETE', `/time-off/${entryId}`)).status).toBe(409);
    });

    it('refuses to add a day to a paid week, whichever technician the run paid (the date rule is checked first, so run it with the clock on that week)', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '1800.00');
      await draftAndFinalize(W1);
      const realDate = Date;
      const frozen = new realDate('2026-09-28T16:00:00Z').getTime();
      jest.useFakeTimers({ now: frozen, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
      try {
        await expect(timeOff.createTimeOff({ technicianId: id, workDate: addDays(W1, 2), kind: 'pto', hours: 8 }, ADMIN_ID, trx))
          .rejects.toMatchObject({ status: 409, message: LOCK });
        // A technician the run did not pay is locked too, on every day of that week.
        const other = await readyTech('Sample Beta');
        for (const offset of [0, 6]) {
          await expect(timeOff.createTimeOff({ technicianId: other, workDate: addDays(W1, offset), kind: 'pto', hours: 8 }, ADMIN_ID, trx))
            .rejects.toMatchObject({ status: 409, message: LOCK });
        }
        // The days either side of the week are not locked.
        const before = await timeOff.createTimeOff({ technicianId: other, workDate: addDays(W1, -1), kind: 'pto', hours: 8 }, ADMIN_ID, trx);
        expect(before.entry.hours).toBe('8.00');
        const next = await timeOff.createTimeOff({ technicianId: id, workDate: addDays(W1, 7), kind: 'pto', hours: 8 }, ADMIN_ID, trx);
        expect(next.entry.workDate).toBe(addDays(W1, 7));
      } finally {
        jest.useRealTimers();
      }
    });

    it('locks on the finalized RUN: a run with no check for this technician refuses create, change and delete, and a void frees the week', async () => {
      const paid = await readyTech('Sample Paid');
      const idle = await readyTech('Sample Idle');
      await approvedWeek(paid, W1);
      const row = (await offDay(idle, addDays(W1, 2), 'pto', '480.00').returning('id'))[0];
      const entryId = row.id || row;
      // The run is drafted before this technician's entry exists in the final run: remove it, finalize, put it back.
      await trx('payroll_time_off').where({ id: entryId }).del();
      const run = await draftAndFinalize(W1);
      expect(run.checks.map((c) => c.name)).toEqual(['Sample Paid']);
      expect(await trx('payroll_checks').where({ technician_id: idle }).count('* as n').first().then((r) => Number(r.n))).toBe(0);
      const restored = (await offDay(idle, addDays(W1, 2), 'pto', '480.00').returning('id'))[0];
      const restoredId = restored.id || restored;

      const put = await api('PUT', `/time-off/${restoredId}`, { body: { kind: 'pto', hours: 4 } });
      expect([put.status, put.body.error]).toEqual([409, LOCK]);
      const del = await api('DELETE', `/time-off/${restoredId}`);
      expect([del.status, del.body.error]).toEqual([409, LOCK]);
      expect(await trx('payroll_time_off').where({ id: restoredId }).first('minutes')).toEqual({ minutes: '480.00' });

      expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      expect((await api('PUT', `/time-off/${restoredId}`, { body: { kind: 'pto', hours: 4 } })).status).toBe(200);
      const redone = (await draft(W1)).body.run;
      expect(byName(redone, 'Sample Idle')).toMatchObject({ ptoHours: '4.00', grossCents: 8800 });
      expect((await finalize(redone.id)).status).toBe(200);
      expect((await api('DELETE', `/time-off/${restoredId}`)).status).toBe(409);
    });

    it('does not lock a week whose only check is a draft or voided', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '1800.00');
      const row = (await offDay(id, addDays(W1, 3), 'holiday', '600.00').returning('id'))[0];
      const entryId = row.id || row;
      await draft(W1);
      expect((await api('PUT', `/time-off/${entryId}`, { body: { kind: 'holiday', hours: 5 } })).status).toBe(200);
    });
  });
  describe('a paid week stays closed to time entry changes, even a time-off-only week', () => {
    const PAID = 'This week is already paid. Void its pay run before changing its entries.';
    const shift = async (technicianId, day, patch = {}) => {
      const id = randomUUID();
      await trx('time_entries').insert({
        id, technician_id: technicianId, entry_type: 'shift', status: 'completed', approval_status: 'pending',
        clock_in: `${day}T14:00:00Z`, clock_out: `${day}T22:00:00Z`, duration_minutes: 480, ...patch,
      });
      return id;
    };
    const timeOffOnlyPaid = async () => {
      const id = await readyTech('Sample Alpha');
      await offDay(id, addDays(W1, 1), 'pto', '480.00');
      const run = await draftAndFinalize(W1);
      expect(run.checks.map((c) => [c.name, c.regularHours, c.ptoHours])).toEqual([['Sample Alpha', '0.00', '8.00']]);
      return { id, run };
    };

    it('refuses to move an unapproved shift into the paid week, and to void one inside it; a void of the pay run frees both', async () => {
      const { id, run } = await timeOffOnlyPaid();
      // Next week has an unapproved shift; this week has no approved timesheet at all.
      const moving = await shift(id, addDays(W1, 8));
      const move = () => timeTracking.adminEditEntry(moving, {
        clock_in: `${addDays(W1, 2)}T14:00:00Z`, clock_out: `${addDays(W1, 2)}T22:00:00Z`,
        edit_reason: 'wrong day', edited_by: ADMIN_ID,
      });
      await expect(move()).rejects.toMatchObject({ statusCode: 409, message: PAID });
      expect(await trx('time_entries').where({ id: moving }).first('clock_in')).toMatchObject({ clock_in: new Date(`${addDays(W1, 8)}T14:00:00Z`) });

      // An entry that already sits in the paid week cannot be voided or edited either.
      const inside = await shift(id, addDays(W1, 3));
      await expect(timeTracking.voidEntry(inside, { reason: 'dup', voided_by: ADMIN_ID })).rejects.toMatchObject({ statusCode: 409, message: PAID });
      await expect(timeTracking.adminEditEntry(inside, { notes: 'x', edit_reason: 'x', edited_by: ADMIN_ID })).rejects.toMatchObject({ statusCode: 409, message: PAID });
      expect((await trx('time_entries').where({ id: inside }).first('status')).status).toBe('completed');

      // Other technicians and other weeks are not affected.
      const other = await readyTech('Sample Beta');
      const free = await shift(other, addDays(W1, 3));
      await expect(timeTracking.voidEntry(free, { reason: 'dup', voided_by: ADMIN_ID })).resolves.toMatchObject({ status: 'voided' });

      expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Redo' } })).status).toBe(200);
      await expect(move()).resolves.toMatchObject({ status: 'edited' });
      await expect(timeTracking.voidEntry(inside, { reason: 'dup', voided_by: ADMIN_ID })).resolves.toMatchObject({ status: 'voided' });
    });

    it('protects the week with the gate off too, once a time-off-only check exists', async () => {
      const { id } = await timeOffOnlyPaid();
      process.env.GATE_PAYROLL_TIME_OFF = 'false';
      const inside = await shift(id, addDays(W1, 3));
      await expect(timeTracking.voidEntry(inside, { reason: 'dup', voided_by: ADMIN_ID })).rejects.toMatchObject({ statusCode: 409, message: PAID });
    });

    it('the shared payroll lock waits for a finalize in progress, and shared holders do not block each other', async () => {
      const holder = await holderDb.transaction();
      await holder.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [payrollRuns.PAYROLL_LOCK_NS, payrollRuns.PAYROLL_LOCK_KEY]);
      try {
        // The edit runs on its own connection with a lock timeout, so the held lock shows as 55P03.
        const timedOut = await callerDb.transaction(async (t) => {
          await t.raw("SET LOCAL lock_timeout = '300ms'");
          return t.raw('SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?::text))', [payrollRuns.PAYROLL_LOCK_NS, payrollRuns.PAYROLL_LOCK_KEY]);
        }).catch((err) => err);
        expect(timedOut.code).toBe('55P03');
      } finally {
        await holder.commit();
      }
      // Shared holders do not block each other.
      const a = await callerDb.transaction();
      const b = await holderDb.transaction();
      try {
        await a.raw('SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?::text))', [payrollRuns.PAYROLL_LOCK_NS, payrollRuns.PAYROLL_LOCK_KEY]);
        await b.raw("SET LOCAL lock_timeout = '300ms'");
        await b.raw('SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?::text))', [payrollRuns.PAYROLL_LOCK_NS, payrollRuns.PAYROLL_LOCK_KEY]);
      } finally {
        await a.commit();
        await b.commit();
      }
    });
  });

  describe('sharing the finalize lock', () => {
    // The service runs on its own connection with a lock timeout, so a held lock shows up as a
    // timeout (55P03) and a free one as the ordinary 404 for an entry that does not exist. Nothing
    // is written: every call here ends in a 404 or a timeout.
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
      create: (conn) => timeOff.createTimeOff({ technicianId: randomUUID(), workDate: etDateString(), kind: 'pto', hours: 8 }, ADMIN_ID, conn),
      update: (conn) => timeOff.updateTimeOff(randomUUID(), { kind: 'pto', hours: 8 }, ADMIN_ID, conn),
      delete: (conn) => timeOff.deleteTimeOff(randomUUID(), ADMIN_ID, conn),
    };

    it.each(Object.keys(calls))('%s waits while a finalize holds the lock, then goes on', async (name) => {
      const holder = await takeLock();
      try {
        const timedOut = await calls[name](callerWith('300ms')).catch((err) => err);
        expect(timedOut.code).toBe('55P03');
      } finally {
        await holder.commit();
      }
      await expect(calls[name](callerWith('300ms'))).rejects.toMatchObject({ status: 404 });
    });
  });
});
