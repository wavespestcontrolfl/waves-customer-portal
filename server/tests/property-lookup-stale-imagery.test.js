/**
 * Stale/invalid-imagery turf-zero guard.
 *
 * Failure shape (prod, 8818 Starry Night Ter, Parrish 2026-07-30): Google
 * Static Maps tiles predate a 2025 build, the vision pass honestly measures
 * the bare-dirt lot — explicit 0 turf, 0% impervious, 0 bed area — and those
 * "known zeros" ride into the estimator, where the lot-estimate fallback
 * becomes lot × (1 − 0%) − 0 beds = the FULL 6,985 sq ft lot priced as
 * treatable turf. 33 of 229 cached lookups carried the same contradiction.
 *
 * The guard (detectStaleImageryTurfConflict + buildEnrichedProfile
 * sanitization) discards the vision AREA fields when the county roll
 * assesses a completed home the vision pass didn't see, skips the county
 * turf prior, and lets the documented lot-based default ladder (20%
 * hardscape / 15% beds → LOW + field-verify) produce the number instead.
 * The codex-P2 rule that an explicit vision 0 on a VISIBLE property is a
 * real measurement (paved / rock / artificial-turf yards) must survive —
 * those read HIGH impervious, which is exactly why the guard requires BOTH
 * zeros.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { detectStaleImageryTurfConflict } = require('../services/property-lookup/ai-property-lookup');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');
const { computeTurfArea } = require('../services/pricing-engine/property-calculator');

// Mirrors the live Starry Night county record: trusted county dims (so the
// county turf prior WOULD seed if the guard didn't also skip it) and an
// assessed-impervious roll of 0 (extra-features lag on new construction).
function starryRecord() {
  return {
    formattedAddress: '8818 Starry Night Ter, Parrish, FL 34219',
    county: 'Manatee',
    propertyType: 'Single Family',
    squareFootage: 2362,
    stories: 2,
    lotSize: 6985,
    yearBuilt: 2025,
    imperviousAreaSf: 0,
    _fieldEvidence: {
      lotSize: { sourceType: 'county' },
      squareFootage: { sourceType: 'county' },
    },
  };
}

// Mirrors the live cached ai_analysis: the vision trio saw pre-construction
// bare dirt and measured it honestly.
function bareDirtAi() {
  return {
    confidenceScore: 68,
    estimatedTurfSf: 0,
    imperviousSurfacePercent: 0,
    imperviosSurfacePercent: 0,
    estimatedBedAreaSf: 0,
    shrubDensity: 'LIGHT',
    treeDensity: 'LIGHT',
    landscapeComplexity: 'SIMPLE',
    analysisNotes: 'The lot has been cleared and graded as bare dirt; no home constructed yet.',
  };
}

beforeEach(() => jest.clearAllMocks());

describe('detectStaleImageryTurfConflict', () => {
  test('fires on county-assessed home + explicit vision zeros for turf AND impervious', () => {
    expect(detectStaleImageryTurfConflict(starryRecord(), bareDirtAi()))
      .toEqual({ countySqFt: 2362, yearBuilt: 2025 });
  });

  test('a genuine no-lawn property (structure visible, high impervious) never trips it', () => {
    const paved = { ...bareDirtAi(), imperviousSurfacePercent: 85, imperviosSurfacePercent: 85 };
    expect(detectStaleImageryTurfConflict(starryRecord(), paved)).toBeNull();
  });

  test('missing/null area fields are "not measured", not explicit zeros', () => {
    const noTurf = bareDirtAi();
    delete noTurf.estimatedTurfSf;
    expect(detectStaleImageryTurfConflict(starryRecord(), noTurf)).toBeNull();

    const nullImpervious = { ...bareDirtAi(), imperviousSurfacePercent: null, imperviosSurfacePercent: null };
    expect(detectStaleImageryTurfConflict(starryRecord(), nullImpervious)).toBeNull();
  });

  test('no county-assessed building means no contradiction (vacant/new-parcel window)', () => {
    const vacant = { ...starryRecord(), squareFootage: 0, yearBuilt: null };
    expect(detectStaleImageryTurfConflict(vacant, bareDirtAi())).toBeNull();
    expect(detectStaleImageryTurfConflict(null, bareDirtAi())).toBeNull();
    expect(detectStaleImageryTurfConflict(starryRecord(), null)).toBeNull();
  });
});

describe('buildEnrichedProfile stale-imagery sanitization', () => {
  test('discards the vision area fields, skips the county prior, and stamps provenance', () => {
    const profile = buildEnrichedProfile(starryRecord(), bareDirtAi(), 27.58, -82.42);

    expect(profile.turfObservation).toBe('unobservable');
    expect(profile.turfReason).toBe('county_structure_vision_bare_land_conflict');
    // No vision turf, no seeded prior — pricing falls to its lot ladder.
    expect(profile.estimatedTurfSf).toBe(0);
    expect(profile.turfSource).toBe('none');
    expect(profile.countyTurfPriorSf).toBeNull();
    // The explicit zeros are GONE, so every consumer's documented defaults
    // apply (client lot estimate 20%/15%; turfCorrectionFactor 0.80).
    expect(profile.imperviousSurfacePercent).toBeUndefined();
    expect(profile.estimatedBedAreaSf).toBeUndefined();
    expect(profile.modifiers.turfCorrectionFactor).toBe(0.80);

    const flag = profile.fieldVerifyFlags.find((f) => f.field === 'estimatedTurfSf');
    expect(flag).toBeDefined();
    expect(flag.priority).toBe('HIGH');
    expect(flag.reason).toMatch(/2,362 sq ft home \(built 2025\)/);
  });

  test('the county prior would have seeded without the guard skip (fixture is trusted)', () => {
    // Same record, but vision returned NO turf number at all (a miss, not a
    // contradiction) — the existing county-prior path seeds 50% of the
    // ceiling. Pins that the fixture actually exercises the skip above.
    const missAi = { ...bareDirtAi(), imperviousSurfacePercent: null, imperviosSurfacePercent: null };
    delete missAi.estimatedTurfSf;
    const profile = buildEnrichedProfile(starryRecord(), missAi, 27.58, -82.42);
    // ceiling = 6,985 − 2,362/2 − 0 assessed impervious = 5,804; prior = 50%.
    expect(profile.countyTurfPriorSf).toBe(2902);
    expect(profile.turfSource).toBe('county_prior');
    expect(profile.turfObservation).toBeUndefined();
  });

  test('a confirmed paved property keeps its explicit vision zero untouched', () => {
    const paved = {
      ...bareDirtAi(),
      imperviousSurfacePercent: 85,
      imperviosSurfacePercent: 85,
      estimatedBedAreaSf: 120,
    };
    const profile = buildEnrichedProfile(starryRecord(), paved, 27.58, -82.42);
    expect(profile.estimatedTurfSf).toBe(0);
    expect(profile.turfSource).toBe('vision');
    expect(profile.turfObservation).toBeUndefined();
    expect(profile.turfReason).toBeUndefined();
    expect(profile.imperviousSurfacePercent).toBe(85);
    expect(profile.estimatedBedAreaSf).toBe(120);
  });

  test('a vacant/unassessed parcel keeps its vision zeros — imagery IS the fresher source there', () => {
    const vacantRecord = {
      formattedAddress: '000 Future St, Parrish, FL 34219',
      county: 'Manatee',
      lotSize: 6985,
      _parcel: { landUseDescription: 'Vacant Residential Platted (1554)', dorUseCode: '00' },
    };
    const profile = buildEnrichedProfile(vacantRecord, bareDirtAi(), 27.58, -82.42);
    expect(profile.unassessedVacantParcel).toBe(true);
    expect(profile.turfObservation).toBeUndefined();
    expect(profile.estimatedTurfSf).toBe(0);
    expect(profile.turfSource).toBe('vision');
  });
});

describe('pricing parity after sanitization', () => {
  // The estimator UI's lot-estimate fallback computes
  // round(lot × (1 − 20%)) − round(open × 15%) when the profile carries no
  // impervious/bed figures — the server engine must land on the SAME number.
  const CLIENT_LOT_ESTIMATE = (() => {
    const open = Math.round(6985 * 0.8);
    return open - Math.round(open * 0.15); // 5,588 − 838 = 4,750
  })();

  function pricingInputFromProfile(profile, extra = {}) {
    return {
      lotSqFt: profile.lotSqFt,
      estimatedTurfSf: profile.estimatedTurfSf,
      turfSource: profile.turfSource,
      imperviousSurfacePercent: profile.imperviousSurfacePercent,
      imperviosSurfacePercent: profile.imperviosSurfacePercent,
      estimatedBedAreaSf: profile.estimatedBedAreaSf,
      ...extra,
    };
  }

  test('sanitized profile prices at the client lot-estimate default, LOW + field-verify', () => {
    const profile = buildEnrichedProfile(starryRecord(), bareDirtAi(), 27.58, -82.42);
    const turf = computeTurfArea(pricingInputFromProfile(profile));
    expect(turf.turfSf).toBe(CLIENT_LOT_ESTIMATE);
    expect(turf.turfSf).toBe(4750);
    expect(turf.turfBasis).toBe('lotFallback');
    expect(turf.turfConfidence).toBe('LOW');
    expect(turf.turfFlags).toContain('FIELD_VERIFY_TURF_SQFT');
  });

  test('REGRESSION — the unsanitized poisoned shape prices the FULL lot as turf', () => {
    // Documents the bug the guard exists for: explicit zeros reaching the
    // engine directly yield 6,985 sq ft of "treatable" turf on a 6,985 lot.
    const poisoned = computeTurfArea({
      lotSqFt: 6985,
      estimatedTurfSf: 0,
      imperviousSurfacePercent: 0,
      imperviosSurfacePercent: 0,
      estimatedBedAreaSf: 0,
      bedArea: 0,
      bedAreaSource: 'estimated',
    });
    expect(poisoned.turfSf).toBe(6985);
  });

  test('a measured turf entry out-ranks the guard fallback (override precedence)', () => {
    const profile = buildEnrichedProfile(starryRecord(), bareDirtAi(), 27.58, -82.42);
    const turf = computeTurfArea(pricingInputFromProfile(profile, { measuredTurfSf: 5200 }));
    expect(turf.turfSf).toBe(5200);
    expect(turf.turfBasis).toBe('measuredTurfSf');
    expect(turf.turfConfidence).toBe('HIGH');
  });
});
