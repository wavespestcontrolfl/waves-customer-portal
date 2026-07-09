const {
  computeTurfArea,
  getLotCategory,
  calculatePropertyProfile,
} = require('../services/pricing-engine/property-calculator');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');

describe('computeTurfArea provenance grading', () => {
  test('measured turf stays HIGH regardless of turfSource', () => {
    const result = computeTurfArea({ measuredTurfSf: 3100, turfSource: 'county_prior' });
    expect(result.turfConfidence).toBe('HIGH');
    expect(result.turfBasis).toBe('measuredTurfSf');
    expect(result.turfFlags).toEqual([]);
  });

  test('vision estimate keeps MEDIUM / estimatedTurfSf with no flags', () => {
    const result = computeTurfArea({ estimatedTurfSf: 4200, turfSource: 'vision' });
    expect(result.turfSf).toBe(4200);
    expect(result.turfConfidence).toBe('MEDIUM');
    expect(result.turfBasis).toBe('estimatedTurfSf');
    expect(result.turfFlags).toEqual([]);
  });

  test('county-prior seed grades LOW / countyPrior with field-verify flag, same sqft', () => {
    const result = computeTurfArea({ estimatedTurfSf: 4050, turfSource: 'county_prior' });
    expect(result.turfSf).toBe(4050);
    expect(result.turfEstimated).toBe(true);
    expect(result.turfConfidence).toBe('LOW');
    expect(result.turfBasis).toBe('countyPrior');
    expect(result.turfFlags).toContain('FIELD_VERIFY_TURF_SQFT');
  });

  test('parcel-clamped vision estimate carries the clamp flag without changing grade', () => {
    const result = computeTurfArea({ estimatedTurfSf: 5200, turfSource: 'vision', turfCappedToParcel: true });
    expect(result.turfSf).toBe(5200);
    expect(result.turfConfidence).toBe('MEDIUM');
    expect(result.turfBasis).toBe('estimatedTurfSf');
    expect(result.turfFlags).toEqual(['TURF_CAPPED_TO_PARCEL']);
  });

  test('county-prior seed that trips the plausible-max cap grades LOW and keeps cap flags', () => {
    const result = computeTurfArea({
      estimatedTurfSf: 5100,
      turfSource: 'county_prior',
      maxEstimatedTurfSf: 5000,
      maxEstimatedTurfSfKnown: true,
    });
    expect(result.turfSf).toBe(5000);
    expect(result.turfConfidence).toBe('LOW');
    expect(result.turfBasis).toBe('plausibleMaxTurfCap');
    expect(result.turfFlags).toEqual(
      expect.arrayContaining(['FIELD_VERIFY_TURF_SQFT', 'TURF_ESTIMATE_EXCEEDS_PLAUSIBLE_MAX'])
    );
  });

  test('lot fallback still grades LOW with field-verify flag', () => {
    const result = computeTurfArea({ lotSqFt: 9000 });
    expect(result.turfConfidence).toBe('LOW');
    expect(result.turfBasis).toBe('lotFallback');
    expect(result.turfFlags).toContain('FIELD_VERIFY_TURF_SQFT');
  });
});

describe('getLotCategory NaN guard', () => {
  test('non-finite lot returns null instead of falling through to ACRE', () => {
    expect(getLotCategory(NaN)).toBe(null);
    expect(getLotCategory(undefined)).toBe(null);
    expect(getLotCategory('not-a-lot')).toBe(null);
  });

  test('numeric behavior is unchanged (0 stays SMALL — commercial gate relies on it)', () => {
    expect(getLotCategory(0)).toBe('SMALL');
    expect(getLotCategory(10889)).toBe('SMALL');
    expect(getLotCategory(10890)).toBe('QUARTER');
    expect(getLotCategory(21780)).toBe('HALF');
    expect(getLotCategory(43560)).toBe('ACRE');
  });
});

