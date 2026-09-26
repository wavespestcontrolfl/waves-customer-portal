/**
 * Property-lookup-v2 commercial-suite sizing (owner ruling 2026-09-25,
 * server/services/commercial-suite-size/): a COMMERCIAL manual lookup on a
 * part-building/multi-tenant suite address must never hand the operator the
 * whole building's sqft as the quotable size. buildEnrichedProfile stays
 * synchronous (dozens of existing tests call it directly, un-awaited) and
 * only stashes a candidate; applyCommercialSuiteSize (the async half) is
 * what this file exercises.
 *
 * The whole lane is OPT-IN (primary review of PR #4840): buildEnrichedProfile
 * only looks for a suite at all when passed `{ commercialSuiteSizing: true }`
 * as its 8th argument — the flag `performPropertyLookup` threads through
 * from the admin lookup route and the estimator engine's
 * gatherPropertySignals. Public callers never pass it.
 */

// Suite sizing ships dark behind GATE_COMMERCIAL_SUITE_SIZING; these tests exercise it ON.
process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true';

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/commercial-suite-size');

const { resolveCommercialSuiteSize } = require('../services/commercial-suite-size');
const { _private: routePrivate, buildEnrichedProfile } = require('../routes/property-lookup-v2');

const SUITE_SIZING_ON = { commercialSuiteSizing: true };

function plazaSuiteRecord(overrides = {}) {
  return {
    formattedAddress: '4400 Test Commons Pkwy E #102, Bradenton, FL 00000',
    propertyType: 'Commercial',
    squareFootage: 46031,
    unitCount: 1,
    _source: 'county',
    _parcel: { landUseDescription: 'Community Shopping Centers (1555)' },
    _fieldEvidence: {
      propertyType: { value: 'Commercial', confidence: 'high', sourceType: 'county', fieldVerify: false, score: 100 },
    },
    ...overrides,
  };
}

const SUITE_ADDRESS = '4400 Test Commons Pkwy E #102, Bradenton, FL 00000';
const BUILDING_ADDRESS = '4400 Test Commons Pkwy E, Bradenton, FL 00000';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('opt-in gating — the whole lane is OFF unless commercialSuiteSizing:true', () => {
  test('a suite address with the flag OMITTED: no candidate, no zeroing, homeSqFt stays the (wrong, but byte-identical-to-before-this-feature) building total', () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS);
    expect(profile.homeSqFt).toBe(46031);
    expect(profile.suiteBuildingTotalSqFt).toBeUndefined();
    expect(profile.suiteSize).toBeUndefined();
    expect(profile._commercialSuiteCandidate).toBeNull();
  });

  test('the same address WITH the flag: candidate is created and homeSqFt is zeroed pending resolution', () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    expect(profile.homeSqFt).toBe(0);
    expect(profile._commercialSuiteCandidate).toEqual(expect.objectContaining({ buildingSqft: 46031 }));
  });

  test('a stamped record is ignored entirely when the flag is off — no sync reuse, no suiteSize field at all', () => {
    const stamp = { value: 1400, source: 'license_seats', unitKey: '102', resolvedAt: new Date().toISOString() };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS,
    );
    expect(profile.homeSqFt).toBe(46031);
    expect(profile.suiteSize).toBeUndefined();
  });
});

