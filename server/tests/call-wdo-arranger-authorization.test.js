// Owner ruling 2026-09-26: a lender or realtor ARRANGING a WDO inspection is
// an authorized caller when staff agreed the time on the call — the same bar
// a homeowner's own booking meets. Live miss (call 17ed9362, 2026-09-24,
// inbound): a lender ordering a refinance WDO inspection, confirmed for 10am
// Monday, blocked with routing.reason "triage_flags" solely on
// caller_not_authorized. The general agent-commitment demotion
// (hasAgentCommittedEvidence, closed-vocabulary grammar) did NOT clear it —
// the agent's quote ("But yeah, we'll see him on Monday at 10 o'clock.") had
// no am/pm and out-of-vocabulary words — and this ruling is deliberately a
// separate, narrower rule that does not touch that grammar.
//
// Anonymized extraction shapes only — no real names/emails/phones.
const {
  isAuthorizedWdoArrangerBooking,
  isWdoInspectionRequest,
  computeDeterministicTriageFlags,
  canAutoRoute,
} = require('../services/call-triage-flags');

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
const ANI = '+19415550100';

// Mirrors the 17ed9362 shape: lender arranging a refinance WDO inspection,
// staff offered a slot, caller confirmed it.
function wdoExtraction(over = {}) {
  return {
    meta: { schema_version: '1.14.0', is_voicemail: false, is_spam: false, call_summary: 'Lender arranging a refinance WDO inspection.' },
    caller: { relationship_to_property: 'lender', on_site_authorization: false },
    property: { service_address: { street_line_1: '123 Example St', city: 'Bradenton', postal_code: '34205', county: 'Manatee' } },
    service_request: {
      primary_service_category: 'wdo',
      specific_service_name: 'WDO Inspection Service',
      service_intent: 'inspection_only',
      urgency: 'within_one_week',
      pests_observed: [],
      pests_observed_status: 'not_discussed',
    },
    scheduling: { status: 'confirmed', confirmed_start_at: '2026-09-28T10:00:00-04:00' },
    confidence: { overall: 0.9, service_address: 0.9 },
    consent: {},
    triage_flags: [],
    ...over,
  };
}

describe('isAuthorizedWdoArrangerBooking (predicate)', () => {
  test('lender + WDO + confirmed with a start time is authorized', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction())).toBe(true);
  });

  test('real_estate_agent + WDO + confirmed is authorized', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ caller: { relationship_to_property: 'real_estate_agent', on_site_authorization: false } }))).toBe(true);
  });

  test('case/whitespace on the relationship is normalized', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ caller: { relationship_to_property: ' Lender ', on_site_authorization: false } }))).toBe(true);
  });

  test('requested/offered scheduling status does not qualify', () => {
    for (const status of ['requested', 'offered', 'ambiguous', 'none']) {
      expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ scheduling: { status, confirmed_start_at: null } }))).toBe(false);
    }
  });

  test('confirmed with no confirmed_start_at does not qualify', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ scheduling: { status: 'confirmed', confirmed_start_at: null } }))).toBe(false);
  });

  test.each(['property_manager', 'other', 'tenant', 'hoa_board_member', 'employee'])(
    '%s is NOT covered by this ruling even with WDO + confirmed',
    (relationship) => {
      expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ caller: { relationship_to_property: relationship, on_site_authorization: false } }))).toBe(false);
    }
  );

  test('a non-WDO service (general pest) does not qualify even for a lender', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction({
      service_request: {
        primary_service_category: 'pest_general',
        specific_service_name: 'General Pest Control',
        service_intent: 'active_infestation_treatment',
        urgency: 'within_one_week',
        pests_observed: [],
        pests_observed_status: 'not_discussed',
      },
    }))).toBe(false);
  });

  test('isWdoInspectionRequest matches on category or specific name', () => {
    expect(isWdoInspectionRequest({ primary_service_category: 'wdo', specific_service_name: null })).toBe(true);
    expect(isWdoInspectionRequest({ primary_service_category: 'inspection_only', specific_service_name: 'WDO Inspection Service' })).toBe(true);
    expect(isWdoInspectionRequest({ primary_service_category: 'pest_general', specific_service_name: 'General Pest Control' })).toBe(false);
  });
});

