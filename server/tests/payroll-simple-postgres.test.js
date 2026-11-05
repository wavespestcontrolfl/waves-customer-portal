// Real PostgreSQL transactions (rolled back): the SIMPLE IRA election table (CHECKs, no-edit trigger,
// W-2 only, the election in force), pay runs that read it (the deferral and Waves' 2% stored on the
// check, year to date, a stale draft, the stub and CSV), the form figures read from the stored checks,
// and a run with no election that is unchanged. All names are synthetic.
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
const payrollSimple = require('../services/payroll-simple');
const { readFormFigures } = require('../services/payroll-form-figures');

jest.setTimeout(60000);

const W1 = '2026-09-14'; // pay Fri 2026-09-25
const W2 = '2026-09-21'; // pay Fri 2026-10-02

postgres('payroll SIMPLE IRA elections and pay runs', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD_GATE = process.env.GATE_PAYROLL;
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
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const election = (technicianId, patch = {}) => trx('payroll_simple_ira_elections').insert({
    technician_id: technicianId, participant: true, signed_on: '2026-01-02', effective_on: '2026-01-02', ...patch,
  }).returning('id');
  const approvedWeek = (technicianId, weekStart, regular = '2400.00') => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: regular, overtime_minutes: '0.00',
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
  const draftAndFinalize = async (weekStart) => {
    const created = await api('POST', '/runs', { body: { weekStart } });
    expect(created.status).toBe(201);
    const done = await api('POST', `/runs/${created.body.run.id}/finalize`, { body: { token: created.body.run.token } });
    expect(done.status).toBe(200);
    return done.body.run;
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

  describe('the election table', () => {
    it('refuses a percent and a dollar amount together, a non-participant with a deferral, and out-of-range figures', async () => {
      const id = await technician();
      expect(await refused(() => election(id, { deferral_bp: 300, deferral_cents: 5000 }))).toBeTruthy();
      expect(await refused(() => election(id, { participant: false, deferral_bp: 300 }))).toBeTruthy();
      expect(await refused(() => election(id, { participant: false, deferral_cents: 100 }))).toBeTruthy();
      expect(await refused(() => election(id, { deferral_bp: 10001 }))).toBeTruthy();
      expect(await refused(() => election(id, { deferral_bp: -1 }))).toBeTruthy();
      expect(await refused(() => election(id, { deferral_cents: -1 }))).toBeTruthy();
      expect(await refused(() => election(id, { note: 'x'.repeat(501) }))).toBeTruthy();
      expect(await refused(() => election(id, { participant: false }))).toBeUndefined();
      expect(await refused(() => election(id, { deferral_bp: 10000 }))).toBeUndefined();
    });

    it('is evidence: an update or a delete is refused', async () => {
      const id = await technician();
      const [row] = await election(id, { deferral_bp: 300 });
      const rowId = row.id || row;
      expect(String((await refused(() => trx('payroll_simple_ira_elections').where({ id: rowId }).update({ deferral_bp: 400 }))).message))
        .toMatch(/cannot be changed or deleted/);
      expect(String((await refused(() => trx('payroll_simple_ira_elections').where({ id: rowId }).del())).message))
        .toMatch(/cannot be changed or deleted/);
    });

    it('a stored check holds all three figures or none', async () => {
      const id = await technician();
      await approvedWeek(id, W1);
      const run = (await api('POST', '/runs', { body: { weekStart: W1 } })).body.run;
      const [row] = await election(id);
      const checkId = run.checks[0].id;
      // Draft rows may change; the CHECK is about the three columns together.
      expect(await refused(() => trx('payroll_checks').where({ id: checkId }).update({ simple_election_id: row.id || row }))).toBeTruthy();
      expect(await refused(() => trx('payroll_checks').where({ id: checkId }).update({ simple_deferral_cents: -1, simple_employer_cents: 0, simple_election_id: row.id || row }))).toBeTruthy();
    });

    it('currentSimpleFor takes the latest effective election not after the pay date; a same-day correction wins', async () => {
      const id = await technician();
      await election(id, { deferral_bp: 300, effective_on: '2026-09-01' });
      await election(id, { deferral_bp: 500, effective_on: '2026-10-01' });
      expect(await payrollSimple.currentSimpleFor(id, '2026-08-31', trx)).toBeNull();
      expect(await payrollSimple.currentSimpleFor(id, '2026-09-25', trx)).toMatchObject({ deferralBp: 300, participant: true });
      expect(await payrollSimple.currentSimpleFor(id, '2026-10-02', trx)).toMatchObject({ deferralBp: 500 });
      expect((await payrollSimple.withCurrentSimple([{ id, name: 'Sample Employee' }], trx))[0].currentSimple).toMatchObject({ participant: true });
      // now() is the transaction start in a test, so the correction gets a later created_at by hand.
      await election(id, { participant: false, effective_on: '2026-10-01', created_at: new Date(Date.now() + 60000) });
      expect(await payrollSimple.currentSimpleFor(id, '2026-10-02', trx)).toMatchObject({ participant: false, deferralBp: null });
      expect(await payrollSimple.simpleInputFor(id, '2026-10-02', { deferral: 0, compensation: 0 }, trx)).toBeUndefined();
    });
  });

  describe('the admin route', () => {
    it('records an election as a new row, lists newest first, and refuses bad input and non-employees', async () => {
      const id = await technician();
      const created = await api('POST', `/technicians/${id}/simple-ira`, {
        body: { participant: true, deferralPercent: '3.5', signedOn: '2026-09-01', effectiveOn: '2027-01-04', note: 'Typed from the signed form' },
      });
      expect(created.status).toBe(201);
      expect(created.body.election).toMatchObject({ participant: true, deferralBp: 350, deferralCents: null, signedOn: '2026-09-01', effectiveOn: '2027-01-04' });
      // A form signed before the plan starts waits for the plan start unless a later date is typed.
      const fixed = await api('POST', `/technicians/${id}/simple-ira`, {
        body: { participant: true, deferralDollars: '25.50', signedOn: '2026-09-02' },
      });
      expect(fixed.body.election).toMatchObject({ deferralBp: null, deferralCents: 2550, effectiveOn: '2027-01-01' });
      const early = await api('POST', `/technicians/${id}/simple-ira`, {
        body: { participant: true, deferralDollars: '10', signedOn: '2026-09-02', effectiveOn: '2026-12-31' },
      });
      expect(early.status).toBe(400);
      expect(early.body.error).toMatch(/plan starts/);
      // Neither applies today, so the Payroll tab shows no election yet.
      const rows = (await api('GET', '/technicians')).body.technicians;
      expect(rows.find((t) => t.id === id).currentSimple).toBeNull();
      const listed = await api('GET', `/technicians/${id}/simple-ira`);
      expect(listed.body.elections.map((e) => e.effectiveOn)).toEqual(['2027-01-04', '2027-01-01']);
      const audit = await trx('audit_log').where({ action: 'payroll.simple_ira_recorded' });
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit[0].metadata)).not.toMatch(/350|Typed/);

      const both = await api('POST', `/technicians/${id}/simple-ira`, { body: { participant: true, deferralPercent: '3', deferralDollars: '10', signedOn: '2026-09-01' } });
      expect(both.status).toBe(400);
      const out = await api('POST', `/technicians/${id}/simple-ira`, { body: { participant: false, deferralPercent: '3', signedOn: '2026-09-01' } });
      expect(out.status).toBe(400);
      const future = await api('POST', `/technicians/${id}/simple-ira`, { body: { participant: true, signedOn: '2099-01-01' } });
      expect(future.status).toBe(400);
      const noAnswer = await api('POST', `/technicians/${id}/simple-ira`, { body: { signedOn: '2026-09-01' } });
      expect(noAnswer.status).toBe(400);
      const contractor = await technician({ employment_type: '1099' });
      expect((await api('POST', `/technicians/${contractor}/simple-ira`, { body: { participant: true, signedOn: '2026-09-01' } })).status).toBe(409);
      expect((await api('POST', '/technicians/not-an-id/simple-ira', { body: { participant: true, signedOn: '2026-09-01' } })).status).toBe(404);
    });
  });

  describe('pay runs', () => {
    it('with no election every check keeps exactly its earlier figures and keys', async () => {
      const id = await technician({ name: 'Sample Alpha' });
      await approvedWeek(id, W1);
      const run = (await api('POST', '/runs', { body: { weekStart: W1 } })).body.run;
      const [check] = run.checks;
      expect(check).not.toHaveProperty('simpleDeferralCents');
      expect(check.netCents).toBe(check.grossCents - check.federalIncomeTaxCents - check.socialSecurityCents - check.medicareCents);
      const row = await trx('payroll_checks').where({ id: check.id }).first();
      expect([row.simple_election_id, row.simple_deferral_cents, row.simple_employer_cents]).toEqual([null, null, null]);
      expect(row.calc_snapshot).not.toHaveProperty('simpleDeferralCents');
      const nonParticipant = await technician({ name: 'Sample Beta' });
      await election(nonParticipant, { participant: false });
      await approvedWeek(nonParticipant, W1);
      const again = (await api('POST', `/runs/${run.id}/recompute`)).body.run;
      expect(again.checks.find((c) => c.name === 'Sample Beta')).not.toHaveProperty('simpleDeferralCents');
    });

    it('a participant saves from each check before income tax; Waves 2% rides on the check; net pay and the token follow', async () => {
      const id = await technician({ name: 'Sample Alpha' });
      await approvedWeek(id, W1);
      const before = (await api('POST', '/runs', { body: { weekStart: W1 } })).body.run;
      const plainCheck = before.checks[0];
      await api('POST', `/runs/${before.id}/void`, { body: { reason: 'Redo with the SIMPLE IRA election' } });

      const [saved] = await election(id, { deferral_bp: 500 });
      const created = await api('POST', '/runs', { body: { weekStart: W1 } });
      const check = created.body.run.checks[0];
      expect(check).toMatchObject({ grossCents: 88000, simpleDeferralCents: 4400, simpleEmployerCents: 1760 });
      expect(check.federalIncomeTaxCents).toBeLessThan(plainCheck.federalIncomeTaxCents);
      expect(check.socialSecurityCents).toBe(plainCheck.socialSecurityCents);
      expect(check.medicareCents).toBe(plainCheck.medicareCents);
      expect(check.futaCents).toBe(plainCheck.futaCents);
      expect(check.netCents).toBe(88000 - check.federalIncomeTaxCents - check.socialSecurityCents - check.medicareCents - 4400);
      const row = await trx('payroll_checks').where({ id: check.id }).first();
      expect(row.simple_election_id).toBe(saved.id || saved);
      expect(row.calc_snapshot.incomeTaxWagesCents).toBe(88000 - 4400);

      // A new election after drafting makes the draft stale until it is recomputed.
      await election(id, { deferral_bp: 1000, effective_on: '2026-09-10' });
      const shown = await api('GET', `/runs/${created.body.run.id}`);
      expect(shown.body.run.stale).toBe(true);
      const recomputed = await api('POST', `/runs/${created.body.run.id}/recompute`);
      expect(recomputed.body.run.checks[0].simpleDeferralCents).toBe(8800);
    });

    it('the next check reads the year to date, the stub shows the line and foots to net pay, the CSV adds one column', async () => {
      const id = await technician({ name: 'Sample Alpha' });
      await election(id, { deferral_cents: 5000 });
      await approvedWeek(id, W1);
      await approvedWeek(id, W2);
      const first = await draftAndFinalize(W1);
      const ytd = await payrollSimple.simpleYtdBefore(trx, [id], '2026-10-02', W2);
      expect(ytd.get(id)).toEqual({ deferral: 5000, compensation: 88000 });
      expect((await payrollSimple.simpleYtdBefore(trx, [id], '2026-09-25', W1)).get(id)).toEqual({ deferral: 0, compensation: 0 });
      const second = await draftAndFinalize(W2);
      expect(second.checks[0].simpleDeferralCents).toBe(5000);

      const stub = (await api('GET', `/checks/${second.checks[0].id}/stub`)).body.stub;
      expect(stub.preTaxDeductions).toEqual({ simpleIraCents: 5000 });
      expect(stub.ytd.simpleIraCents).toBe(10000);
      expect(stub.netCents).toBe(stub.earnings.grossCents - stub.taxes.totalCents - stub.preTaxDeductions.simpleIraCents);

      const csv = await api('GET', `/runs/${first.id}/export.csv`, { raw: true });
      const [header, line] = csv.text.split('\n');
      expect(header.endsWith('SIMPLE IRA Savings')).toBe(true);
      expect(line.endsWith('50.00')).toBe(true);

      // A voided run no longer counts toward the year.
      await api('POST', `/runs/${second.id}/void`, { body: { reason: 'Test' } });
      await api('POST', `/runs/${first.id}/void`, { body: { reason: 'Test' } });
      expect((await payrollSimple.simpleYtdBefore(trx, [id], '2026-10-02', W2)).get(id)).toEqual({ deferral: 0, compensation: 0 });
    });

    it('a later check with no savings still shows the year-to-date savings, and no this-pay line', async () => {
      const id = await technician({ name: 'Sample Alpha' });
      await election(id, { deferral_cents: 5000, effective_on: '2026-01-02' });
      await election(id, { participant: false, effective_on: '2026-10-05', created_at: new Date(Date.now() + 60000) });
      await approvedWeek(id, W1);
      await approvedWeek(id, W2);
      await approvedWeek(id, '2026-09-28');
      await draftAndFinalize(W1);
      await draftAndFinalize(W2);
      const ended = await draftAndFinalize('2026-09-28');
      const stub = (await api('GET', `/checks/${ended.checks[0].id}/stub`)).body.stub;
      expect(stub).not.toHaveProperty('preTaxDeductions');
      expect(stub.ytd.simpleIraCents).toBe(10000);
    });

    it('a check with no election has no SIMPLE line on its stub and no CSV column', async () => {
      const id = await technician({ name: 'Sample Alpha' });
      await approvedWeek(id, W1);
      const run = await draftAndFinalize(W1);
      const stub = (await api('GET', `/checks/${run.checks[0].id}/stub`)).body.stub;
      expect(stub).not.toHaveProperty('preTaxDeductions');
      expect(stub.ytd).not.toHaveProperty('simpleIraCents');
      const csv = await api('GET', `/runs/${run.id}/export.csv`, { raw: true });
      expect(csv.text.split('\n')[0]).not.toMatch(/SIMPLE/);
    });
  });

  describe('form figures from the stored checks', () => {
    it('box 1 and Form 941 line 2 exclude the savings; boxes 3 and 5 and line 5c keep them; box 12 S and box 13 appear', async () => {
      const saver = await technician({ name: 'Sample Alpha' });
      const other = await technician({ name: 'Sample Beta' });
      await election(saver, { deferral_cents: 5000 });
      await approvedWeek(saver, W1);
      await approvedWeek(other, W1);
      await draftAndFinalize(W1);
      const figures = await readFormFigures({ year: 2026, quarter: 3, conn: trx });
      const w2 = Object.fromEntries(figures.w2.map((f) => [f.name, f]));
      expect(w2['Sample Alpha']).toMatchObject({ box1: 83000, box3: 88000, box5: 88000, box12S: 5000, box13RetirementPlan: true });
      expect(w2['Sample Beta']).toMatchObject({ box1: 88000, box3: 88000, box5: 88000 });
      expect(w2['Sample Beta']).not.toHaveProperty('box12S');
      expect(w2['Sample Beta']).not.toHaveProperty('box13RetirementPlan');
      expect(figures.w3.box1).toBe(83000 + 88000);
      const line = (n) => figures.f941.rows.find((r) => r.line === n);
      expect(line('2').value).toBe(83000 + 88000);
      expect(line('2').note).toMatch(/SIMPLE IRA/);
      expect(line('5c').value).toBe(88000 * 2);
      expect(line('5a').value).toBe(88000 * 2);
    });
  });
});
