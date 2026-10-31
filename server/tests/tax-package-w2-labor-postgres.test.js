// Real PostgreSQL transaction (rolled back): the CPA tax package ZIP with
// GATE_TAX_PACKAGE_W2_LABOR off and on. Pay checks: a finalized one in the year is
// listed; a draft check, a voided check and finalized checks paid outside the year are
// left out. The time-tracking file loses the W-2 technician's days when on and keeps
// them when off. All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
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
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const taxRouter = require('../routes/admin-tax');
const { readZip } = require('./helpers/read-zip');

jest.setTimeout(60000);
const GATE = 'GATE_TAX_PACKAGE_W2_LABOR';

postgres('tax package W-2 labor', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD_GATE = process.env[GATE];

  const technician = async (name, employmentType) => {
    const id = randomUUID();
    await trx('technicians').insert({ id, name, employment_type: employmentType, employment_status: 'active' });
    return id;
  };
  const day = (technicianId, workDate, jobMinutes) => trx('time_entry_daily_summary').insert({
    technician_id: technicianId, work_date: workDate, total_shift_minutes: 480, total_job_minutes: jobMinutes, job_count: 2,
  });
  const run = async (weekStart, payDate, status) => {
    const id = randomUUID();
    await trx('payroll_runs').insert({ id, week_start: weekStart, pay_date: payDate, status });
    return id;
  };
  const check = async (runId, technicianId, name, weekStart, payDate, status, patch = {}) => {
    const w4 = randomUUID();
    await trx('payroll_w4_elections').insert({
      id: w4, technician_id: technicianId, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    await trx('payroll_checks').insert({
      run_id: runId, technician_id: technicianId, employee_name: name, week_start: weekStart, pay_date: payDate,
      hourly_rate: '25.00', regular_minutes: '2400.00', overtime_minutes: '90.00',
      gross_cents: 100000, regular_pay_cents: 100000, overtime_pay_cents: 0, overtime_premium_cents: 0,
      federal_income_tax_cents: 9000, social_security_cents: 6200, medicare_cents: 1450, additional_medicare_cents: 50,
      net_cents: 83300, employer_social_security_cents: 6200, employer_medicare_cents: 1450, futa_cents: 600,
      fl_reemployment_cents: 270, ytd_gross_before_cents: 0, w4_election_id: w4, calc_snapshot: JSON.stringify({}),
      pay_method: 'check', status, ...patch,
    });
  };
  const pack = async () => {
    const res = await fetch(`${baseUrl}/admin/tax/export/tax-package?year=2026`);
    if (res.status !== 200) throw new Error(await res.text());
    return readZip(Buffer.from(await res.arrayBuffer()));
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
    app.use('/admin/tax', taxRouter);
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    delete process.env[GATE];
    // Time days in 2026-03: an owner (no employment type), a 1099 contractor, a W-2 hire.
    const owner = await technician('Sample Owner', null);
    const contractor = await technician('Sample Contractor', '1099');
    const hire = await technician('Sample Hire', 'w2');
    await day(owner, '2026-03-02', 120);
    await day(contractor, '2026-03-03', 180);
    await day(hire, '2026-03-04', 240);
    // Pay checks. One finalized check in the year (Hire), and four that must stay out.
    const finalRun = await run('2026-09-14', '2026-09-25', 'finalized');
    await check(finalRun, hire, 'Sample Hire', '2026-09-14', '2026-09-25', 'finalized');
    const draftRun = await run('2026-09-21', '2026-10-02', 'draft');
    await check(draftRun, hire, 'Sample Hire', '2026-09-21', '2026-10-02', 'draft');
    const voidRun = await run('2026-09-28', '2026-10-09', 'voided');
    await check(voidRun, hire, 'Sample Hire', '2026-09-28', '2026-10-09', 'voided');
    const earlyRun = await run('2025-12-22', '2025-12-31', 'finalized');
    await check(earlyRun, hire, 'Sample Hire', '2025-12-22', '2025-12-31', 'finalized');
    const lateRun = await run('2026-12-28', '2027-01-08', 'finalized');
    await check(lateRun, hire, 'Sample Hire', '2026-12-28', '2027-01-08', 'finalized');
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env[GATE]; else process.env[GATE] = OLD_GATE;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  const timeRows = (files) => files['labor-timetracking-informational.csv'].split('\n').slice(1).map((l) => l.split(',')[1]).sort();

  it('gate off: no W-2 file, every technician in the time file, today\'s README', async () => {
    const files = await pack();
    expect(files['w2-payroll.csv']).toBeUndefined();
    expect(timeRows(files)).toEqual(['Sample Contractor', 'Sample Hire', 'Sample Owner']);
    expect(files['README.txt']).toContain('  7. pnl.csv              — Profit & Loss statement');
    expect(files['README.txt']).not.toContain('w2-payroll');
  });

  it('gate on: the time file drops the W-2 hire and w2-payroll.csv lists only the finalized check paid in the year', async () => {
    process.env[GATE] = 'true';
    const files = await pack();
    expect(timeRows(files)).toEqual(['Sample Contractor', 'Sample Owner']);
    const lines = files['w2-payroll.csv'].split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('Sample Hire,2026-09-14,2026-09-20,2026-09-25,40.00,1.50,1000.00,90.00,62.00,15.00,62.00,14.50,6.00,2.70,833.00');
    expect(lines[2]).toBe('TOTAL,,,,40.00,1.50,1000.00,90.00,62.00,15.00,62.00,14.50,6.00,2.70,833.00');
    expect(files['README.txt']).toMatch(/7\. w2-payroll\.csv/);
    expect(files['README.txt']).toMatch(/8\. pnl\.csv/);
  });

  it('GATE_PAYROLL_TIME_OFF on: w2-payroll.csv adds the time off and holiday hours, and the totals row foots them', async () => {
    process.env[GATE] = 'true';
    process.env.GATE_PAYROLL_TIME_OFF = 'true';
    try {
      const hire = (await trx('technicians').where({ name: 'Sample Hire' }).first('id')).id;
      const offRun = await run('2026-10-05', '2026-10-16', 'finalized');
      await check(offRun, hire, 'Sample Hire', '2026-10-05', '2026-10-16', 'finalized', { pto_minutes: '600.00', holiday_minutes: '480.00', pto_pay_cents: 25000, holiday_pay_cents: 20000 });
      const lines = (await pack())['w2-payroll.csv'].split('\n');
      expect(lines[0]).toContain('Regular Hours,Overtime Hours,Paid Time Off Hours,Holiday Hours,Gross Wages');
      expect(lines).toHaveLength(4);
      expect(lines[1]).toBe('Sample Hire,2026-09-14,2026-09-20,2026-09-25,40.00,1.50,0.00,0.00,1000.00,90.00,62.00,15.00,62.00,14.50,6.00,2.70,833.00');
      expect(lines[2]).toBe('Sample Hire,2026-10-05,2026-10-11,2026-10-16,40.00,1.50,10.00,8.00,1000.00,90.00,62.00,15.00,62.00,14.50,6.00,2.70,833.00');
      expect(lines[3]).toBe('TOTAL,,,,80.00,3.00,10.00,8.00,2000.00,180.00,124.00,30.00,124.00,29.00,12.00,5.40,1666.00');
    } finally {
      delete process.env.GATE_PAYROLL_TIME_OFF;
    }
  });

  it('GATE_PAYROLL_TIME_OFF off: the same package is byte for byte today\'s even with time off on a check', async () => {
    process.env[GATE] = 'true';
    const hire = (await trx('technicians').where({ name: 'Sample Hire' }).first('id')).id;
    const offRun = await run('2026-10-05', '2026-10-16', 'finalized');
    await check(offRun, hire, 'Sample Hire', '2026-10-05', '2026-10-16', 'finalized', { pto_minutes: '600.00', holiday_minutes: '480.00' });
    const lines = (await pack())['w2-payroll.csv'].split('\n');
    expect(lines[0]).not.toMatch(/Paid Time Off|Holiday/);
    expect(lines[2]).toBe('Sample Hire,2026-10-05,2026-10-11,2026-10-16,40.00,1.50,1000.00,90.00,62.00,15.00,62.00,14.50,6.00,2.70,833.00');
  });

  // The standalone export (Taxes → Exports → Labor) once filtered a column the table does not
  // have, and swallowed the error into a header-only CSV.
  it('the standalone labor export lists every technician\'s days in the picked range, gate on too', async () => {
    process.env[GATE] = 'true';
    await trx('company_financials').insert({ effective_date: '2026-03-01', loaded_labor_rate: '40.00' });
    const res = await fetch(`${baseUrl}/admin/tax/export/labor?start_date=2026-03-03&end_date=2026-03-31`);
    expect(res.status).toBe(200);
    expect((await res.text()).split('\n').slice(1)).toEqual([
      '2026-03-04,Sample Hire,4.0,0.0,4.0,2,40.00,160.00,0.00,160.00',
      '2026-03-03,Sample Contractor,3.0,0.0,3.0,2,40.00,120.00,0.00,120.00',
    ]);
  });
});
