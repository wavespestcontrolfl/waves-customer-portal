// ops/agents/tree-shrub-estimates-report.js — the pure half (payload
// extraction + roll-up). The script is the owner's evidence for the
// 2026-10-21 "quotes read high" audit, so the three stored payload shapes it
// claims to read must each resolve, and a stale raw line must lose to the
// mapped envelope exactly as estimate-actuals does.
const path = require('path');
const { extractTreeShrub, outcomeOf, summarize, median } = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'tree-shrub-estimates-report.js'));

describe('tree-shrub-estimates-report extraction', () => {
  test('raw engine line that agrees with the mapped envelope carries the full source enums', () => {
    const data = {
      engineResult: { lineItems: [{ service: 'tree_shrub', bedAreaUsed: 1800, bedAreaSource: 'lot_based', treeCount: 6, treeCountSource: 'density_estimate', monthly: 51.44, tier: 'standard', manualReviewReasons: [] }] },
      result: { results: { tsMeta: { eb: 1800, et: 6, bedAreaIsEstimated: true }, ts: [{ tier: 'standard', mo: 51.44, selected: true }] } },
    };
    expect(extractTreeShrub(data)).toMatchObject({ shape: 'raw', bedSqFt: 1800, bedSource: 'lot_based', treeCount: 6, treeSource: 'density_estimate', monthly: 51.44, tier: 'standard' });
  });

  test('a stale raw line (revision replaced the mapped result) loses to the mapped envelope, which reports the coarse source', () => {
    const data = {
      engineResult: { lineItems: [{ service: 'tree_shrub', bedAreaUsed: 1800, bedAreaSource: 'lot_based', treeCount: 6, monthly: 51.44 }] },
      result: { results: { tsMeta: { eb: 900, et: 2, bedAreaIsEstimated: false }, ts: [{ tier: 'standard', mo: 38.5, selected: true }] } },
    };
    expect(extractTreeShrub(data)).toMatchObject({ shape: 'mapped', bedSqFt: 900, bedSource: 'measured', treeCount: 2, treeSource: 'unknown', monthly: 38.5 });
  });

  test('a compact quote-wizard line reports price only, never a fabricated zero', () => {
    const data = { result: { lineItems: [{ service: 'tree_shrub', monthly: 35, tier: 'standard' }] } };
    expect(extractTreeShrub(data)).toMatchObject({ shape: 'compact', bedSqFt: null, bedSource: 'unknown', treeCount: null, monthly: 35 });
    expect(extractTreeShrub({ result: { lineItems: [{ service: 'lawn_care', monthly: 60 }] } })).toBeNull();
  });

  test('outcome and roll-up', () => {
    expect(outcomeOf({ status: 'sent', accepted_at: '2026-10-01' })).toBe('accepted');
    expect(outcomeOf({ status: 'accepted', accepted_at: '2026-10-01', accepted_service_mode: 'one_time' })).toBe('accepted_one_time');
    expect(outcomeOf({ status: 'viewed', archived_at: '2026-10-01' })).toBe('expired');
    expect(outcomeOf({ status: 'draft' })).toBe('draft');
    expect(outcomeOf({ status: 'sent', expires_at: '2099-01-01' })).toBe('pending');
    const rows = [
      { bedSource: 'lot_based', outcome: 'accepted', bedSqFt: 1800, monthly: 51, treeSource: 'density_estimate', reviewReasons: [], pricedBefore: true },
      { bedSource: 'lot_based', outcome: 'declined', bedSqFt: 1350, monthly: 47, treeSource: 'density_estimate', reviewReasons: ['bed_area_at_or_above_8000'], pricedBefore: true },
      { bedSource: 'explicit', outcome: 'pending', bedSqFt: 600, monthly: 36, treeSource: 'explicit', reviewReasons: [], pricedBefore: false },
      { bedSource: 'explicit', outcome: 'draft', bedSqFt: 500, monthly: 35, treeSource: 'explicit', reviewReasons: [], pricedBefore: false },
    ];
    const s = summarize(rows);
    expect(s.bySource.lot_based).toMatchObject({ quotes: 2, sent: 2, accepted: 1, declined: 1, densityTrees: 2, review: 1 });
    expect(s.bySource.explicit).toMatchObject({ quotes: 2, sent: 1, accepted: 0 });
    expect(median(s.bySource.lot_based.beds)).toBe(1575);
    expect(s.treeSources).toEqual({ density_estimate: 2, explicit: 2 });
    expect(s.regimes).toEqual({ before: 2, after: 2 });
  });
});
