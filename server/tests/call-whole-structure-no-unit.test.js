/**
 * GATE_CALL_WHOLE_STRUCTURE_NO_UNIT (owner ruling 2026-09-30, call-booker gates
 * review item 7): a WDO inspection or termite pre-treat booked on a call is not
 * held because the address has no unit number. Never for interior condo /
 * apartment work, never when another address problem exists, never commercial.
 * Synthetic data only.
 */
const {
  applyWholeStructureUnitWaiver,
  reconstructWaivedAddressValidation,
  serviceMayForceAssessment,
  isWholeStructureService,
  WHOLE_STRUCTURE_SERVICE_KEYS,
  canAutoRoute,
  computeDeterministicTriageFlags,
  suppressAddressFlagsForAV,
} = require('../services/call-triage-flags');
const { V2_DECISION_VERSION, V2_DECISION_VERSIONS, resolveDecisionVersion, buildRouteDecision } = require('../services/call-routing-gates');
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
    // A coarse label with no catalog row never qualifies (codex #5378 r1 P1).
    expect(isWholeStructureService({ serviceKey: 'bed_bug_treatment', coarseLabel: 'WDO Inspection' })).toBe(false);
    expect(isWholeStructureService({ coarseLabel: 'WDO Inspection' })).toBe(false);
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
  test('WDO inspection at a duplex with no unit is waived when the catalog row resolves', () => {
    const picked = call({ specific_service_name: 'WDO Inspection (Termite Letter)', requested_service: 'WDO inspection for a duplex sale' });
    expect(picked.status).toBe('validated_accept');
    expect(picked.wholeStructureUnitWaived.service).toBe('wdo_inspection');
  });

  test('a coarse label with no catalog row stays held (catalog outage, inactive or non-bookable row)', () => {
    const extracted = { matched_service: 'WDO Inspection', requested_service: 'WDO inspection for a duplex sale' };
    // "WDO Inspection" alone names no catalog row in this catalog.
    expect(call(extracted)).toBe(AV_UNIT_MISSING);
    // The services query failed: no rows at all.
    expect(wholeStructureUnitWaiverForCall({
      addressValidation: AV_UNIT_MISSING, extracted, services: [], property: { property_type: 'multi_family' },
    })).toBe(AV_UNIT_MISSING);
    // The matching row exists but is not in the bookable list.
    expect(wholeStructureUnitWaiverForCall({
      addressValidation: AV_UNIT_MISSING,
      extracted: { specific_service_name: 'WDO Inspection (Termite Letter)' },
      services: CATALOG.filter((r) => r.service_key !== 'wdo_inspection'),
      property: { property_type: 'multi_family' },
    })).toBe(AV_UNIT_MISSING);
    // Transcript-only WDO, no catalog pick: still no row.
    expect(call({ requested_service: 'wood destroying organism inspection' }, {
      transcription: 'Agent: Are you buying it? Caller: yes, the duplex, I need the WDO letter.',
    })).toBe(AV_UNIT_MISSING);
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
    const extracted = { specific_service_name: 'WDO Inspection (Termite Letter)', requested_service: 'WDO inspection' };
    expect(call(extracted, { property: { property_type: 'condo' } })).toBe(AV_UNIT_MISSING);
    expect(call(extracted, { transcription: 'Caller: it is a condominium unit we are buying' })).toBe(AV_UNIT_MISSING);
  });

  test('spot/foam termite work is not whole-structure and stays held', () => {
    expect(call({ specific_service_name: 'Termite Foam Drill Service' })).toBe(AV_UNIT_MISSING);
  });

  test('commercial stays held', () => {
    const extracted = { specific_service_name: 'WDO Inspection (Termite Letter)', requested_service: 'WDO inspection' };
    expect(call(extracted, { property: { property_type: 'commercial' } })).toBe(AV_UNIT_MISSING);
    expect(call(extracted).status).toBe('validated_accept');
    expect(call(extracted, { property: { hoa_common_area_service: true } })).toBe(AV_UNIT_MISSING);
  });

  test('a V1 allowlisted pick that the V2-approved booking replaces stays held (V1/V2 service disagreement)', () => {
    const v1Wdo = { specific_service_name: 'WDO Inspection (Termite Letter)', requested_service: 'WDO inspection' };
    const v2 = (svc) => ({
      meta: { schema_version: '1.20.0' },
      property: { property_type: 'multi_family' },
      service_request: svc,
    });
    const run = (extracted, v2Extraction, preAdoptionExtracted = null) => wholeStructureUnitWaiverForCall({
      addressValidation: AV_UNIT_MISSING, extracted, preAdoptionExtracted, services: CATALOG, v2Extraction,
    });
    expect(run(v1Wdo, v2({ primary_service_category: 'bed_bug', specific_service_name: null }))).toBe(AV_UNIT_MISSING);
    expect(run(v1Wdo, v2({ primary_service_category: 'pest_general', specific_service_name: 'Bed Bug Treatment' }))).toBe(AV_UNIT_MISSING);
    expect(run(v1Wdo, v2({ primary_service_category: 'termite', specific_service_name: 'Termite Foam Drill Service' }))).toBe(AV_UNIT_MISSING);
    // Both views on the list: waived.
    expect(run(v1Wdo, v2({ primary_service_category: 'wdo', specific_service_name: 'WDO Inspection (Termite Letter)' })).status)
      .toBe('validated_accept');
  });

  test('V1 interior pest that V2-primary adoption already turned into WDO stays held (codex #5378 r1 P1)', () => {
    // `extracted` at the gate is POST-adoption: it already carries V2's WDO pick.
    const adopted = { specific_service_name: 'WDO Inspection (Termite Letter)', matched_service: 'WDO Inspection (Termite Letter)', requested_service: 'WDO inspection' };
    const preAdoption = { matched_service: 'General Pest Control', requested_service: 'pest control' };
    const v2Extraction = {
      meta: { schema_version: '1.20.0' },
      property: { property_type: 'multi_family' },
      service_request: { primary_service_category: 'wdo', specific_service_name: 'WDO Inspection (Termite Letter)' },
    };
    const args = { addressValidation: AV_UNIT_MISSING, extracted: adopted, services: CATALOG, v2Extraction };
    expect(wholeStructureUnitWaiverForCall({ ...args, preAdoptionExtracted: preAdoption })).toBe(AV_UNIT_MISSING);
    // Same call where V1 agreed: waived.
    expect(wholeStructureUnitWaiverForCall({ ...args, preAdoptionExtracted: { ...adopted } }).status).toBe('validated_accept');
    // The processor snapshots the V1 fields before adoption.
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src.indexOf('const preAdoptionExtracted = { ...extracted };')).toBeGreaterThan(0);
    expect(src.indexOf('const preAdoptionExtracted = { ...extracted };')).toBeLessThan(src.indexOf('const adoption = adoptV2PrimaryFields('));
    expect(src).toContain('preAdoptionExtracted,\n            transcription,');
  });

  test('both gates on: a call the Assessment gate may force to Waves Assessment is not waived (pre-push P1)', () => {
    const v2 = (patch) => ({
      meta: { schema_version: '1.20.0' },
      property: { property_type: 'multi_family' },
      service_request: { primary_service_category: 'wdo', specific_service_name: 'WDO Inspection (Termite Letter)' },
      triage_flags: [],
      confidence: { overall: 0.9, service_address: 0.9 },
      ...patch,
    });
    const extracted = { specific_service_name: 'WDO Inspection (Termite Letter)', requested_service: 'WDO inspection' };
    const run = (v2Extraction, unclear) => wholeStructureUnitWaiverForCall({
      addressValidation: AV_UNIT_MISSING, extracted, services: CATALOG, v2Extraction, unclearServiceAssessment: unclear,
    });
    const ambiguous = v2({ triage_flags: ['ambiguous_pest_or_service'] });
    const lowAddrOnly = v2({ confidence: { overall: 0.4, service_address: 0.3, urgency: 0.9 } });
    expect(serviceMayForceAssessment(ambiguous)).toBe(true);
    expect(serviceMayForceAssessment(lowAddrOnly)).toBe(true);
    expect(serviceMayForceAssessment(v2({}))).toBe(false);
    // Assessment gate on + service unclear: the hold stands.
    expect(run(ambiguous, true)).toBe(AV_UNIT_MISSING);
    expect(run(lowAddrOnly, true)).toBe(AV_UNIT_MISSING);
    // Assessment gate off: unchanged (waived). Clear service, gate on: waived.
    expect(run(ambiguous, false).status).toBe('validated_accept');
    expect(run(v2({}), true).status).toBe('validated_accept');
  });

  test('an allowlisted service with another address problem stays held', () => {
    const extracted = { specific_service_name: 'WDO Inspection (Termite Letter)', requested_service: 'WDO inspection' };
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

  test('the gate is a dark decision tag: base version untouched, fresh key only while live (codex r1)', () => {
    expect(V2_DECISION_VERSION).toBe('v2-1.50.0');
    expect(resolveDecisionVersion([])).toBe('v2-1.50.0');
    expect(resolveDecisionVersion(['w'])).toBe('v2-1.50.0+w');
    expect(resolveDecisionVersion(['u', 'w'])).toBe('v2-1.50.0+uw');
    expect(V2_DECISION_VERSIONS).toEqual(expect.arrayContaining(['v2-1.50.0+w', 'v2-1.50.0+uw']));
    expect(V2_DECISION_VERSIONS[V2_DECISION_VERSIONS.length - 1]).toBe(V2_DECISION_VERSION);
    expect(new Set(V2_DECISION_VERSIONS).size).toBe(V2_DECISION_VERSIONS.length);
    expect(Math.max(...V2_DECISION_VERSIONS.map((v) => v.length))).toBeLessThanOrEqual(30);
    const args = { callLogId: 'c1', extraction: {}, finalTriageFlags: [], routingResult: { allowed: true }, action: 'x' };
    expect(buildRouteDecision(args).decision_version).toBe('v2-1.50.0');
    expect(buildRouteDecision({ ...args, decisionVersion: resolveDecisionVersion(['w']) }).decision_version).toBe('v2-1.50.0+w');
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain("if (isEnabled('callWholeStructureNoUnit') === true) tags.push('w');");
  });
});

