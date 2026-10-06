/**
 * GATE_CALL_BUSINESS_WHOLE_BUILDING_NO_UNIT (owner ruling 2026-10-06): a
 * business address given with no unit is not held for the "which unit?" ask
 * when the caller says they own, bought, lease or occupy the WHOLE building.
 * The V2 extraction judges the language and pins a caller quote; the rule only
 * verifies it. Synthetic names, addresses and phones only.
 */
const {
  applyBusinessWholeBuildingUnitWaiver,
  reconstructWaivedAddressValidation,
  waiverCarriesToCandidate,
  canAutoRoute,
  computeDeterministicTriageFlags,
  suppressAddressFlagsForAV,
} = require('../services/call-triage-flags');
const { businessWholeBuildingUnitWaiverForCall } = require('../services/call-recording-processor')._test;

// Google's verdict for a business building given without a unit.
const AV_BUSINESS = {
  status: 'ambiguous',
  granularity: 'PREMISE',
  inServiceArea: true,
  county: 'Manatee County',
  hasInferred: true,
  hasReplaced: false,
  hasUnconfirmed: false,
  addressUse: { business: true, residential: false, poBox: false },
  normalized: { street_line_1: '200 Example Avenue', city: 'Bradenton', state: 'FL', postal_code: '34205' },
  missingComponents: ['subpremise'],
};

const QUOTE = 'We just bought this building and we are making it a flower shop';
const TRANSCRIPT = [
  'Agent: Hi, this is Waves Pest Control returning your request. What can we help with?',
  `Caller: Hi. ${QUOTE}. We need pest service before we open.`,
  'Agent: Great. What is the address?',
  'Caller: 200 Example Avenue in Bradenton.',
  'Agent: Thank you. We will get you scheduled.',
].join('\n');

const EVIDENCE = [{ field_path: '/property/whole_building_occupancy', quote: QUOTE, speaker: 'caller', transcript_offset_ms: null }];

const OK = {
  enabled: true,
  propertyType: 'commercial',
  wholeBuildingOccupancy: true,
  evidence: EVIDENCE,
  transcript: TRANSCRIPT,
};

const withTranscript = (lines) => ({ ...OK, transcript: lines.join('\n') });