describe('calculatePropertyProfile missing-lot semantics', () => {
  test('missing lot yields null lotCategory, UNSET treatable area, explicit ACRE mosquito bucket', () => {
    const profile = calculatePropertyProfile({ homeSqFt: 2000, stories: 1 });
    expect(profile.lotCategory).toBe(null);
    // Not 0: an explicit zero would suppress the ACRE proxy downstream and
    // drop cost math / one-time mosquito to the smallest bucket (codex P2).
    expect(profile.mosquitoTreatableSqFt).toBe(undefined);
    // Fail-expensive direction preserved from the old NaN fall-through —
    // changing this direction is an owner policy call.
    expect(profile.mosquitoLotCategory).toBe('ACRE');
  });

  test('missing-lot mosquito still prices the ACRE bucket off the 43,560 proxy and flags review', () => {
    const estimate = generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      services: { mosquito: { tier: 'monthly12' } },
    });
    const mq = estimate.lineItems.find((item) => item.service === 'mosquito');
    expect(mq.lotCategory).toBe('ACRE');
    expect(mq.annual).toBeGreaterThan(0);
    // The proxy area (not 0) reaches the line item so product-cost math and
    // one-time mosquito keep pricing the full ACRE bucket.
    expect(mq.mosquitoTreatableSqFt).toBe(43560);
    expect(mq.manualReviewReasons).toContain('missing_mosquito_treatable_area');
    expect(estimate.pricingMetadata.manualReviewReasons).toContain('missing_mosquito_treatable_area');
  });

  test('profile carries turf provenance passthrough fields', () => {
    const profile = calculatePropertyProfile({
      homeSqFt: 1800,
      lotSqFt: 9000,
      estimatedTurfSf: 4050,
      turfSource: 'county_prior',
      countyTurfPriorSf: 4050,
      countyTurfCeilingSf: 8100,
    });
    expect(profile.turfSource).toBe('county_prior');
    expect(profile.countyTurfPriorSf).toBe(4050);
    expect(profile.countyTurfCeilingSf).toBe(8100);
    expect(profile.turfCappedToParcel).toBe(false);
  });
});

describe('turf provenance through the translate boundary (P1)', () => {
  const lookupProfile = {
    homeSqFt: 1800,
    stories: 1,
    lotSqFt: 9000,
    estimatedTurfSf: 4050,
    turfSource: 'county_prior',
    countyTurfPriorSf: 4050,
    countyTurfCeilingSf: 8100,
    turfCappedToParcel: false,
  };

  test('translateV2CallToV1Input forwards turf provenance', () => {
    const v1Input = translateV2CallToV1Input(lookupProfile, ['LAWN'], { lawnTrack: 'B' });
    expect(v1Input.turfSource).toBe('county_prior');
    expect(v1Input.countyTurfPriorSf).toBe(4050);
    expect(v1Input.countyTurfCeilingSf).toBe(8100);
    expect(v1Input.turfCappedToParcel).toBe(false);
  });

  test('county-prior seed reaches the engine as LOW/countyPrior with fieldVerify, price unchanged', () => {
    const base = {
      homeSqFt: 1800,
      stories: 1,
      lotSqFt: 9000,
      estimatedTurfSf: 4050,
      services: { lawn: { track: 'st_augustine', tier: 'enhanced' } },
    };
    const withoutProvenance = generateEstimate(base);
    const withProvenance = generateEstimate({
      ...base,
      turfSource: 'county_prior',
      countyTurfPriorSf: 4050,
      countyTurfCeilingSf: 8100,
    });

    // Same dollars — provenance is metadata only.
    expect(withProvenance.summary).toEqual(withoutProvenance.summary);
    const lawnBefore = withoutProvenance.lineItems.find((i) => i.service === 'lawn_care');
    const lawnAfter = withProvenance.lineItems.find((i) => i.service === 'lawn_care');
    expect(lawnAfter.annual).toBe(lawnBefore.annual);
    expect(lawnAfter.lawnSqFt).toBe(lawnBefore.lawnSqFt);

    // Grading + flags now reflect the seed.
    expect(withProvenance.property.turfConfidence).toBe('LOW');
    expect(withProvenance.property.turfBasis).toBe('countyPrior');
    expect(withProvenance.property.turfSource).toBe('county_prior');
    expect(withProvenance.fieldVerify).toContain('FIELD_VERIFY_TURF_SQFT');
    expect(withoutProvenance.fieldVerify).not.toContain('FIELD_VERIFY_TURF_SQFT');

    // Legacy mapper surfaces the downgraded confidence for the admin builder.
    const mapped = mapV1ToLegacyShape(withProvenance);
    expect(mapped.results.lawnMeta.turfConfidence).toBe('LOW');
    expect(mapped.results.lawnMeta.turfBasis).toBe('countyPrior');
  });
});

