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

// Condo/townhome resident misclassification: county rolls file these
// communities as building-level "Multifamily" master parcels, so a unit-less
// address resolves to the association's whole building and a resident's
// lookup prices commercial. The guidance flag names the fix without touching
// the classification itself. Fixture address is synthetic.
describe('multifamily master-parcel guidance flag', () => {
  const { buildFieldVerifyFlags } = routePrivate;

  function countyMultifamilyBuilding(overrides = {}) {
    return {
      formattedAddress: '1 Example Building Way, Testville, FL 00000',
      propertyType: 'Multifamily',
      unitCount: 8,
      squareFootage: 63096,
      lotSize: 93940,
      stories: 2,
      _source: 'county',
      ...overrides,
    };
  }

  test('county Multifamily building parcel → HIGH guidance naming the unit count and the resident path', () => {
    const flags = buildFieldVerifyFlags(countyMultifamilyBuilding(), null, null);
    const flag = flags.find((f) => f.field === 'commercialSubtype');
    expect(flag).toBeDefined();
    expect(flag.priority).toBe('HIGH');
    expect(flag.reason).toMatch(/8-unit/);
    expect(flag.reason).toMatch(/master parcel/i);
    expect(flag.reason).toMatch(/unit number/i);
    expect(flag.reason).toMatch(/association, complex owner, or property manager/i);
  });

  test('HOA common-area parcel subtype gets the same guidance (no unit-count prefix at 1)', () => {
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({ propertyType: 'HOA Common Area', unitCount: 1 }), null, null
    );
    const flag = flags.find((f) => f.field === 'commercialSubtype');
    expect(flag).toBeDefined();
    expect(flag.reason).not.toMatch(/\d-unit/);
  });

  test('true commercial (office) → no master-parcel guidance even with unitCount > 4', () => {
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({ propertyType: 'Office Building' }), null, null
    );
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('residential single-family → no guidance', () => {
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({ propertyType: 'Single Family', unitCount: 1, squareFootage: 1200 }), null, null
    );
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('untrusted AI-only Multifamily (Gateway Ave shape) classifies residential → no guidance either', () => {
    const flags = buildFieldVerifyFlags(untrustedAiRecord(), null, null);
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('legacy AI record without field evidence classifies commercial but gets no county-master copy (codex P1)', () => {
    // No _fieldEvidence → recordCommercialSignalTrusted trusts it for
    // CLASSIFICATION (legacy-cache compatibility), but the guidance asserts
    // county-roll provenance the record does not have.
    const legacy = { formattedAddress: '2 Example Building Way, Testville, FL 00000', propertyType: 'Multifamily', unitCount: 8, _source: 'ai' };
    expect(detectCategory(legacy, {})).toBe('COMMERCIAL');
    const flags = buildFieldVerifyFlags(legacy, null, null);
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('hybrid whose Multifamily type came from an unverified web hit → no county-master copy (codex P1)', () => {
    // County evidence exists on OTHER fields, but the type field itself is
    // web-sourced (and not fieldVerify-flagged, so classification trusts it).
    const hybrid = countyMultifamilyBuilding({
      _source: 'hybrid',
      _parcel: undefined,
      _fieldEvidence: {
        propertyType: { value: 'Multifamily', sourceType: 'listing', fieldVerify: false, score: 40 },
        lotSize: { value: 93940, sourceType: 'county', fieldVerify: false, score: 100 },
      },
    });
    expect(detectCategory(hybrid, {})).toBe('COMMERCIAL');
    const flags = buildFieldVerifyFlags(hybrid, null, null);
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('verified/permit/builder type sources do not pass the county-roll gate (codex P1)', () => {
    // Authoritative for classification, but not the county roll — the copy
    // claims county provenance, so only county/cadastral evidence earns it.
    for (const sourceType of ['verified', 'permit', 'builder']) {
      const flags = buildFieldVerifyFlags(countyMultifamilyBuilding({
        _source: 'hybrid',
        _fieldEvidence: { propertyType: { value: 'Multifamily', sourceType, fieldVerify: false, score: 90 } },
      }), null, null);
      expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
    }
  });

  test('per-field dimension provenance: verified sqft is excluded from the building-wide claim (codex P1)', () => {
    const flag = buildFieldVerifyFlags(countyMultifamilyBuilding({
      _fieldEvidence: {
        squareFootage: { value: 1200, sourceType: 'verified', fieldVerify: false, score: 100 },
      },
    }), null, null).find((f) => f.field === 'commercialSubtype');
    expect(flag).toBeDefined();
    expect(flag.reason).toMatch(/lot, stories are the WHOLE BUILDING'S/);
    expect(flag.reason).not.toMatch(/sq ft, lot, stories/);
  });

  test('all dimensions tech-verified → no building-wide dimension claim, exit steps remain', () => {
    const verified = (value) => ({ value, sourceType: 'verified', fieldVerify: false, score: 100 });
    const flag = buildFieldVerifyFlags(countyMultifamilyBuilding({
      _fieldEvidence: {
        squareFootage: verified(1200), lotSize: verified(500), stories: verified(2),
      },
    }), null, null).find((f) => f.field === 'commercialSubtype');
    expect(flag).toBeDefined();
    expect(flag.reason).not.toMatch(/WHOLE BUILDING/);
    expect(flag.reason).toMatch(/set Commercial to No/i);
  });

  test('hybrid whose type evidence IS county-sourced → guidance fires', () => {
    const hybrid = countyMultifamilyBuilding({
      _source: 'hybrid',
      _fieldEvidence: {
        propertyType: { value: 'Multifamily', sourceType: 'county', fieldVerify: false, score: 100 },
      },
    });
    expect(buildFieldVerifyFlags(hybrid, null, null).find((f) => f.field === 'commercialSubtype')).toBeDefined();
  });

  test('untrusted web-sourced unit count neither proves a master parcel nor gets echoed (trustedUnitCount)', () => {
    const withUntrustedCount = (overrides = {}) => countyMultifamilyBuilding({
      _source: 'hybrid',
      _fieldEvidence: {
        propertyType: { value: 'Multifamily', sourceType: 'county', fieldVerify: false, score: 100 },
        unitCount: { value: 8, sourceType: 'listing', fieldVerify: true, score: 30 },
      },
      ...overrides,
    });
    // Without other master-parcel evidence the untrusted count proves nothing.
    expect(buildFieldVerifyFlags(withUntrustedCount(), null, null)
      .find((f) => f.field === 'commercialSubtype')).toBeUndefined();
    // With aggregation evidence the flag fires but never echoes the web count.
    const flag = buildFieldVerifyFlags(withUntrustedCount({ _parcel: { aggregated: true } }), null, null)
      .find((f) => f.field === 'commercialSubtype');
    expect(flag).toBeDefined();
    expect(flag.reason).not.toMatch(/8-unit/);
  });

  test('satellite-AI multifamily signal on a county single-family record → no master-parcel guidance (codex P1)', () => {
    // The AI signal may legitimately flip the CATEGORY, but the guidance copy
    // asserts county master-parcel provenance — it must only fire when the
    // trusted RECORD itself carries the multifamily/HOA evidence.
    const ai = { propertyUse: 'COMMERCIAL', commercialUseType: 'MULTIFAMILY_COMMON_AREA' };
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({ propertyType: 'Single Family', unitCount: 1, squareFootage: 1400 }), ai, null
    );
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('guidance instructs the full commercial exit, not just a type override (codex P1)', () => {
    const flag = buildFieldVerifyFlags(countyMultifamilyBuilding(), null, null)
      .find((f) => f.field === 'commercialSubtype');
    expect(flag.reason).toMatch(/set Property Type to the actual unit type/i);
    expect(flag.reason).toMatch(/set Commercial to No/i);
    expect(flag.reason).toMatch(/clear the Commercial Subtype/i);
    // The prefilled dimensions are the building's — the copy must demand
    // unit-specific dimensions before the resident path is priced (codex P0).
    expect(flag.reason).toMatch(/WHOLE BUILDING/);
    expect(flag.reason).toMatch(/sq ft and stories from the customer|replace home\/lot/i);
    // The flag renders directly above the "Save … as field-verified" button
    // (EstimateToolViewV2) — the copy must defuse that footgun explicitly
    // (codex P1): saving would pin the building's dimensions to the address.
    expect(flag.reason).toMatch(/Do NOT save these as field-verified/);
  });

  test('generic Multifamily and apartment records → customer-supplied unit dimensions, no re-lookup recommendation (codex P1)', () => {
    // Generic "Multifamily" covers rental buildings whose units have no
    // separate parcels — only positive condo/townhome or aggregation
    // evidence earns the re-lookup recommendation.
    for (const propertyType of ['Multifamily', 'Apartments']) {
      const flags = buildFieldVerifyFlags(
        countyMultifamilyBuilding({ propertyType, unitCount: 24 }), null, null
      );
      const flag = flags.find((f) => f.field === 'commercialSubtype');
      expect(flag).toBeDefined();
      expect(flag.reason).toMatch(/from the customer/i);
      expect(flag.reason).not.toMatch(/re-run the lookup/i);
    }
  });

  test('condo/townhome record text → re-lookup path (unit parcels exist)', () => {
    for (const propertyType of ['Multifamily Condominium', 'Multifamily Townhouse']) {
      const flag = buildFieldVerifyFlags(
        countyMultifamilyBuilding({ propertyType }), null, null
      ).find((f) => f.field === 'commercialSubtype');
      expect(flag).toBeDefined();
      expect(flag.reason).toMatch(/re-run the lookup/i);
    }
  });

  test('county match for ONE condo unit (own parcel, unitCount 1) → no master-parcel copy (codex P1)', () => {
    // A unit-specific lookup that matched the unit's own parcel has CORRECT
    // dimensions — it must not be told they belong to the whole building.
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({ propertyType: 'Multifamily Condominium', unitCount: 1, squareFootage: 1200 }), null, null
    );
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('real aggregate shape (unitCount 1, _parcel.residentialUnits 48) → flag fires with the aggregate count', () => {
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({ unitCount: 1, _parcel: { aggregated: true, residentialUnits: 48 } }), null, null
    );
    const flag = flags.find((f) => f.field === 'commercialSubtype');
    expect(flag).toBeDefined();
    expect(flag.reason).toMatch(/48-unit/);
  });

  test('NON-STACKED county master polygon (unitCount 1, _parcel.residentialUnits 48, no aggregated) → flag fires (codex P1)', () => {
    // The commonest master shape: county GIS returns ONE multifamily master
    // parcel rather than stacked unit parcels, so attachParcelMeta records the
    // assessed unit total but leaves `aggregated` unset and unitCount at 1.
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({ unitCount: 1, _parcel: { residentialUnits: 48 } }), null, null
    );
    const flag = flags.find((f) => f.field === 'commercialSubtype');
    expect(flag).toBeDefined();
    expect(flag.reason).toMatch(/48-unit/);
  });

  test('a single condo unit parcel (residentialUnits 1) still gets no master-parcel copy', () => {
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({
        propertyType: 'Multifamily Condominium', unitCount: 1, squareFootage: 1200,
        _parcel: { residentialUnits: 1 },
      }), null, null
    );
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('a runaway parcel unit count is bounded, not echoed verbatim', () => {
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({ unitCount: 1, _parcel: { residentialUnits: 999999 } }), null, null
    );
    const flag = flags.find((f) => f.field === 'commercialSubtype');
    expect(flag).toBeDefined();
    expect(flag.reason).toMatch(/2000-unit/);
    expect(flag.reason).not.toMatch(/999999/);
  });

  test('a TECH-VERIFIED propertyType override on a county record gets no county-roll copy (codex P2)', () => {
    // applyVerifiedOverrides rewrites the field evidence to 'verified' but
    // leaves _source at 'county' — the copy must not credit the roll.
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({
        _fieldEvidence: { propertyType: { sourceType: 'verified', value: 'Multifamily' } },
      }), null, null
    );
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('a verified override cannot ride the AGGREGATED arm into county-roll copy either (codex P2)', () => {
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({
        propertyType: 'HOA Common Area',
        _parcel: { aggregated: true, residentialUnits: 30 },
        _fieldEvidence: { propertyType: { sourceType: 'verified', value: 'HOA Common Area' } },
      }), null, null
    );
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeUndefined();
  });

  test('county field evidence on a NON-county _source record still passes the gate', () => {
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({
        _source: 'hybrid',
        _fieldEvidence: { propertyType: { sourceType: 'county', value: 'Multifamily' } },
      }), null, null
    );
    expect(flags.find((f) => f.field === 'commercialSubtype')).toBeDefined();
  });

  test('aggregated parcel labeled Apartment still gets the re-lookup path (aggregation is built from unit parcels)', () => {
    const flags = buildFieldVerifyFlags(
      countyMultifamilyBuilding({ propertyType: 'Apartment', _parcel: { aggregated: true } }), null, null
    );
    const flag = flags.find((f) => f.field === 'commercialSubtype');
    expect(flag).toBeDefined();
    expect(flag.reason).toMatch(/re-run the lookup/i);
  });

  test('the instructed exit actually leaves commercial pricing per the real classifier (codex P1)', () => {
    // Property Type left at Commercial defeats the Commercial=No override —
    // exactly the trap the copy warns about.
    expect(isCommercialProfile({ propertyType: 'Commercial', isCommercial: 'no', commercialSubtype: null })).toBe(true);
    // The instructed exit: concrete residential unit type + Commercial=No.
    // Even a stale category/subtype no longer holds it commercial.
    expect(isCommercialProfile({
      propertyType: 'condo_upper', isCommercial: 'no', commercialSubtype: null, category: 'COMMERCIAL',
    })).toBe(false);
  });

  test('guidance rides the enriched profile without changing the commercial verdict', () => {
    const profile = buildEnrichedProfile(countyMultifamilyBuilding(), {}, 27.5, -82.45);
    expect(profile.category).toBe('COMMERCIAL');
    expect(profile.isCommercial).toBe(true);
    expect(profile.commercialSubtype).toBe('multifamily_common_area_residential');
    expect(profile.fieldVerifyFlags.find((f) => f.field === 'commercialSubtype')).toBeDefined();
  });
});
