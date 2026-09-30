/**
 * GATE_CALL_WHOLE_STRUCTURE_NO_UNIT (owner ruling 2026-09-30, call-booker gates
 * review item 7): a WDO inspection or termite pre-treat booked on a call is not
 * held because the address has no unit number. Never for interior condo /
 * apartment work, never when another address problem exists, never commercial.
 * Synthetic data only.
 */
const {
  applyWholeStructureUnitWaiver,
  isWholeStructureService,
  WHOLE_STRUCTURE_SERVICE_KEYS,
  canAutoRoute,
  computeDeterministicTriageFlags,
  suppressAddressFlagsForAV,
} = require('../services/call-triage-flags');
const { V2_DECISION_VERSION, V2_DECISION_VERSIONS } = require('../services/call-routing-gates');
const { wholeStructureUnitWaiverForCall } = require('../services/call-recording-processor')._test;

// Google's verdict for a duplex given without a unit: the building resolved,
// only the subpremise is missing, so deriveStatus returned `ambiguous`.
const AV_UNIT_MISSING = {
  status: 'ambiguous',
  granularity: 'PREMISE',
  inServiceArea: true,
  county: 'Manatee County',
  hasInferred: true,
  hasReplaced: false,
  hasUnconfirmed: false,
  normalized: { street_line_1: '100 Example Loop', city: 'Parrish', state: 'FL', postal_code: '34219' },
  missingComponents: ['subpremise'],
};

const CATALOG = [
  { service_key: 'wdo_inspection', name: 'WDO Inspection (Termite Letter)', short_name: 'WDO Inspect', category: 'inspection' },
  { service_key: 'termite_slab_pretreat', name: 'Slab Pre-Treat Termite Service', short_name: 'Slab Pre-Treat', category: 'termite' },
  { service_key: 'termite_pretreatment', name: 'Termite Pretreatment Service', short_name: 'Pre-Treat', category: 'termite' },
  { service_key: 'termite_spot_treatment', name: 'Termite Foam Drill Service', short_name: 'Foam Drill', category: 'termite' },
  { service_key: 'bed_bug_treatment', name: 'Bed Bug Treatment', short_name: 'Bed Bugs', category: 'pest' },
  { service_key: 'pest_control_one_time', name: 'General Pest Control', short_name: 'Pest One-Time', category: 'pest' },
];

function call(extracted, extra = {}) {
  return wholeStructureUnitWaiverForCall({
    addressValidation: AV_UNIT_MISSING,
    extracted,
    transcription: extra.transcription || '',
    services: CATALOG,
    property: { property_type: 'multi_family', ...(extra.property || {}) },
  });
}

