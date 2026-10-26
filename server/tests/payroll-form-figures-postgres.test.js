// Real PostgreSQL transactions (rolled back): the tax form figures read only
// finalized pay checks (a draft and a voided check are left out), sum the paid
// Tax page deposit rows for 941 line 13 and 940 line 13, read the paid RT-6
// rows for 940 line 10, carry the technician address onto the W-2, and answer
// through the route. All names synthetic.
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
const { readFormFigures } = require('../services/payroll-form-figures');

jest.setTimeout(60000);

postgres('payroll tax form figures', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  let techId;
  let otherTechId;
  let w4Id;
  const OLD = { payroll: process.env.GATE_PAYROLL, forms: process.env.GATE_PAYROLL_FORM_FIGURES };
  const line = (form, id) => form.rows.find((r) => r.line === id);

  // A check in the given status: insert as a draft (the protect trigger lets a
  // draft change), then move the check and its run to the final status.
  const addCheck = async (weekStart, payDate, patch = {}, status = 'finalized', tech = techId) => {
    const runId = randomUUID();
    await trx('payroll_runs').insert({ id: runId, week_start: weekStart, pay_date: payDate, status: 'draft' });
    const [saved] = await trx('payroll_checks').insert({
      run_id: runId, technician_id: tech, employee_name: 'Sample Employee', week_start: weekStart, pay_date: payDate,
      hourly_rate: '25.00', regular_minutes: '2400.00', overtime_minutes: '0.00',
      gross_cents: 100000, regular_pay_cents: 100000, overtime_pay_cents: 0, overtime_premium_cents: 0,
      federal_income_tax_cents: 10000, social_security_cents: 6200, medicare_cents: 1450, additional_medicare_cents: 0,
      net_cents: 82350, employer_social_security_cents: 6200, employer_medicare_cents: 1450,
      futa_cents: 600, fl_reemployment_cents: 2700, ytd_gross_before_cents: 0,
      w4_election_id: w4Id, calc_snapshot: { floridaReemploymentCents: 2700, taxableWages: { floridaReemploymentCents: 100000 } },
      pay_method: 'check', status: 'draft', ...patch,
    }).returning('id');
    if (status !== 'draft') {
      await trx('payroll_checks').where({ id: saved.id }).update({ status });
      await trx('payroll_runs').where({ id: runId }).update({ status });
    }
    return saved.id;
  };
  const addDeposit = (key, status, amountPaid, amountDue = null) => trx('tax_filing_calendar').insert({
    filing_type: 'payroll_941_deposit', title: 'Sample deposit', due_date: '2026-11-16', source_key: key, status,
    amount_paid: amountPaid, amount_due: amountDue,
  });

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
    process.env.GATE_PAYROLL_FORM_FIGURES = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    techId = randomUUID();
    otherTechId = randomUUID();
    await trx('technicians').insert({
      id: techId, name: 'Sample Employee', employment_type: 'w2', employment_status: 'active', pay_rate: '25.00',
      address: '1 Example Way, Testville, FL 00000',
    });
    await trx('technicians').insert({
      id: otherTechId, name: 'Sample Other', employment_type: 'w2', employment_status: 'active', pay_rate: '25.00',
    });
    [{ id: w4Id }] = await trx('payroll_w4_elections').insert({
      technician_id: techId, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    }).returning('id');
    await trx('payroll_w4_elections').insert({
      technician_id: otherTechId, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
  });
  afterEach(async () => {
    await trx.rollback();
    for (const [key, name] of [['payroll', 'GATE_PAYROLL'], ['forms', 'GATE_PAYROLL_FORM_FIGURES']]) {
      if (OLD[key] === undefined) delete process.env[name]; else process.env[name] = OLD[key];
    }
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  it('counts finalized checks only: a draft and a voided check are left out', async () => {
    await addCheck('2026-10-05', '2026-10-16');
    await addCheck('2026-10-12', '2026-10-23', { gross_cents: 555555 }, 'voided');
    await addCheck('2026-10-19', '2026-10-30', { gross_cents: 777777 }, 'draft');
    const out = await readFormFigures({ year: 2026, quarter: 4, conn: trx });
    expect(line(out.f941, '2').value).toBe(100000);
    expect(line(out.f941, '3').value).toBe(10000);
    expect(line(out.rt6, '2').value).toBe(100000);
    expect(line(out.f940, '3').value).toBe(100000);
    expect(out.w2).toHaveLength(1);
    expect(out.w2[0]).toMatchObject({ box1: 100000, box2: 10000, box4: 6200, box6: 1450, address: '1 Example Way, Testville, FL 00000' });
    expect(line(out.rt6, '5').rate).toBe('2.7%');
  });

  it('keeps each period to its own pay dates, and the year to the pay year', async () => {
    await addCheck('2026-09-21', '2026-10-02', {}, 'finalized'); // Q4
    await addCheck('2026-06-22', '2026-07-03', { gross_cents: 200000 }, 'finalized', otherTechId); // Q3
    await addCheck('2026-12-28', '2027-01-08', { gross_cents: 300000 }, 'finalized', otherTechId); // next year
    const q4 = await readFormFigures({ year: 2026, quarter: 4, conn: trx });
    const q3 = await readFormFigures({ year: 2026, quarter: 3, conn: trx });
    expect(line(q4.f941, '2').value).toBe(100000);
    expect(line(q3.f941, '2').value).toBe(200000);
    expect(line(q4.f940, '3').value).toBe(300000);
    expect(q4.w2).toHaveLength(2);
  });

  it('a quarter with no checks reads zeros', async () => {
    const out = await readFormFigures({ year: 2026, quarter: 2, conn: trx });
    expect(line(out.f941, '2').value).toBe(0);
    expect(out.w2).toEqual([]);
  });

  it('941 line 13 sums the paid deposit rows of the quarter (balance rows too) and nothing else', async () => {
    await addCheck('2026-10-05', '2026-10-16', { federal_income_tax_cents: 100000 });
    await addDeposit('payroll:941_deposit:2026-10', 'paid', '100.00', '253.00');
    await addDeposit('payroll:941_deposit:2026-10:balance:1', 'paid', null, '20.00'); // amount due when no amount paid
    await addDeposit('payroll:941_deposit:2026-11', 'upcoming', null, '999.00'); // not marked paid
    await addDeposit('payroll:941_deposit:2026-12', 'filed', '888.00'); // filed is not paid
    await addDeposit('payroll:941_deposit:2026-07', 'paid', '777.00'); // another quarter
    await addDeposit('payroll:941_deposit:2027-10', 'paid', '666.00'); // another year
    await trx('tax_filing_calendar').insert({
      filing_type: 'payroll_941', title: 'Sample 941', due_date: '2027-01-31', source_key: 'payroll:941:2026-Q4', status: 'paid', amount_paid: '555.00',
    });
    const out = await readFormFigures({ year: 2026, quarter: 4, conn: trx });
    expect(line(out.f941, '13').value).toBe(12000);
    expect(line(out.f941, '12').value).toBe(25300 + 90000);
    expect(line(out.f941, '14').value).toBe(115300 - 12000);
  });

  it('940 line 13 reads a paid 940 deposit row of the year, else 0', async () => {
    await addCheck('2026-10-05', '2026-10-16');
    expect(line((await readFormFigures({ year: 2026, quarter: 4, conn: trx })).f940, '13').value).toBe(0);
    await trx('tax_filing_calendar').insert({
      filing_type: 'payroll_940_deposit', title: 'Sample FUTA deposit', due_date: '2026-10-31', source_key: 'payroll:940_deposit:2026', status: 'paid', amount_paid: '5.00',
    });
    expect(line((await readFormFigures({ year: 2026, quarter: 4, conn: trx })).f940, '13').value).toBe(500);
  });

  it('940 line 10 reads the year\'s RT-6 rows marked paid with the day marked: balance rows count; filed, review and other-year rows do not', async () => {
    await addCheck('2026-10-05', '2026-10-16'); // Q4: $1,000.00 gross, $27.00 Florida tax
    const addRt6 = (key, status, amountPaid, paidDate) => trx('tax_filing_calendar').insert({
      filing_type: 'payroll_rt6', title: 'Sample RT-6', due_date: '2027-02-01', source_key: key, status, amount_paid: amountPaid, paid_date: paidDate,
    });
    await addRt6('payroll:rt6:2026-Q4', 'filed', '27.00', null); // filed is not paid
    await addRt6('payroll:rt6:2025-Q4', 'paid', '27.00', '2026-01-20'); // another year
    await addRt6('payroll:rt6:2026-Q4:review:1', 'paid', '27.00', '2027-01-20'); // a review row pays nothing
    let out = await readFormFigures({ year: 2026, quarter: 4, conn: trx });
    expect(line(out.f940, '10')).toMatchObject({ kind: 'text', value: 'Needs your check' });
    expect(line(out.f940, '12')).toMatchObject({ kind: 'text', value: 'Needs your check' });
    await addRt6('payroll:rt6:2026-Q4:balance:1', 'paid', '27.00', '2027-02-02'); // after the due date
    out = await readFormFigures({ year: 2026, quarter: 4, conn: trx });
    expect(line(out.f940, '10').kind).toBe('text');
    await trx('tax_filing_calendar').where({ source_key: 'payroll:rt6:2026-Q4:balance:1' }).update({ paid_date: '2027-02-01' });
    out = await readFormFigures({ year: 2026, quarter: 4, conn: trx });
    expect(line(out.f940, '10')).toMatchObject({ kind: 'cents', value: 0 });
    expect(line(out.f940, '12')).toMatchObject({ kind: 'cents', value: 600 });
  });

  it('answers through the route, and 404 while the gate is off', async () => {
    await addCheck('2026-10-05', '2026-10-16');
    const on = await fetch(`${baseUrl}/forms?year=2026&quarter=4`, { headers: { 'x-test-admin': randomUUID() } });
    expect(on.status).toBe(200);
    const body = await on.json();
    expect(line(body.f941, '2').value).toBe(100000);
    expect(body.w2[0].ssn).toBe('Enter from your records');
    delete process.env.GATE_PAYROLL_FORM_FIGURES;
    expect((await fetch(`${baseUrl}/forms?year=2026&quarter=4`)).status).toBe(404);
    process.env.GATE_PAYROLL_FORM_FIGURES = 'true';
    expect((await fetch(`${baseUrl}/forms?year=2026&quarter=9`)).status).toBe(400);
  });
});
