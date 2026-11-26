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

const svc = require('../services/monthly-financial-snapshot');
const migration = require('../models/migrations/20261126100000_monthly_financial_snapshots');

// A knex fake that records every call per table and answers from `results[table]`.
function makeDb(results = {}) {
  const log = [];
  const db = (table) => {
    const entry = { table, calls: [] };
    log.push(entry);
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

  test('paid stops: completed visits in the month, callbacks and free returns left out (flag null counts as not a callback)', async () => {
    const db = makeDb({ service_records: { first: { n: '42' } } });
    expect(await svc.paidStopsForWindow(db, '2026-10-01', '2026-10-31')).toBe(42);
    const calls = db.callsFor('service_records');
    expect(calls).toContainEqual(['whereBetween', 'service_date', ['2026-10-01', '2026-10-31']]);
    expect(calls).toContainEqual(['where', 'status', 'completed']);
    expect(calls).toContainEqual(['whereNull', 'is_callback']);
    expect(calls).toContainEqual(['orWhere', 'is_callback', false]);
  });
});

describe('computeMonthSnapshot', () => {
  const pnl = (cash, net, margin) => ({ revenue: { total: cash }, netIncome: net, netMargin: margin });

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
    });
    expect(mockBuildPnl).toHaveBeenCalledWith(db, '2026-10-01', '2026-10-31');
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
});

describe('runMonthlyFinancialSnapshots', () => {
  const NOW = new Date('2026-12-02T10:35:00Z'); // 05:35 ET on the 2nd

  function runDb({ existing = null } = {}) {
    const inserted = [];
    const db = (table) => {
      if (table === 'monthly_financial_snapshots') {
        const q = {
          where: () => q,
          first: () => Promise.resolve(existing),
          insert: (row) => { inserted.push(row); return q; },
          onConflict: () => q,
          merge: () => Promise.resolve(),
        };
        return q;
      }
      return makeDb({ expenses: { first: { total: '100' } }, service_records: { first: { n: '10', revenue: '1000', weighted_margin: '50' } }, company_financials: { first: null } })(table);
    };
    db.raw = (s) => s;
    return { db, inserted };
  }

  test('writes last month and re-writes the month before it', async () => {
    mockBuildPnl.mockResolvedValue({ revenue: { total: 900 }, netIncome: 100, netMargin: 0.11 });
    const { db, inserted } = runDb();
    const res = await svc.runMonthlyFinancialSnapshots({ now: NOW, db });
    expect(res).toEqual({ skipped: null, months: ['2026-11-01', '2026-10-01'] });
    expect(inserted.map((r) => r.month)).toEqual(['2026-11-01', '2026-10-01']);
    expect(inserted[0]).toMatchObject({ paid_stops: 10, office_cost: 100, office_cost_per_stop: 10 });
    expect(inserted[0].computed_at).toBeInstanceOf(Date);
  });

  test('the catch-up run writes nothing once last month has its row', async () => {
    const { db, inserted } = runDb({ existing: { id: 7 } });
    const res = await svc.runMonthlyFinancialSnapshots({ now: new Date('2026-12-04T10:35:00Z'), catchUp: true, db });
    expect(res).toEqual({ skipped: 'already_written', months: [] });
    expect(inserted).toEqual([]);
    expect(mockBuildPnl).not.toHaveBeenCalled();
  });

  test('the catch-up run fills a missing month (a lost tick on the 2nd)', async () => {
    mockBuildPnl.mockResolvedValue({ revenue: { total: 900 }, netIncome: 100, netMargin: 0.11 });
    const { db, inserted } = runDb({ existing: null });
    const res = await svc.runMonthlyFinancialSnapshots({ now: new Date('2026-12-04T10:35:00Z'), catchUp: true, db });
    expect(res.months).toEqual(['2026-11-01', '2026-10-01']);
    expect(inserted).toHaveLength(2);
  });
});

describe('getOfficeCostPerStopSeries', () => {
  test('returns the stored rows oldest first with the headline, and says when owner time is not counted', async () => {
    const stored = [ // newest first, as the query returns them
      { month: '2026-10-01', completed_job_revenue: '5000.00', cash_revenue: '4800.00', gross_margin_pct: '51.20', office_cost: '600.00', owner_allowance: '0.00', paid_stops: 60, office_cost_per_stop: '10.00', net_income: '700.00', net_margin_pct: '14.58' },
      { month: new Date(Date.UTC(2026, 8, 1)), completed_job_revenue: '4000.00', cash_revenue: '3900.00', gross_margin_pct: null, office_cost: '400.00', owner_allowance: '0.00', paid_stops: 0, office_cost_per_stop: null, net_income: '-50.00', net_margin_pct: null },
    ];
    const db = makeDb({ monthly_financial_snapshots: stored, company_financials: { first: { owner_office_hours_per_month: null, owner_office_hourly_rate: null } } });
    const out = await svc.getOfficeCostPerStopSeries({ months: 12, db });
    expect(out.months.map((m) => m.month)).toEqual(['2026-09-01', '2026-10-01']);
    expect(out.months[0]).toMatchObject({ paidStops: 0, officeCostPerStop: null, grossMarginPct: null });
    expect(out.trailing).toEqual({ months: ['2026-09-01', '2026-10-01'], officeCost: 1000, paidStops: 60, officeCostPerStop: 16.67 });
    expect(out.ownerOfficeTime).toEqual({ counted: false, hoursPerMonth: null, hourlyRate: null });
    expect(out.officeCategories).toEqual(svc.OFFICE_CATEGORIES);
  });

  test('owner time set is reported as counted', async () => {
    const db = makeDb({ monthly_financial_snapshots: [], company_financials: { first: { owner_office_hours_per_month: '8', owner_office_hourly_rate: '45' } } });
    const out = await svc.getOfficeCostPerStopSeries({ months: 'abc', db });
    expect(out.ownerOfficeTime).toEqual({ counted: true, hoursPerMonth: 8, hourlyRate: 45 });
    expect(out.months).toEqual([]);
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