describe('applyWholeStructureUnitWaiver (pure)', () => {
  const ok = { enabled: true, serviceKey: 'wdo_inspection', propertyType: 'multi_family', text: 'duplex WDO' };

  test('gate off returns the very same verdict object', () => {
    expect(applyWholeStructureUnitWaiver(AV_UNIT_MISSING, { ...ok, enabled: false })).toBe(AV_UNIT_MISSING);
    expect(applyWholeStructureUnitWaiver(AV_UNIT_MISSING, {})).toBe(AV_UNIT_MISSING);
  });

  test('gate on + allowlisted service + only the unit missing -> accepted verdict, evidence kept', () => {
    const out = applyWholeStructureUnitWaiver(AV_UNIT_MISSING, ok);
    expect(out).not.toBe(AV_UNIT_MISSING);
    expect(out.status).toBe('validated_accept');
    expect(out.missingComponents).toEqual([]);
    expect(out.wholeStructureUnitWaived).toEqual({ missingComponents: ['subpremise'], originalStatus: 'ambiguous' });
    // The input is never mutated (the persisted shadow row keeps the original).
    expect(AV_UNIT_MISSING.status).toBe('ambiguous');
    expect(AV_UNIT_MISSING.missingComponents).toEqual(['subpremise']);
  });

  test('the allowlist is small and explicit', () => {
    expect([...WHOLE_STRUCTURE_SERVICE_KEYS].sort()).toEqual([
      'termite_liquid', 'termite_pretreatment', 'termite_slab_pretreat', 'termite_trenching', 'wdo_inspection',
    ]);
    for (const key of ['termite_spot_treatment', 'termite_bait', 'termite_monitoring', 'bed_bug_treatment', 'pest_control_one_time', 'termite_bond_5yr']) {
      expect(isWholeStructureService({ serviceKey: key })).toBe(false);
    }
    // A resolved catalog row outranks the coarse label.
    expect(isWholeStructureService({ serviceKey: 'bed_bug_treatment', coarseLabel: 'WDO Inspection' })).toBe(false);
    expect(isWholeStructureService({ coarseLabel: 'WDO Inspection' })).toBe(true);
    expect(isWholeStructureService({ coarseLabel: 'Termite Inspection' })).toBe(false);
    expect(isWholeStructureService({})).toBe(false);
  });

  test.each([
    ['another missing component', { ...AV_UNIT_MISSING, missingComponents: ['subpremise', 'street_number'] }],
    ['below PREMISE granularity', { ...AV_UNIT_MISSING, granularity: 'ROUTE' }],
    ['out of service area', { ...AV_UNIT_MISSING, inServiceArea: false }],
    ['unknown county', { ...AV_UNIT_MISSING, inServiceArea: null }],
    ['unconfirmed components', { ...AV_UNIT_MISSING, hasUnconfirmed: true }],
    ['replaced components', { ...AV_UNIT_MISSING, hasReplaced: true }],
    ['a different status shape', { ...AV_UNIT_MISSING, missingComponents: [] }],
  ])('another address problem (%s) keeps the hold', (_label, av) => {
    expect(applyWholeStructureUnitWaiver(av, ok)).toBe(av);
  });

  test.each([
    ['condo type', { propertyType: 'condo' }],
    ['unknown type', { propertyType: 'unknown' }],
    ['no type', { propertyType: undefined }],
    ['commercial', { propertyType: 'commercial', commercial: true }],
    ['commercial flag on a house', { commercial: true }],
    ['condo wording', { text: 'inspection for the condo on the second floor' }],
    ['apartment wording', { text: 'it is an apartment building' }],
  ])('property shape (%s) keeps the hold', (_label, patch) => {
    expect(applyWholeStructureUnitWaiver(AV_UNIT_MISSING, { ...ok, ...patch })).toBe(AV_UNIT_MISSING);
  });
});

