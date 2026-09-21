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
const { buildEnrichedProfile, translateV2CallToV1Input } = require('../routes/property-lookup-v2');
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
      yearBuilt: { sourceType: 'county' },
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
        yearBuilt: { sourceType: 'county' },
      },
    };
    expect(detectStaleImageryTurfConflict(listingSourced, bareDirtAi())).toBeNull();

    // County-sourced building but listing/AI-sourced recent yearBuilt: the
    // recency claim itself is unverified — a county-sourced OLD home with a
    // wrong listing year would otherwise discard truthful teardown zeros
    // (pre-push P1 r4 #3098).
    const listingYear = {
      ...newBuildRecord(),
      _fieldEvidence: {
        lotSize: { sourceType: 'county' },
        squareFootage: { sourceType: 'county' },
        yearBuilt: { sourceType: 'listing' },
      },
    };
    expect(detectStaleImageryTurfConflict(listingYear, bareDirtAi())).toBeNull();

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
        yearBuilt: [{ sourceType: 'cadastral' }],
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

  // Owner ruling 2026-09-21 (supersedes the earlier "imagery is the fresher
  // source" pin): a bare-land reading on a vacant-roll parcel is the
  // IMAGERY's state — nobody prices lawn or mosquito work on a dirt reading
  // for a home the customer is asking to treat — so the zeros are
  // unobservable, never a no-lawn measurement.
  function vacantRollRecord() {
    return {
      formattedAddress: '000 Future St, Parrish, FL 34219',
      county: 'Manatee',
      lotSize: 6985,
      _parcel: { landUseDescription: 'Vacant Residential Platted (1554)', dorUseCode: '00' },
    };
  }

  test('a vacant/unassessed parcel with bare-land zeros is unobservable, not a no-lawn measurement', () => {
    const profile = buildEnrichedProfile(vacantRollRecord(), bareDirtAi(), 27.58, -82.42);
    expect(profile.unassessedVacantParcel).toBe(true);
    expect(profile.turfObservation).toBe('unobservable');
    expect(profile.turfReason).toBe('vacant_roll_bare_land_imagery');
    expect(profile.estimatedTurfSf).toBe(0);
    expect(profile.turfSource).toBe('none');
    expect(profile.imperviousSurfacePercent).not.toBe(0);
    const flag = profile.fieldVerifyFlags.find((f) => f.field === 'estimatedTurfSf' && /bare land/.test(f.reason));
    expect(flag).toMatchObject({ priority: 'HIGH' });
    expect(flag.reason).toContain('Vacant Residential Platted');
    expect(flag.reason).toContain('imagery predates it');
    // The stale-imagery (county-home) flag is a different situation and must not also fire.
    expect(profile.fieldVerifyFlags.some((f) => /conflicts with county records/.test(f.reason))).toBe(false);
  });

  test('a vacant/unassessed parcel whose imagery already shows a lawn keeps the vision reading', () => {
    const lawn = { ...bareDirtAi(), estimatedTurfSf: 3200, imperviousSurfacePercent: 35, imperviosSurfacePercent: 35 };
    const profile = buildEnrichedProfile(vacantRollRecord(), lawn, 27.58, -82.42);
    expect(profile.turfObservation).toBeUndefined();
    expect(profile.estimatedTurfSf).toBe(3200);
    expect(profile.turfSource).toBe('vision');
  });

  test('fires from the ROLL\'s vacancy even when a listing or a verified size filled the dimensions', () => {
    // A listing's square footage is non-authoritative, so the stale-imagery
    // guard refuses it; a verified size with no year built fails its recency
    // gate. Both must still land on the vacant-roll guard.
    const listed = { ...vacantRollRecord(), squareFootage: 2400, _fieldEvidence: { squareFootage: { sourceType: 'listing' } } };
    const listedProfile = buildEnrichedProfile(listed, bareDirtAi(), 27.58, -82.42);
    expect(listedProfile.unassessedVacantParcel).toBeUndefined();
    expect(listedProfile.turfObservation).toBe('unobservable');
    expect(listedProfile.turfReason).toBe('vacant_roll_bare_land_imagery');
    const verified = { ...vacantRollRecord(), squareFootage: 2980, _fieldEvidence: { squareFootage: { sourceType: 'verified' } } };
    const verifiedProfile = buildEnrichedProfile(verified, bareDirtAi(), 27.58, -82.42);
    expect(verifiedProfile.turfObservation).toBe('unobservable');
    expect(verifiedProfile.fieldVerifyFlags.some((f) => /conflicts with county records/.test(f.reason))).toBe(false);
  });

  test('needsTurfManualConfirmation gates mosquito-only pricing on an unobservable profile', () => {
    const { needsTurfManualConfirmation } = require('../routes/property-lookup-v2');
    const profile = buildEnrichedProfile(vacantRollRecord(), bareDirtAi(), 27.58, -82.42);
    const gate = needsTurfManualConfirmation(profile, ['MOSQUITO'], {});
    expect(gate).toMatchObject({ field: 'measuredTurfSf', turfObservation: 'unobservable' });
    expect(gate.message).toContain('mosquito');
    expect(needsTurfManualConfirmation(profile, ['OT_MOSQUITO', 'PEST'], {})).not.toBeNull();
    // A confirmed outdoor area clears it; a normal profile never gates mosquito.
    expect(needsTurfManualConfirmation({ ...profile, measuredTurfSf: 4000 }, ['MOSQUITO'], {})).toBeNull();
    const lawn = { ...bareDirtAi(), estimatedTurfSf: 3200, imperviousSurfacePercent: 35, imperviosSurfacePercent: 35 };
    expect(needsTurfManualConfirmation(buildEnrichedProfile(vacantRollRecord(), lawn, 27.58, -82.42), ['MOSQUITO'], {})).toBeNull();
    // The county-home stale-imagery profile gates mosquito the same way.
    expect(needsTurfManualConfirmation(buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42), ['MOSQUITO'], {})).not.toBeNull();
  });

  test('needsTurfManualConfirmation names the vacant-roll situation on that profile', () => {
    const { needsTurfManualConfirmation } = require('../routes/property-lookup-v2');
    const profile = buildEnrichedProfile(vacantRollRecord(), bareDirtAi(), 27.58, -82.42);
    const gate = needsTurfManualConfirmation(profile, ['LAWN'], {});
    expect(gate).toMatchObject({ field: 'measuredTurfSf', turfObservation: 'unobservable' });
    expect(gate.message).toContain('county roll shows no building yet');
  });
});

