jest.mock('../services/mrr-breakdown', () => ({ computeMrrBreakdown: jest.fn() }));

const { computeMrrBreakdown } = require('../services/mrr-breakdown');
const {
  recordMrrSnapshot,
  recordCustomerMrrSnapshots,
  customerRateRows,
  tierBreakdown,
} = require('../services/mrr-snapshot');

// Fake Knex.
//  - customers queries: a FRESH builder per db('customers') call. The grouped
//    (tierBreakdown) query resolves to `tierRows`; the per-customer query
//    (customerRateRows, no groupBy) resolves to `customerRows`.
//  - mrr_snapshots / customer_mrr_snapshots capture the upsert (insert →
//    onConflict → merge). `custFail` makes the per-customer merge reject so we
//    can prove it can't break the aggregate.
function makeFakeDb({ tierRows = [], customerRows = [], capture = {}, custFail = false } = {}) {
  function makeCustomers() {
    let grouped = false;
    const b = {
      where: () => b,
      whereNull: () => b,
      whereNotIn: (col, list) => { capture.tierExcluded = list; return b; },
      modify: (fn) => { fn(b); return b; },
      select: () => b,
      groupBy: () => { grouped = true; return b; },
      then: (res, rej) => Promise.resolve(grouped ? tierRows : customerRows).then(res, rej),
    };
    return b;
  }
  const snapshots = {
    insert: (row) => { capture.row = row; return snapshots; },
    onConflict: (col) => { capture.conflict = col; return snapshots; },
    merge: () => { capture.merged = true; return Promise.resolve(); },
  };
  const custSnapshots = {
    insert: (rows) => { capture.custRows = rows; return custSnapshots; },
    onConflict: (cols) => { capture.custConflict = cols; return custSnapshots; },
    merge: () => {
      capture.custMerged = true;
      return custFail ? Promise.reject(new Error('boom')) : Promise.resolve();
    },
  };
  const db = (table) => {
    const t = String(table);
    if (t.startsWith('customer_mrr_snapshots')) return custSnapshots;
    if (t.startsWith('mrr_snapshots')) return snapshots;
    return makeCustomers();
  };
  db.raw = (sql) => ({ sql });
  return db;
}

describe('tierBreakdown', () => {
  test('maps rows and labels a null tier "None"', async () => {
    const db = makeFakeDb({ tierRows: [
      { waveguard_tier: 'Gold', mrr: '600.00', count: '15' },
      { waveguard_tier: null, mrr: '400', count: '10' },
    ] });
    const tiers = await tierBreakdown(db);
    expect(tiers).toEqual([
      { tier: 'Gold', mrr: 600, count: 15 },
      { tier: 'None', mrr: 400, count: 10 },
    ]);
  });

  test('excludes internal/test accounts (same population as the live trend)', async () => {
    const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
    const capture = {};
    const db = makeFakeDb({ tierRows: [], capture });
    await tierBreakdown(db);
    expect(capture.tierExcluded).toEqual(INTERNAL_TEST_CUSTOMERS);
  });
});

describe('customerRateRows', () => {
  test('maps id/rate/tier and coerces rate to a number, null tier stays null', async () => {
    const db = makeFakeDb({ customerRows: [
      { customer_id: 'c1', monthly_rate: '120.00', waveguard_tier: 'Gold' },
      { customer_id: 'c2', monthly_rate: '0', waveguard_tier: null },
    ] });
    const rows = await customerRateRows(db);
    expect(rows).toEqual([
      { customer_id: 'c1', monthly_rate: 120, waveguard_tier: 'Gold' },
      { customer_id: 'c2', monthly_rate: 0, waveguard_tier: null },
    ]);
  });

  test('excludes internal/test accounts (same population as the aggregate)', async () => {
    const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
    const capture = {};
    await customerRateRows(makeFakeDb({ customerRows: [], capture }));
    expect(capture.tierExcluded).toEqual(INTERNAL_TEST_CUSTOMERS);
  });
});