describe('applyBusinessWholeBuildingUnitWaiver (pure)', () => {
  test('gate off returns the very same verdict object', () => {
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...OK, enabled: false })).toBe(AV_BUSINESS);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, {})).toBe(AV_BUSINESS);
  });

  test('every condition holds -> accepted verdict, original evidence and reason kept, input untouched', () => {
    const out = applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, OK);
    expect(out).not.toBe(AV_BUSINESS);
    expect(out.status).toBe('validated_accept');
    expect(out.missingComponents).toEqual([]);
    expect(out.wholeStructureUnitWaived).toEqual({
      missingComponents: ['subpremise'], originalStatus: 'ambiguous', reason: 'business_whole_building',
    });
    expect(AV_BUSINESS.status).toBe('ambiguous');
    expect(AV_BUSINESS.missingComponents).toEqual(['subpremise']);
  });

  test.each([
    ['not exactly the unit missing (another component too)', { ...AV_BUSINESS, missingComponents: ['subpremise', 'street_number'] }],
    ['not PREMISE granularity', { ...AV_BUSINESS, granularity: 'ROUTE' }],
    ['out of service area', { ...AV_BUSINESS, inServiceArea: false }],
    ['unknown service area', { ...AV_BUSINESS, inServiceArea: undefined }],
    ['unconfirmed components', { ...AV_BUSINESS, hasUnconfirmed: true }],
    ['replaced components', { ...AV_BUSINESS, hasReplaced: true }],
    ['no addressUse', { ...AV_BUSINESS, addressUse: undefined }],
    ['addressUse not business', { ...AV_BUSINESS, addressUse: { business: false, residential: true, poBox: false } }],
    ['addressUse residential null (unknown)', { ...AV_BUSINESS, addressUse: { business: true, residential: null, poBox: false } }],
    ['addressUse residential absent', { ...AV_BUSINESS, addressUse: { business: true } }],
    ['addressUse business unknown', { ...AV_BUSINESS, addressUse: { business: null, residential: false } }],
    ['mixed business and residential use', { ...AV_BUSINESS, addressUse: { business: true, residential: true } }],
  ])('verdict check keeps the hold: %s', (_label, av) => {
    expect(applyBusinessWholeBuildingUnitWaiver(av, OK)).toBe(av);
  });

  test.each([
    ['property is not commercial', { propertyType: 'single_family' }],
    ['property type missing', { propertyType: undefined }],
    ['whole_building_occupancy false', { wholeBuildingOccupancy: false }],
    ['whole_building_occupancy null', { wholeBuildingOccupancy: null }],
    ['whole_building_occupancy missing', { wholeBuildingOccupancy: undefined }],
    ['whole_building_occupancy a string', { wholeBuildingOccupancy: 'true' }],
    ['no evidence', { evidence: [] }],
    ['evidence not an array', { evidence: null }],
    ['evidence for another field', { evidence: [{ ...EVIDENCE[0], field_path: '/property/hoa_common_area_service' }] }],
    ['evidence pinned to the agent', { evidence: [{ ...EVIDENCE[0], speaker: 'agent' }] }],
    ['quote not in the transcript', { evidence: [{ ...EVIDENCE[0], quote: 'We own the whole building outright' }] }],
    ['no transcript', { transcript: '' }],
  ])('input check keeps the hold: %s', (_label, patch) => {
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...OK, ...patch })).toBe(AV_BUSINESS);
  });

  test('a quote found only in an AGENT turn keeps the hold', () => {
    const t = withTranscript([
      `Agent: Just to confirm, ${QUOTE}, correct?`,
      'Caller: Yes, that is right, thanks.',
    ]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).toBe(AV_BUSINESS);
  });

  test('an unlabeled or one-speaker transcript keeps the hold', () => {
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...OK, transcript: `Hi. ${QUOTE}.` })).toBe(AV_BUSINESS);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, withTranscript([`Caller: ${QUOTE}.`]))).toBe(AV_BUSINESS);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, withTranscript([
      'Agent: Hello.', `Caller: ${QUOTE}.`, 'we will call you back',
    ]))).toBe(AV_BUSINESS);
  });

  test('a quote stitched across two turns keeps the hold', () => {
    const t = withTranscript(['Agent: Hello.', 'Caller: We just bought this building.', 'Agent: Nice.', 'Caller: And we are making it a flower shop.']);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).toBe(AV_BUSINESS);
  });

  test('a quote carrying a negation or hedge keeps the hold', () => {
    const q = 'We might buy this building next year';
    const t = withTranscript(['Agent: Hello.', `Caller: ${q}.`]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...t, evidence: [{ ...EVIDENCE[0], quote: q }] })).toBe(AV_BUSINESS);
    const n = 'We do not own this building';
    const t2 = withTranscript(['Agent: Hello.', `Caller: ${n}.`]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...t2, evidence: [{ ...EVIDENCE[0], quote: n }] })).toBe(AV_BUSINESS);
  });

  test('the WHOLE holding caller turn is screened, not only the pinned fragment', () => {
    const fragment = "we'll own the whole building";
    const evidence = [{ ...EVIDENCE[0], quote: fragment }];
    for (const turn of [
      "We do not own it yet; if closing happens, we'll own the whole building.",
      "Maybe, but we'll own the whole building.",
      "Once the sale closes we'll own the whole building.",
    ]) {
      const t = withTranscript(['Agent: Hello.', `Caller: ${turn}`]);
      expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...t, evidence })).toBe(AV_BUSINESS);
    }
    // The same fragment in a plain turn still waives.
    const plain = withTranscript(['Agent: Hello.', "Caller: Good news, we'll own the whole building."]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...plain, evidence })).not.toBe(AV_BUSINESS);
  });

  test.each([
    'Caller: Our space is suite 4 in the back.',
    'Caller: It is ste 12.',
    'Caller: The shop is unit B.',
    'Caller: We have bay 3.',
    'Caller: It is an apartment above the shop.',
    'Caller: It is a condo office.',
  ])('suite / unit wording in a CALLER turn keeps the hold: %s', (line) => {
    const t = withTranscript(['Agent: Hello.', `Caller: ${QUOTE}.`, line]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).toBe(AV_BUSINESS);
  });

  test.each([
    'Caller: Actually we only lease the storefront inside it.',
    'Caller: Actually we only have the space on the left.',
    'Caller: We lease part of the building.',
    'Caller: We have one side of it.',
    'Caller: We share it with a dentist.',
    'Caller: We sublease a portion of it.',
  ])('a later caller correction to partial occupancy keeps the hold: %s', (line) => {
    const t = withTranscript(['Agent: Hello.', `Caller: ${QUOTE}.`, 'Agent: Got it.', line]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).toBe(AV_BUSINESS);
  });

  test('"office space" or "space" said by STAFF does not matter (agent turns are not screened for it)', () => {
    const t = withTranscript(['Agent: Is it an office space or a whole building?', `Caller: ${QUOTE}.`, 'Agent: Great, we cover every kind of space.']);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).not.toBe(AV_BUSINESS);
  });

  test.each([
    ['punctuated question', 'Do we own the whole building?'],
    ['unpunctuated question opener', 'is it the whole building'],
    ['question after a filler', 'Well, are we leasing the whole building?'],
    ['question sentence before an assertion-looking tail', 'Do we own the whole building or just a part'],
  ])('a quote that is a question keeps the hold: %s', (_label, q) => {
    const t = withTranscript(['Agent: Hello.', `Caller: ${q}`]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...t, evidence: [{ ...EVIDENCE[0], quote: q.replace(/\?$/, '') }] })).toBe(AV_BUSINESS);
  });

  test('a turn whose quoted sentence is a question keeps the hold even if another sentence asserts', () => {
    const q = 'we own the whole building';
    const t = withTranscript(['Agent: Hello.', 'Caller: Thanks. Is it true we own the whole building? I think so.']);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...t, evidence: [{ ...EVIDENCE[0], quote: q }] })).toBe(AV_BUSINESS);
    // A plain assertion next to an unrelated question still waives.
    const t2 = withTranscript(['Agent: Hello.', 'Caller: Is the technician licensed? We own the whole building.']);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, { ...t2, evidence: [{ ...EVIDENCE[0], quote: q }] })).not.toBe(AV_BUSINESS);
  });

  test.each([
    'Caller: It is in a strip mall.',
    'Caller: It is in the Example Plaza.',
    'Caller: It is in a shopping center.',
    'Caller: It is in an office park.',
    'Caller: It is part of a complex.',
  ])('strip mall / plaza wording in a caller turn keeps the hold: %s', (line) => {
    const t = withTranscript(['Agent: Hello.', `Caller: ${QUOTE}.`, line]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).toBe(AV_BUSINESS);
  });

  test('strip mall wording in an AGENT turn also keeps the hold', () => {
    const t = withTranscript(['Agent: Is that in a shopping center?', `Caller: ${QUOTE}.`]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).toBe(AV_BUSINESS);
  });

  test('an agent asking about a suite does not count against the caller', () => {
    const t = withTranscript([
      'Agent: Is there a suite or unit number for that address?',
      `Caller: ${QUOTE}.`,
    ]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).not.toBe(AV_BUSINESS);
  });

  test('words that merely contain the screened words do not trip it', () => {
    const t = withTranscript(['Agent: Hello.', `Caller: ${QUOTE}. It is near the Tampa Bayshore, the community united us, and a mallard pond.`]);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).not.toBe(AV_BUSINESS);
  });

  test('the quote matches through punctuation and case differences', () => {
    const t = withTranscript(['Agent: Hello.', 'Caller: Hi. WE JUST BOUGHT THIS BUILDING, and we are making it a flower shop!']);
    expect(applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, t)).not.toBe(AV_BUSINESS);
  });
});

