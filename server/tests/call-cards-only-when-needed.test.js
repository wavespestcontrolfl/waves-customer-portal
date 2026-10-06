// Cards nobody needs (2026-10-05 call-agent audit) and spelled-email trust
// (owner ruling 2026-10-05). Pure helpers in call-triage-flags.js; the call
// processor trims only the Needs Review cards with them — the routing
// verdict keeps every flag.
const {
  dropUnneededCallCards,
  callMakesNoServiceAsk,
  spelledEmailSettled,
} = require('../services/call-triage-flags');

function ext({ status = 'none', intent = null, quoteRequested = false, quotePromised = false, relationship = 'owner', service = {} } = {}) {
  return {
    scheduling: { status },
    caller: { relationship_to_property: relationship },
    service_request: { service_intent: intent, quote_requested: quoteRequested, quote_promised: quotePromised, ...service },
  };
}

describe('dropUnneededCallCards', () => {
  test('a cancellation files one card, not three', () => {
    const r = dropUnneededCallCards(
      ['cancellation_request', 'reschedule_or_cancel', 'existing_appointment_coordination'],
      ext({ status: 'canceled', intent: 'cancellation_request' }),
    );
    expect(r.flags).toEqual(['cancellation_request']);
    expect(r.dropped.sort()).toEqual(['existing_appointment_coordination', 'reschedule_or_cancel']);
  });

  test('a reschedule keeps reschedule_or_cancel and drops the coordination duplicate', () => {
    const r = dropUnneededCallCards(['reschedule_or_cancel', 'existing_appointment_coordination'], ext({ status: 'reschedule_requested' }));
    expect(r.flags).toEqual(['reschedule_or_cancel']);
  });

  test('coordination with no change asked files no card', () => {
    const r = dropUnneededCallCards(['existing_appointment_coordination'], ext({ status: 'none', intent: 'follow_up_existing_service' }));
    expect(r.flags).toEqual([]);
  });

  test('coordination with a time still asked keeps its card', () => {
    const r = dropUnneededCallCards(['existing_appointment_coordination'], ext({ status: 'requested' }));
    expect(r.flags).toEqual(['existing_appointment_coordination']);
  });

  test('address cards drop on a status call that asks for no visit or quote', () => {
    const r = dropUnneededCallCards(
      ['address_unverifiable', 'missing_service_address', 'address_unverified', 'low_confidence_address'],
      ext({ status: 'none', intent: 'follow_up_existing_service' }),
    );
    expect(r.flags).toEqual([]);
  });

  test('address cards stay on a new-service ask, a quote, or any time asked', () => {
    const flags = ['address_unverifiable', 'missing_service_address'];
    expect(dropUnneededCallCards(flags, ext({ status: 'none', intent: 'active_infestation_treatment' })).flags).toEqual(flags);
    expect(dropUnneededCallCards(flags, ext({ status: 'none', intent: 'follow_up_existing_service', quoteRequested: true })).flags).toEqual(flags);
    expect(dropUnneededCallCards(flags, ext({ status: 'none', intent: null, quotePromised: true })).flags).toEqual(flags);
    expect(dropUnneededCallCards(flags, ext({ status: 'requested', intent: 'follow_up_existing_service' })).flags).toEqual(flags);
    expect(dropUnneededCallCards(flags, ext({ status: 'offered', intent: null })).flags).toEqual(flags);
  });

  test('out_of_service_area is never dropped', () => {
    const r = dropUnneededCallCards(['out_of_service_area', 'missing_service_address'], ext({ status: 'none', intent: null }));
    expect(r.flags).toEqual(['out_of_service_area']);
  });

  test('family members and client employees need no authorization card when no time was asked', () => {
    expect(dropUnneededCallCards(['caller_not_authorized'], ext({ relationship: 'family_member', status: 'none' })).flags).toEqual([]);
    expect(dropUnneededCallCards(['caller_not_authorized'], ext({ relationship: 'employee', status: 'canceled' })).flags).toEqual([]);
  });

  test('an authorization card stays whenever a time was asked, offered or confirmed', () => {
    for (const status of ['requested', 'offered', 'confirmed', 'ambiguous']) {
      expect(dropUnneededCallCards(['caller_not_authorized'], ext({ relationship: 'family_member', status })).flags).toEqual(['caller_not_authorized']);
    }
  });

  test('a realtor arranging a WDO inspection with no time asked needs no card; a realtor asking for treatment keeps it', () => {
    const wdo = ext({ relationship: 'real_estate_agent', status: 'none', intent: 'inspection_only', service: { primary_service_category: 'wdo', specific_service_name: 'WDO Inspection' } });
    expect(dropUnneededCallCards(['caller_not_authorized'], wdo).flags).toEqual([]);
    const treat = ext({ relationship: 'real_estate_agent', status: 'none', service: { primary_service_category: 'pest_general', specific_service_name: 'General Pest Control' } });
    expect(dropUnneededCallCards(['caller_not_authorized'], treat).flags).toEqual(['caller_not_authorized']);
  });

  test('tenants and property managers keep the authorization card', () => {
    expect(dropUnneededCallCards(['caller_not_authorized'], ext({ relationship: 'tenant' })).flags).toEqual(['caller_not_authorized']);
    expect(dropUnneededCallCards(['caller_not_authorized'], ext({ relationship: 'property_manager' })).flags).toEqual(['caller_not_authorized']);
  });

  test('missing_last_name is never dropped here (the resolver closes it on the resolved customer)', () => {
    expect(dropUnneededCallCards(['missing_last_name'], ext()).flags).toEqual(['missing_last_name']);
  });

  test('blocking flags it does not know about pass through', () => {
    const r = dropUnneededCallCards(['commercial_requires_quote', 'do_not_contact_requested', 'spam_or_wrong_number'], ext({ status: 'none' }));
    expect(r.flags).toEqual(['commercial_requires_quote', 'do_not_contact_requested', 'spam_or_wrong_number']);
  });

  test('tolerates a missing extraction', () => {
    expect(dropUnneededCallCards(['missing_service_address'], null).flags).toEqual([]);
    expect(dropUnneededCallCards(null, null)).toEqual({ flags: [], dropped: [] });
  });
});