describe('buildEnrichedProfile (flag on) stashes a candidate but never leaks building sqft as homeSqFt', () => {
  test('suite address on a commercial record: homeSqFt is 0 pending resolution, suiteBuildingTotalSqFt carries the total', () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    expect(profile.isCommercial).toBe(true);
    expect(profile.homeSqFt).toBe(0);
    expect(profile.suiteBuildingTotalSqFt).toBe(46031);
    expect(profile._commercialSuiteCandidate).toEqual(expect.objectContaining({ buildingSqft: 46031 }));
  });

  test('bare building address (no suite/unit): unaffected, homeSqFt is the building total as before', () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, BUILDING_ADDRESS, SUITE_SIZING_ON);
    expect(profile.isCommercial).toBe(true);
    expect(profile.homeSqFt).toBe(46031);
    expect(profile.suiteBuildingTotalSqFt).toBeUndefined();
    expect(profile._commercialSuiteCandidate).toBeNull();
  });

  test('freestanding building whose address carries a suite: no multi-tenant evidence, keeps the county building size', () => {
    const record = plazaSuiteRecord({ _parcel: { landUseDescription: 'Stores, One Story (1100)' } });
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    expect(profile.isCommercial).toBe(true);
    expect(profile.homeSqFt).toBe(46031);
    expect(profile.suiteBuildingTotalSqFt).toBeUndefined();
    expect(profile._commercialSuiteCandidate).toBeNull();
  });

  test('residential lookup (no commercial signal): no candidate at all', () => {
    const profile = buildEnrichedProfile(
      { formattedAddress: SUITE_ADDRESS, propertyType: 'Single Family', squareFootage: 1800, _source: 'county' },
      null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    expect(profile.isCommercial).toBe(false);
    expect(profile._commercialSuiteCandidate).toBeNull();
  });

  test('a suite already stamped on the record (persisted by a prior fresh lookup) is reused synchronously — no candidate at all', () => {
    const stamp = {
      value: 1400, source: 'license_seats', confidence: 'medium', unitKey: '102',
      businessName: 'Test Taco Shop', evidence: [{ source: 'license_seats', detail: '25 seats -> 1,400 sq ft' }], seats: 25,
      resolvedAt: new Date().toISOString(),
    };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    expect(profile.homeSqFt).toBe(1400);
    expect(profile.footprint).toBe(1400);
    expect(profile.suiteBuildingTotalSqFt).toBe(46031);
    expect(profile.suiteSize).toEqual(stamp);
    // Already resolved — nothing pending for applyCommercialSuiteSize.
    expect(profile._commercialSuiteCandidate).toBeNull();
  });

  test('a stamped office_retail plaza reconciles to restaurant synchronously, same as a fresh resolution', () => {
    const stamp = { value: 1400, source: 'license_seats', businessName: 'Test Taco Shop', unitKey: '102', resolvedAt: new Date().toISOString() };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    expect(profile.commercialSubtype).toBe('restaurant');
  });
});

describe('grounds blanking — a suite never inherits the plaza\'s lot/pool/stories/satellite reads (primary review PR #4840 r5 P1, shared with residentialUnitLookup)', () => {
  test('lot, pool, stories, and building count are all blanked — not just squareFootage', () => {
    const record = plazaSuiteRecord({
      lotSize: 93940,
      hasPool: true,
      poolCageSqft: 900,
      stories: 2,
      _parcel: { landUseDescription: 'Community Shopping Centers (1555)', buildingCount: 3 },
    });
    const profile = buildEnrichedProfile(record, { estimatedTreeCount: 40, waterProximity: 'CLOSE' }, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    expect(profile.isCommercial).toBe(true);
    expect(profile.homeSqFt).toBe(0); // pending resolution — unaffected by this fix
    expect(profile.lotSqFt).toBe(0);
    expect(profile.pool).not.toBe('YES');
    expect(profile.poolCage).not.toBe('YES');
    // The building's floor count would derive a fractional footprint from
    // the suite's own sq ft once resolved — a suite is single-level, same
    // assumption a residential unit gets.
    expect(profile.stories).toBe(1);
    expect(profile.storiesSource).toBe('default');
    expect(profile.buildingCount).toBe(1);
    // Every satellite/vision read describes the PARCEL — dropped whole, same
    // as residentialUnitLookup, so a plaza's tree canopy never becomes this
    // one suite's landscape estimate.
    expect(profile.estimatedTreeCount).toBeFalsy();
    expect(profile.waterProximity).not.toBe('CLOSE');
  });

  test('the resolved suite size is applied ON TOP of the blanked grounds — lot/pool/stories stay blanked even after resolution', async () => {
    resolveCommercialSuiteSize.mockResolvedValue({
      value: 1400, source: 'license_seats', confidence: 'medium', evidence: [],
    });
    const record = plazaSuiteRecord({ lotSize: 93940, hasPool: true, stories: 2 });
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.homeSqFt).toBe(1400); // the suite's own resolved size...
    expect(profile.footprint).toBe(1400);
    expect(profile.lotSqFt).toBe(0); // ...but the plaza's grounds never come back
    expect(profile.pool).not.toBe('YES');
    expect(profile.stories).toBe(1);
  });

  test('control: a genuine whole-building commercial lookup keeps its real lot/pool/stories (unaffected)', () => {
    const record = plazaSuiteRecord({
      lotSize: 93940,
      hasPool: true,
      stories: 2,
      _parcel: { landUseDescription: 'Community Shopping Centers (1555)', buildingCount: 3 },
    });
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, BUILDING_ADDRESS, SUITE_SIZING_ON);
    expect(profile._commercialSuiteCandidate).toBeNull();
    expect(profile.lotSqFt).toBe(93940);
    expect(profile.pool).toBe('YES');
    expect(profile.stories).toBe(2);
    expect(profile.buildingCount).toBe(3);
  });
});

