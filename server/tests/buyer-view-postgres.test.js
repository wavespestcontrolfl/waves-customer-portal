// Buyer view columns and metrics against real PostgreSQL (one rolled-back transaction per test): the owner's field time
// at standard minutes (a grouped visit as one stop), the P&L-based margin and EBITDA, plan members' revenue (mature part,
// autopay share, test accounts left out), prepaid money owed at month end, plan revenue kept, and the stored columns.
// All names and numbers are synthetic. No network, no spend, no customer.
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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The owner phones, as ops-buyer-metrics.js tells the owner apart.
jest.mock('../services/twilio', () => ({ isKnownOwnerPhone: (phone) => ['+19415550100', '+19415550101'].includes(phone) }));

const { randomUUID } = require('node:crypto');
const snapshot = require('../services/monthly-financial-snapshot');
const cols = require('../services/monthly-snapshot-buyer-columns');
const view = require('../services/buyer-view');
const { buildPnlReport } = require('../services/pnl-report');

jest.setTimeout(60000);
const OWNER_PHONE = '+19415550100';
const NOW = new Date('2026-11-26T15:00:00Z'); // Thursday, 10 AM ET
const DRIVE_KEY = 'global_drive_time';

postgres('buyer view (live Postgres)', () => {
  let database;
  let trx;
  let seq = 0;
  const pricingConstants = require('../services/pricing-engine/constants');
  const OLD_DRIVE = pricingConstants.GLOBAL.DRIVE_TIME;
  // The configured Average Drive Time job-costing reads (pricing_config global_drive_time), set inside the transaction and
  // loaded by the same refresh job-costing runs (the sync is due once the cache is invalidated).
  const setDrive = async (minutes) => {
    await trx('pricing_config').insert({ config_key: DRIVE_KEY, name: 'Average drive time', category: 'global', data: JSON.stringify({ value: minutes }) })
      .onConflict('config_key').merge(['data']);
    require('../services/pricing-engine').invalidatePricingConfigCache();
  };

  const customer = async (fields = {}) => {
    seq += 1;
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Sample', last_name: `Customer${seq}`, phone: `+1941555${String(1000 + seq)}`, ...fields,
    });
    return id;
  };
  const technician = async (fields = {}) => {
    seq += 1;
    const id = randomUUID();
    await trx('technicians').insert({
      id, name: `Sample Tech ${seq}`, active: true, employment_status: 'active', field_dispatchable: true, ...fields,
    });
    return id;
  };
  // A completed service_records row; `scheduled` makes its scheduled_services row too (group, prepay term).
  const visit = async (customerId, date, fields = {}, scheduled = null) => {
    let scheduledServiceId = null;
    if (scheduled) {
      scheduledServiceId = randomUUID();
      await trx('scheduled_services').insert({
        id: scheduledServiceId, customer_id: customerId, scheduled_date: date, service_type: 'Pest Control Visit', status: 'completed', ...scheduled,
      });
    }
    await trx('service_records').insert({
      id: randomUUID(), customer_id: customerId, service_date: date, service_type: 'Pest Control Visit', status: 'completed',
      scheduled_service_id: scheduledServiceId, ...fields,
    });
  };
  // The start of a recurring series: a scheduled visit (never done here) that is the first of the series.
  const series = (customerId, date) => trx('scheduled_services').insert({
    id: randomUUID(), customer_id: customerId, scheduled_date: date, service_type: 'Pest Control Visit', status: 'cancelled', is_recurring: true,
  });
  const group = async (customerId, date) => {
    const id = randomUUID();
    await trx('service_visits').insert({ id, customer_id: customerId, scheduled_date: date, stop_base_key: `sample:${id}`, created_by: 'test' });
    return id;
  };
  const expense = async (categoryName, amount, date) => {
    const cat = await trx('expense_categories').where({ name: categoryName }).first('id');
    await trx('expenses').insert({ category_id: cat.id, description: `Sample ${categoryName}`, amount, expense_date: date, tax_year: Number(date.slice(0, 4)) });
  };
  const settings = (fields, effective_date = '2026-09-15') => trx('company_financials').insert({ effective_date, ...fields });

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's: the managed runner sets both marks and names
    // the database after the worktree id. Or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter of a connection string into its settings: refuse a URL with a query
    // and build the pool from the parts this guard read.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
  });
  afterAll(async () => { if (database) await database.destroy(); });

  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    // Only this test's technicians count: any seeded one is set aside inside the rolled-back transaction.
    await trx('technicians').update({ role: 'technician', employment_status: 'inactive' });
    await trx('service_records').del();
    await trx('scheduled_services').del();
    await setDrive(20);
  });
  afterEach(async () => {
    await trx.rollback();
    pricingConstants.GLOBAL.DRIVE_TIME = OLD_DRIVE;
    require('../services/pricing-engine').invalidatePricingConfigCache();
  });

  describe('the owner and the owner\'s field time', () => {
    it('counts the owner\'s completed stops at standard minutes, a grouped visit once, and nobody else\'s', async () => {
      const owner = await technician({ role: 'admin', phone: OWNER_PHONE });
      const other = await technician({ role: 'technician' });
      const home = await customer();
      const grouped = await group(home, '2026-10-05');
      await visit(home, '2026-10-05', { technician_id: owner, labor_hours: 3 }, { visit_id: grouped });
      await visit(home, '2026-10-05', { technician_id: owner, service_type: 'Lawn Care Visit', labor_hours: 3 }, { visit_id: grouped });
      await visit(home, '2026-10-06', { technician_id: owner, labor_hours: 5 }); // an app span of 5 h is never read: 25 standard
      await visit(home, '2026-10-07', { technician_id: other }); // someone else's stop
      await visit(home, '2026-10-08', { technician_id: owner, status: 'cancelled' });
      await visit(home, '2026-09-30', { technician_id: owner }); // the day before the month
      await visit(home, '2026-11-01', { technician_id: owner }); // the day after
      expect(await cols.ownerFieldMinutes(trx, owner, '2026-10-01', '2026-10-31')).toEqual({ minutes: (25 + 20 + 20) + (25 + 20), stops: 2 });
    });

    it('the drive is the configured Average Drive Time: 30 minutes, not a fixed 20', async () => {
      const owner = await technician({ role: 'admin', phone: OWNER_PHONE });
      const home = await customer();
      await visit(home, '2026-10-06', { technician_id: owner });
      await setDrive(30);
      expect(await cols.ownerFieldMinutes(trx, owner, '2026-10-01', '2026-10-31')).toEqual({ minutes: 25 + 30, stops: 1 });
    });

    it('hours x the wage in effect on the last day: later rows never change an earlier month', async () => {
      const owner = await technician({ role: 'admin', phone: OWNER_PHONE });
      const home = await customer();
      for (let day = 1; day <= 8; day += 1) await visit(home, `2026-10-${String(day).padStart(2, '0')}`, { technician_id: owner });
      await settings({ owner_field_hourly_rate: '30.00' }, '2026-10-20');
      await settings({ owner_field_hourly_rate: '60.00' }, '2026-11-05');
      const octoberFin = (await trx('company_financials').where('effective_date', '<=', '2026-10-31').orderBy('effective_date', 'desc').first());
      expect(await cols.ownerFieldTime(trx, octoberFin, '2026-10-01', '2026-10-31')).toEqual({ hours: 6, allowance: 180, onPayroll: false });
    });

    it('two owners, none, an inactive admin or a technician-role row with the owner phone is unavailable; an owner on payroll is flagged', async () => {
      expect(await cols.ownerForSnapshot(trx)).toBeNull();
      const owner = await technician({ role: 'admin', phone: OWNER_PHONE });
      expect(await cols.ownerForSnapshot(trx)).toEqual({ id: owner, onPayroll: false });
      const second = await technician({ role: 'admin', phone: '+19415550101' });
      expect(await cols.ownerForSnapshot(trx)).toBeNull(); // two known owner phones
      await trx('technicians').where({ id: second }).update({ employment_status: 'inactive' });
      expect(await cols.ownerForSnapshot(trx)).toEqual({ id: owner, onPayroll: false });
      await trx('technicians').where({ id: owner }).update({ employment_type: 'w2' });
      expect(await cols.ownerForSnapshot(trx)).toMatchObject({ onPayroll: true });
      await trx('technicians').where({ id: owner }).update({ role: 'technician' });
      expect(await cols.ownerForSnapshot(trx)).toBeNull();
    });
  });

  describe('a month snapshot with the buyer columns', () => {
    let planOld; let planNew; let nonMember; let testAccount; let owner;
    const seedMonth = async () => {
      owner = await technician({ role: 'admin', phone: OWNER_PHONE });
      const other = await technician({ role: 'technician' });
      planOld = await customer({ waveguard_tier: 'Gold', member_since: '2024-01-01', autopay_enabled: true });
      planNew = await customer({ waveguard_tier: 'Silver', member_since: '2026-09-15' });
      nonMember = await customer({ waveguard_tier: 'One-Time' }); // a sentinel tier is not a plan
      testAccount = await customer({ first_name: 'Adam', last_name: 'Martinez', waveguard_tier: 'Gold', member_since: '2024-01-01' });
      // planOld is on chargeable autopay (enrolled, with a usable saved card); planNew is not enrolled.
      await trx('payment_methods').insert({
        customer_id: planOld, processor: 'stripe', is_default: true, autopay_enabled: true, stripe_payment_method_id: `pm_sample_${seq}`,
        method_type: 'card', exp_month: '12', exp_year: '2035',
      });
      await visit(planOld, '2026-10-02', { revenue: 300, technician_id: owner });
      await visit(planOld, '2026-10-16', { revenue: 100, technician_id: other });
      await visit(planNew, '2026-10-20', { revenue: 200, technician_id: other });
      await visit(nonMember, '2026-10-21', { revenue: 400, technician_id: other });
      await visit(testAccount, '2026-10-22', { revenue: 500, technician_id: other });
      await visit(planOld, '2026-09-30', { revenue: 7000, technician_id: other }); // the day before: out
      await visit(planOld, '2026-11-01', { revenue: 7000, technician_id: other }); // the day after: out
      const grouped = await group(nonMember, '2026-10-23');
      await visit(nonMember, '2026-10-23', { revenue: 10, technician_id: owner }, { visit_id: grouped });
      await visit(nonMember, '2026-10-23', { revenue: 10, technician_id: owner, service_type: 'Lawn Care Visit' }, { visit_id: grouped });
      // Cash and the books: 5000 received, 1000 of supplies (cost of goods), 100 interest, 500 insurance.
      await trx('payments').insert({ customer_id: planOld, amount: 5000, status: 'paid', payment_date: '2026-10-10', processor: 'stripe', stripe_charge_id: `ch_sample_${seq}` });
      await expense('Supplies', '1000.00', '2026-10-05');
      await expense('Interest', '100.00', '2026-10-05');
      await expense('Insurance', '500.00', '2026-10-05');
      await settings({ owner_field_hourly_rate: '25.00', owner_office_hours_per_month: '10', owner_office_hourly_rate: '30.00' });
    };

    it('recurring revenue: plan members only, the mature part and the autopay share; test accounts and other months stay out', async () => {
      await seedMonth();
      expect(await cols.recurringRevenue(trx, '2026-10-01', '2026-10-31', NOW)).toEqual({
        recurring_revenue: 600,
        recurring_mature_revenue: 400,
        autopay_renewing_share: 0.6667,
      });
    });

    it('plan revenue is judged on each visit\'s own date: a recurring-series visit counts without a tier, a visit after the customer churned or before they started does not', async () => {
      const other = await technician({ role: 'technician' });
      // Offboarded: tier cleared, churned 2026-10-10. Their series visit on 10-02 stays plan revenue; a one-off after does not.
      const left = await customer({ waveguard_tier: null, member_since: '2024-01-01', churned_at: '2026-10-10' });
      await series(left, '2024-02-01');
      await visit(left, '2026-10-02', { revenue: 50, technician_id: other }, { is_recurring: true });
      await visit(left, '2026-10-20', { revenue: 7, technician_id: other });
      // Still tiered but churned 2026-10-10: before the churn date counts, after does not.
      const churned = await customer({ waveguard_tier: 'Gold', member_since: '2024-01-01', churned_at: '2026-10-10' });
      await visit(churned, '2026-10-05', { revenue: 100, technician_id: other });
      await visit(churned, '2026-10-20', { revenue: 9, technician_id: other });
      // Started 2026-10-15: a visit before that is not plan revenue yet, one after is.
      const started = await customer({ waveguard_tier: 'Silver', member_since: '2026-10-15' });
      await visit(started, '2026-10-05', { revenue: 11, technician_id: other });
      await visit(started, '2026-10-20', { revenue: 30, technician_id: other });
      // A prepay-term visit counts with no tier at all; a one-time customer's plain visit does not.
      const term = await trx('annual_prepay_terms').insert({ customer_id: left, prepay_amount: 100, term_start: '2026-06-01', term_end: '2027-05-31', status: 'active' }).returning('id');
      const prepaid = await customer({ waveguard_tier: null, member_since: '2024-01-01' });
      await trx('annual_prepay_terms').insert({ customer_id: prepaid, prepay_amount: 100, term_start: '2024-03-01', term_end: '2025-02-28', status: 'cancelled' });
      await visit(prepaid, '2026-10-12', { revenue: 20, technician_id: other }, { annual_prepay_term_id: term[0].id || term[0] });
      await visit(await customer({ waveguard_tier: 'One-Time' }), '2026-10-13', { revenue: 500, technician_id: other });
      const result = await cols.recurringRevenue(trx, '2026-10-01', '2026-10-31', NOW);
      expect(result.recurring_revenue).toBe(50 + 100 + 30 + 20);
      expect(result.recurring_mature_revenue).toBe(50 + 100 + 20); // started 2026-10-15 is not a mature plan
    });

    it('plan age comes from plan evidence, not customer tenure: a long-time customer whose plan began recently is not mature; a tier-only customer uses member_since', async () => {
      const other = await technician({ role: 'technician' });
      const lateStart = await customer({ waveguard_tier: 'Gold', member_since: '2020-01-01' }); // customer for years, plan since June
      await series(lateStart, '2026-06-01');
      await visit(lateStart, '2026-10-05', { revenue: 80, technician_id: other }, { is_recurring: true });
      const seriesOld = await customer({ waveguard_tier: 'Gold', member_since: '2026-09-01' }); // tenure says new, series says old
      await series(seriesOld, '2025-02-01');
      await visit(seriesOld, '2026-10-06', { revenue: 60, technician_id: other }, { is_recurring: true });
      const tierOnly = await customer({ waveguard_tier: 'Silver', member_since: '2024-01-01' }); // no series or term: member_since
      await visit(tierOnly, '2026-10-07', { revenue: 40, technician_id: other });
      const result = await cols.recurringRevenue(trx, '2026-10-01', '2026-10-31', NOW);
      expect(result.recurring_revenue).toBe(180);
      expect(result.recurring_mature_revenue).toBe(100); // seriesOld 60 + tierOnly 40
    });

    it('an identifiable one-time job is not plan revenue even for a tiered customer or when it hangs off a series; plan visits still are', async () => {
      const other = await technician({ role: 'technician' });
      const member = await customer({ waveguard_tier: 'Gold', member_since: '2024-01-01' });
      const wdo = await trx('services').insert({ service_key: `wdo_${seq}`, name: 'WDO Inspection Service', category: 'termite', billing_type: 'one_time' }).returning('id');
      const wdoId = wdo[0].id || wdo[0];
      await visit(member, '2026-10-02', { revenue: 150, technician_id: other, service_id: wdoId }); // a standalone WDO inspection
      const parent = randomUUID();
      await trx('scheduled_services').insert({ id: parent, customer_id: member, scheduled_date: '2026-01-05', service_type: 'Pest Control Visit', status: 'completed', is_recurring: true });
      await visit(member, '2026-10-05', { revenue: 90, technician_id: other, service_id: wdoId }, { recurring_parent_id: parent }); // a one-time booster on the series
      await visit(member, '2026-10-06', { revenue: 80, technician_id: other }, { service_type: 'WDO Inspection', recurring_parent_id: parent }); // no catalog link: the type says inspection
      await visit(member, '2026-10-07', { revenue: 60, technician_id: other }, { recurring_parent_id: parent }); // the plan's own visit
      await visit(member, '2026-10-09', { revenue: 40, technician_id: other }); // a plain visit by a tiered member: membership
      expect((await cols.recurringRevenue(trx, '2026-10-01', '2026-10-31', NOW)).recurring_revenue).toBe(60 + 40);
    });

    it('membership uses the tier frozen on the visit when recorded: a label is not a member, a member then stays one after the tier is cleared', async () => {
      const other = await technician({ role: 'technician' });
      const label = await customer({ waveguard_tier: 'Gold', member_since: '2024-01-01' }); // tier today, but a label on that visit
      await visit(label, '2026-10-02', { revenue: 11, technician_id: other, service_tier: 'Gold', service_tier_source: 'auto' });
      const wasMember = await customer({ waveguard_tier: null, member_since: '2024-01-01' }); // tier since cleared (no churn date)
      await visit(wasMember, '2026-10-03', { revenue: 70, technician_id: other, service_tier: 'Silver', service_tier_source: 'manual' });
      const sentinel = await customer({ waveguard_tier: 'Gold', member_since: '2024-01-01' }); // recorded as one-time on that visit
      await visit(sentinel, '2026-10-04', { revenue: 13, technician_id: other, service_tier: 'One-Time', service_tier_source: 'manual' });
      expect((await cols.recurringRevenue(trx, '2026-10-01', '2026-10-31', NOW)).recurring_revenue).toBe(70);
    });

    it('stores field time, the books margin, SDE and owner-paid profit with the owner\'s allowances taken out', async () => {
      await seedMonth();
      const row = await snapshot.computeMonthSnapshot('2026-10', trx);
      const pnl = await buildPnlReport(trx, '2026-10-01', '2026-10-31');
      // Owner stops: planOld pest (25 + 20) and the grouped visit pest + lawn (25 + 20 + 20) = 110 minutes = 1.83 h, at $25.
      expect(row).toMatchObject({ owner_field_hours: 1.83, owner_field_allowance: 45.75, owner_allowance: 300 });
      const ebitda = Math.round((pnl.netIncome + pnl.deductions.depreciation + 100) * 100) / 100;
      expect(row.sde).toBe(ebitda);
      expect(row.owner_paid_profit).toBe(Math.round((ebitda - 300 - 45.75) * 100) / 100);
      expect(row.cash_revenue).toBe(5000);
      expect(row.book_gross_profit).toBe(Math.round((pnl.grossProfit - 45.75) * 100) / 100);
      expect(row.book_gross_margin_pct).toBe(Math.round(((pnl.grossProfit - 45.75) / 5000) * 10000) / 100);
      expect(pnl.cogs.materials).toBe(1000); // supplies are the cost of goods
      expect(row).toMatchObject({ recurring_revenue: 600, recurring_mature_revenue: 400, autopay_renewing_share: 0.6667, prepaid_owed: 0 });
    });

    it('no field wage set counts 0 allowance but still reports the hours; no single owner login leaves profit blank when a wage is set', async () => {
      await seedMonth();
      await trx('company_financials').update({ owner_field_hourly_rate: null });
      expect(await snapshot.computeMonthSnapshot('2026-10', trx)).toMatchObject({ owner_field_hours: 1.83, owner_field_allowance: 0 });
      await trx('company_financials').update({ owner_field_hourly_rate: 25 });
      await trx('technicians').where({ phone: OWNER_PHONE }).update({ phone: '+19415550999' });
      const row = await snapshot.computeMonthSnapshot('2026-10', trx);
      expect(row).toMatchObject({ owner_field_hours: null, owner_field_allowance: null, owner_paid_profit: null, book_gross_margin_pct: null });
      expect(row.sde).not.toBeNull();
    });

    it('an owner on payroll: no allowance, and profit, SDE and margin stay blank', async () => {
      await seedMonth();
      await trx('technicians').where({ phone: OWNER_PHONE }).update({ employment_type: 'w2' });
      expect(await snapshot.computeMonthSnapshot('2026-10', trx)).toMatchObject({
        owner_field_allowance: 0, owner_paid_profit: null, sde: null, book_gross_margin_pct: null, owner_field_hours: 1.83,
      });
    });

    it('stores every buyer column on the month\'s row, and the stored row feeds the buyer view', async () => {
      await seedMonth();
      await snapshot.upsertMonthSnapshot('2026-10', trx);
      const stored = await trx('monthly_financial_snapshots').where({ month: '2026-10-01' }).first();
      expect(Number(stored.owner_field_allowance)).toBe(45.75);
      expect(Number(stored.recurring_revenue)).toBe(600);
      expect(Number(stored.autopay_renewing_share)).toBe(0.6667);
      const payload = await view.getBuyerView({ db: trx, now: NOW });
      expect(payload.months).toEqual({ count: 1, from: '2026-10-01', to: '2026-10-01' });
      expect(payload.revenue).toMatchObject({ value: 5000, growthPct: null, monthsCounted: 1 });
      expect(payload.recurring).toMatchObject({ recurringRevenue: 600, matureShareOfRecurring: 66.7 });
      expect(payload.ownerProfit.sde).toBe(Number(stored.sde));
      expect(payload.ownerProfit.ownerPay).toEqual({ officeMonths: 1, fieldMonths: 1, months: 1 });
      expect(payload.officeCost.paidStops).toBe(Number(stored.paid_stops));
    });
  });

  describe('per-job margin from stored job profit', () => {
    it('a $1,000 month at $200 cost and a callback-only month that lost $100 give 70% over the two months, not 80%', async () => {
      const other = await technician({ role: 'technician' });
      const home = await customer();
      await visit(home, '2026-09-10', { revenue: 1000, gross_profit: 800, technician_id: other });
      await visit(home, '2026-10-10', { revenue: 0, gross_profit: -100, technician_id: other, is_callback: true }); // a free return: cost, no revenue
      const september = await snapshot.upsertMonthSnapshot('2026-09', trx);
      const october = await snapshot.upsertMonthSnapshot('2026-10', trx);
      expect(september).toMatchObject({ completed_job_revenue: 1000, job_gross_profit: 800, gross_margin_pct: 80 });
      expect(october).toMatchObject({ completed_job_revenue: 0, job_gross_profit: -100, gross_margin_pct: null });
      const payload = await view.getBuyerView({ db: trx, now: NOW });
      expect(payload.grossMargin).toMatchObject({ perJobAtStandardPct: 70, perJobMonthsCounted: 2 });
    });
  });

  describe('the recurring share denominator', () => {
    it('is stored in the same snapshot: the revenue of every customer except the internal test accounts', async () => {
      const plan = await customer({ waveguard_tier: 'Gold', member_since: '2024-01-01' });
      const oneTime = await customer({ waveguard_tier: 'One-Time' });
      const testAccount = await customer({ first_name: 'Adam', last_name: 'Martinez', waveguard_tier: 'Gold', member_since: '2024-01-01' });
      await visit(plan, '2026-10-02', { revenue: 100 });
      await visit(oneTime, '2026-10-03', { revenue: 100 });
      await visit(testAccount, '2026-10-04', { revenue: 5000 });
      await visit(plan, '2026-09-30', { revenue: 7000 }); // the day before: out
      expect(await cols.eligibleJobRevenue(trx, '2026-10-01', '2026-10-31')).toBe(200);
      const stored = await snapshot.upsertMonthSnapshot('2026-10', trx);
      expect(stored).toMatchObject({ recurring_revenue: 100, eligible_job_revenue: 200 });
      expect(stored.completed_job_revenue).toBe(5200); // includes the test account, so it is not the denominator
      const payload = await view.getBuyerView({ db: trx, now: NOW });
      expect(payload.recurring).toMatchObject({ share: 50, matureShareOfRevenue: 50 }); // 100 / 200, not 100 / 5200
    });
  });

  describe('prepaid money owed', () => {
    let home;
    const term = async (fields = {}, invoiceFields = {}) => {
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: home, token: `tok-${randomUUID()}`, invoice_number: `INV-${randomUUID().slice(0, 8)}`,
        status: 'paid', paid_at: '2026-06-02T15:00:00Z', total: 1200, ...invoiceFields,
      });
      const id = randomUUID();
      await trx('annual_prepay_terms').insert({
        id, customer_id: home, prepay_invoice_id: invoiceId, prepay_amount: 1200, term_start: '2026-06-01', term_end: '2027-05-31', status: 'active', ...fields,
      });
      return id;
    };
    const termVisit = (termId, date) => visit(home, date, { revenue: 300 }, { annual_prepay_term_id: termId });
    beforeEach(async () => { home = await customer({ waveguard_tier: 'Gold' }); });

    it('prepay amount less the revenue of its visits done by month end; a later visit still counts as owed on that date', async () => {
      const termId = await term();
      await termVisit(termId, '2026-06-10');
      await termVisit(termId, '2026-10-02');
      await termVisit(termId, '2026-11-12');
      expect(await cols.prepaidOwed(trx, '2026-10-31')).toBe(600);
      expect(await cols.prepaidOwed(trx, '2026-11-30')).toBe(300);
      expect(await cols.prepaidOwed(trx, '2026-05-31')).toBe(0); // before the term started
    });

    it('money collected before the term starts is owed from the collection date: an October payment for a November term', async () => {
      const termId = await term({ term_start: '2026-11-01', term_end: '2027-10-31' }, { paid_at: '2026-10-20T15:00:00Z' });
      expect(await cols.prepaidOwed(trx, '2026-10-31')).toBe(1200); // collected, no visit done yet
      expect(await cols.prepaidOwed(trx, '2026-10-19')).toBe(0); // not collected yet
      await termVisit(termId, '2026-11-10');
      expect(await cols.prepaidOwed(trx, '2026-11-30')).toBe(900);
    });

    describe('refunds against the term\'s invoice', () => {
      const payment = (pi, fields = {}) => trx('payments').insert({
        customer_id: home, amount: 1200, status: 'paid', payment_date: '2026-06-02', processor: 'stripe', stripe_payment_intent_id: pi, ...fields,
      }).returning('id').then((r) => r[0].id || r[0]);
      const refund = (paymentId, amount, at) => trx('stripe_payout_transactions').insert({
        type: 'refund', reporting_category: 'refund', amount: -amount, payment_id: paymentId, created_at_stripe: at,
      });

      it('a partial refund recorded by month end reduces what is owed; one recorded later does not yet', async () => {
        const termId = await term({}, { stripe_payment_intent_id: 'pi_sample_1' });
        const paymentId = await payment('pi_sample_1', { refund_amount: 500, refund_status: 'partial' });
        await refund(paymentId, 200, '2026-09-10T15:00:00Z');
        await refund(paymentId, 300, '2026-11-10T15:00:00Z');
        await termVisit(termId, '2026-06-10');
        expect(await cols.prepaidOwed(trx, '2026-10-31')).toBe(1200 - 300 - 200); // visit 300, refund 200 so far
        expect(await cols.prepaidOwed(trx, '2026-11-30')).toBe(1200 - 300 - 500);
      });

      it('a refund the ledger cannot date (the payment says more was refunded than the ledger holds) leaves the month NULL, never a wrong figure', async () => {
        await term({}, { stripe_payment_intent_id: 'pi_sample_2' });
        const paymentId = await payment('pi_sample_2', { refund_amount: 500, refund_status: 'partial' });
        await refund(paymentId, 200, '2026-09-10T15:00:00Z'); // 300 of the 500 has no ledger row
        expect(await cols.prepaidOwed(trx, '2026-10-31')).toBeNull();
      });

      it('a term with no refunds is unaffected by another term\'s refund', async () => {
        await term({}, { stripe_payment_intent_id: 'pi_sample_3' });
        const otherPayment = await payment('pi_sample_other', { refund_amount: 100, refund_status: 'partial' });
        await refund(otherPayment, 100, '2026-09-10T15:00:00Z');
        expect(await cols.prepaidOwed(trx, '2026-10-31')).toBe(1200);
      });
    });

    it('only paid coverage counts: unpaid, paid after month end, expired and cancelled terms are left out; a fully used term owes 0', async () => {
      await term({ status: 'payment_pending' }, { status: 'sent', paid_at: null });
      await term({}, { paid_at: '2026-11-05T15:00:00Z' }); // paid after October ended
      await term({ term_start: '2025-06-01', term_end: '2026-05-31' }); // expired before
      await term({ status: 'cancelled', renewal_decision: null }, { status: 'refunded' });
      const used = await term();
      for (const date of ['2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10']) await termVisit(used, date);
      expect(await cols.prepaidOwed(trx, '2026-10-31')).toBe(0);
    });
  });

  describe('plan revenue kept and owner hours', () => {
    const member = (fields = {}) => customer({ waveguard_tier: 'Gold', member_since: '2023-01-01', ...fields });

    it('what plan members of 24 months or more pay now, capped at what they paid, over what they paid then', async () => {
      const kept = await member();
      const cut = await member();
      const gone = await member();
      const tooYoung = await member({ member_since: '2025-06-01' });
      const nonMember = await customer({ waveguard_tier: null, member_since: '2023-01-01' });
      const testAccount = await member({ first_name: 'Adam', last_name: 'Martinez' });
      for (const [id, then, now] of [[kept, 1000, 1200], [cut, 1000, 400], [gone, 500, null], [tooYoung, 900, 900], [nonMember, 900, 900], [testAccount, 900, 0]]) {
        await visit(id, '2025-03-01', { revenue: then });
        if (now) await visit(id, '2026-03-01', { revenue: now });
      }
      await visit(kept, '2025-10-31', { revenue: 0 });
      await visit(kept, '2024-10-31', { revenue: 9000 }); // before the earlier window
      await visit(kept, '2026-11-02', { revenue: 9000 }); // after the latest closed month
      const result = await view.planRevenueKept(trx, NOW);
      expect(result).toMatchObject({ customers: 3, thenRevenue: 2500, keptRevenue: 1400, pct: 56 });
      expect(result.windows).toEqual({ latest: { start: '2025-11-01', end: '2026-10-31' }, earlier: { start: '2024-11-01', end: '2025-10-31' } });
    });

    it('a customer who cancelled and had their tier cleared still counts in what was paid earlier: two equal customers, one leaves, is 50%', async () => {
      const stays = await member();
      const leaves = await member();
      for (const id of [stays, leaves]) {
        await series(id, '2023-02-01');
        await visit(id, '2025-03-01', { revenue: 1000 }, { is_recurring: true });
      }
      await visit(stays, '2026-03-01', { revenue: 1000 }, { is_recurring: true });
      // Offboarding clears the tier and the rate and stamps the churn date; nothing is paid after it.
      await trx('customers').where({ id: leaves }).update({ waveguard_tier: null, monthly_rate: null, churned_at: '2025-12-15' });
      expect(await view.planRevenueKept(trx, NOW)).toMatchObject({ customers: 2, thenRevenue: 2000, keptRevenue: 1000, pct: 50 });
    });

    it('only plan revenue counts on both sides: a cancelled $500 plan and a later $500 one-time job is 0% kept, not 100%', async () => {
      const gone = await member();
      await series(gone, '2023-02-01');
      await visit(gone, '2025-03-01', { revenue: 500 }, { is_recurring: true });
      await trx('customers').where({ id: gone }).update({ waveguard_tier: null, monthly_rate: null, churned_at: '2025-12-15' });
      await visit(gone, '2026-03-01', { revenue: 500 }); // a one-time job after the plan ended
      expect(await view.planRevenueKept(trx, NOW)).toMatchObject({ customers: 1, thenRevenue: 500, keptRevenue: 0, pct: 0 });
      // The same customer who kept their tier and churn date: the later job is still after the churn, so still not plan revenue.
      await trx('customers').where({ id: gone }).update({ waveguard_tier: 'Gold' });
      expect(await view.planRevenueKept(trx, NOW)).toMatchObject({ keptRevenue: 0, pct: 0 });
    });

    it('a customer whose plan began inside the earlier window is not in the cohort, whatever their customer-since date', async () => {
      const young = await member({ member_since: '2020-01-01' });
      await series(young, '2025-01-01');
      await visit(young, '2025-03-01', { revenue: 600 }, { is_recurring: true });
      await visit(young, '2026-03-01', { revenue: 600 }, { is_recurring: true });
      expect(await view.planRevenueKept(trx, NOW)).toMatchObject({ customers: 0, pct: null });
    });

    it('a tiered customer\'s earlier visits count when the visit has no series marker, as of the visit date; a tier-less customer with no marker never was a plan', async () => {
      const tiered = await member();
      await visit(tiered, '2025-03-01', { revenue: 1000 });
      await visit(tiered, '2026-03-01', { revenue: 500 });
      const never = await customer({ waveguard_tier: null, member_since: '2023-01-01' });
      await visit(never, '2025-03-01', { revenue: 900 });
      expect(await view.planRevenueKept(trx, NOW)).toMatchObject({ customers: 1, thenRevenue: 1000, keptRevenue: 500, pct: 50 });
    });

    it('no plan members that old is blank, not 0% or 100%', async () => {
      await customer({ waveguard_tier: 'Gold', member_since: '2026-01-01' });
      expect(await view.planRevenueKept(trx, NOW)).toMatchObject({ pct: null, customers: 0, thenRevenue: 0 });
    });

    it('the owner\'s field hours a week over the last 12 weeks, standard minutes', async () => {
      expect(await view.ownerHoursPerWeek(trx, NOW)).toEqual({ value: null, available: false });
      const owner = await technician({ role: 'admin', phone: OWNER_PHONE });
      const home = await customer();
      for (let day = 1; day <= 8; day += 1) await visit(home, `2026-10-${String(day).padStart(2, '0')}`, { technician_id: owner });
      await visit(home, '2026-09-03', { technician_id: owner }); // before the window (it opens 2026-09-04)
      expect(await view.ownerHoursPerWeek(trx, NOW)).toEqual({ value: 0.5, available: true, window: { start: '2026-09-04', end: '2026-11-26' } });
    });
  });

  describe('the schema', () => {
    it('adds the nullable buyer columns and the field wage at the planned precision', async () => {
      const rows = await trx('information_schema.columns')
        .whereIn('table_name', ['monthly_financial_snapshots', 'company_financials'])
        .whereIn('column_name', [
          'book_gross_profit', 'book_gross_margin_pct', 'owner_field_hours', 'owner_field_allowance', 'owner_paid_profit', 'sde', 'recurring_revenue',
          'recurring_mature_revenue', 'prepaid_owed', 'autopay_renewing_share', 'owner_field_hourly_rate', 'eligible_job_revenue', 'job_gross_profit',
        ])
        .select('column_name', 'data_type', 'numeric_precision', 'numeric_scale', 'is_nullable');
      expect(rows).toHaveLength(13);
      expect(rows.every((r) => r.data_type === 'numeric' && r.is_nullable === 'YES')).toBe(true);
      const byName = Object.fromEntries(rows.map((r) => [r.column_name, [r.numeric_precision, r.numeric_scale]]));
      expect(byName.owner_field_hourly_rate).toEqual([8, 2]);
      expect(byName.autopay_renewing_share).toEqual([6, 4]);
      expect(byName.sde).toEqual([12, 2]);
    });
  });
});
