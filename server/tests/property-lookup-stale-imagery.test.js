/**
 * Stale/invalid-imagery turf-zero guard.
 *
 * Failure shape (prod, a 2025-build Parrish parcel, 2026-07-30): Google
 * Static Maps tiles predate a 2025 build, the vision pass honestly measures
 * the bare-dirt lot — explicit 0 turf, 0% impervious, 0 bed area — and those
 * "known zeros" ride into the estimator, where the lot-estimate fallback
 * becomes lot × (1 − 0%) − 0 beds = the FULL 6,985 sq ft lot priced as
 * treatable turf. 33 of 229 cached lookups carried the same contradiction.
 *
 * The guard (detectStaleImageryTurfConflict + buildEnrichedProfile
 * sanitization) discards the vision AREA fields when COUNTY-EVIDENCED
 * building records contradict the vision pass, skips the county turf
 * prior, and lets the engine's documented fallback (the legacy
 * building/hardscape estimate, LOW + field-verify) produce the number —
 * exposed to the client as turfFallbackPreviewSf so the previewed number
 * IS the priced number. The codex-P2 rule that an explicit vision 0 on a
 * VISIBLE property is a real measurement (paved / rock / artificial-turf
 * yards) must survive — those read HIGH impervious, which is exactly why
 * the guard requires BOTH zeros.
 *
 * Addresses in fixtures are synthetic (repo policy: no live customer
 * addresses in code or tests); the dimensions mirror the prod incident.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { detectStaleImageryTurfConflict } = require('../services/property-lookup/ai-property-lookup');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');
const { computeTurfArea, calculatePropertyProfile } = require('../services/pricing-engine/property-calculator');

// Mirrors the prod incident's county record (synthetic address): trusted
// county dims (so the county turf prior WOULD seed if the guard didn't also
// skip it, and so the detector's evidence gate passes) with an
// assessed-impervious roll of 0 (extra-features lag on new construction).
function newBuildRecord() {
  return {
    formattedAddress: '100 Sample Build Ct, Parrish, FL 34219',
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
    expect(detectStaleImageryTurfConflict(newBuildRecord(), bareDirtAi()))
      .toEqual({ countySqFt: 2362, yearBuilt: 2025 });
  });

  test('a genuine no-lawn property (structure visible, high impervious) never trips it', () => {
    const paved = { ...bareDirtAi(), imperviousSurfacePercent: 85, imperviosSurfacePercent: 85 };
    expect(detectStaleImageryTurfConflict(newBuildRecord(), paved)).toBeNull();
  });

  test('missing/null area fields are "not measured", not explicit zeros', () => {
    const noTurf = bareDirtAi();
    delete noTurf.estimatedTurfSf;
    expect(detectStaleImageryTurfConflict(newBuildRecord(), noTurf)).toBeNull();

    const nullImpervious = { ...bareDirtAi(), imperviousSurfacePercent: null, imperviosSurfacePercent: null };
    expect(detectStaleImageryTurfConflict(newBuildRecord(), nullImpervious)).toBeNull();
  });

  test('no county-assessed building means no contradiction (vacant/new-parcel window)', () => {
    const vacant = { ...newBuildRecord(), squareFootage: 0, yearBuilt: null };
    expect(detectStaleImageryTurfConflict(vacant, bareDirtAi())).toBeNull();
    expect(detectStaleImageryTurfConflict(null, bareDirtAi())).toBeNull();
    expect(detectStaleImageryTurfConflict(newBuildRecord(), null)).toBeNull();
  });

  test('listing/AI-sourced square footage is not authoritative — never fires', () => {
    // A vacant-roll parcel with a stale listing sqft bypasses
    // detectUnassessedVacantParcel (early return on positive sqft); without
    // the evidence gate that would discard CORRECT bare-lot vision zeros.
    const listingSourced = {
      ...newBuildRecord(),
      _fieldEvidence: {
        lotSize: { sourceType: 'county' },
        squareFootage: { sourceType: 'ai_search' },
      },
    };
    expect(detectStaleImageryTurfConflict(listingSourced, bareDirtAi())).toBeNull();

    const noEvidence = { ...newBuildRecord(), _fieldEvidence: {} };
    expect(detectStaleImageryTurfConflict(noEvidence, bareDirtAi())).toBeNull();

    const noEvidenceMap = { ...newBuildRecord() };
    delete noEvidenceMap._fieldEvidence;
    expect(detectStaleImageryTurfConflict(noEvidenceMap, bareDirtAi())).toBeNull();
  });

  test('accepts both _fieldEvidence shapes (merged object and raw single-source array)', () => {
    const arrayShape = {
      ...newBuildRecord(),
      _fieldEvidence: {
        lotSize: [{ sourceType: 'cadastral' }],
        squareFootage: [{ sourceType: 'cadastral' }],
      },
    };
    expect(detectStaleImageryTurfConflict(arrayShape, bareDirtAi()))
      .toEqual({ countySqFt: 2362, yearBuilt: 2025 });
  });
});

describe('buildEnrichedProfile stale-imagery sanitization', () => {
  test('discards the vision area fields, skips the county prior, and stamps provenance', () => {
    const profile = buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42);

    expect(profile.turfObservation).toBe('unobservable');
    expect(profile.turfReason).toBe('county_structure_vision_bare_land_conflict');
    // No vision turf, no seeded prior — pricing falls to its lot ladder.
    expect(profile.estimatedTurfSf).toBe(0);
    expect(profile.turfSource).toBe('none');
    expect(profile.countyTurfPriorSf).toBeNull();
    // The explicit zeros are GONE, so every consumer's documented defaults
    // apply (turfCorrectionFactor 0.80; engine legacy fallback for turf).
    expect(profile.imperviousSurfacePercent).toBeUndefined();
    expect(profile.estimatedBedAreaSf).toBeUndefined();
    expect(profile.modifiers.turfCorrectionFactor).toBe(0.80);
    // The engine-faithful preview the client displays instead of its own
    // 20%/15% heuristic (parity pinned in the describe below).
    expect(profile.turfFallbackPreviewSf).toBeGreaterThan(0);

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
    const profile = buildEnrichedProfile(newBuildRecord(), missAi, 27.58, -82.42);
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
    const profile = buildEnrichedProfile(newBuildRecord(), paved, 27.58, -82.42);
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
  // The number an unconfirmed estimate is actually priced with comes from
  // calculatePropertyProfile, which always hands computeTurfArea its legacy
  // building/hardscape fallback — NOT the bare lot ladder (codex P1 #3098).
  // This input mirrors the /calculate-estimate request path for the
  // sanitized profile: same dims, no turf/impervious/bed fields.
  function engineInputFromProfile(profile, extra = {}) {
    return {
      lotSqFt: profile.lotSqFt,
      homeSqFt: profile.homeSqFt,
      stories: profile.stories,
      footprintSqFt: profile.footprint,
      propertyType: 'single_family',
      estimatedTurfSf: profile.estimatedTurfSf,
      turfSource: profile.turfSource,
      imperviousSurfacePercent: profile.imperviousSurfacePercent,
      imperviosSurfacePercent: profile.imperviosSurfacePercent,
      estimatedBedAreaSf: profile.estimatedBedAreaSf,
      features: {
        pool: false,
        poolCage: false,
        shrubs: 'light',
        trees: 'light',
        complexity: 'simple',
        nearWater: false,
      },
      ...extra,
    };
  }

  test('turfFallbackPreviewSf IS the number the engine prices on the real path', () => {
    const profile = buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42);
    expect(profile.turfFallbackPreviewSf).toBeGreaterThan(0);
    // Sanity: a building/hardscape fallback, not the full lot and not zero.
    expect(profile.turfFallbackPreviewSf).toBeLessThan(profile.lotSqFt);

    const engine = calculatePropertyProfile(engineInputFromProfile(profile));
    expect(engine.lawnSqFt).toBe(profile.turfFallbackPreviewSf);
    // The engine grades this as its legacy fallback: LOW + field-verify.
    expect(engine.turfEstimated ?? true).toBe(true);
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
    const profile = buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42);
    const engine = calculatePropertyProfile(engineInputFromProfile(profile, { measuredTurfSf: 5200 }));
    expect(engine.lawnSqFt).toBe(5200);
  });

  test('no preview on normal profiles — the field only exists when the guard fired', () => {
    const paved = { ...bareDirtAi(), imperviousSurfacePercent: 85, imperviosSurfacePercent: 85 };
    const profile = buildEnrichedProfile(newBuildRecord(), paved, 27.58, -82.42);
    expect(profile.turfFallbackPreviewSf).toBeUndefined();
  });
});
