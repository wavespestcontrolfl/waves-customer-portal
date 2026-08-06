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
    expect(facts).toEqual({ imperviousAreaSf: 288 + 1 + 729, poolImperviousSf: 288 + 1 + 729 });
  });

  test('flag beats keywords both directions', () => {
    const facts = imperviousFactsFromFeatures([
      // Keyword would count it; county says NO → not counted.
      { description: 'PATIO', sqft: '500', impervious: 'NO' },
      // Keyword would NOT match; county says YES → counted.
      { description: 'UTILITY BUILDING', sqft: '120', impervious: 'YES' },
    ]);
    expect(facts).toEqual({ imperviousAreaSf: 120, poolImperviousSf: 0 });
  });

  test('keyword fallback (no flag): pool + patio count, enclosure/cage and walls do not', () => {
    // Mirrors the live Sarasota fixture rows.
    const facts = imperviousFactsFromFeatures([
      { description: 'Screened Enclosure', sqft: '1066' },
      { description: 'Patio - concrete or Pavers', sqft: '674' },
      { description: 'Swimming Pool', sqft: '392' },
      { description: 'Privacy Wall Residential', sqft: '55' },
    ]);
    expect(facts).toEqual({ imperviousAreaSf: 674 + 392, poolImperviousSf: 674 + 392 });
  });

  test('Charlotte-style rows: pool + porch/deck count, screen cage does not', () => {
    const facts = imperviousFactsFromFeatures([
      { description: 'Pool - Gunite (sq. Ft.)', sqft: '392' },
      { description: 'Screen Cage, 8 - Aluminum Frame - 3 Walls (sq. Ft.)', sqft: '840' },
      { description: 'Porch/Deck', sqft: '120' },
    ]);
    expect(facts).toEqual({ imperviousAreaSf: 392 + 120, poolImperviousSf: 392 + 120 });
  });

  test('equipment never counts: pool heater excluded', () => {
    const facts = imperviousFactsFromFeatures([
      { description: 'POOL HEATER', sqft: '12' },
      { description: 'BOAT DOCK', sqft: '400' },
    ]);
    expect(facts).toEqual({ imperviousAreaSf: 0, poolImperviousSf: 0 });
  });

  test('parsed table with zero impervious rows is a meaningful 0', () => {
    expect(imperviousFactsFromFeatures([
      { description: 'FENCE - CHAIN LINK', sqft: '200' },
    ])).toEqual({ imperviousAreaSf: 0, poolImperviousSf: 0 });
  });

  test('non-array input returns {} (table never parsed → null on the record)', () => {
    expect(imperviousFactsFromFeatures(null)).toEqual({});
    expect(imperviousFactsFromFeatures(undefined)).toEqual({});
  });

  test('rows without usable sqft are skipped', () => {
    expect(imperviousFactsFromFeatures([
      { description: 'RESIDENTIAL POOL', sqft: null },
      { description: 'PATIO', sqft: '0' },
    ])).toEqual({ imperviousAreaSf: 0, poolImperviousSf: 0 });
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
      parts: {
        lotSqFt: 10000,
        footprintSf: 1200,
        footprintBasis: 'living_area',
        stories: 2,
        imperviousSf: 800,
        imperviousKnown: true,
        enclosureNetSf: 0,
      },
    });
  });

  test('gross-under-roof building rows beat living/stories, cage nets against pool-family (2026-08-05 audit shape)', () => {
    // Bolton-class parcel: living 2,085 said footprint 2,085 while the
    // roll's under-roof said 2,771; cage 1,066 wraps pool-family 1,018.
    const result = computeFootprintTurf({
      lotSize: 7523,
      squareFootage: 2085,
      stories: 1,
      imperviousAreaSf: 1018,
      poolCageSqft: 1066,
      poolImperviousSf: 1018,
      _buildings: [{ livingAreaSqft: 2085, underRoofSqft: 2771, stories: 1 }],
    });
    expect(result.parts.footprintSf).toBe(2771);
    expect(result.parts.footprintBasis).toBe('gross_under_roof');
    expect(result.parts.enclosureNetSf).toBe(48);
    expect(result.turfSf).toBe(7523 - 2771 - 1018 - 48);
  });

  test('each building divides its gross by its own story count (Sarasota Gross Area shape)', () => {
    const result = computeFootprintTurf({
      lotSize: 10000,
      squareFootage: 3239,
      stories: 2,
      imperviousAreaSf: 0,
      _buildings: [{ livingAreaSqft: 3239, grossAreaSqft: 3945, stories: 2 }],
    });
    // max(living/stories = 1,620, gross/stories = 1,973)
    expect(result.parts.footprintSf).toBe(1973);
    expect(result.parts.footprintBasis).toBe('gross_under_roof');
  });

  test('Charlotte Total Area shape is recognized', () => {
    const result = computeFootprintTurf({
      lotSize: 9000,
      squareFootage: 1800,
      stories: 1,
      imperviousAreaSf: 0,
      _buildings: [{ acAreaSqft: 1800, totalAreaSqft: 2350, stories: 1 }],
    });
    expect(result.parts.footprintSf).toBe(2350);
    expect(result.parts.footprintBasis).toBe('gross_under_roof');
  });

  test('a gross row without its OWN story count falls back whole-record (codex #3229 P2)', () => {
    // A 1-story accessory next to a 2-story primary must not inherit the
    // record-level count (halves its footprint) nor default to 1 (doubles
    // a story-less primary's).
    const result = computeFootprintTurf({
      lotSize: 20000,
      squareFootage: 4000,
      stories: 2,
      imperviousAreaSf: 0,
      _buildings: [
        { livingAreaSqft: 4000, underRoofSqft: 4800, stories: 2 },
        { underRoofSqft: 500 },
      ],
    });
    expect(result.parts.footprintBasis).toBe('living_area');
    expect(result.parts.footprintSf).toBe(2000);
  });

  test('an at-cap lot rejects the gross basis — capped lot never meets uncapped gross (codex r3)', () => {
    // Commercial parsers cap lotSize at 200k while building gross rides
    // uncapped: a campus footprint above the "lot" would emit a trusted
    // ZERO ceiling and clamp real turf to nothing.
    const result = computeFootprintTurf({
      lotSize: 200000,
      squareFootage: 120000,
      stories: 1,
      imperviousAreaSf: 0,
      _buildings: [{ underRoofSqft: 250000, stories: 1 }],
    });
    expect(result.parts.footprintBasis).toBe('living_area');
    expect(result.parts.footprintSf).toBe(120000);
  });

  test('a gross footprint at/above the lot (impossible geometry) rejects the gross basis (codex r3)', () => {
    const result = computeFootprintTurf({
      lotSize: 5000,
      squareFootage: 1500,
      stories: 1,
      imperviousAreaSf: 0,
      _buildings: [{ underRoofSqft: 6000, stories: 1 }],
    });
    expect(result.parts.footprintBasis).toBe('living_area');
    expect(result.parts.footprintSf).toBe(1500);
  });

  test('a tech-verified story correction stands the gross basis down (codex r3)', () => {
    // applyVerifiedOverrides updates record.stories but not the preserved
    // _buildings rows — gross/staleStories would inflate the footprint, so
    // living / verified-stories governs instead.
    const result = computeFootprintTurf({
      lotSize: 10000,
      squareFootage: 3200,
      stories: 1, // tech-corrected from the county's 2
      imperviousAreaSf: 0,
      _fieldEvidence: {
        stories: { sourceType: 'verified' },
      },
      _buildings: [{ livingAreaSqft: 3200, underRoofSqft: 3900, stories: 2 }],
    });
    expect(result.parts.footprintBasis).toBe('living_area');
    expect(result.parts.footprintSf).toBe(3200);
  });

  test('one gross-less building row falls back whole-record to living/stories', () => {
    const result = computeFootprintTurf({
      lotSize: 20000,
      squareFootage: 4000,
      stories: 1,
      imperviousAreaSf: 0,
      _buildings: [
        { livingAreaSqft: 2500, underRoofSqft: 3000, stories: 1 },
        { livingAreaSqft: 1500, stories: 1 },
      ],
    });
    expect(result.parts.footprintSf).toBe(4000);
    expect(result.parts.footprintBasis).toBe('living_area');
  });

  test('a short gross parse never shrinks the footprint below living/stories — and the basis records that living won (codex r2)', () => {
    const result = computeFootprintTurf({
      lotSize: 9000,
      squareFootage: 1500,
      stories: 1,
      imperviousAreaSf: 0,
      _buildings: [{ livingAreaSqft: 1500, underRoofSqft: 900, stories: 1 }],
    });
    expect(result.parts.footprintSf).toBe(1500);
    // living/stories determined the footprint, so home edits DO move it —
    // the adapter must keep validating them.
    expect(result.parts.footprintBasis).toBe('living_area');
  });

  test('cage on a pre-poolImperviousSf record (field null) nets nothing — no over-subtraction', () => {
    const result = computeFootprintTurf({
      lotSize: 7523,
      squareFootage: 2085,
      stories: 1,
      imperviousAreaSf: 1018,
      poolCageSqft: 1066,
      poolImperviousSf: null,
    });
    expect(result.parts.enclosureNetSf).toBe(0);
    expect(result.turfSf).toBe(7523 - 2085 - 1018);
  });

  test('cage with zero pool-family rows nets its full area', () => {
    const result = computeFootprintTurf({
      lotSize: 8000,
      squareFootage: 1500,
      stories: 1,
      imperviousAreaSf: 600,
      poolCageSqft: 840,
      poolImperviousSf: 0,
    });
    expect(result.parts.enclosureNetSf).toBe(840);
    expect(result.turfSf).toBe(8000 - 1500 - 600 - 840);
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
  // The lot/building dims carry county evidence — the prior requires the
  // dimensions THEMSELVES to be county-sourced, not just the impervious.
  function countyRecord(overrides = {}) {
    return {
      propertyType: 'Single Family',
      lotSize: 10000,
      squareFootage: 2400,
      stories: 2,
      imperviousAreaSf: 800,
      _fieldEvidence: {
        lotSize: { sourceType: 'county' },
        squareFootage: { sourceType: 'county' },
      },
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

  test('gross-under-roof building rows refine the ceiling the prior seeds from', () => {
    // footprint = max(2400/2, 3200/2) = 1,600 → ceiling 10000 − 1600 − 800
    // = 7,600 → prior 3,800 (was 4,000 off the living-area footprint).
    const profile = buildEnrichedProfile(
      countyRecord({ _buildings: [{ livingAreaSqft: 2400, underRoofSqft: 3200, stories: 2 }] }),
      null, 27.4, -82.4,
    );
    expect(profile.footprintTurfSf).toBe(7600);
    expect(profile.footprintTurfParts.footprintBasis).toBe('gross_under_roof');
    expect(profile.countyTurfPriorSf).toBe(3800);
    expect(profile.estimatedTurfSf).toBe(3800);
  });

  test('TRUSTED shared-turf types never seed from their own parcel', () => {
    const profile = buildEnrichedProfile(countyRecord({
      propertyType: 'Townhome',
      _fieldEvidence: {
        lotSize: { sourceType: 'county' },
        squareFootage: { sourceType: 'county' },
        propertyType: { sourceType: 'satellite' },
      },
    }), null, 27.4, -82.4);
    expect(profile.countyTurfPriorSf).toBeNull();
    expect(profile.estimatedTurfSf).toBe(0);
  });

  test('an UNTRUSTED shared-turf label keeps the bound — the prior still seeds (codex P1)', () => {
    // Same evidence bar as applyParcelTurfBound: a listing-sourced
    // "Townhome" on county-verified dims must not lift the per-parcel bound.
    const profile = buildEnrichedProfile(countyRecord({
      propertyType: 'Townhome',
      _fieldEvidence: {
        lotSize: { sourceType: 'county' },
        squareFootage: { sourceType: 'county' },
        propertyType: { sourceType: 'listing', fieldVerify: true },
      },
    }), null, 27.4, -82.4);
    expect(profile.countyTurfPriorSf).toBe(4000);
    expect(profile.estimatedTurfSf).toBe(4000);
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

  test('listing-sourced dimensions never seed, even with GIS impervious backfilled (codex P2)', () => {
    // Hybrid merge shape: lot won from a listing, impervious backfilled
    // from county GIS — the ceiling is not county-grade.
    const profile = buildEnrichedProfile(countyRecord({
      _fieldEvidence: {
        lotSize: { sourceType: 'listing' },
        squareFootage: { sourceType: 'county' },
      },
    }), null, 27.4, -82.4);
    expect(profile.countyTurfPriorSf).toBeNull();
    expect(profile.estimatedTurfSf).toBe(0);
    // …and the untrusted ceiling never feeds the review reason either.
    expect(profile.countyTurfCeilingSf).toBeNull();
    // The shadow fields still ride along untrusted, for the log series.
    expect(profile.footprintTurfSf).toBe(8000);
  });

  test('trusted ceiling is exposed for the review reason on county-complete records', () => {
    const profile = buildEnrichedProfile(countyRecord(), { estimatedTurfSf: 9500, confidenceScore: 80 }, 27.4, -82.4);
    expect(profile.countyTurfCeilingSf).toBe(8000);
    expect(profile.fieldVerifyFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'estimatedTurfSf',
        reason: expect.stringContaining('county-facts ceiling of 8,000 sq ft'),
      }),
    ]));
  });

  test('TRUSTED shared-turf types never expose a per-parcel ceiling (same exemption as the prior)', () => {
    const profile = buildEnrichedProfile(
      countyRecord({
        propertyType: 'Townhome',
        _fieldEvidence: {
          lotSize: { sourceType: 'county' },
          squareFootage: { sourceType: 'county' },
          propertyType: { sourceType: 'satellite' },
        },
      }),
      { estimatedTurfSf: 9500, confidenceScore: 80 },
      27.4, -82.4,
    );
    expect(profile.countyTurfCeilingSf).toBeNull();
    // ...and buildFieldVerifyFlags honors the same exemption — no spurious
    // exceeds-ceiling review reason for a lawn that legitimately spans
    // beyond the unit's parcel (codex P2).
    expect(profile.fieldVerifyFlags.some((f) => /county-facts ceiling/.test(f.reason))).toBe(false);
  });

  test('an UNTRUSTED shared-turf label still exposes the ceiling and its review reason (codex P1)', () => {
    const profile = buildEnrichedProfile(
      countyRecord({
        propertyType: 'Townhome',
        _fieldEvidence: {
          lotSize: { sourceType: 'county' },
          squareFootage: { sourceType: 'county' },
          propertyType: { sourceType: 'listing', fieldVerify: true },
        },
      }),
      { estimatedTurfSf: 9500, confidenceScore: 80 },
      27.4, -82.4,
    );
    expect(profile.countyTurfCeilingSf).toBe(8000);
    expect(profile.fieldVerifyFlags.some((f) => /county-facts ceiling of 8,000 sq ft/.test(f.reason))).toBe(true);
  });
});