describe('call-level waiver (service resolved the way the booking resolves it)', () => {
  test('WDO inspection at a duplex with no unit is waived', () => {
    const picked = call({ specific_service_name: 'WDO Inspection (Termite Letter)', requested_service: 'WDO inspection for a duplex sale' });
    expect(picked.status).toBe('validated_accept');
    expect(picked.wholeStructureUnitWaived.service).toBe('wdo_inspection');
    // A coarse label with no catalog pick is allowlisted too.
    const coarse = call({ matched_service: 'WDO Inspection', requested_service: 'WDO inspection for a duplex sale' });
    expect(coarse.status).toBe('validated_accept');
  });

  test('WDO named only in the transcript (coarse label, no catalog pick) is waived', () => {
    const out = call({ requested_service: 'wood destroying organism inspection' }, {
      transcription: 'Agent: Are you buying it? Caller: yes, the duplex, I need the WDO letter.',
    });
    expect(out.status).toBe('validated_accept');
  });

  test('termite pre-treat and slab pre-treat are waived', () => {
    const pre = call({ specific_service_name: 'Termite Pretreatment Service', matched_service: 'Termite Pretreatment Service' });
    expect(pre.status).toBe('validated_accept');
    expect(pre.wholeStructureUnitWaived.service).toBe('termite_pretreatment');
    const slab = call({ specific_service_name: 'Slab Pre-Treat Termite Service', requested_service: 'pre-slab termite treatment for new construction' });
    expect(slab.status).toBe('validated_accept');
    expect(slab.wholeStructureUnitWaived.service).toBe('termite_slab_pretreat');
  });

  test('interior pest treatment in a condo with no unit stays held', () => {
    const extracted = { matched_service: 'General Pest Control', requested_service: 'roaches inside my condo' };
    expect(call(extracted, { property: { property_type: 'condo' }, transcription: 'roaches in my condo kitchen' })).toBe(AV_UNIT_MISSING);
    // Even typed as multi-family, an interior pest service is not on the list.
    expect(call(extracted)).toBe(AV_UNIT_MISSING);
  });

  test('bed bugs stay held', () => {
    expect(call({ matched_service: 'Bed Bug Treatment', requested_service: 'bed bugs' })).toBe(AV_UNIT_MISSING);
  });

  test('a unit-level WDO in a condo stays held', () => {
    const extracted = { matched_service: 'WDO Inspection', requested_service: 'WDO inspection' };
    expect(call(extracted, { property: { property_type: 'condo' } })).toBe(AV_UNIT_MISSING);
    expect(call(extracted, { transcription: 'Caller: it is a condominium unit we are buying' })).toBe(AV_UNIT_MISSING);
  });

  test('spot/foam termite work is not whole-structure and stays held', () => {
    expect(call({ specific_service_name: 'Termite Foam Drill Service' })).toBe(AV_UNIT_MISSING);
  });

  test('commercial stays held', () => {
    const extracted = { matched_service: 'WDO Inspection', requested_service: 'WDO inspection' };
    expect(call(extracted, { property: { property_type: 'commercial' } })).toBe(AV_UNIT_MISSING);
    expect(call(extracted, { property: { hoa_common_area_service: true } })).toBe(AV_UNIT_MISSING);
  });

  test('a V1 allowlisted pick that the V2-approved booking replaces stays held (V1/V2 service disagreement)', () => {
    const v1Wdo = { matched_service: 'WDO Inspection', requested_service: 'WDO inspection' };
    const v2 = (svc) => ({
      meta: { schema_version: '1.20.0' },
      property: { property_type: 'multi_family' },
      service_request: svc,
    });
    const run = (extracted, v2Extraction) => wholeStructureUnitWaiverForCall({
      addressValidation: AV_UNIT_MISSING, extracted, services: CATALOG, v2Extraction,
    });
    // V2 says bed bugs (category maps one-to-one, so it overrides V1 at booking).
    expect(run(v1Wdo, v2({ primary_service_category: 'bed_bug', specific_service_name: null }))).toBe(AV_UNIT_MISSING);
    // V2 names a catalog service that is not whole-structure.
    expect(run(v1Wdo, v2({ primary_service_category: 'pest_general', specific_service_name: 'Bed Bug Treatment' }))).toBe(AV_UNIT_MISSING);
    expect(run(v1Wdo, v2({ primary_service_category: 'termite', specific_service_name: 'Termite Foam Drill Service' }))).toBe(AV_UNIT_MISSING);
    // The reverse: V1 interior pest, V2 WDO. V1's own pick still governs the gate view.
    expect(run({ matched_service: 'General Pest Control', requested_service: 'pest control' },
      v2({ primary_service_category: 'wdo', specific_service_name: null }))).toBe(AV_UNIT_MISSING);
    // Both views on the list: waived.
    expect(run(v1Wdo, v2({ primary_service_category: 'wdo', specific_service_name: 'WDO Inspection (Termite Letter)' })).status)
      .toBe('validated_accept');
  });

  test('an allowlisted service with another address problem stays held', () => {
    const extracted = { matched_service: 'WDO Inspection', requested_service: 'WDO inspection' };
    const out = wholeStructureUnitWaiverForCall({
      addressValidation: { ...AV_UNIT_MISSING, hasUnconfirmed: true },
      extracted, services: CATALOG, property: { property_type: 'multi_family' },
    });
    expect(out.status).toBe('ambiguous');
  });
});

