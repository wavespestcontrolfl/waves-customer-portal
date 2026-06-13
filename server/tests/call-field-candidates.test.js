const {
  buildCustomerFieldCandidates,
} = require('../services/call-field-candidates');

function validV2Extraction(overrides = {}) {
  const base = {
    meta: {
      schema_version: '1.0.0',
      is_voicemail: false,
      is_spam: false,
    },
    caller: {
      name_full: 'Maria Rodriguez',
      first_name: 'Maria',
      last_name: 'Rodriguez',
      phone_e164: '+19415551234',
      email: null,
    },
    property: {
      service_address: {
        street_line_1: '8224 Abalone Loop',
        city: 'Parrish',
        state: 'FL',
        postal_code: '34219',
      },
    },
    service_request: {
      primary_service_category: 'pest_general',
    },
    evidence: [
      {
        field_path: '/caller/name_full',
        quote: 'My name is Maria Rodriguez.',
        speaker: 'caller',
      },
      {
        field_path: '/property/service_address',
        quote: "I'm at 8224 Abalone Loop in Parrish.",
        speaker: 'caller',
      },
      {
        field_path: '/service_request/primary_service_category',
        quote: 'I need pest control for roaches.',
        speaker: 'caller',
      },
    ],
    confidence: {
      caller_identity: 0.9,
      service_address: 0.95,
      primary_service_category: 0.94,
    },
  };

  return merge(base, overrides);
}

function merge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source || {})) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && target[key]
      && typeof target[key] === 'object'
      && !Array.isArray(target[key])
    ) {
      out[key] = merge(target[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

describe('call field candidates', () => {
  test('builds v2 candidates with evidence, confidence, and mapped service values', () => {
    const rows = buildCustomerFieldCandidates({
      callId: '11111111-1111-4111-8111-111111111111',
      customerId: '22222222-2222-4222-8222-222222222222',
      extraction: { first_name: 'Legacy' },
      v2Extraction: validV2Extraction(),
    });

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field_name: 'first_name',
        final_recommended_value: 'Maria',
        evidence_quote: 'My name is Maria Rodriguez.',
        source: 'gemini_v2',
        confidence: 0.9,
      }),
      expect.objectContaining({
        field_name: 'address_line1',
        final_recommended_value: '8224 Abalone Loop',
        evidence_quote: "I'm at 8224 Abalone Loop in Parrish.",
        source: 'gemini_v2',
        confidence: 0.95,
      }),
      expect.objectContaining({
        field_name: 'matched_service',
        final_recommended_value: 'General Pest Control',
        evidence_quote: 'I need pest control for roaches.',
        source: 'gemini_v2',
        confidence: 0.94,
      }),
    ]));
  });

  test('falls back to legacy extraction when v2 is unavailable', () => {
    const rows = buildCustomerFieldCandidates({
      callId: '11111111-1111-4111-8111-111111111111',
      extraction: {
        first_name: 'Ada',
        phone: '+19415550000',
        matched_service: 'General Pest Control',
      },
    });

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field_name: 'first_name',
        final_recommended_value: 'Ada',
        evidence_quote: null,
        source: 'legacy_gemini',
        confidence: null,
      }),
      expect.objectContaining({
        field_name: 'matched_service',
        final_recommended_value: 'General Pest Control',
        source: 'legacy_gemini',
      }),
    ]));
  });
});