describe('a stamp expires after its source-specific max age (license_seats: 30 days)', () => {
  test('a fresh (1-day-old) license_seats stamp is reused', () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const stamp = { value: 1400, source: 'license_seats', unitKey: '102', resolvedAt: oneDayAgo };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    expect(profile.homeSqFt).toBe(1400);
    expect(profile._commercialSuiteCandidate).toBeNull();
  });

  test('a 31-day-old license_seats stamp is ignored — falls back to a pending candidate (re-resolve)', () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const stamp = { value: 1400, source: 'license_seats', unitKey: '102', resolvedAt: thirtyOneDaysAgo };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    expect(profile.homeSqFt).toBe(0);
    expect(profile._commercialSuiteCandidate).toEqual(expect.objectContaining({ buildingSqft: 46031 }));
  });

  test('a stamp with no resolvedAt at all (a pre-fix legacy row) is treated as stale for a max-aged source', () => {
    const stamp = { value: 1400, source: 'license_seats', unitKey: '102' };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    expect(profile.homeSqFt).toBe(0);
  });

  test('a suite_type_default stamp (no max age defined) is reused however old', () => {
    const tenYearsAgo = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const stamp = { value: 1500, source: 'suite_type_default', unitKey: '102', resolvedAt: tenYearsAgo };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    expect(profile.homeSqFt).toBe(1500);
    expect(profile._commercialSuiteCandidate).toBeNull();
  });
});

describe('applyCommercialSuiteSize — the async resolution', () => {
  test('folds the resolved suite value in, keeps the building total, and never leaks _commercialSuiteCandidate', async () => {
    resolveCommercialSuiteSize.mockResolvedValue({
      value: 1400, source: 'license_seats', confidence: 'medium',
      businessName: 'Test Taco Shop', businessType: 'restaurant_food', seats: 25,
      evidence: [{ source: 'license_seats', detail: '25 seats -> 1,400 sq ft' }],
    });
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    await routePrivate.applyCommercialSuiteSize(profile);

    expect(profile.homeSqFt).toBe(1400);
    expect(profile.suiteBuildingTotalSqFt).toBe(46031); // the building total is never dropped, only not double-counted as homeSqFt
    expect(profile.suiteSize).toEqual(expect.objectContaining({
      value: 1400, source: 'license_seats', businessName: 'Test Taco Shop', seats: 25,
    }));
    // Stamped with a resolution timestamp for the freshness check.
    expect(Number.isFinite(Date.parse(profile.suiteSize.resolvedAt))).toBe(true);
    expect(profile._commercialSuiteCandidate).toBeUndefined();
  });

  test('reconciles the plaza-fallback office_retail subtype to restaurant on a food-service match', async () => {
    resolveCommercialSuiteSize.mockResolvedValue({
      value: 1400, source: 'license_seats', confidence: 'medium', businessName: 'Test Taco Shop', businessType: 'restaurant_food',
      evidence: [],
    });
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    expect(profile.commercialSubtype).toBe('office_retail'); // the plaza's generic pre-resolution subtype
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.commercialSubtype).toBe('restaurant');
  });

  test('a non-suite profile (no candidate) is a no-op and never calls the resolver', async () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, BUILDING_ADDRESS, SUITE_SIZING_ON);
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(resolveCommercialSuiteSize).not.toHaveBeenCalled();
    expect(profile.homeSqFt).toBe(46031);
  });

  test('a profile whose suite was already resolved via a persisted stamp never calls the resolver either — zero network on reuse', async () => {
    const stamp = { value: 1400, source: 'license_seats', businessName: 'Test Taco Shop', unitKey: '102', resolvedAt: new Date().toISOString() };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(resolveCommercialSuiteSize).not.toHaveBeenCalled();
    expect(profile.homeSqFt).toBe(1400);
  });

  test('a resolver failure is fail-open: the profile keeps its pending (0) homeSqFt rather than throwing', async () => {
    resolveCommercialSuiteSize.mockRejectedValue(new Error('boom'));
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    await expect(routePrivate.applyCommercialSuiteSize(profile)).resolves.toBe(profile);
    expect(profile.homeSqFt).toBe(0);
  });

  test('passes skipWebSearch through to the resolver (cached-lookup fast path), and never a buildingSqft param', async () => {
    resolveCommercialSuiteSize.mockResolvedValue(null);
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    await routePrivate.applyCommercialSuiteSize(profile, { skipWebSearch: true });
    expect(resolveCommercialSuiteSize).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ skipWebSearch: true }),
    );
    const resolveArg = resolveCommercialSuiteSize.mock.calls[0][0];
    expect(resolveArg.buildingSqft).toBeUndefined();
  });

  test('cacheOnly: never calls the resolver even with a pending candidate — reuse a persisted stamp only', async () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    await routePrivate.applyCommercialSuiteSize(profile, { cacheOnly: true });
    expect(resolveCommercialSuiteSize).not.toHaveBeenCalled();
    expect(profile.homeSqFt).toBe(0);
  });

  test('cacheOnly with an already-reused stamp: still a no-op (nothing pending to resolve)', async () => {
    const stamp = { value: 1400, source: 'license_seats', unitKey: '102', resolvedAt: new Date().toISOString() };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    await routePrivate.applyCommercialSuiteSize(profile, { cacheOnly: true });
    expect(resolveCommercialSuiteSize).not.toHaveBeenCalled();
    expect(profile.homeSqFt).toBe(1400);
  });
});

