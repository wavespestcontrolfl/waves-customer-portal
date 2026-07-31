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

// Recent build — the detector only sanitizes new-construction
// contradictions (a bare-land reading against an OLD home is a plausible
// teardown). Dynamic so the fixture stays "recent" as the clock moves.
const BUILD_YEAR = new Date().getFullYear() - 1;

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
    yearBuilt: BUILD_YEAR,
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
      .toEqual({ countySqFt: 2362, yearBuilt: BUILD_YEAR });
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

  test('an OLD assessed home never fires — bare-land vision may be a real teardown', () => {
    // codex P2 #3098: the roll carries no demolition signal, so only a
    // recent build proves the imagery-lag direction. Old or unknown
    // yearBuilt keeps the explicit vision zeros (correct for a teardown).
    expect(detectStaleImageryTurfConflict({ ...newBuildRecord(), yearBuilt: 1987 }, bareDirtAi())).toBeNull();
    expect(detectStaleImageryTurfConflict({ ...newBuildRecord(), yearBuilt: null }, bareDirtAi())).toBeNull();
    const noYear = { ...newBuildRecord() };
    delete noYear.yearBuilt;
    expect(detectStaleImageryTurfConflict(noYear, bareDirtAi())).toBeNull();
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
      .toEqual({ countySqFt: 2362, yearBuilt: BUILD_YEAR });
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
    expect(flag.reason).toMatch(new RegExp(`2,362 sq ft home \\(built ${BUILD_YEAR}\\)`));
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

describe('POST /turf-preview (live engine preview for form edits)', () => {
  // codex P1 r2 #3098: the client re-asks the engine when the rep edits the
  // dims/features after lookup, so the displayed fallback keeps tracking
  // what /calculate-estimate prices. Handler invoked off the router stack
  // (repo has no supertest); it is pure computation, no DB.
  const router = require('../routes/property-lookup-v2');

  function invoke(body) {
    const layer = router.stack.find((l) => l.route?.path === '/turf-preview' && l.route.methods.post);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, payload }); },
      };
      handler({ body }, res);
    });
  }

  const LIGHT_SIMPLE = { pool: false, poolCage: false, shrubs: 'light', trees: 'light', complexity: 'simple', nearWater: false };

  test('returns the engine number, matching the lookup-time profile preview', async () => {
    const { status, payload } = await invoke({
      lotSqFt: 6985, homeSqFt: 2362, stories: 2,
      propertyType: 'Single Family', features: LIGHT_SIMPLE,
    });
    expect(status).toBe(200);
    const engine = calculatePropertyProfile({
      lotSqFt: 6985, homeSqFt: 2362, stories: 2,
      propertyType: 'single_family', features: LIGHT_SIMPLE,
    });
    expect(payload.turfSf).toBe(Math.round(engine.lawnSqFt));
    const profile = buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42);
    expect(payload.turfSf).toBe(profile.turfFallbackPreviewSf);
  });

  test("tracks edited dims — codex's 10,000 sf lot example prices via the engine", async () => {
    const { payload } = await invoke({
      lotSqFt: 10000, homeSqFt: 2362, stories: 2,
      propertyType: 'Single Family', features: LIGHT_SIMPLE,
    });
    const engine = calculatePropertyProfile({
      lotSqFt: 10000, homeSqFt: 2362, stories: 2,
      propertyType: 'single_family', features: LIGHT_SIMPLE,
    });
    expect(payload.turfSf).toBe(Math.round(engine.lawnSqFt));
    expect(payload.turfSf).toBeGreaterThan(0);
  });

  test('junk input degrades to turfSf 0 without throwing', async () => {
    const { status, payload } = await invoke({ lotSqFt: 'x', stories: -4, features: ['nope'] });
    expect(status).toBe(200);
    expect(payload.turfSf).toBe(0);
  });
});
