const { validateModelOutput, validatePersisted, SCHEMA_VERSION } = require('../schemas/validate-extraction');
const { normalizeExtractionV2, normalizePhone, normalizeZip, normalizeState, cleanValidEmail } = require('../utils/normalize-extraction-v2');
const { isV2Extraction, flatView, mapServiceCategoryToLegacy } = require('../utils/extraction-compat');

function validModelOutput() {
  return {
    meta: {
      is_voicemail: false,
      is_spam: false,
      transcript_word_count: 342,
      transcript_duration_seconds: 185,
      call_summary: 'Caller reports roaches in the kitchen, wants treatment this week.',
    },
    caller: {
      name_full: 'Maria Rodriguez',
      first_name: 'Maria',
      last_name: 'Rodriguez',
      organization_name: null,
      name_confidence: 0.9,
      phone_e164: '+19415551234',
      phone_raw_spoken: 'nine four one, five five five, one two three four',
      phone_source: 'spoken',
      email: null,
      relationship_to_property: 'owner',
      on_site_authorization: true,
      decision_maker_present: true,
      preferred_contact_method: 'phone',
    },
    consent: {
      sms_consent_given: true,
      sms_consent_quote: 'Yes, you can text me at this number.',
      call_recording_disclosed: true,
      do_not_contact_request: false,
    },
    property: {
      service_address: {
        raw_text: '8224 Abalone Loop, Parrish',
        street_line_1: '8224 Abalone Loop',
        street_line_2: null,
        city: 'Parrish',
        state: 'FL',
        postal_code: '34219',
        county: 'Manatee',
        subdivision_or_community: null,
        normalization_status: 'not_attempted',
      },
      property_type: 'single_family',
      hoa_community_flag: false,
      hoa_common_area_service: false,
      commercial_subtype: null,
      approximate_lot_size_acres: null,
      approximate_living_sqft: null,
      pets_on_property: { present: true, species_notes: 'two dogs in yard' },
      access_notes: 'gate code 1234',
    },
    service_request: {
      primary_service_category: 'pest_general',
      secondary_categories: [],
      pests_observed_status: 'observed',
      pests_observed: [
        {
          pest_type: 'roaches_german',
          location_on_property: 'kitchen',
          severity_signal: 'sighting_multiple',
          first_observed: 'last week',
          prior_treatment_attempts: 'store-bought spray',
        },
      ],
      service_intent: 'active_infestation_treatment',
      urgency: 'within_48_hours',
      waveguard_tier_mentioned: null,
    },
    customer_history: {
      status: 'new_customer',
      competitor_name: null,
      referral_source: 'Google',
      prior_complaint_mentioned: false,
    },
    scheduling: {
      status: 'confirmed',
      confirmed_start_at: '2026-05-28T10:00:00-04:00',
      requested_date_range_start: '2026-05-28',
      requested_date_range_end: null,
      preferred_time_of_day: 'morning',
      callback_window_start: null,
      callback_window_end: null,
      blackout_dates: [],
      scheduling_notes_raw: null,
    },
    sentiment_and_lead: {
      sentiment: 'frustrated',
      lead_quality: 'hot',
      objections_raised: [],
      buying_signals: ['how soon can someone come out'],
    },
    evidence: [
      {
        field_path: '/property/service_address',
        quote: 'I\'m at 8224 Abalone Loop in Parrish',
        speaker: 'caller',
        transcript_offset_ms: 12000,
      },
      {
        field_path: '/consent/sms_consent_given',
        quote: 'Yes, you can text me at this number.',
        speaker: 'caller',
        transcript_offset_ms: 45000,
      },
    ],
    confidence: {
      caller_identity: 0.9,
      service_address: 0.95,
      property_type: 0.8,
      primary_service_category: 0.95,
      urgency: 0.85,
      scheduling_window: 0.9,
      consent_capture: 0.92,
      overall: 0.91,
    },
    triage_flags: [],
  };
}

function validPersisted() {
  const output = validModelOutput();
  output.meta.call_id = '550e8400-e29b-41d4-a716-446655440000';
  output.meta.schema_version = '1.0.0';
  output.meta.extracted_at = '2026-05-28T02:30:00Z';
  output.meta.extraction_model = 'gemini-2.5-flash';
  output.meta.extraction_prompt_version = 'v1-abc123';
  return output;
}

// ═══════════════════════════════════════════════════
// Schema Validation
// ═══════════════════════════════════════════════════

