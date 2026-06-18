const {
  buildEnrichedProfile,
  needsTurfManualConfirmation,
  _private,
} = require('../routes/property-lookup-v2');

const { applyParcelTurfBound, parcelTurfBoundSqft, turfRiskReasons } = _private;

function recordFixture(overrides = {}) {
  return {
    formattedAddress: '2965 Rock Creek Dr, Port Charlotte, FL 33948',
    propertyType: 'Single Family',
    squareFootage: 1348,
    lotSize: 10043,
    stories: 1,
    _fieldEvidence: {
      lotSize: { sourceType: 'county' },
    },
    _parcel: {
      parcelId: '402217351013',
      county: 'Charlotte',
      polygonAreaSqft: 10085,
      lotSqft: 10043,
    },
    ...overrides,
  };
}

function analysisFixture(overrides = {}) {
  return {
    propertyUse: 'RESIDENTIAL',
    estimatedTurfSf: 24000,
    confidenceScore: 80,
    analysisNotes: 'base notes',
    ...overrides,
  };
}

describe('parcelTurfBoundSqft', () => {
  it('prefers the GIS polygon area', () => {
    expect(parcelTurfBoundSqft(recordFixture())).toEqual({ areaSqft: 10085, source: 'parcel_polygon' });
  });

  it('falls back to county/cadastral lot size only', () => {
    const noParcel = recordFixture({ _parcel: null });
    expect(parcelTurfBoundSqft(noParcel)).toEqual({ areaSqft: 10043, source: 'county' });

    const listingLot = recordFixture({ _parcel: null, _fieldEvidence: { lotSize: { sourceType: 'listing' } } });
    expect(parcelTurfBoundSqft(listingLot)).toBeNull();

    expect(parcelTurfBoundSqft(null)).toBeNull();
  });
});

describe('applyParcelTurfBound', () => {
  it('clamps an over-parcel estimate and keeps provenance', () => {
    const ai = analysisFixture();
    applyParcelTurfBound(ai, recordFixture());
    expect(ai.estimatedTurfSf).toBe(10085);
    expect(ai._turfPreCapSf).toBe(24000);
    expect(ai.turfCappedToParcel).toBe(true);
    expect(ai.turfCapSource).toBe('parcel_polygon');
    expect(ai.analysisNotes).toContain('base notes');
    expect(ai.analysisNotes).toContain('clamped to the parcel');
  });

  it('leaves in-bounds estimates untouched', () => {
    const ai = analysisFixture({ estimatedTurfSf: 6000 });
    applyParcelTurfBound(ai, recordFixture());
    expect(ai.estimatedTurfSf).toBe(6000);
    expect(ai.turfCappedToParcel).toBeUndefined();
  });

  it('never clamps condos, HOAs, or commercial use', () => {
    const condo = analysisFixture();
    applyParcelTurfBound(condo, recordFixture({ propertyType: 'Condo' }));
    expect(condo.estimatedTurfSf).toBe(24000);

    const commercial = analysisFixture({ propertyUse: 'COMMERCIAL' });
    applyParcelTurfBound(commercial, recordFixture());
    expect(commercial.estimatedTurfSf).toBe(24000);

    const hoa = analysisFixture();
    applyParcelTurfBound(hoa, recordFixture({ propertyType: 'HOA Common Area' }));
    expect(hoa.estimatedTurfSf).toBe(24000);
  });

  it('a structured commercial subtype exempts even when propertyUse stays RESIDENTIAL', () => {
    const hoaCommon = analysisFixture({ propertyUse: 'RESIDENTIAL', commercialUseType: 'HOA_COMMON_AREA' });
    applyParcelTurfBound(hoaCommon, recordFixture());
    expect(hoaCommon.estimatedTurfSf).toBe(24000);

    const multifamily = analysisFixture({ propertyUse: 'UNKNOWN', commercialUseType: 'MULTIFAMILY_COMMON_AREA' });
    applyParcelTurfBound(multifamily, recordFixture());
    expect(multifamily.estimatedTurfSf).toBe(24000);

    // The non-commercial sentinels do not exempt.
    const none = analysisFixture({ commercialUseType: 'NONE' });
    applyParcelTurfBound(none, recordFixture());
    expect(none.estimatedTurfSf).toBe(10085);
  });

  it('does nothing without a county-grade bound', () => {
    const ai = analysisFixture();
    applyParcelTurfBound(ai, recordFixture({ _parcel: null, _fieldEvidence: { lotSize: { sourceType: 'listing' } } }));
    expect(ai.estimatedTurfSf).toBe(24000);
    expect(ai.turfCappedToParcel).toBeUndefined();
  });
});

