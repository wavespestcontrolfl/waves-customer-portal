// Real PostgreSQL transactions (rolled back): pay lines (review bonus, commission,
// health allowance, employer HSA) on pay runs, behind GATE_PAYROLL_PAY_LINES. Lines
// attach to a draft, a changed line makes the draft stale, finalize marks them paid
// with the check, void reopens them, a paid line cannot be deleted or edited, a
// lines-only check pays a technician with no hours (one who has left too), a late
// commission is spread back over the weeks it covers, and the tax form figures read
// code TT and code W. With the gate off nothing changes. All names are synthetic.
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

jest.setTimeout(60000);

// Finished staff weeks in 2026 (Monday dates). Pay dates default to the Friday after.
const W1 = '2026-09-14'; // pay Fri 2026-09-25
const W2 = '2026-09-21'; // pay Fri 2026-10-02
const W3 = '2026-09-28'; // pay Fri 2026-10-09
const W4 = '2026-10-05'; // pay Fri 2026-10-16

const GATES = ['GATE_PAYROLL', 'GATE_PAYROLL_PAY_LINES', 'GATE_PAYROLL_FORM_FIGURES', 'GATE_PAYROLL_TIME_OFF'];

postgres('payroll pay lines', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  const ADMIN_ID = randomUUID();

  const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
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
  const addLine = async (technicianId, patch = {}) => {
    const created = await api('POST', '/pay-lines', {
      body: { kind: 'review_bonus', technicianId, amountCents: 3000, earnedWeekStart: W1, ...patch },
    });
    expect(created.status).toBe(201);
    return created.body.payLine;
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
  const byName = (run, name) => run.checks.find((c) => c.name === name);
  const lineRow = (id) => trx('payroll_pay_lines').where({ id }).first();

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
    process.env.GATE_PAYROLL_PAY_LINES = 'true';
    delete process.env.GATE_PAYROLL_FORM_FIGURES;
    delete process.env.GATE_PAYROLL_TIME_OFF;
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    await trx.rollback();
    for (const name of GATES) {
      if (OLD[name] === undefined) delete process.env[name]; else process.env[name] = OLD[name];
    }
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  describe('the routes', () => {
    it('answer 404 and touch nothing while the gate is off', async () => {
      delete process.env.GATE_PAYROLL_PAY_LINES;
      const id = await readyTech('Sample Alpha');
      for (const [method, path, body] of [
        ['GET', '/pay-lines'],
        ['POST', '/pay-lines', { kind: 'review_bonus', technicianId: id, amountCents: 3000, earnedWeekStart: W1 }],
        ['DELETE', `/pay-lines/${randomUUID()}`],
        ['PUT', `/technicians/${id}/flsa-coverage`, { covered: true }],
      ]) {
        const response = await api(method, path, { body });
        expect([method, path, response.status, response.body]).toEqual([method, path, 404, { enabled: false }]);
      }
      expect(Number((await trx('payroll_pay_lines').count('* as n').first()).n)).toBe(0);
      expect((await trx('technicians').where({ id }).first('flsa_overtime_covered')).flsa_overtime_covered).toBeNull();
    });

    it('are admin only', async () => {
      const response = await api('GET', '/pay-lines', { role: 'technician' });
      expect(response.status).toBe(403);
    });

    it('add, list and remove a line, with an audit event that holds ids and no amount', async () => {
      const id = await readyTech('Sample Alpha');
      const line = await addLine(id, { kind: 'commission', amountCents: 12345, note: 'Sample note' });
      expect(line).toMatchObject({
        technicianId: id, name: 'Sample Alpha', kind: 'commission', amountCents: 12345, earnedWeekStart: W1,
        coversFrom: null, coversTo: null, note: 'Sample note', status: 'open', checkId: null,
      });
      const audit = await trx('audit_log').where({ action: 'payroll.pay_line_created', resource_id: line.id }).first();
      expect(audit.metadata).toEqual({ pay_line_id: line.id, technician_id: id, kind: 'commission' });
      expect(JSON.stringify(audit.metadata)).not.toContain('12345');

      const listed = await api('GET', `/pay-lines?technicianId=${id}&status=open`);
      expect(listed.body.payLines.map((l) => l.id)).toEqual([line.id]);
      expect((await api('GET', `/pay-lines?technicianId=${id}&status=paid`)).body.payLines).toEqual([]);

      expect((await api('DELETE', `/pay-lines/${line.id}`)).body).toEqual({ deleted: true });
      expect(await lineRow(line.id)).toBeUndefined();
      const gone = await trx('audit_log').where({ action: 'payroll.pay_line_deleted', resource_id: line.id }).first();
      expect(gone.metadata).toEqual({ pay_line_id: line.id, technician_id: id, kind: 'commission' });
      expect((await api('DELETE', `/pay-lines/${line.id}`)).status).toBe(404);
    });

    it('refuse a bad kind, amount, week, span, technician and a contractor', async () => {
      const id = await readyTech('Sample Alpha');
      const contractor = await readyTech('Sample Contractor', { employment_type: '1099' });
      const post = (patch) => api('POST', '/pay-lines', { body: { kind: 'review_bonus', technicianId: id, amountCents: 3000, earnedWeekStart: W1, ...patch } });
      const cases = [
        [{ kind: 'tip' }, 400, /Pick a kind/],
        [{ amountCents: 0 }, 400, /more than \$0\.00/],
        [{ amountCents: 10.5 }, 400, /whole number of cents/],
        [{ amountCents: 20000000 }, 400, /at most/],
        [{ earnedWeekStart: '2026-09-15' }, 400, /Monday/],
        [{ earnedWeekStart: '2026-02-31' }, 400, /real date/],
        [{ coversFrom: '2026-09-01' }, 400, /both dates/],
        [{ coversFrom: '2026-09-10', coversTo: '2026-09-01' }, 400, /cannot be after/],
        [{ coversFrom: '2025-01-01', coversTo: '2026-09-13' }, 400, /at most 366 days/],
        [{ coversFrom: '2026-09-01', coversTo: '2026-09-30' }, 400, /holds the last covered date/],
        [{ technicianId: 'not-a-uuid' }, 404, /Technician not found/],
        [{ technicianId: randomUUID() }, 404, /Technician not found/],
        [{ technicianId: contractor }, 409, /W-2 employees/],
        [{ note: 'x'.repeat(501) }, 400, /at most 500/],
      ];
      for (const [patch, status, message] of cases) {
        const response = await post(patch);
        expect([JSON.stringify(patch), response.status]).toEqual([JSON.stringify(patch), status]);
        expect(response.body.error).toMatch(message);
      }
      expect(Number((await trx('payroll_pay_lines').count('* as n').first()).n)).toBe(0);
    });

    it('set and read whether overtime law covers an employee (W-2 only)', async () => {
      const id = await readyTech('Sample Alpha');
      const contractor = await readyTech('Sample Contractor', { employment_type: '1099' });
      const row = async () => (await trx('technicians').where({ id }).first('flsa_overtime_covered')).flsa_overtime_covered;
      expect(await row()).toBeNull();
      expect((await api('PUT', `/technicians/${id}/flsa-coverage`, { body: { covered: true } })).body)
        .toEqual({ technician: { id, flsaOvertimeCovered: true } });
      expect(await row()).toBe(true);
      expect((await api('PUT', `/technicians/${id}/flsa-coverage`, { body: { covered: null } })).body.technician.flsaOvertimeCovered).toBeNull();
      expect((await api('PUT', `/technicians/${id}/flsa-coverage`, { body: {} })).status).toBe(400);
      expect((await api('PUT', `/technicians/${contractor}/flsa-coverage`, { body: { covered: true } })).status).toBe(409);
      const listed = await api('GET', '/technicians');
      expect(listed.body.technicians.find((t) => t.id === id)).toMatchObject({ flsaOvertimeCovered: null });
      delete process.env.GATE_PAYROLL_PAY_LINES;
      expect((await api('GET', '/technicians')).body.technicians.find((t) => t.id === id)).not.toHaveProperty('flsaOvertimeCovered');
    });
  });

  describe('on a draft run', () => {
    it('attach to the technician check and add to gross, with the lines in the snapshot', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await addLine(id, { amountCents: 3000 });
      const allowance = await addLine(id, { kind: 'health_allowance', amountCents: 20000 });
      const created = await draft(W1);
      expect(created.status).toBe(201);
      const check = byName(created.body.run, 'Sample Alpha');
      expect(created.body.run.checks).toHaveLength(1);
      expect(check).toMatchObject({
        regularPayCents: 88000, reviewBonusCents: 3000, healthAllowanceCents: 20000, commissionCents: 0,
        hsaEmployerCents: 0, lineOvertimePremiumCents: 0, grossCents: 111000,
      });
      expect(check.payLines.map((l) => l.id).sort()).toEqual([bonus.id, allowance.id].sort());
      const row = await trx('payroll_checks').where({ id: check.id }).first();
      expect(row).toMatchObject({
        review_bonus_cents: '3000', health_allowance_cents: '20000', hsa_employer_cents: '0',
        line_overtime_premium_cents: '0', qualified_overtime_cents: '0', simple_compensation_cents: '111000',
      });
      expect(row.calc_snapshot.payLines).toHaveLength(2);
      // The lines stay open until the run is final.
      expect((await lineRow(bonus.id)).status).toBe('open');
    });

    it('pay the extra overtime a bonus and allowance cause, and fill code TT only for a covered employee', async () => {
      const id = await readyTech('Sample Alpha', { pay_rate: '23.00' });
      await approvedWeek(id, W1, '2400.00', '120.00');
      await addLine(id, { amountCents: 3000 });
      await addLine(id, { kind: 'health_allowance', amountCents: 4615 });
      const first = (await draft(W1)).body.run;
      const notSet = byName(first, 'Sample Alpha');
      expect(notSet).toMatchObject({ lineOvertimePremiumCents: 181 });
      expect((await trx('payroll_checks').where({ id: notSet.id }).first()).qualified_overtime_cents).toBe('0');
      await api('PUT', `/technicians/${id}/flsa-coverage`, { body: { covered: true } });
      const run = (await api('POST', `/runs/${first.id}/recompute`)).body.run;
      const covered = byName(run, 'Sample Alpha');
      expect(covered.lineOvertimePremiumCents).toBe(181);
      expect((await trx('payroll_checks').where({ id: covered.id }).first()).qualified_overtime_cents).toBe('2481');
      expect(covered.grossCents).toBe(92000 + 6900 + 3000 + 4615 + 181);
    });

    it('make a technician with lines and no hours a lines-only check, one who has left too', async () => {
      const left = await readyTech('Sample Former', { employment_status: 'inactive' });
      const line = await addLine(left, { kind: 'commission', amountCents: 50000, earnedWeekStart: W2 });
      const created = await draft(W2);
      expect(created.status).toBe(201);
      const check = byName(created.body.run, 'Sample Former');
      expect(check).toMatchObject({
        regularHours: '0.00', overtimeHours: '0.00', commissionCents: 50000, grossCents: 50000,
        socialSecurityCents: 3100, medicareCents: 725, lineOvertimePremiumCents: 0,
      });
      expect(check.netCents).toBe(50000 - check.federalIncomeTaxCents - 3100 - 725);
      const done = await finalize(created.body.run.id);
      expect(done.status).toBe(200);
      expect((await lineRow(line.id)).status).toBe('paid');
    });

    it('leave a technician whose worked time is still waiting for approval waiting, lines unpaid', async () => {
      const id = await readyTech('Sample Alpha');
      await trx('time_entry_daily_summary').insert({ technician_id: id, work_date: W1, total_shift_minutes: 480 });
      const line = await addLine(id);
      const created = await draft(W1);
      expect(created.body.run.checks).toEqual([]);
      expect(created.body.run.waiting.map((w) => w.name)).toEqual(['Sample Alpha']);
      expect((await lineRow(line.id)).status).toBe('open');
    });

    it('wait for the week they were earned: a line earned later is not on an earlier run', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const later = await addLine(id, { earnedWeekStart: W2 });
      const created = await draft(W1);
      expect(byName(created.body.run, 'Sample Alpha')).toMatchObject({ grossCents: 88000, reviewBonusCents: 0 });
      expect((await lineRow(later.id)).status).toBe('open');
    });

    it('spread a late commission back over the weeks it covers and pay a premium for the weeks that had overtime', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '2400.00', '0.00');
      await approvedWeek(id, W2, '2400.00', '240.00');
      await approvedWeek(id, W3, '2400.00', '60.00');
      // W4 has no approved timesheet: it counts as no hours worked.
      await api('PUT', `/technicians/${id}/flsa-coverage`, { body: { covered: true } });
      await addLine(id, { kind: 'commission', amountCents: 40000, coversFrom: W1, coversTo: '2026-10-11', earnedWeekStart: W4 });
      const created = await draft(W4);
      expect(created.status).toBe(201);
      const check = byName(created.body.run, 'Sample Alpha');
      expect(check).toMatchObject({ commissionCents: 40000, lineOvertimePremiumCents: 577, grossCents: 40577, regularHours: '0.00' });
      const row = await trx('payroll_checks').where({ id: check.id }).first();
      expect(row.qualified_overtime_cents).toBe('577');
      expect(row.calc_snapshot.lineOvertimeWeeks.map((w) => [w.weekStart, w.allocatedCents, w.premiumCents])).toEqual([
        [W1, 10000, 0], [W2, 10000, 455], [W3, 10000, 122], [W4, 10000, 0],
      ]);
    });

    it('pay a line added after its week was final on the next run, with the premium from its own week', async () => {
      const id = await readyTech('Sample Alpha', { pay_rate: '23.00' });
      await approvedWeek(id, W1, '2400.00', '120.00');
      await approvedWeek(id, W2, '2400.00', '0.00');
      await draftAndFinalize(W1);
      const line = await addLine(id, { amountCents: 7615, earnedWeekStart: W1 });
      const created = await draft(W2);
      const check = byName(created.body.run, 'Sample Alpha');
      // The bonus belongs to W1, which had 2 overtime hours of 42: 1/2 x (76.15 / 42) x 2 = 1.81.
      expect(check).toMatchObject({ reviewBonusCents: 7615, lineOvertimePremiumCents: 181 });
      expect((await finalize(created.body.run.id)).status).toBe(200);
      expect((await lineRow(line.id)).status).toBe('paid');
    });

    it('share one check with paid time off when both gates are on, and make a time-off-only check carry the lines', async () => {
      process.env.GATE_PAYROLL_TIME_OFF = 'true';
      const id = await readyTech('Sample Alpha');
      // No worked time that week: one paid day off, plus a commission earned the same week.
      await trx('payroll_time_off').insert({ technician_id: id, work_date: addDays(W2, 1), kind: 'pto', minutes: '480.00' });
      await addLine(id, { kind: 'commission', amountCents: 10000, earnedWeekStart: W2 });
      const created = await draft(W2);
      expect(created.status).toBe(201);
      expect(created.body.run.checks).toHaveLength(1);
      expect(byName(created.body.run, 'Sample Alpha')).toMatchObject({
        regularHours: '0.00', ptoPayCents: 17600, commissionCents: 10000, grossCents: 27600, lineOvertimePremiumCents: 0,
      });
    });

    it('keep the employer HSA money out of gross and net pay, and in the regular rate', async () => {
      const id = await readyTech('Sample Alpha', { pay_rate: '23.00' });
      await approvedWeek(id, W1, '2400.00', '120.00');
      await addLine(id, { kind: 'hsa_employer', amountCents: 20000 });
      const run = (await draft(W1)).body.run;
      const check = byName(run, 'Sample Alpha');
      // 1/2 x (200.00 / 42) x 2 = 4.76 on the same check, taxable as wages.
      expect(check).toMatchObject({ hsaEmployerCents: 20000, lineOvertimePremiumCents: 476, grossCents: 92000 + 6900 + 476 });
      expect(check.netCents).toBe(check.grossCents - check.federalIncomeTaxCents - check.socialSecurityCents - check.medicareCents);
      const done = await finalize(run.id);
      const stub = (await api('GET', `/checks/${byName(done.body.run, 'Sample Alpha').id}/stub`)).body.stub;
      expect(stub.employerContributions).toEqual({ hsaCents: 20000 });
      expect(stub.earnings).toMatchObject({ reviewBonusCents: 0, lineOvertimePremiumCents: 476, grossCents: check.grossCents });
    });
  });

  describe('a changed line', () => {
    it('makes the draft stale, and a recompute or a removal clears it', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const run = (await draft(W1)).body.run;
      expect(run.stale).toBe(false);
      const line = await addLine(id);
      const shown = (await api('GET', `/runs/${run.id}`)).body.run;
      expect(shown.stale).toBe(true);
      // Finalizing the old token is refused and the draft is replaced by the fresh numbers.
      const refusedFinalize = await api('POST', `/runs/${run.id}/finalize`, { body: { token: run.token } });
      expect(refusedFinalize.status).toBe(409);
      const fresh = (await api('GET', `/runs/${run.id}`)).body.run;
      expect(fresh.stale).toBe(false);
      expect(byName(fresh, 'Sample Alpha').reviewBonusCents).toBe(3000);
      // Removing the line makes the draft stale again.
      await api('DELETE', `/pay-lines/${line.id}`);
      expect((await api('GET', `/runs/${run.id}`)).body.run.stale).toBe(true);
      const recomputed = (await api('POST', `/runs/${run.id}/recompute`)).body.run;
      expect(recomputed.stale).toBe(false);
      expect(byName(recomputed, 'Sample Alpha').reviewBonusCents).toBe(0);
    });

    it('goes stale when the span of a line changes under the same id and amount', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W3, '2400.00', '0.00');
      const line = await addLine(id, { kind: 'commission', earnedWeekStart: W3, coversFrom: W2, coversTo: W3 });
      const run = (await draft(W3)).body.run;
      await trx('payroll_pay_lines').where({ id: line.id }).update({ covers_from: W3, covers_to: '2026-10-04' });
      expect((await api('GET', `/runs/${run.id}`)).body.run.stale).toBe(true);
    });
  });

  describe('finalize and void', () => {
    it('mark the lines paid with the check, and a void reopens them', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await addLine(id);
      const hsa = await addLine(id, { kind: 'hsa_employer', amountCents: 20000 });
      const run = await draftAndFinalize(W1);
      const check = byName(run, 'Sample Alpha');
      for (const line of [bonus, hsa]) {
        expect(await lineRow(line.id)).toMatchObject({ status: 'paid', check_id: check.id });
      }
      expect((await api('GET', `/pay-lines?technicianId=${id}&status=paid`)).body.payLines).toHaveLength(2);
      // Neither the next run nor the open list holds a paid line.
      expect((await api('GET', `/pay-lines?status=open`)).body.payLines).toEqual([]);

      const voided = await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Sample correction' } });
      expect(voided.status).toBe(200);
      for (const line of [bonus, hsa]) {
        expect(await lineRow(line.id)).toMatchObject({ status: 'open', check_id: null });
      }
      // The reopened lines go on the re-drafted run.
      const again = byName((await draft(W1)).body.run, 'Sample Alpha');
      expect(again).toMatchObject({ reviewBonusCents: 3000, hsaEmployerCents: 20000 });
    });

    it('never delete or change a paid line, by the route or the database', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const line = await addLine(id);
      await draftAndFinalize(W1);
      const response = await api('DELETE', `/pay-lines/${line.id}`);
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/not paid yet/);
      expect(await lineRow(line.id)).toMatchObject({ status: 'paid' });

      const deleteError = await refused(() => trx('payroll_pay_lines').where({ id: line.id }).del());
      expect(deleteError.message).toMatch(/paid or voided pay line cannot be deleted/);
      for (const change of [{ amount_cents: 1 }, { kind: 'commission' }, { earned_week_start: W2 }, { note: 'edited' }]) {
        const error = await refused(() => trx('payroll_pay_lines').where({ id: line.id }).update(change));
        expect(error.message).toMatch(/paid pay line cannot be changed/);
      }
      // Only the reopen of a voided run is allowed: status open, no check, nothing else changed.
      const half = await refused(() => trx('payroll_pay_lines').where({ id: line.id }).update({ status: 'open' }));
      expect(half).toBeTruthy();
    });

    it('refuse a status that does not match the check, and a repeat source', async () => {
      const id = await readyTech('Sample Alpha');
      const line = await addLine(id);
      const badStatus = await refused(() => trx('payroll_pay_lines').where({ id: line.id }).update({ status: 'paid' }));
      expect(badStatus.message).toMatch(/paid_check_id_check/);
      await trx('payroll_pay_lines').where({ id: line.id }).update({ source_type: 'review', source_id: 'r-1' });
      const repeat = await refused(() => trx('payroll_pay_lines').insert({
        technician_id: id, kind: 'review_bonus', amount_cents: 3000, earned_week_start: W1, source_type: 'review', source_id: 'r-1',
      }));
      expect(repeat.message).toMatch(/payroll_pay_lines_source_unique/);
      const half = await refused(() => trx('payroll_pay_lines').where({ id: line.id }).update({ source_type: 'review', source_id: null }));
      expect(half.message).toMatch(/source_pair_check/);
    });

    it('stop a second draft from paying a line the first run already paid', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await approvedWeek(id, W2);
      await addLine(id);
      const first = (await draft(W1)).body.run;
      const second = (await draft(W2)).body.run;
      expect(byName(second, 'Sample Alpha').reviewBonusCents).toBe(3000);
      expect((await finalize(first.id)).status).toBe(200);
      const shown = (await api('GET', `/runs/${second.id}`)).body.run;
      expect(shown.stale).toBe(true);
      const recomputed = (await api('POST', `/runs/${second.id}/recompute`)).body.run;
      expect(byName(recomputed, 'Sample Alpha').reviewBonusCents).toBe(0);
    });

    it('add the new columns to the CSV and the check row only with the gate on', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await addLine(id, { kind: 'hsa_employer', amountCents: 20000 });
      const run = await draftAndFinalize(W1);
      const on = await api('GET', `/runs/${run.id}/export.csv`, { raw: true });
      const headerOn = on.text.split('\n')[0];
      expect(headerOn).toMatch(/Check Number,Review Bonus,Commission,Health Allowance,Overtime On Bonus And Allowance,HSA From Waves$/);
      expect(on.text.split('\n')[1]).toMatch(/0\.00,0\.00,0\.00,0\.00,200\.00$/);
      delete process.env.GATE_PAYROLL_PAY_LINES;
      const off = await api('GET', `/runs/${run.id}/export.csv`, { raw: true });
      expect(off.text.split('\n')[0]).toMatch(/Pay Method,Check Number$/);
      const view = (await api('GET', `/runs/${run.id}`)).body.run;
      expect(view.checks[0]).not.toHaveProperty('hsaEmployerCents');
      expect(view.checks[0]).not.toHaveProperty('payLines');
    });
  });

  describe('with the gate off', () => {
    it('leaves an open line alone and writes a check exactly as before', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1, '2400.00', '120.00');
      const line = await addLine(id);
      delete process.env.GATE_PAYROLL_PAY_LINES;
      const run = (await draft(W1)).body.run;
      const check = byName(run, 'Sample Alpha');
      expect(check).toMatchObject({ regularPayCents: 88000, overtimePayCents: 6600, grossCents: 94600 });
      for (const key of ['reviewBonusCents', 'commissionCents', 'hsaEmployerCents', 'lineOvertimePremiumCents', 'payLines']) {
        expect(check).not.toHaveProperty(key);
      }
      const row = await trx('payroll_checks').where({ id: check.id }).first();
      for (const column of ['review_bonus_cents', 'commission_cents', 'health_allowance_cents', 'hsa_employer_cents',
        'line_overtime_premium_cents', 'qualified_overtime_cents', 'simple_compensation_cents']) {
        expect(row[column]).toBeNull();
      }
      expect(Object.keys(row.calc_snapshot)).not.toContain('payLines');
      const done = await finalize(run.id);
      expect(done.status).toBe(200);
      expect((await lineRow(line.id)).status).toBe('open');
      const stub = (await api('GET', `/checks/${byName(done.body.run, 'Sample Alpha').id}/stub`)).body.stub;
      expect(stub).not.toHaveProperty('employerContributions');
      expect(stub.earnings).not.toHaveProperty('reviewBonusCents');
    });

    it('does not draft a lines-only check', async () => {
      const left = await readyTech('Sample Former', { employment_status: 'inactive' });
      await addLine(left, { kind: 'commission', amountCents: 50000, earnedWeekStart: W2 });
      delete process.env.GATE_PAYROLL_PAY_LINES;
      const created = await draft(W2);
      expect(created.status).toBe(409);
      expect(created.body.error).toMatch(/No W-2 hours/);
    });

    it('still reopens a paid line when a run is voided after the gate was turned off', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const line = await addLine(id);
      const run = await draftAndFinalize(W1);
      delete process.env.GATE_PAYROLL_PAY_LINES;
      expect((await api('POST', `/runs/${run.id}/void`, { body: { reason: 'Sample correction' } })).status).toBe(200);
      expect(await lineRow(line.id)).toMatchObject({ status: 'open', check_id: null });
    });
  });

  describe('tax form figures', () => {
    const w2Of = (figures, name) => figures.w2.find((form) => form.name === name);
    const row940 = (figures, id) => figures.f940.rows.find((r) => r.line === id);
    const forms = async () => (await api('GET', '/forms?year=2026&quarter=3')).body;

    // Two employees in W1 (paid 2026-09-25), each with 2 overtime hours and $76.15 of lines.
    async function paidWeek() {
      const covered = await readyTech('Sample Covered', { pay_rate: '23.00' });
      const notCovered = await readyTech('Sample Notcovered', { pay_rate: '23.00' });
      await api('PUT', `/technicians/${covered}/flsa-coverage`, { body: { covered: true } });
      await api('PUT', `/technicians/${notCovered}/flsa-coverage`, { body: { covered: false } });
      for (const id of [covered, notCovered]) {
        await approvedWeek(id, W1, '2400.00', '120.00');
        await addLine(id, { amountCents: 3000 });
        await addLine(id, { kind: 'health_allowance', amountCents: 4615 });
      }
      await addLine(covered, { kind: 'hsa_employer', amountCents: 20000 });
      await draftAndFinalize(W1);
    }

    it('fill code TT from the stored qualified overtime and code W from the employer HSA money', async () => {
      process.env.GATE_PAYROLL_FORM_FIGURES = 'true';
      await paidWeek();
      const figures = await forms();
      const covered = w2Of(figures, 'Sample Covered');
      const notCovered = w2Of(figures, 'Sample Notcovered');
      // HSA line: 1/2 x ($276.15 / 42) x 2 = 6.58 for the covered employee: base 23.00 + 6.58 = 29.58.
      expect(covered).toMatchObject({ box12TT: 2300 + 658, box12W: 20000 });
      expect(notCovered.box12TT).toBeNull();
      expect(notCovered.box12W).toBeNull();
      // Boxes 1, 3 and 5 are wages: the HSA money is in none of them.
      expect(covered.box1).toBe(92000 + 6900 + 3000 + 4615 + 658);
      expect(covered.box3).toBe(covered.box1);
      expect(covered.box5).toBe(covered.box1);
      // Form 940: the HSA money is in line 3 and line 4 and leaves line 7 as wages only.
      const total = covered.box1 + notCovered.box1;
      expect(row940(figures, '3').value).toBe(total + 20000);
      expect(row940(figures, '4')).toMatchObject({ value: 20000 });
      expect(row940(figures, '4').note).toMatch(/4a/);
      expect(row940(figures, '7').value).toBe(total - row940(figures, '5').value);
      // Form 941 and RT-6 wages exclude it.
      expect(figures.f941.rows.find((r) => r.line === '2').value).toBe(total);
      expect(figures.rt6.rows.find((r) => r.line === '2').value).toBe(total);
    });

    it('count an old check with no stored figure for TT only when the employee is covered now', async () => {
      process.env.GATE_PAYROLL_FORM_FIGURES = 'true';
      const covered = await readyTech('Sample Covered', { pay_rate: '23.00' });
      const unset = await readyTech('Sample Unset', { pay_rate: '23.00' });
      await api('PUT', `/technicians/${covered}/flsa-coverage`, { body: { covered: true } });
      for (const id of [covered, unset]) await approvedWeek(id, W1, '2400.00', '120.00');
      delete process.env.GATE_PAYROLL_PAY_LINES;
      await draftAndFinalize(W1);
      process.env.GATE_PAYROLL_PAY_LINES = 'true';
      const figures = await forms();
      expect(w2Of(figures, 'Sample Covered')).toMatchObject({ box12TT: 2300, box12W: null });
      expect(w2Of(figures, 'Sample Unset').box12TT).toBeNull();
    });

    it('read exactly what they read before with the gate off', async () => {
      process.env.GATE_PAYROLL_FORM_FIGURES = 'true';
      await paidWeek();
      delete process.env.GATE_PAYROLL_PAY_LINES;
      const figures = await forms();
      const notCovered = w2Of(figures, 'Sample Notcovered');
      // Gate off: every overtime premium is reported, covered or not, and there is no code W.
      expect(notCovered.box12TT).toBe(2300);
      expect(notCovered).not.toHaveProperty('box12W');
      expect(row940(figures, '4').value).toBe(0);
      expect(row940(figures, '4')).not.toHaveProperty('note');
    });
  });
});
