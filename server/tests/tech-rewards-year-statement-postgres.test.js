// Real PostgreSQL transactions (rolled back): the yearly pay statement (Tech Rewards Plan D5-6) sums a technician's
// FINALIZED checks of finalized pay runs by PAY DATE, splits the Tech Rewards pay by the lines each check froze,
// agrees with Form W-2 box 5 for the same year, and shows a technician only their own. Goes through both routers
// with the session from headers. All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
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
  adminAuthenticate: (req, _res, next) => { req.technicianId = req.headers['x-test-tech'] || null; req.techRole = req.headers['x-test-role'] || 'technician'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const techRouter = require('../routes/tech-rewards-scoreboard');
const adminRouter = require('../routes/admin-tech-rewards-scoreboard');
const { getYearStatement } = require('../services/tech-rewards-year-statement');
const { readFormFigures } = require('../services/payroll-form-figures');

jest.setTimeout(60000);

postgres('yearly pay statement', () => {
  let database;
  let trx;
  let server;
  let techUrl;
  let adminUrl;
  let techId;
  let otherTechId;
  let w4Id;
  let otherW4Id;
  const OLD = process.env.GATE_TECH_REWARDS_SCOREBOARD;

  // A paycheck in the given status: insert as a draft (the protect trigger lets a draft change), then move the check
  // and its run to their final status. Gross is always the sum of its parts, as payroll-calc.js stores it. A pay line
  // figure a check does not hold is null, as on a check made with GATE_PAYROLL_PAY_LINES off.
  const addCheck = async (weekStart, payDate, parts = {}, { status = 'finalized', runStatus = status, tech = techId, patch = {} } = {}) => {
    // `lines`: the pay lines the check froze when it was priced, in the shape payroll-pay-lines.js openLinesFor gives buildCheck
    const { lines = null, ...amounts } = parts;
    const pay = { regular: 100000, overtime: 0, pto: 0, holiday: 0, minimumWeek: null, commission: null, reviewBonus: null, healthAllowance: null, techRewards: null, linePremium: null, ...amounts };
    const gross = Object.values(pay).reduce((total, value) => total + (value || 0), 0);
    const snapshot = lines ? { payLines: lines.map(([kind, amountCents]) => ({ id: randomUUID(), kind, amountCents, earnedWeekStart: weekStart, coversFrom: null, coversTo: null })) } : {};
    const taxes = { federal_income_tax_cents: 10000, social_security_cents: 6200, medicare_cents: 1450, additional_medicare_cents: 0 };
    const deferral = patch.simple_deferral_cents || 0;
    const runId = randomUUID();
    await trx('payroll_runs').insert({ id: runId, week_start: weekStart, pay_date: payDate, status: 'draft' });
    const [saved] = await trx('payroll_checks').insert({
      run_id: runId, technician_id: tech, employee_name: tech === techId ? 'Sample Employee' : 'Sample Other',
      week_start: weekStart, pay_date: payDate,
      hourly_rate: '25.00', regular_minutes: '2400.00', overtime_minutes: '0.00',
      gross_cents: gross, regular_pay_cents: pay.regular, overtime_pay_cents: pay.overtime, overtime_premium_cents: 0,
      pto_pay_cents: pay.pto, holiday_pay_cents: pay.holiday,
      ...(pay.minimumWeek == null ? {} : { minimum_week_minutes: '120.00', minimum_week_pay_cents: pay.minimumWeek }),
      commission_cents: pay.commission, review_bonus_cents: pay.reviewBonus,
      health_allowance_cents: pay.healthAllowance, tech_rewards_cents: pay.techRewards, line_overtime_premium_cents: pay.linePremium,
      ...taxes, net_cents: gross - 17650 - deferral,
      employer_social_security_cents: 6200, employer_medicare_cents: 1450, futa_cents: 600, fl_reemployment_cents: 2700,
      ytd_gross_before_cents: 0, w4_election_id: tech === techId ? w4Id : otherW4Id, calc_snapshot: snapshot,
      pay_method: 'check', status: 'draft', ...patch,
    }).returning('id');
    if (status !== 'draft') await trx('payroll_checks').where({ id: saved.id }).update({ status });
    if (runStatus !== 'draft') await trx('payroll_runs').where({ id: runId }).update({ status: runStatus });
    return saved.id;
  };
  const paidLine = (checkId, kind, amountCents, weekStart, tech = techId) => trx('payroll_pay_lines')
    .insert({ technician_id: tech, kind, amount_cents: amountCents, earned_week_start: weekStart, status: 'paid', check_id: checkId });
  const api = (url, { tech = techId, role = 'technician' } = {}) => fetch(url, { headers: { 'x-test-tech': tech, 'x-test-role': role } })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const own = (query = '?year=2026', options) => api(`${techUrl}/year-statement${query}`, options);

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use('/api/tech/rewards-scoreboard', techRouter);
    app.use('/api/admin/tech-rewards-scoreboard', adminRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    techUrl = `http://127.0.0.1:${server.address().port}/api/tech/rewards-scoreboard`;
    adminUrl = `http://127.0.0.1:${server.address().port}/api/admin/tech-rewards-scoreboard`;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_TECH_REWARDS_SCOREBOARD = 'true';
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
    if (OLD === undefined) delete process.env.GATE_TECH_REWARDS_SCOREBOARD; else process.env.GATE_TECH_REWARDS_SCOREBOARD = OLD;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  it('counts a paycheck in the year of its pay date, and only finalized checks of finalized runs', async () => {
    // worked in the last week of 2025, paid Jan 2 2026: this year's pay
    await addCheck('2025-12-22', '2026-01-02', { regular: 90000 });
    await addCheck('2026-06-08', '2026-06-19', { regular: 100000, overtime: 15000 });
    // paid on the last day of the year
    await addCheck('2026-12-14', '2026-12-31', { regular: 80000 });
    // worked in 2026, paid Jan 8 2027: next year's pay
    await addCheck('2026-12-28', '2027-01-08', { regular: 70000 });
    // none of these count
    await addCheck('2026-07-06', '2026-07-17', { regular: 111110 }, { status: 'draft' });
    await addCheck('2026-07-13', '2026-07-24', { regular: 222220 }, { status: 'voided' });
    await addCheck('2026-07-20', '2026-07-31', { regular: 333330 }, { status: 'finalized', runStatus: 'draft' });
    await addCheck('2026-07-27', '2026-08-07', { regular: 444440 }, { tech: otherTechId });

    const result = await own();
    expect(result.status).toBe(200);
    expect(result.body.statement).toMatchObject({
      technician: { id: techId, name: 'Sample Employee' },
      year: 2026,
      checkCount: 3,
      firstPayDate: '2026-01-02',
      lastPayDate: '2026-12-31',
      pay: { regularPayCents: 270000, overtimePayCents: 15000, otherCents: 0, grossCents: 285000 },
      withheld: { federalIncomeTaxCents: 30000, socialSecurityCents: 18600, medicareCents: 4350, totalCents: 52950 },
      netCents: 285000 - 52950,
      totalCents: 285000,
    });
    expect((await own('?year=2027')).body.statement).toMatchObject({ year: 2027, checkCount: 1, firstPayDate: '2027-01-08', pay: { grossCents: 70000 } });
    expect((await own('?year=2025')).body.statement).toMatchObject({ year: 2025, checkCount: 0, firstPayDate: null, lastPayDate: null, pay: { grossCents: 0 }, netCents: 0 });
  });

  it('names every part of gross pay and what Waves paid on top, and the rows add up to gross pay', async () => {
    const [{ id: electionId }] = await trx('payroll_simple_ira_elections')
      .insert({ technician_id: techId, participant: true, deferral_bp: 300, signed_on: '2026-01-02', effective_on: '2026-01-02' }).returning('id');
    const simple = { simple_election_id: electionId, simple_deferral_cents: 3000, simple_employer_cents: 2000 };
    // a commission or review bonus line on a check is not a bonus row: its own stored column covers it
    await addCheck('2026-03-02', '2026-03-13', { regular: 100000, overtime: 7500, pto: 20000, holiday: 10000, commission: 6000, reviewBonus: 1500, healthAllowance: 30000, linePremium: 450, lines: [['commission', 6000], ['review_bonus', 1500], ['health_allowance', 30000]] }, { patch: { ...simple, hsa_employer_cents: 5000 } });
    await addCheck('2026-09-14', '2026-09-25', { regular: 100000, techRewards: 150000, linePremium: 1200, lines: [['season_bonus', 120000], ['stay_bonus', 30000]] }, { patch: simple });
    await addCheck('2026-12-07', '2026-12-18', { regular: 100000, techRewards: 30000, lines: [['december_gift', 30000]] });
    // a week the minimum paid week topped up
    await addCheck('2026-11-02', '2026-11-13', { regular: 95000, minimumWeek: 5000 });
    // checks that must not count: another year's and another person's
    await addCheck('2026-12-28', '2027-01-08', { regular: 100000, techRewards: 5000, lines: [['stay_bonus', 5000]] });
    await addCheck('2026-10-05', '2026-10-16', { regular: 100000, techRewards: 8000, lines: [['season_bonus', 8000]] }, { tech: otherTechId });

    const { statement } = (await own()).body;
    expect(statement.pay).toEqual({
      regularPayCents: 395000, overtimePayCents: 7500, ptoPayCents: 20000, holidayPayCents: 10000, minimumWeekPayCents: 5000,
      commissionCents: 6000, reviewBonusCents: 1500, healthAllowanceCents: 30000, productionShareCents: 0,
      seasonBonusCents: 120000, stayBonusCents: 30000, decemberGiftCents: 30000,
      lineOvertimePremiumCents: 1650, otherCents: 0, grossCents: 656650,
    });
    expect(Object.entries(statement.pay).filter(([key]) => key !== 'grossCents').reduce((total, [, value]) => total + value, 0)).toBe(656650);
    expect(statement.fromWaves).toEqual({ simpleEmployerCents: 4000, hsaEmployerCents: 5000 });
    expect(statement.totalCents).toBe(656650 + 4000 + 5000);
    expect(statement.simpleSavingsCents).toBe(6000);
    expect(statement.pay.grossCents - statement.withheld.totalCents - statement.simpleSavingsCents).toBe(statement.netCents);
    // every year with a paycheck, newest first (and the year the test runs in, whatever it is)
    expect(statement.years.filter((year) => year <= 2027)).toEqual([2027, 2026]);
  });

  it('names a bonus only from the lines the check itself froze: a check whose lines do not add up shows that pay as other pay, whatever the ledger says', async () => {
    // the check stored 50.00 of Tech Rewards pay and froze a 40.00 stay bonus line; the ledger holds a paid 50.00 line for it
    const short = await addCheck('2026-04-06', '2026-04-17', { regular: 100000, techRewards: 5000, lines: [['stay_bonus', 4000]] });
    await paidLine(short, 'stay_bonus', 5000, '2026-04-06');
    // a check with Tech Rewards pay and no frozen line at all, and a paid ledger line of another amount
    const bare = await addCheck('2026-05-04', '2026-05-15', { regular: 100000, techRewards: 7000 });
    await paidLine(bare, 'season_bonus', 9000, '2026-05-04');
    // a check whose lines add up is named, beside them
    await addCheck('2026-12-07', '2026-12-18', { regular: 100000, techRewards: 30000, lines: [['december_gift', 30000]] });
    // a paid ledger line on a check that stored no Tech Rewards pay changes nothing
    const plain = await addCheck('2026-06-08', '2026-06-19', { regular: 100000 });
    await paidLine(plain, 'stay_bonus', 2500, '2026-06-08');

    const { statement } = (await own()).body;
    expect(statement.pay).toMatchObject({ seasonBonusCents: 0, stayBonusCents: 0, decemberGiftCents: 30000, otherCents: 12000, grossCents: 442000 });
    expect(Object.entries(statement.pay).filter(([key]) => key !== 'grossCents').reduce((total, [, value]) => total + value, 0)).toBe(442000);
    expect(Object.values(statement.pay).every((value) => value >= 0)).toBe(true);
  });

  it('gross pay is the year\'s Form W-2 box 5 for the same technician', async () => {
    await addCheck('2025-12-22', '2026-01-02', { regular: 90000, commission: 4000 });
    await addCheck('2026-06-08', '2026-06-19', { regular: 100000, overtime: 15000, healthAllowance: 30000 });
    await addCheck('2026-12-28', '2027-01-08', { regular: 70000 });
    await addCheck('2026-07-13', '2026-07-24', { regular: 22222 }, { status: 'voided' });
    const { statement } = (await own()).body;
    const forms = await readFormFigures({ year: 2026, quarter: 4, conn: trx });
    const w2 = forms.w2.find((form) => form.technicianId === techId);
    expect(statement.pay.grossCents).toBe(239000);
    expect(w2.box5).toBe(statement.pay.grossCents);
    expect(w2.box2).toBe(statement.withheld.federalIncomeTaxCents);
    expect(w2.box4).toBe(statement.withheld.socialSecurityCents);
    expect(w2.box6).toBe(statement.withheld.medicareCents);
  });

  it('shows a technician only their own statement; the office opens any one technician\'s', async () => {
    await addCheck('2026-06-08', '2026-06-19', { regular: 100000 });
    await addCheck('2026-06-15', '2026-06-26', { regular: 55500 }, { tech: otherTechId });
    expect((await own()).body.statement.pay.grossCents).toBe(100000);
    expect((await own('?year=2026', { tech: otherTechId })).body.statement).toMatchObject({ technician: { id: otherTechId, name: 'Sample Other' }, pay: { grossCents: 55500 } });
    // a technician cannot name another person, on either router
    expect((await own(`?year=2026&technicianId=${otherTechId}`)).status).toBe(403);
    expect((await api(`${adminUrl}/${otherTechId}/year-statement?year=2026`)).status).toBe(403);
    // the office
    const preview = await api(`${adminUrl}/${otherTechId}/year-statement?year=2026`, { role: 'admin' });
    expect(preview.status).toBe(200);
    expect(preview.body.statement).toEqual((await own('?year=2026', { tech: otherTechId })).body.statement);
    expect(JSON.stringify(preview.body)).not.toMatch(/employer(Social|Medicare)|futa|reemployment|ssn/i);
  });

  it('the office still reaches a former technician: the picker lists them once they have a finalized paycheck, and their statement opens', async () => {
    await addCheck('2026-06-08', '2026-06-19', { regular: 100000 });
    await addCheck('2026-06-15', '2026-06-26', { regular: 55500 }, { tech: otherTechId });
    const neverPaid = randomUUID();
    await trx('technicians').insert({ id: neverPaid, name: 'Sample Never Paid', employment_type: 'w2', employment_status: 'inactive', active: false, pay_rate: '25.00' });
    await trx('technicians').where({ id: otherTechId }).update({ active: false, employment_status: 'inactive' });
    const picker = (await api(adminUrl, { role: 'admin' })).body.technicians;
    expect(picker.filter((t) => [techId, otherTechId, neverPaid].includes(t.id)).sort((a, b) => (a.name < b.name ? -1 : 1)))
      .toEqual([{ id: techId, name: 'Sample Employee' }, { id: otherTechId, name: 'Sample Other', active: false }]);
    const former = await api(`${adminUrl}/${otherTechId}/year-statement?year=2026`, { role: 'admin' });
    expect(former.status).toBe(200);
    expect(former.body.statement).toMatchObject({ technician: { id: otherTechId, name: 'Sample Other' }, checkCount: 1, pay: { grossCents: 55500 } });
  });

  it('no year is this year; a bad year is 400 and an unknown technician 404, with no statement', async () => {
    await addCheck('2026-06-08', '2026-06-19', { regular: 100000 });
    const now = new Date('2026-07-01T16:00:00Z');
    expect(await getYearStatement(techId, undefined, { now })).toMatchObject({ year: 2026, pay: { grossCents: 100000 }, years: [2026] });
    // 11:30 PM Eastern on Dec 31 is still the old year
    expect((await getYearStatement(techId, undefined, { now: new Date('2027-01-01T04:30:00Z') })).year).toBe(2026);
    expect((await getYearStatement(techId, undefined, { now: new Date('2027-01-01T05:30:00Z') }))).toMatchObject({ year: 2027, checkCount: 0, years: [2027, 2026] });
    // a year that is not one plain value (an array, an object) is a 400 too, never a 500 and never a read
    for (const bad of ['year=26', 'year=2019', 'year=2101', 'year=abcd', 'year[]=2026', 'year=2026&year=2025', 'year[toString]=x', 'year[a]=2026']) {
      const result = await own(`?${bad}`);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'Year must be a four-digit year, 2020 or later.' });
    }
    expect((await api(`${adminUrl}/${randomUUID()}/year-statement?year=2026`, { role: 'admin' })).status).toBe(404);
    expect((await api(`${adminUrl}/not-a-uuid/year-statement?year=2026`, { role: 'admin' })).status).toBe(400);
  });

  it('the technician route is off with the gate off; the office preview still works', async () => {
    await addCheck('2026-06-08', '2026-06-19', { regular: 100000 });
    delete process.env.GATE_TECH_REWARDS_SCOREBOARD;
    const off = await own();
    expect(off.status).toBe(404);
    expect(off.body).toEqual({ enabled: false });
    expect((await api(`${adminUrl}/${techId}/year-statement?year=2026`, { role: 'admin' })).body.statement.pay.grossCents).toBe(100000);
  });
});
