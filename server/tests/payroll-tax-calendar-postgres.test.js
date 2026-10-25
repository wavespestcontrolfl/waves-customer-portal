// Real PostgreSQL transactions (rolled back): the payroll tax calendar sync
// writes tax_filing_calendar rows from finalized checks, stays idempotent,
// keeps an upcoming row current, leaves an owner-marked row alone, removes an
// upcoming row whose checks are gone, and follows pay run finalize and void.
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
  adminAuthenticate: (req, _res, next) => { req.technicianId = req.headers['x-test-admin'] || null; req.techRole = 'admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-payroll');
const { syncPayrollFilings, syncPayrollFilingsSafe } = require('../services/payroll-tax-calendar');

jest.setTimeout(60000);

const TODAY = '2027-02-10';
const W1 = '2027-01-04'; // pay Fri 2027-01-15
const W2 = '2027-01-11'; // pay Fri 2027-01-22
const W3 = '2027-01-25'; // pay Fri 2027-02-05
const W_APPROVED = '2026-09-14'; // pay Fri 2026-09-25

postgres('payroll tax calendar sync', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  let techId;
  let w4Id;
  const OLD = {
    payroll: process.env.GATE_PAYROLL,
    calendar: process.env.GATE_PAYROLL_TAX_CALENDAR,
  };
  const ADMIN_ID = randomUUID();

  // A finalized check: a draft run and check first (the protect triggers let a
  // draft change), then finalize both.
  const finalCheck = async (weekStart, payDate, patch = {}, status = 'finalized') => {
    const runId = randomUUID();
    await trx('payroll_runs').insert({ id: runId, week_start: weekStart, pay_date: payDate, status: 'draft' });
    const [row] = await trx('payroll_checks').insert({
      run_id: runId, technician_id: techId, employee_name: 'Sample Employee', week_start: weekStart, pay_date: payDate,
      hourly_rate: '25.00', regular_minutes: '2400.00', overtime_minutes: '0.00',
      gross_cents: 100000, regular_pay_cents: 100000, overtime_pay_cents: 0, overtime_premium_cents: 0,
      federal_income_tax_cents: 10000, social_security_cents: 6200, medicare_cents: 1450, additional_medicare_cents: 0,
      net_cents: 82350, employer_social_security_cents: 6200, employer_medicare_cents: 1450,
      futa_cents: 600, fl_reemployment_cents: 270, ytd_gross_before_cents: 0,
      w4_election_id: w4Id, calc_snapshot: {}, pay_method: 'check', status: 'draft', ...patch,
    }).returning('id');
    if (status !== 'draft') {
      await trx('payroll_checks').where({ id: row.id }).update({ status });
      await trx('payroll_runs').where({ id: runId }).update({ status });
    }
    return { runId, checkId: row.id };
  };
  const payrollRows = () => trx('tax_filing_calendar').where('source_key', 'like', 'payroll:%').orderBy('source_key');
  const rowFor = (key) => trx('tax_filing_calendar').where({ source_key: key }).first();
  const sync = () => syncPayrollFilings({ conn: trx, today: TODAY });

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
    process.env.GATE_PAYROLL_TAX_CALENDAR = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
    techId = randomUUID();
    await trx('technicians').insert({
      id: techId, name: 'Sample Employee', employment_type: 'w2', employment_status: 'active', pay_rate: '25.00',
    });
    [{ id: w4Id }] = await trx('payroll_w4_elections').insert({
      technician_id: techId, form_year: 2027, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    }).returning('id');
  });
  afterEach(async () => {
    await trx.rollback();
    for (const [key, name] of [['payroll', 'GATE_PAYROLL'], ['calendar', 'GATE_PAYROLL_TAX_CALENDAR']]) {
      if (OLD[key] === undefined) delete process.env[name]; else process.env[name] = OLD[key];
    }
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  it('writes nothing, and runs no query, while the gate is off', async () => {
    delete process.env.GATE_PAYROLL_TAX_CALENDAR;
    await finalCheck(W1, '2027-01-15');
    const touched = jest.fn();
    expect(await syncPayrollFilings({ conn: { transaction: touched }, today: TODAY })).toEqual({ skipped: 'gate_off' });
    expect(touched).not.toHaveBeenCalled();
    expect(await sync()).toEqual({ skipped: 'gate_off' });
    expect(await payrollRows()).toHaveLength(0);
  });

  it('inserts the rows from finalized checks and is idempotent on a second run', async () => {
    await finalCheck(W1, '2027-01-15');
    await finalCheck(W2, '2027-01-22');
    await finalCheck(W3, '2027-02-05');
    const first = await sync();
    expect(first.inserted).toBeGreaterThan(0);
    expect(first).toMatchObject({ updated: 0, deleted: 0 });
    const jan = await rowFor('payroll:941_deposit:2027-01');
    expect(jan).toMatchObject({
      filing_type: 'payroll_941_deposit', status: 'upcoming', period_label: 'Jan 2027', amount_due: '506.00',
    });
    const due = await trx('tax_filing_calendar').where({ source_key: 'payroll:941_deposit:2027-01' })
      .select(trx.raw("to_char(due_date, 'YYYY-MM-DD') AS d")).first();
    expect(due.d).toBe('2027-02-16'); // the 15th is Washington's Birthday
    expect((await rowFor('payroll:rt6:2027-Q1')).amount_due).toBe('8.10');
    expect(await rowFor('payroll:941:2027-Q1')).toBeTruthy();
    expect(await rowFor('payroll:940:2027')).toBeTruthy();
    expect(await rowFor('payroll:w2:2027')).toBeTruthy();
    const before = await payrollRows();
    expect(await sync()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(await payrollRows()).toEqual(before);
  });

  it('updates an upcoming row when a new check lands', async () => {
    await finalCheck(W1, '2027-01-15');
    await sync();
    expect((await rowFor('payroll:941_deposit:2027-01')).amount_due).toBe('253.00');
    await finalCheck(W2, '2027-01-22');
    const result = await sync();
    expect(result.updated).toBeGreaterThan(0);
    expect((await rowFor('payroll:941_deposit:2027-01')).amount_due).toBe('506.00');
  });

  it('never changes a row the owner marked paid', async () => {
    await finalCheck(W1, '2027-01-15');
    await sync();
    await trx('tax_filing_calendar').where({ source_key: 'payroll:941_deposit:2027-01' })
      .update({ status: 'paid', amount_paid: '253.00', confirmation_number: 'SAMPLE-1' });
    await finalCheck(W2, '2027-01-22');
    await sync();
    const row = await rowFor('payroll:941_deposit:2027-01');
    expect(row).toMatchObject({ status: 'paid', amount_due: '253.00', amount_paid: '253.00', confirmation_number: 'SAMPLE-1' });
  });

  it('counts finalized checks only: voided and draft checks add nothing', async () => {
    await finalCheck(W1, '2027-01-15');
    await finalCheck(W2, '2027-01-22', {}, 'voided');
    await finalCheck(W3, '2027-02-05', {}, 'draft');
    await sync();
    expect((await rowFor('payroll:941_deposit:2027-01')).amount_due).toBe('253.00');
    expect(await rowFor('payroll:941_deposit:2027-02')).toBeUndefined();
  });

  it('deletes an upcoming row whose checks were all voided', async () => {
    const { runId, checkId } = await finalCheck(W1, '2027-01-15');
    await sync();
    expect(await rowFor('payroll:941_deposit:2027-01')).toBeTruthy();
    await trx('payroll_checks').where({ id: checkId }).update({ status: 'voided' });
    await trx('payroll_runs').where({ id: runId }).update({ status: 'voided' });
    const result = await sync();
    expect(result.deleted).toBeGreaterThan(0);
    expect(await payrollRows()).toHaveLength(0);
  });

  describe('a pay run corrected after its deposit was marked paid', () => {
    const KEY = 'payroll:941_deposit:2027-01';
    const markPaid = (amount) => trx('tax_filing_calendar').where({ source_key: KEY })
      .update({ status: 'paid', amount_paid: amount, paid_date: '2027-02-12', confirmation_number: 'SAMPLE-2' });
    // Void the first run and finalize a replacement for the same week.
    const replace = async (first, patch) => {
      await trx('payroll_checks').where({ id: first.checkId }).update({ status: 'voided' });
      await trx('payroll_runs').where({ id: first.runId }).update({ status: 'voided' });
      return finalCheck(W1, '2027-01-15', patch);
    };

    it('adds exactly one balance row for a higher amount and leaves the paid row alone', async () => {
      const first = await finalCheck(W1, '2027-01-15'); // deposit 253.00
      await sync();
      await markPaid('253.00');
      await replace(first, { federal_income_tax_cents: 20000 }); // deposit 353.00
      await sync();
      const rows = (await payrollRows()).filter((r) => r.source_key.startsWith(KEY));
      expect(rows.map((r) => [r.source_key, r.status, r.amount_due])).toEqual([
        [KEY, 'paid', '253.00'],
        [`${KEY}:balance:1`, 'upcoming', '100.00'],
      ]);
      expect(rows[0]).toMatchObject({ amount_paid: '253.00', confirmation_number: 'SAMPLE-2' });
      expect(await sync()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    });

    it('adds no row for a lower amount', async () => {
      const first = await finalCheck(W1, '2027-01-15');
      await sync();
      await markPaid('253.00');
      await replace(first, { federal_income_tax_cents: 5000 }); // deposit 203.00
      await sync();
      const rows = (await payrollRows()).filter((r) => r.source_key.startsWith(KEY));
      expect(rows.map((r) => [r.source_key, r.status, r.amount_due])).toEqual([[KEY, 'paid', '253.00']]);
    });

    it('removes the balance row when the amount comes back down before it is paid', async () => {
      const first = await finalCheck(W1, '2027-01-15');
      await sync();
      await markPaid('253.00');
      const second = await replace(first, { federal_income_tax_cents: 20000 });
      await sync();
      expect(await rowFor(`${KEY}:balance:1`)).toBeTruthy();
      await replace(second, { federal_income_tax_cents: 10000 });
      await sync();
      expect(await rowFor(`${KEY}:balance:1`)).toBeUndefined();
    });
  });

  it('asks for a review when the checks behind a filed Form 941 change, and only once', async () => {
    const KEY = 'payroll:941:2027-Q1';
    const first = await finalCheck(W1, '2027-01-15');
    await sync();
    const before = await rowFor(KEY);
    expect(before.source_digest).toMatch(/^[0-9a-f]{32}$/);
    await trx('tax_filing_calendar').where({ source_key: KEY }).update({ status: 'filed', filed_date: '2027-04-20' });
    await trx('payroll_checks').where({ id: first.checkId }).update({ status: 'voided' });
    await trx('payroll_runs').where({ id: first.runId }).update({ status: 'voided' });
    await finalCheck(W1, '2027-01-15'); // same figures, a new check
    await sync();
    const rows = await trx('tax_filing_calendar').where('source_key', 'like', `${KEY}%`).orderBy('source_key');
    expect(rows.map((r) => [r.status, r.amount_due])).toEqual([['filed', null], ['upcoming', null]]);
    expect(rows[0]).toMatchObject({ source_key: KEY, source_digest: before.source_digest });
    expect(rows[1].source_key).toBe(`${KEY}:review:${rows[1].source_digest.slice(0, 12)}`);
    expect(rows[1].source_digest).not.toBe(before.source_digest);
    expect(rows[1].title).toBe('Form 941 — Q1 2027 — figures changed after it was marked done');
    expect(await sync()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    // The owner marks the review row done: it stops asking.
    await trx('tax_filing_calendar').where({ id: rows[1].id }).update({ status: 'filed', filed_date: '2027-04-25' });
    expect(await sync()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(await trx('tax_filing_calendar').where('source_key', 'like', `${KEY}%`)).toHaveLength(2);
  });

  it('writes one FUTA alert row when the year passes $500, and no FUTA deposit rows', async () => {
    await finalCheck(W1, '2027-01-15', { futa_cents: 30000 });
    await finalCheck(W2, '2027-01-22', { futa_cents: 30000 });
    await sync();
    const alert = await rowFor('payroll:futa_over_500:2027');
    expect(alert).toMatchObject({ filing_type: 'payroll_futa_alert', status: 'upcoming', amount_due: null, period_label: 'Tax Year 2027' });
    expect(alert.title).toBe('FUTA passed $500 — deposit due (Q1 2027)');
    expect((await rowFor('payroll:940:2027')).amount_due).toBe('600.00');
    expect((await payrollRows()).filter((r) => r.filing_type === 'payroll_futa_deposit')).toHaveLength(0);
  });

  it('leaves ordinary calendar rows alone', async () => {
    await trx('tax_filing_calendar').insert({ filing_type: 'dr15_sales_tax', title: 'Sample DR-15', due_date: '2027-02-20', status: 'upcoming' });
    await sync();
    expect(await trx('tax_filing_calendar').where({ title: 'Sample DR-15' })).toHaveLength(1);
  });

  it('syncPayrollFilingsSafe reports a failure and does not throw', async () => {
    mockConnection = null;
    expect(await syncPayrollFilingsSafe({ conn: { transaction: () => { throw new Error('boom'); } } })).toEqual({ failed: true });
    mockConnection = trx;
  });

  it('follows pay run finalize and void through the admin routes', async () => {
    await trx('time_weekly_summary').insert({
      technician_id: techId, week_start: W_APPROVED, week_end: '2026-09-20', status: 'approved',
      regular_minutes: '2400.00', overtime_minutes: '0.00',
    });
    await trx('payroll_w4_elections').insert({
      technician_id: techId, form_year: 2026, filing_status: 'single', signed_on: '2026-01-03', effective_on: '2026-01-03',
    });
    const call = async (method, path, body) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method, headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const created = await call('POST', '/runs', { weekStart: W_APPROVED });
    expect(created.status).toBe(201);
    expect(await payrollRows()).toHaveLength(0); // a draft adds nothing
    const runId = created.body.run.id;
    const shown = await call('GET', `/runs/${runId}`);
    expect((await call('POST', `/runs/${runId}/finalize`, { token: shown.body.run.token })).status).toBe(200);
    expect(await rowFor('payroll:941_deposit:2026-09')).toBeTruthy();
    expect(await rowFor('payroll:rt6:2026-Q3')).toBeTruthy();
    expect((await call('POST', `/runs/${runId}/void`, { reason: 'Sample redo' })).status).toBe(200);
    expect(await rowFor('payroll:941_deposit:2026-09')).toBeUndefined();
  });
});