describe('vision-only turf with the county cross-check disarmed (verify flag)', () => {
  const { buildEnrichedProfile } = require('../routes/property-lookup-v2');

  function countyRecord(overrides = {}) {
    return {
      propertyType: 'Single Family',
      lotSize: 10000,
      squareFootage: 2400,
      stories: 2,
      imperviousAreaSf: 800,
      _fieldEvidence: {
        lotSize: { sourceType: 'county' },
        squareFootage: { sourceType: 'county' },
      },
      ...overrides,
    };
  }
  const audit = { county: 'Manatee', streetExists: true, hasExactMatch: true, parcelCount: 45, nearestNumbers: [] };
  const visionOnlyFlag = expect.objectContaining({
    field: 'estimatedTurfSf',
    priority: 'HIGH',
    reason: expect.stringContaining('satellite-vision only'),
  });

  test('county roll answered the audit but no record arrived → HIGH verify flag', () => {
    const profile = buildEnrichedProfile(null, { estimatedTurfSf: 3200, confidenceScore: 80 }, 27.4, -82.4, null, audit);
    expect(profile.estimatedTurfSf).toBe(3200);
    expect(profile.turfSource).toBe('vision');
    expect(profile.fieldVerifyFlags).toEqual(expect.arrayContaining([visionOnlyFlag]));
    expect(profile.fieldVerifyFlags.find((f) => /satellite-vision only/.test(f.reason)).reason)
      .toContain('Manatee');
  });

  test('untrusted county dims (listing-sourced lot) also flag — the cross-check is still disarmed', () => {
    const profile = buildEnrichedProfile(
      countyRecord({ _fieldEvidence: { lotSize: { sourceType: 'listing' }, squareFootage: { sourceType: 'county' } } }),
      { estimatedTurfSf: 3200, confidenceScore: 80 },
      27.4, -82.4, null, audit,
    );
    expect(profile.fieldVerifyFlags).toEqual(expect.arrayContaining([visionOnlyFlag]));
  });

  test('trusted ceiling present → no flag (the cross-check is armed)', () => {
    const profile = buildEnrichedProfile(countyRecord(), { estimatedTurfSf: 3200, confidenceScore: 80 }, 27.4, -82.4, null, audit);
    expect(profile.countyTurfCeilingSf).toBe(8000);
    expect(profile.fieldVerifyFlags).not.toEqual(expect.arrayContaining([visionOnlyFlag]));
  });

  test('no address audit (out-of-area / GIS outage) → quiet', () => {
    const profile = buildEnrichedProfile(null, { estimatedTurfSf: 3200, confidenceScore: 80 }, 27.4, -82.4, null, null);
    expect(profile.fieldVerifyFlags).not.toEqual(expect.arrayContaining([visionOnlyFlag]));
  });

  test('TRUSTED shared-turf types stay quiet — no per-parcel bound would apply anyway', () => {
    const profile = buildEnrichedProfile(
      countyRecord({
        propertyType: 'Townhome',
        _fieldEvidence: { propertyType: { sourceType: 'satellite' } },
      }),
      { estimatedTurfSf: 3200, confidenceScore: 80 },
      27.4, -82.4, null, audit,
    );
    expect(profile.fieldVerifyFlags).not.toEqual(expect.arrayContaining([visionOnlyFlag]));
  });

  test('county-sourced record with an untrusted ceiling flags even WITHOUT an address audit (codex P1)', () => {
    // Fresh county-backed lookups skip the audit (it only runs when the
    // record lacks county evidence) — record provenance must arm the flag.
    const profile = buildEnrichedProfile(
      countyRecord({
        _source: 'county',
        county: 'Sarasota',
        imperviousAreaSf: undefined, // unparsed roll → untrusted ceiling
      }),
      { estimatedTurfSf: 3200, confidenceScore: 80 },
      27.4, -82.4, null, null,
    );
    const flag = profile.fieldVerifyFlags.find((f) => /satellite-vision only/.test(f.reason));
    expect(flag).toBeTruthy();
    expect(flag.reason).toContain('Sarasota');
  });

  test('explicit vision 0 (no-lawn property) never flags', () => {
    const profile = buildEnrichedProfile(null, { estimatedTurfSf: 0, confidenceScore: 85 }, 27.4, -82.4, null, audit);
    expect(profile.fieldVerifyFlags).not.toEqual(expect.arrayContaining([visionOnlyFlag]));
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
