// Real PostgreSQL transactions (rolled back): the family employee setting (the owner's parent
// or spouse) on pay runs, behind GATE_PAYROLL_FAMILY_EMPLOYEE (owner 2026-10-29, D5 part 2).
// A check dated on or after the start date skips FUTA and Florida reemployment tax and
// nothing else; the check stores that; the Tax page calendar and the RT-6 and Form 940
// figures read the stored columns. With the gate off nothing changes. All names are synthetic.
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
const { syncPayrollFilings } = require('../services/payroll-tax-calendar');

jest.setTimeout(60000);

// Finished staff weeks in 2026 (Monday dates). Pay dates default to the Friday after.
const W1 = '2026-09-14'; // pay Fri 2026-09-25
const W2 = '2026-09-21'; // pay Fri 2026-10-02
const TODAY = '2026-10-20';

const GATES = ['GATE_PAYROLL', 'GATE_PAYROLL_FAMILY_EMPLOYEE', 'GATE_PAYROLL_FORM_FIGURES', 'GATE_PAYROLL_TAX_CALENDAR', 'GATE_PAYROLL_PAY_LINES'];

postgres('payroll family employee', () => {
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
      id, name: 'Sample Employee', employment_type: 'w2', employment_status: 'active', pay_rate: '23.00', ...patch,
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
  const api = async (method, path, { body, role } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID, ...(role ? { 'x-test-role': role } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const setFamily = (id, body) => api('PUT', `/technicians/${id}/family-employment`, { body });
  const parentFrom = (id, exemptFrom = '2026-09-25') => setFamily(id, { relationship: 'parent', entity: 'single_member_llc', exemptFrom });
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
  const stored = (id) => trx('payroll_checks').where({ id }).first('unemployment_exempt', 'unemployment_wages_cents', 'futa_cents', 'fl_reemployment_cents');
  const forms = async () => (await api('GET', '/forms?year=2026&quarter=3')).body;
  const line = (form, id) => form.rows.find((r) => r.line === id);
  const calendarRt6 = async () => {
    await syncPayrollFilings({ conn: trx, today: TODAY });
    return (await trx('tax_filing_calendar').where({ source_key: 'payroll:rt6:2026-Q3' }).first('amount_due')).amount_due;
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
    jest.clearAllMocks();
    process.env.GATE_PAYROLL = 'true';
    process.env.GATE_PAYROLL_FAMILY_EMPLOYEE = 'true';
    process.env.GATE_PAYROLL_FORM_FIGURES = 'true';
    process.env.GATE_PAYROLL_TAX_CALENDAR = 'true';
    delete process.env.GATE_PAYROLL_PAY_LINES;
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

  describe('the setting route', () => {
    it('answers 404 and writes nothing while the gate is off, and the list carries no setting', async () => {
      delete process.env.GATE_PAYROLL_FAMILY_EMPLOYEE;
      const id = await readyTech('Sample Parent');
      const response = await parentFrom(id);
      expect([response.status, response.body]).toEqual([404, { enabled: false }]);
      const row = await trx('technicians').where({ id }).first('family_relationship', 'family_employer_entity', 'family_exempt_from');
      expect(row).toEqual({ family_relationship: null, family_employer_entity: null, family_exempt_from: null });
      const listed = await api('GET', '/technicians');
      expect(listed.body.technicians.find((t) => t.id === id)).not.toHaveProperty('familyEmployment');
    });

    it('sets, lists and clears the setting, with an audit event that holds ids only', async () => {
      const id = await readyTech('Sample Parent');
      const set = await parentFrom(id, '2026-09-25');
      expect(set.status).toBe(200);
      expect(set.body.technician).toEqual({ id, familyEmployment: { relationship: 'parent', entity: 'single_member_llc', exemptFrom: '2026-09-25' } });
      const listed = await api('GET', '/technicians');
      expect(listed.body.technicians.find((t) => t.id === id).familyEmployment)
        .toEqual({ relationship: 'parent', entity: 'single_member_llc', exemptFrom: '2026-09-25' });
      const audit = await trx('audit_log').where({ action: 'payroll.family_employment_changed', resource_id: id }).first();
      expect(audit.metadata).toEqual({ technician_id: id });
      const cleared = await setFamily(id, { relationship: null });
      expect(cleared.body.technician).toEqual({ id, familyEmployment: null });
      expect(await trx('technicians').where({ id }).first('family_relationship', 'family_employer_entity', 'family_exempt_from'))
        .toEqual({ family_relationship: null, family_employer_entity: null, family_exempt_from: null });
      const afterClear = await api('GET', '/technicians');
      expect(afterClear.body.technicians.find((t) => t.id === id).familyEmployment).toBeNull();
      expect(Number((await trx('audit_log').where({ action: 'payroll.family_employment_changed', resource_id: id }).count('* as n').first()).n)).toBe(2);
    });

    it('refuses a bad relationship, entity or date, a contractor and a non-admin, and changes nothing', async () => {
      const id = await readyTech('Sample Parent');
      const contractor = await technician({ name: 'Sample Contractor', employment_type: '1099' });
      const good = { relationship: 'parent', entity: 'single_member_llc', exemptFrom: '2026-09-25' };
      for (const [patch, status] of [
        [{ relationship: 'child' }, 400],
        [{ relationship: 'cousin' }, 400],
        [{ entity: 's_corporation' }, 400],
        [{ entity: null }, 400],
        [{ exemptFrom: '2026-02-30' }, 400],
        [{ exemptFrom: '2019-12-31' }, 400],
        [{ exemptFrom: null }, 400],
        [{ extra: true }, 400],
      ]) {
        const response = await setFamily(id, { ...good, ...patch });
        expect([JSON.stringify(patch), response.status]).toEqual([JSON.stringify(patch), status]);
      }
      expect((await setFamily(id, { relationship: 'parent' })).status).toBe(400);
      expect((await setFamily(randomUUID(), good)).status).toBe(404);
      expect((await setFamily('not-an-id', good)).status).toBe(404);
      expect((await setFamily(contractor, good)).status).toBe(409);
      expect((await api('PUT', `/technicians/${id}/family-employment`, { body: good, role: 'technician' })).status).toBe(403);
      expect((await trx('technicians').where({ id }).first('family_relationship')).family_relationship).toBeNull();
      expect((await trx('technicians').where({ id: contractor }).first('family_relationship')).family_relationship).toBeNull();
    });

    it('is held by the database: all three fields or none', async () => {
      const id = await readyTech('Sample Parent');
      await trx.raw('SAVEPOINT attempt');
      await expect(trx('technicians').where({ id }).update({ family_relationship: 'parent' })).rejects.toThrow(/technicians_family_all_or_none_check/);
      await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    });
  });

  describe('on a pay run', () => {
    async function weekWithTwins(exemptFrom = '2026-09-25') {
      const parent = await readyTech('Sample Parent');
      const twin = await readyTech('Sample Twin');
      await parentFrom(parent, exemptFrom);
      for (const id of [parent, twin]) await approvedWeek(id, W1, '2400.00', '120.00');
      return { parent, twin };
    }

    it('skips FUTA and Florida tax for a check paid on the start date, and nothing else', async () => {
      await weekWithTwins();
      const run = await draftAndFinalize(W1);
      const parent = byName(run, 'Sample Parent');
      const twin = byName(run, 'Sample Twin');
      expect(twin.futaCents).toBeGreaterThan(0);
      expect(twin.flReemploymentCents).toBeGreaterThan(0);
      expect([parent.futaCents, parent.flReemploymentCents]).toEqual([0, 0]);
      for (const key of ['grossCents', 'federalIncomeTaxCents', 'socialSecurityCents', 'medicareCents', 'additionalMedicareCents', 'netCents',
        'employerSocialSecurityCents', 'employerMedicareCents']) {
        expect([key, parent[key]]).toEqual([key, twin[key]]);
      }
      expect(await stored(parent.id)).toMatchObject({ unemployment_exempt: true, unemployment_wages_cents: '0', futa_cents: '0', fl_reemployment_cents: '0' });
      expect(await stored(twin.id)).toMatchObject({ unemployment_exempt: false, unemployment_wages_cents: String(twin.grossCents) });
      const snapshot = (await trx('payroll_checks').where({ id: parent.id }).first('calc_snapshot')).calc_snapshot;
      expect(snapshot).toMatchObject({ unemploymentExempt: true, taxableWages: { futaCents: 0, floridaReemploymentCents: 0 } });
    });

    it('does not exempt a check paid before the start date', async () => {
      await weekWithTwins('2026-09-26');
      const run = await draftAndFinalize(W1);
      const parent = byName(run, 'Sample Parent');
      expect(parent.futaCents).toBe(byName(run, 'Sample Twin').futaCents);
      expect(await stored(parent.id)).toMatchObject({ unemployment_exempt: false });
    });

    it('stores nothing and exempts nobody with the gate off', async () => {
      await weekWithTwins();
      delete process.env.GATE_PAYROLL_FAMILY_EMPLOYEE;
      const run = await draftAndFinalize(W1);
      const parent = byName(run, 'Sample Parent');
      expect(parent.futaCents).toBe(byName(run, 'Sample Twin').futaCents);
      expect(await stored(parent.id)).toMatchObject({ unemployment_exempt: null, unemployment_wages_cents: null });
    });

    it('makes the draft stale when the setting changes, and when the gate is turned off under it', async () => {
      const { parent } = await weekWithTwins();
      const created = await draft(W1);
      const runId = created.body.run.id;
      expect(created.body.run.stale).toBe(false);
      await setFamily(parent, { relationship: null });
      const shown = await api('GET', `/runs/${runId}`);
      expect(shown.body.run.stale).toBe(true);
      const refused = await api('POST', `/runs/${runId}/finalize`, { body: { token: created.body.run.token } });
      expect(refused.status).toBe(409);
      // The refused finalize kept the fresh numbers as the draft: the parent now pays FUTA.
      const fresh = await api('GET', `/runs/${runId}`);
      expect(fresh.body.run.stale).toBe(false);
      expect(byName(fresh.body.run, 'Sample Parent').futaCents).toBeGreaterThan(0);
      // A draft that stored the exemption goes stale when the gate is turned off.
      await parentFrom(parent);
      await api('POST', `/runs/${runId}/recompute`);
      expect((await api('GET', `/runs/${runId}`)).body.run.stale).toBe(false);
      delete process.env.GATE_PAYROLL_FAMILY_EMPLOYEE;
      expect((await api('GET', `/runs/${runId}`)).body.run.stale).toBe(true);
    });

    it('counts non-exempt pay only toward the $7,000 base, across a cleared setting', async () => {
      const parent = await readyTech('Sample Parent', { pay_rate: '200.00' });
      await parentFrom(parent, '2026-09-25');
      await approvedWeek(parent, W1);
      await approvedWeek(parent, W2);
      const first = await draftAndFinalize(W1);
      expect(byName(first, 'Sample Parent').futaCents).toBe(0);
      await setFamily(parent, { relationship: null });
      const second = await draftAndFinalize(W2);
      const check = byName(second, 'Sample Parent');
      // $8,000 of exempt pay earlier used none of the base; this check is capped at $7,000 of its own.
      expect(check.ytdGrossBeforeCents).toBe(800000);
      expect(check.futaCents).toBe(4200);
      expect(check.flReemploymentCents).toBe(18900);
      expect(await stored(check.id)).toMatchObject({ unemployment_exempt: false, unemployment_wages_cents: '700000' });
    });
  });

  describe('after the gate is turned off', () => {
    it('keeps earlier exempt pay out of the $7,000 base, and stores nothing for anyone with no exempt pay', async () => {
      const parent = await readyTech('Sample Parent', { pay_rate: '200.00' });
      const plain = await readyTech('Sample Plain', { pay_rate: '200.00' });
      await parentFrom(parent, '2026-09-25');
      for (const id of [parent, plain]) {
        await approvedWeek(id, W1);
        await approvedWeek(id, W2);
      }
      const first = await draftAndFinalize(W1);
      expect(byName(first, 'Sample Parent').futaCents).toBe(0);
      delete process.env.GATE_PAYROLL_FAMILY_EMPLOYEE;
      const second = await draftAndFinalize(W2);
      // No exemption now, but the $8,000 of exempt pay in W1 used none of the base.
      const check = byName(second, 'Sample Parent');
      expect(check).toMatchObject({ futaCents: 4200, flReemploymentCents: 18900 });
      expect(await stored(check.id)).toMatchObject({ unemployment_exempt: false, unemployment_wages_cents: '700000' });
      // No exempt pay this year: today's math (W1 used up the base) and nothing stored.
      const other = byName(second, 'Sample Plain');
      expect(other.futaCents).toBe(0);
      expect(await stored(other.id)).toMatchObject({ unemployment_exempt: null, unemployment_wages_cents: null });
    });
  });

  describe('the Tax page calendar and the tax form figures', () => {
    async function paidWeek() {
      const parent = await readyTech('Sample Parent');
      const twin = await readyTech('Sample Twin');
      await parentFrom(parent);
      for (const id of [parent, twin]) await approvedWeek(id, W1, '2400.00', '120.00');
      return draftAndFinalize(W1);
    }

    it('leave her out of the RT-6 and Form 940 line 5, and list her pay as exempt on Form 940 line 4', async () => {
      const run = await paidWeek();
      const gross = byName(run, 'Sample Parent').grossCents;
      const twinFl = byName(run, 'Sample Twin').flReemploymentCents;
      const figures = await forms();
      expect(line(figures.rt6, '2').value).toBe(gross);
      expect(line(figures.rt6, '4').value).toBe(gross);
      expect(line(figures.rt6, '5').value).toBe(twinFl);
      expect(figures.rt6.employees.map((e) => e.name)).toEqual(['Sample Twin']);
      expect(line(figures.f940, '3').value).toBe(gross * 2);
      expect(line(figures.f940, '4').value).toBe(gross);
      expect(line(figures.f940, '4').note).toMatch(/box 4e/);
      expect(line(figures.f940, '7').value).toBe(gross);
      expect(line(figures.f941, '2').value).toBe(gross * 2);
      expect(figures.w2.find((f) => f.name === 'Sample Parent').box1).toBe(gross);
      expect(await calendarRt6()).toBe((twinFl / 100).toFixed(2));
    });

    it('read the same after the gate is turned off', async () => {
      await paidWeek();
      const before = await forms();
      const calendarBefore = await calendarRt6();
      delete process.env.GATE_PAYROLL_FAMILY_EMPLOYEE;
      expect(await forms()).toEqual(before);
      expect(await calendarRt6()).toBe(calendarBefore);
    });

    it('read a run drafted with the gate off exactly as before', async () => {
      const parent = await readyTech('Sample Parent');
      await approvedWeek(parent, W1, '2400.00', '120.00');
      await parentFrom(parent);
      delete process.env.GATE_PAYROLL_FAMILY_EMPLOYEE;
      const run = await draftAndFinalize(W1);
      const check = byName(run, 'Sample Parent');
      const figures = await forms();
      expect(line(figures.rt6, '5').value).toBe(check.flReemploymentCents);
      expect(line(figures.f940, '4').value).toBe(0);
      expect(await calendarRt6()).toBe((check.flReemploymentCents / 100).toFixed(2));
    });
  });
});
