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
  test('schema version is 1.13.0', () => {
    expect(SCHEMA_VERSION).toBe('1.13.0');
  });

  describe('model-output schema', () => {
    test('a caller-proposed slot remains a request through validation, normalization and flattening', () => {
      const data = validPersisted();
      data.meta.schema_version = SCHEMA_VERSION;
      data.scheduling.status = 'reschedule_requested';
      data.scheduling.confirmed_start_at = null;
      data.scheduling.agent_committed_booking = false;
      data.scheduling.proposed_start_at = '2026-11-09T12:00:00-05:00';
      expect(validatePersisted(data).valid).toBe(true);
      const normalized = normalizeExtractionV2(data);
      expect(flatView(normalized)).toMatchObject({ proposed_start_at: '2026-11-09T12:00:00-05:00',
        preferred_date_time: null, appointment_confirmed: false, agent_committed_booking: false });
    });

    test('malformed proposed timestamps are refused while older rows without a proposal still validate', () => {
      const data = validModelOutput();
      data.scheduling.proposed_start_at = 'tomorrow around lunch';
      expect(validateModelOutput(data).valid).toBe(false);
      data.scheduling.proposed_start_at = '2026-11-09T12:00:00-05:00';
      expect(validateModelOutput(data).valid).toBe(true);
      const old = validPersisted();
      old.meta.schema_version = '1.10.0';
      expect(validatePersisted(normalizeExtractionV2(old)).valid).toBe(true);
      expect(flatView(old).proposed_start_at).toBeNull();
    });

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

    test('an as-heard invalid caller email does not fail the whole extraction (server re-validates)', () => {
      // A dropped TLD ("brandon@gmail") used to fail format:"email" here,
      // which under CALL_EXTRACTION_V2_DRIVES_ROUTING fail-closed the entire
      // call to triage BEFORE the repair path ever saw the address. The
      // model-output schema accepts it as-heard; normalizeCaller nulls what
      // it can't validate — demoting the capture to the server-derived
      // email_raw so the gated repair / read-back path still sees it — and
      // the persisted schema (still format:"email" on `email`) stays strict.
      const data = validModelOutput();
      data.caller.email = 'brandon@gmail';
      const { valid } = validateModelOutput(data);
      expect(valid).toBe(true);
      const normalized = normalizeExtractionV2(data);
      expect(normalized.caller.email).toBeNull();
      expect(normalized.caller.email_raw).toBe('brandon@gmail');
      // Persisted validation runs after finalizeV2Extraction injects the
      // server-owned meta — mirror that so this asserts the email_raw shape,
      // not a missing-meta artifact of the fixture.
      normalized.meta = {
        ...normalized.meta,
        call_id: '550e8400-e29b-41d4-a716-446655440000',
        schema_version: SCHEMA_VERSION,
        extracted_at: '2026-07-11T00:00:00.000Z',
        extraction_model: 'test-model',
      };
      const persisted = validatePersisted(normalized);
      expect(persisted.errors).toBeNull();
      expect(persisted.valid).toBe(true);
    });

    test('caller.email_raw is server-owned — model output carrying it is rejected', () => {
      const data = validModelOutput();
      data.caller.email_raw = 'brandon@gmail';
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

    // service_request.price (call-agent audit 2026-09-23): captures any
    // price the agent states, accepted or not — distinct from
    // quoted_price_usd, which stays accepted-total-only.
    describe('service_request.price', () => {
      test('a full price object with every field set validates', () => {
        const data = validModelOutput();
        data.service_request.price = {
          amount_usd: 90,
          amount_max_usd: 100,
          unit: 'per_quarter',
          accepted: false,
          stated_by: 'agent',
          prepay_term: 'annual',
          tier_mentioned: 'gold',
          evidence_quote: 'that runs ninety to a hundred a quarter',
        };
        const { valid, errors } = validateModelOutput(data);
        expect(errors).toBeNull();
        expect(valid).toBe(true);
      });

      test('omitting price entirely is valid (backward compatible with older prompts)', () => {
        const data = validModelOutput();
        delete data.service_request.price;
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(true);
      });

      test('a price object with every field null is valid', () => {
        const data = validModelOutput();
        data.service_request.price = {
          amount_usd: null,
          amount_max_usd: null,
          unit: null,
          accepted: null,
          stated_by: null,
          prepay_term: null,
          tier_mentioned: null,
          evidence_quote: null,
        };
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(true);
      });

      test('a range with only amount_usd/amount_max_usd set is valid', () => {
        const data = validModelOutput();
        data.service_request.price = { amount_usd: 350, amount_max_usd: null, unit: 'one_time', accepted: null, stated_by: 'agent', prepay_term: null, tier_mentioned: null, evidence_quote: '$350 to set the traps' };
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(true);
      });

      test('an invalid unit value fails', () => {
        const data = validModelOutput();
        data.service_request.price = { amount_usd: 65, unit: 'weekly' };
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(false);
      });

      test('an invalid tier_mentioned value fails', () => {
        const data = validModelOutput();
        data.service_request.price = { amount_usd: 65, tier_mentioned: 'diamond' };
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(false);
      });

      test('an invalid prepay_term value fails', () => {
        const data = validModelOutput();
        data.service_request.price = { amount_usd: 65, prepay_term: 'monthly' };
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(false);
      });

      test('an invalid stated_by value fails', () => {
        const data = validModelOutput();
        data.service_request.price = { amount_usd: 65, stated_by: 'office' };
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(false);
      });

      test('an unknown field on price fails (additionalProperties: false)', () => {
        const data = validModelOutput();
        data.service_request.price = { amount_usd: 65, extra: 'nope' };
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(false);
      });

      test('a price object survives persisted validation alongside the unchanged quoted_price_usd', () => {
        const data = validPersisted();
        data.meta.schema_version = SCHEMA_VERSION;
        data.service_request.quoted_price_usd = null;
        data.service_request.price = { amount_usd: 65, amount_max_usd: null, unit: 'per_application', accepted: null, stated_by: 'agent', prepay_term: null, tier_mentioned: null, evidence_quote: '$65 per application' };
        const { valid, errors } = validatePersisted(data);
        expect(errors).toBeNull();
        expect(valid).toBe(true);
      });

      // caller_response (schema 1.13.0, #4707 follow-up 1): replaces the
      // boolean-only accepted, which conflated "declined" with "never
      // responded". accepted stays for backward compatibility, derived.
      describe('caller_response', () => {
        test('every caller_response enum value validates alongside its derived accepted', () => {
          const cases = [
            { caller_response: 'accepted', accepted: true },
            { caller_response: 'declined', accepted: false },
            { caller_response: 'no_response', accepted: false },
            { caller_response: 'not_at_issue', accepted: null },
            { caller_response: null, accepted: null },
          ];
          for (const { caller_response, accepted } of cases) {
            const data = validModelOutput();
            data.service_request.price = { amount_usd: 65, caller_response, accepted };
            const { valid, errors } = validateModelOutput(data);
            expect(errors).toBeNull();
            expect(valid).toBe(true);
          }
        });

        test('an invalid caller_response value fails', () => {
          const data = validModelOutput();
          data.service_request.price = { amount_usd: 65, caller_response: 'maybe' };
          const { valid } = validateModelOutput(data);
          expect(valid).toBe(false);
        });

        test('a price object omitting caller_response is still valid (backward compatible with pre-1.13.0 prompts)', () => {
          const data = validModelOutput();
          data.service_request.price = { amount_usd: 65, accepted: false };
          const { valid, errors } = validateModelOutput(data);
          expect(errors).toBeNull();
          expect(valid).toBe(true);
        });

        test('caller_response survives persisted validation', () => {
          const data = validPersisted();
          data.meta.schema_version = SCHEMA_VERSION;
          data.service_request.price = { amount_usd: 65, caller_response: 'declined', accepted: false };
          const { valid, errors } = validatePersisted(data);
          expect(errors).toBeNull();
          expect(valid).toBe(true);
        });
      });
    });

    // prices[] (schema 1.13.0, #4707 follow-up 2): one price per call — a
    // call that states both a one-time and a monthly price keeps every one
    // of them here; `price` stays the single primary entry.
    describe('service_request.prices', () => {
      test('an array of distinct prices validates, with price kept as the primary entry', () => {
        const data = validModelOutput();
        data.service_request.price = { amount_usd: 300, unit: 'one_time', caller_response: 'accepted', accepted: true };
        data.service_request.prices = [
          { amount_usd: 300, unit: 'one_time', caller_response: 'accepted', accepted: true },
          { amount_usd: 40, unit: 'per_month', caller_response: 'not_at_issue', accepted: null },
        ];
        const { valid, errors } = validateModelOutput(data);
        expect(errors).toBeNull();
        expect(valid).toBe(true);
      });

      test('omitting prices entirely is valid (backward compatible)', () => {
        const data = validModelOutput();
        delete data.service_request.prices;
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(true);
      });

      test('an empty prices array is valid', () => {
        const data = validModelOutput();
        data.service_request.prices = [];
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(true);
      });

      test('more than 6 prices fails maxItems', () => {
        const data = validModelOutput();
        data.service_request.prices = Array.from({ length: 7 }, (_, i) => ({ amount_usd: i, unit: 'one_time' }));
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(false);
      });

      test('an unknown field on a prices[] entry fails (additionalProperties: false)', () => {
        const data = validModelOutput();
        data.service_request.prices = [{ amount_usd: 65, extra: 'nope' }];
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(false);
      });

      test('an invalid unit inside a prices[] entry fails', () => {
        const data = validModelOutput();
        data.service_request.prices = [{ amount_usd: 65, unit: 'weekly' }];
        const { valid } = validateModelOutput(data);
        expect(valid).toBe(false);
      });

      test('prices[] survives persisted validation', () => {
        const data = validPersisted();
        data.meta.schema_version = SCHEMA_VERSION;
        data.service_request.prices = [
          { amount_usd: 300, unit: 'one_time', caller_response: 'accepted', accepted: true },
          { amount_usd: 40, unit: 'per_month', caller_response: 'not_at_issue', accepted: null },
        ];
        const { valid, errors } = validatePersisted(data);
        expect(errors).toBeNull();
        expect(valid).toBe(true);
      });
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

  test('normalizes email (strict — the domain repair lives in the gated review path, not here)', () => {
    expect(cleanValidEmail('Test@Example.COM')).toBe('test@example.com');
    expect(cleanValidEmail('not-an-email')).toBeNull();
    // A bare-SLD capture is NOT repaired inline; deriveEmailReview proposes
    // the fix and the processor's ownership gate decides adoption.
    expect(cleanValidEmail('brandon@gmail')).toBeNull();
    expect(cleanValidEmail(null)).toBeNull();
  });

  test('normalizeCaller rejects a URL-shaped caller email (transcript garble) but keeps it in email_raw', () => {
    const extraction = validModelOutput();
    extraction.caller.email = 'www.cw63@gmail.com';
    const result = normalizeExtractionV2(extraction);
    expect(result.caller.email).toBeNull();
    // Preserved for the read-back card; deriveEmailReview classifies a garble
    // email_invalid and never repairs it into an adoptable address.
    expect(result.caller.email_raw).toBe('www.cw63@gmail.com');
  });

  test('a valid caller email leaves email_raw null', () => {
    const extraction = validModelOutput();
    extraction.caller.email = 'MARIA@GMAIL.COM';
    const result = normalizeExtractionV2(extraction);
    expect(result.caller.email).toBe('maria@gmail.com');
    expect(result.caller.email_raw).toBeNull();
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

  // #4722 codex r1 P1s: server-side derivation + the primary/prices
  // compatibility contract — the model can disagree with itself
  // (caller_response 'accepted' alongside accepted: false, or a price that
  // doesn't match the accepted prices[] entry) and both must be corrected
  // before persistence, not left for readers to reconcile.
  describe('service_request.price / prices normalization', () => {
    test('derives accepted from caller_response on price, overriding a disagreeing model value', () => {
      const extraction = validModelOutput();
      extraction.service_request.price = { amount_usd: 65, caller_response: 'accepted', accepted: false };
      const result = normalizeExtractionV2(extraction);
      expect(result.service_request.price.accepted).toBe(true);
    });

    test('derives accepted for every caller_response value', () => {
      const cases = [
        ['accepted', true],
        ['declined', false],
        ['no_response', false],
        ['not_at_issue', null],
        [null, null],
      ];
      for (const [caller_response, expected] of cases) {
        const extraction = validModelOutput();
        extraction.service_request.price = { amount_usd: 65, caller_response, accepted: 'stale' };
        const result = normalizeExtractionV2(extraction);
        expect(result.service_request.price.accepted).toBe(expected);
      }
    });

    test('when caller_response is absent (key not present), the old accepted value is preserved unchanged', () => {
      const extraction = validModelOutput();
      extraction.service_request.price = { amount_usd: 65, accepted: false };
      const result = normalizeExtractionV2(extraction);
      expect(result.service_request.price.accepted).toBe(false);
      expect(result.service_request.price).not.toHaveProperty('caller_response');
    });

    test('derives accepted on every prices[] entry independently', () => {
      const extraction = validModelOutput();
      extraction.service_request.price = { amount_usd: 300, unit: 'one_time', caller_response: 'accepted', accepted: true };
      extraction.service_request.prices = [
        { amount_usd: 300, unit: 'one_time', caller_response: 'accepted', accepted: false },
        { amount_usd: 40, unit: 'per_month', caller_response: 'declined', accepted: true },
      ];
      const result = normalizeExtractionV2(extraction);
      expect(result.service_request.prices[0].accepted).toBe(true);
      expect(result.service_request.prices[1].accepted).toBe(false);
    });

    test('a nonempty prices[] with price missing fills price from the accepted entry (first such), else prices[0]', () => {
      const withAccepted = validModelOutput();
      delete withAccepted.service_request.price;
      withAccepted.service_request.prices = [
        { amount_usd: 40, unit: 'per_month', caller_response: 'declined' },
        { amount_usd: 300, unit: 'one_time', caller_response: 'accepted' },
      ];
      const resultA = normalizeExtractionV2(withAccepted);
      expect(resultA.service_request.price).toMatchObject({ amount_usd: 300, unit: 'one_time', caller_response: 'accepted', accepted: true });

      const noneAccepted = validModelOutput();
      delete noneAccepted.service_request.price;
      noneAccepted.service_request.prices = [
        { amount_usd: 40, unit: 'per_month', caller_response: 'declined' },
        { amount_usd: 300, unit: 'one_time', caller_response: 'no_response' },
      ];
      const resultB = normalizeExtractionV2(noneAccepted);
      expect(resultB.service_request.price).toMatchObject({ amount_usd: 40, unit: 'per_month', caller_response: 'declined', accepted: false });
    });

    // codex #4722 r1 push-gate P1: primary selection must key off the
    // NORMALIZED accepted, not caller_response directly — caller_response
    // is optional (pre-1.13.0 shape / a field the model omitted), and an
    // entry that omits it keeps its own accepted value unchanged. Checking
    // caller_response alone would skip that entry and fall through to
    // prices[0], demoting a genuinely accepted price.
    test('selects the accepted entry as primary even when it omits caller_response (legacy accepted-only shape)', () => {
      const extraction = validModelOutput();
      delete extraction.service_request.price;
      extraction.service_request.prices = [
        { amount_usd: 40, unit: 'per_month', accepted: false },
        { amount_usd: 300, unit: 'one_time', accepted: true },
      ];
      const result = normalizeExtractionV2(extraction);
      expect(result.service_request.price).toMatchObject({ amount_usd: 300, unit: 'one_time', accepted: true });
      expect(result.service_request.price).not.toHaveProperty('caller_response');
    });

    test('a price that disagrees with the accepted prices[] entry is replaced by that entry', () => {
      const extraction = validModelOutput();
      extraction.service_request.price = { amount_usd: 40, unit: 'per_month', caller_response: 'declined', accepted: false };
      extraction.service_request.prices = [
        { amount_usd: 40, unit: 'per_month', caller_response: 'declined' },
        { amount_usd: 300, unit: 'one_time', caller_response: 'accepted' },
      ];
      const result = normalizeExtractionV2(extraction);
      expect(result.service_request.price).toMatchObject({ amount_usd: 300, unit: 'one_time', caller_response: 'accepted', accepted: true });
    });

    // codex #4722 r2 P1: when the selected prices[] entry describes the
    // SAME price as the existing `price` (same amount_usd/amount_max_usd/
    // unit), merge rather than replace wholesale — a wholesale replacement
    // would discard richer fields (stated_by, evidence_quote,
    // tier_mentioned, prepay_term...) the top-level price carried and the
    // sparser prices[] echo omitted.
    describe('primary price merge vs replace (codex #4722 r2 P1)', () => {
      test('merges when the selected entry describes the same price, filling its gaps from the existing richer price', () => {
        const extraction = validModelOutput();
        extraction.service_request.price = {
          amount_usd: 65,
          amount_max_usd: null,
          unit: 'one_time',
          caller_response: 'accepted',
          accepted: true,
          stated_by: 'agent',
          prepay_term: 'none',
          tier_mentioned: 'gold',
          evidence_quote: 'it is sixty five dollars, one time',
        };
        // The prices[] echo of the SAME price, but sparser — only what the
        // model repeated when listing every distinct price.
        extraction.service_request.prices = [
          { amount_usd: 65, unit: 'one_time', caller_response: 'accepted' },
        ];
        const result = normalizeExtractionV2(extraction);
        expect(result.service_request.price).toMatchObject({
          amount_usd: 65,
          unit: 'one_time',
          caller_response: 'accepted',
          accepted: true,
          // Preserved from the existing price — the sparser prices[] entry
          // never carried these, so they must survive the merge.
          stated_by: 'agent',
          prepay_term: 'none',
          tier_mentioned: 'gold',
          evidence_quote: 'it is sixty five dollars, one time',
        });
      });

      test('the selected entry\'s non-null fields win over the existing price\'s on a genuine conflict', () => {
        const extraction = validModelOutput();
        extraction.service_request.price = {
          amount_usd: 65, unit: 'one_time', caller_response: 'accepted', accepted: true, stated_by: 'agent', tier_mentioned: 'silver',
        };
        extraction.service_request.prices = [
          { amount_usd: 65, unit: 'one_time', caller_response: 'accepted', stated_by: 'caller', tier_mentioned: 'gold' },
        ];
        const result = normalizeExtractionV2(extraction);
        expect(result.service_request.price).toMatchObject({ amount_usd: 65, unit: 'one_time', stated_by: 'caller', tier_mentioned: 'gold' });
      });

      test('a different price (amount or unit mismatch) still replaces outright, never merges', () => {
        const sameAmountDifferentUnit = validModelOutput();
        sameAmountDifferentUnit.service_request.price = { amount_usd: 65, unit: 'per_month', stated_by: 'agent', tier_mentioned: 'gold' };
        sameAmountDifferentUnit.service_request.prices = [
          { amount_usd: 65, unit: 'one_time', caller_response: 'accepted' },
        ];
        const result = normalizeExtractionV2(sameAmountDifferentUnit);
        expect(result.service_request.price).toEqual({ amount_usd: 65, unit: 'one_time', caller_response: 'accepted', accepted: true });
        expect(result.service_request.price).not.toHaveProperty('tier_mentioned');
      });

      test('an amount_max_usd mismatch (range vs single) also replaces outright', () => {
        const extraction = validModelOutput();
        extraction.service_request.price = { amount_usd: 90, amount_max_usd: 100, unit: 'per_quarter', stated_by: 'agent', tier_mentioned: 'gold' };
        extraction.service_request.prices = [
          { amount_usd: 90, amount_max_usd: null, unit: 'per_quarter', caller_response: 'accepted' },
        ];
        const result = normalizeExtractionV2(extraction);
        expect(result.service_request.price).toEqual({ amount_usd: 90, amount_max_usd: null, unit: 'per_quarter', caller_response: 'accepted', accepted: true });
        expect(result.service_request.price).not.toHaveProperty('tier_mentioned');
      });

      // codex #4722 r2 push-gate P1: the generic "overlay's non-null fields
      // win" rule must NOT apply to caller_response/accepted — null is a
      // real, meaningful caller_response value ('not_at_issue' is not
      // null, but a null caller_response must still win over a stale base
      // value), and accepted is purely derived from it. A merge that
      // filtered out a null caller_response, or merged accepted field-by-
      // field instead of re-deriving it, would resurrect a stale
      // acceptance the call no longer supports.
      test('merging a same-identity prices[] entry with caller_response not_at_issue clears a stale accepted, never resurrects it', () => {
        const extraction = validModelOutput();
        extraction.service_request.price = {
          amount_usd: 65, unit: 'one_time', caller_response: 'accepted', accepted: true, stated_by: 'agent', tier_mentioned: 'gold',
        };
        extraction.service_request.prices = [
          { amount_usd: 65, unit: 'one_time', caller_response: 'not_at_issue' },
        ];
        const result = normalizeExtractionV2(extraction);
        expect(result.service_request.price).toMatchObject({
          amount_usd: 65, unit: 'one_time', caller_response: 'not_at_issue', accepted: null,
          // Merge still fills the gap from the richer existing price.
          stated_by: 'agent', tier_mentioned: 'gold',
        });
      });

      test('an explicit null caller_response on the selected entry wins over the existing price\'s caller_response, and accepted is re-derived to null', () => {
        const extraction = validModelOutput();
        extraction.service_request.price = {
          amount_usd: 65, unit: 'one_time', caller_response: 'accepted', accepted: true, stated_by: 'agent',
        };
        extraction.service_request.prices = [
          { amount_usd: 65, unit: 'one_time', caller_response: null },
        ];
        const result = normalizeExtractionV2(extraction);
        expect(result.service_request.price).toMatchObject({ amount_usd: 65, unit: 'one_time', caller_response: null, accepted: null, stated_by: 'agent' });
      });
    });

    test('a single price with no prices array is left alone (only accepted derivation applies)', () => {
      const extraction = validModelOutput();
      extraction.service_request.price = { amount_usd: 65, unit: 'one_time', caller_response: 'accepted', accepted: false };
      const result = normalizeExtractionV2(extraction);
      expect(result.service_request.price).toMatchObject({ amount_usd: 65, unit: 'one_time', caller_response: 'accepted', accepted: true });
      expect(result.service_request.prices).toBeUndefined();
    });

    test('an empty prices[] array leaves price alone', () => {
      const extraction = validModelOutput();
      extraction.service_request.price = { amount_usd: 65, caller_response: 'accepted', accepted: false };
      extraction.service_request.prices = [];
      const result = normalizeExtractionV2(extraction);
      expect(result.service_request.price).toMatchObject({ amount_usd: 65, caller_response: 'accepted', accepted: true });
      expect(result.service_request.prices).toEqual([]);
    });

    test('a service_request with neither price nor prices is untouched', () => {
      const extraction = validModelOutput();
      delete extraction.service_request.price;
      const before = JSON.stringify(extraction.service_request);
      const result = normalizeExtractionV2(extraction);
      expect(JSON.stringify(result.service_request)).toBe(before);
    });
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
