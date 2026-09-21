/**
 * The unauthenticated estimator lookup returns and stores the enriched
 * profile for the requested parcel only (docs/public-route-contracts.md).
 * The admin lookup's plat-median estimate — plat name, county, and the
 * neighbors' sample/range for an unassessed vacant parcel — is staff-only
 * context and must never ride the public response or the lead snapshot.
 */
const { _test: { publicEnrichedProfile } } = require('../routes/public-property-lookup');
const { VACANT_SQFT_FLAG_COPY } = require('../routes/property-lookup-v2');

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
