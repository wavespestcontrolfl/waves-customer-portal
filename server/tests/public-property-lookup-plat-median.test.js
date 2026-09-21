/**
 * The unauthenticated estimator lookup returns and stores the enriched
 * profile for the requested parcel only (docs/public-route-contracts.md).
 * The admin lookup's plat-median estimate — plat name, county, and the
 * neighbors' sample/range for an unassessed vacant parcel — is staff-only
 * context and must never ride the public response or the lead snapshot.
 */
const { _test: { publicEnrichedProfile } } = require('../routes/public-property-lookup');

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

  it('passes null / non-object profiles through as null', () => {
    expect(publicEnrichedProfile(null)).toBeNull();
    expect(publicEnrichedProfile(undefined)).toBeNull();
  });
});