describe('callMakesNoServiceAsk', () => {
  test('canceled and none with an existing-service intent make no ask', () => {
    expect(callMakesNoServiceAsk(ext({ status: 'canceled', intent: 'cancellation_request' }))).toBe(true);
    expect(callMakesNoServiceAsk(ext({ status: 'none', intent: 'complaint_or_callback' }))).toBe(true);
  });
  test('ambiguous scheduling is an ask', () => {
    expect(callMakesNoServiceAsk(ext({ status: 'ambiguous', intent: null }))).toBe(false);
  });
});

describe('spelledEmailSettled', () => {
  const one = (value, extra = {}) => ({ email_candidates: [{ value, confidence: 0.8 }], ...extra });

  test('one spelling heard that matches the saved email settles it', () => {
    expect(spelledEmailSettled(one('quentrell.w@example.com'), 'Quentrell.W@example.com')).toBe(true);
  });

  test('a decisive adopt with one spelling settles it; adopt_with_confirmation keeps the card', () => {
    expect(spelledEmailSettled(one('q@example.com', { arbiter: { verdict: 'adopt' } }), 'q@example.com')).toBe(true);
    expect(spelledEmailSettled(one('q@example.com', { arbiter: { verdict: 'adopt_with_confirmation' } }), 'q@example.com')).toBe(false);
  });

  test('two spellings, a disagreement, or a review/reject verdict keep the card', () => {
    expect(spelledEmailSettled({ email_candidates: [{ value: 'a@example.com' }, { value: 'aa@example.com' }] }, 'a@example.com')).toBe(false);
    expect(spelledEmailSettled(one('a@example.com', { email_disagreement: true }), 'a@example.com')).toBe(false);
    expect(spelledEmailSettled(one('a@example.com', { arbiter: { verdict: 'review' } }), 'a@example.com')).toBe(false);
    expect(spelledEmailSettled(one('a@example.com', { arbiter: { verdict: 'reject' } }), 'a@example.com')).toBe(false);
  });

  test('a spelling that differs from the saved email keeps the card', () => {
    expect(spelledEmailSettled(one('a@example.com'), 'b@example.com')).toBe(false);
  });

  test('a domain correction that changes the value keeps the card', () => {
    expect(spelledEmailSettled(one('a@example.com'), 'a@example.com', 'a@example.org')).toBe(false);
    expect(spelledEmailSettled(one('a@example.com'), 'a@example.com', 'a@example.com')).toBe(true);
  });

  test('no decoder payload, no saved email, or a malformed value keeps the card', () => {
    expect(spelledEmailSettled(null, 'a@example.com')).toBe(false);
    expect(spelledEmailSettled(one('a@example.com'), '')).toBe(false);
    expect(spelledEmailSettled(one('not-an-email'), 'not-an-email')).toBe(false);
  });
});
