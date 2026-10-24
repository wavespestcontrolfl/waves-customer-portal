// Score scale 2 (GATE_LAWN_SCORE_SCALE_V2, owner 2026-10-24): the ROI improvement buckets and the
// neighbor benchmarks compare lawn scores within one score scale. A scale-1 row (NULL) and a
// scale-2 row never meet in a first-to-last improvement or a benchmark pool. Synthetic ids only.
jest.mock('../models/db', () => {
  const fn = (table) => global.__scaleDb(table);
  fn.schema = { hasColumn: jest.fn(async () => true) };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/fawn-weather', () => ({ getCurrent: jest.fn(), getPressureSignals: jest.fn(() => []) }));
jest.mock('../services/lawn-grass-context', () => ({
  loadCustomerGrassContext: jest.fn(async () => ({ grassType: 'st_augustine' })),
  normalizeGrassType: jest.fn((g) => g),
}));
jest.mock('../services/agronomic-wiki', () => ({
  recomputeEntryReviewGate: jest.fn(async () => {}),
  escapeLike: jest.requireActual('../services/agronomic-wiki').escapeLike,
}));

const analytics = require('../services/assessment-analytics');

// A chainable query double: `rows(table, ops, how)` answers each awaited read.
function useDb(rows) {
  const inserts = [];
  global.__scaleDb = (table) => {
    const ops = [];
    const b = {};
    for (const m of ['distinct', 'where', 'andWhere', 'orWhere', 'whereIn', 'select', 'orderBy', 'join']) {
      b[m] = (...args) => { ops.push([m, args]); if (typeof args[0] === 'function') args[0].call(b); return b; };
    }
    b.leftJoin = (name, on) => { ops.push(['leftJoin', [name]]); const j = { on: () => j, andOnVal: () => j }; if (typeof on === 'function') on.call(j); return b; };
    b.pluck = async () => [];
    b.sum = () => b;
    b.first = async () => (rows(table, ops, 'first') || [])[0] ?? null;
    b.then = (resolve, reject) => Promise.resolve(rows(table, ops, 'all') || []).then(resolve, reject);
    b.insert = (row) => { inserts.push({ table, row }); return { onConflict: () => ({ merge: async () => 1 }) }; };
    return b;
  };
  return inserts;
}

const visit = (customer, date, overall, scale) => ({ customer_id: customer, service_date: date, overall_score: overall, score_scale: scale ?? null });

test('ROI improvement buckets: first to last on each customer\'s latest score scale only', async () => {
  useDb((table) => (table === 'lawn_assessments' ? [
    // Old scale 70 -> 72, then one new-scale visit at 95: no same-scale pair, never "+25".
    visit('a', '2026-06-01', 70), visit('a', '2026-08-01', 72), visit('a', '2026-11-01', 95, 2),
    // Old scale only: 80 -> 60 is a decline.
    visit('b', '2026-06-01', 80), visit('b', '2026-08-01', 60),
    // New scale only: 70 -> 95 is a big improvement.
    visit('c', '2026-11-01', 70, 2), visit('c', '2026-12-01', 95, 2),
  ] : []));
  const roi = await analytics.computeROI();
  expect(roi.improvementBuckets).toEqual({ bigImprovers: 1, smallImprovers: 0, decliners: 1 });
});

describe('neighbor benchmarks', () => {
  const row = (id, overall, scale) => ({ id, zip: '34202', grass_type: 'st_augustine', lawn_type: null, overall_score: overall, is_baseline: false, service_date: '2026-10-01', score_scale: scale ?? null });

  test('one segment per score scale; a scale with fewer than 3 customers writes no benchmark', async () => {
    const twoOnScale2 = [row('c1', 70), row('c2', 80), row('c3', 90), row('c1', 95, 2), row('c2', 85, 2)];
    let inserts = useDb((table) => (table === 'customers as c' ? twoOnScale2 : []));
    await analytics.computeNeighborhoodBenchmarks();
    expect(inserts.map((i) => i.row.segment_key)).toEqual(['34202|st-augustine']);
    expect(inserts[0].row).toMatchObject({ customer_count: 3, assessment_count: 3, avg_overall: 80 });

    inserts = useDb((table) => (table === 'customers as c' ? [...twoOnScale2, row('c3', 88, 2)] : []));
    await analytics.computeNeighborhoodBenchmarks();
    const byKey = Object.fromEntries(inserts.map((i) => [i.row.segment_key, i.row]));
    expect(Object.keys(byKey).sort()).toEqual(['34202|st-augustine', '34202|st-augustine|s2']);
    expect(byKey['34202|st-augustine|s2']).toMatchObject({ customer_count: 3, assessment_count: 3, avg_overall: 89 });
    expect(byKey['34202|st-augustine'].avg_overall).toBe(80);
  });

  test('a customer is ranked against the benchmark of their latest score\'s scale', async () => {
    const keysRead = [];
    const benchmark = { customer_count: 3, p25_overall: 70, p50_overall: 80, p75_overall: 90, avg_overall: 80, segment_name: '34202' };
    const answer = (latest) => (table, ops) => {
      if (table === 'customers') return [{ id: 'c1', zip: '34202' }];
      if (table === 'lawn_assessments') return [latest];
      if (table === 'neighborhood_benchmarks') {
        const key = ops.find(([m]) => m === 'where')[1][0].segment_key;
        keysRead.push(key);
        return [benchmark];
      }
      return [];
    };
    useDb(answer({ overall_score: 92, score_scale: 2 }));
    expect((await analytics.getCustomerBenchmark('c1')).percentile).toBe('top 25%');
    useDb(answer({ overall_score: 85, score_scale: null }));
    await analytics.getCustomerBenchmark('c1');
    expect(keysRead).toEqual(['34202|st-augustine|s2', '34202|st-augustine']);
  });
});
