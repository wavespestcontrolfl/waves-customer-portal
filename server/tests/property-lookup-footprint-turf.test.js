/**
 * Building-footprint turf subtraction (SHADOW).
 *
 * footprintTurfSf = lot − ground-floor building footprint (living area /
 * stories) − assessed impervious improvements from the county
 * extra-features roll. Attached to the enriched profile for comparison
 * against the vision estimate; NOT a pricing input — these tests pin that
 * estimatedTurfSf is untouched and the new fields ride alongside.
 *
 * Impervious classification semantics come from Manatee's own roll (live
 * probe 2026-06-12): pool/spa/pool-deck rows are flagged Impervious YES,
 * the screen CAGE is NO (mesh doesn't seal the ground; the deck beneath is
 * its own YES row). The keyword fallback for Sarasota/Charlotte mirrors
 * exactly that.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const logger = require('../services/logger');
const { _private: aiPrivate } = require('../services/property-lookup/ai-property-lookup');
const { _private: routePrivate } = require('../routes/property-lookup-v2');

const { imperviousFactsFromFeatures } = aiPrivate;
const { computeFootprintTurf } = routePrivate;

beforeEach(() => jest.clearAllMocks());

describe('imperviousFactsFromFeatures', () => {
  test('Manatee flag is authoritative: YES rows sum, the NO-flagged cage does not', () => {
    // Mirrors the live Manatee fixture: cage 1066 NO, pool 288 YES,
    // spa 1 YES, pool deck 729 YES.
    const facts = imperviousFactsFromFeatures([
      { description: 'CAGE 1 STORY', sqft: '1,066', impervious: 'NO' },
      { description: 'RESIDENTIAL POOL', sqft: '288', impervious: 'YES' },
      { description: 'SPA-ATTACHED', sqft: '1', impervious: 'YES' },
      { description: 'POOL DECK GOOD', sqft: '729', impervious: 'YES' },
    ]);
    expect(facts).toEqual({ imperviousAreaSf: 288 + 1 + 729 });
  });

  test('flag beats keywords both directions', () => {
    const facts = imperviousFactsFromFeatures([
      // Keyword would count it; county says NO → not counted.
      { description: 'PATIO', sqft: '500', impervious: 'NO' },
      // Keyword would NOT match; county says YES → counted.
      { description: 'UTILITY BUILDING', sqft: '120', impervious: 'YES' },
    ]);
    expect(facts).toEqual({ imperviousAreaSf: 120 });
  });

  test('keyword fallback (no flag): pool + patio count, enclosure/cage and walls do not', () => {
    // Mirrors the live Sarasota fixture rows.
    const facts = imperviousFactsFromFeatures([
      { description: 'Screened Enclosure', sqft: '1066' },
      { description: 'Patio - concrete or Pavers', sqft: '674' },
      { description: 'Swimming Pool', sqft: '392' },
      { description: 'Privacy Wall Residential', sqft: '55' },
    ]);
    expect(facts).toEqual({ imperviousAreaSf: 674 + 392 });
  });

  test('Charlotte-style rows: pool + porch/deck count, screen cage does not', () => {
    const facts = imperviousFactsFromFeatures([
      { description: 'Pool - Gunite (sq. Ft.)', sqft: '392' },
      { description: 'Screen Cage, 8 - Aluminum Frame - 3 Walls (sq. Ft.)', sqft: '840' },
      { description: 'Porch/Deck', sqft: '120' },
    ]);
    expect(facts).toEqual({ imperviousAreaSf: 392 + 120 });
  });

  test('equipment never counts: pool heater excluded', () => {
    const facts = imperviousFactsFromFeatures([
      { description: 'POOL HEATER', sqft: '12' },
      { description: 'BOAT DOCK', sqft: '400' },
    ]);
    expect(facts).toEqual({ imperviousAreaSf: 0 });
  });

  test('parsed table with zero impervious rows is a meaningful 0', () => {
    expect(imperviousFactsFromFeatures([
      { description: 'FENCE - CHAIN LINK', sqft: '200' },
    ])).toEqual({ imperviousAreaSf: 0 });
  });

  test('non-array input returns {} (table never parsed → null on the record)', () => {
    expect(imperviousFactsFromFeatures(null)).toEqual({});
    expect(imperviousFactsFromFeatures(undefined)).toEqual({});
  });

  test('rows without usable sqft are skipped', () => {
    expect(imperviousFactsFromFeatures([
      { description: 'RESIDENTIAL POOL', sqft: null },
      { description: 'PATIO', sqft: '0' },
    ])).toEqual({ imperviousAreaSf: 0 });
  });
});

describe('computeFootprintTurf', () => {
  test('lot minus footprint minus impervious', () => {
    const result = computeFootprintTurf({
      lotSize: 10000,
      squareFootage: 2400,
      stories: 2,
      imperviousAreaSf: 800,
    });
    expect(result).toEqual({
      turfSf: 10000 - 1200 - 800,
      parts: { lotSqFt: 10000, footprintSf: 1200, imperviousSf: 800, imperviousKnown: true },
    });
  });

  test('stories defaults to 1 (single-story footprint = living area)', () => {
    const result = computeFootprintTurf({ lotSize: 8000, squareFootage: 1500, imperviousAreaSf: 0 });
    expect(result.parts.footprintSf).toBe(1500);
    expect(result.turfSf).toBe(6500);
  });

  test('unknown impervious (roll not parsed) is treated as 0 and flagged', () => {
    const result = computeFootprintTurf({ lotSize: 8000, squareFootage: 1500, stories: 1 });
    expect(result.turfSf).toBe(6500);
    expect(result.parts.imperviousKnown).toBe(false);
    expect(result.parts.imperviousSf).toBe(0);
  });

  test('missing lot or building size yields null — no fabricated estimate', () => {
    expect(computeFootprintTurf({ lotSize: 0, squareFootage: 1500 })).toBeNull();
    expect(computeFootprintTurf({ lotSize: 8000, squareFootage: 0 })).toBeNull();
    expect(computeFootprintTurf(null)).toBeNull();
  });

  test('floors at 0 when improvements exceed the lot (complex-parcel style rows)', () => {
    const result = computeFootprintTurf({
      lotSize: 2000,
      squareFootage: 2400,
      stories: 1,
      imperviousAreaSf: 500,
    });
    expect(result.turfSf).toBe(0);
  });
});

describe('county turf prior (vision-missing seed)', () => {
  const { buildEnrichedProfile } = require('../routes/property-lookup-v2');

  // County-complete residential record: ceiling = 10000 − 1200 − 800 = 8000.
  function countyRecord(overrides = {}) {
    return {
      propertyType: 'Single Family',
      lotSize: 10000,
      squareFootage: 2400,
      stories: 2,
      imperviousAreaSf: 800,
      ...overrides,
    };
  }

  afterEach(() => { delete process.env.TURF_COUNTY_PRIOR_DISABLED; });

  test('vision missing → seeds 50% of the county ceiling, flagged for verification', () => {
    const profile = buildEnrichedProfile(countyRecord(), null, 27.4, -82.4);
    expect(profile.footprintTurfSf).toBe(8000);
    expect(profile.estimatedTurfSf).toBe(4000);
    expect(profile.turfSource).toBe('county_prior');
    expect(profile.countyTurfPriorSf).toBe(4000);
    expect(profile.fieldVerifyFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'estimatedTurfSf',
        priority: 'HIGH',
        reason: expect.stringContaining('seeded 4,000 sq ft from county records'),
      }),
    ]));
    // The shadow series stays vision-only — a prior seed must not compare
    // the ceiling with itself.
    expect(logger.info).not.toHaveBeenCalledWith('[turf-footprint] shadow comparison', expect.anything());
  });

  test('vision present → vision wins untouched, no prior, shadow log fires', () => {
    const profile = buildEnrichedProfile(countyRecord(), { estimatedTurfSf: 5200, confidenceScore: 80 }, 27.4, -82.4);
    expect(profile.estimatedTurfSf).toBe(5200);
    expect(profile.turfSource).toBe('vision');
    expect(profile.countyTurfPriorSf).toBeNull();
    expect(logger.info).toHaveBeenCalledWith('[turf-footprint] shadow comparison', expect.objectContaining({
      estimatedTurfSf: 5200,
      footprintTurfSf: 8000,
    }));
  });

  test('kill switch TURF_COUNTY_PRIOR_DISABLED=1 → no seed', () => {
    process.env.TURF_COUNTY_PRIOR_DISABLED = '1';
    const profile = buildEnrichedProfile(countyRecord(), null, 27.4, -82.4);
    expect(profile.estimatedTurfSf).toBe(0);
    expect(profile.turfSource).toBe('none');
    expect(profile.countyTurfPriorSf).toBeNull();
  });

  test('shared-turf types never seed from their own parcel', () => {
    const profile = buildEnrichedProfile(countyRecord({ propertyType: 'Townhome' }), null, 27.4, -82.4);
    expect(profile.countyTurfPriorSf).toBeNull();
    expect(profile.estimatedTurfSf).toBe(0);
  });

  test('a sub-minimum ceiling (tiny/implausible yard) never seeds', () => {
    // ceiling = 3000 − 2400 − 400 = 200 < 500 floor
    const profile = buildEnrichedProfile(
      countyRecord({ lotSize: 3000, squareFootage: 2400, stories: 1, imperviousAreaSf: 400 }),
      null, 27.4, -82.4,
    );
    expect(profile.countyTurfPriorSf).toBeNull();
    expect(profile.estimatedTurfSf).toBe(0);
  });

  test('no county facts (record-less lookup) → no seed', () => {
    const profile = buildEnrichedProfile(null, null, 27.4, -82.4);
    expect(profile.countyTurfPriorSf).toBeNull();
    expect(profile.estimatedTurfSf).toBe(0);
    expect(profile.turfSource).toBe('none');
  });

  test('an EXPLICIT vision 0 (measured no-lawn property) is never overwritten (codex P2)', () => {
    const profile = buildEnrichedProfile(countyRecord(), { estimatedTurfSf: 0, confidenceScore: 85 }, 27.4, -82.4);
    expect(profile.estimatedTurfSf).toBe(0);
    expect(profile.turfSource).toBe('vision');
    expect(profile.countyTurfPriorSf).toBeNull();
  });

  test('unparsed extra-features roll (imperviousKnown=false) → no seed (codex P2)', () => {
    const profile = buildEnrichedProfile(countyRecord({ imperviousAreaSf: undefined }), null, 27.4, -82.4);
    expect(profile.footprintTurfParts?.imperviousKnown).toBe(false);
    expect(profile.countyTurfPriorSf).toBeNull();
    expect(profile.estimatedTurfSf).toBe(0);
  });

  test('missing story count (footprint unreliable) → no seed (codex P2)', () => {
    const profile = buildEnrichedProfile(countyRecord({ stories: null }), null, 27.4, -82.4);
    expect(profile.countyTurfPriorSf).toBeNull();
    expect(profile.estimatedTurfSf).toBe(0);
  });
});

describe('shadow wiring (no pricing impact)', () => {
  // computeTurfArea is the engine's only turf reader — pin that it ignores
  // footprintTurfSf so the shadow field can never move a price.
  const { computeTurfArea } = require('../services/pricing-engine/property-calculator');

  test('pricing turf is identical with and without the shadow fields', () => {
    const base = { estimatedTurfSf: 6200, lotSqFt: 10000, homeSqFt: 2400 };
    const withShadow = {
      ...base,
      footprintTurfSf: 3000,
      footprintTurfParts: { lotSqFt: 10000, footprintSf: 2400, imperviousSf: 800, imperviousKnown: true },
    };
    expect(computeTurfArea(withShadow)).toEqual(computeTurfArea(base));
  });
});
