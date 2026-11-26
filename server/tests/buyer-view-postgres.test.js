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

postgres('buyer view (live Postgres)', () => {
  let database;
  let trx;
  let seq = 0;

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
  });
  afterEach(async () => {
    await trx.rollback();
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
          'book_gross_margin_pct', 'owner_field_hours', 'owner_field_allowance', 'owner_paid_profit', 'sde', 'recurring_revenue',
          'recurring_mature_revenue', 'prepaid_owed', 'autopay_renewing_share', 'owner_field_hourly_rate',
        ])
        .select('column_name', 'data_type', 'numeric_precision', 'numeric_scale', 'is_nullable');
      expect(rows).toHaveLength(10);
      expect(rows.every((r) => r.data_type === 'numeric' && r.is_nullable === 'YES')).toBe(true);
      const byName = Object.fromEntries(rows.map((r) => [r.column_name, [r.numeric_precision, r.numeric_scale]]));
      expect(byName.owner_field_hourly_rate).toEqual([8, 2]);
      expect(byName.autopay_renewing_share).toEqual([6, 4]);
      expect(byName.sde).toEqual([12, 2]);
    });
  });
});