describe('persisted marker + stale unit ask', () => {
  test('a waived verdict is persisted as a marker on the ORIGINAL and the audits rebuild it', () => {
    const waived = applyWholeStructureUnitWaiver(AV_UNIT_MISSING, {
      enabled: true, serviceKey: 'wdo_inspection', propertyType: 'multi_family', text: '',
    });
    const persisted = JSON.parse(JSON.stringify({ ...AV_UNIT_MISSING, wholeStructureUnitWaived: waived.wholeStructureUnitWaived }));
    expect(persisted.status).toBe('ambiguous');
    const rebuilt = reconstructWaivedAddressValidation(persisted);
    expect(rebuilt.status).toBe('validated_accept');
    expect(rebuilt.missingComponents).toEqual([]);
    expect(rebuilt.inServiceArea).toBe(true);
    // The rebuilt verdict routes like the in-memory one; an unmarked row is untouched.
    expect(reconstructWaivedAddressValidation(AV_UNIT_MISSING)).toBe(AV_UNIT_MISSING);
    expect(reconstructWaivedAddressValidation(null)).toBe(null);
    expect(reconstructWaivedAddressValidation(waived)).toBe(waived);
    for (const f of ['v2-promotion-readiness', 'verify-v2-shadow-path', 'replay-call-extraction-variance']) {
      const src = require('fs').readFileSync(require.resolve(`../scripts/${f}`), 'utf8');
      expect(src).toContain('reconstructWaivedAddressValidation');
    }
    // The replay routes a FRESH extraction on the unwaived verdict unless it names the same service + property type.
    const replaySrc = require('fs').readFileSync(require.resolve('../scripts/replay-call-extraction-variance'), 'utf8');
    expect(replaySrc).toContain('waiverInputs(priorV2) !== waiverInputs(currentExtraction)');
    const proc = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(proc).toContain('ai_address_validation: JSON.stringify({ ...v2AddressValidation, wholeStructureUnitWaived: wsAv.wholeStructureUnitWaived })');
  });

  test('an open missing_unit_number card from an earlier pass keeps the hold', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const at = src.indexOf("reason_code: 'missing_unit_number' })\n          .whereIn('status', ['open', 'in_progress'])\n          .first('id');");
    expect(at).toBeGreaterThan(0);
    // The card check runs BEFORE the waiver is computed, and a lookup failure fails closed (hold stands).
    expect(at).toBeLessThan(src.lastIndexOf('wholeStructureUnitWaiverForCall({'));
    expect(src).toContain('whole-structure unit waiver failed open (hold stands)');
  });
});
