// Office cost per stop and the monthly snapshot against real PostgreSQL (one rolled-back transaction per test):
// the real SQL on the migrated schema. Office categories only (insurance and the like stay out), the month's
// edges, callbacks and cancelled visits left out of the stops, the gross margin formula of the dashboard tile,
// the pay-run exclusion with its gate, the owner allowance, and one row per month on a second write.
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

const { randomUUID } = require('node:crypto');
const svc = require('../services/monthly-financial-snapshot');

jest.setTimeout(60000);
const GATE = 'GATE_PNL_PAY_RUN_WAGES';

postgres('monthly financial snapshot (live Postgres)', () => {
  let database;
  let trx;
  let customerId;
  const OLD_GATE = process.env[GATE];

  const expense = async (categoryName, amount, date) => {
    const cat = categoryName ? await trx('expense_categories').where({ name: categoryName }).first('id') : null;
    await trx('expenses').insert({
      category_id: cat ? cat.id : null, description: `Sample ${categoryName || 'uncategorized'}`, amount, expense_date: date, tax_year: Number(date.slice(0, 4)),
    });
  };
  // A completed service_records row. `scheduled` makes its scheduled_services row too (callback flag, included
  // follow-up, group); `scheduled.visit_id` puts it in a grouped visit.
  const visit = async (date, fields = {}, scheduled = null) => {
    let scheduledServiceId = null;
    if (scheduled) {
      scheduledServiceId = randomUUID();
      await trx('scheduled_services').insert({
        id: scheduledServiceId, customer_id: customerId, scheduled_date: date, service_type: 'Sample Visit', status: 'completed', ...scheduled,
      });
    }
    await trx('service_records').insert({
      id: randomUUID(), customer_id: customerId, service_date: date, service_type: 'Sample Visit', status: 'completed',
      scheduled_service_id: scheduledServiceId, ...fields,
    });
  };
  const group = async (date) => {
    const id = randomUUID();
    await trx('service_visits').insert({
      id, customer_id: customerId, scheduled_date: date, stop_base_key: `sample:${id}`, created_by: 'test',
    });
    return id;
  };
  // An effective-dated settings row; the default date is before the October fixtures, after the seeded row.
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
    delete process.env[GATE];
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Customer', phone: '+19415550142' });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env[GATE]; else process.env[GATE] = OLD_GATE;
  });

  describe('the office ledger read', () => {
    it('sums the five office categories inside the month and nothing else', async () => {
      await expense('Legal & Professional', '100.00', '2026-10-01'); // first day: in
      await expense('Office Expenses', '50.25', '2026-10-15');
      await expense('Utilities', '75.00', '2026-10-31'); // last day: in
      await expense('Software & Technology', '20.00', '2026-10-10');
      await expense('Home Office', '10.00', '2026-10-20');
      await expense('Insurance', '400.00', '2026-10-05'); // field cost: out
      await expense('Vehicle Expenses', '300.00', '2026-10-05');
      await expense('Advertising & Marketing', '200.00', '2026-10-05');
      await expense('Supplies', '90.00', '2026-10-05');
      await expense('Interest', '40.00', '2026-10-05');
      await expense('Taxes & Licenses', '30.00', '2026-10-05');
      await expense('Depreciation', '25.00', '2026-10-05');
      await expense(null, '15.00', '2026-10-05'); // uncategorized: not office
      await expense('Office Expenses', '999.00', '2026-09-30'); // the day before: out
      await expense('Office Expenses', '999.00', '2026-11-01'); // the day after: out
      expect(await svc.officeLedgerCost(trx, '2026-10-01', '2026-10-31')).toBe(255.25);
    });

    it('an empty month is 0', async () => {
      expect(await svc.officeLedgerCost(trx, '2026-10-01', '2026-10-31')).toBe(0);
    });

    it('pay-run exclusion: a category flagged as counted from pay runs stays out only while the gate is on', async () => {
      await expense('Office Expenses', '120.00', '2026-10-10');
      await expense('Utilities', '80.00', '2026-10-10');
      await trx('expense_categories').where({ name: 'Office Expenses' }).update({ counted_from_pay_runs: true });
      expect(await svc.officeLedgerCost(trx, '2026-10-01', '2026-10-31')).toBe(200); // gate off: both count
      process.env[GATE] = 'true';
      expect(await svc.officeLedgerCost(trx, '2026-10-01', '2026-10-31')).toBe(80); // gate on: flagged category left out
    });
  });

  describe('paid stops and the job revenue figures', () => {
    it('counts completed visits that are not callbacks; callbacks, cancelled and other months stay out', async () => {
      await visit('2026-10-02', { revenue: '100.00', gross_profit: '60.00' });
      await visit('2026-10-09', { revenue: '200.00', gross_profit: '100.00', is_callback: false });
      await visit('2026-10-12', { revenue: '0.00', gross_profit: '-20.00', is_callback: true }); // free return
      await visit('2026-10-13', { status: 'cancelled' });
      await visit('2026-10-14', { status: 'in_progress' });
      await visit('2026-09-30', { revenue: '500.00', gross_profit: '250.00' });
      await visit('2026-11-01', { revenue: '500.00', gross_profit: '250.00' });
      expect(await svc.paidStopsForWindow(trx, '2026-10-01', '2026-10-31')).toBe(2);
      // The tile's formula: 100 x SUM(gross_profit) / SUM(revenue) over every visit with a revenue figure,
      // the $0 free return included: (60 + 100 - 20) / 300.
      expect(await svc.jobRevenueForWindow(trx, '2026-10-01', '2026-10-31')).toEqual({ revenue: 300, grossMarginPct: 46.67 });
    });

    it('free work without the callback flag is not a paid stop: a $0 included follow-up, one flagged on its visit, one marked free', async () => {
      await visit('2026-10-02', { revenue: '100.00', gross_profit: '60.00' });
      await visit('2026-10-03', { revenue: '0.00', gross_profit: '-15.00' }, { followup_included: true }); // is_callback false, $0
      await visit('2026-10-04', { revenue: '80.00', gross_profit: '10.00' }, { followup_included: true }); // included follow-up that carries a price
      await visit('2026-10-05', { revenue: '90.00', gross_profit: '20.00' }, { is_callback: true }); // the visit is the callback, the record flag unset
      await visit('2026-10-06', { revenue: '0.00', gross_profit: '-10.00' }, { is_callback: false }); // job-costing booked $0 (stamped zero or intentionally free)
      await visit('2026-10-07', { revenue: null }); // never costed
      expect(await svc.paidStopsForWindow(trx, '2026-10-01', '2026-10-31')).toBe(1);
    });

    it('a paid annual-prepay visit keeps its prepay share as revenue and stays in', async () => {
      await visit('2026-10-02', { revenue: '55.00', gross_profit: '30.00' }, { prepaid_amount: '55.00' });
      await visit('2026-10-09', { revenue: '55.00', gross_profit: '30.00' }, { is_callback: false });
      expect(await svc.paidStopsForWindow(trx, '2026-10-01', '2026-10-31')).toBe(2);
    });

    it('a grouped visit counts once per physical stop; standalone records and other groups count on their own', async () => {
      const stopA = await group('2026-10-02');
      const stopB = await group('2026-10-09');
      await visit('2026-10-02', { revenue: '100.00', gross_profit: '50.00' }, { visit_id: stopA }); // three services, one stop
      await visit('2026-10-02', { revenue: '60.00', gross_profit: '30.00' }, { visit_id: stopA });
      await visit('2026-10-02', { revenue: '40.00', gross_profit: '20.00' }, { visit_id: stopA });
      await visit('2026-10-09', { revenue: '70.00', gross_profit: '35.00' }, { visit_id: stopB });
      await visit('2026-10-09', { revenue: '0.00', gross_profit: '-5.00' }, { visit_id: stopB }); // free part of that stop: still one stop
      await visit('2026-10-12', { revenue: '80.00', gross_profit: '40.00' }); // no scheduled row
      await visit('2026-10-13', { revenue: '80.00', gross_profit: '40.00' }, {}); // scheduled row, no group
      await visit('2026-10-14', { revenue: '80.00', gross_profit: '40.00' }, {}); // a second standalone one
      expect(await svc.paidStopsForWindow(trx, '2026-10-01', '2026-10-31')).toBe(5);
    });

    it('a group whose only work is free is not a paid stop', async () => {
      const stop = await group('2026-10-02');
      await visit('2026-10-02', { revenue: '0.00' }, { visit_id: stop, followup_included: true });
      expect(await svc.paidStopsForWindow(trx, '2026-10-01', '2026-10-31')).toBe(0);
    });

    it('a month with no visits has 0 stops and no margin', async () => {
      expect(await svc.paidStopsForWindow(trx, '2026-10-01', '2026-10-31')).toBe(0);
      expect(await svc.jobRevenueForWindow(trx, '2026-10-01', '2026-10-31')).toEqual({ revenue: 0, grossMarginPct: null });
    });
  });

  describe('computeMonthSnapshot and upsertMonthSnapshot', () => {
    const seedMonth = async () => {
      await expense('Office Expenses', '300.00', '2026-10-10');
      await expense('Insurance', '400.00', '2026-10-10');
      await visit('2026-10-02', { revenue: '100.00', gross_profit: '60.00' });
      await visit('2026-10-09', { revenue: '200.00', gross_profit: '100.00' });
      await visit('2026-10-12', { revenue: '0.00', gross_profit: '-20.00', is_callback: true });
    };

    it('owner time not set: office cost is the ledger, cost per stop over two paid stops', async () => {
      await seedMonth();
      const row = await svc.computeMonthSnapshot('2026-10', trx);
      expect(row).toMatchObject({
        month: '2026-10-01',
        completed_job_revenue: 300,
        gross_margin_pct: 46.67,
        office_cost: 300,
        owner_allowance: 0,
        paid_stops: 2,
        office_cost_per_stop: 150,
        cash_revenue: 0,
        net_margin_pct: null, // no cash revenue that month
      });
      // The stored net income is the P&L's own (the migrated database also seeds equipment that depreciates),
      // and with no revenue it can only be at or below the two expenses.
      const pnl = await require('../services/pnl-report').buildPnlReport(trx, '2026-10-01', '2026-10-31');
      expect(row.net_income).toBe(pnl.netIncome);
      expect(row.net_income).toBeLessThanOrEqual(-700);
    });

    it('owner time set: the allowance is hours x rate and joins the office cost', async () => {
      await seedMonth();
      await settings({ owner_office_hours_per_month: '10', owner_office_hourly_rate: '30.00' });
      const row = await svc.computeMonthSnapshot('2026-10', trx);
      expect(row).toMatchObject({ owner_allowance: 300, office_cost: 600, office_cost_per_stop: 300 });
    });

    it('owner hours set but no rate: not counted', async () => {
      await seedMonth();
      await settings({ owner_office_hours_per_month: '10', owner_office_hourly_rate: null });
      expect((await svc.computeMonthSnapshot('2026-10', trx)).owner_allowance).toBe(0);
    });

    it('the allowance is the settings row in effect on the month\'s last day: later rows never change an earlier month', async () => {
      await seedMonth();
      await settings({ owner_office_hours_per_month: '10', owner_office_hourly_rate: '30.00' }, '2026-10-15'); // in effect at October's end
      await settings({ owner_office_hours_per_month: '20', owner_office_hourly_rate: '30.00' }, '2026-11-05'); // after it
      expect((await svc.computeMonthSnapshot('2026-10', trx)).owner_allowance).toBe(300);
      expect((await svc.computeMonthSnapshot('2026-11', trx)).owner_allowance).toBe(600);
      // September ended before either row started: the seeded row has no owner time.
      expect((await svc.computeMonthSnapshot('2026-09', trx)).owner_allowance).toBe(0);
    });

    it('zero paid stops: the ratio is null and the office cost is still stored', async () => {
      await expense('Utilities', '60.00', '2026-10-10');
      await visit('2026-10-12', { revenue: '0.00', is_callback: true });
      const row = await svc.computeMonthSnapshot('2026-10', trx);
      expect(row).toMatchObject({ paid_stops: 0, office_cost: 60, office_cost_per_stop: null });
    });

    it('a second write for the same month replaces the row (one row per month) and moves computed_at', async () => {
      await seedMonth();
      await svc.upsertMonthSnapshot('2026-10', trx);
      const first = await trx('monthly_financial_snapshots').where({ month: '2026-10-01' }).first();
      await expense('Utilities', '100.00', '2026-10-20'); // a late ledger entry
      await svc.upsertMonthSnapshot('2026-10', trx);
      const rows = await trx('monthly_financial_snapshots').where({ month: '2026-10-01' });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].office_cost)).toBe(400);
      expect(rows[0].id).toBe(first.id);
      expect(rows[0].computed_at.getTime()).toBeGreaterThanOrEqual(first.computed_at.getTime());
    });

    it('the dashboard reader returns stored months oldest first with the three-month headline', async () => {
      for (const [month, office, stops] of [['2026-07-01', 100, 10], ['2026-08-01', 200, 10], ['2026-09-01', 300, 10], ['2026-10-01', 400, 10]]) {
        await trx('monthly_financial_snapshots').insert({
          month, office_cost: office, paid_stops: stops, office_cost_per_stop: office / stops,
        });
      }
      const out = await svc.getOfficeCostPerStopSeries({ months: 12, db: trx });
      expect(out.months.map((m) => m.month)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']);
      expect(out.trailing).toEqual({ months: ['2026-08-01', '2026-09-01', '2026-10-01'], officeCost: 900, paidStops: 30, officeCostPerStop: 30 });
      expect(out.ownerOfficeTime).toEqual({ status: 'none', monthsWithAllowance: 0, months: 3 });
    });

    it('the owner-time note comes from the stored allowances, whatever the settings say today', async () => {
      await settings({ owner_office_hours_per_month: '10', owner_office_hourly_rate: '30.00' }, '2026-11-20'); // today's settings: counted
      for (const [month, allowance] of [['2026-08-01', 0], ['2026-09-01', 0], ['2026-10-01', 300]]) {
        await trx('monthly_financial_snapshots').insert({ month, office_cost: 100, owner_allowance: allowance, paid_stops: 10 });
      }
      const out = await svc.getOfficeCostPerStopSeries({ db: trx });
      expect(out.ownerOfficeTime).toEqual({ status: 'some', monthsWithAllowance: 1, months: 3 });
    });

    it('P&L completeness: stored false while the balance ledger has not synced past month end, true after', async () => {
      await seedMonth();
      expect((await svc.upsertMonthSnapshot('2026-10', trx)).pnl_complete).toBe(false); // never synced
      expect((await trx('monthly_financial_snapshots').where({ month: '2026-10-01' }).first()).pnl_complete).toBe(false);
      await trx('stripe_sync_state').insert({ sync_type: 'balance_transactions', last_sync_at: '2026-11-01T12:00:00Z' });
      expect((await svc.upsertMonthSnapshot('2026-10', trx)).pnl_complete).toBe(true);
      expect((await trx('monthly_financial_snapshots').where({ month: '2026-10-01' }).first()).pnl_complete).toBe(true);
      // A sync that ran inside the month is not past its end.
      await trx('stripe_sync_state').update({ last_sync_at: '2026-10-31T12:00:00Z' });
      expect((await svc.upsertMonthSnapshot('2026-10', trx)).pnl_complete).toBe(false);
      const out = await svc.getOfficeCostPerStopSeries({ db: trx });
      expect(out.pnlIncompleteMonths).toEqual(['2026-10-01']);
    });

    describe('the monthly pair', () => {
      const NOW = new Date('2026-12-02T10:35:00Z'); // 05:35 ET on the 2nd: last month is November
      const CATCH_UP = new Date('2026-12-04T10:35:00Z');
      const failOctober = async () => {
        await trx.raw(`CREATE FUNCTION snapshot_pair_fail() RETURNS trigger AS $$
          BEGIN IF NEW.month = DATE '2026-10-01' THEN RAISE EXCEPTION 'sample failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
        await trx.raw('CREATE TRIGGER snapshot_pair_fail BEFORE INSERT OR UPDATE ON monthly_financial_snapshots FOR EACH ROW EXECUTE FUNCTION snapshot_pair_fail()');
      };

      it('writes last month and the month before, both rows in one run', async () => {
        await expense('Office Expenses', '50.00', '2026-11-10');
        await expense('Office Expenses', '70.00', '2026-10-10');
        const res = await svc.runMonthlyFinancialSnapshots({ now: NOW, db: trx });
        expect(res.months).toEqual(['2026-11-01', '2026-10-01']);
        const rows = await trx('monthly_financial_snapshots').orderBy('month');
        expect(rows.map((r) => Number(r.office_cost))).toEqual([70, 50]);
      });

      it('a failure on the month-before refresh keeps neither row, and the catch-up then does the pair', async () => {
        await failOctober();
        await expect(svc.runMonthlyFinancialSnapshots({ now: NOW, db: trx })).rejects.toThrow(/sample failure/);
        expect(await trx('monthly_financial_snapshots').count({ n: '*' }).first()).toMatchObject({ n: '0' }); // November rolled back too
        await trx.raw('DROP TRIGGER snapshot_pair_fail ON monthly_financial_snapshots');
        const res = await svc.runMonthlyFinancialSnapshots({ now: CATCH_UP, catchUp: true, db: trx });
        expect(res.months).toEqual(['2026-11-01', '2026-10-01']);
        expect(await trx('monthly_financial_snapshots').count({ n: '*' }).first()).toMatchObject({ n: '2' });
      });

      it('the catch-up skips a pair this month\'s run finished with the ledger synced, and redoes one that is stale in EITHER month', async () => {
        await trx('stripe_sync_state').insert({ sync_type: 'balance_transactions', last_sync_at: '2026-12-02T09:00:00Z' });
        await svc.runMonthlyFinancialSnapshots({ now: NOW, db: trx }); // both rows complete
        const catchUp = () => svc.runMonthlyFinancialSnapshots({ now: CATCH_UP, catchUp: true, db: trx });
        expect((await catchUp()).skipped).toBe('already_written');
        const row = (month) => trx('monthly_financial_snapshots').where({ month });
        await row('2026-11-01').update({ pnl_complete: false });
        expect((await catchUp()).months).toEqual(['2026-11-01', '2026-10-01']);
        // A one-month backfill on the 1st: last month's row predates the run window.
        await row('2026-11-01').update({ computed_at: '2026-12-01T20:00:00Z' });
        expect((await catchUp()).skipped).toBeNull();
        // The month before is stale while last month looks fresh.
        await row('2026-10-01').update({ computed_at: '2026-11-02T10:36:00Z' });
        expect((await catchUp()).skipped).toBeNull();
        expect((await catchUp()).skipped).toBe('already_written'); // the run just made both fresh
        // The month before is missing while last month looks fresh.
        await row('2026-10-01').del();
        expect((await catchUp()).months).toEqual(['2026-11-01', '2026-10-01']);
        expect((await row('2026-10-01').first()).computed_at.toISOString()).toBe(CATCH_UP.toISOString());
      });
    });

    describe('isolation', () => {
      // A wrapper that hands the service the real pool and records, from inside each transaction it opens, the
      // isolation level Postgres is actually running it at. These writes commit, so they use a month far from real
      // data and are deleted afterwards.
      const spied = () => {
        const seen = [];
        const db = (...args) => database(...args);
        db.raw = (...args) => database.raw(...args);
        db.transaction = (cb, options) => database.transaction(async (inner) => {
          seen.push((await inner.raw('SHOW transaction_isolation')).rows[0].transaction_isolation);
          return cb(inner);
        }, options);
        return { db, seen };
      };
      const cleanup = () => database('monthly_financial_snapshots').whereIn('month', ['2001-01-01', '2001-02-01']).del();
      afterEach(cleanup);

      it('upsertMonthSnapshot and the monthly pair both run REPEATABLE READ', async () => {
        await cleanup();
        const one = spied();
        await svc.upsertMonthSnapshot('2001-01', one.db);
        expect(one.seen).toEqual(['repeatable read']);
        expect(await database('monthly_financial_snapshots').where({ month: '2001-01-01' }).first('id')).toBeTruthy();
        const pair = spied();
        // now = 2001-03-02 05:35 ET: the pair is February and January 2001.
        const res = await svc.runMonthlyFinancialSnapshots({ now: new Date('2001-03-02T10:35:00Z'), db: pair.db });
        expect(res.months).toEqual(['2001-02-01', '2001-01-01']);
        expect(pair.seen).toEqual(['repeatable read']); // one transaction for both months
      });
    });
  });
});
