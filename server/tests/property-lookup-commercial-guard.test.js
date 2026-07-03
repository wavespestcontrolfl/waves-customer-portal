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
} = routePrivate;

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

  test('trusts county / hybrid / cadastral merges even when the field is flagged', () => {
    for (const source of ['county', 'hybrid', 'cadastral']) {
      expect(recordCommercialSignalTrusted(untrustedAiRecord({ _source: source }))).toBe(true);
    }
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
  test('Gateway Ave profile comes back residential with the type preserved for the verify flag', () => {
    const profile = buildEnrichedProfile(untrustedAiRecord(), {}, 27.26, -82.51);
    expect(profile.category).toBe('RESIDENTIAL');
    expect(profile.isCommercial).toBe(false);
    expect(profile.commercialSubtype).toBeNull();
    expect(profile.commercialDetectionSource).toBeNull();
    // The unverified value stays visible (it already carries a field-verify
    // flag in the UI) — the guard only stops it from driving pricing.
    expect(profile.propertyType).toBe('Multifamily');
  });

  test('county-backed commercial profile is unchanged', () => {
    const profile = buildEnrichedProfile(countyCommercialRecord(), {}, 27.26, -82.51);
    expect(profile.category).toBe('COMMERCIAL');
    expect(profile.isCommercial).toBe(true);
  });
});