describe('mosquito prices on the confirmed outdoor area when imagery is unobservable', () => {
  const { calculatePropertyProfile } = require('../services/pricing-engine/property-calculator');

  function vacantRollRecord() {
    return { formattedAddress: '000 Future St, Parrish, FL 34219', county: 'Manatee', lotSize: 6985, _parcel: { landUseDescription: 'Vacant Residential Platted (1554)', dorUseCode: '00' } };
  }

  test('the confirmed turf (+ entered bed area) becomes mosquitoTreatableSqFt through translate and the calculator', () => {
    const profile = { ...buildEnrichedProfile(vacantRollRecord(), bareDirtAi(), 27.58, -82.42), homeSqFt: 2400, stories: 1, measuredTurfSf: 4000, estimatedBedAreaSf: 300 };
    const v1 = translateV2CallToV1Input(profile, ['MOSQUITO'], {});
    expect(v1.mosquitoTreatableSqFt).toBe(4300);
    const priced = calculatePropertyProfile(v1);
    expect(priced.mosquitoTreatableSqFt).toBe(4300);
    // Not the lot-geometry default the gate exists to block.
    expect(priced.mosquitoTreatableSqFt).not.toBe(Math.max(0, 6985 - priced.footprint - priced.hardscape));
  });

  test('a normal profile never carries an explicit area — the calculator keeps its lot-geometry derivation', () => {
    const lawn = { ...bareDirtAi(), estimatedTurfSf: 3200, imperviousSurfacePercent: 35, imperviosSurfacePercent: 35 };
    const profile = { ...buildEnrichedProfile(vacantRollRecord(), lawn, 27.58, -82.42), homeSqFt: 2400, stories: 1, measuredTurfSf: 4000 };
    const v1 = translateV2CallToV1Input(profile, ['MOSQUITO'], {});
    expect(v1.mosquitoTreatableSqFt).toBeUndefined();
    const priced = calculatePropertyProfile(v1);
    expect(priced.mosquitoTreatableSqFt).toBe(Math.max(0, 6985 - priced.footprint - priced.hardscape));
  });

  test('end to end: the pricing engine prices mosquito on the explicit area, not lot geometry', () => {
    const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
    const base = { homeSqFt: 2400, stories: 1, lotSqFt: 6985, services: { mosquito: { tier: 'monthly12' } } };
    const derived = generateEstimate(base);
    const explicit = generateEstimate({ ...base, mosquitoTreatableSqFt: 1500 });
    expect(explicit.property.mosquitoTreatableSqFt).toBe(1500);
    expect(derived.property.mosquitoTreatableSqFt).toBe(Math.max(0, 6985 - derived.property.footprint - derived.property.hardscape));
    expect(explicit.property.mosquitoTreatableSqFt).not.toBe(derived.property.mosquitoTreatableSqFt);
  });

  test('the stale-imagery (county-home) profile takes the same path', () => {
    const profile = { ...buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42), measuredTurfSf: 3500 };
    expect(translateV2CallToV1Input(profile, ['OT_MOSQUITO'], {}).mosquitoTreatableSqFt).toBe(3500);
  });
});

