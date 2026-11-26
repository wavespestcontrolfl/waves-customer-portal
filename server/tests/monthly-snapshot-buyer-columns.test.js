/**
 * The buyer-view columns of the monthly snapshot (services/monthly-snapshot-buyer-columns.js), no database: the
 * allowance rounding, EBITDA and the owner-paid profit rules, and the owner's field minutes on a recording fake
 * (one owner login, standard minutes, a grouped visit as one stop). The real SQL runs in buyer-view-postgres.test.js.
 * Synthetic numbers only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The owner phones: the same predicate ops-buyer-metrics.js uses to tell the owner apart.
jest.mock('../services/twilio', () => ({ isKnownOwnerPhone: (phone) => ['+19415550100', '+19415550101'].includes(phone) }));

const cols = require('../services/monthly-snapshot-buyer-columns');

// A knex fake: every call on a table's chain is recorded, and awaiting the chain gives results[table].
function makeDb(results = {}) {
  const log = [];
  const db = (table) => {
    const name = String(table).split(' as ')[0];
    const entry = { table: name, calls: [] };
    log.push(entry);
    return new Proxy({}, {
      get(_t, method) {
        if (method === 'then') return (resolve, reject) => Promise.resolve(results[name] ?? []).then(resolve, reject);
        return (...args) => { entry.calls.push([method, ...args]); return db.__q(entry); };
      },
    });
  };
  db.__q = (entry) => new Proxy({}, {
    get(_t, method) {
      if (method === 'then') return (resolve, reject) => Promise.resolve(results[entry.table] ?? []).then(resolve, reject);
      if (method === 'first') return (...args) => { entry.calls.push([method, ...args]); return Promise.resolve((results[entry.table] || [])[0] ?? null); };
      return (...args) => { entry.calls.push([method, ...args]); return db.__q(entry); };
    },
  });
  db.raw = (sql) => sql;
  db.log = log;
  db.callsFor = (table) => log.filter((e) => e.table === table).flatMap((e) => e.calls);
  return db;
}

describe('timeAllowance', () => {
  test('hundredths of an hour x cents, rounded once: 2.50 h x $21.29 is 53.23, where a float product gives 53.22', () => {
    expect(2.5 * 21.29 * 100 / 100).not.toBe(53.23); // the float trap this guards against
    expect(cols.timeAllowance(2.5, 21.29)).toBe(53.23);
    expect(cols.timeAllowance('12.50', '40.00')).toBe(500);
  });

  test('null, zero or a missing input counts nothing', () => {
    expect(cols.timeAllowance(null, 25)).toBe(0);
    expect(cols.timeAllowance(10, null)).toBe(0);
    expect(cols.timeAllowance(0, 25)).toBe(0);
    expect(cols.timeAllowance(undefined, undefined)).toBe(0);
  });
});

describe('ebitdaOf and profitColumns', () => {
  const pnl = {
    netIncome: 1000,
    grossProfit: 6000,
    deductions: { depreciation: 200 },
    operatingExpenses: { categories: [
      { name: 'Interest', amount: 50 }, { name: 'Depreciation', amount: 10 }, { name: 'Insurance', amount: 700 },
    ] },
  };

  test('EBITDA adds back the asset-schedule depreciation and the interest and depreciation ledger categories, nothing else', () => {
    expect(cols.ebitdaOf(pnl)).toBe(1260);
    expect(cols.ebitdaOf({ netIncome: 500 })).toBe(500);
  });

  test('owner-paid profit is EBITDA less the office and field allowances; SDE is EBITDA before them', () => {
    expect(cols.profitColumns({ pnl, officeAllowance: 100, field: { allowance: 160, onPayroll: false }, cashRevenue: 10000 }))
      .toEqual({ book_gross_margin_pct: 58.4, owner_paid_profit: 1000, sde: 1260 });
  });

  test('a paycheck covering the owner leaves all three blank, because the paycheck would have to be added back', () => {
    expect(cols.profitColumns({ pnl, officeAllowance: 100, field: { allowance: 0, onPayroll: true }, cashRevenue: 10000 }))
      .toEqual({ book_gross_margin_pct: null, owner_paid_profit: null, sde: null });
  });

  test('an owner that cannot be resolved while a rate is set leaves margin and profit blank but keeps SDE', () => {
    expect(cols.profitColumns({ pnl, officeAllowance: 0, field: { allowance: null, onPayroll: false }, cashRevenue: 10000 }))
      .toEqual({ book_gross_margin_pct: null, owner_paid_profit: null, sde: 1260 });
  });

  test('no revenue gives no margin, never a divide by zero', () => {
    expect(cols.profitColumns({ pnl, officeAllowance: 0, field: { allowance: 0, onPayroll: false }, cashRevenue: 0 }).book_gross_margin_pct).toBeNull();
  });
});

describe('the owner and the owner\'s field time', () => {
  const OWNER = '+19415550100';

  test('the owner is ops-buyer-metrics\' one admin technician with a known owner phone; two or none is unavailable', async () => {
    const one = makeDb({ technicians: [{ id: 't1', phone: OWNER, employment_type: null }, { id: 't9', phone: '+19415550999' }] });
    expect(await cols.ownerForSnapshot(one)).toEqual({ id: 't1', onPayroll: false });
    expect(one.callsFor('technicians')).toContainEqual(['where', 'role', 'admin']);
    expect(await cols.ownerForSnapshot(makeDb({ technicians: [{ id: 't1', phone: OWNER }, { id: 't2', phone: '+19415550101' }] }))).toBeNull();
    expect(await cols.ownerForSnapshot(makeDb({ technicians: [{ id: 't9', phone: '+19415550999' }, { id: 't8', phone: null }] }))).toBeNull();
    expect(await cols.ownerForSnapshot(makeDb({ technicians: [] }))).toBeNull();
    expect(await cols.ownerForSnapshot(makeDb({ technicians: [{ id: 't3', phone: OWNER, employment_type: 'w2' }] }))).toEqual({ id: 't3', onPayroll: true });
  });

  const stops = [
    { stop_key: 'g1', service_type: 'Pest Control Visit', labor_hours: '0.90' }, // grouped: pest 25 + lawn 20, one drive
    { stop_key: 'g1', service_type: 'Lawn Care Visit', labor_hours: '0.10' },
    { stop_key: 'r2', service_type: 'Pest Control Visit', labor_hours: '2.00' }, // app tap span is never read: 25 standard
    { stop_key: 'r3', service_type: 'Termite Inspection', labor_hours: '0.50' }, // no standard: costed labor hours (30 min)
  ];

  test('minutes: standard on-site minutes of every service in a stop, plus one 20-minute drive per physical stop', async () => {
    const db = makeDb({ service_records: stops });
    expect(await cols.ownerFieldMinutes(db, 't1', '2026-10-01', '2026-10-31')).toEqual({ minutes: (45 + 20) + (25 + 20) + (30 + 20), stops: 3 });
  });

  test('hours and allowance: hundredths of an hour x the rate in effect; no rate counts 0; an unresolvable owner is unavailable', async () => {
    const results = { technicians: [{ id: 't1', phone: OWNER, employment_type: null }], service_records: stops };
    expect(await cols.ownerFieldTime(makeDb(results), { owner_field_hourly_rate: '25.00' }, '2026-10-01', '2026-10-31'))
      .toEqual({ hours: 2.67, allowance: 66.75, onPayroll: false }); // 160 min = 2.67 h; 267 x 2500 cents
    expect(await cols.ownerFieldTime(makeDb(results), null, '2026-10-01', '2026-10-31')).toEqual({ hours: 2.67, allowance: 0, onPayroll: false });
    const none = makeDb({ technicians: [], service_records: stops });
    expect(await cols.ownerFieldTime(none, { owner_field_hourly_rate: '25.00' }, '2026-10-01', '2026-10-31')).toEqual({ hours: null, allowance: null, onPayroll: false });
    expect(await cols.ownerFieldTime(none, {}, '2026-10-01', '2026-10-31')).toEqual({ hours: null, allowance: 0, onPayroll: false });
  });

  test('an owner on payroll: the hours are reported, no allowance is charged', async () => {
    const db = makeDb({ technicians: [{ id: 't1', phone: OWNER, employment_type: 'w2' }], service_records: stops });
    expect(await cols.ownerFieldTime(db, { owner_field_hourly_rate: '25.00' }, '2026-10-01', '2026-10-31')).toEqual({ hours: 2.67, allowance: 0, onPayroll: true });
  });
});

describe('migration 20261126120000', () => {
  const migration = require('../models/migrations/20261126120000_snapshot_buyer_columns_owner_field_rate');
  function makeKnex(present = []) {
    const have = new Set(present);
    const added = [];
    const dropped = [];
    const updates = [];
    const knex = (table) => ({
      whereNull: () => ({ update: async (v) => { updates.push({ table, v }); } }),
    });
    knex.schema = {
      hasColumn: async (table, name) => have.has(`${table}.${name}`),
      alterTable: async (table, cb) => {
        cb({
          decimal: (name, precision, scale) => { added.push(`${table}.${name} ${precision},${scale}`); have.add(`${table}.${name}`); return { nullable: () => {} }; },
          dropColumn: (name) => { dropped.push(`${table}.${name}`); have.delete(`${table}.${name}`); },
        });
      },
    };
    return { knex, added, dropped, updates };
  }

  test('adds the field wage and the nine snapshot columns, all nullable decimals, and seeds the owner\'s $25 once', async () => {
    const { knex, added, updates } = makeKnex();
    await migration.up(knex);
    expect(added).toEqual([
      'company_financials.owner_field_hourly_rate 8,2',
      'monthly_financial_snapshots.book_gross_margin_pct 7,2',
      'monthly_financial_snapshots.owner_field_hours 8,2',
      'monthly_financial_snapshots.owner_field_allowance 12,2',
      'monthly_financial_snapshots.owner_paid_profit 12,2',
      'monthly_financial_snapshots.sde 12,2',
      'monthly_financial_snapshots.recurring_revenue 12,2',
      'monthly_financial_snapshots.recurring_mature_revenue 12,2',
      'monthly_financial_snapshots.prepaid_owed 12,2',
      'monthly_financial_snapshots.autopay_renewing_share 6,4',
    ]);
    expect(updates).toEqual([{ table: 'company_financials', v: { owner_field_hourly_rate: 25 } }]);
  });

  test('a second run changes nothing and never overwrites a wage the owner has since changed', async () => {
    const all = [
      'company_financials.owner_field_hourly_rate',
      ...migration.SNAPSHOT_COLUMNS.map(([c]) => `monthly_financial_snapshots.${c}`),
    ];
    const { knex, added, updates } = makeKnex(all);
    await migration.up(knex);
    expect(added).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('down drops what up added', async () => {
    const all = [
      'company_financials.owner_field_hourly_rate',
      ...migration.SNAPSHOT_COLUMNS.map(([c]) => `monthly_financial_snapshots.${c}`),
    ];
    const { knex, dropped } = makeKnex(all);
    await migration.down(knex);
    expect(dropped).toHaveLength(10);
    expect(dropped[dropped.length - 1]).toBe('company_financials.owner_field_hourly_rate');
  });
});
