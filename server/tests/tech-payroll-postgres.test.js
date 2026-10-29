// Real PostgreSQL transactions (rolled back): a technician reads only their own FINALIZED checks of
// finalized, not-voided pay runs, and the stub of one of them. Another person's check, a draft, a
// voided check and a bad id all answer 404. Goes through the router with the session id from a header.
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
  adminAuthenticate: (req, _res, next) => { req.technicianId = req.headers['x-test-tech'] || null; req.techRole = 'technician'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/tech-payroll');

jest.setTimeout(60000);

postgres('technician pay stubs', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  let techId;
  let otherTechId;
  let w4Id;
  let otherW4Id;
  const OLD = process.env.GATE_TECH_PAY_STUBS;

  // A check in the given status: insert as a draft (the protect trigger lets a draft change), then move
  // the check and its run to the final status.
  const addCheck = async (weekStart, payDate, patch = {}, { status = 'finalized', runStatus = status, tech = techId } = {}) => {
    const runId = randomUUID();
    await trx('payroll_runs').insert({ id: runId, week_start: weekStart, pay_date: payDate, status: 'draft' });
    const [saved] = await trx('payroll_checks').insert({
      run_id: runId, technician_id: tech, employee_name: tech === techId ? 'Sample Employee' : 'Sample Other',
      week_start: weekStart, pay_date: payDate,
      hourly_rate: '25.00', regular_minutes: '2400.00', overtime_minutes: '60.00',
      gross_cents: 100000, regular_pay_cents: 100000, overtime_pay_cents: 0, overtime_premium_cents: 0,
      federal_income_tax_cents: 10000, social_security_cents: 6200, medicare_cents: 1450, additional_medicare_cents: 0,
      net_cents: 82350, employer_social_security_cents: 6200, employer_medicare_cents: 1450,
      futa_cents: 600, fl_reemployment_cents: 2700, ytd_gross_before_cents: 0,
      w4_election_id: tech === techId ? w4Id : otherW4Id, calc_snapshot: {},
      pay_method: 'check', status: 'draft', ...patch,
    }).returning('id');
    if (status !== 'draft') await trx('payroll_checks').where({ id: saved.id }).update({ status });
    if (runStatus !== 'draft') await trx('payroll_runs').where({ id: runId }).update({ status: runStatus });
    return saved.id;
  };
  const api = (path, tech = techId) => fetch(`${baseUrl}${path}`, { headers: { 'x-test-tech': tech } })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use('/api/tech/payroll', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/tech/payroll`;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_TECH_PAY_STUBS = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    techId = randomUUID();
    otherTechId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Sample Employee', employment_type: 'w2', employment_status: 'active', pay_rate: '25.00', ssn_last4: '1234' });
    await trx('technicians').insert({ id: otherTechId, name: 'Sample Other', employment_type: 'w2', employment_status: 'active', pay_rate: '25.00' });
    [{ id: w4Id }] = await trx('payroll_w4_elections').insert({
      technician_id: techId, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    }).returning('id');
    [{ id: otherW4Id }] = await trx('payroll_w4_elections').insert({
      technician_id: otherTechId, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    }).returning('id');
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD === undefined) delete process.env.GATE_TECH_PAY_STUBS; else process.env.GATE_TECH_PAY_STUBS = OLD;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  it('lists only the caller\'s finalized checks of finalized runs, newest first, without employer taxes', async () => {
    const older = await addCheck('2026-09-14', '2026-09-25');
    const newer = await addCheck('2026-09-21', '2026-10-02');
    await addCheck('2026-09-28', '2026-10-09', {}, { status: 'draft' });
    await addCheck('2026-10-05', '2026-10-16', {}, { status: 'voided' });
    await addCheck('2026-10-12', '2026-10-23', {}, { tech: otherTechId });
    const result = await api('/checks');
    expect(result.status).toBe(200);
    expect(result.body.checks.map((c) => c.id)).toEqual([newer, older]);
    expect(result.body.checks[0]).toEqual({
      id: newer, name: 'Sample Employee', weekStart: '2026-09-21', payDate: '2026-10-02', grossCents: 100000, netCents: 82350,
      regularHours: '40.00', overtimeHours: '1.00', payMethod: 'check',
    });
    expect(JSON.stringify(result.body)).not.toMatch(/employer|futa|reemployment/i);
  });

  it('shows another person nothing of the caller\'s checks', async () => {
    await addCheck('2026-09-21', '2026-10-02');
    expect((await api('/checks', otherTechId)).body.checks).toEqual([]);
  });

  it('opens the stub of an own finalized check', async () => {
    const id = await addCheck('2026-09-21', '2026-10-02');
    const result = await api(`/checks/${id}/stub`);
    expect(result.status).toBe(200);
    expect(result.body.stub).toMatchObject({
      checkId: id, employee: { name: 'Sample Employee', ssnLast4: '1234' }, payDate: '2026-10-02', netCents: 82350,
      earnings: { grossCents: 100000 },
    });
    expect(JSON.stringify(result.body)).not.toMatch(/employer(Social|Medicare)|futa|reemployment/i);
  });

  it('answers 404 for another person\'s check, a draft, a voided check and a bad id', async () => {
    const others = await addCheck('2026-09-21', '2026-10-02', {}, { tech: otherTechId });
    const draft = await addCheck('2026-09-28', '2026-10-09', {}, { status: 'draft' });
    const voided = await addCheck('2026-10-05', '2026-10-16', {}, { status: 'voided' });
    for (const id of [others, draft, voided, randomUUID(), 'not-a-uuid']) {
      const result = await api(`/checks/${id}/stub`);
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'Pay stub not found.' });
    }
  });

  it('answers 404 before any query while the gate is off', async () => {
    const id = await addCheck('2026-09-21', '2026-10-02');
    delete process.env.GATE_TECH_PAY_STUBS;
    const spy = jest.fn();
    const saved = mockConnection;
    mockConnection = Object.assign((...args) => { spy(); return saved(...args); }, saved);
    expect((await api('/checks')).status).toBe(404);
    expect((await api(`/checks/${id}/stub`)).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    mockConnection = saved;
  });
});
