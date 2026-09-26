/**
 * The unauthenticated estimator lookup returns and stores the enriched
 * profile for the requested parcel only (docs/public-route-contracts.md).
 * The admin lookup's plat-median estimate — plat name, county, and the
 * neighbors' sample/range for an unassessed vacant parcel — is staff-only
 * context and must never ride the public response or the lead snapshot.
 */
const { _test: { publicEnrichedProfile, publicLookupMeta, publicLookupErrors } } = require('../routes/public-property-lookup');
const { VACANT_SQFT_FLAG_COPY } = require('../routes/property-lookup-v2');

describe('public lookup metadata — provider health stays staff-only', () => {
  it.each(['miss', 'hit', 'refresh'])('strips credential configuration and provider attempts on a cache %s', (cache) => {
    const parcelMeta = { cache, lookupMs: 1200, timestamp: '2026-01-01T12:00:00Z', budgetMs: 60000 };
    const providerStatus = {
      propertySearch: { claude: true, openai: true, gemini: true },
      satelliteVision: { gemini: { configured: true, available: false }, openai: { configured: true, available: true } },
      maps: true,
    };
    const adminMeta = { ...parcelMeta, providerStatus };
    expect(publicLookupMeta(adminMeta)).toEqual(parcelMeta);
    expect(adminMeta.providerStatus).toBe(providerStatus);
  });

  it('preserves cached metadata with no provider diagnostics', () => {
    const meta = { cache: 'hit', cachedAt: '2026-01-01T12:00:00Z', lookupMs: 2 };
    expect(publicLookupMeta(meta)).toEqual(meta);
  });
});

describe('public lookup errors — operational failures stay staff-only', () => {
  it('strips failed provider attempts and configuration messages without changing staff diagnostics', () => {
    const errors = [
      { source: 'gemini', message: 'Satellite vision analysis failed: no_key' },
      { source: 'openai', message: 'Satellite vision analysis failed: openai_503' },
      { source: 'claude', message: 'Claude analysis failed' },
      { source: 'ai', message: 'All AI vision models failed — check API keys' },
      { source: 'satellite', message: 'No GOOGLE_MAPS_API_KEY or GOOGLE_API_KEY configured' },
      { source: 'ai-property', message: 'Provider-specific diagnostic' },
    ];
    const before = JSON.stringify(errors);
    expect(publicLookupErrors(errors)).toEqual([]);
    expect(JSON.stringify(errors)).toBe(before);
  });

  it('preserves the known service-area verdict without copying arbitrary fields', () => {
    expect(publicLookupErrors([
      { source: 'geo', message: 'Unknown upstream error', diagnostic: 'private' },
      { source: 'geo', message: 'Outside SWFL service area', diagnostic: 'private' },
      { source: 'openai', message: 'Satellite vision analysis failed: invalid_schema' },
    ])).toEqual([{ source: 'geo', message: 'Outside SWFL service area' }]);
  });

  it('keeps successful responses free of errors', () => {
    expect(publicLookupErrors([])).toEqual([]);
    expect(publicLookupErrors(undefined)).toEqual([]);
  });
});

describe('publicEnrichedProfile — plat median stays out of the public payload', () => {
  it('drops subdivisionMedian and keeps every other field', () => {
    const enriched = {
      homeSqFt: 0,
      lotSqFt: 9541,
      unassessedVacantParcel: true,
      subdivisionMedian: { medianSqft: 3071, sampleCount: 174, minSqft: 2101, maxSqft: 3242, subdivision: 'EXAMPLE PLAT PH VI', county: 'Manatee' },
      fieldVerifyFlags: [{ field: 'vacantParcel', priority: 'HIGH', reason: 'x' }],
    };
    const out = publicEnrichedProfile(enriched);
    expect(out).toEqual({
      homeSqFt: 0,
      lotSqFt: 9541,
      unassessedVacantParcel: true,
      fieldVerifyFlags: [{ field: 'vacantParcel', priority: 'HIGH', reason: 'x' }],
    });
    expect('subdivisionMedian' in out).toBe(false);
    // Never mutates the lookup result the admin path also reads.
    expect(enriched.subdivisionMedian.medianSqft).toBe(3071);
  });

  it('scrubs the homeSqFt flag prose that spells the same figures out', () => {
    const enriched = {
      homeSqFt: 0,
      subdivisionMedian: { medianSqft: 3071, sampleCount: 174, minSqft: 2101, maxSqft: 3242 },
      fieldVerifyFlags: [
        { field: 'vacantParcel', priority: 'HIGH', reason: 'County roll shows Vacant Residential Platted (1554) with no building record' },
        { field: 'homeSqFt', priority: 'HIGH', reason: 'Prefilled with the median of 174 assessed homes in this plat, 3,071 sq ft (range 2,101–3,242)' },
        { field: 'yearBuilt', priority: 'MEDIUM', reason: 'Year built missing' },
      ],
    };
    const out = publicEnrichedProfile(enriched);
    expect(JSON.stringify(out)).not.toMatch(/3,071|174 assessed|2,101|3,242/);
    expect(out.fieldVerifyFlags[1]).toEqual({ field: 'homeSqFt', priority: 'HIGH', reason: VACANT_SQFT_FLAG_COPY });
    expect(out.fieldVerifyFlags[0]).toEqual(enriched.fieldVerifyFlags[0]);
    expect(out.fieldVerifyFlags[2]).toEqual(enriched.fieldVerifyFlags[2]);
    // Without a median block the flags pass through untouched.
    const plain = publicEnrichedProfile({ homeSqFt: 0, fieldVerifyFlags: enriched.fieldVerifyFlags });
    expect(plain.fieldVerifyFlags).toBe(enriched.fieldVerifyFlags);
  });

  it('passes null / non-object profiles through as null', () => {
    expect(publicEnrichedProfile(null)).toBeNull();
    expect(publicEnrichedProfile(undefined)).toBeNull();
  });
});

describe('public payload never carries suite-sizing fields (Codex #4840 r6 P0)', () => {
  test('publicEnrichedProfile strips unitScopedLookup, suiteSize and suiteBuildingTotalSqFt', () => {
    const { publicEnrichedProfile } = require('../routes/public-property-lookup')._test;
    const out = publicEnrichedProfile({
      homeSqFt: 1400, unitScopedLookup: true, suiteSize: { value: 1400 }, suiteBuildingTotalSqFt: 46031,
    });
    expect(out).not.toHaveProperty('unitScopedLookup');
    expect(out).not.toHaveProperty('suiteSize');
    expect(out).not.toHaveProperty('suiteBuildingTotalSqFt');
    expect(out.homeSqFt).toBe(1400);
  });
});