describe('detectVacantRollBareLandImagery', () => {
  const { detectVacantRollBareLandImagery } = require('../services/property-lookup/ai-property-lookup');
  const vacant = { lotSize: 6985, _parcel: { landUseDescription: 'Vacant Residential Platted (1554)', dorUseCode: '00' } };

  test('fires only on a vacant-roll parcel with explicit zeros for turf AND impervious', () => {
    expect(detectVacantRollBareLandImagery(vacant, bareDirtAi())).toEqual({ landUseDescription: 'Vacant Residential Platted (1554)' });
    // Roll verdict, not merged dims: a listing size on a vacant roll still fires.
    expect(detectVacantRollBareLandImagery({ ...vacant, squareFootage: 2400 }, bareDirtAi())).toEqual({ landUseDescription: 'Vacant Residential Platted (1554)' });
    expect(detectVacantRollBareLandImagery(newBuildRecord(), bareDirtAi())).toBeNull(); // county home → the stale-imagery guard's case
    const noTurf = bareDirtAi();
    delete noTurf.estimatedTurfSf;
    expect(detectVacantRollBareLandImagery(vacant, noTurf)).toBeNull(); // not measured ≠ explicit zero
    expect(detectVacantRollBareLandImagery(vacant, { ...bareDirtAi(), imperviousSurfacePercent: 40, imperviosSurfacePercent: 40 })).toBeNull();
    expect(detectVacantRollBareLandImagery(vacant, null)).toBeNull();
  });
});

describe('pricing parity after sanitization', () => {
  // Faithfulness is judged against the REAL request path (pre-push P1 r3
  // #3098): doGenerate spreads the profile, defaults a blank bed-area field
  // to estimatedBedAreaSf 0, and /calculate-estimate runs
  // translateV2CallToV1Input -> calculatePropertyProfile. That explicit
  // bed-0 flips computeTurfArea off the legacy fallback and onto the
  // plausible-max-capped lot ladder — a hand-built engine input misses it.
  function clientProfileFor(profile, overrides = {}) {
    const clientProfile = {
      ...profile,
      estimatedBedAreaSf: Number(profile.estimatedBedAreaSf) || 0,
      ...overrides,
    };
    delete clientProfile.measuredTurfSf;
    return clientProfile;
  }

  function pricedTurfSf(profileLike) {
    const v1Input = translateV2CallToV1Input(profileLike, [], {});
    return Math.round(calculatePropertyProfile(v1Input).lawnSqFt);
  }

  test('turfFallbackPreviewSf IS the number the real request path prices', () => {
    const profile = buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42);
    expect(profile.turfFallbackPreviewSf).toBeGreaterThan(0);
    expect(profile.turfFallbackPreviewSf).toBeLessThan(profile.lotSqFt);
    expect(profile.turfFallbackPreviewSf).toBe(pricedTurfSf(clientProfileFor(profile)));
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
    expect(pricedTurfSf({ ...clientProfileFor(profile), measuredTurfSf: 5200 })).toBe(5200);
  });

  test('an engine ZERO is preserved, not coerced to null (codex P2 r4)', () => {
    // Footprint + hardscape consume a 1,400 sf lot — the engine's 0 is the
    // authoritative answer; null would make the client fall back to a
    // stale positive number.
    const tinyLot = { ...newBuildRecord(), lotSize: 1400 };
    const profile = buildEnrichedProfile(tinyLot, bareDirtAi(), 27.58, -82.42);
    expect(profile.turfFallbackPreviewSf).toBe(0);
    expect(pricedTurfSf(clientProfileFor(profile))).toBe(0);
  });

  test('no preview on normal profiles — the field only exists when the guard fired', () => {
    const paved = { ...bareDirtAi(), imperviousSurfacePercent: 85, imperviosSurfacePercent: 85 };
    const profile = buildEnrichedProfile(newBuildRecord(), paved, 27.58, -82.42);
    expect(profile.turfFallbackPreviewSf).toBeUndefined();
  });
});