describe('waived verdict through routing', () => {
  const waived = applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, OK);
  const opts = (av) => ({ contactPhone: '+19415550100', addressValidation: av });
  function extraction() {
    return {
      meta: {},
      caller: { first_name: 'Pat', last_name: 'Example', phone_e164: '+19415550100', relationship_to_property: 'owner' },
      property: {
        property_type: 'commercial',
        commercial_subtype: 'retail',
        whole_building_occupancy: true,
        service_address: { street_line_1: '200 Example Avenue', city: 'Bradenton', state: 'FL', postal_code: '34205', county: 'Manatee' },
      },
      service_request: { primary_service_category: 'pest' },
      triage_flags: [],
    };
  }

  test('the unit hold flags are gone for the waived verdict and present without it', () => {
    const held = computeDeterministicTriageFlags(extraction(), opts(AV_BUSINESS));
    expect(held).toEqual(expect.arrayContaining(['address_unverified', 'missing_unit_number']));
    const flags = computeDeterministicTriageFlags(extraction(), opts(waived));
    expect(flags).not.toContain('address_unverified');
    expect(flags).not.toContain('missing_unit_number');
    expect(suppressAddressFlagsForAV(['address_unverified'], waived)).toEqual([]);
    expect(canAutoRoute(extraction(), opts(AV_BUSINESS)).allowed).toBe(false);
  });

  test('the commercial quote rule is untouched by the waiver', () => {
    expect(computeDeterministicTriageFlags(extraction(), opts(waived))).toContain('commercial_requires_quote');
  });

  test('every other address check still applies to a waived verdict', () => {
    expect(canAutoRoute(extraction(), opts({ ...waived, inServiceArea: false })).allowed).toBe(false);
  });
});