describe('turfRiskReasons clamp reason', () => {
  it('surfaces the clamp as a deterministic review reason', () => {
    const ai = analysisFixture();
    applyParcelTurfBound(ai, recordFixture());
    const reasons = turfRiskReasons({ ...ai, lotSqFt: 10043 });
    expect(reasons.some((r) => r.includes('clamped to 10,085 sq ft'))).toBe(true);
    expect(reasons.some((r) => r.includes('AI estimated 24,000'))).toBe(true);
  });

  it('stays silent when nothing was clamped', () => {
    const reasons = turfRiskReasons({ estimatedTurfSf: 6000, lotSqFt: 10043 });
    expect(reasons.some((r) => r.includes('clamped'))).toBe(false);
  });
});

describe('gate interaction (intentional behavior change)', () => {
  it('a clamped estimate below 20k no longer trips the manual-confirmation hard block', () => {
    const ai = analysisFixture(); // 24k AI guess
    applyParcelTurfBound(ai, recordFixture()); // clamped to 10,085

    const profile = buildEnrichedProfile(recordFixture(), ai, 26.99, -82.14);
    expect(profile.estimatedTurfSf).toBe(10085);
    expect(profile.turfCappedToParcel).toBe(true);

    // Pre-clamp, 24k > 20k would have blocked lawn pricing. The deterministic
    // bound replaces the manual gate for this failure mode.
    const confirmation = needsTurfManualConfirmation(profile, ['LAWN']);
    expect(confirmation).toBeNull();

    // ...but the review flag still fires via the clamp reason.
    const flag = profile.fieldVerifyFlags.find((f) => f.field === 'estimatedTurfSf');
    expect(flag).toBeTruthy();
    expect(flag.reason).toContain('clamped');
  });

  it('an unclamped over-20k estimate still blocks (no parcel bound available)', () => {
    const record = recordFixture({ _parcel: null, _fieldEvidence: { lotSize: { sourceType: 'listing' } }, lotSize: 30000 });
    const ai = analysisFixture(); // 24k, no bound to clamp against
    applyParcelTurfBound(ai, record);

    const profile = buildEnrichedProfile(record, ai, 26.99, -82.14);
    expect(profile.estimatedTurfSf).toBe(24000);
    const confirmation = needsTurfManualConfirmation(profile, ['LAWN']);
    expect(confirmation).not.toBeNull();
    expect(confirmation.field).toBe('measuredTurfSf');
  });

  it('exempts a top-dressing-only estimate when an explicit area is entered', () => {
    const record = recordFixture({ _parcel: null, _fieldEvidence: { lotSize: { sourceType: 'listing' } }, lotSize: 30000 });
    const ai = analysisFixture(); // 24k, over the 20k gate
    applyParcelTurfBound(ai, record);

    const profile = buildEnrichedProfile(record, ai, 26.99, -82.14);
    expect(profile.estimatedTurfSf).toBe(24000);

    // Without an explicit area, top dressing still blocks on the AI turf guess.
    expect(needsTurfManualConfirmation(profile, ['TOPDRESS'])).not.toBeNull();
    // An entered front/back-yard area is the exact priced area — no confirmation.
    expect(needsTurfManualConfirmation(profile, ['TOPDRESS'], { topDressArea: 4000 })).toBeNull();
  });

  it('exempts a Top Dressing + Plugging combo when both areas are entered', () => {
    const record = recordFixture({ _parcel: null, _fieldEvidence: { lotSize: { sourceType: 'listing' } }, lotSize: 30000 });
    const ai = analysisFixture(); // 24k, over the 20k gate
    applyParcelTurfBound(ai, record);

    const profile = buildEnrichedProfile(record, ai, 26.99, -82.14);
    expect(profile.estimatedTurfSf).toBe(24000);

    // Both bounded add-ons with explicit areas clear together.
    expect(
      needsTurfManualConfirmation(profile, ['TOPDRESS', 'PLUGGING'], { topDressArea: 4000, plugArea: 1000 }),
    ).toBeNull();
    // If one of them is missing its area, the gate still fires.
    expect(
      needsTurfManualConfirmation(profile, ['TOPDRESS', 'PLUGGING'], { topDressArea: 4000 }),
    ).not.toBeNull();
    // A whole-lawn service in the mix still requires confirmation.
    expect(
      needsTurfManualConfirmation(profile, ['TOPDRESS', 'LAWN'], { topDressArea: 4000 }),
    ).not.toBeNull();
  });
});

describe('enriched parcel block', () => {
  it('exposes the GIS parcel additively', () => {
    const profile = buildEnrichedProfile(recordFixture(), analysisFixture({ estimatedTurfSf: 6000 }), 26.99, -82.14);
    expect(profile.parcel).toEqual({
      parcelId: '402217351013',
      county: 'Charlotte',
      areaSqft: 10085,
      source: 'fdor_cadastral',
    });
  });

  it('is null without a parcel match', () => {
    const profile = buildEnrichedProfile(recordFixture({ _parcel: null }), analysisFixture({ estimatedTurfSf: 6000 }), 26.99, -82.14);
    expect(profile.parcel).toBeNull();
  });
});
