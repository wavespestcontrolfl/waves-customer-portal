/**
 * Office cost per stop and the monthly snapshot (services/monthly-financial-snapshot.js), no database:
 * the pure math (zero stops, owner allowance null vs set, trailing three months), the shape of the queries
 * (office category filter, callbacks left out, pay-run exclusion only with its gate) on a recording fake,
 * the cron body (writes last month and the month before; the catch-up writes nothing once last month exists)
 * and the migration. The real SQL runs in monthly-financial-snapshot-postgres.test.js. Synthetic numbers only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockGate = { payRunWages: false };
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  pnlPayRunWagesLive: () => mockGate.payRunWages,
}));
const mockBuildPnl = jest.fn();
jest.mock('../services/pnl-report', () => ({ buildPnlReport: (...a) => mockBuildPnl(...a) }));

// The buyer columns have their own suites (monthly-snapshot-buyer-columns.test.js and the Postgres one); here only their
// hand-off is checked: the arguments computeMonthSnapshot gives them and that their columns land on the stored row.
const mockBuyerColumns = jest.fn();
jest.mock('../services/monthly-snapshot-buyer-columns', () => ({
  ...jest.requireActual('../services/monthly-snapshot-buyer-columns'),
  buyerColumns: (...a) => mockBuyerColumns(...a),
}));

const svc = require('../services/monthly-financial-snapshot');
const migration = require('../models/migrations/20261126100000_monthly_financial_snapshots');

// A knex fake that records every call per table and answers from `results[table]`.
function makeDb(results = {}) {
  const log = [];
  const db = (table) => {
    const name = String(table).split(' as ')[0];
    const entry = { table: name, calls: [] };
    log.push(entry);
    table = name;
    const q = new Proxy({}, {
      get(_t, method) {
        if (method === 'then') {
          return (resolve, reject) => Promise.resolve(results[table] ?? []).then(resolve, reject);
        }
        return (...args) => {
          entry.calls.push([method, ...args]);
          // Callback predicates run against the same recorder so their clauses are visible.
          if (method === 'where' && typeof args[0] === 'function') args[0].call(q);
          if (method === 'first') return Promise.resolve(results[table]?.first ?? results[table] ?? null);
          return q;
        };
      },
    });
    return q;
  };
  db.raw = (sql) => sql;
  db.log = log;
  db.callsFor = (table) => log.filter((e) => e.table === table).flatMap((e) => e.calls);
  return db;
}

beforeEach(() => {
  mockGate.payRunWages = false;
  mockBuildPnl.mockReset();
  mockBuyerColumns.mockReset();
  mockBuyerColumns.mockResolvedValue({ sde: 1800, prepaid_owed: 0 });
});

describe('monthWindow and monthOffset', () => {
  test('a month becomes its first and last calendar day, leap February included', () => {
    expect(svc.monthWindow('2026-10')).toEqual({ month: '2026-10-01', startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(svc.monthWindow('2028-02-15')).toEqual({ month: '2028-02-01', startDate: '2028-02-01', endDate: '2028-02-29' });
    expect(svc.monthWindow('2026-02').endDate).toBe('2026-02-28');
  });

  test('a bad month throws instead of reading a wrong window', () => {
    expect(() => svc.monthWindow('2026-13')).toThrow(/YYYY-MM/);
    expect(() => svc.monthWindow('')).toThrow(/YYYY-MM/);
  });

  test('last month and the one before are taken in Eastern time across a year end', () => {
    // 2026-01-02 05:35 ET is 10:35Z.
    const now = new Date('2026-01-02T10:35:00Z');
    expect(svc.monthOffset(now, -1)).toBe('2025-12-01');
    expect(svc.monthOffset(now, -2)).toBe('2025-11-01');
  });
});

describe('office cost math', () => {
  test('zero stops gives no cost per stop, never a zero or a divide by zero', () => {
    expect(svc.officeCostPerStop(1500, 0)).toBeNull();
    expect(svc.officeCostPerStop(0, 0)).toBeNull();
    expect(svc.officeCostPerStop(1500, null)).toBeNull();
  });

  test('cost per stop is office cost over paid stops, to the cent', () => {
    expect(svc.officeCostPerStop(1000, 80)).toBe(12.5);
    expect(svc.officeCostPerStop(1000, 3)).toBe(333.33);
    expect(svc.officeCostPerStop(0, 40)).toBe(0);
  });

  test.each([
    ['both unset', {}, 0],
    ['null settings row', null, 0],
    ['hours unset', { owner_office_hourly_rate: '50.00' }, 0],
    ['rate unset', { owner_office_hours_per_month: '10.00' }, 0],
    ['hours zero', { owner_office_hours_per_month: '0', owner_office_hourly_rate: '50' }, 0],
    ['rate zero', { owner_office_hours_per_month: '12', owner_office_hourly_rate: '0.00' }, 0],
    ['both set', { owner_office_hours_per_month: '12.50', owner_office_hourly_rate: '40.00' }, 500],
    ['a half cent rounds up once, on integers (2.50 h x $21.29 = 53.225)', { owner_office_hours_per_month: '2.50', owner_office_hourly_rate: '21.29' }, 53.23],
    ['numbers as well as strings', { owner_office_hours_per_month: 2.5, owner_office_hourly_rate: 21.29 }, 53.23],
    ['under a half cent rounds down (1.15 h x $1.15 = 1.3225)', { owner_office_hours_per_month: '1.15', owner_office_hourly_rate: '1.15' }, 1.32],
    ['a hundredth of an hour at a nickel an hour is a cent (0.005 rounds up)', { owner_office_hours_per_month: '0.10', owner_office_hourly_rate: '0.05' }, 0.01],
    ['the largest values the columns hold', { owner_office_hours_per_month: '9999.99', owner_office_hourly_rate: '999999.99' }, 9999989900],
  ])('owner allowance, %s', (_name, row, expected) => {
    expect(svc.ownerAllowance(row)).toBe(expected);
  });

  test('trailing three months sums cost and stops, it does not average the monthly ratios', () => {
    const rows = [
      { month: '2026-06-01', officeCost: 9999, paidStops: 1 }, // older than three months: left out
      { month: '2026-07-01', officeCost: 1000, paidStops: 100 },
      { month: '2026-08-01', officeCost: 500, paidStops: 20 },
      { month: '2026-09-01', officeCost: 500, paidStops: 80 },
    ];
    expect(svc.trailingThreeMonths(rows)).toEqual({
      months: ['2026-07-01', '2026-08-01', '2026-09-01'],
      officeCost: 2000,
      paidStops: 200,
      officeCostPerStop: 10, // not the 11.9 an average of 10, 25 and 6.25 gives
    });
  });

  test('trailing three months with fewer rows, or no stops, stays honest', () => {
    expect(svc.trailingThreeMonths([{ month: '2026-09-01', officeCost: 40, paidStops: 0 }]).officeCostPerStop).toBeNull();
    expect(svc.trailingThreeMonths([]).officeCostPerStop).toBeNull();
  });
});

describe('office categories', () => {
  test('the list is exactly the five office categories; field and non-office costs are not in it', () => {
    expect(svc.OFFICE_CATEGORIES).toEqual(['Legal & Professional', 'Office Expenses', 'Utilities', 'Software & Technology', 'Home Office']);
    for (const out of ['Insurance', 'Vehicle', 'Advertising', 'Interest', 'Taxes & Licenses', 'Supplies', 'Depreciation']) {
      expect(svc.OFFICE_CATEGORIES).not.toContain(out);
    }
  });
});

describe('query shapes', () => {
  test('the office ledger read filters by the office category names over the month, gate off: no pay-run exclusion', async () => {
    const db = makeDb({ expenses: { first: { total: '1234.5' } } });
    expect(await svc.officeLedgerCost(db, '2026-10-01', '2026-10-31')).toBe(1234.5);
    const calls = db.callsFor('expenses');
    expect(calls).toContainEqual(['whereBetween', 'expenses.expense_date', ['2026-10-01', '2026-10-31']]);
    expect(calls).toContainEqual(['whereIn', 'expense_categories.name', svc.OFFICE_CATEGORIES]);
    expect(calls.some(([m]) => m === 'whereRaw')).toBe(false);
  });

  test('gate on: the pay-run category is left out of the office ledger read', async () => {
    mockGate.payRunWages = true;
    const db = makeDb({ expenses: { first: { total: '10' } } });
    await svc.officeLedgerCost(db, '2026-10-01', '2026-10-31');
    const raw = db.callsFor('expenses').filter(([m]) => m === 'whereRaw');
    expect(raw).toHaveLength(1);
    expect(raw[0][1]).toMatch(/^NOT .*counted_from_pay_runs/s);
  });

  test('an empty ledger month reads as 0', async () => {
    const db = makeDb({ expenses: { first: { total: '0' } } });
    expect(await svc.officeLedgerCost(db, '2026-10-01', '2026-10-31')).toBe(0);
  });

  test('paid stops: completed, revenue above $0, no callback flag on the record or its visit, no included follow-up, one per physical stop', async () => {
    const db = makeDb({ service_records: { first: { n: '42' } } });
    expect(await svc.paidStopsForWindow(db, '2026-10-01', '2026-10-31')).toBe(42);
    const calls = db.callsFor('service_records');
    expect(calls).toContainEqual(['leftJoin', 'scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id']);
    expect(calls).toContainEqual(['whereBetween', 'sr.service_date', ['2026-10-01', '2026-10-31']]);
    expect(calls).toContainEqual(['where', 'sr.status', 'completed']);
    expect(calls).toContainEqual(['where', 'sr.revenue', '>', 0]); // job-costing's own verdict: free work books $0
    for (const col of ['sr.is_callback', 'ss.is_callback', 'ss.followup_included']) {
      expect(calls).toContainEqual(['whereNull', col]);
      expect(calls).toContainEqual(['orWhere', col, false]);
    }
    // A grouped visit (scheduled_services.visit_id) is one stop; an ungrouped record is its own.
    const select = calls.find(([m]) => m === 'select');
    expect(select[1]).toMatch(/COUNT\(DISTINCT COALESCE\(ss\.visit_id::text, sr\.id::text\)\)/);
  });
});

describe('computeMonthSnapshot', () => {
  const pnl = (cash, net, margin, complete = true) => ({
    revenue: { total: cash }, netIncome: net, netMargin: margin, coverage: { complete },
  });

  // Four reads hit different tables here, so one fake serves all of them.
  const dbFor = ({ ledger, stops, rev, margin, fin }) => makeDb({
    expenses: { first: { total: String(ledger) } },
    service_records: { first: { n: String(stops), revenue: String(rev), weighted_margin: margin } },
    company_financials: { first: fin },
  });

  test('office cost is the ledger plus the owner allowance, and cost per stop divides by paid stops', async () => {
    mockBuildPnl.mockResolvedValue(pnl(9000, 1800, 0.2));
    const db = dbFor({ ledger: 1000, stops: 100, rev: 10000, margin: '52.456', fin: { owner_office_hours_per_month: '10', owner_office_hourly_rate: '50' } });
    expect(await svc.computeMonthSnapshot('2026-10', db)).toEqual({
      month: '2026-10-01',
      completed_job_revenue: 10000,
      cash_revenue: 9000,
      gross_margin_pct: 52.46,
      office_cost: 1500,
      owner_allowance: 500,
      paid_stops: 100,
      office_cost_per_stop: 15,
      net_income: 1800,
      net_margin_pct: 20,
      pnl_complete: true,
      sde: 1800,
      prepaid_owed: 0,
    });
    expect(mockBuildPnl).toHaveBeenCalledWith(db, '2026-10-01', '2026-10-31');
    // The buyer columns get the month's window, the settings row in effect, the P&L, the office allowance and cash revenue.
    expect(mockBuyerColumns).toHaveBeenCalledWith(db, expect.objectContaining({
      startDate: '2026-10-01', endDate: '2026-10-31', officeAllowance: 500, cashRevenue: 9000,
      financials: { owner_office_hours_per_month: '10', owner_office_hourly_rate: '50' },
    }));
  });

  test('the settings row is the one in effect on the month\'s last day, not the newest', async () => {
    mockBuildPnl.mockResolvedValue(pnl(9000, 1800, 0.2));
    const db = dbFor({ ledger: 1000, stops: 100, rev: 10000, margin: '50', fin: { owner_office_hours_per_month: '10', owner_office_hourly_rate: '50' } });
    await svc.computeMonthSnapshot('2026-10', db);
    const calls = db.callsFor('company_financials');
    expect(calls).toContainEqual(['where', 'effective_date', '<=', '2026-10-31']);
    expect(calls).toContainEqual(['orderBy', 'effective_date', 'desc']);
  });

  test('owner time unset: the allowance is 0 and the office cost is the ledger alone', async () => {
    mockBuildPnl.mockResolvedValue(pnl(9000, 1800, 0.2));
    const db = dbFor({ ledger: 1000, stops: 100, rev: 10000, margin: '50', fin: { owner_office_hours_per_month: null, owner_office_hourly_rate: null } });
    const row = await svc.computeMonthSnapshot('2026-10', db);
    expect(row.owner_allowance).toBe(0);
    expect(row.office_cost).toBe(1000);
    expect(row.office_cost_per_stop).toBe(10);
  });

  test('a month with no stops and no revenue stores nulls for the ratios, not zeros', async () => {
    mockBuildPnl.mockResolvedValue(pnl(0, -300, 0));
    const db = dbFor({ ledger: 300, stops: 0, rev: 0, margin: null, fin: null });
    const row = await svc.computeMonthSnapshot('2026-10', db);
    expect(row).toMatchObject({
      paid_stops: 0, office_cost: 300, office_cost_per_stop: null, gross_margin_pct: null, net_margin_pct: null, net_income: -300,
    });
  });

  test('P&L completeness is stored: incomplete coverage (ledger not synced past month end) reads false', async () => {
    const db = dbFor({ ledger: 100, stops: 10, rev: 1000, margin: '50', fin: null });
    mockBuildPnl.mockResolvedValue(pnl(900, 100, 0.11, false));
    expect((await svc.computeMonthSnapshot('2026-10', db)).pnl_complete).toBe(false);
    mockBuildPnl.mockResolvedValue({ revenue: { total: 900 }, netIncome: 100, netMargin: 0.11 }); // no verdict at all: not proven
    expect((await svc.computeMonthSnapshot('2026-10', db)).pnl_complete).toBe(false);
  });
});

describe('runMonthlyFinancialSnapshots', () => {
  const NOW = new Date('2026-12-02T10:35:00Z'); // 05:35 ET on the 2nd
  const CATCH_UP_NOW = new Date('2026-12-04T10:35:00Z');
  const PNL = { revenue: { total: 900 }, netIncome: 100, netMargin: 0.11, coverage: { complete: true } };
  const fresh = (month, over = {}) => ({ month, computed_at: new Date('2026-12-02T10:36:00Z'), pnl_complete: true, ...over });
  const FRESH_PAIR = [fresh('2026-11-01'), fresh('2026-10-01')];

  // `rows` are the stored rows the catch-up looks at, a recording insert, and a transaction that keeps its writes
  // only when the callback resolves (like Postgres), so a failure in the second write drops the first. Each
  // transaction's options are recorded.
  function runDb({ rows = [], failOn = null } = {}) {
    const committed = [];
    const options = [];
    const build = (writes) => {
      const db = (table) => {
        if (table === 'monthly_financial_snapshots') {
          let pending = null;
          const q = {
            whereIn: () => q,
            select: () => Promise.resolve(rows),
            insert: (row) => { pending = row; return q; },
            onConflict: () => q,
            merge: async () => {
              if (failOn && pending.month === failOn) throw new Error(`write of ${failOn} failed`);
              writes.push(pending);
            },
          };
          return q;
        }
        return makeDb({ expenses: { first: { total: '100' } }, service_records: { first: { n: '10', revenue: '1000', weighted_margin: '50' } }, company_financials: { first: null } })(table);
      };
      db.raw = (s) => s;
      return db;
    };
    const db = build(committed);
    db.transaction = async (cb, opts) => {
      options.push(opts);
      const writes = [];
      const result = await cb(build(writes));
      committed.push(...writes);
      return result;
    };
    return { db, committed, options };
  }

  test('writes last month and re-writes the month before it, in one REPEATABLE READ transaction', async () => {
    mockBuildPnl.mockResolvedValue(PNL);
    const { db, committed, options } = runDb();
    const res = await svc.runMonthlyFinancialSnapshots({ now: NOW, db });
    expect(res).toEqual({ skipped: null, months: ['2026-11-01', '2026-10-01'] });
    expect(options).toEqual([{ isolationLevel: 'repeatable read' }]); // one transaction, for both months and every read in them
    expect(committed.map((r) => r.month)).toEqual(['2026-11-01', '2026-10-01']);
    expect(committed[0]).toMatchObject({ paid_stops: 10, office_cost: 100, office_cost_per_stop: 10, pnl_complete: true });
    expect(committed[0].computed_at).toEqual(NOW);
  });

  test('a single upsert (the backfill path) is its own REPEATABLE READ transaction', async () => {
    mockBuildPnl.mockResolvedValue(PNL);
    const { db, committed, options } = runDb();
    const row = await svc.upsertMonthSnapshot('2026-10', db);
    expect(options).toEqual([{ isolationLevel: 'repeatable read' }]);
    expect(row.month).toBe('2026-10-01');
    expect(committed).toHaveLength(1);
    // The reads of the snapshot ran on the transaction's connection, so mockBuildPnl got the transaction's db, not the pool.
    expect(mockBuildPnl.mock.calls[0][0]).not.toBe(db);
  });

  // A transaction that fails with `failures` serialization errors (SQLSTATE 40001) before it lets one through.
  const serializationFailures = (db, failures, code = '40001') => {
    const real = db.transaction;
    const state = { attempts: 0 };
    db.transaction = async (cb, opts) => {
      state.attempts += 1;
      if (state.attempts <= failures) throw Object.assign(new Error('could not serialize access due to concurrent update'), { code });
      return real(cb, opts);
    };
    return state;
  };

  test('a serialization failure repeats the whole pair on a fresh snapshot, then succeeds', async () => {
    mockBuildPnl.mockResolvedValue(PNL);
    const { db, committed } = runDb();
    const state = serializationFailures(db, 2);
    const res = await svc.runMonthlyFinancialSnapshots({ now: NOW, db });
    expect(state.attempts).toBe(3);
    expect(res.months).toEqual(['2026-11-01', '2026-10-01']);
    expect(committed).toHaveLength(2); // the two failed attempts kept nothing
  });

  test('a single upsert (the backfill) retries a serialization failure the same way', async () => {
    mockBuildPnl.mockResolvedValue(PNL);
    const { db, committed } = runDb();
    const state = serializationFailures(db, 1);
    expect((await svc.upsertMonthSnapshot('2026-10', db)).month).toBe('2026-10-01');
    expect(state.attempts).toBe(2);
    expect(committed).toHaveLength(1);
    expect(mockBuildPnl).toHaveBeenCalledTimes(1); // compute ran on the attempt that got a transaction
  });

  test('the retry is bounded: three attempts, then the serialization error reaches the caller', async () => {
    mockBuildPnl.mockResolvedValue(PNL);
    const { db, committed } = runDb();
    const state = serializationFailures(db, 99);
    await expect(svc.runMonthlyFinancialSnapshots({ now: NOW, db })).rejects.toMatchObject({ code: '40001' });
    expect(state.attempts).toBe(3);
    expect(committed).toEqual([]);
    // The same bound on the single upsert (the backfill path).
    const alwaysFails = { attempts: 0, transaction: async () => { alwaysFails.attempts += 1; throw Object.assign(new Error('x'), { code: '40001' }); } };
    await expect(svc.upsertMonthSnapshot('2026-10', alwaysFails)).rejects.toMatchObject({ code: '40001' });
    expect(alwaysFails.attempts).toBe(3);
  });

  test.each([['a deadlock (40P01)', '40P01'], ['no code', null], ['a unique violation (23505)', '23505']])('%s is not retried', async (_n, code) => {
    const { db } = runDb();
    const state = serializationFailures(db, 99, code);
    await expect(svc.runMonthlyFinancialSnapshots({ now: NOW, db })).rejects.toThrow(/could not serialize/);
    expect(state.attempts).toBe(1);
  });

  test('if the month-before refresh fails, nothing is kept, so the pair stays missing and the catch-up retries it', async () => {
    mockBuildPnl.mockResolvedValue(PNL);
    const first = runDb({ failOn: '2026-10-01' });
    await expect(svc.runMonthlyFinancialSnapshots({ now: NOW, db: first.db })).rejects.toThrow(/2026-10-01 failed/);
    expect(first.committed).toEqual([]); // the 11-01 write was rolled back with it
    const retry = runDb({ rows: [] });
    const res = await svc.runMonthlyFinancialSnapshots({ now: CATCH_UP_NOW, catchUp: true, db: retry.db });
    expect(res.months).toEqual(['2026-11-01', '2026-10-01']);
    expect(retry.committed).toHaveLength(2);
  });

  test('the catch-up run writes nothing when BOTH months were written by this month\'s run with the ledger complete', async () => {
    const { db, committed, options } = runDb({ rows: FRESH_PAIR });
    const res = await svc.runMonthlyFinancialSnapshots({ now: CATCH_UP_NOW, catchUp: true, db });
    expect(res).toEqual({ skipped: 'already_written', months: [] });
    expect(committed).toEqual([]);
    expect(options).toEqual([]);
    expect(mockBuildPnl).not.toHaveBeenCalled();
  });

  test('a row with no pnl_complete verdict (NULL, an older row) is not by itself a reason to rerun', async () => {
    const { db } = runDb({ rows: [fresh('2026-11-01', { pnl_complete: null }), fresh('2026-10-01', { pnl_complete: null })] });
    expect((await svc.runMonthlyFinancialSnapshots({ now: CATCH_UP_NOW, catchUp: true, db })).skipped).toBe('already_written');
  });

  test.each([
    ['both rows are missing', []],
    ['last month is missing', [fresh('2026-10-01')]],
    ['the month before is missing (a one-month backfill made last month look fresh)', [fresh('2026-11-01')]],
    ['last month was written before this month\'s run window opened', [fresh('2026-11-01', { computed_at: new Date('2026-12-01T20:00:00Z') }), fresh('2026-10-01')]],
    ['the month before was written before this month\'s run window opened', [fresh('2026-11-01'), fresh('2026-10-01', { computed_at: new Date('2026-11-02T10:36:00Z') })]],
    ['last month was stored while the balance ledger had not synced past month end', [fresh('2026-11-01', { pnl_complete: false }), fresh('2026-10-01')]],
    ['the month before was stored incomplete', [fresh('2026-11-01'), fresh('2026-10-01', { pnl_complete: false })]],
    ['a row has no computed_at', [fresh('2026-11-01', { computed_at: null }), fresh('2026-10-01')]],
  ])('the catch-up run does the whole pair again when %s', async (_n, rows) => {
    mockBuildPnl.mockResolvedValue(PNL);
    const { db, committed } = runDb({ rows });
    const res = await svc.runMonthlyFinancialSnapshots({ now: CATCH_UP_NOW, catchUp: true, db });
    expect(res.months).toEqual(['2026-11-01', '2026-10-01']);
    expect(committed).toHaveLength(2);
  });

  test('the run window opens at 00:00 ET on the 2nd, across the standard-time change', async () => {
    mockBuildPnl.mockResolvedValue(PNL);
    // 2027-02-02 00:00 EST is 05:00Z. A row computed 04:59Z is before it, 05:01Z is after.
    const now = new Date('2027-02-04T15:00:00Z');
    const pair = (at) => [fresh('2027-01-01', { computed_at: new Date(at) }), fresh('2026-12-01', { computed_at: new Date(at) })];
    expect((await svc.runMonthlyFinancialSnapshots({ now, catchUp: true, db: runDb({ rows: pair('2027-02-02T04:59:00Z') }).db })).skipped).toBeNull();
    expect((await svc.runMonthlyFinancialSnapshots({ now, catchUp: true, db: runDb({ rows: pair('2027-02-02T05:01:00Z') }).db })).skipped).toBe('already_written');
  });
});

describe('getOfficeCostPerStopSeries', () => {
  const row = (month, over = {}) => ({
    month, completed_job_revenue: '5000.00', cash_revenue: '4800.00', gross_margin_pct: '51.20', office_cost: '600.00', owner_allowance: '0.00',
    paid_stops: 60, office_cost_per_stop: '10.00', net_income: '700.00', net_margin_pct: '14.58', pnl_complete: true, ...over,
  });

  test('returns the stored rows oldest first with the headline', async () => {
    const stored = [ // newest first, as the query returns them
      row('2026-10-01'),
      row(new Date(Date.UTC(2026, 8, 1)), { office_cost: '400.00', paid_stops: 0, office_cost_per_stop: null, gross_margin_pct: null, net_margin_pct: null }),
    ];
    const out = await svc.getOfficeCostPerStopSeries({ months: 12, db: makeDb({ monthly_financial_snapshots: stored }) });
    expect(out.months.map((m) => m.month)).toEqual(['2026-09-01', '2026-10-01']);
    expect(out.months[0]).toMatchObject({ paidStops: 0, officeCostPerStop: null, grossMarginPct: null, pnlComplete: true });
    expect(out.trailing).toEqual({ months: ['2026-09-01', '2026-10-01'], officeCost: 1000, paidStops: 60, officeCostPerStop: 16.67 });
    expect(out.officeCategories).toEqual(svc.OFFICE_CATEGORIES);
  });

  test.each([
    ['none: no trailing month used an allowance', ['0.00', '0.00', '0.00'], { status: 'none', monthsWithAllowance: 0, months: 3 }],
    ['some: it was added partway through the trailing months', ['0.00', '0.00', '300.00'], { status: 'some', monthsWithAllowance: 1, months: 3 }],
    ['all: every trailing month used it', ['300.00', '300.00', '300.00'], { status: 'all', monthsWithAllowance: 3, months: 3 }],
  ])('owner time, %s (read from the stored rows)', async (_n, allowances, expected) => {
    const stored = ['2026-10-01', '2026-09-01', '2026-08-01'].map((m, i) => row(m, { owner_allowance: allowances[2 - i] }));
    const db = makeDb({ monthly_financial_snapshots: stored });
    const out = await svc.getOfficeCostPerStopSeries({ db });
    expect(out.ownerOfficeTime).toEqual(expected);
    // Today's settings are never read for the note.
    expect(db.log.some((e) => e.table === 'company_financials')).toBe(false);
  });

  test('an older month with an allowance does not count when the trailing months have none', async () => {
    const stored = ['2026-10-01', '2026-09-01', '2026-08-01', '2026-07-01'].map((m, i) => row(m, { owner_allowance: i === 3 ? '300.00' : '0.00' }));
    const out = await svc.getOfficeCostPerStopSeries({ db: makeDb({ monthly_financial_snapshots: stored }) });
    expect(out.ownerOfficeTime.status).toBe('none');
  });

  test('names the trailing months stored before the balance ledger finished syncing; unknown (null) is not flagged', async () => {
    const stored = [row('2026-10-01', { pnl_complete: false }), row('2026-09-01', { pnl_complete: null }), row('2026-08-01'), row('2026-07-01', { pnl_complete: false })];
    const out = await svc.getOfficeCostPerStopSeries({ db: makeDb({ monthly_financial_snapshots: stored }) });
    expect(out.pnlIncompleteMonths).toEqual(['2026-10-01']); // July is outside the trailing three
    expect(out.months.find((m) => m.month === '2026-09-01').pnlComplete).toBeNull();
  });

  test('no stored months at all', async () => {
    const out = await svc.getOfficeCostPerStopSeries({ months: 'abc', db: makeDb({ monthly_financial_snapshots: [] }) });
    expect(out.months).toEqual([]);
    expect(out.ownerOfficeTime.status).toBe('none');
  });
});

describe('migration 20261126100000', () => {
  function makeKnex({ hasColumns = [], hasTables = [] } = {}) {
    const added = [];
    const created = [];
    const dropped = [];
    const cols = new Set(hasColumns);
    const tables = new Set(hasTables);
    const col = (name, args) => {
      const rec = { name, args, mods: [] };
      const b = new Proxy({}, { get: (_t, m) => (...a) => { rec.mods.push([m, ...a]); return b; } });
      return { rec, b };
    };
    const knex = {
      fn: { now: () => 'now()' },
      schema: {
        hasColumn: async (t, c) => cols.has(`${t}.${c}`),
        hasTable: async (t) => tables.has(t),
        alterTable: async (t, cb) => {
          cb({
            decimal: (name, ...args) => { added.push({ table: t, name, args }); cols.add(`${t}.${name}`); return col(name, args).b; },
            dropColumn: (name) => { dropped.push(`${t}.${name}`); cols.delete(`${t}.${name}`); },
          });
        },
        createTable: async (t, cb) => {
          const defs = [];
          const mk = (type) => (name, ...args) => { const c = col(name, args); defs.push({ type, name, args, rec: c.rec }); return c.b; };
          cb({ increments: mk('increments'), date: mk('date'), decimal: mk('decimal'), integer: mk('integer'), timestamp: mk('timestamp') });
          created.push({ table: t, defs });
          tables.add(t);
        },
        dropTableIfExists: async (t) => { dropped.push(t); tables.delete(t); },
      },
    };
    return { knex, added, created, dropped };
  }

  test('adds the two nullable owner-time columns and the snapshot table, one row per month', async () => {
    const { knex, added, created } = makeKnex();
    await migration.up(knex);
    expect(added.map((a) => `${a.table}.${a.name}`)).toEqual([
      'company_financials.owner_office_hours_per_month',
      'company_financials.owner_office_hourly_rate',
    ]);
    expect(created).toHaveLength(1);
    expect(created[0].table).toBe('monthly_financial_snapshots');
    const month = created[0].defs.find((d) => d.name === 'month');
    expect(month.type).toBe('date');
    expect(month.rec.mods.map(([m]) => m)).toEqual(expect.arrayContaining(['notNullable', 'unique']));
    const names = created[0].defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining([
      'completed_job_revenue', 'cash_revenue', 'gross_margin_pct', 'office_cost', 'owner_allowance',
      'paid_stops', 'office_cost_per_stop', 'net_income', 'net_margin_pct', 'computed_at',
    ]));
  });

  test('a second run changes nothing', async () => {
    const { knex, added, created } = makeKnex({
      hasColumns: ['company_financials.owner_office_hours_per_month', 'company_financials.owner_office_hourly_rate'],
      hasTables: ['monthly_financial_snapshots'],
    });
    await migration.up(knex);
    expect(added).toEqual([]);
    expect(created).toEqual([]);
  });

  test('down drops the table and the two columns', async () => {
    const { knex, dropped } = makeKnex({
      hasColumns: ['company_financials.owner_office_hours_per_month', 'company_financials.owner_office_hourly_rate'],
      hasTables: ['monthly_financial_snapshots'],
    });
    await migration.down(knex);
    expect(dropped).toEqual([
      'monthly_financial_snapshots',
      'company_financials.owner_office_hours_per_month',
      'company_financials.owner_office_hourly_rate',
    ]);
  });
});

describe('migration 20261126110000 (pnl_complete)', () => {
  const pnlMigration = require('../models/migrations/20261126110000_monthly_financial_snapshots_pnl_complete');
  function makeKnex(hasColumn) {
    const log = [];
    let present = hasColumn;
    return {
      log,
      schema: {
        hasColumn: async () => present,
        alterTable: async (table, cb) => {
          cb({
            boolean: (name) => { log.push(['boolean', table, name]); present = true; const b = { nullable: () => { log.push(['nullable', name]); return b; } }; return b; },
            dropColumn: (name) => { log.push(['dropColumn', table, name]); present = false; },
          });
        },
      },
    };
  }

  test('adds one nullable boolean column, and a second run changes nothing', async () => {
    const knex = makeKnex(false);
    await pnlMigration.up(knex);
    expect(knex.log).toEqual([['boolean', 'monthly_financial_snapshots', 'pnl_complete'], ['nullable', 'pnl_complete']]);
    await pnlMigration.up(knex);
    expect(knex.log).toHaveLength(2);
  });

  test('down drops it only when it is there', async () => {
    const knex = makeKnex(true);
    await pnlMigration.down(knex);
    expect(knex.log).toEqual([['dropColumn', 'monthly_financial_snapshots', 'pnl_complete']]);
    await pnlMigration.down(knex);
    expect(knex.log).toHaveLength(1);
  });
});
