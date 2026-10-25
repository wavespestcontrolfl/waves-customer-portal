// Real PostgreSQL transactions (rolled back): the W-4 table's CHECKs and its
// no-edit trigger, which election currentW4For picks, the W-2-only rule, the
// pay-method consent rule, and the admin routes (gate off writes nothing).
// All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
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

const { randomUUID } = require('node:crypto');
const express = require('express');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { computePaycheck } = require('../services/payroll-calc');
const payrollW4 = require('../services/payroll-w4');
const router = require('../routes/admin-payroll');

jest.setTimeout(30000);
postgres('payroll W-4 elections and pay method', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD_GATE = process.env.GATE_PAYROLL;
  const day = (n) => etDateString(addETDays(new Date(), n));
  const ADMIN_ID = randomUUID();

  const technician = async (patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name: 'Sample Employee', employment_type: 'w2', employment_status: 'active', pay_rate: '22.00', ...patch,
    });
    return id;
  };
  const election = (patch = {}) => ({
    formYear: 2026, filingStatus: 'single', step2Checkbox: false, step3Amount: '0', step4aOtherIncome: '0',
    step4bDeductions: '0', step4cExtraWithholding: '0', exempt: false, signedOn: day(-5), ...patch,
  });
  // A failed statement aborts the whole transaction; a savepoint keeps it usable.
  const refused = async (work) => {
    await trx.raw('SAVEPOINT attempt');
    let error;
    try { await work(); } catch (err) { error = err; }
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    return error;
  };
  const rawRow = (technicianId, patch = {}) => ({
    technician_id: technicianId, form_year: 2026, filing_status: 'single', signed_on: day(-5), effective_on: day(-5), ...patch,
  });
  const api = async (method, path, { body, role, admin = ADMIN_ID } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': admin, ...(role ? { 'x-test-role': role } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
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
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: 'w2', employment_status: 'active' });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_PAYROLL; else process.env.GATE_PAYROLL = OLD_GATE;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  describe('table rules', () => {
    it.each([
      ['a form year before 2020', { form_year: 2019 }],
      ['an unknown filing status', { filing_status: 'widowed' }],
      ['a negative Step 3 amount', { step3_amount: -1 }],
      ['a negative Step 4(a) amount', { step4a_other_income: -0.01 }],
      ['a negative Step 4(b) amount', { step4b_deductions: -5 }],
      ['a negative Step 4(c) amount', { step4c_extra_withholding: -1 }],
      ['a note over 500 characters', { note: 'x'.repeat(501) }],
      ['no signed date', { signed_on: null }],
    ])('refuses %s', async (_name, patch) => {
      const id = await technician();
      const error = await refused(() => trx('payroll_w4_elections').insert(rawRow(id, patch)));
      expect(error).toBeTruthy();
    });

    it('accepts a plain row and fills the defaults', async () => {
      const id = await technician();
      const [row] = await trx('payroll_w4_elections').insert(rawRow(id)).returning('*');
      expect(row).toMatchObject({ step2_checkbox: false, exempt: false, step3_amount: '0.00', note: null });
    });

    it('blocks UPDATE and DELETE, so a correction has to be a new row', async () => {
      const id = await technician();
      const [row] = await trx('payroll_w4_elections').insert(rawRow(id)).returning('id');
      const update = await refused(() => trx('payroll_w4_elections').where({ id: row.id }).update({ filing_status: 'married_jointly' }));
      expect(update.message).toMatch(/cannot be changed or deleted/);
      const del = await refused(() => trx('payroll_w4_elections').where({ id: row.id }).del());
      expect(del.message).toMatch(/cannot be changed or deleted/);
      expect(await trx('payroll_w4_elections').where({ id: row.id }).first('filing_status')).toMatchObject({ filing_status: 'single' });
    });

    it('does not let a technician with W-4 history be deleted', async () => {
      const id = await technician();
      await trx('payroll_w4_elections').insert(rawRow(id));
      expect(await refused(() => trx('technicians').where({ id }).del())).toBeTruthy();
    });

    it('defaults a technician to paper check and refuses an unknown method', async () => {
      const id = await technician();
      expect(await trx('technicians').where({ id }).first('pay_method', 'pay_method_consent_on'))
        .toMatchObject({ pay_method: 'check', pay_method_consent_on: null });
      expect(await refused(() => trx('technicians').where({ id }).update({ pay_method: 'cash' }))).toBeTruthy();
    });

    it('refuses bank transfer with no written OK date, and accepts it with one', async () => {
      const id = await technician();
      expect(await refused(() => trx('technicians').where({ id }).update({ pay_method: 'bank_transfer' }))).toBeTruthy();
      await trx('technicians').where({ id }).update({ pay_method: 'bank_transfer', pay_method_consent_on: day(-1) });
      expect((await trx('technicians').where({ id }).first('pay_method')).pay_method).toBe('bank_transfer');
    });
  });

  describe('currentW4For', () => {
    it('returns null before any election applies', async () => {
      const id = await technician();
      expect(await payrollW4.currentW4For(id, day(0))).toBeNull();
      await trx('payroll_w4_elections').insert(rawRow(id, { effective_on: day(10), signed_on: day(-1) }));
      expect(await payrollW4.currentW4For(id, day(0))).toBeNull();
    });

    it('picks the latest effective date not after the pay date and ignores a future row', async () => {
      const id = await technician();
      await trx('payroll_w4_elections').insert([
        rawRow(id, { filing_status: 'single', effective_on: day(-30) }),
        rawRow(id, { filing_status: 'married_jointly', effective_on: day(-10) }),
        rawRow(id, { filing_status: 'head_of_household', effective_on: day(20), signed_on: day(-1) }),
      ]);
      expect((await payrollW4.currentW4For(id, day(0))).filingStatus).toBe('married_jointly');
      expect((await payrollW4.currentW4For(id, day(-15))).filingStatus).toBe('single');
      expect((await payrollW4.currentW4For(id, day(-10))).filingStatus).toBe('married_jointly');
      expect((await payrollW4.currentW4For(id, day(20))).filingStatus).toBe('head_of_household');
      expect(await payrollW4.currentW4For(id, day(-31))).toBeNull();
    });

    it('lets a same-day correction win by created_at', async () => {
      const id = await technician();
      await trx('payroll_w4_elections').insert(rawRow(id, { filing_status: 'single', effective_on: day(-3), created_at: trx.raw("now() - interval '2 hours'") }));
      await trx('payroll_w4_elections').insert(rawRow(id, { filing_status: 'head_of_household', effective_on: day(-3), created_at: trx.raw("now() - interval '1 hour'") }));
      expect((await payrollW4.currentW4For(id, day(0))).filingStatus).toBe('head_of_household');
    });

    it('never mixes up two technicians', async () => {
      const a = await technician();
      const b = await technician();
      await trx('payroll_w4_elections').insert(rawRow(a, { filing_status: 'married_jointly' }));
      expect(await payrollW4.currentW4For(b, day(0))).toBeNull();
    });

    it('feeds computePaycheck from a stored row', async () => {
      const id = await technician();
      await payrollW4.recordW4(id, election({ filingStatus: 'married_jointly', step2Checkbox: true, step3Amount: '2000', step4cExtraWithholding: '5.25', formYear: 2026 }), ADMIN_ID);
      const w4 = await payrollW4.currentW4For(id, day(0));
      const pay = computePaycheck({ payDate: '2026-11-06', hourlyRate: '23.00', regularMinutes: '2400.00', w4 });
      expect(pay).toBeTruthy();
    });
  });

  describe('recordW4', () => {
    it('stores the election, defaults the first pay date to the signed date and audits ids only', async () => {
      const id = await technician();
      const saved = await payrollW4.recordW4(id, election({ step4cExtraWithholding: '7.50', note: 'From the paper form' }), ADMIN_ID);
      expect(saved).toMatchObject({ filingStatus: 'single', step4cExtraWithholding: '7.50', signedOn: day(-5), effectiveOn: day(-5), note: 'From the paper form' });
      const row = await trx('payroll_w4_elections').where({ id: saved.id }).first();
      expect(row.entered_by).toBe(ADMIN_ID);
      const audit = await trx('audit_log').where({ action: 'payroll.w4_recorded', resource_id: saved.id }).first();
      expect(audit).toMatchObject({ actor_type: 'admin', actor_id: ADMIN_ID, resource_type: 'payroll_w4_elections' });
      expect(audit.metadata).toEqual({ technician_id: id, election_id: saved.id });
    });

    it('refuses a 1099 contractor with 409 and writes nothing', async () => {
      const id = await technician({ employment_type: '1099' });
      await expect(payrollW4.recordW4(id, election(), ADMIN_ID)).rejects.toMatchObject({ status: 409, message: 'W-4 is for W-2 employees.' });
      expect(await trx('payroll_w4_elections').where({ technician_id: id }).count('* as n').first()).toMatchObject({ n: '0' });
      expect(await trx('audit_log').where({ action: 'payroll.w4_recorded' }).count('* as n').first()).toMatchObject({ n: '0' });
    });

    it('refuses a technician with no employment type, and an unknown technician with 404', async () => {
      const id = await technician({ employment_type: null });
      await expect(payrollW4.recordW4(id, election(), ADMIN_ID)).rejects.toMatchObject({ status: 409 });
      await expect(payrollW4.recordW4(randomUUID(), election(), ADMIN_ID)).rejects.toMatchObject({ status: 404 });
    });

    it('lists history newest first', async () => {
      const id = await technician();
      await payrollW4.recordW4(id, election({ signedOn: day(-40) }), ADMIN_ID);
      await payrollW4.recordW4(id, election({ signedOn: day(-20), filingStatus: 'head_of_household' }), ADMIN_ID);
      const history = await payrollW4.listW4(id);
      expect(history.map((r) => r.filingStatus)).toEqual(['head_of_household', 'single']);
    });
  });

  describe('setPayMethod', () => {
    it('records bank transfer with the written OK date, and clears the date on paper check', async () => {
      const id = await technician();
      expect(await payrollW4.setPayMethod(id, { payMethod: 'bank_transfer', consentOn: day(-2) }, ADMIN_ID))
        .toEqual({ id, payMethod: 'bank_transfer', payMethodConsentOn: day(-2) });
      expect(await payrollW4.setPayMethod(id, { payMethod: 'check', consentOn: day(-2) }, ADMIN_ID))
        .toEqual({ id, payMethod: 'check', payMethodConsentOn: null });
      // One audit row per change. Both rows carry the same created_at (the test
      // runs inside one transaction, so now() does not move), so compare them
      // as a set, not in insertion order.
      const audits = await trx('audit_log').where({ action: 'payroll.pay_method_changed', resource_id: id });
      expect(audits.map((row) => row.metadata)).toEqual(expect.arrayContaining([
        { technician_id: id, pay_method: 'bank_transfer' },
        { technician_id: id, pay_method: 'check' },
      ]));
      expect(audits).toHaveLength(2);
    });

    it('refuses bank transfer without a date or with a future date, and a 1099 contractor', async () => {
      const id = await technician();
      await expect(payrollW4.setPayMethod(id, { payMethod: 'bank_transfer' }, ADMIN_ID)).rejects.toMatchObject({ status: 400 });
      await expect(payrollW4.setPayMethod(id, { payMethod: 'bank_transfer', consentOn: day(1) }, ADMIN_ID)).rejects.toMatchObject({ status: 400 });
      const contractor = await technician({ employment_type: '1099' });
      await expect(payrollW4.setPayMethod(contractor, { payMethod: 'check' }, ADMIN_ID)).rejects.toMatchObject({ status: 409 });
      expect((await trx('technicians').where({ id }).first('pay_method')).pay_method).toBe('check');
    });
  });

  describe('admin routes', () => {
    const counts = async () => ({
      elections: Number((await trx('payroll_w4_elections').count('* as n').first()).n),
      audits: Number((await trx('audit_log').whereIn('action', ['payroll.w4_recorded', 'payroll.pay_method_changed']).count('* as n').first()).n),
    });

    it('answers /status while dark and refuses everything else before any query', async () => {
      delete process.env.GATE_PAYROLL;
      const id = await technician();
      const before = await counts();
      expect(await api('GET', '/status')).toEqual({ status: 200, body: { enabled: false } });
      expect((await api('GET', '/technicians')).status).toBe(404);
      expect((await api('GET', `/technicians/${id}/w4`)).status).toBe(404);
      const post = await api('POST', `/technicians/${id}/w4`, { body: election() });
      expect(post).toEqual({ status: 404, body: { enabled: false } });
      const put = await api('PUT', `/technicians/${id}/pay-method`, { body: { payMethod: 'bank_transfer', consentOn: day(-1) } });
      expect(put.status).toBe(404);
      expect(await counts()).toEqual(before);
      expect((await trx('technicians').where({ id }).first('pay_method')).pay_method).toBe('check');
    });

    it('treats any value but exactly true as dark', async () => {
      process.env.GATE_PAYROLL = 'TRUE';
      expect((await api('GET', '/status')).body).toEqual({ enabled: false });
      process.env.GATE_PAYROLL = '1';
      expect((await api('GET', '/technicians')).status).toBe(404);
    });

    it('is admin only', async () => {
      expect((await api('GET', '/status', { role: 'technician' })).status).toBe(403);
      expect((await api('GET', '/technicians', { role: 'technician' })).status).toBe(403);
    });

    it('lists W-2 technicians with the W-4 in force today and no SSN', async () => {
      const w2 = await technician({ name: 'Sample Alpha', ssn_last4: '1234' });
      await technician({ name: 'Sample Contractor', employment_type: '1099' });
      await technician({ name: 'Sample Former', employment_status: 'inactive' });
      await technician({ name: 'Sample Prospect', employment_status: 'prospective' });
      await trx('payroll_w4_elections').insert(rawRow(w2, { filing_status: 'married_jointly', step4c_extra_withholding: '3.00', effective_on: day(-2) }));
      await trx('payroll_w4_elections').insert(rawRow(w2, { filing_status: 'head_of_household', effective_on: day(30), signed_on: day(-1) }));
      const response = await api('GET', '/technicians');
      expect(response.status).toBe(200);
      const byName = Object.fromEntries(response.body.technicians.map((t) => [t.name, t]));
      expect(Object.keys(byName).sort()).toEqual(['Sample Admin', 'Sample Alpha', 'Sample Prospect']);
      expect(byName['Sample Alpha']).toMatchObject({ payRate: '22.00', payMethod: 'check', currentW4: { filingStatus: 'married_jointly', step4cExtraWithholding: '3.00' } });
      expect(byName['Sample Prospect'].currentW4).toBeNull();
      expect(JSON.stringify(response.body)).not.toMatch(/ssn|1234|bank_account|routing/i);
    });

    it('records a W-4 (201), lists the history, and refuses bad input with 400', async () => {
      const id = await technician();
      const created = await api('POST', `/technicians/${id}/w4`, { body: election({ filingStatus: 'head_of_household', step4cExtraWithholding: '10' }) });
      expect(created.status).toBe(201);
      expect(created.body.election).toMatchObject({ filingStatus: 'head_of_household', step4cExtraWithholding: '10.00' });
      const history = await api('GET', `/technicians/${id}/w4`);
      expect(history.body.elections).toHaveLength(1);
      const bad = await api('POST', `/technicians/${id}/w4`, { body: election({ step3Amount: '1e3' }) });
      expect(bad.status).toBe(400);
      const withSsn = await api('POST', `/technicians/${id}/w4`, { body: { ...election(), ssn: '123-45-6789' } });
      expect(withSsn.status).toBe(400);
      expect(JSON.stringify(withSsn.body)).not.toMatch(/123-45-6789/);
      expect((await counts()).elections).toBe(1);
    });

    it('answers 409 for a 1099 contractor and 404 for an unknown technician', async () => {
      const contractor = await technician({ employment_type: '1099' });
      expect((await api('POST', `/technicians/${contractor}/w4`, { body: election() })).status).toBe(409);
      expect((await api('POST', `/technicians/${randomUUID()}/w4`, { body: election() })).status).toBe(404);
      expect((await api('POST', '/technicians/not-an-id/w4', { body: election() })).status).toBe(404);
    });

    it('sets the pay method', async () => {
      const id = await technician();
      const set = await api('PUT', `/technicians/${id}/pay-method`, { body: { payMethod: 'bank_transfer', consentOn: day(-1) } });
      expect(set).toEqual({ status: 200, body: { technician: { id, payMethod: 'bank_transfer', payMethodConsentOn: day(-1) } } });
      expect((await api('PUT', `/technicians/${id}/pay-method`, { body: { payMethod: 'bank_transfer' } })).status).toBe(400);
    });
  });
});
