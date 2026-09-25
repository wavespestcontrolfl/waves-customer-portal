/**
 * Property-lookup-v2 commercial-suite sizing (owner ruling 2026-09-25,
 * server/services/commercial-suite-size/): a COMMERCIAL manual lookup on a
 * part-building/multi-tenant suite address must never hand the operator the
 * whole building's sqft as the quotable size. buildEnrichedProfile stays
 * synchronous (dozens of existing tests call it directly, un-awaited) and
 * only stashes a candidate; applyCommercialSuiteSize (the async half) is
 * what this file exercises.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/commercial-suite-size');

const { resolveCommercialSuiteSize } = require('../services/commercial-suite-size');
const { _private: routePrivate, buildEnrichedProfile } = require('../routes/property-lookup-v2');

function plazaSuiteRecord(overrides = {}) {
  return {
    formattedAddress: '4400 Test Commons Pkwy E #102, Bradenton, FL 00000',
    propertyType: 'Commercial',
    squareFootage: 46031,
    unitCount: 1,
    _source: 'county',
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

describe('buildEnrichedProfile stashes a candidate but never leaks building sqft as homeSqFt', () => {
  test('suite address on a commercial record: homeSqFt is 0 pending resolution, buildingSqFt carries the total', () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS);
    expect(profile.isCommercial).toBe(true);
    expect(profile.homeSqFt).toBe(0);
    expect(profile.buildingSqFt).toBe(46031);
    expect(profile._commercialSuiteCandidate).toEqual(expect.objectContaining({ buildingSqft: 46031 }));
  });

  test('bare building address (no suite/unit): unaffected, homeSqFt is the building total as before', () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, BUILDING_ADDRESS);
    expect(profile.isCommercial).toBe(true);
    expect(profile.homeSqFt).toBe(46031);
    expect(profile.buildingSqFt).toBeUndefined();
    expect(profile._commercialSuiteCandidate).toBeNull();
  });

  test('residential lookup (no commercial signal): no candidate at all', () => {
    const profile = buildEnrichedProfile(
      { formattedAddress: SUITE_ADDRESS, propertyType: 'Single Family', squareFootage: 1800, _source: 'county' },
      null, 27.5, -82.45, null, null, SUITE_ADDRESS,
    );
    expect(profile.isCommercial).toBe(false);
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
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS);
    await routePrivate.applyCommercialSuiteSize(profile);

    expect(profile.homeSqFt).toBe(1400);
    expect(profile.buildingSqFt).toBe(46031); // the building total is never dropped, only not double-counted as homeSqFt
    expect(profile.suiteSize).toEqual(expect.objectContaining({
      value: 1400, source: 'license_seats', businessName: 'Test Taco Shop', seats: 25,
    }));
    expect(profile._commercialSuiteCandidate).toBeUndefined();
  });

  test('reconciles the plaza-fallback office_retail subtype to restaurant on a food-service match', async () => {
    resolveCommercialSuiteSize.mockResolvedValue({
      value: 1400, source: 'license_seats', confidence: 'medium', businessName: 'Test Taco Shop', businessType: 'restaurant_food',
      evidence: [],
    });
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS);
    expect(profile.commercialSubtype).toBe('office_retail'); // the plaza's generic pre-resolution subtype
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(profile.commercialSubtype).toBe('restaurant');
  });

  test('a non-suite profile (no candidate) is a no-op and never calls the resolver', async () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, BUILDING_ADDRESS);
    await routePrivate.applyCommercialSuiteSize(profile);
    expect(resolveCommercialSuiteSize).not.toHaveBeenCalled();
    expect(profile.homeSqFt).toBe(46031);
  });

  test('a resolver failure is fail-open: the profile keeps its pending (0) homeSqFt rather than throwing', async () => {
    resolveCommercialSuiteSize.mockRejectedValue(new Error('boom'));
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS);
    await expect(routePrivate.applyCommercialSuiteSize(profile)).resolves.toBe(profile);
    expect(profile.homeSqFt).toBe(0);
  });

  test('passes skipWebSearch through to the resolver (cached-lookup fast path)', async () => {
    resolveCommercialSuiteSize.mockResolvedValue(null);
    const profile = buildEnrichedProfile(plazaSuiteRecord(), null, 27.5, -82.45, null, null, SUITE_ADDRESS);
    await routePrivate.applyCommercialSuiteSize(profile, { skipWebSearch: true });
    expect(resolveCommercialSuiteSize).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ skipWebSearch: true }),
    );
  });
});
