const {
  DECISION_MODE,
  DECISION_VERSION,
  buildLegacyShadowRouteDecision,
} = require('../services/call-route-decisions');

describe('call route decisions', () => {
  const call = {
    id: '11111111-1111-4111-8111-111111111111',
    twilio_call_sid: 'CA123',
  };

  test('records successful legacy appointment auto-create as shadow decision', () => {
    const decision = buildLegacyShadowRouteDecision({
      call,
      customerId: '22222222-2222-4222-8222-222222222222',
      leadId: '33333333-3333-4333-8333-333333333333',
      extracted: {
        first_name: 'Ada',
        phone: '+19415551212',
        appointment_confirmed: true,
        preferred_date_time: '2026-06-03T10:00',
        matched_service: 'General Pest Control',
      },
      appointmentResult: {
        scheduledServiceId: '44444444-4444-4444-8444-444444444444',
        smsSent: true,
        service: 'General Pest Control',
      },
      serviceResolution: { ok: true, service: 'General Pest Control' },
      hasSpecificTime: true,
    });

    expect(decision).toMatchObject({
      decision_version: DECISION_VERSION,
      mode: DECISION_MODE,
      validator_recommendation: 'auto_create_appointment',
      final_action_taken: 'auto_create_appointment',
      created_scheduled_service_id: '44444444-4444-4444-8444-444444444444',
    });
    expect(decision.blocked_reasons).toEqual([]);
    expect(decision.allowed_reasons).toEqual(expect.arrayContaining([
      'codex_shadow_route_decision',
      'appointment_confirmed_extracted',
      'specific_time_extracted',
      'schedulable_service_resolved',
    ]));
    expect(decision.ai_validation_model).toBe('codex_legacy_rules');
    expect(decision.field_write_plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'first_name', extracted_value: 'Ada' }),
    ]));
  });

  test('records blocked appointment reasons for calibration review', () => {
    const decision = buildLegacyShadowRouteDecision({
      call,
      customerId: null,
      extracted: {
        appointment_confirmed: true,
        preferred_date_time: 'tomorrow',
        requested_service: 'SEO for pest control',
      },
      appointmentResult: {
        skippedReason: 'unsupported_service',
        service: 'General Pest Control',
      },
      serviceResolution: { ok: false, reason: 'unsupported_service' },
      hasSpecificTime: false,
    });

    expect(decision.validator_recommendation).toBe('needs_review');
    expect(decision.final_action_taken).toBe('needs_review');
    expect(decision.blocked_reasons).toEqual(expect.arrayContaining([
      'time_not_specific',
      'missing_customer',
      'unsupported_service',
      'no_customer_match',
    ]));
  });
});
