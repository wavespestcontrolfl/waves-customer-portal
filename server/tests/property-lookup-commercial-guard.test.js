/**
 * Commercial-classification evidence guard.
 *
 * detectCategory used to regex-match rc.propertyType with no provenance
 * check, so an AI-web-search-only record whose type the merge itself flagged
 * for manual verification could flip a profile to commercial pricing on its
 * own. Real miss (2026-07-03): "6314 Gateway Ave, Sarasota" is not on the
 * county roll, the grounded web search landed on a LoopNet listing for a
 * different Gateway Ave parcel, and its "Multifamily" string
 * commercial-classified a residential lead at 0/100 data quality.
 *
 * The guard: record-derived commercial signals (propertyType / zoning /
 * land-use strings, unitCount) only vote when the record is county-backed,
 * carries no evidence metadata (verified overrides, legacy cache rows), or
 * the merged propertyType evidence passed field verification. Structured
 * satellite AI signals are unaffected — vision looked at THIS parcel.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { _private: routePrivate, buildEnrichedProfile } = require('../routes/property-lookup-v2');

const {
  recordCommercialSignalTrusted,
  detectCategory,
  resolveCommercialSubtype,
  resolveCommercialDetectionSource,
  isCommercialProfile,
} = routePrivate;

// A hybrid (county + AI) merge whose WINNING propertyType came from the county
// roll — authoritative even though disagreement raised the field-verify flag.
function hybridCountyWonRecord(overrides = {}) {
  return {
    formattedAddress: '77 County Line Rd, Parrish, FL 34219',
    propertyType: 'Commercial',
    unitCount: 1,
    _source: 'hybrid',
    _fieldEvidence: {
      propertyType: {
        value: 'Commercial', confidence: 'high', sourceType: 'county', fieldVerify: true, score: 100,
      },
    },
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

// The Gateway Ave shape: AI-trio-only merge, propertyType from an unknown
// web source (LoopNet), merge flagged the field for manual verification.
function untrustedAiRecord(overrides = {}) {
  return {
    formattedAddress: '6314 Gateway Ave, Sarasota, FL 34231',
    propertyType: 'Multifamily',
    squareFootage: 8640,
    lotSize: 25265,
    stories: 2,
    yearBuilt: 1964,
    unitCount: 1,
    _source: 'ai',
    _aiProviders: ['gemini'],
    _fieldEvidence: {
      propertyType: {
        value: 'Multifamily',
        confidence: 'low',
        sourceType: 'unknown',
        sourceLabel: 'unknown source',
        winningSource: 'https://www.loopnet.com/Listing/Gateway-Ave-Sarasota-FL/28250396/',
        fieldVerify: true,
        score: 30,
      },
    },
    ...overrides,
  };
}

function countyCommercialRecord(overrides = {}) {
  return {
    formattedAddress: '123 Main St, Bradenton, FL 34205',
    propertyType: 'Commercial',
    unitCount: 1,
    _source: 'county',
    _fieldEvidence: {
      propertyType: {
        value: 'Commercial',
        confidence: 'high',
        sourceType: 'county',
        fieldVerify: false,
        score: 100,
      },
    },
    ...overrides,
  };
}

describe('recordCommercialSignalTrusted', () => {
  test('distrusts an AI-only record whose propertyType is flagged for verification', () => {
    expect(recordCommercialSignalTrusted(untrustedAiRecord())).toBe(false);
  });

  test('trusts pure county / cadastral merges even when the field is flagged', () => {
    for (const source of ['county', 'cadastral']) {
      expect(recordCommercialSignalTrusted(untrustedAiRecord({ _source: source }))).toBe(true);
    }
  });

  test('distrusts a hybrid merge whose propertyType was won by an unverified web source (codex P1)', () => {
    // Sparse county fact merged with an AI "Multifamily" listing: _source is
    // hybrid but the WINNING propertyType is still the unverified web hit.
    expect(recordCommercialSignalTrusted(untrustedAiRecord({ _source: 'hybrid' }))).toBe(false);
  });

  test('trusts a hybrid merge when the county won the propertyType field', () => {
    // Authoritative county-won type on a hybrid record, flagged only because an
    // AI source disagreed — must still classify commercial (no regression).
    expect(recordCommercialSignalTrusted(hybridCountyWonRecord())).toBe(true);
  });

  test('trusts an AI record whose propertyType passed field verification', () => {
    const rc = untrustedAiRecord({
      _fieldEvidence: {
        propertyType: {
          value: 'Commercial', confidence: 'high', sourceType: 'listing', fieldVerify: false, score: 100,
        },
      },
    });
    expect(recordCommercialSignalTrusted(rc)).toBe(true);
  });

  test('trusts records with no evidence metadata (legacy cache rows, verified overrides)', () => {
    expect(recordCommercialSignalTrusted({ propertyType: 'Commercial' })).toBe(true);
    expect(recordCommercialSignalTrusted(null)).toBe(true);
  });
});

describe('detectCategory with the evidence guard', () => {
  test('Gateway Ave regression: unverified LoopNet "Multifamily" no longer flips COMMERCIAL', () => {
    expect(detectCategory(untrustedAiRecord(), {})).toBe('RESIDENTIAL');
  });

  test('county-sourced commercial still classifies COMMERCIAL', () => {
    expect(detectCategory(countyCommercialRecord(), {})).toBe('COMMERCIAL');
  });

  test('verified AI listing-source commercial still classifies COMMERCIAL', () => {
    const rc = untrustedAiRecord({
      propertyType: 'Commercial',
      _fieldEvidence: {
        propertyType: {
          value: 'Commercial', confidence: 'high', sourceType: 'listing', fieldVerify: false, score: 100,
        },
      },
    });
    expect(detectCategory(rc, {})).toBe('COMMERCIAL');
  });

  test('hybrid merge with an AI-won unverified Multifamily classifies RESIDENTIAL (codex P1)', () => {
    expect(detectCategory(untrustedAiRecord({ _source: 'hybrid' }), {})).toBe('RESIDENTIAL');
  });

  test('hybrid merge with a county-won commercial type still classifies COMMERCIAL', () => {
    expect(detectCategory(hybridCountyWonRecord(), {})).toBe('COMMERCIAL');
  });

  test('unitCount from an untrusted record cannot vote COMMERCIAL', () => {
    expect(detectCategory(untrustedAiRecord({ unitCount: 12 }), {})).toBe('RESIDENTIAL');
  });

  test('unitCount on a trusted record still votes COMMERCIAL', () => {
    expect(detectCategory(countyCommercialRecord({ propertyType: 'Single Family', unitCount: 12 }), {})).toBe('COMMERCIAL');
  });

  test('structured satellite AI signal still classifies COMMERCIAL on an untrusted record', () => {
    expect(detectCategory(untrustedAiRecord(), { propertyUse: 'COMMERCIAL' })).toBe('COMMERCIAL');
  });

  test('legacy record without evidence metadata keeps the old behavior', () => {
    expect(detectCategory({ propertyType: 'Commercial' }, {})).toBe('COMMERCIAL');
  });
});

describe('hybrid county land-use survives an untrusted type (codex rd2 P1)', () => {
  // A hybrid whose propertyType was won by an unverified web hit, but whose
  // county GIS donated authoritative land-use strings in _raw —
  // buildCadastralRecord deliberately carries these even when they can't be
  // normalized into a propertyType.
  function hybridMunicipalRecord(overrides = {}) {
    return untrustedAiRecord({
      _source: 'hybrid',
      _raw: { landUse: 'MUNICIPAL GOVERNMENT', zoning: '' },
      ...overrides,
    });
  }

  test('county municipal land-use still classifies COMMERCIAL despite the untrusted type', () => {
    expect(detectCategory(hybridMunicipalRecord(), {})).toBe('COMMERCIAL');
  });

  test('county common-area land-use still classifies COMMERCIAL', () => {
    expect(detectCategory(untrustedAiRecord({
      _source: 'hybrid',
      _raw: { landUse: 'HOA COMMON AREA' },
    }), {})).toBe('COMMERCIAL');
  });

  test('the untrusted type string itself is still suppressed on the hybrid', () => {
    // Same record, but land-use carries no commercial signal — the LoopNet
    // "Multifamily" alone must not flip it.
    expect(detectCategory(untrustedAiRecord({
      _source: 'hybrid',
      _raw: { landUse: 'VACANT RESIDENTIAL' },
    }), {})).toBe('RESIDENTIAL');
  });

  test('AI-only merges keep nothing — raw web strings stay suppressed', () => {
    expect(detectCategory(untrustedAiRecord({
      _raw: { landUse: 'MULTIFAMILY 10+ UNITS' },
    }), {})).toBe('RESIDENTIAL');
  });

  test('subtype resolves from the preserved county land-use', () => {
    expect(resolveCommercialSubtype(hybridMunicipalRecord(), {})).toBe('government_municipal');
  });

  test('web-sourced unverified unitCount on a hybrid cannot vote COMMERCIAL', () => {
    expect(detectCategory(untrustedAiRecord({
      _source: 'hybrid',
      unitCount: 12,
      _fieldEvidence: {
        ...untrustedAiRecord()._fieldEvidence,
        unitCount: { value: 12, sourceType: 'unknown', fieldVerify: true, score: 30 },
      },
    }), {})).toBe('RESIDENTIAL');
  });

  test('county-sourced unitCount on a hybrid still votes COMMERCIAL', () => {
    expect(detectCategory(untrustedAiRecord({
      _source: 'hybrid',
      unitCount: 12,
      _fieldEvidence: {
        ...untrustedAiRecord()._fieldEvidence,
        unitCount: { value: 12, sourceType: 'county', fieldVerify: false, score: 100 },
      },
    }), {})).toBe('COMMERCIAL');
  });
});

describe('parcel turf cap ignores untrusted types (codex rd2 P1)', () => {
  const { applyParcelTurfBound } = routePrivate;

  function oversizedTurfAnalysis() {
    return { estimatedTurfSf: 20000, propertyUse: 'RESIDENTIAL', commercialUseType: 'NONE' };
  }

  test('untrusted web-search Multifamily no longer skips the parcel cap', () => {
    const ai = oversizedTurfAnalysis();
    const rc = untrustedAiRecord({ _parcel: { polygonAreaSqft: 8000 } });
    applyParcelTurfBound(ai, rc);
    expect(ai.turfCappedToParcel).toBe(true);
    expect(ai.estimatedTurfSf).toBe(8000);
    expect(ai._turfPreCapSf).toBe(20000);
  });

  test('trusted county Multifamily still skips the cap (shared turf is legitimate)', () => {
    const ai = oversizedTurfAnalysis();
    const rc = countyCommercialRecord({
      propertyType: 'Multifamily',
      _parcel: { polygonAreaSqft: 8000 },
      _fieldEvidence: {
        propertyType: { value: 'Multifamily', sourceType: 'county', fieldVerify: false, score: 100 },
      },
    });
    applyParcelTurfBound(ai, rc);
    expect(ai.turfCappedToParcel).toBeUndefined();
    expect(ai.estimatedTurfSf).toBe(20000);
  });

  test('satellite-applied townhome still skips the cap (vision reclassifies before the cap by design)', () => {
    const ai = oversizedTurfAnalysis();
    const rc = untrustedAiRecord({
      propertyType: 'Interior Townhome',
      _parcel: { polygonAreaSqft: 8000 },
      _fieldEvidence: {
        propertyType: {
          value: 'Interior Townhome', sourceType: 'satellite', sourceLabel: 'satellite imagery', fieldVerify: true, score: 50,
        },
      },
    });
    applyParcelTurfBound(ai, rc);
    expect(ai.turfCappedToParcel).toBeUndefined();
    expect(ai.estimatedTurfSf).toBe(20000);
  });

  test('untrusted single-family shape still gets the ordinary cap (no regression)', () => {
    const ai = oversizedTurfAnalysis();
    const rc = untrustedAiRecord({ propertyType: 'Single Family', _parcel: { polygonAreaSqft: 8000 } });
    applyParcelTurfBound(ai, rc);
    expect(ai.turfCappedToParcel).toBe(true);
    expect(ai.estimatedTurfSf).toBe(8000);
  });
});

describe('subtype / detection-source respect the guard', () => {
  test('untrusted record text cannot pick the commercial subtype', () => {
    // Satellite says commercial; the LoopNet "Multifamily" string must not
    // steer the subtype to multifamily_common_area_residential. The result
    // matches what a record-less satellite signal alone produces.
    const withUntrustedRecord = resolveCommercialSubtype(untrustedAiRecord(), { propertyUse: 'COMMERCIAL' });
    expect(withUntrustedRecord).not.toBe('multifamily_common_area_residential');
    expect(withUntrustedRecord).toBe(resolveCommercialSubtype(null, { propertyUse: 'COMMERCIAL' }));
  });

  test('detection source reports satellite, not the untrusted property record', () => {
    expect(resolveCommercialDetectionSource(untrustedAiRecord(), { propertyUse: 'COMMERCIAL' }))
      .toBe('satellite_ai_property_use');
  });

  test('detection source still credits a trusted property record', () => {
    expect(resolveCommercialDetectionSource(countyCommercialRecord(), {}))
      .toBe('property_record_property_type');
  });
});

describe('buildEnrichedProfile end-to-end', () => {
  test('Gateway Ave profile comes back residential and cannot re-commercialize at pricing (codex P1)', () => {
    const profile = buildEnrichedProfile(untrustedAiRecord(), {}, 27.26, -82.51);
    expect(profile.category).toBe('RESIDENTIAL');
    expect(profile.isCommercial).toBe(false);
    expect(profile.commercialSubtype).toBeNull();
    expect(profile.commercialDetectionSource).toBeNull();
    // The untrusted commercial alias is suppressed from the PRICED field so it
    // can't flip the profile back to commercial via
    // isCommercialProfile → normalizePricingPropertyType. Direct proof:
    expect(profile.propertyType).toBe('Single Family');
    expect(isCommercialProfile(profile)).toBe(false);
    // …but the raw unverified value stays visible for the field-verify UI.
    expect(profile.fieldEvidence.propertyType.value).toBe('Multifamily');
  });

  test('county-backed commercial profile is unchanged', () => {
    const profile = buildEnrichedProfile(countyCommercialRecord(), {}, 27.26, -82.51);
    expect(profile.category).toBe('COMMERCIAL');
    expect(profile.isCommercial).toBe(true);
  });
});