describe('a tech-verified sqft outranks the suite resolver', () => {
  test('verified squareFootage on a plaza suite: no candidate, the verified size stays the size', () => {
    const record = plazaSuiteRecord({
      squareFootage: 1650,
      _verifiedFields: ['squareFootage'],
      _fieldEvidence: {
        propertyType: { value: 'Commercial', confidence: 'high', sourceType: 'county', fieldVerify: false, score: 100 },
        squareFootage: { value: 1650, confidence: 'high', sourceType: 'verified' },
      },
    });
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    expect(profile.homeSqFt).toBe(1650);
    expect(profile._commercialSuiteCandidate).toBeNull();
    // Still suite-scoped: the verified area is the footprint, never
    // re-derived from the building's story count downstream.
    expect(profile.suiteSize).toEqual(expect.objectContaining({ value: 1650, source: 'verified' }));
    expect(profile.footprint).toBe(1650);
  });

  // Primary review of PR #4840 r7 P1: a verified squareFootage saved BEFORE
  // suite scoping existed can be the lookup-prefilled WHOLE-BUILDING figure,
  // saved as "verified" under the unit address — the residential-unit path
  // already documents this exact risk for its own unit lookups.
  test('a LEGACY verified squareFootage that still reads like the whole building is NOT trusted as a suite measurement', () => {
    const record = plazaSuiteRecord({
      squareFootage: 46031, // unchanged by the "verification" — it's the building's own total
      _verifiedFields: ['squareFootage'],
      _fieldEvidence: {
        propertyType: { value: 'Commercial', confidence: 'high', sourceType: 'county', fieldVerify: false, score: 100 },
        squareFootage: {
          value: 46031, confidence: 'high', sourceType: 'verified',
          // applyVerifiedOverrides prepends the fresh 'verified' entry but
          // keeps the prior (pre-verification) evidence right behind it —
          // here that prior entry is the SAME 46,031 county total, proving
          // this "verification" never actually re-measured the suite.
          evidence: [
            { sourceType: 'verified', value: 46031 },
            { sourceType: 'county', value: 46031 },
          ],
        },
      },
    });
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    // Distrusted — treated like no stamp at all: the resolver runs (a
    // pending candidate is stashed), never a HIGH-confidence 'verified' size.
    expect(profile.homeSqFt).toBe(0);
    expect(profile._commercialSuiteCandidate).toEqual(expect.objectContaining({ buildingSqft: 46031 }));
    expect(profile.suiteSize).toBeNull();
    const flag = profile.fieldVerifyFlags.find((f) => f.field === 'squareFootage');
    expect(flag).toBeDefined();
    expect(flag.priority).toBe('HIGH');
    expect(flag.reason).toMatch(/46,031 sq ft is saved on this suite address/);
    expect(flag.reason).toMatch(/WHOLE BUILDING/);
  });

  test('a GENUINE suite-sized verified override (clearly below the building total) is trusted', () => {
    const record = plazaSuiteRecord({
      squareFootage: 1400, // the tech's own on-site suite measurement
      _verifiedFields: ['squareFootage'],
      _fieldEvidence: {
        propertyType: { value: 'Commercial', confidence: 'high', sourceType: 'county', fieldVerify: false, score: 100 },
        squareFootage: {
          value: 1400, confidence: 'high', sourceType: 'verified',
          // The prior (pre-verification) evidence still shows the building's
          // real total — proving the verified 1,400 is a genuine correction
          // to the suite's own size, not a repeat of the building figure.
          evidence: [
            { sourceType: 'verified', value: 1400 },
            { sourceType: 'county', value: 46031 },
          ],
        },
      },
    });
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    expect(profile.homeSqFt).toBe(1400);
    expect(profile._commercialSuiteCandidate).toBeNull();
    expect(profile.suiteSize).toEqual(expect.objectContaining({ value: 1400, source: 'verified' }));
    expect(profile.fieldVerifyFlags.find((f) => f.field === 'squareFootage')).toBeUndefined();
  });

  test('a legacy whole-building override is caught even when an AI unit-size figure precedes the county building figure', () => {
    const record = plazaSuiteRecord({
      squareFootage: 46031, // lookup-prefilled building total saved as "verified" under the unit address
      _verifiedFields: ['squareFootage'],
      _fieldEvidence: {
        propertyType: { value: 'Commercial', confidence: 'high', sourceType: 'county', fieldVerify: false, score: 100 },
        squareFootage: {
          value: 46031, confidence: 'high', sourceType: 'verified',
          evidence: [
            { sourceType: 'verified', value: 46031 },
            { sourceType: 'ai', value: 1400 }, // an AI leg's unit-level figure, listed first
            { sourceType: 'county', value: 46031 },
          ],
        },
      },
    });
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    // The building total is the LARGEST prior figure, so the whole-building
    // override is not trusted as a suite measurement.
    expect(profile.suiteSize?.source).not.toBe('verified');
    expect(profile.homeSqFt).not.toBe(46031);
  });

  test('a non-aggregated commercial condo keeps its own county folio measurement', () => {
    const record = plazaSuiteRecord({
      squareFootage: 1850,
      propertyType: 'Commercial Condo',
      _parcel: { landUseDescription: 'Commercial Condominium (1900)' },
    });
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON);
    expect(profile.homeSqFt).toBe(1850);
    expect(profile._commercialSuiteCandidate).toBeNull();
    expect(profile.suiteSize == null).toBe(true);
  });
});