describe('processor helper', () => {
  const v2 = (patch = {}) => ({
    property: { property_type: 'commercial', commercial_subtype: 'retail', whole_building_occupancy: true, ...patch },
    evidence: EVIDENCE,
  });

  test('hands the pure rule the V2 property, evidence and labeled transcript', () => {
    const out = businessWholeBuildingUnitWaiverForCall({ addressValidation: AV_BUSINESS, v2Extraction: v2(), transcription: TRANSCRIPT });
    expect(out.status).toBe('validated_accept');
    expect(out.wholeStructureUnitWaived.reason).toBe('business_whole_building');
  });

  test('returns the same object when V2 did not judge a whole building, or no V2 exists', () => {
    expect(businessWholeBuildingUnitWaiverForCall({ addressValidation: AV_BUSINESS, v2Extraction: v2({ whole_building_occupancy: null }), transcription: TRANSCRIPT })).toBe(AV_BUSINESS);
    expect(businessWholeBuildingUnitWaiverForCall({ addressValidation: AV_BUSINESS, v2Extraction: null, transcription: TRANSCRIPT })).toBe(AV_BUSINESS);
    expect(businessWholeBuildingUnitWaiverForCall({ addressValidation: AV_BUSINESS })).toBe(AV_BUSINESS);
  });

  test('the same helper serves inbound and outbound (no direction check)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const fn = src.slice(src.indexOf('function businessWholeBuildingUnitWaiverForCall'), src.indexOf('async function resolveDefaultCallBookingTechnician'));
    expect(fn).not.toMatch(/isOutboundCall|direction/);
  });
});

