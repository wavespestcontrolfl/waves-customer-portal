const {
  computeDeterministicTriageFlags,
  mergeTriageFlags,
  suppressAddressFlagsForAV,
  canAutoRoute,
  SERVICE_AREA_COUNTIES,
  normalizeCounty,
  isInServiceAreaCounty,
  hasCanonicalWriteBlock,
  CANONICAL_WRITE_BLOCKING_FLAGS,
  hasNameEmailMismatch,
} = require('../services/call-triage-flags');

const {
  computeAppointmentIdempotencyKey,
  computeAddressHash,
  checkTcpaConsent,
  buildRouteDecision,
  buildTriageItem,
} = require('../services/call-routing-gates');

function validV2Extraction() {
  return {
    meta: {
      call_id: '550e8400-e29b-41d4-a716-446655440000',
      schema_version: '1.0.0',
      extracted_at: '2026-05-28T02:30:00Z',
      extraction_model: 'gemini-2.5-flash',
      extraction_prompt_version: 'v1-abc123',
      is_voicemail: false,
      is_spam: false,
      transcript_word_count: 342,
      call_summary: 'Caller reports roaches in kitchen.',
    },
    caller: {
      first_name: 'Maria',
      last_name: 'Rodriguez',
      phone_e164: '+19415551234',
      phone_source: 'spoken',
      email: null,
      relationship_to_property: 'owner',
      on_site_authorization: true,
      decision_maker_present: true,
    },
    consent: {
      sms_consent_given: true,
      sms_consent_quote: 'Yes, you can text me.',
      call_recording_disclosed: true,
      do_not_contact_request: false,
    },
    property: {
      service_address: {
        street_line_1: '8224 Abalone Loop',
        city: 'Parrish',
        state: 'FL',
        postal_code: '34219',
        county: 'Manatee',
      },
      property_type: 'single_family',
      hoa_community_flag: false,
      hoa_common_area_service: false,
    },
    service_request: {
      primary_service_category: 'pest_general',
      pests_observed_status: 'observed',
      pests_observed: [{ pest_type: 'roaches_german', severity_signal: 'sighting_multiple' }],
      service_intent: 'active_infestation_treatment',
      urgency: 'within_48_hours',
    },
    customer_history: {
      status: 'new_customer',
      prior_complaint_mentioned: false,
    },
    scheduling: {
      status: 'confirmed',
      confirmed_start_at: '2026-05-28T10:00:00-04:00',
    },
    sentiment_and_lead: {
      sentiment: 'frustrated',
      lead_quality: 'hot',
    },
    confidence: {
      caller_identity: 0.9,
      service_address: 0.95,
      primary_service_category: 0.95,
      urgency: 0.85,
      consent_capture: 0.92,
      overall: 0.91,
    },
    triage_flags: [],
  };
}

// ═══════════════════════════════════════════════════
// Deterministic Triage Flags
// ═══════════════════════════════════════════════════

