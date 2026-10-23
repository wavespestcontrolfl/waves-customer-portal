// Public quote: the Tree & Shrub open-parcel bed basis never reads the
// body's homeSqFt (unauthenticated). The route hands the pricer the footprint
// from the SERVER-SIDE lookup row only, and tells it whether such a footprint
// exists at all — absent, the pricer parks the lot-based line for review
// instead of publishing a bed inferred from a number nobody vouched for
// (Codex #6398 security r11: a 50,000 sf lot with a claimed 20,000 sf home
// stayed under the half-lot heuristic and shrank the bed and the price).
const { _internals } = require('../routes/public-quote');

const { trustedTreeShrubFootprintSqFt, isResidentialVerificationHold } = _internals;

describe('isResidentialVerificationHold', () => {
  test('the open-parcel holds on a RESIDENTIAL T&S line are property-confirmation holds, never the commercial fallback (Codex #6398 r22)', () => {
    const residential = { service: 'tree_shrub', requiresManualReview: true, manualReviewReasons: ['open_parcel_basis_unconfirmed_footprint'] };
    expect(isResidentialVerificationHold('open_parcel_basis_unconfirmed_footprint', residential)).toBe(true);
    expect(isResidentialVerificationHold('open_parcel_basis_footprint_over_half_lot', residential)).toBe(true);
    // No parked line at all (the reason came from another leg) still reads residential.
    expect(isResidentialVerificationHold('open_parcel_basis_unconfirmed_footprint', null)).toBe(true);
    // The pricer lists bed_area_at_or_above_8000 FIRST, so the selected reason
    // is the large-bed one while the open-parcel hold sits later in the list
    // (Codex #6398 r23): the whole list decides.
    const largeBed = { service: 'tree_shrub', requiresManualReview: true, manualReviewReasons: ['bed_area_at_or_above_8000', 'open_parcel_basis_unconfirmed_footprint'] };
    expect(isResidentialVerificationHold('bed_area_at_or_above_8000', largeBed)).toBe(true);
    expect(isResidentialVerificationHold('bed_area_at_or_above_8000', { ...largeBed, manualReviewReasons: ['bed_area_at_or_above_8000'] })).toBe(false);
  });
  test('the same reason strings on the COMMERCIAL program keep the commercial copy', () => {
    const commercial = { service: 'commercial_tree_shrub', requiresManualReview: true, manualReviewReasons: ['open_parcel_basis_unconfirmed_footprint'] };
    expect(isResidentialVerificationHold('open_parcel_basis_unconfirmed_footprint', commercial)).toBe(false);
    expect(isResidentialVerificationHold('open_parcel_basis_footprint_over_half_lot', commercial)).toBe(false);
    expect(isResidentialVerificationHold('bed_area_at_or_above_8000', { ...commercial, manualReviewReasons: ['bed_area_at_or_above_8000', 'open_parcel_basis_unconfirmed_footprint'] })).toBe(false);
  });
  test('the existing residential verification reasons are unchanged; unknown reasons are not holds', () => {
    expect(isResidentialVerificationHold('lot_size_requires_verification', { service: 'commercial_pest' })).toBe(true);
    expect(isResidentialVerificationHold('bed_area_at_or_above_8000', { service: 'tree_shrub' })).toBe(false);
    expect(isResidentialVerificationHold(null, null)).toBe(false);
  });
});

describe('trustedTreeShrubFootprintSqFt', () => {
  const V = { storiesSource: 'verified' };

  test('prefers the lookup footprint, then footprintSqFt, building, then living area per story', () => {
    expect(trustedTreeShrubFootprintSqFt({ ...V, footprint: 1600, footprintSqFt: 1850, homeSqFt: 3700, stories: 2 })).toBe(1600);
    expect(trustedTreeShrubFootprintSqFt({ ...V, footprintSqFt: 1850, homeSqFt: 3700, stories: 2 })).toBe(1850);
    expect(trustedTreeShrubFootprintSqFt({ ...V, buildingSqFt: 2400, homeSqFt: 9000 })).toBe(2400);
    expect(trustedTreeShrubFootprintSqFt({ ...V, homeSqFt: 3700, stories: 2 })).toBe(1850);
    expect(trustedTreeShrubFootprintSqFt({ ...V, livingAreaSqFt: 3000, stories: 3 })).toBe(1000);
  });

  test('every trusted story provenance is accepted; stories clamp to 1–3', () => {
    for (const storiesSource of ['ai', 'permit', 'verified', 'manual']) {
      expect(trustedTreeShrubFootprintSqFt({ storiesSource, homeSqFt: 3000, stories: 2 })).toBe(1500);
    }
    expect(trustedTreeShrubFootprintSqFt({ ...V, homeSqFt: 3000, stories: 9 })).toBe(1000);
    expect(trustedTreeShrubFootprintSqFt({ ...V, homeSqFt: 3000, stories: 0 })).toBe(3000);
  });

  test('a defaulted or missing story count yields NO trusted footprint, even with a lookup footprint present (Codex security r13)', () => {
    // The lookup footprint IS living area ÷ stories; with storiesSource
    // 'default' the lookup fell back to 1 and a 15,000 sf three-story home
    // would pass as a 15,000 sf footprint. The body's story count is not an
    // argument at all, so nothing here can read it.
    expect(trustedTreeShrubFootprintSqFt({ storiesSource: 'default', stories: 1, footprint: 15000, homeSqFt: 15000 })).toBeNull();
    expect(trustedTreeShrubFootprintSqFt({ stories: 1, footprint: 2000, homeSqFt: 2000 })).toBeNull();
    expect(trustedTreeShrubFootprintSqFt({ storiesSource: 'guess', footprint: 2000 })).toBeNull();
  });

  test('no server-measured building → null (the pricer parks the lot-based line)', () => {
    expect(trustedTreeShrubFootprintSqFt({ ...V })).toBeNull();
    expect(trustedTreeShrubFootprintSqFt(null)).toBeNull();
    expect(trustedTreeShrubFootprintSqFt({ ...V, footprintSqFt: 0, homeSqFt: 0 })).toBeNull();
    expect(trustedTreeShrubFootprintSqFt({ ...V, footprintSqFt: 'n/a', homeSqFt: -5 })).toBeNull();
  });

  test('a footprintUnknown lookup yields NO trusted footprint — never a reconstruction from the aggregate homeSqFt (Codex r13 P1)', () => {
    // buildEnrichedProfile suppresses the footprint of an aggregate parcel
    // whose story count is unknown but keeps the summed living area.
    expect(trustedTreeShrubFootprintSqFt({ ...V, footprint: 0, footprintUnknown: true, homeSqFt: 48000, stories: 1 })).toBeNull();
    expect(trustedTreeShrubFootprintSqFt({ ...V, footprintSqFt: 0, footprintUnknown: true })).toBeNull();
    // A positive footprint does not override the suppression marker.
    expect(trustedTreeShrubFootprintSqFt({ ...V, footprint: 2000, footprintUnknown: true })).toBeNull();
  });
});