describe('gate wiring', () => {
  const ENV = 'GATE_CALL_BUSINESS_WHOLE_BUILDING_NO_UNIT';
  function gateWith(value) {
    const saved = process.env[ENV];
    if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
    try {
      let out;
      jest.isolateModules(() => {
        out = require('../config/feature-gates').isEnabled('callBusinessWholeBuildingNoUnit');
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

  const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  test('the processor reads the gate at the whole-structure site, after the open-card guard, and persists the marker', () => {
    const card = src.indexOf("reason_code: 'missing_unit_number' })\n          .whereIn('status', ['open', 'in_progress'])\n          .first('id');");
    const call = src.indexOf('businessWholeBuildingUnitWaiverForCall({\n              addressValidation: v2AddressValidation');
    expect(card).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(card);
    expect(src).toContain("isEnabled('callBusinessWholeBuildingNoUnit')");
    // The shadow row keeps the ORIGINAL verdict; the marker rides the same write.
    expect(src.indexOf('ai_address_validation: v2AddressValidation')).toBeLessThan(call);
    expect(src).toContain('ai_address_validation: JSON.stringify({ ...v2AddressValidation, wholeStructureUnitWaived: wsAv.wholeStructureUnitWaived })');
  });

  test('the whole-structure rule runs first and the business rule only when it did not waive', () => {
    expect(src).toContain("if (wsAv === v2AddressValidation && isEnabled('callBusinessWholeBuildingNoUnit'))");
  });
});

describe('persisted marker + audits', () => {
  test('the audits rebuild a business whole-building waiver from the persisted marker', () => {
    const waived = applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, OK);
    const persisted = JSON.parse(JSON.stringify({ ...AV_BUSINESS, wholeStructureUnitWaived: waived.wholeStructureUnitWaived }));
    expect(persisted.status).toBe('ambiguous');
    const rebuilt = reconstructWaivedAddressValidation(persisted);
    expect(rebuilt.status).toBe('validated_accept');
    expect(rebuilt.missingComponents).toEqual([]);
    expect(rebuilt.addressUse.business).toBe(true);
    expect(reconstructWaivedAddressValidation(waived)).toBe(waived);
  });

  describe('waiverCarriesToCandidate (audit transfer)', () => {
    const waived = applyBusinessWholeBuildingUnitWaiver(AV_BUSINESS, OK);
    const stored = JSON.parse(JSON.stringify({ ...AV_BUSINESS, wholeStructureUnitWaived: waived.wholeStructureUnitWaived }));
    const candidate = (patch = {}) => ({
      property: { property_type: 'commercial', whole_building_occupancy: true },
      evidence: EVIDENCE,
      ...patch,
    });
    const args = (extra = {}) => ({ transcript: TRANSCRIPT, scalarInputsMatch: true, ...extra });

    test('a candidate that keeps a grounded pin keeps the waiver', () => {
      expect(waiverCarriesToCandidate(stored, candidate(), args())).toBe(true);
    });

    test('matching scalar inputs are not enough: a dropped or misgrounded pin keeps the hold', () => {
      expect(waiverCarriesToCandidate(stored, candidate({ evidence: [] }), args())).toBe(false);
      expect(waiverCarriesToCandidate(stored, candidate({ evidence: [{ ...EVIDENCE[0], quote: 'We own the whole building outright' }] }), args())).toBe(false);
      expect(waiverCarriesToCandidate(stored, candidate({ evidence: [{ ...EVIDENCE[0], speaker: 'agent' }] }), args())).toBe(false);
      expect(waiverCarriesToCandidate(stored, candidate({ property: { property_type: 'commercial', whole_building_occupancy: null } }), args())).toBe(false);
      expect(waiverCarriesToCandidate(stored, candidate(), args({ transcript: 'Agent: Hi.\nCaller: Hello.' }))).toBe(false);
    });

    test('the whole-structure waiver keeps its scalar-input transfer', () => {
      const ws = { ...AV_BUSINESS, wholeStructureUnitWaived: { missingComponents: ['subpremise'], originalStatus: 'ambiguous' } };
      expect(waiverCarriesToCandidate(ws, candidate({ evidence: [] }), args({ scalarInputsMatch: true }))).toBe(true);
      expect(waiverCarriesToCandidate(ws, candidate(), args({ scalarInputsMatch: false }))).toBe(false);
    });

    test('the audit scripts route the transfer decision through it', () => {
      for (const f of ['replay-call-extraction-variance', 'verify-v2-shadow-path']) {
        const src = require('fs').readFileSync(require.resolve(`../scripts/${f}`), 'utf8');
        expect(src).toContain('waiverCarriesToCandidate');
      }
    });
  });
});

describe('extraction schema 1.23.0', () => {
  const { validateModelOutput, validatePersisted, SCHEMA_VERSION } = require('../schemas/validate-extraction');
  const { flatView } = require('../utils/extraction-compat');

  test('whole_building_occupancy is an optional nullable boolean in both schemas', () => {
    expect(SCHEMA_VERSION).toBe('1.23.0');
    for (const f of ['call-extraction.model-output.schema.json', 'call-extraction.persisted.schema.json']) {
      const schema = require(`../schemas/${f}`);
      const def = schema.properties.property.properties.whole_building_occupancy;
      expect(def.type).toEqual(['boolean', 'null']);
      expect(schema.properties.property.required || []).not.toContain('whole_building_occupancy');
    }
    expect(typeof validateModelOutput).toBe('function');
    expect(typeof validatePersisted).toBe('function');
  });

  test('flatView mirrors it as a tri-state (null when absent)', () => {
    expect(flatView({ meta: { schema_version: '1.23.0' }, property: { whole_building_occupancy: true } }).whole_building_occupancy).toBe(true);
    expect(flatView({ meta: { schema_version: '1.23.0' }, property: { whole_building_occupancy: false } }).whole_building_occupancy).toBe(false);
    expect(flatView({ meta: { schema_version: '1.23.0' }, property: {} }).whole_building_occupancy).toBeNull();
  });

  test('the prompt asks for the field and the caller-pinned quote', () => {
    const { buildExtractionPrompt } = require('../services/prompts/call-extraction-v1');
    const prompt = buildExtractionPrompt('', '', '');
    expect(prompt).toContain('- whole_building_occupancy: true ONLY when the CALLER states');
    expect(prompt).toContain('/property/whole_building_occupancy');
  });
});