describe('per-line review hoisting (P4) and stories flag (P9)', () => {
  test('pest missing-footprint review reason is hoisted to pricingMetadata', () => {
    const estimate = generateEstimate({
      lotSqFt: 9000,
      services: { pest: { frequency: 'quarterly' } },
    });
    const pest = estimate.lineItems.find((i) => i.service === 'pest_control');
    expect(pest.manualReviewReasons).toContain('invalid_or_zero_pest_footprint');
    expect(estimate.pricingMetadata.manualReviewReasons).toContain('invalid_or_zero_pest_footprint');
  });

  test('termite bait flags stories_estimated when perimeter is computed off a defaulted stories count', () => {
    const estimate = generateEstimate({
      homeSqFt: 3000,
      storiesSource: 'default',
      lotSqFt: 9000,
      services: { termiteBait: { system: 'advance', monitoringTier: 'basic' } },
    });
    const bait = estimate.lineItems.find((i) => i.service === 'termite_bait');
    expect(bait.perimeterSource).toBe('computed_from_footprint');
    expect(bait.manualReviewReasons).toContain('stories_estimated');
    // Metadata-only: requiresManualReview stays false on a priced line —
    // estimate-converter drops recurring lines flagged requiresManualReview,
    // which would silently omit the priced termite program (codex P1).
    expect(bait.requiresManualReview).toBe(false);
    expect(bait.annual).toBeGreaterThan(0);
    expect(estimate.pricingMetadata.manualReviewReasons).toContain('stories_estimated');
  });

  test('termite bait does NOT flag stories when perimeter was measured or stories are known', () => {
    const measured = generateEstimate({
      homeSqFt: 3000,
      storiesSource: 'default',
      lotSqFt: 9000,
      perimeterLF: 220,
      services: { termiteBait: { system: 'advance', monitoringTier: 'basic' } },
    });
    const measuredBait = measured.lineItems.find((i) => i.service === 'termite_bait');
    expect(measuredBait.manualReviewReasons).not.toContain('stories_estimated');

    const knownStories = generateEstimate({
      homeSqFt: 3000,
      stories: 2,
      storiesSource: 'ai',
      lotSqFt: 9000,
      services: { termiteBait: { system: 'advance', monitoringTier: 'basic' } },
    });
    const knownBait = knownStories.lineItems.find((i) => i.service === 'termite_bait');
    expect(knownBait.manualReviewReasons).not.toContain('stories_estimated');
  });
});

describe('v1-legacy-mapper T&S bed-area badge (#12b)', () => {
  test('lot-based bed area marks bedAreaIsEstimated true', () => {
    const estimate = generateEstimate({
      homeSqFt: 2000,
      lotSqFt: 12000,
      shrubDensity: 'moderate',
      services: { treeShrub: {} },
    });
    const ts = estimate.lineItems.find((i) => i.service === 'tree_shrub');
    expect(['lot_based', 'estimated', 'fallback']).toContain(ts.bedAreaSource);
    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.results.tsMeta.bedAreaIsEstimated).toBe(true);
  });

  test('explicit bed area keeps bedAreaIsEstimated false', () => {
    const estimate = generateEstimate({
      homeSqFt: 2000,
      lotSqFt: 12000,
      bedArea: 1500,
      services: { treeShrub: {} },
    });
    const ts = estimate.lineItems.find((i) => i.service === 'tree_shrub');
    expect(ts.bedAreaSource).toBe('explicit');
    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.results.tsMeta.bedAreaIsEstimated).toBe(false);
  });
});