describe('computeDeterministicTriageFlags', () => {
  test('clean extraction produces no flags', () => {
    expect(computeDeterministicTriageFlags(validV2Extraction())).toEqual([]);
  });

  test('voicemail flag', () => {
    const e = validV2Extraction();
    e.meta.is_voicemail = true;
    expect(computeDeterministicTriageFlags(e)).toContain('voicemail');
  });

  test('spam flag', () => {
    const e = validV2Extraction();
    e.meta.is_spam = true;
    expect(computeDeterministicTriageFlags(e)).toContain('spam_or_wrong_number');
  });

  test('missing address flags missing_service_address', () => {
    const e = validV2Extraction();
    e.property.service_address = { street_line_1: null, city: null, postal_code: null };
    expect(computeDeterministicTriageFlags(e)).toContain('missing_service_address');
  });

  test('low address confidence', () => {
    const e = validV2Extraction();
    e.confidence.service_address = 0.3;
    expect(computeDeterministicTriageFlags(e)).toContain('low_confidence_address');
  });

  test('out of service area — Lee County', () => {
    const e = validV2Extraction();
    e.property.service_address.county = 'Lee';
    expect(computeDeterministicTriageFlags(e)).toContain('out_of_service_area');
  });

  test('in service area — Sarasota', () => {
    const e = validV2Extraction();
    e.property.service_address.county = 'Sarasota';
    expect(computeDeterministicTriageFlags(e)).not.toContain('out_of_service_area');
  });

  test('in service area — lowercase county', () => {
    const e = validV2Extraction();
    e.property.service_address.county = 'sarasota';
    expect(computeDeterministicTriageFlags(e)).not.toContain('out_of_service_area');
  });

  test('in service area — uppercase county', () => {
    const e = validV2Extraction();
    e.property.service_address.county = 'MANATEE';
    expect(computeDeterministicTriageFlags(e)).not.toContain('out_of_service_area');
  });

  test('in service area — "County" suffix', () => {
    const e = validV2Extraction();
    e.property.service_address.county = 'Manatee County';
    expect(computeDeterministicTriageFlags(e)).not.toContain('out_of_service_area');
  });

  test('out of service area — lowercase Lee', () => {
    const e = validV2Extraction();
    e.property.service_address.county = 'lee county';
    expect(computeDeterministicTriageFlags(e)).toContain('out_of_service_area');
  });

  describe('address validation overrides model address signals', () => {
    test('validated_accept clears low-confidence + county flags (clean auto-route)', () => {
      const e = validV2Extraction();
      e.confidence.service_address = 0.3;       // model unsure
      e.property.service_address.county = 'Lee'; // model has wrong/out-of-area county string
      const av = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
      const flags = computeDeterministicTriageFlags(e, { addressValidation: av });
      expect(flags).not.toContain('low_confidence_address');
      expect(flags).not.toContain('out_of_service_area');
      expect(flags).not.toContain('address_unverified');
    });

    test('corrected (bad zip rewritten) clears address triage — the Parrish case', () => {
      const e = validV2Extraction();
      e.confidence.service_address = 0.4;
      const av = { status: 'corrected', inServiceArea: true, county: 'Manatee County', normalized: { postal_code: '34219' } };
      const flags = computeDeterministicTriageFlags(e, { addressValidation: av });
      expect(flags).not.toContain('low_confidence_address');
      expect(flags).not.toContain('address_unverified');
    });

    test('out_of_service_area verdict flags out_of_service_area regardless of model county', () => {
      const e = validV2Extraction();
      e.property.service_address.county = 'Manatee'; // model thinks in-area
      const av = { status: 'out_of_service_area', inServiceArea: false, county: 'Fulton County' };
      const flags = computeDeterministicTriageFlags(e, { addressValidation: av });
      expect(flags).toContain('out_of_service_area');
    });

    test('confirm_needed / missing_component / ambiguous → address_unverified', () => {
      for (const status of ['confirm_needed', 'missing_component', 'ambiguous']) {
        const e = validV2Extraction();
        const flags = computeDeterministicTriageFlags(e, { addressValidation: { status } });
        expect(flags).toContain('address_unverified');
      }
    });

    test('api_unavailable holds for review (address_validation_unavailable) and still applies model signals', () => {
      const e = validV2Extraction();
      e.confidence.service_address = 0.3;
      const flags = computeDeterministicTriageFlags(e, { addressValidation: { status: 'api_unavailable' } });
      expect(flags).toContain('address_validation_unavailable');
      expect(flags).toContain('low_confidence_address'); // fell back to model signal
    });

    test('not_attempted (validation disabled) falls back to model signals exactly as before', () => {
      const e = validV2Extraction();
      e.confidence.service_address = 0.3;
      e.property.service_address.county = 'Lee';
      const flags = computeDeterministicTriageFlags(e, { addressValidation: { status: 'not_attempted' } });
      expect(flags).toContain('low_confidence_address');
      expect(flags).toContain('out_of_service_area');
      expect(flags).not.toContain('address_unverified');
    });

    test('clean validated address allows auto-route (no address flags block it)', () => {
      const e = validV2Extraction();
      const av = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
      expect(canAutoRoute(e, { contactPhone: '+19415551234', addressValidation: av }).allowed).toBe(true);
    });

    test('AV acceptance strips a stale MODEL address flag so it does not block (Codex P2)', () => {
      const e = validV2Extraction();
      e.triage_flags = ['low_confidence_address']; // model emitted it
      const av = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
      expect(canAutoRoute(e, { contactPhone: '+19415551234', addressValidation: av }).allowed).toBe(true);
    });

    test('AV acceptance clears the model address_unverifiable flag (the model marks nearly every call)', () => {
      // The model emits `address_unverifiable` (schema enum / prompt) on most
      // calls; if AV acceptance does not clear it, no clean address ever routes.
      const e = validV2Extraction();
      e.triage_flags = ['address_unverifiable'];
      const av = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
      expect(suppressAddressFlagsForAV(e.triage_flags, av)).not.toContain('address_unverifiable');
      expect(canAutoRoute(e, { contactPhone: '+19415551234', addressValidation: av }).allowed).toBe(true);
      // corrected (bad zip rewritten) clears it too
      expect(suppressAddressFlagsForAV(['address_unverifiable'], { status: 'corrected' })).not.toContain('address_unverifiable');
      // but a non-accepting verdict leaves it in place
      expect(suppressAddressFlagsForAV(['address_unverifiable'], { status: 'confirm_needed' })).toContain('address_unverifiable');
    });

    test('AV acceptance clears a stale MODEL out_of_service_area hard-veto', () => {
      const e = validV2Extraction();
      e.triage_flags = ['out_of_service_area']; // model wrongly thought out-of-area
      const av = { status: 'corrected', inServiceArea: true, county: 'Manatee County' };
      const r = canAutoRoute(e, { contactPhone: '+19415551234', addressValidation: av });
      expect(r.allowed).toBe(true);
      expect(suppressAddressFlagsForAV(e.triage_flags, av)).not.toContain('out_of_service_area');
    });

    test('without AV acceptance, a model address flag still blocks (no suppression)', () => {
      const e = validV2Extraction();
      e.triage_flags = ['low_confidence_address'];
      const av = { status: 'confirm_needed' };
      expect(canAutoRoute(e, { contactPhone: '+19415551234', addressValidation: av }).allowed).toBe(false);
      expect(suppressAddressFlagsForAV(e.triage_flags, av)).toContain('low_confidence_address');
    });
  });

  test('ambiguous scheduling', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'ambiguous';
    expect(computeDeterministicTriageFlags(e)).toContain('ambiguous_scheduling');
  });

  test('reschedule request', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'reschedule_requested';
    expect(computeDeterministicTriageFlags(e)).toContain('reschedule_or_cancel');
  });

  test('cancellation', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'canceled';
    expect(computeDeterministicTriageFlags(e)).toContain('reschedule_or_cancel');
  });

  test('no SMS consent does NOT block routing (handled by TCPA gate downstream)', () => {
    const e = validV2Extraction();
    e.consent.sms_consent_given = false;
    expect(computeDeterministicTriageFlags(e)).not.toContain('sms_consent_missing');
  });

  test('no SMS consent still allows appointment creation', () => {
    const e = validV2Extraction();
    e.consent.sms_consent_given = false;
    expect(canAutoRoute(e).allowed).toBe(true);
  });

  test('do not contact', () => {
    const e = validV2Extraction();
    e.consent.do_not_contact_request = true;
    const flags = computeDeterministicTriageFlags(e);
    expect(flags).toContain('do_not_contact_requested');
  });

  test('no spoken phone but ANI present → NOT flagged (we can still call back)', () => {
    const e = validV2Extraction();
    e.caller.phone_e164 = null;
    expect(computeDeterministicTriageFlags(e, { contactPhone: '+19415551234' })).not.toContain('caller_phone_missing');
  });

  test('no spoken phone AND no ANI (blocked caller ID) → flagged', () => {
    const e = validV2Extraction();
    e.caller.phone_e164 = null;
    expect(computeDeterministicTriageFlags(e, { contactPhone: null })).toContain('caller_phone_missing');
  });

  test('no spoken phone, no opts → flagged (conservative default)', () => {
    const e = validV2Extraction();
    e.caller.phone_e164 = null;
    expect(computeDeterministicTriageFlags(e)).toContain('caller_phone_missing');
  });

  test('no spoken phone + withheld caller ID ("anonymous"/"unknown") → flagged (not dialable)', () => {
    const e = validV2Extraction();
    e.caller.phone_e164 = null;
    for (const ani of ['anonymous', 'unknown', 'restricted', 'unavailable', '']) {
      expect(computeDeterministicTriageFlags(e, { contactPhone: ani })).toContain('caller_phone_missing');
    }
  });

  test('no spoken phone + dialable ANI variants → NOT flagged', () => {
    const e = validV2Extraction();
    e.caller.phone_e164 = null;
    for (const ani of ['+19415551234', '9415551234', '(941) 555-1234']) {
      expect(computeDeterministicTriageFlags(e, { contactPhone: ani })).not.toContain('caller_phone_missing');
    }
  });

  test('spam lead quality', () => {
    const e = validV2Extraction();
    e.sentiment_and_lead.lead_quality = 'spam_or_solicitation';
    expect(computeDeterministicTriageFlags(e)).toContain('spam_or_wrong_number');
  });

  test('lead_quality = out_of_service_area flags out_of_service_area', () => {
    const e = validV2Extraction();
    e.sentiment_and_lead.lead_quality = 'out_of_service_area';
    expect(computeDeterministicTriageFlags(e)).toContain('out_of_service_area');
  });

  test('HOA common area', () => {
    const e = validV2Extraction();
    e.property.hoa_common_area_service = true;
    expect(computeDeterministicTriageFlags(e)).toContain('hoa_common_area_requires_approval');
  });

  test('prior complaint', () => {
    const e = validV2Extraction();
    e.customer_history.prior_complaint_mentioned = true;
    expect(computeDeterministicTriageFlags(e)).toContain('prior_complaint_unresolved');
  });

  test('low overall confidence', () => {
    const e = validV2Extraction();
    e.confidence.overall = 0.4;
    expect(computeDeterministicTriageFlags(e)).toContain('low_extraction_confidence');
  });

  test('caller not authorized — tenant without authorization', () => {
    const e = validV2Extraction();
    e.caller.relationship_to_property = 'tenant';
    e.caller.on_site_authorization = false;
    expect(computeDeterministicTriageFlags(e)).toContain('caller_not_authorized');
  });

  test('caller authorized — tenant with authorization', () => {
    const e = validV2Extraction();
    e.caller.relationship_to_property = 'tenant';
    e.caller.on_site_authorization = true;
    expect(computeDeterministicTriageFlags(e)).not.toContain('caller_not_authorized');
  });

  test('owner without explicit authorization is fine', () => {
    const e = validV2Extraction();
    e.caller.relationship_to_property = 'owner';
    e.caller.on_site_authorization = false;
    expect(computeDeterministicTriageFlags(e)).not.toContain('caller_not_authorized');
  });

  test('commercial property', () => {
    const e = validV2Extraction();
    e.property.property_type = 'commercial';
    expect(computeDeterministicTriageFlags(e)).toContain('commercial_requires_quote');
  });

  test('null extraction returns empty', () => {
    expect(computeDeterministicTriageFlags(null)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════
// Merge Triage Flags
// ═══════════════════════════════════════════════════

describe('mergeTriageFlags', () => {
  test('unions model and deterministic flags', () => {
    const result = mergeTriageFlags(
      ['out_of_service_area', 'spam_or_wrong_number'],
      ['missing_service_address', 'spam_or_wrong_number']
    );
    expect(result).toHaveLength(3);
    expect(result).toContain('out_of_service_area');
    expect(result).toContain('spam_or_wrong_number');
    expect(result).toContain('missing_service_address');
  });

  test('handles null inputs', () => {
    expect(mergeTriageFlags(null, ['a'])).toEqual(['a']);
    expect(mergeTriageFlags(['b'], null)).toEqual(['b']);
    expect(mergeTriageFlags(null, null)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════
// canAutoRoute
// ═══════════════════════════════════════════════════

describe('canAutoRoute', () => {
  test('clean confirmed extraction auto-routes', () => {
    const result = canAutoRoute(validV2Extraction());
    expect(result.allowed).toBe(true);
  });

  test('blocked by triage flags', () => {
    const e = validV2Extraction();
    e.triage_flags = ['out_of_service_area'];
    const result = canAutoRoute(e);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('triage_flags');
  });

  test('blocked by deterministic flags even when model flags empty', () => {
    const e = validV2Extraction();
    e.property.service_address = { street_line_1: null, city: null, postal_code: null };
    const result = canAutoRoute(e);
    expect(result.allowed).toBe(false);
    expect(result.flags).toContain('missing_service_address');
  });

  test('blocked by low confidence', () => {
    const e = validV2Extraction();
    e.confidence.overall = 0.3;
    const result = canAutoRoute(e);
    expect(result.allowed).toBe(false);
  });

  test('blocked when scheduling not confirmed', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'requested';
    const result = canAutoRoute(e);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_confirmed');
  });

  test('blocked when confirmed but no confirmed_start_at', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'confirmed';
    e.scheduling.confirmed_start_at = null;
    const result = canAutoRoute(e);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('confirmed_without_start_time');
  });

  test('model no_sms_consent_captured flag does NOT block appointment', () => {
    const e = validV2Extraction();
    e.triage_flags = ['no_sms_consent_captured'];
    const result = canAutoRoute(e);
    expect(result.allowed).toBe(true);
  });

  test('model no_sms_consent_captured combined with real flag still blocks', () => {
    const e = validV2Extraction();
    e.triage_flags = ['no_sms_consent_captured', 'out_of_service_area'];
    const result = canAutoRoute(e);
    expect(result.allowed).toBe(false);
    expect(result.appointmentBlockingFlags).toContain('out_of_service_area');
    expect(result.appointmentBlockingFlags).not.toContain('no_sms_consent_captured');
  });

  test('blocked when scheduling is offered', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'offered';
    expect(canAutoRoute(e).allowed).toBe(false);
  });

  test('blocked when scheduling is none', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'none';
    expect(canAutoRoute(e).allowed).toBe(false);
  });

  test('blocked by do_not_contact', () => {
    const e = validV2Extraction();
    e.consent.do_not_contact_request = true;
    const result = canAutoRoute(e);
    expect(result.allowed).toBe(false);
  });

  test('null extraction blocked', () => {
    expect(canAutoRoute(null).allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════
// Idempotency Key
// ═══════════════════════════════════════════════════

describe('computeAppointmentIdempotencyKey', () => {
  test('same inputs produce same key', () => {
    const params = {
      callLogId: '550e8400-e29b-41d4-a716-446655440000',
      schedulingStatus: 'confirmed',
      confirmedStartAt: '2026-05-28T10:00:00-04:00',
      primaryServiceCategory: 'pest_general',
      addressHash: 'abc123',
    };
    expect(computeAppointmentIdempotencyKey(params)).toBe(computeAppointmentIdempotencyKey(params));
  });

  test('different inputs produce different keys', () => {
    const base = {
      callLogId: '550e8400-e29b-41d4-a716-446655440000',
      schedulingStatus: 'confirmed',
      confirmedStartAt: '2026-05-28T10:00:00-04:00',
      primaryServiceCategory: 'pest_general',
      addressHash: 'abc123',
    };
    const different = { ...base, confirmedStartAt: '2026-05-29T14:00:00-04:00' };
    expect(computeAppointmentIdempotencyKey(base)).not.toBe(computeAppointmentIdempotencyKey(different));
  });

  test('key is 64 chars hex', () => {
    const key = computeAppointmentIdempotencyKey({ callLogId: 'test' });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  test('handles missing values gracefully', () => {
    const key = computeAppointmentIdempotencyKey({});
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('computeAddressHash', () => {
  test('produces consistent hash', () => {
    const addr = { street_line_1: '8224 Abalone Loop', city: 'Parrish', postal_code: '34219' };
    expect(computeAddressHash(addr)).toBe(computeAddressHash(addr));
  });

  test('case insensitive', () => {
    const a = { street_line_1: '8224 Abalone Loop', city: 'Parrish', postal_code: '34219' };
    const b = { street_line_1: '8224 abalone loop', city: 'parrish', postal_code: '34219' };
    expect(computeAddressHash(a)).toBe(computeAddressHash(b));
  });

  // Regression: street must participate in the hash. The call site builds this object
  // from customer.address_line1 (NOT customer.street_address, which does not exist as a
  // column — that typo collapsed the hash to city+zip and let same-city/zip street
  // corrections silently reuse the pre-correction appointment via idempotency_key).
  test('differs when only the street differs (same city/zip)', () => {
    const a = { street_line_1: '8224 Abalone Loop', city: 'Parrish', postal_code: '34219' };
    const b = { street_line_1: '101 Main St', city: 'Parrish', postal_code: '34219' };
    expect(computeAddressHash(a)).not.toBe(computeAddressHash(b));
  });

  test('missing street degrades to city/zip but stays distinct from full address', () => {
    const full = { street_line_1: '8224 Abalone Loop', city: 'Parrish', postal_code: '34219' };
    const noStreet = { street_line_1: undefined, city: 'Parrish', postal_code: '34219' };
    expect(computeAddressHash(noStreet)).not.toBeNull();
    expect(computeAddressHash(noStreet)).not.toBe(computeAddressHash(full));
  });

  test('null address returns null', () => {
    expect(computeAddressHash(null)).toBeNull();
  });

  test('empty address returns null', () => {
    expect(computeAddressHash({})).toBeNull();
  });
});

// ═══════════════════════════════════════════════════
// TCPA Consent Gate
// ═══════════════════════════════════════════════════

describe('checkTcpaConsent', () => {
  test('SMS consent given allows SMS', () => {
    const result = checkTcpaConsent(validV2Extraction());
    expect(result.canSms).toBe(true);
    expect(result.canEmail).toBe(true);
  });

  test('no SMS consent falls back to email', () => {
    const e = validV2Extraction();
    e.consent.sms_consent_given = false;
    const result = checkTcpaConsent(e);
    expect(result.canSms).toBe(false);
    expect(result.canEmail).toBe(true);
    expect(result.reason).toBe('sms_consent_not_given');
  });

  test('do not contact blocks everything', () => {
    const e = validV2Extraction();
    e.consent.do_not_contact_request = true;
    const result = checkTcpaConsent(e);
    expect(result.canSms).toBe(false);
    expect(result.canEmail).toBe(false);
    expect(result.reason).toBe('do_not_contact_requested');
  });

  test('missing consent object falls back to email', () => {
    const result = checkTcpaConsent({ meta: {} });
    expect(result.canSms).toBe(false);
    expect(result.canEmail).toBe(true);
  });

  test('null extraction falls back to email', () => {
    const result = checkTcpaConsent(null);
    expect(result.canSms).toBe(false);
    expect(result.canEmail).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
// Route Decision Builder
// ═══════════════════════════════════════════════════

describe('buildRouteDecision', () => {
  test('builds route decision for auto-route', () => {
    const decision = buildRouteDecision({
      callLogId: '550e8400-e29b-41d4-a716-446655440000',
      extraction: validV2Extraction(),
      finalTriageFlags: [],
      routingResult: { allowed: true },
      action: 'auto_route',
    });
    expect(decision.call_log_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(decision.validator_recommendation).toBe('auto_create_appointment');
    expect(decision.final_action_taken).toBe('auto_route');
    expect(decision.mode).toBe('enforce');
  });

  test('builds route decision for triage', () => {
    const decision = buildRouteDecision({
      callLogId: 'test-id',
      extraction: validV2Extraction(),
      finalTriageFlags: ['out_of_service_area'],
      routingResult: { allowed: false },
      action: 'triage_review',
    });
    expect(decision.validator_recommendation).toBe('needs_review');
    expect(JSON.parse(decision.blocked_reasons)).toContain('out_of_service_area');
  });
});

// ═══════════════════════════════════════════════════
// Triage Item Builder
// ═══════════════════════════════════════════════════

describe('buildTriageItem', () => {
  test('maps flag to category', () => {
    const item = buildTriageItem({
      callLogId: 'test-id',
      flag: 'out_of_service_area',
      extraction: validV2Extraction(),
    });
    expect(item.category).toBe('out_of_service_area');
    expect(item.reason_code).toBe('out_of_service_area');
    expect(item.status).toBe('open');
  });

  test('includes synopsis in summary', () => {
    const item = buildTriageItem({
      callLogId: 'test-id',
      flag: 'missing_service_address',
      extraction: validV2Extraction(),
    });
    expect(item.summary).toBe('Caller reports roaches in kitchen.');
  });

  test('unknown flag defaults to service_unknown', () => {
    const item = buildTriageItem({
      callLogId: 'test-id',
      flag: 'some_future_flag',
      extraction: validV2Extraction(),
    });
    expect(item.category).toBe('service_unknown');
  });
});

// ═══════════════════════════════════════════════════
// Migration
// ═══════════════════════════════════════════════════

describe('idempotency migration', () => {
  const migration = require('../models/migrations/20260528000002_scheduled_services_idempotency');

  test('exports up and down functions', () => {
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});

// ═══════════════════════════════════════════════════
// Canonical-Write Blocking (hard vetoes)
// ═══════════════════════════════════════════════════

describe('hasCanonicalWriteBlock', () => {
  test('spam_or_wrong_number is a hard veto', () => {
    expect(hasCanonicalWriteBlock(['spam_or_wrong_number'])).toBe(true);
  });
  test('out_of_service_area is a hard veto', () => {
    expect(hasCanonicalWriteBlock(['out_of_service_area'])).toBe(true);
  });
  test('do_not_contact_requested is a hard veto', () => {
    expect(hasCanonicalWriteBlock(['do_not_contact_requested'])).toBe(true);
  });
  test('soft blocks are NOT canonical-write vetoes', () => {
    expect(hasCanonicalWriteBlock(['ambiguous_scheduling'])).toBe(false);
    expect(hasCanonicalWriteBlock(['hoa_common_area_requires_approval'])).toBe(false);
    expect(hasCanonicalWriteBlock(['caller_not_authorized'])).toBe(false);
    expect(hasCanonicalWriteBlock(['low_extraction_confidence'])).toBe(false);
    expect(hasCanonicalWriteBlock(['prior_complaint_unresolved'])).toBe(false);
  });
  test('mixed flags: any hard veto present triggers block', () => {
    expect(hasCanonicalWriteBlock(['ambiguous_scheduling', 'out_of_service_area'])).toBe(true);
  });
  test('empty / null is not a block', () => {
    expect(hasCanonicalWriteBlock([])).toBe(false);
    expect(hasCanonicalWriteBlock(null)).toBe(false);
  });
  test('set contains exactly the three hard vetoes', () => {
    expect([...CANONICAL_WRITE_BLOCKING_FLAGS].sort()).toEqual(
      ['do_not_contact_requested', 'out_of_service_area', 'spam_or_wrong_number']
    );
  });
});

// ═══════════════════════════════════════════════════
// County Normalization
// ═══════════════════════════════════════════════════

describe('normalizeCounty', () => {
  test('lowercases', () => {
    expect(normalizeCounty('SARASOTA')).toBe('sarasota');
  });
  test('strips County suffix', () => {
    expect(normalizeCounty('Manatee County')).toBe('manatee');
  });
  test('handles lowercase county suffix', () => {
    expect(normalizeCounty('charlotte county')).toBe('charlotte');
  });
  test('null/empty returns null', () => {
    expect(normalizeCounty(null)).toBeNull();
    expect(normalizeCounty('')).toBeNull();
  });
});

describe('isInServiceAreaCounty', () => {
  test('matches exact display names', () => {
    expect(isInServiceAreaCounty('Manatee')).toBe(true);
    expect(isInServiceAreaCounty('DeSoto')).toBe(true);
  });
  test('matches case-insensitively', () => {
    expect(isInServiceAreaCounty('sarasota')).toBe(true);
    expect(isInServiceAreaCounty('MANATEE')).toBe(true);
    expect(isInServiceAreaCounty('desoto')).toBe(true);
  });
  test('matches with County suffix', () => {
    expect(isInServiceAreaCounty('Manatee County')).toBe(true);
    expect(isInServiceAreaCounty('charlotte county')).toBe(true);
  });
  test('rejects out-of-area', () => {
    expect(isInServiceAreaCounty('Lee')).toBe(false);
    expect(isInServiceAreaCounty('lee county')).toBe(false);
    expect(isInServiceAreaCounty('Hillsborough')).toBe(false);
  });
  test('null returns false', () => {
    expect(isInServiceAreaCounty(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════
// Side-Effect Guard Tests
// ═══════════════════════════════════════════════════

describe('side-effect guards', () => {
  test('scheduling.status=requested does NOT auto-route', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'requested';
    expect(canAutoRoute(e).allowed).toBe(false);
  });

  test('scheduling.status=offered does NOT auto-route', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'offered';
    expect(canAutoRoute(e).allowed).toBe(false);
  });

  test('scheduling.status=ambiguous does NOT auto-route', () => {
    const e = validV2Extraction();
    e.scheduling.status = 'ambiguous';
    expect(canAutoRoute(e).allowed).toBe(false);
  });

  test('scheduling.status=confirmed WITH consent auto-routes', () => {
    expect(canAutoRoute(validV2Extraction()).allowed).toBe(true);
  });

  test('no SMS without explicit consent', () => {
    const e = validV2Extraction();
    e.consent.sms_consent_given = false;
    expect(checkTcpaConsent(e).canSms).toBe(false);
  });

  test('retry with same key produces same idempotency hash', () => {
    const params = {
      callLogId: 'retry-test',
      schedulingStatus: 'confirmed',
      confirmedStartAt: '2026-05-28T10:00:00-04:00',
      primaryServiceCategory: 'pest_general',
      addressHash: 'xyz789',
    };
    const key1 = computeAppointmentIdempotencyKey(params);
    const key2 = computeAppointmentIdempotencyKey(params);
    expect(key1).toBe(key2);
  });

  test('HOA common area blocks auto-route', () => {
    const e = validV2Extraction();
    e.property.hoa_common_area_service = true;
    expect(canAutoRoute(e).allowed).toBe(false);
  });

  test('out-of-service-area blocks auto-route', () => {
    const e = validV2Extraction();
    e.property.service_address.county = 'Lee';
    expect(canAutoRoute(e).allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════
// Name ↔ Email reconciliation (name_review)
// ═══════════════════════════════════════════════════

describe('hasNameEmailMismatch', () => {
  test('spoken name not corroborated by email → mismatch (Jeanette vs gennettryan@)', () => {
    expect(hasNameEmailMismatch({ first_name: 'Jeanette', last_name: null, email: 'gennettryan@yahoo.com' })).toBe(true);
  });
  test('name corroborated by email → no mismatch', () => {
    expect(hasNameEmailMismatch({ first_name: 'Maria', last_name: 'Rodriguez', email: 'mariar@gmail.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'Bob', last_name: 'Smith', email: 'bsmith@x.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'John', last_name: 'Doe', email: 'john.doe@x.com' })).toBe(false);
  });
  test('correct name for the Gennett call → no mismatch (both tokens present)', () => {
    expect(hasNameEmailMismatch({ first_name: 'Ryan', last_name: 'Gennett', email: 'gennettryan@yahoo.com' })).toBe(false);
  });
  test('separator-delimited segment names a different person → mismatch', () => {
    // Surname "smith" matches, but the delimited "john" segment is a first name
    // that contradicts the extracted "Bob".
    expect(hasNameEmailMismatch({ first_name: 'Bob', last_name: 'Smith', email: 'john.smith@x.com' })).toBe(true);
    expect(hasNameEmailMismatch({ first_name: 'Bob', last_name: 'Rodriguez', email: 'maria_rodriguez@x.com' })).toBe(true);
  });
  test('common first-initial + surname + affix mailboxes do NOT false-flag (Codex P2)', () => {
    // jsmithhome / jsmithwork / mrodriguezfamily: surname is a substring of a
    // separator-less segment → not mined; "home"/"work"/"family" are not names.
    expect(hasNameEmailMismatch({ first_name: 'John', last_name: 'Smith', email: 'jsmithhome@x.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'John', last_name: 'Smith', email: 'jsmithwork@x.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'Maria', last_name: 'Rodriguez', email: 'mrodriguezfamily@x.com' })).toBe(false);
    // Affix as an explicit delimited segment is also ignored.
    expect(hasNameEmailMismatch({ first_name: 'John', last_name: 'Smith', email: 'jsmith.home@x.com' })).toBe(false);
  });
  test('concatenated surname+other-name is intentionally NOT mined (no dictionary; caught by rule 1 when wholly wrong)', () => {
    // Surname extracted correctly, first name wrong, no separator → we accept
    // the miss rather than over-triage mailbox variants. Documented tradeoff.
    expect(hasNameEmailMismatch({ first_name: 'Jeanette', last_name: 'Gennett', email: 'gennettryan@yahoo.com' })).toBe(false);
  });
  test('first-initial / first-name-only emails → no mismatch', () => {
    expect(hasNameEmailMismatch({ first_name: 'Maria', last_name: 'Rodriguez', email: 'mariar@gmail.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'John', last_name: 'Smith', email: 'jsmith@x.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'John', last_name: 'Smith', email: 'johnnyc@x.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'Bob', last_name: null, email: 'bobfitness@x.com' })).toBe(false);
  });
  test('delimited role-mailbox segment is not a foreign name (Codex P2 — office.john@)', () => {
    expect(hasNameEmailMismatch({ first_name: 'John', last_name: 'Smith', email: 'office.john@x.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'Maria', last_name: 'Rodriguez', email: 'sales.maria@x.com' })).toBe(false);
  });
  test('generic/role mailbox → never a mismatch', () => {
    expect(hasNameEmailMismatch({ first_name: 'Jeanette', last_name: null, email: 'info@company.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'Bob', last_name: 'Smith', email: 'office@x.com' })).toBe(false);
  });
  test('multi-segment role mailbox with no personal name → no mismatch (Codex P2 — office.sales@)', () => {
    expect(hasNameEmailMismatch({ first_name: 'John', last_name: 'Smith', email: 'office.sales@company.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'Bob', last_name: 'Jones', email: 'sales.support@x.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'Maria', last_name: 'Lee', email: 'billing.office@x.com' })).toBe(false);
  });
  test('no usable signal → no mismatch (null email, null name, short local-part)', () => {
    expect(hasNameEmailMismatch({ first_name: 'Bob', last_name: 'Smith', email: null })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: null, last_name: null, email: 'gennettryan@yahoo.com' })).toBe(false);
    expect(hasNameEmailMismatch({ first_name: 'Al', last_name: null, email: 'xy@x.com' })).toBe(false);
  });
});

describe('name_email_mismatch in routing', () => {
  test('flags name_email_mismatch and blocks auto-route', () => {
    const e = validV2Extraction();
    e.caller.first_name = 'Jeanette';
    e.caller.last_name = null;
    e.caller.email = 'gennettryan@yahoo.com';
    const flags = computeDeterministicTriageFlags(e, { contactPhone: '+19415551234' });
    expect(flags).toContain('name_email_mismatch');
    expect(canAutoRoute(e, { contactPhone: '+19415551234' }).allowed).toBe(false);
  });

  test('name_email_mismatch is appointment-blocking, not SMS-only', () => {
    const e = validV2Extraction();
    e.caller.first_name = 'Jeanette';
    e.caller.last_name = null;
    e.caller.email = 'gennettryan@yahoo.com';
    const r = canAutoRoute(e, { contactPhone: '+19415551234' });
    expect(r.appointmentBlockingFlags).toContain('name_email_mismatch');
  });

  test('maps to name_review triage category', () => {
    const item = buildTriageItem({ callLogId: 'x', flag: 'name_email_mismatch', extraction: { meta: { call_summary: 's' } } });
    expect(item.category).toBe('name_review');
  });
});