describe('schema validation', () => {
  test('schema version is 1.2.0', () => {
    expect(SCHEMA_VERSION).toBe('1.2.0');
  });

  describe('model-output schema', () => {
    test('valid extraction passes', () => {
      const { valid, errors } = validateModelOutput(validModelOutput());
      expect(errors).toBeNull();
      expect(valid).toBe(true);
    });

    test('rejects server-owned fields in model output', () => {
      const data = validModelOutput();
      data.meta.call_id = '550e8400-e29b-41d4-a716-446655440000';
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(false);
    });

    test('missing required section fails', () => {
      const data = validModelOutput();
      delete data.consent;
      const { valid, errors } = validateModelOutput(data);
      expect(valid).toBe(false);
      expect(errors.some(e => e.params?.missingProperty === 'consent')).toBe(true);
    });

    test('wrong enum value fails', () => {
      const data = validModelOutput();
      data.caller.relationship_to_property = 'neighbor';
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(false);
    });

    test('scheduling.status=confirmed is valid', () => {
      const data = validModelOutput();
      data.scheduling.status = 'confirmed';
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });

    test('scheduling.status=requested is valid', () => {
      const data = validModelOutput();
      data.scheduling.status = 'requested';
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });

    test('invalid scheduling.status fails', () => {
      const data = validModelOutput();
      data.scheduling.status = 'booked';
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(false);
    });

    test('empty triage_flags is valid', () => {
      const data = validModelOutput();
      data.triage_flags = [];
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });

    test('invalid triage flag value fails', () => {
      const data = validModelOutput();
      data.triage_flags = ['nonexistent_flag'];
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(false);
    });

    test('duplicate triage flags fail', () => {
      const data = validModelOutput();
      data.triage_flags = ['spam_or_wrong_number', 'spam_or_wrong_number'];
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(false);
    });

    test('null optional sections valid (scheduling omitted)', () => {
      const data = validModelOutput();
      delete data.scheduling;
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });

    test('null optional sections valid (evidence omitted)', () => {
      const data = validModelOutput();
      delete data.evidence;
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });

    test('null optional sections valid (commercial_signals omitted)', () => {
      const data = validModelOutput();
      delete data.commercial_signals;
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });

    test('pests_observed_status observed with empty array fails conceptually but passes schema', () => {
      const data = validModelOutput();
      data.service_request.pests_observed_status = 'observed';
      data.service_request.pests_observed = [];
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });

    test('pests_observed_status not_discussed is valid', () => {
      const data = validModelOutput();
      data.service_request.pests_observed_status = 'not_discussed';
      data.service_request.pests_observed = [];
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });

    test('voicemail extraction is valid', () => {
      const data = validModelOutput();
      data.meta.is_voicemail = true;
      data.scheduling = { status: 'none', blackout_dates: [] };
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });

    test('additionalProperties on root rejected', () => {
      const data = validModelOutput();
      data.extra_field = 'should fail';
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(false);
    });

    test('phone_e164 pattern enforced', () => {
      const data = validModelOutput();
      data.caller.phone_e164 = '9415551234';
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(false);
    });

    test('null phone_e164 is valid', () => {
      const data = validModelOutput();
      data.caller.phone_e164 = null;
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
    });
  });

  describe('persisted schema', () => {
    test('valid persisted extraction passes', () => {
      const { valid, errors } = validatePersisted(validPersisted());
      expect(errors).toBeNull();
      expect(valid).toBe(true);
    });

    test('missing call_id fails', () => {
      const data = validPersisted();
      delete data.meta.call_id;
      const { valid } = validatePersisted(data);
      expect(valid).toBe(false);
    });

    test('missing schema_version fails', () => {
      const data = validPersisted();
      delete data.meta.schema_version;
      const { valid } = validatePersisted(data);
      expect(valid).toBe(false);
    });

    test('wrong schema_version fails', () => {
      const data = validPersisted();
      data.meta.schema_version = '2.0.0';
      const { valid } = validatePersisted(data);
      expect(valid).toBe(false);
    });

    test('the injected SCHEMA_VERSION validates', () => {
      const data = validPersisted();
      data.meta.schema_version = SCHEMA_VERSION;
      const { valid, errors } = validatePersisted(data);
      expect(errors).toBeNull();
      expect(valid).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════
// Normalize Extraction v2
// ═══════════════════════════════════════════════════

describe('normalize extraction v2', () => {
  test('normalizes phone to E.164', () => {
    expect(normalizePhone('9415551234')).toBe('+19415551234');
    expect(normalizePhone('+19415551234')).toBe('+19415551234');
    expect(normalizePhone('(941) 555-1234')).toBe('+19415551234');
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });

  test('normalizes zip to 5-digit', () => {
    expect(normalizeZip('34219')).toBe('34219');
    expect(normalizeZip('34219-1234')).toBe('34219');
    expect(normalizeZip('Parrish FL 34219')).toBe('34219');
    expect(normalizeZip(null)).toBeNull();
  });

  test('normalizes state to FL or null', () => {
    expect(normalizeState('FL')).toBe('FL');
    expect(normalizeState('Florida')).toBe('FL');
    expect(normalizeState('fl')).toBe('FL');
    expect(normalizeState('GA')).toBeNull();
    expect(normalizeState(null)).toBeNull();
  });

  test('normalizes email', () => {
    expect(cleanValidEmail('Test@Example.COM')).toBe('test@example.com');
    expect(cleanValidEmail('not-an-email')).toBeNull();
    expect(cleanValidEmail(null)).toBeNull();
  });

  test('normalizeExtractionV2 handles full extraction', () => {
    const extraction = validModelOutput();
    extraction.caller.phone_e164 = '9415551234';
    extraction.caller.email = 'MARIA@GMAIL.COM';
    extraction.caller.first_name = 'maria';
    extraction.property.service_address.state = 'florida';
    extraction.property.service_address.postal_code = '34219-1234';

    const result = normalizeExtractionV2(extraction);
    expect(result.caller.phone_e164).toBe('+19415551234');
    expect(result.caller.email).toBe('maria@gmail.com');
    expect(result.caller.first_name).toBe('Maria');
    expect(result.property.service_address.state).toBe('FL');
    expect(result.property.service_address.postal_code).toBe('34219');
  });

  test('normalizeExtractionV2 preserves null values', () => {
    const extraction = validModelOutput();
    extraction.caller.email = null;
    extraction.caller.last_name = null;
    const result = normalizeExtractionV2(extraction);
    expect(result.caller.email).toBeNull();
    expect(result.caller.last_name).toBeNull();
  });
});

// ═══════════════════════════════════════════════════
// Extraction Compatibility Adapter
// ═══════════════════════════════════════════════════

describe('extraction compat adapter', () => {
  test('isV2Extraction detects v2', () => {
    expect(isV2Extraction(validPersisted())).toBe(true);
    expect(isV2Extraction({ first_name: 'Bob' })).toBe(false);
    expect(isV2Extraction(null)).toBe(false);
    expect(isV2Extraction({})).toBe(false);
  });

  test('flatView returns flat extraction unchanged', () => {
    const flat = { first_name: 'Bob', last_name: 'Smith' };
    expect(flatView(flat)).toBe(flat);
  });

  test('flatView maps v2 to flat keys', () => {
    const v2 = validPersisted();
    const flat = flatView(v2);

    expect(flat.first_name).toBe('Maria');
    expect(flat.last_name).toBe('Rodriguez');
    expect(flat.phone).toBe('+19415551234');
    expect(flat.email).toBeNull();
    expect(flat.address_line1).toBe('8224 Abalone Loop');
    expect(flat.city).toBe('Parrish');
    expect(flat.state).toBe('FL');
    expect(flat.zip).toBe('34219');
    expect(flat.is_voicemail).toBe(false);
    expect(flat.is_spam).toBe(false);
    expect(flat.sentiment).toBe('frustrated');
    expect(flat.call_summary).toBe('Caller reports roaches in the kitchen, wants treatment this week.');
  });

  test('flatView maps appointment_confirmed from scheduling.status', () => {
    const v2 = validPersisted();
    v2.scheduling = { status: 'confirmed', confirmed_start_at: '2026-05-28T10:00:00', blackout_dates: [] };
    expect(flatView(v2).appointment_confirmed).toBe(true);

    v2.scheduling.status = 'requested';
    expect(flatView(v2).appointment_confirmed).toBe(false);

    v2.scheduling.status = 'offered';
    expect(flatView(v2).appointment_confirmed).toBe(false);

    v2.scheduling.status = 'none';
    expect(flatView(v2).appointment_confirmed).toBe(false);

    v2.scheduling.status = 'ambiguous';
    expect(flatView(v2).appointment_confirmed).toBe(false);
  });

  test('flatView maps preferred_date_time from confirmed_start_at only', () => {
    const v2 = validPersisted();
    v2.scheduling = { status: 'confirmed', confirmed_start_at: '2026-05-28T10:00:00', blackout_dates: [] };
    expect(flatView(v2).preferred_date_time).toBe('2026-05-28T10:00:00');

    v2.scheduling = { status: 'requested', confirmed_start_at: null, requested_date_range_start: '2026-05-28', blackout_dates: [] };
    expect(flatView(v2).preferred_date_time).toBeNull();
  });

  test('flatView preserves _v2 reference', () => {
    const v2 = validPersisted();
    const flat = flatView(v2);
    expect(flat._v2).toBe(v2);
  });

  test('flatView handles missing optional sections', () => {
    const v2 = validPersisted();
    delete v2.scheduling;
    const flat = flatView(v2);
    expect(flat.appointment_confirmed).toBe(false);
    expect(flat.preferred_date_time).toBeNull();
  });

  test('mapServiceCategoryToLegacy maps correctly', () => {
    expect(mapServiceCategoryToLegacy('pest_general')).toBe('General Pest Control');
    expect(mapServiceCategoryToLegacy('termite')).toBe('Termite Inspection');
    expect(mapServiceCategoryToLegacy('lawn_care')).toBe('Lawn Care');
    expect(mapServiceCategoryToLegacy('rodent')).toBe('Rodent Control');
    expect(mapServiceCategoryToLegacy('mosquito')).toBe('Mosquito Control');
    expect(mapServiceCategoryToLegacy(null)).toBeNull();
  });

  test('flatView lead_quality maps spam variants', () => {
    const v2 = validPersisted();
    v2.sentiment_and_lead.lead_quality = 'spam_or_solicitation';
    expect(flatView(v2).lead_quality).toBe('spam');

    v2.sentiment_and_lead.lead_quality = 'wrong_number';
    expect(flatView(v2).lead_quality).toBe('spam');
  });
});