describe('POST /turf-preview (live engine preview for form edits)', () => {
  // codex P1 r2 + pre-push P1 r3 #3098: the client re-sends the SAME
  // doGenerate-shaped profile as the form is edited; the endpoint runs it
  // through the SAME translate/engine boundary /calculate-estimate uses.
  // Handler invoked off the router stack (repo has no supertest); pure
  // computation, no DB.
  const router = require('../routes/property-lookup-v2');

  function clientProfileFor(profile, overrides = {}) {
    const clientProfile = {
      ...profile,
      estimatedBedAreaSf: Number(profile.estimatedBedAreaSf) || 0,
      ...overrides,
    };
    delete clientProfile.measuredTurfSf;
    return clientProfile;
  }

  function pricedTurfSf(profileLike) {
    const v1Input = translateV2CallToV1Input(profileLike, [], {});
    return Math.round(calculatePropertyProfile(v1Input).lawnSqFt);
  }

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

  test('returns the real-request-path number, matching the lookup-time profile preview', async () => {
    const profile = buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42);
    const clientProfile = clientProfileFor(profile);
    const { status, payload } = await invoke({ profile: clientProfile });
    expect(status).toBe(200);
    expect(payload.turfSf).toBe(pricedTurfSf(clientProfile));
    expect(payload.turfSf).toBe(profile.turfFallbackPreviewSf);
  });

  test("tracks edited dims — the reviewer's 10,000 sf lot example prices via the real path", async () => {
    const profile = buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42);
    const edited = clientProfileFor(profile, { lotSqFt: 10000 });
    const { payload } = await invoke({ profile: edited });
    expect(payload.turfSf).toBe(pricedTurfSf(edited));
    expect(payload.turfSf).toBeGreaterThan(profile.turfFallbackPreviewSf);
  });

  test('missing profile is a 400; junk profile degrades without throwing', async () => {
    expect((await invoke({})).status).toBe(400);
    expect((await invoke({ profile: [1, 2] })).status).toBe(400);
    const { status, payload } = await invoke({ profile: { lotSqFt: 'x', stories: -4 } });
    expect(status).toBe(200);
    expect(payload.turfSf).toBeGreaterThanOrEqual(0);
  });
});

describe('needsTurfManualConfirmation on unobservable profiles', () => {
  // Pre-push P1 r4 #3098: an unobservable-turf profile carries
  // estimatedTurfSf 0, so the existing >20k threshold never fires and the
  // engine's lot/hardscape fallback would price whole-lawn services with no
  // measurement. The estimator-authority rule routes that to confirmation.
  const { needsTurfManualConfirmation } = require('../routes/property-lookup-v2');

  function unobservableProfile(extra = {}) {
    return {
      ...buildEnrichedProfile(newBuildRecord(), bareDirtAi(), 27.58, -82.42),
      ...extra,
    };
  }

  test('whole-lawn pricing without a measurement is blocked', () => {
    const gate = needsTurfManualConfirmation(unobservableProfile(), ['LAWN'], {});
    expect(gate).not.toBeNull();
    expect(gate.field).toBe('measuredTurfSf');
    expect(gate.turfObservation).toBe('unobservable');
  });

  test('a confirmed measurement clears the gate', () => {
    expect(needsTurfManualConfirmation(unobservableProfile({ measuredTurfSf: 4500 }), ['LAWN'], {})).toBeNull();
  });

  test('bounded-area add-ons keep their exemption', () => {
    expect(needsTurfManualConfirmation(unobservableProfile(), ['TOPDRESS'], { topDressArea: 800 })).toBeNull();
  });

  test('commercial profiles are gated too — commercial lawn auto-prices in the pilot', () => {
    // The commercial filter used to strip LAWN before the gate ran,
    // letting a conflicted commercial profile price unverified fallback
    // turf through priceCommercialLawn (pre-push P1 r6 #3098).
    const commercial = unobservableProfile({ isCommercial: true, propertyType: 'Commercial' });
    const gate = needsTurfManualConfirmation(commercial, ['LAWN'], {});
    expect(gate).not.toBeNull();
    expect(gate.turfObservation).toBe('unobservable');
  });

  test('non-turf services and normal profiles are untouched', () => {
    expect(needsTurfManualConfirmation(unobservableProfile(), ['PEST'], {})).toBeNull();
    const paved = { ...bareDirtAi(), imperviousSurfacePercent: 85, imperviosSurfacePercent: 85 };
    const normal = buildEnrichedProfile(newBuildRecord(), paved, 27.58, -82.42);
    expect(needsTurfManualConfirmation(normal, ['LAWN'], {})).toBeNull();
  });
});
