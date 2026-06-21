jest.mock('../services/mrr-breakdown', () => ({ computeMrrBreakdown: jest.fn() }));

const { computeMrrBreakdown } = require('../services/mrr-breakdown');
const { recordMrrSnapshot, tierBreakdown } = require('../services/mrr-snapshot');

// Fake Knex: customers queries resolve to canned tier rows; mrr_snapshots
// captures the upserted row (insert → onConflict → merge).
function makeFakeDb({ tierRows = [], capture = {} } = {}) {
  const customers = {
    where: () => customers,
    whereNull: () => customers,
    whereNotIn: (col, list) => { capture.tierExcluded = list; return customers; },
    modify: (fn) => { fn(customers); return customers; },
    select: () => customers,
    groupBy: () => customers,
    then: (res, rej) => Promise.resolve(tierRows).then(res, rej),
  };
  const snapshots = {
    insert: (row) => { capture.row = row; return snapshots; },
    onConflict: (col) => { capture.conflict = col; return snapshots; },
    merge: () => { capture.merged = true; return Promise.resolve(); },
  };
  const db = (table) => (String(table).startsWith('mrr_snapshots') ? snapshots : customers);
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

describe('recordMrrSnapshot', () => {
  beforeEach(() => {
    computeMrrBreakdown.mockResolvedValue({ total: 1000, committed: 800, atRisk: 200, totalCount: 25, atRiskCount: 4 });
  });

  test('upserts a snapshot row from the MRR breakdown + tier breakdown', async () => {
    const capture = {};
    const db = makeFakeDb({
      tierRows: [{ waveguard_tier: 'Gold', mrr: '600', count: '15' }, { waveguard_tier: 'None', mrr: '400', count: '10' }],
      capture,
    });
    const out = await recordMrrSnapshot('2026-06-01', db);

    expect(computeMrrBreakdown).toHaveBeenCalledWith(db, expect.any(String));
    expect(capture.conflict).toBe('period_month');
    expect(capture.merged).toBe(true);
    expect(capture.row).toMatchObject({
      period_month: '2026-06-01',
      total_mrr: 1000,
      committed_mrr: 800,
      at_risk_mrr: 200,
      customer_count: 25,
    });
    // by_tier is serialized JSON of the tier breakdown.
    expect(JSON.parse(capture.row.by_tier)).toEqual([
      { tier: 'Gold', mrr: 600, count: 15 },
      { tier: 'None', mrr: 400, count: 10 },
    ]);
    expect(out).toMatchObject({ period_month: '2026-06-01', total: 1000, committed: 800, atRisk: 200 });
  });
});
