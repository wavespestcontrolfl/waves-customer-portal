// ops/agents/tree-shrub-estimates-report.js — the pure half (payload
// extraction + roll-up). The script is the owner's evidence for the
// 2026-10-21 "quotes read high" audit, so the three stored payload shapes it
// claims to read must each resolve, and a stale raw line must lose to the
// mapped envelope exactly as estimate-actuals does.
const path = require('path');
const { extractTreeShrub, outcomeOf, regimeOf, summarize, median, isRealCalendarDate } = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'tree-shrub-estimates-report.js'));

describe('tree-shrub-estimates-report extraction', () => {
  test('raw engine line that agrees with the mapped envelope carries the full source enums', () => {
    const data = {
      engineResult: { lineItems: [{ service: 'tree_shrub', bedAreaUsed: 1800, bedAreaSource: 'lot_based', treeCount: 6, treeCountSource: 'density_estimate', monthly: 51.44, tier: 'standard', manualReviewReasons: [] }] },
      result: { results: { tsMeta: { eb: 1800, et: 6, bedAreaIsEstimated: true }, ts: [{ tier: 'standard', mo: 51.44, selected: true }] } },
    };
    expect(extractTreeShrub(data)).toMatchObject({ shape: 'raw', bedSqFt: 1800, bedSource: 'lot_based', treeCount: 6, treeSource: 'density_estimate', monthly: 51.44, tier: 'standard' });
  });

  test('a tier-only revision keeps the raw line (bed/trees agree) but takes the MAPPED tier and price (Codex #6398)', () => {
    const data = {
      engineResult: { lineItems: [{ service: 'tree_shrub', bedAreaUsed: 1800, bedAreaSource: 'lot_based', treeCount: 6, treeCountSource: 'density_estimate', monthly: 51.44, tier: 'standard', pricingKnobs: { marginTarget: 0.45 } }] },
      result: { results: { tsMeta: { eb: 1800, et: 6, bedAreaIsEstimated: true }, ts: [{ tier: 'enhanced', mo: 68.5, selected: true }] } },
    };
    const ts = extractTreeShrub(data);
    expect(ts).toMatchObject({ shape: 'raw', bedSource: 'lot_based', treeSource: 'density_estimate', tier: 'enhanced', monthly: 68.5, marginTarget: 0.45 });
    expect(regimeOf(ts)).toBe('before_2026_10_21');
    // The mapped revision's stamp and provenance win over the retained raw
    // line (Codex #6398 r3): a revision that typed the same count the table
    // inferred, under the repriced engine, is an explicit / after quote.
    const revised = extractTreeShrub({
      ...data,
      result: { results: { tsMeta: { eb: 1800, et: 6, bedAreaIsEstimated: true, treeCountSource: 'explicit', pricingKnobs: { marginTarget: 0.40, lotBedBasis: 'open_parcel' } }, ts: [{ tier: 'enhanced', mo: 68.5, selected: true }] } },
    });
    expect(revised).toMatchObject({ shape: 'raw', treeSource: 'explicit', marginTarget: 0.40, lotBedBasis: 'open_parcel' });
    expect(regimeOf(revised)).toBe('after_2026_10_21');
  });

  test('the regime is the open-parcel stamp, never the margin value (Codex #6398 r4)', () => {
    // An admin-tuned global_margin_target_ts survives 20261021010000, so a
    // fresh quote can stamp 0.42 and a replayed legacy line 0.35.
    expect(regimeOf({ marginTarget: 0.42, lotBedBasis: 'open_parcel' })).toBe('after_2026_10_21');
    expect(regimeOf({ marginTarget: 0.35, lotBedBasis: 'gross_lot' })).toBe('before_2026_10_21');
    expect(regimeOf({ marginTarget: 0.40, lotBedBasis: null })).toBe('before_2026_10_21');
    expect(regimeOf({ marginTarget: null, lotBedBasis: undefined })).toBe('before_2026_10_21');
  });

  test('a mapped-only envelope reports the review flags mapV1ToLegacyShape put on the recurring row (Codex #6398 r4)', () => {
    const mappedOnly = {
      result: {
        results: { tsMeta: { eb: 2400, et: 4, bedAreaIsEstimated: true, pricingKnobs: { marginTarget: 0.40, lotBedBasis: 'open_parcel' } }, ts: [{ tier: 'standard', mo: 58.1, selected: true }] },
        recurring: { services: [
          { service: 'lawn_care', manualReviewReasons: ['oversize_lawn'] },
          { service: 'tree_shrub', manualReviewReasons: ['open_parcel_basis_footprint_over_half_lot'] },
        ] },
      },
    };
    expect(extractTreeShrub(mappedOnly)).toMatchObject({ shape: 'mapped', bedSource: 'inferred', reviewReasons: ['open_parcel_basis_footprint_over_half_lot'], lotBedBasis: 'open_parcel' });
    // With a retained raw line the mapped row's reasons still win (a revision
    // can clear or add a flag without touching bed/trees).
    const withRaw = {
      ...mappedOnly,
      engineResult: { lineItems: [{ service: 'tree_shrub', bedAreaUsed: 2400, bedAreaSource: 'lot_based', treeCount: 4, monthly: 58.1, manualReviewReasons: [] }] },
    };
    expect(extractTreeShrub(withRaw)).toMatchObject({ shape: 'raw', reviewReasons: ['open_parcel_basis_footprint_over_half_lot'] });
    // No recurring row at all: the raw line's own reasons stand.
    expect(extractTreeShrub({ engineResult: withRaw.engineResult, result: { results: mappedOnly.result.results } }).reviewReasons).toEqual([]);
  });

  test('a stale raw line (revision replaced the mapped result) loses to the mapped envelope, which reports the coarse source', () => {
    const data = {
      engineResult: { lineItems: [{ service: 'tree_shrub', bedAreaUsed: 1800, bedAreaSource: 'lot_based', treeCount: 6, monthly: 51.44 }] },
      result: { results: { tsMeta: { eb: 900, et: 2, bedAreaIsEstimated: false }, ts: [{ tier: 'standard', mo: 38.5, selected: true }] } },
    };
    expect(extractTreeShrub(data)).toMatchObject({ shape: 'mapped', bedSqFt: 900, bedSource: 'measured', treeCount: 2, treeSource: 'unknown', monthly: 38.5 });
  });

  test('a current mapped envelope with NO T&S row is authoritative over a stale raw line (Codex #6398 r13)', () => {
    const raw = { engineResult: { lineItems: [{ service: 'tree_shrub', bedAreaUsed: 1800, bedAreaSource: 'lot_based', treeCount: 6, monthly: 51.44 }] } };
    // Revision removed T&S: the mapped envelope prices lawn only.
    expect(extractTreeShrub({ ...raw, result: { results: { lawnMeta: {} }, recurring: { services: [{ service: 'lawn_care' }] }, lineItems: [{ service: 'lawn_care', monthly: 60 }] } })).toBeNull();
    expect(extractTreeShrub({ ...raw, result: { lineItems: [{ service: 'pest_control', monthly: 45 }] } })).toBeNull();
    // No mapped envelope at all: the raw line still stands.
    expect(extractTreeShrub(raw)).toMatchObject({ shape: 'raw', bedSqFt: 1800 });
    expect(extractTreeShrub({ ...raw, result: {} })).toMatchObject({ shape: 'raw', bedSqFt: 1800 });
  });

  test('commercial Tree & Shrub lines are part of the audit — raw, mapped recurring row, or both (Codex #6398 r14)', () => {
    const raw = { engineResult: { lineItems: [{ service: 'commercial_tree_shrub', bedArea: 4680, bedAreaSource: 'lot_based', treeCount: 4, monthly: 112.5, manualReviewReasons: [], pricingKnobs: { lotBedBasis: 'open_parcel' } }] } };
    expect(extractTreeShrub(raw)).toMatchObject({ shape: 'raw', service: 'commercial_tree_shrub', bedSqFt: 4680, bedSource: 'lot_based', treeCount: 4, monthly: 112.5, lotBedBasis: 'open_parcel' });
    // Admin V2 keeps only the mapped recurring row: price + review flags.
    const mappedOnly = { result: { recurring: { services: [{ service: 'commercial_tree_shrub', mo: 112.5, monthly: 112.5, manualReviewReasons: ['open_parcel_basis_footprint_over_half_lot'], pricingKnobs: { lotBedBasis: 'open_parcel' } }] } } };
    // An ordinary UNFLAGGED mapped row carries no manualReviewReasons at all
    // and is still the T&S evidence (Codex #6398 r17).
    const unflagged = { result: { recurring: { services: [{ service: 'commercial_tree_shrub', mo: 112.5, monthly: 112.5, pricingKnobs: { lotBedBasis: 'open_parcel' } }] } } };
    expect(extractTreeShrub(unflagged)).toMatchObject({ shape: 'compact', service: 'commercial_tree_shrub', monthly: 112.5, reviewReasons: [] });
    expect(extractTreeShrub(mappedOnly)).toMatchObject({ shape: 'compact', service: 'commercial_tree_shrub', monthly: 112.5, bedSqFt: null, reviewReasons: ['open_parcel_basis_footprint_over_half_lot'], lotBedBasis: 'open_parcel' });
    expect(regimeOf(extractTreeShrub(mappedOnly))).toBe('after_2026_10_21');
    // Raw agrees with the mapped row on price → raw inputs, mapped flags.
    expect(extractTreeShrub({ ...raw, ...mappedOnly })).toMatchObject({ shape: 'raw', service: 'commercial_tree_shrub', bedSqFt: 4680, reviewReasons: ['open_parcel_basis_footprint_over_half_lot'] });
    // A repriced mapped row (different price) makes the raw line stale.
    const repriced = { result: { recurring: { services: [{ service: 'commercial_tree_shrub', mo: 98, monthly: 98, manualReviewReasons: [] }] } } };
    expect(extractTreeShrub({ ...raw, ...repriced })).toMatchObject({ shape: 'compact', service: 'commercial_tree_shrub', monthly: 98 });
    // The residential shapes still report service 'tree_shrub' and the roll-up counts both programs.
    const residential = extractTreeShrub({ engineResult: { lineItems: [{ service: 'tree_shrub', bedAreaUsed: 2400, bedAreaSource: 'lot_based', treeCount: 4, monthly: 58.1 }] } });
    expect(residential.service).toBe('tree_shrub');
    const base = { outcome: 'pending', regime: 'after_2026_10_21', reviewReasons: [], treeSource: 'unknown' };
    expect(summarize([{ ...base, ...residential }, { ...base, ...extractTreeShrub(raw) }]).byService).toEqual({ tree_shrub: 1, commercial_tree_shrub: 1 });
  });

  test('a compact quote-wizard line reports price only, never a fabricated zero', () => {
    const data = { result: { lineItems: [{ service: 'tree_shrub', monthly: 35, tier: 'standard' }] } };
    expect(extractTreeShrub(data)).toMatchObject({ shape: 'compact', bedSqFt: null, bedSource: 'unknown', treeCount: null, monthly: 35 });
    expect(extractTreeShrub({ result: { lineItems: [{ service: 'lawn_care', monthly: 60 }] } })).toBeNull();
  });

  test('--since accepts only real calendar dates (Codex #6398 r5)', () => {
    expect(isRealCalendarDate('2026-02-28')).toBe(true);
    expect(isRealCalendarDate('2028-02-29')).toBe(true);
    // Date.parse would normalize these to March 3 / March 2 and silently drop days.
    expect(isRealCalendarDate('2026-02-31')).toBe(false);
    expect(isRealCalendarDate('2026-02-29')).toBe(false);
    expect(isRealCalendarDate('2026-13-01')).toBe(false);
    expect(isRealCalendarDate('2026-1-01')).toBe(false);
    expect(isRealCalendarDate(undefined)).toBe(false);
  });

  test('outcome and roll-up', () => {
    expect(outcomeOf({ status: 'sent', accepted_at: '2026-10-01' })).toBe('accepted');
    expect(outcomeOf({ status: 'accepted', accepted_at: '2026-10-01', accepted_service_mode: 'one_time' })).toBe('accepted_one_time');
    expect(outcomeOf({ status: 'viewed', archived_at: '2026-10-01', sent_at: '2026-09-01' })).toBe('expired');
    // A never-sent internal draft that aged out is NOT a sent quote (Codex #6398 r7).
    expect(outcomeOf({ status: 'expired', disposition: 'expired_unsent', sent_at: '2026-09-01' })).toBe('expired_unsent');
    expect(outcomeOf({ status: 'expired', disposition: null, sent_at: null })).toBe('expired_unsent');
    expect(outcomeOf({ status: 'expired', disposition: 'expired_unviewed', sent_at: '2026-09-01' })).toBe('expired');
    expect(outcomeOf({ status: 'viewed', archived_at: '2026-10-01', sent_at: null, disposition: null })).toBe('expired_unsent');
    expect(outcomeOf({ status: 'draft' })).toBe('draft');
    expect(outcomeOf({ status: 'sent', expires_at: '2099-01-01' })).toBe('pending');
    const rows = [
      { bedSource: 'lot_based', outcome: 'accepted', bedSqFt: 1800, monthly: 51, treeSource: 'density_estimate', reviewReasons: [], regime: 'before_2026_10_21' },
      { bedSource: 'lot_based', outcome: 'declined', bedSqFt: 1350, monthly: 47, treeSource: 'density_estimate', reviewReasons: ['bed_area_at_or_above_8000'], regime: 'before_2026_10_21' },
      { bedSource: 'explicit', outcome: 'pending', bedSqFt: 600, monthly: 36, treeSource: 'explicit', reviewReasons: [], regime: 'after_2026_10_21' },
      { bedSource: 'explicit', outcome: 'draft', bedSqFt: 500, monthly: 35, treeSource: 'explicit', reviewReasons: [], regime: 'after_2026_10_21' },
      { bedSource: 'lot_based', outcome: 'expired_unsent', bedSqFt: 2000, monthly: 55, treeSource: 'density_estimate', reviewReasons: [], regime: 'before_2026_10_21' },
      // A one-time acceptance is a conversion too (Codex #6398 r15).
      { bedSource: 'explicit', outcome: 'accepted_one_time', bedSqFt: 700, monthly: 38, treeSource: 'explicit', reviewReasons: [], regime: 'after_2026_10_21' },
    ];
    const s = summarize(rows);
    // The never-sent expiration counts as a quote, never as sent.
    expect(s.bySource.lot_based).toMatchObject({ quotes: 3, sent: 2, accepted: 1, declined: 1, densityTrees: 3, review: 1 });
    expect(s.bySource.explicit).toMatchObject({ quotes: 3, sent: 2, accepted: 1 });
    expect(median(s.bySource.lot_based.beds)).toBe(1800);
    expect(s.treeSources).toEqual({ density_estimate: 3, explicit: 3 });
    expect(s.regimes).toEqual({ before: 3, after: 3 });
  });
});