describe('computeDeterministicTriageFlags — WDO arranger demotion', () => {
  test('lender + WDO + confirmed raises no caller_not_authorized', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction());
    expect(flags).not.toContain('caller_not_authorized');
  });

  test('real_estate_agent + WDO + confirmed raises no caller_not_authorized', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ caller: { relationship_to_property: 'real_estate_agent', on_site_authorization: false } }));
    expect(flags).not.toContain('caller_not_authorized');
  });

  test('lender + WDO but only requested (not confirmed) still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ scheduling: { status: 'requested', confirmed_start_at: null } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('property_manager + WDO + confirmed still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ caller: { relationship_to_property: 'property_manager', on_site_authorization: false } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('other (buyer under contract) + WDO + confirmed still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ caller: { relationship_to_property: 'other', on_site_authorization: false } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('tenant + WDO + confirmed still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ caller: { relationship_to_property: 'tenant', on_site_authorization: false } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('lender + non-WDO service (general pest) + confirmed still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({
      service_request: {
        primary_service_category: 'pest_general',
        specific_service_name: 'General Pest Control',
        service_intent: 'active_infestation_treatment',
        urgency: 'within_one_week',
        pests_observed: [],
        pests_observed_status: 'not_discussed',
      },
    }));
    expect(flags).toContain('caller_not_authorized');
  });
});

describe('canAutoRoute — the pipeline decision for a 17ed9362-shaped call', () => {
  test('lender + WDO + confirmed: deterministic AND model-emitted caller_not_authorized are both suppressed; no blocking flags', () => {
    const r = canAutoRoute(wdoExtraction({ triage_flags: ['caller_not_authorized'] }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(true);
    expect(r.flags || []).not.toContain('caller_not_authorized');
    expect(r.appointmentBlockingFlags || []).not.toContain('caller_not_authorized');
    // No advisory "confirm the account holder" card either — the owner ruled
    // the arranger IS authorized.
    expect(r.failedOpenFlags || []).not.toContain('caller_not_authorized');
  });

  test('real_estate_agent + WDO + confirmed: same result', () => {
    const r = canAutoRoute(wdoExtraction({
      caller: { relationship_to_property: 'real_estate_agent', on_site_authorization: false },
      triage_flags: ['caller_not_authorized'],
    }), { contactPhone: ANI, addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(true);
    expect(r.appointmentBlockingFlags || []).not.toContain('caller_not_authorized');
    expect(r.failedOpenFlags || []).not.toContain('caller_not_authorized');
  });

  test('lender + WDO but status is offered (not confirmed): still blocked', () => {
    const r = canAutoRoute(wdoExtraction({ scheduling: { status: 'offered', confirmed_start_at: null } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
  });

  test('property_manager + WDO + confirmed: still blocked on caller_not_authorized', () => {
    const r = canAutoRoute(wdoExtraction({ caller: { relationship_to_property: 'property_manager', on_site_authorization: false } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('other (buyer under contract) + WDO + confirmed: still blocked', () => {
    const r = canAutoRoute(wdoExtraction({ caller: { relationship_to_property: 'other', on_site_authorization: false } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('tenant + WDO + confirmed: still blocked', () => {
    const r = canAutoRoute(wdoExtraction({ caller: { relationship_to_property: 'tenant', on_site_authorization: false } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('lender + non-WDO service (general pest) + confirmed: still blocked', () => {
    const r = canAutoRoute(wdoExtraction({
      service_request: {
        primary_service_category: 'pest_general',
        specific_service_name: 'General Pest Control',
        service_intent: 'active_infestation_treatment',
        urgency: 'within_one_week',
        pests_observed: [],
        pests_observed_status: 'not_discussed',
      },
    }), { contactPhone: ANI, addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('lender + WDO + confirmed but out_of_service_area also present: still blocked by the OTHER hard flag', () => {
    const r = canAutoRoute(wdoExtraction({
      property: { service_address: { street_line_1: '9 Rural Rd', city: 'Nowhere', postal_code: '00000', county: 'Lee' } },
    }), { contactPhone: ANI, addressValidation: { status: 'out_of_service_area', inServiceArea: false, county: 'Lee County' } });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('out_of_service_area');
    expect(r.appointmentBlockingFlags).not.toContain('caller_not_authorized');
  });

  test('direction independence: canAutoRoute takes no direction input — an outbound call with the identical extraction reaches the same decision', () => {
    // canAutoRoute/computeDeterministicTriageFlags never read call direction;
    // the opts shape below is exactly what an OUTBOUND call site passes
    // (agentCommitFailOpen is disabled for outbound elsewhere, but this
    // ruling does not depend on that opt at all).
    const outboundOpts = { contactPhone: ANI, addressValidation: AV_CLEAN, agentCommitFailOpen: false, failOpen: false };
    const inboundOpts = { contactPhone: ANI, addressValidation: AV_CLEAN, agentCommitFailOpen: true, failOpen: true };
    const rOutbound = canAutoRoute(wdoExtraction(), outboundOpts);
    const rInbound = canAutoRoute(wdoExtraction(), inboundOpts);
    expect(rOutbound.allowed).toBe(true);
    expect(rInbound.allowed).toBe(true);
  });
});