describe('recordCustomerMrrSnapshots', () => {
  test('batch-upserts one row per customer, conflict on (period_month, customer_id)', async () => {
    const capture = {};
    const db = makeFakeDb({
      customerRows: [
        { customer_id: 'c1', monthly_rate: '120', waveguard_tier: 'Gold' },
        { customer_id: 'c2', monthly_rate: '40', waveguard_tier: 'Bronze' },
      ],
      capture,
    });
    const out = await recordCustomerMrrSnapshots('2026-06-01', db);

    expect(out).toEqual({ period_month: '2026-06-01', count: 2 });
    expect(capture.custConflict).toEqual(['period_month', 'customer_id']);
    expect(capture.custMerged).toBe(true);
    expect(capture.custRows).toEqual([
      expect.objectContaining({ period_month: '2026-06-01', customer_id: 'c1', monthly_rate: 120, waveguard_tier: 'Gold' }),
      expect.objectContaining({ period_month: '2026-06-01', customer_id: 'c2', monthly_rate: 40, waveguard_tier: 'Bronze' }),
    ]);
  });

  test('writes nothing when the population is empty', async () => {
    const capture = {};
    const out = await recordCustomerMrrSnapshots('2026-06-01', makeFakeDb({ customerRows: [], capture }));
    expect(out).toEqual({ period_month: '2026-06-01', count: 0 });
    expect(capture.custRows).toBeUndefined();
  });
});

describe('recordMrrSnapshot', () => {
  beforeEach(() => {
    computeMrrBreakdown.mockResolvedValue({ total: 1000, committed: 800, atRisk: 200, totalCount: 25, atRiskCount: 4 });
  });

  test('upserts the aggregate snapshot AND per-customer rows', async () => {
    const capture = {};
    const db = makeFakeDb({
      tierRows: [{ waveguard_tier: 'Gold', mrr: '600', count: '15' }, { waveguard_tier: 'None', mrr: '400', count: '10' }],
      customerRows: [{ customer_id: 'c1', monthly_rate: '600', waveguard_tier: 'Gold' }],
      capture,
    });
    const out = await recordMrrSnapshot('2026-06-01', db);

    expect(computeMrrBreakdown).toHaveBeenCalledWith(db, expect.any(String));
    // aggregate
    expect(capture.conflict).toBe('period_month');
    expect(capture.merged).toBe(true);
    expect(capture.row).toMatchObject({
      period_month: '2026-06-01',
      total_mrr: 1000,
      committed_mrr: 800,
      at_risk_mrr: 200,
      customer_count: 25,
    });
    expect(JSON.parse(capture.row.by_tier)).toEqual([
      { tier: 'Gold', mrr: 600, count: 15 },
      { tier: 'None', mrr: 400, count: 10 },
    ]);
    // per-customer
    expect(capture.custConflict).toEqual(['period_month', 'customer_id']);
    expect(capture.custRows).toEqual([
      expect.objectContaining({ period_month: '2026-06-01', customer_id: 'c1', monthly_rate: 600 }),
    ]);
    expect(out).toMatchObject({ period_month: '2026-06-01', total: 1000, customerSnapshot: { period_month: '2026-06-01', count: 1 } });
  });

  test('a per-customer failure does not break the aggregate snapshot', async () => {
    const capture = {};
    const db = makeFakeDb({
      tierRows: [{ waveguard_tier: 'Gold', mrr: '600', count: '15' }],
      customerRows: [{ customer_id: 'c1', monthly_rate: '600', waveguard_tier: 'Gold' }],
      capture,
      custFail: true,
    });
    const out = await recordMrrSnapshot('2026-06-01', db);

    // aggregate still committed; the call resolves; per-customer is isolated to null
    expect(capture.merged).toBe(true);
    expect(capture.custMerged).toBe(true); // it tried, then rejected internally
    expect(out).toMatchObject({ period_month: '2026-06-01', total: 1000, customerSnapshot: null });
  });
});