describe('a cached suite stamp is reused only for the unit it sized', () => {
  test('a stamp from #104 is not reused for #102 — the resolver runs again', () => {
    const stamp = { value: 2200, source: 'license_seats', businessName: 'Other Shop', unitKey: '104', resolvedAt: new Date().toISOString() };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    expect(profile.homeSqFt).toBe(0);
    expect(profile._commercialSuiteCandidate).toEqual(expect.objectContaining({ buildingSqft: 46031 }));
  });
  test('an untagged legacy stamp is not reused', () => {
    const stamp = { value: 2200, source: 'license_seats', resolvedAt: new Date().toISOString() };
    const profile = buildEnrichedProfile(
      plazaSuiteRecord({ _commercialSuiteSize: stamp }), null, 27.5, -82.45, null, null, SUITE_ADDRESS, SUITE_SIZING_ON,
    );
    expect(profile._commercialSuiteCandidate).not.toBeNull();
  });
});

describe('subtype reconciliation evidence', () => {
  test('a web-search businessType alone never reclassifies office_retail', () => {
    const { reconcileCommercialSuiteSubtype } = require('../routes/property-lookup-v2')._private;
    if (typeof reconcileCommercialSuiteSubtype !== 'function') throw new Error('reconcileCommercialSuiteSubtype not exported');
    expect(reconcileCommercialSuiteSubtype('office_retail', { source: 'suite_type_default', businessType: 'restaurant' })).toBe('office_retail');
    expect(reconcileCommercialSuiteSubtype('office_retail', { source: 'license_seats' })).toBe('restaurant');
  });
});

describe('Codex r6: commercial Space designator is suite scope', () => {
  test('"Space 12" on a plaza record enters the suite path', () => {
    const address = '4400 Test Commons Pkwy E Space 12, Bradenton, FL 00000';
    const profile = buildEnrichedProfile(plazaSuiteRecord({ formattedAddress: address }), null, 27.5, -82.45, null, null, address, SUITE_SIZING_ON);
    expect(profile.homeSqFt).toBe(0);
    expect(profile._commercialSuiteCandidate).not.toBeNull();
  });
});