describe('routing effect', () => {
  function extraction() {
    return {
      meta: { is_voicemail: false, is_spam: false, call_summary: 'Duplex WDO inspection.' },
      caller: {
        first_name: 'Test', last_name: 'Caller', phone_e164: '+19415550100', phone_source: 'spoken',
        relationship_to_property: 'owner', on_site_authorization: true,
      },
      consent: { sms_consent_given: true, do_not_contact_request: false },
      property: {
        service_address: { street_line_1: '100 Example Loop', city: 'Parrish', state: 'FL', postal_code: '34219', county: 'Manatee' },
        property_type: 'multi_family', hoa_community_flag: false, hoa_common_area_service: false,
      },
      service_request: { primary_service_category: 'wdo_inspection' },
      customer_history: { status: 'new_customer', prior_complaint_mentioned: false },
      scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-05T10:00:00-04:00' },
      sentiment_and_lead: { sentiment: 'neutral', lead_quality: 'hot' },
      confidence: { service_address: 0.95, overall: 0.92 },
      triage_flags: [],
    };
  }
  const opts = (av) => ({ contactPhone: '+19415550100', addressValidation: av });
  const waived = applyWholeStructureUnitWaiver(AV_UNIT_MISSING, {
    enabled: true, serviceKey: 'wdo_inspection', propertyType: 'multi_family', text: '',
  });

  test('without the waiver the unit-less duplex is held on the address (today)', () => {
    const flags = computeDeterministicTriageFlags(extraction(), opts(AV_UNIT_MISSING));
    expect(flags).toEqual(expect.arrayContaining(['address_unverified', 'missing_unit_number']));
    const route = canAutoRoute(extraction(), opts(AV_UNIT_MISSING));
    expect(route.allowed).toBe(false);
  });

  test('with the waiver: no address flag, no unit ask, and the booking auto-routes', () => {
    const flags = computeDeterministicTriageFlags(extraction(), opts(waived));
    expect(flags).not.toContain('address_unverified');
    expect(flags).not.toContain('missing_unit_number');
    expect(suppressAddressFlagsForAV(['missing_unit_number', 'address_unverified'], waived)).not.toContain('address_unverified');
    expect(canAutoRoute(extraction(), opts(waived)).allowed).toBe(true);
  });

  test('a waived commercial call still holds on the commercial rule', () => {
    const e = extraction();
    e.property.property_type = 'commercial';
    const route = canAutoRoute(e, opts(waived));
    expect(route.allowed).toBe(false);
    expect(computeDeterministicTriageFlags(e, opts(waived))).toContain('commercial_requires_quote');
  });

  test('every other address check still applies to a waived verdict', () => {
    const e = extraction();
    e.property.service_address.county = 'Lee';
    // The waiver does not touch a county-level model signal.
    expect(computeDeterministicTriageFlags(e, opts(waived))).not.toContain('address_unverified');
    const outOfArea = { ...waived, inServiceArea: false };
    expect(canAutoRoute(extraction(), opts(outOfArea)).allowed).toBe(false);
  });
});

describe('gate wiring', () => {
  const ENV = 'GATE_CALL_WHOLE_STRUCTURE_NO_UNIT';
  function gateWith(value) {
    const saved = process.env[ENV];
    if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
    try {
      let out;
      jest.isolateModules(() => {
        out = require('../config/feature-gates').isEnabled('callWholeStructureNoUnit');
      });
      return out;
    } finally {
      if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
    }
  }

  test('strict opt-in: off unless exactly "true"', () => {
    expect(gateWith(undefined)).toBe(false);
    expect(gateWith('')).toBe(false);
    expect(gateWith('1')).toBe(false);
    expect(gateWith('TRUE')).toBe(false);
    expect(gateWith('true')).toBe(true);
  });

  test('the processor reads the gate and hands the waiver only the pure helper', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain("isEnabled('callWholeStructureNoUnit') && isMissingUnitNumber(v2AddressValidation)");
    // The persisted shadow row is written BEFORE the waiver rewrites the verdict.
    expect(src.indexOf('ai_address_validation: v2AddressValidation')).toBeLessThan(src.lastIndexOf('wholeStructureUnitWaiverForCall({'));
  });

  test('decision version bumped past #5371 and listed', () => {
    expect(V2_DECISION_VERSION).toBe('v2-1.52.0');
    expect(V2_DECISION_VERSIONS[V2_DECISION_VERSIONS.length - 1]).toBe(V2_DECISION_VERSION);
    expect(new Set(V2_DECISION_VERSIONS).size).toBe(V2_DECISION_VERSIONS.length);
  });
});
