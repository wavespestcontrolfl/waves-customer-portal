/**
 * Automatic booking-link text after a call (services/call-booking-link-text.js).
 *
 * Pins: the 2-hour / 8am-ET-next-morning delay rule, every stage-time "never"
 * condition (and the happy path), gate-off being a true no-op, and the
 * send-time re-checks (booked since, an estimate linked, a link sent in the
 * last 14 days, the lead no longer open, outside the send window) plus a
 * successful dispatch. The sender and the link builder are mocked; no real
 * text is ever sent by this suite.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/lead-consultation-link', () => ({
  buildLeadConsultationSmsLine: jest.fn(async () => ({ url: 'https://wavespest.co/l/abcd', line: 'Pick a time...\n\n' })),
  isUsPhone: jest.fn((phone) => /^\+?1?\d{10}$/.test(String(phone || '').replace(/[^0-9+]/g, ''))),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM_test_sid', deliveryOutcome: 'accepted' })),
}));
jest.mock('../services/sms-auto-send', () => ({
  isRealProviderSend: jest.fn((r) => !!r?.sent && !!r?.providerMessageId),
  isAmbiguousProviderOutcome: jest.fn(() => false),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { buildLeadConsultationSmsLine } = require('../services/lead-consultation-link');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { isAmbiguousProviderOutcome } = require('../services/sms-auto-send');
const {
  computeSendAt,
  callEndFor,
  conversationSeconds,
  managedLineForCall,
  stagingIneligibleReason,
  outboundPriorContactMissing,
  outboundStagingReason,
  resolveLeadId,
  resolveLeadLinkage,
  activationBoundary,
  persistedActivationBoundary,
  refreshLiveActivationBoundary,
  ACTIVATION_SETTINGS_KEY,
  LAST_LIVE_SETTINGS_KEY,
  HEARTBEAT_GAP_MS,
  MODULE_LOAD_AT,
  neverSendRecheck,
  consentedDestination,
  dispatchClaimedCall,
  claimForDispatch,
  recoverAbandonedClaim,
  recoverStaleClaims,
  stage,
  stageOne,
  sweep,
  STAGING_GRACE_MINUTES,
} = require('../services/call-booking-link-text');

// ── computeSendAt — 2h delay, 6pm ET cutoff → 8am ET next morning ─────────
describe('computeSendAt', () => {
  test.each([
    ['2:00 PM ET → 4:00 PM ET', new Date('2026-09-26T18:00:00Z'), new Date('2026-09-26T20:00:00Z')], // 14:00 EDT
    ['5:59 PM ET → 7:59 PM ET (just inside the window)', new Date('2026-09-26T21:59:00Z'), new Date('2026-09-26T23:59:00Z')],
    ['exactly 6:00 PM ET → 8:00 AM ET next day', new Date('2026-09-26T22:00:00Z'), new Date('2026-09-27T12:00:00Z')],
    ['9:30 PM ET → 8:00 AM ET next day', new Date('2026-09-27T01:30:00Z'), new Date('2026-09-27T12:00:00Z')],
  ])('%s', (_label, callEnd, expected) => {
    expect(computeSendAt(callEnd).toISOString()).toBe(expected.toISOString());
  });

  test('never lands at or after 8 PM ET for a call ending before the 6 PM cutoff', () => {
    for (const hour of [8, 12, 15, 17]) {
      const callEnd = new Date(`2026-09-26T${String(hour + 4).padStart(2, '0')}:00:00Z`); // ET = UTC-4
      const sendAt = computeSendAt(callEnd);
      const etHour = new Date(sendAt.getTime() - 4 * 3600000).getUTCHours();
      expect(etHour).toBeLessThan(20);
    }
  });
});

// ── callEndFor — this lane's own call-end derivation ──────────────────────
// Deliberately does NOT use call-commitments.js's callEndedAt: that adds
// duration on top of created_at for every inbound row (wrong for a
// post-call/recovered row, whose created_at is already stamped after the
// call ended) and returns the bare created_at for a plain outbound row
// with no bridged_at (too early — no duration added at all). callEndFor
// uses callStartedAt(call) + callDurationSeconds(call) uniformly instead,
// since callStartedAt already backs a post-call row's own length out of
// created_at.
describe('callEndFor', () => {
  test('a ring-time inbound row: end is start + duration', () => {
    const call = { direction: 'inbound', created_at: new Date('2026-09-26T19:00:00Z'), duration_seconds: 300 }; // not flagged post-call
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T19:05:00Z').getTime());
  });

  // codex round-9 finding: a post-call recovered row (status_callback on a
  // TERMINAL event, or a recording-status recovery insert) stamps
  // created_at AFTER the call ends. A real call ending at 5:55 PM ET
  // (21:55Z) with a 5-minute duration must compute an end of 5:55 PM, not
  // 6:05 PM — callStartedAt backs the duration out of created_at (reaching
  // 5:50 PM), and callEndFor adds it back to reach the TRUE end (5:55 PM),
  // never created_at's own inflated reading.
  test('a post-call recovered row: end is the TRUE end, not created_at + duration', () => {
    const call = {
      direction: 'inbound', created_at: new Date('2026-09-26T21:55:00Z'), duration_seconds: 300, // 5:55 PM ET, 5 min
      metadata: { source: 'status_callback', inserted_on_status: 'completed' }, // terminal ⇒ post-call row
    };
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T21:55:00Z').getTime()); // 5:55 PM ET — NOT 6:05 PM
  });

  test('a plain outbound row (no bridged_at): end includes the duration, never just the start', () => {
    const call = { direction: 'outbound', created_at: new Date('2026-09-26T19:00:00Z'), duration_seconds: 180 };
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T19:03:00Z').getTime());
  });

  // codex r3 P2: a signed customer-leg receipt (/outbound-dial-complete)
  // is the EXACT end for a callback attempt — it wins over bridged_at and
  // duration_seconds entirely, and even over a wildly different
  // duration_seconds on the same row (a stale/inflated parent-leg field
  // must never override the provider's own definitive receipt).
  test('a customer_leg receipt is the exact end, regardless of bridged_at/duration_seconds', () => {
    const call = {
      direction: 'outbound', bridged_at: new Date('2026-09-26T19:00:00Z'), duration_seconds: 600,
      metadata: { customer_leg: { status: 'completed', sid: 'CA1', duration_seconds: 30, ended_at: '2026-09-26T19:01:15.000Z' } },
    };
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T19:01:15.000Z').getTime());
  });

  test('an inbound row with a customer_leg key (never stamped for inbound) ignores it and falls through to the ordinary branch', () => {
    const call = {
      direction: 'inbound', created_at: new Date('2026-09-26T19:00:00Z'), duration_seconds: 300,
      metadata: { customer_leg: { ended_at: '2026-09-26T20:00:00.000Z' } },
    };
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T19:05:00Z').getTime());
  });

  test('an unparseable customer_leg.ended_at falls through to the bridged fallback instead of NaN', () => {
    const call = {
      direction: 'outbound', bridged_at: new Date('2026-09-26T19:00:00Z'), duration_seconds: 240,
      metadata: { customer_leg: { ended_at: 'not-a-date' } },
    };
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T19:04:00Z').getTime());
  });

  // codex r3 P2: the recording-duration branch (codex r2 P2) ran EARLY —
  // Twilio's recorded duration measures only the customer's talk time and
  // misses hold/silence — dropped entirely. bridged_at + duration_seconds
  // is kept as the fallback for a bridged row with no customer_leg receipt
  // yet: duration_seconds is the PARENT (admin) leg's length, starting at
  // the admin's OWN answer — earlier than bridged_at (dial start) — so
  // this can only run LATE (the press-1 prompt + the customer's own ring
  // time), never early, which is the deliberately safe direction for this
  // lane's 2-hour/6pm-ET rule.
  test('a bridged row with no customer_leg receipt: end is bridged_at + duration_seconds, regardless of created_at', () => {
    const call = {
      direction: 'outbound', created_at: new Date('2026-09-26T18:50:00Z'), // dialing started here
      bridged_at: new Date('2026-09-26T19:00:00Z'), duration_seconds: 240, // the answer, 10 min later
    };
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T19:04:00Z').getTime());
  });

  test('a bridged row with a recording_duration_seconds present is UNAFFECTED by it — duration_seconds alone decides', () => {
    const call = {
      direction: 'outbound', created_at: new Date('2026-09-26T18:50:00Z'),
      bridged_at: new Date('2026-09-26T19:00:00Z'), duration_seconds: 600, recording_duration_seconds: 90,
    };
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T19:10:00Z').getTime());
  });

  test('a bridged row with a zero/missing duration_seconds falls back to bridged_at itself, never NaN', () => {
    const call = {
      direction: 'outbound', created_at: new Date('2026-09-26T18:50:00Z'),
      bridged_at: new Date('2026-09-26T19:00:00Z'), duration_seconds: 0,
    };
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T19:00:00Z').getTime());
  });

  test('a missing duration falls back to the call start, never NaN or a throw', () => {
    const call = { direction: 'inbound', created_at: new Date('2026-09-26T19:00:00Z') }; // no duration_seconds at all
    expect(callEndFor(call).getTime()).toBe(new Date('2026-09-26T19:00:00Z').getTime());
  });

  test('no created_at at all returns null (the no_call_end_time skip)', () => {
    expect(callEndFor({ direction: 'inbound' })).toBeNull();
  });
});

// ── conversationSeconds — talk time for the call_too_short screen only ───
describe('conversationSeconds', () => {
  test('outbound: recording_duration_seconds is used directly, never maxed against the inflated duration_seconds', () => {
    // duration_seconds includes staff ringing + the press-1 prompt (10 min);
    // the recorded conversation itself was only 20s.
    const call = { direction: 'outbound', duration_seconds: 600, recording_duration_seconds: 20 };
    expect(conversationSeconds(call)).toBe(20);
  });

  test('outbound with no usable recording falls back to callDurationSeconds', () => {
    const call = { direction: 'outbound', duration_seconds: 45, recording_duration_seconds: 0 };
    expect(conversationSeconds(call)).toBe(45);
  });

  test('inbound stays on callDurationSeconds (its own "largest positive wins" rule), unaffected', () => {
    const call = { direction: 'inbound', duration_seconds: 20, recording_duration_seconds: 600 };
    expect(conversationSeconds(call)).toBe(600);
  });
});

// ── managedLineForCall — reply from the line the caller actually reached ──
describe('managedLineForCall', () => {
  const PARRISH = '+19412972817'; // a real registered location line
  const TECH_LINE = '+19413529161'; // a real registered field-tech line
  const TOLL_FREE = '+18559260203'; // the AI toll-free / customer-chat line
  const UNREGISTERED = '+19995551234';

  test('inbound: to_phone, when it is a real registered location line', () => {
    expect(managedLineForCall({ direction: 'inbound', to_phone: PARRISH })).toBe(PARRISH);
  });

  test('outbound: from_phone, when it is a real registered line', () => {
    expect(managedLineForCall({ direction: 'outbound', from_phone: PARRISH })).toBe(PARRISH);
  });

  test('a lead-webhook auto-bridge uses metadata.bridgeCallerId — never the internal alert leg from_phone/to_phone', () => {
    const call = { direction: 'outbound', from_phone: '+19415550100', to_phone: '+19415550200', metadata: { bridgeCallerId: PARRISH } };
    expect(managedLineForCall(call)).toBe(PARRISH);
  });

  test('a tech line is never used, even though it is a registered number', () => {
    expect(managedLineForCall({ direction: 'inbound', to_phone: TECH_LINE })).toBeNull();
  });

  test('the AI toll-free line is never used', () => {
    expect(managedLineForCall({ direction: 'inbound', to_phone: TOLL_FREE })).toBeNull();
  });

  test('a registered line ALSO configured as a staff-forward number is never used', () => {
    process.env.WAVES_FALLBACK_FORWARD_NUMBERS = PARRISH;
    try {
      expect(managedLineForCall({ direction: 'inbound', to_phone: PARRISH })).toBeNull();
    } finally {
      delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
    }
  });

  test('an unregistered number resolves to null — deriveOutboundNumber decides as today', () => {
    expect(managedLineForCall({ direction: 'inbound', to_phone: UNREGISTERED })).toBeNull();
  });

  test('no candidate at all resolves to null', () => {
    expect(managedLineForCall({ direction: 'inbound' })).toBeNull();
  });
});

// ── stagingIneligibleReason — every "never" rule + the happy path ────────
describe('stagingIneligibleReason', () => {
  const baseCall = { customer_id: null, duration_seconds: 90, ai_address_validation: { inServiceArea: true } };
  const baseExtraction = () => ({
    meta: { is_voicemail: false, is_spam: false },
    call_nature: 'new_lead',
    recommended_disposition: 'lead_response_flow_triggered',
    triage_flags: [],
    caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
    property: { property_type: 'single_family' },
    service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
    scheduling: { status: 'requested' },
    consent: { do_not_contact_request: false, sms_consent_given: true },
    sentiment_and_lead: { lead_quality: 'warm' },
  });
  const leadId = 'lead-1';

  test('eligible call returns null', () => {
    expect(stagingIneligibleReason(baseCall, baseExtraction(), leadId)).toBeNull();
  });

  test('no lead linkage', () => {
    expect(stagingIneligibleReason(baseCall, baseExtraction(), null)).toBe('no_lead_linkage');
  });

  test('a customer_id that predates this call is never eligible, whatever the call says', () => {
    expect(stagingIneligibleReason({ ...baseCall, customer_id: 'cust-1' }, baseExtraction(), leadId)).toBe('existing_customer');
    // Same customer_id, but this call's own metadata names a DIFFERENT
    // customer as its own creation — still a pre-existing customer.
    expect(stagingIneligibleReason(
      { ...baseCall, customer_id: 'cust-1', metadata: { lead_id: leadId, created_customer_id: 'cust-other' } },
      baseExtraction(), leadId,
    )).toBe('existing_customer');
  });

  // codex pre-push P1: the legacy call-created-customer path
  // (call-recording-processor.js) mints a customers row directly for a
  // first-time caller and stamps customer_id AND created_customer_id on
  // this SAME call in one transaction — that customer_id is not evidence
  // of a pre-existing relationship, and must not disqualify an otherwise
  // eligible new-lead call.
  test('a customer_id THIS call itself just created is not "an existing customer"', () => {
    const call = { ...baseCall, customer_id: 'cust-new', metadata: { lead_id: leadId, created_customer_id: 'cust-new' } };
    expect(stagingIneligibleReason(call, baseExtraction(), leadId)).toBeNull();
  });

  test('no extraction to judge', () => {
    expect(stagingIneligibleReason(baseCall, null, leadId)).toBe('no_extraction');
  });

  test.each([
    ['voicemail', { meta: { is_voicemail: true } }, 'voicemail_or_spam'],
    ['spam', { meta: { is_spam: true } }, 'voicemail_or_spam'],
    ['existing-customer call nature', { call_nature: 'existing_customer_service' }, 'not_new_lead_call'],
    ['vendor call nature', { call_nature: 'vendor_or_partner' }, 'not_new_lead_call'],
    ['a voicemail disposition', { recommended_disposition: 'voicemail_processed' }, 'not_a_conversation'],
    ['out of service area (triage flag)', { triage_flags: ['out_of_service_area'] }, 'triage_flag_out_of_service_area'],
    ['commercial requires quote (triage flag)', { triage_flags: ['commercial_requires_quote'] }, 'triage_flag_commercial_requires_quote'],
    ['do-not-contact (triage flag)', { triage_flags: ['do_not_contact_requested'] }, 'triage_flag_do_not_contact_requested'],
    ['a quote was already promised (triage flag)', { triage_flags: ['quote_promised'] }, 'triage_flag_quote_promised'],
    ['a quote was promised (field only, no flag)', { service_request: { service_intent: 'active_infestation_treatment', quote_promised: true } }, 'quote_promised'],
    ['callback number needed (triage flag)', { triage_flags: ['callback_number_needed'] }, 'triage_flag_callback_number_needed'],
    ['the caller said the number is not theirs', { caller: { caller_id_disclaimed: true } }, 'caller_id_disclaimed'],
    ['the number is disclaimed even with a spoken callback', { caller: { caller_id_disclaimed: true, phone_e164: '+19415550199', phone_source: 'spoken' } }, 'caller_id_disclaimed'],
    ['a property manager calling', { caller: { relationship_to_property: 'property_manager' } }, 'third_party_caller'],
    ['a realtor calling', { caller: { relationship_to_property: 'real_estate_agent' } }, 'third_party_caller'],
    ['a lender calling', { caller: { relationship_to_property: 'lender' } }, 'third_party_caller'],
    ['a commercial property', { property: { property_type: 'commercial' } }, 'not_residential'],
    ['an HOA common area', { property: { property_type: 'hoa_common_area' } }, 'not_residential'],
    ['a priced one-time job (preventative)', { service_request: { service_intent: 'preventative_one_time' } }, 'service_intent_not_onsite'],
    ['a phone-only price ask', { service_request: { service_intent: 'quote_only' } }, 'service_intent_not_onsite'],
    ['an existing-service follow-up', { service_request: { service_intent: 'follow_up_existing_service' } }, 'service_intent_not_onsite'],
    ['a price was quoted on the call', { service_request: { service_intent: 'active_infestation_treatment', quoted_price_usd: 199 } }, 'priced_on_call'],
    ['caller said no appointment needed', { service_request: { service_intent: 'active_infestation_treatment', urgency: 'no_appointment_needed' } }, 'no_appointment_needed'],
    ['already booked on the call', { scheduling: { status: 'confirmed' } }, 'already_booked_on_call'],
    ['disposition already booked', { recommended_disposition: 'booked' }, 'disposition_booked'],
    ['disposition no action needed', { recommended_disposition: 'no_action_needed' }, 'disposition_no_action_needed'],
    ['explicit do-not-contact', { consent: { do_not_contact_request: true } }, 'do_not_contact'],
    ['explicit SMS consent refusal', { consent: { sms_consent_given: false } }, 'sms_consent_refused'],
    ['caller prefers a phone call', { caller: { preferred_contact_method: 'phone' } }, 'prefers_phone_contact'],
    ['wrong-number lead quality', { sentiment_and_lead: { lead_quality: 'wrong_number' } }, 'lead_quality_wrong_number'],
    ['spam/solicitation lead quality', { sentiment_and_lead: { lead_quality: 'spam_or_solicitation' } }, 'lead_quality_spam_or_solicitation'],
  ])('%s → %s', (_label, patch, expected) => {
    const extraction = { ...baseExtraction(), ...patch };
    // Deep-merge the one level these patches touch so unrelated fields keep
    // their eligible default. Array-valued fields (triage_flags) replace
    // outright — spreading an array into an object would silently turn it
    // into a plain object with numeric keys.
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      const isPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value);
      extraction[key] = isPlainObject ? { ...baseExtraction()[key], ...value } : value;
    }
    expect(stagingIneligibleReason(baseCall, extraction, leadId)).toBe(expected);
  });

  test('a call too short to be a real conversation is skipped', () => {
    expect(stagingIneligibleReason({ ...baseCall, duration_seconds: 5 }, baseExtraction(), leadId)).toBe('call_too_short');
  });

  test('a recovered row with only recording_duration_seconds is judged on that duration', () => {
    const recovered = { ...baseCall, duration_seconds: null, recording_duration_seconds: 300 };
    expect(stagingIneligibleReason(recovered, baseExtraction(), leadId)).not.toBe('call_too_short');
    expect(stagingIneligibleReason({ ...recovered, recording_duration_seconds: 5 }, baseExtraction(), leadId)).toBe('call_too_short');
  });

  // codex r1 P1: an outbound bridge's duration_seconds includes staff
  // ringing and the press-1 prompt — a real conversation this short must
  // still be caught, which the OLD callDurationSeconds check (max of both
  // fields) would have missed entirely.
  test('an outbound bridge with a long ring but a genuinely short conversation is still call_too_short', () => {
    const outboundBridge = { ...baseCall, direction: 'outbound', duration_seconds: 600, recording_duration_seconds: 20 };
    expect(stagingIneligibleReason(outboundBridge, baseExtraction(), leadId)).toBe('call_too_short');
  });

  test('an address that never validated in-area is skipped', () => {
    expect(stagingIneligibleReason({ ...baseCall, ai_address_validation: { inServiceArea: false } }, baseExtraction(), leadId)).toBe('not_in_service_area');
    expect(stagingIneligibleReason({ ...baseCall, ai_address_validation: null }, baseExtraction(), leadId)).toBe('not_in_service_area');
  });

  test('an unrecognized property type is never assumed residential', () => {
    const extraction = { ...baseExtraction(), property: { property_type: 'unknown' } };
    expect(stagingIneligibleReason(baseCall, extraction, leadId)).toBe('not_residential');
  });
});

// ── Gate off is a true no-op ──────────────────────────────────────────────
test('gate off: sweep never touches the database', async () => {
  isEnabled.mockReturnValue(false);
  const result = await sweep(db, { now: new Date() });
  expect(result).toEqual({ staged: 0, ineligible: 0, sent: 0, dispatchSkipped: 0 });
  expect(db).not.toHaveBeenCalled();
  isEnabled.mockReturnValue(true);
});

// ── activationBoundary / persistedActivationBoundary ──────────────────────
// Mirrors reschedule-link-promises.js's own activationBoundary pattern:
// flipping the gate on must never pick up days of pre-existing valid-but-
// unstaged calls and text them all in one burst (codex r1 P1).
describe('activationBoundary / persistedActivationBoundary', () => {
  afterEach(() => { delete process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT; });

  test('an explicit env override always wins, with no DB read at all', async () => {
    process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT = '2026-01-01T00:00:00.000Z';
    const conn = jest.fn();
    const boundary = await activationBoundary(conn);
    expect(boundary.getTime()).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
    expect(conn).not.toHaveBeenCalled();
  });

  test('an unparseable env override falls back to the persisted boundary instead of throwing', async () => {
    process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT = 'not-a-date';
    const chain = { where: jest.fn(() => chain), first: jest.fn(async () => ({ value: '2026-02-01T00:00:00.000Z' })) };
    const conn = jest.fn(() => chain);
    const boundary = await activationBoundary(conn);
    expect(boundary.getTime()).toBe(new Date('2026-02-01T00:00:00.000Z').getTime());
  });

  test('reads an already-persisted boundary without ever writing', async () => {
    const insert = jest.fn();
    const chain = { where: jest.fn(() => chain), first: jest.fn(async () => ({ value: '2026-02-01T00:00:00.000Z' })), insert };
    const conn = jest.fn(() => chain);
    const boundary = await persistedActivationBoundary(conn);
    expect(boundary.getTime()).toBe(new Date('2026-02-01T00:00:00.000Z').getTime());
    expect(insert).not.toHaveBeenCalled();
  });

  // codex r2 P2: the boundary is fixed at THIS process's own module-load
  // time (MODULE_LOAD_AT — captured once, at require, which happens at
  // process boot since GATE_CALL_BOOKING_LINK_TEXT can only ever be live
  // in a process that booted with it already set), never at whatever
  // moment the first cron tick happens to run 5 minutes later. conn.raw
  // is no longer called at all for this write.
  test('the first process anywhere to find nothing stored writes its OWN module-load time (onConflict-ignore), then reads it back', async () => {
    let stored = null;
    const chain = {
      where: jest.fn(() => chain),
      first: jest.fn(async () => (stored ? { value: stored } : undefined)),
      insert: jest.fn((row) => { stored = row.value; return { onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) }; }),
    };
    const conn = jest.fn(() => chain);
    conn.raw = jest.fn();
    const boundary = await persistedActivationBoundary(conn);
    expect(boundary.getTime()).toBe(MODULE_LOAD_AT.getTime());
    expect(stored).toBe(MODULE_LOAD_AT.toISOString());
    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ key: 'call_booking_link_text_activated_at' }));
    expect(conn.raw).not.toHaveBeenCalled();
  });
});

// ── stage — a grace period before ever judging a fresh call ──────────────
describe('stage', () => {
  function spyingConn() {
    const wheres = [];
    const whereNulls = [];
    const conn = jest.fn(() => {
      const chain = {};
      ['where', 'orderBy', 'limit', 'select', 'whereRaw'].forEach((m) => {
        chain[m] = jest.fn((...args) => { if (m === 'where') wheres.push(args); return chain; });
      });
      chain.whereNull = jest.fn((col) => { whereNulls.push(col); return chain; });
      // activationBoundary's own system_settings read — pinned to the
      // epoch so every test call is well after it and the pre_activation
      // check never trips for these call_log-query-shape assertions.
      chain.first = jest.fn(async () => ({ value: '1970-01-01T00:00:00.000Z' }));
      chain.then = (resolve) => resolve([]);
      return chain;
    });
    return { conn, wheres, whereNulls };
  }

  test('excludes a call still being processed', async () => {
    const { conn, whereNulls } = spyingConn();
    await stage(conn, { now: new Date('2026-09-26T18:00:00Z') });
    expect(whereNulls).toContain('processing_token');
  });

  test('the grace period anchors on updated_at, not created_at (codex pre-push P1: created_at is fixed at ring time and can already be stale for a long call)', async () => {
    const { conn, wheres } = spyingConn();
    const now = new Date('2026-09-26T18:00:00Z');
    await stage(conn, { now });
    const graceWhere = wheres.find(([col, op]) => col === 'updated_at' && op === '<=');
    expect(graceWhere).toBeTruthy();
    expect(now.getTime() - graceWhere[2].getTime()).toBe(STAGING_GRACE_MINUTES * 60 * 1000);
    expect(wheres.some(([col, op]) => col === 'created_at' && op === '<=')).toBe(false);
  });

  // codex pre-push P1: a bogus/huge duration_seconds can make callEndFor()
  // read as decades in the future for any row. Unclamped, computeSendAt on
  // that future end could push send_at arbitrarily late; clamping to `now`
  // bounds the delay instead.
  test('a row whose computed end is in the future (a bogus duration) computes send_at from `now`, not that future reading', async () => {
    const now = new Date('2026-09-26T15:00:00Z'); // 11:00 ET — inside the window, well before the 6pm cutoff
    const rawBindings = [];
    const conn = jest.fn(() => {
      const chain = {};
      ['where', 'whereRaw'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-recovered', direction: 'inbound', created_at: new Date(now.getTime() - 60000), duration_seconds: 999999999,
      metadata: { lead_id: 'lead-1' },
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now);
    expect(decided).toBe('pending');
    const parsed = rawBindings.map(([json]) => JSON.parse(json)).find((v) => v.call_booking_link_text?.status === 'pending');
    expect(parsed).toBeTruthy();
    const sendAt = new Date(parsed.call_booking_link_text.send_at);
    expect(sendAt.getTime()).toBe(computeSendAt(now).getTime());
  });

  // codex round-9 finding, closed structurally by callEndFor: a post-call
  // recovered row whose real end is 5:55 PM ET must send at 7:55 PM ET the
  // SAME evening — never deferred to 8 AM the next morning, which is what
  // callEndedAt's created_at + duration (reading 6:05 PM) would have done.
  test('a recovered row ending at 5:55 PM ET sends at 7:55 PM ET the same evening, never 8 AM the next morning', async () => {
    const now = new Date('2026-09-26T22:10:00Z'); // 6:10 PM ET — staging runs shortly after the recovered row lands
    const rawBindings = [];
    const conn = jest.fn(() => {
      const chain = {};
      ['where', 'whereRaw'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-555pm', direction: 'inbound', created_at: new Date('2026-09-26T21:55:00Z'), duration_seconds: 300, // 5:55 PM ET, 5 min
      metadata: { lead_id: 'lead-1', source: 'status_callback', inserted_on_status: 'completed' }, // post-call row
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now);
    expect(decided).toBe('pending');
    const parsed = rawBindings.map(([json]) => JSON.parse(json)).find((v) => v.call_booking_link_text?.status === 'pending');
    const sendAt = new Date(parsed.call_booking_link_text.send_at);
    expect(sendAt.getTime()).toBe(new Date('2026-09-26T23:55:00Z').getTime()); // 7:55 PM ET, same evening
  });

  // codex pre-push P1: a fresh lead the call pipeline just minted carries
  // NO metadata.lead_id stamp at all — only its own twilio_call_sid links
  // it. Staging must still resolve and stage it, not permanently record
  // no_lead_linkage.
  test('a fresh lead with no metadata stamp, linked only by twilio_call_sid, is staged', async () => {
    const now = new Date('2026-09-26T15:00:00Z');
    const rawBindings = [];
    const conn = jest.fn((table) => {
      if (table === 'leads') return leadsSidChain([{ id: 'lead-fresh' }]);
      const chain = {};
      ['where', 'whereRaw'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-fresh-lead', direction: 'inbound', created_at: new Date(now.getTime() - 60000), duration_seconds: 90,
      metadata: {}, twilio_call_sid: 'CAxxx', // no lead_id stamp — SID-only linkage
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now);
    expect(decided).toBe('pending');
    const parsed = rawBindings.map(([json]) => JSON.parse(json)).find((v) => v.call_booking_link_text?.status === 'pending');
    expect(parsed.call_booking_link_text.lead_id).toBe('lead-fresh');
  });

  // codex r1 P1: flipping the gate on must never pick up a call that
  // started before the lane's own first live activation.
  test('a call that started before the activation boundary is skipped as pre_activation, never judged further', async () => {
    const boundary = new Date('2026-09-26T12:00:00Z');
    const now = new Date('2026-09-26T13:00:00Z');
    const rawBindings = [];
    const conn = jest.fn(() => {
      const chain = {};
      ['where', 'whereRaw'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = { id: 'call-old', direction: 'inbound', created_at: new Date('2026-09-26T11:00:00Z'), duration_seconds: 90, metadata: {} };
    const decided = await stageOne(conn, call, now, boundary);
    expect(decided).toBe('skipped');
    const parsed = rawBindings.map(([json]) => JSON.parse(json)).find((v) => v.call_booking_link_text);
    expect(parsed.call_booking_link_text.reason).toBe('pre_activation');
    expect(conn).not.toHaveBeenCalledWith('leads'); // never even resolves lead linkage
  });

  test('a call that started at/after the boundary proceeds to ordinary eligibility, unaffected', async () => {
    const boundary = new Date('2020-01-01T00:00:00Z'); // long past — never blocks a real call
    const now = new Date('2026-09-26T15:00:00Z');
    const rawBindings = [];
    const conn = jest.fn((table) => {
      if (table === 'leads') return leadsSidChain([{ id: 'lead-fresh' }]);
      const chain = {};
      ['where', 'whereRaw'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-fresh-2', direction: 'inbound', created_at: new Date(now.getTime() - 60000), duration_seconds: 90,
      metadata: {}, twilio_call_sid: 'CAyyy',
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now, boundary);
    expect(decided).toBe('pending');
  });

  // codex r2 P2: the boundary is fixed at process boot (MODULE_LOAD_AT),
  // not at the first cron tick 5 minutes later — a call that started in
  // that gap must be staged normally, never pre_activation.
  test('a call starting between gate-live (module load) and the first cron tick is NOT pre_activation', async () => {
    let storedBoundary = null;
    const now = new Date(MODULE_LOAD_AT.getTime() + 4 * 60 * 1000); // 4 min after boot — before the first 5-min tick
    const conn = jest.fn((table) => {
      if (table === 'system_settings') {
        const chain = {
          where: jest.fn(() => chain),
          first: jest.fn(async () => (storedBoundary ? { value: storedBoundary } : undefined)),
          insert: jest.fn((row) => { storedBoundary = row.value; return { onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) }; }),
        };
        return chain;
      }
      const chain = {};
      ['where', 'whereRaw'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn();
    // This IS the first-ever establishment — exactly what a real first
    // cron tick would do too, just via the same MODULE_LOAD_AT anchor.
    const boundary = await activationBoundary(conn);
    expect(boundary.getTime()).toBe(MODULE_LOAD_AT.getTime());

    const call = {
      id: 'call-boot-gap', direction: 'inbound', created_at: new Date(MODULE_LOAD_AT.getTime() + 60 * 1000), duration_seconds: 90,
      metadata: { lead_id: 'lead-1' }, // isolates the boundary check from lead-linkage resolution
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now, boundary);
    expect(decided).toBe('pending'); // NOT skipped as pre_activation
  });
});

// ── refreshLiveActivationBoundary — self-heals the boundary after a
// disabled interval (codex r3 P1) ─────────────────────────────────────────
// Two independent system_settings rows: ACTIVATION_SETTINGS_KEY (the
// boundary itself) and LAST_LIVE_SETTINGS_KEY (a heartbeat every LIVE sweep
// writes). A gap since the last heartbeat past HEARTBEAT_GAP_MS means the
// gate was off (or the worker was down) since then, and the boundary
// advances to max(stored boundary, MODULE_LOAD_AT) — never regresses it.
describe('refreshLiveActivationBoundary', () => {
  function systemSettingsMock(initial = {}) {
    const store = { ...initial };
    const conn = jest.fn((table) => {
      if (table !== 'system_settings') throw new Error(`unexpected table ${table}`);
      let pendingKey;
      const chain = {
        where: jest.fn(({ key }) => { pendingKey = key; return chain; }),
        first: jest.fn(async () => (store[pendingKey] !== undefined ? { value: store[pendingKey] } : undefined)),
        insert: jest.fn((row) => ({
          onConflict: jest.fn(() => ({
            merge: jest.fn(async () => { store[row.key] = row.value; }),
            ignore: jest.fn(async () => { if (store[row.key] === undefined) store[row.key] = row.value; }),
          })),
        })),
      };
      return chain;
    });
    return { conn, store };
  }

  afterEach(() => { delete process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT; });

  test('an explicit env override skips this entirely — no read, no write, at any gap', async () => {
    process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT = '2026-01-01T00:00:00.000Z';
    const { conn } = systemSettingsMock();
    await refreshLiveActivationBoundary(conn, new Date());
    expect(conn).not.toHaveBeenCalled();
  });

  test('no heartbeat at all (first live sweep after a fresh boot) advances the boundary to MODULE_LOAD_AT and writes a fresh heartbeat', async () => {
    const { conn, store } = systemSettingsMock({ [ACTIVATION_SETTINGS_KEY]: '2020-01-01T00:00:00.000Z' });
    const now = new Date(MODULE_LOAD_AT.getTime() + 60 * 1000);
    await refreshLiveActivationBoundary(conn, now);
    expect(new Date(store[ACTIVATION_SETTINGS_KEY]).getTime()).toBe(MODULE_LOAD_AT.getTime());
    expect(new Date(store[LAST_LIVE_SETTINGS_KEY]).getTime()).toBe(now.getTime());
  });

  // "on -> off (gap) -> on: off-period calls excluded" — a heartbeat older
  // than the threshold is exactly what a gate cycled off (or a dead worker)
  // for longer than 2 cron ticks leaves behind; a call landing during that
  // gap must be pre_activation once the boundary catches up.
  test('a stale heartbeat (past 2x the cron cadence) advances the boundary, so a call from the gap is pre_activation', async () => {
    const now = new Date(MODULE_LOAD_AT.getTime() + 60 * 1000);
    const staleHeartbeat = new Date(now.getTime() - HEARTBEAT_GAP_MS - 60 * 1000).toISOString();
    const oldBoundary = new Date(MODULE_LOAD_AT.getTime() - 24 * 60 * 60 * 1000).toISOString(); // established a day before this boot
    const { conn, store } = systemSettingsMock({ [ACTIVATION_SETTINGS_KEY]: oldBoundary, [LAST_LIVE_SETTINGS_KEY]: staleHeartbeat });
    await refreshLiveActivationBoundary(conn, now);
    expect(new Date(store[ACTIVATION_SETTINGS_KEY]).getTime()).toBe(MODULE_LOAD_AT.getTime());

    // A call that started during the gap (after the old boundary, before
    // the advanced one) now reads as pre_activation via the ordinary
    // stageOne path — this is the actual "off-period calls excluded"
    // guarantee, not just an isolated boundary-value assertion.
    const gapCall = {
      id: 'call-in-gap', direction: 'inbound', created_at: new Date(MODULE_LOAD_AT.getTime() - 60 * 1000),
      duration_seconds: 90, metadata: { lead_id: 'lead-1' },
    };
    const advancedBoundary = new Date(store[ACTIVATION_SETTINGS_KEY]);
    const stageConn = jest.fn(() => { const chain = {}; ['where', 'whereRaw'].forEach((m) => { chain[m] = jest.fn(() => chain); }); chain.update = jest.fn(async () => 1); return chain; });
    stageConn.raw = jest.fn((sql, bindings) => { stageConn.raw.calls = stageConn.raw.calls || []; stageConn.raw.calls.push(bindings); return 'RAW'; });
    const decided = await stageOne(stageConn, gapCall, now, advancedBoundary);
    expect(decided).toBe('skipped');
    const parsed = stageConn.raw.calls.map(([json]) => JSON.parse(json)).find((v) => v.call_booking_link_text);
    expect(parsed.call_booking_link_text.reason).toBe('pre_activation');
  });

  // "a routine restart within the threshold: nothing lost" — an ordinary
  // deploy's own gap (the process restarting, picking the cron back up)
  // lands comfortably under the threshold and must never regress the
  // boundary a call between the ORIGINAL boundary and now still needs.
  test('a fresh heartbeat under the gap threshold leaves the boundary untouched — a call since the original boundary still stages', async () => {
    const now = new Date('2026-09-26T15:00:00Z');
    const recentHeartbeat = new Date(now.getTime() - 60 * 1000).toISOString(); // 1 min ago — well under the threshold
    const originalBoundary = '2020-01-01T00:00:00.000Z';
    const { conn, store } = systemSettingsMock({ [ACTIVATION_SETTINGS_KEY]: originalBoundary, [LAST_LIVE_SETTINGS_KEY]: recentHeartbeat });
    await refreshLiveActivationBoundary(conn, now);
    expect(store[ACTIVATION_SETTINGS_KEY]).toBe(originalBoundary); // untouched
    expect(new Date(store[LAST_LIVE_SETTINGS_KEY]).getTime()).toBe(now.getTime()); // heartbeat still refreshed

    const call = {
      id: 'call-since-boundary', direction: 'inbound', created_at: new Date(now.getTime() - 60000), duration_seconds: 90,
      metadata: { lead_id: 'lead-1' },
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { inServiceArea: true },
    };
    const stageConn = jest.fn(() => { const chain = {}; ['where', 'whereRaw'].forEach((m) => { chain[m] = jest.fn(() => chain); }); chain.update = jest.fn(async () => 1); return chain; });
    stageConn.raw = jest.fn(() => 'RAW');
    const decided = await stageOne(stageConn, call, now, new Date(originalBoundary));
    expect(decided).toBe('pending'); // nothing lost
  });

  test('a gap detected but the stored boundary is already newer than MODULE_LOAD_AT is never regressed (no boundary write at all)', async () => {
    const now = new Date(MODULE_LOAD_AT.getTime() + 60 * 1000);
    const futureBoundary = new Date(now.getTime() + 60 * 60 * 1000).toISOString(); // already ahead of MODULE_LOAD_AT
    const { conn, store } = systemSettingsMock({ [ACTIVATION_SETTINGS_KEY]: futureBoundary }); // no heartbeat at all — a real gap
    await refreshLiveActivationBoundary(conn, now);
    expect(store[ACTIVATION_SETTINGS_KEY]).toBe(futureBoundary); // unchanged — never regressed
    expect(new Date(store[LAST_LIVE_SETTINGS_KEY]).getTime()).toBe(now.getTime());
  });
});

// ── outbound "return call" evidence ───────────────────────────────────────
describe('outboundPriorContactMissing / outboundStagingReason', () => {
  const callEnd = new Date('2026-09-26T18:00:00Z');
  test('an inbound call never needs prior-contact evidence', () => {
    expect(outboundPriorContactMissing({ direction: 'inbound', created_at: callEnd }, null)).toBe(false);
  });
  test('an outbound call to a lead that already existed (contacted us first) is fine', () => {
    const lead = { first_contact_at: new Date('2026-09-20T12:00:00Z') };
    expect(outboundPriorContactMissing({ direction: 'outbound', created_at: callEnd }, lead)).toBe(false);
  });
  test('an outbound call to a lead minted by this same call (or later) is not a return call', () => {
    const mintedNow = { direction: 'outbound', created_at: callEnd };
    expect(outboundPriorContactMissing(mintedNow, { first_contact_at: callEnd })).toBe(true);
    expect(outboundPriorContactMissing(mintedNow, null)).toBe(true);
  });
  test('outboundStagingReason never queries the database for an inbound call', async () => {
    const conn = jest.fn();
    const reason = await outboundStagingReason(conn, { direction: 'inbound', created_at: callEnd }, 'lead-1');
    expect(reason).toBeNull();
    expect(conn).not.toHaveBeenCalled();
  });
  test('outboundStagingReason skips a genuinely cold outbound call', async () => {
    const chain = { where: jest.fn(() => chain), first: jest.fn(async () => ({ first_contact_at: callEnd })) };
    const conn = jest.fn(() => chain);
    const reason = await outboundStagingReason(conn, { direction: 'outbound', created_at: callEnd }, 'lead-1');
    expect(reason).toBe('outbound_without_prior_contact');
  });

  // codex pre-push P1 regression: a post-call fallback row (Studio Flow's
  // /call-status on a TERMINAL event, or a recording-status recovery
  // insert — call-timeline.js's POST_CALL_ROW_SOURCES) stamps created_at
  // AFTER the call ends, while call-recording-processor.js's own
  // leadFirstContactAt backs the call's own length out of created_at via
  // the SAME callStartedAt() to set a newly minted lead's first_contact_at.
  // Comparing against created_at directly (instead of callStartedAt) would
  // read that lead as having contacted us BEFORE this very call.
  test('a terminal status_callback row: comparing against created_at (not callStartedAt) would wrongly pass a same-call mint', () => {
    const created_at = new Date('2026-09-26T18:10:00Z'); // stamped after the call ended
    const duration_seconds = 300; // 5 minutes
    const call = {
      direction: 'outbound', created_at, duration_seconds,
      metadata: { source: 'status_callback', inserted_on_status: 'completed' }, // terminal ⇒ post-call row
    };
    // The lead's first_contact_at, as leadFirstContactAt(call) would ACTUALLY
    // stamp it: created_at minus the call's own duration.
    const first_contact_at = new Date(created_at.getTime() - duration_seconds * 1000);
    expect(outboundPriorContactMissing(call, { first_contact_at })).toBe(true);
    // The bug this guards: first_contact_at (18:05) is indeed BEFORE
    // created_at (18:10), so a naive created_at comparison would call this
    // a return call — it is not; callStartedAt(call) is 18:05 too.
    expect(first_contact_at.getTime()).toBeLessThan(created_at.getTime());
  });
});

// ── resolveLeadId — the SID fallback for a stamp-less fresh lead ─────────
// codex pre-push P1: call-recording-processor.js's fresh-lead-insert path
// never stamps metadata.lead_id for the most common "brand new lead" shape
// — a stamp-less, phone-bearing fresh insert self-links through its OWN
// leads.twilio_call_sid instead. leadIdOf alone reads no_lead_linkage for
// every such call.
function leadsSidChain(rows) {
  const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), limit: jest.fn(() => chain), select: jest.fn(async () => rows) };
  return chain;
}

describe('resolveLeadId / resolveLeadLinkage', () => {
  test('a stamped call resolves without ever querying leads', async () => {
    const conn = jest.fn();
    const call = { metadata: { lead_id: 'lead-1' }, twilio_call_sid: 'CAxxx' };
    await expect(resolveLeadId(conn, call)).resolves.toBe('lead-1');
    expect(conn).not.toHaveBeenCalled();
  });

  test('a stamp-less call with no twilio_call_sid at all resolves to null without querying', async () => {
    const conn = jest.fn();
    await expect(resolveLeadId(conn, { metadata: {} })).resolves.toBeNull();
    expect(conn).not.toHaveBeenCalled();
  });

  test('a stamp-less fresh lead resolves through its own twilio_call_sid', async () => {
    const chain = leadsSidChain([{ id: 'lead-fresh' }]);
    const conn = jest.fn(() => chain);
    const call = { metadata: {}, twilio_call_sid: 'CAxxx' };
    await expect(resolveLeadId(conn, call)).resolves.toBe('lead-fresh');
    expect(conn).toHaveBeenCalledWith('leads');
    expect(chain.where).toHaveBeenCalledWith({ twilio_call_sid: 'CAxxx' });
    expect(chain.limit).toHaveBeenCalledWith(2);
  });

  test('a twilio_call_sid matching no lead resolves to null', async () => {
    const conn = jest.fn(() => leadsSidChain([]));
    await expect(resolveLeadId(conn, { metadata: {}, twilio_call_sid: 'CAxxx' })).resolves.toBeNull();
  });

  // codex r1 P1: leads.twilio_call_sid carries no unique index. Minting a
  // fresh send to the WRONG lead is worse than not sending at all, so two
  // or more live matches must fail CLOSED — never an arbitrary pick.
  test('two or more live leads sharing a sid resolve to no lead — ambiguous, not an arbitrary pick', async () => {
    const conn = jest.fn(() => leadsSidChain([{ id: 'lead-a' }, { id: 'lead-b' }]));
    await expect(resolveLeadId(conn, { metadata: {}, twilio_call_sid: 'CAxxx' })).resolves.toBeNull();
    await expect(resolveLeadLinkage(conn, { metadata: {}, twilio_call_sid: 'CAxxx' })).resolves.toEqual({ leadId: null, ambiguous: true });
  });

  test('a stamped call is never ambiguous, whatever else shares its sid', async () => {
    const conn = jest.fn();
    const linkage = await resolveLeadLinkage(conn, { metadata: { lead_id: 'lead-1' }, twilio_call_sid: 'CAxxx' });
    expect(linkage).toEqual({ leadId: 'lead-1', ambiguous: false });
  });
});

// ── consentedDestination — implied consent is PERSONAL to the caller
// (codex r5 P1) ────────────────────────────────────────────────────────────
describe('consentedDestination', () => {
  const ANI = '+19415550100';
  const SPOKEN = '+19415559999'; // a different number the caller SPOKE on the call
  const EDITED = '+19415551234'; // neither the ANI nor spoken — e.g. the lead record edited later

  const inboundCall = { direction: 'inbound', from_phone: ANI, to_phone: '+19415550200' };
  const outboundCall = { direction: 'outbound', from_phone: '+19415550200', to_phone: ANI };

  test('the inbound ANI (no consent record needed) sends', () => {
    expect(consentedDestination(inboundCall, null, ANI)).toBe(true);
  });

  test('a lead phone edited to a different number since the call is never consented', () => {
    expect(consentedDestination(inboundCall, null, EDITED)).toBe(false);
    expect(consentedDestination(inboundCall, { caller: {}, consent: {} }, EDITED)).toBe(false);
  });

  test('a spoken number WITH explicit sms_consent_given sends', () => {
    const extraction = { caller: { phone_e164: SPOKEN }, consent: { sms_consent_given: true } };
    expect(consentedDestination(inboundCall, extraction, SPOKEN)).toBe(true);
  });

  test('a spoken number WITHOUT explicit consent is refused — implied consent alone never covers it', () => {
    const extraction = { caller: { phone_e164: SPOKEN }, consent: {} };
    expect(consentedDestination(inboundCall, extraction, SPOKEN)).toBe(false);
    const explicitlyRefused = { caller: { phone_e164: SPOKEN }, consent: { sms_consent_given: false } };
    expect(consentedDestination(inboundCall, explicitlyRefused, SPOKEN)).toBe(false);
  });

  test('outbound: the dialed number (to_phone), not from_phone, is the call\'s own contact number', () => {
    expect(consentedDestination(outboundCall, null, ANI)).toBe(true);
    expect(consentedDestination(outboundCall, null, '+19415550200')).toBe(false); // from_phone alone is never it
  });

  test('phone identity compares by canonical NANP digits, not a raw string match', () => {
    expect(consentedDestination(inboundCall, null, '19415550100')).toBe(true); // no leading +
    expect(consentedDestination(inboundCall, null, '(941) 555-0100')).toBe(true);
  });

  test('a null/empty destination is never consented', () => {
    expect(consentedDestination(inboundCall, null, null)).toBe(false);
    expect(consentedDestination(inboundCall, null, '')).toBe(false);
  });
});

// ── neverSendRecheck — the providerPreSendCheck hook ──────────────────────
// codex r2 P2: re-runs the MUTABLE never-send predicates on the connection
// send-customer-message.js hands this callback, right before Twilio's own
// messages.create() — never this module's own outer `conn`.
describe('neverSendRecheck', () => {
  const CALL_FOR_RECHECK = { id: 'call-1', created_at: new Date('2026-09-26T15:30:00Z'), direction: 'inbound', from_phone: '+19415550100' };
  const DESTINATION = '+19415550100'; // matches CALL_FOR_RECHECK's own ANI — consent isolated from these tests' own concerns
  const OPEN = { id: 'lead-1', status: 'new', converted_at: null, estimate_id: null, customer_id: null, deleted_at: null };

  function dbi({ lead = OPEN, bookedSince = null, smsWithLink = null } = {}) {
    return jest.fn((table) => {
      const chain = {};
      ['where', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'limit', 'modify']
        .forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.first = jest.fn(async () => {
        if (table === 'leads') return lead;
        if (table === 'scheduled_services') return bookedSince;
        if (table === 'sms_log') return smsWithLink;
        return undefined;
      });
      chain.pluck = jest.fn(async () => []);
      return chain;
    });
  }

  test('an open lead with no estimate, not booked, no recent link: ok', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    await expect(check({ dbi: dbi() })).resolves.toEqual({ ok: true });
  });

  test('a lead closed since dispatchIneligibleReason ran blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const closed = dbi({ lead: { ...OPEN, status: 'won', converted_at: new Date() } });
    await expect(check({ dbi: closed })).resolves.toEqual({ ok: false, code: 'lead_no_longer_open' });
  });

  test('a missing lead blocks the send the same way', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    await expect(check({ dbi: dbi({ lead: null }) })).resolves.toEqual({ ok: false, code: 'lead_no_longer_open' });
  });

  test('an estimate linked since then blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    await expect(check({ dbi: dbi({ lead: { ...OPEN, estimate_id: 'est-1' } }) })).resolves.toEqual({ ok: false, code: 'estimate_linked' });
  });

  test('booked since the call started blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi({ lead: { ...OPEN, customer_id: 'cust-1' }, bookedSince: { id: 'visit-1' } });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'booked_since_call' });
  });

  test('a link delivered in the last 14 days blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi();
    conn.mockImplementation((table) => {
      const chain = {};
      ['where', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'limit', 'modify']
        .forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.first = jest.fn(async () => (table === 'leads' ? OPEN : (table === 'sms_log' ? { id: 'sms-1' } : undefined)));
      chain.pluck = jest.fn(async () => (table === 'short_codes' ? ['abcd'] : []));
      return chain;
    });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'link_sent_recently' });
  });

  // codex r3 P1: an UNCAUGHT throw here (a transient DB failure, not a
  // deliberate refusal) would leave twilio.js's own providerPreSendCheck
  // contract with no `.retryable` flag on the resulting error, turning an
  // ordinary infrastructure hiccup into a PERMANENT, non-retryable skip
  // even though Twilio was never contacted. This must be a RETURNED
  // retryable refusal instead, never a thrown error.
  test('a transient DB failure inside the recheck returns a retryable refusal, never throws', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const failing = jest.fn(() => { throw new Error('connection reset'); });
    await expect(check({ dbi: failing })).resolves.toEqual({
      ok: false, retryable: true, code: 'never_send_recheck_failed', reason: 'connection reset',
    });
  });
});

// ── claimForDispatch — atomic single-row claim ────────────────────────────
describe('claimForDispatch', () => {
  test('a pending row is claimed', async () => {
    db.raw = jest.fn(async () => ({ rows: [{ id: 'call-1' }] }));
    await expect(claimForDispatch(db, 'call-1')).resolves.toBe(true);
  });
  test('a row already claimed by another tick is not claimed twice', async () => {
    db.raw = jest.fn(async () => ({ rows: [] }));
    await expect(claimForDispatch(db, 'call-1')).resolves.toBe(false);
  });
});

// ── dispatchClaimedCall — every send-time re-check + the happy path ──────
describe('dispatchClaimedCall', () => {
  const NOW = new Date('2026-09-26T18:00:00Z'); // 2:00 PM ET — inside the window
  const CALL = { id: 'call-1', created_at: new Date('2026-09-26T15:30:00Z'), duration_seconds: 90,
    direction: 'inbound', from_phone: '+19415550100', // the ANI — matches OPEN_LEAD.phone below by default
    v2_extraction_status: 'valid', processing_token: null,
    metadata: { lead_id: 'lead-1', call_booking_link_text: { status: 'claimed', lead_id: 'lead-1', send_at: NOW.toISOString() } },
    ai_extraction_enriched: {
      meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
      caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
      property: { property_type: 'single_family' },
      service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
      scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true },
      sentiment_and_lead: { lead_quality: 'warm' },
    },
    ai_address_validation: { inServiceArea: true } };
  const OPEN_LEAD = { id: 'lead-1', status: 'new', converted_at: null, phone: '+19415550100', first_name: 'Jamie',
    customer_id: null, estimate_id: null, is_commercial: false, deleted_at: null };

  // `visitCreatedAt`, when given, makes the scheduled_services stub a REAL
  // comparison against whatever lower-bound date the code under test
  // actually queries with (captured via the `where('created_at', '>=', X)`
  // call) — rather than a canned true/false — so a test can prove the bound
  // is callStartedAt(call) and not some other instant. `bookedSince` (a
  // canned row/null) still works for tests that don't care about the exact
  // bound.
  function makeDb({ lead = OPEN_LEAD, bookedSince = null, visitCreatedAt = null, consultationCodes = [], smsWithLink = null,
    callLogUpdate = jest.fn(async () => 1), activityInsert = jest.fn(async () => {}), capture = {} } = {}) {
    const conn = jest.fn((table) => {
      const chain = {};
      ['whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'limit', 'modify']
        .forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.where = jest.fn((...args) => {
        if (table === 'scheduled_services' && args[0] === 'created_at') capture.bookedSinceBound = args[2];
        return chain;
      });
      chain.first = jest.fn(async () => {
        if (table === 'leads') return lead;
        if (table === 'scheduled_services') {
          if (visitCreatedAt) return visitCreatedAt.getTime() >= capture.bookedSinceBound.getTime() ? { id: 'visit-1' } : null;
          return bookedSince;
        }
        if (table === 'sms_log') return smsWithLink;
        return undefined;
      });
      chain.pluck = jest.fn(async () => (table === 'short_codes' ? consultationCodes : []));
      chain.update = table === 'call_log' ? callLogUpdate : jest.fn(async () => 1);
      chain.insert = table === 'activity_log' ? activityInsert : jest.fn(async () => {});
      return chain;
    });
    conn.raw = jest.fn(() => 'RAW_FRAGMENT');
    return conn;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://wavespest.co/l/abcd', line: 'Pick a time...\n\n' });
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM_test_sid', deliveryOutcome: 'accepted' });
    isAmbiguousProviderOutcome.mockReturnValue(false);
  });

  test('happy path: sends and records a sent decision', async () => {
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.sent).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: OPEN_LEAD.phone, purpose: 'missed_call_followup', audience: 'lead', channel: 'sms',
      entryPoint: 'call_booking_link_text', leadId: OPEN_LEAD.id,
      consentBasis: { status: 'transactional_allowed', source: 'call_booking_link_text' },
    }));
  });

  test('a lead linkage rewritten since staging (attribution correction/merge) blocks the send', async () => {
    const rewritten = { ...CALL, metadata: { ...CALL.metadata, lead_id: 'lead-2' } };
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, rewritten, NOW);
    expect(result.skipped).toBe('lead_linkage_changed');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a lead linkage cleared since staging blocks the send', async () => {
    const cleared = { ...CALL, metadata: { call_booking_link_text: CALL.metadata.call_booking_link_text } };
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, cleared, NOW);
    expect(result.skipped).toBe('lead_linkage_changed');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('lead no longer open (converted/lost since the call) blocks the send', async () => {
    const conn = makeDb({ lead: { ...OPEN_LEAD, status: 'won', converted_at: new Date() } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('lead_no_longer_open');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an estimate linked since the call blocks the send (their own Book button applies)', async () => {
    const conn = makeDb({ lead: { ...OPEN_LEAD, estimate_id: 'est-1' } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('estimate_linked');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a commercial lead blocks the send', async () => {
    const conn = makeDb({ lead: { ...OPEN_LEAD, is_commercial: true } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('commercial_lead');
  });

  test('a cold outbound call (no prior inbound contact) blocks the send', async () => {
    const outboundCall = { ...CALL, direction: 'outbound' };
    const conn = makeDb({ lead: { ...OPEN_LEAD, first_contact_at: outboundCall.created_at } });
    const result = await dispatchClaimedCall(conn, outboundCall, NOW);
    expect(result.skipped).toBe('outbound_without_prior_contact');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an outbound RETURN call (lead contacted us first) still sends', async () => {
    const outboundCall = { ...CALL, direction: 'outbound' };
    const conn = makeDb({ lead: { ...OPEN_LEAD, first_contact_at: new Date('2026-09-20T12:00:00Z') } });
    const result = await dispatchClaimedCall(conn, outboundCall, NOW);
    expect(result.sent).toBe(true);
  });

  test('booked since the call (any time after call end) blocks the send', async () => {
    const conn = makeDb({ lead: { ...OPEN_LEAD, customer_id: 'cust-1' }, bookedSince: { id: 'visit-1' } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('booked_since_call');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a visit created during the call (after it started, before it ended) is caught as booked since the call', async () => {
    const callDuring = { ...CALL, direction: 'inbound', created_at: new Date('2026-09-26T15:00:00Z'), duration_seconds: 300 }; // 15:00–15:05
    const visitCreatedAt = new Date('2026-09-26T15:02:00Z'); // mid-call
    const conn = makeDb({ lead: { ...OPEN_LEAD, customer_id: 'cust-1' }, visitCreatedAt });
    const result = await dispatchClaimedCall(conn, callDuring, NOW);
    expect(result.skipped).toBe('booked_since_call');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // codex pre-push P1: a "recovered" post-call fallback row's created_at is
  // stamped AFTER the call ends, and a bogus/huge duration_seconds makes
  // callEndedAt(call) read as decades in the future. bookedSinceCall's
  // lower bound must be the call's actual START (callStartedAt), never that
  // reading — otherwise a visit created minutes after the real
  // conversation falls BEFORE the bogus future bound and escapes
  // detection, texting a link to someone who already booked.
  test('a visit created after the real call end, but long before callEndedAt\'s bogus future reading, is still caught', async () => {
    const recovered = { ...CALL, direction: 'inbound', created_at: new Date('2026-09-26T15:00:00Z'), duration_seconds: 999999999 };
    const visitCreatedAt = new Date('2026-09-26T15:10:00Z'); // minutes after the real call, decades before callEndedAt's reading
    const conn = makeDb({ lead: { ...OPEN_LEAD, customer_id: 'cust-1' }, visitCreatedAt });
    const result = await dispatchClaimedCall(conn, recovered, NOW);
    expect(result.skipped).toBe('booked_since_call');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a link actually delivered by SMS in the last 14 days blocks a second one', async () => {
    const conn = makeDb({ consultationCodes: ['abcd'], smsWithLink: { id: 'sms-1' } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('link_sent_recently');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a link merely MINTED (composer opened, never sent) does not suppress a real send', async () => {
    // codex pre-push P1: a short_codes row only proves the link was minted
    // (Virginia's composer prefill, or the estimate-email offer's own
    // separate mint) — not that an SMS carrying it was ever accepted.
    const conn = makeDb({ consultationCodes: ['abcd'], smsWithLink: null });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.sent).toBe(true);
  });

  test('a call mid-reprocess (processing_token held) waits instead of judging half-written state', async () => {
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, { ...CALL, processing_token: 'tok-1' }, NOW);
    expect(result).toMatchObject({ sent: false, skipped: 'call_not_ready', deferred: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // codex r2 P1: this requeue must not silently drop original_send_at —
    // metadataPatch replaces the whole nested entry.
    const rawCall = conn.raw.mock.calls.find(([, bindings]) => bindings?.[0]?.includes('"status":"pending"'));
    expect(JSON.parse(rawCall[1][0]).call_booking_link_text.original_send_at).toBe(NOW.toISOString());
  });

  test('an extraction reset by a reprocess (status null) waits too', async () => {
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, { ...CALL, v2_extraction_status: null }, NOW);
    expect(result).toMatchObject({ skipped: 'call_not_ready', deferred: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a reprocess that ended non-valid is a skip, never a send on the stale extraction', async () => {
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, { ...CALL, v2_extraction_status: 'parse_failed' }, NOW);
    expect(result.skipped).toBe('extraction_parse_failed');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a row still not ready a day past its send time gives up with a reason', async () => {
    const conn = makeDb();
    const staleEntry = { status: 'claimed', lead_id: 'lead-1', send_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString() };
    const stuck = { ...CALL, processing_token: 'tok-1', metadata: { ...CALL.metadata, call_booking_link_text: staleEntry } };
    const result = await dispatchClaimedCall(conn, stuck, NOW);
    expect(result.skipped).toBe('call_not_ready_timeout');
    expect(result.deferred).toBeUndefined();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('outside the 8am-8pm ET window is deferred to the next window open, never lost', async () => {
    const conn = makeDb();
    const lateNight = new Date('2026-09-27T03:00:00Z'); // 11 PM ET
    const result = await dispatchClaimedCall(conn, CALL, lateNight);
    expect(result.skipped).toBe('outside_send_window');
    expect(result.deferred).toBe(true);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Re-queued as 'pending' with a fresh send_at — never terminally 'skipped'.
    const rawCall = conn.raw.mock.calls.find(([, bindings]) => bindings?.[0]?.includes('"status":"pending"'));
    expect(rawCall).toBeTruthy();
    // codex r2 P1: original_send_at must survive this deferral too, or an
    // overnight quiet-hours crossing would reset the 24h retry anchor.
    expect(JSON.parse(rawCall[1][0]).call_booking_link_text.original_send_at).toBe(CALL.metadata.call_booking_link_text.send_at);
  });

  test('the link builder refusing (e.g. GATE_LEAD_INSPECTION_LINK dark) blocks the send with its reason', async () => {
    buildLeadConsultationSmsLine.mockResolvedValue({ url: null, line: '', reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)' });
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('link_unavailable:Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // codex r2 P2: a PERMANENT refusal (gate off, template missing, invalid
  // phone, ineligible lead — none of these carry `transient`) still skips
  // terminally, exactly as above. A TRANSIENT one (a DB hiccup inside the
  // builder itself) must requeue through the same bounded retry rail a
  // retryable send outcome uses, never a terminal skip.
  test('a transient link-construction failure requeues through the retry rail, not a terminal skip', async () => {
    buildLeadConsultationSmsLine.mockResolvedValue({ url: null, line: '', reason: 'Could not build a consultation link', transient: true });
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.sent).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.skipped).toBe('link_unavailable:Could not build a consultation link');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const rawCall = conn.raw.mock.calls.find(([, bindings]) => bindings?.[0]?.includes('"status":"pending"'));
    expect(rawCall).toBeTruthy();
  });

  test('a transient link-construction failure past the 24h deadline gives up like any other overdue retry', async () => {
    buildLeadConsultationSmsLine.mockResolvedValue({ url: null, line: '', reason: 'Could not build a consultation link', transient: true });
    const originalSendAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const stale = {
      ...CALL,
      metadata: { ...CALL.metadata, call_booking_link_text: { status: 'claimed', lead_id: 'lead-1', send_at: originalSendAt, original_send_at: originalSendAt } },
    };
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, stale, NOW);
    expect(result.deferred).toBeUndefined();
    expect(result.skipped).toBe('send_retry_timeout');
  });

  // codex r2 P2: dispatchIneligibleReason's own checks, run once earlier,
  // can go stale by the time Twilio's own request fires — providerPreSendCheck
  // re-runs the mutable ones on the SAME connection the provider handoff holds.
  test('sendCustomerMessage receives a providerPreSendCheck re-running the mutable never-send checks', async () => {
    const conn = makeDb();
    await dispatchClaimedCall(conn, CALL, NOW);
    const sendInput = sendCustomerMessage.mock.calls[0][0];
    expect(typeof sendInput.providerPreSendCheck).toBe('function');
    // And it actually re-derives the SAME never-send verdict this dispatch
    // itself just cleared — not a stub.
    await expect(sendInput.providerPreSendCheck({ dbi: makeDb() })).resolves.toEqual({ ok: true });
  });

  test('a policy-blocked send (e.g. opted out since the call) is recorded as skipped, not sent', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED_OPT_OUT' });
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('SUPPRESSED_OPT_OUT');
  });

  // codex r1 P1: the token is signed for the phone buildLeadConsultationSmsLine
  // minted it for, not necessarily lead.phone from this function's own
  // earlier read.
  test('a token minted for a different phone than the row judged blocks the send', async () => {
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://wavespest.co/l/abcd', line: 'Pick a time...\n\n', phone: '+19415559999' });
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('phone_changed_before_send');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a token minted for the SAME phone sends normally, to that exact number', async () => {
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://wavespest.co/l/abcd', line: 'Pick a time...\n\n', phone: OPEN_LEAD.phone });
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.sent).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: OPEN_LEAD.phone }));
  });

  // codex r5 P1: implied transactional consent is PERSONAL to whoever was
  // actually ON the call — it never extends to a number the lead record
  // was edited to sometime AFTER the call, even when that new number is
  // internally consistent (the token minted for it matches lead.phone, so
  // phone_changed_before_send never fires).
  test('a lead phone edited to a number never on this call blocks the send with destination_not_consented', async () => {
    const editedPhone = '+19415551234'; // neither CALL.from_phone (the ANI) nor any spoken number
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://wavespest.co/l/abcd', line: 'Pick a time...\n\n', phone: editedPhone });
    const conn = makeDb({ lead: { ...OPEN_LEAD, phone: editedPhone } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('destination_not_consented');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // codex r1 P2: reply from the line the caller actually reached, not
  // deriveOutboundNumber's location-based fallback.
  test('metadata.fromNumber rides the managed line this call actually used', async () => {
    const PARRISH = '+19412972817'; // a real registered location line
    const withLine = { ...CALL, to_phone: PARRISH };
    const conn = makeDb();
    await dispatchClaimedCall(conn, withLine, NOW);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ fromNumber: PARRISH }),
    }));
  });

  test('no valid managed line omits fromNumber entirely — deriveOutboundNumber decides as before', async () => {
    const conn = makeDb();
    await dispatchClaimedCall(conn, CALL, NOW); // CALL carries no to_phone/from_phone at all
    expect(sendCustomerMessage.mock.calls[0][0].metadata.fromNumber).toBeUndefined();
  });

  // codex r1 P1: a retryable/deferred sendCustomerMessage outcome (a
  // quiet-hours hold this sweep crossed into, CONSENT_LOOKUP_FAILED, a
  // transient provider failure) is a reason to WAIT, never to give up.
  test('a retryable send outcome re-queues as pending at nextAllowedAt, not a terminal skip', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, retryable: true, nextAllowedAt: '2026-09-26T20:30:00.000Z', code: 'CONSENT_LOOKUP_FAILED' });
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('CONSENT_LOOKUP_FAILED');
    expect(result.deferred).toBe(true);
    const rawCall = conn.raw.mock.calls.find(([, bindings]) => bindings?.[0]?.includes('"status":"pending"'));
    expect(rawCall).toBeTruthy();
    expect(JSON.parse(rawCall[1][0]).call_booking_link_text.send_at).toBe('2026-09-26T20:30:00.000Z');
  });

  test('a retryable outcome with no nextAllowedAt uses a short backoff instead', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, retryable: true, code: 'PROVIDER_FAILURE' });
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.deferred).toBe(true);
    const rawCall = conn.raw.mock.calls.find(([, bindings]) => bindings?.[0]?.includes('"status":"pending"'));
    const sendAt = new Date(JSON.parse(rawCall[1][0]).call_booking_link_text.send_at);
    expect(sendAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(sendAt.getTime()).toBeLessThan(NOW.getTime() + 60 * 60 * 1000); // well under an hour out
  });

  // codex r3 P1: the deadline must be judged BEFORE ever minting/sending,
  // not only after a retryable failure — otherwise an overdue attempt that
  // happens to succeed still texts a stale follow-up and records it as an
  // ordinary send.
  test('an overdue retry (past the 24h deadline) never calls the sender, even though it would succeed', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM_would_succeed', deliveryOutcome: 'accepted' });
    const originalSendAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const overdue = {
      ...CALL,
      metadata: { ...CALL.metadata, call_booking_link_text: { status: 'claimed', lead_id: 'lead-1', send_at: originalSendAt, original_send_at: originalSendAt } },
    };
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, overdue, NOW);
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('send_retry_timeout');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(buildLeadConsultationSmsLine).not.toHaveBeenCalled();
  });

  test('a row past 24h from the ORIGINAL send_at gives up with a reason, not another requeue or a send attempt', async () => {
    // The deadline is judged BEFORE ever sending (see the overdue-retry
    // test above), so what sendCustomerMessage would have returned is
    // irrelevant here — it must never be called at all.
    const staleEntry = { status: 'claimed', lead_id: 'lead-1', send_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString() };
    const stale = { ...CALL, metadata: { ...CALL.metadata, call_booking_link_text: staleEntry } };
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, stale, NOW);
    expect(result.skipped).toBe('send_retry_timeout');
    expect(result.deferred).toBeUndefined();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // codex r2 P1: each retry re-queues with a NEW send_at (the next attempt
  // time). If the 24h bound were measured against THAT field, consecutive
  // transient failures would push the deadline out indefinitely — a stale
  // follow-up could send days later. original_send_at is the one fixed
  // anchor that must survive every deferral unchanged.
  test('original_send_at survives a retry requeue unchanged — the 24h bound never resets on it', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, retryable: true, code: 'PROVIDER_FAILURE' });
    const originalSendAt = new Date(NOW.getTime() - 23 * 60 * 60 * 1000).toISOString(); // 23h ago — still inside the 24h bound
    const entry1 = { status: 'claimed', lead_id: 'lead-1', send_at: originalSendAt, original_send_at: originalSendAt };
    const call1 = { ...CALL, metadata: { ...CALL.metadata, call_booking_link_text: entry1 } };
    const conn1 = makeDb();
    const result1 = await dispatchClaimedCall(conn1, call1, NOW);
    expect(result1.deferred).toBe(true); // still within bound — requeued, not given up

    const rawCall1 = conn1.raw.mock.calls.find(([, bindings]) => bindings?.[0]?.includes('"status":"pending"'));
    const written1 = JSON.parse(rawCall1[1][0]).call_booking_link_text;
    expect(written1.original_send_at).toBe(originalSendAt); // preserved
    expect(written1.send_at).not.toBe(originalSendAt); // send_at itself DID advance to the next attempt

    // Two hours later — now 25h past the ORIGINAL send_at. A naive
    // implementation reading the (just-advanced) send_at as its own anchor
    // would still see itself as within bound; this must not.
    const laterNow = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    const entry2 = { ...entry1, send_at: written1.send_at, original_send_at: written1.original_send_at };
    const call2 = { ...CALL, metadata: { ...CALL.metadata, call_booking_link_text: entry2 } };
    const conn2 = makeDb();
    const result2 = await dispatchClaimedCall(conn2, call2, laterNow);
    expect(result2.deferred).toBeUndefined();
    expect(result2.skipped).toBe('send_retry_timeout'); // caught by the pre-send deadline check, never reaches the sender again
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1); // only round 1's attempt — round 2 never re-sent
  });

  // codex r2 P1: the OTHER two pending-requeue writers (the call_not_ready
  // wait branch, and the outside-send-window branch) also replace the
  // whole nested entry via metadataPatch — a retry that happens to cross
  // into quiet hours must not have THAT deferral silently drop
  // original_send_at either.
  test('a retry that spans an overnight outside-window deferral still measures the 24h bound from the TRUE original', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, retryable: true, code: 'PROVIDER_FAILURE' });
    const originalSendAt = new Date(NOW.getTime() - 20 * 60 * 60 * 1000).toISOString(); // 20h before the first attempt
    const entry1 = { status: 'claimed', lead_id: 'lead-1', send_at: originalSendAt, original_send_at: originalSendAt };
    const call1 = { ...CALL, metadata: { ...CALL.metadata, call_booking_link_text: entry1 } };
    const conn1 = makeDb();
    const result1 = await dispatchClaimedCall(conn1, call1, NOW); // still within 24h — requeued
    expect(result1.deferred).toBe(true);
    const written1 = JSON.parse(conn1.raw.mock.calls.find(([, b]) => b?.[0]?.includes('"status":"pending"'))[1][0]).call_booking_link_text;

    // The next tick lands overnight — dispatchClaimedCall's OWN send-window
    // deferral fires before sendCustomerMessage is ever called again.
    const lateNight = new Date('2026-09-27T03:00:00Z'); // 11 PM ET
    const entry2 = { ...entry1, send_at: written1.send_at, original_send_at: written1.original_send_at };
    const call2 = { ...CALL, metadata: { ...CALL.metadata, call_booking_link_text: entry2 } };
    const conn2 = makeDb();
    const result2 = await dispatchClaimedCall(conn2, call2, lateNight);
    expect(result2.skipped).toBe('outside_send_window');
    const written2 = JSON.parse(conn2.raw.mock.calls.find(([, b]) => b?.[0]?.includes('"status":"pending"'))[1][0]).call_booking_link_text;
    expect(written2.original_send_at).toBe(originalSendAt); // still the TRUE original

    // The window reopens the next morning — but by now more than 24h has
    // passed since the TRUE original send_at. This pass must give up, not
    // requeue a third time.
    const nextMorning = new Date('2026-09-27T13:00:00Z'); // 9 AM ET
    const entry3 = { ...entry2, send_at: written2.send_at, original_send_at: written2.original_send_at };
    const call3 = { ...CALL, metadata: { ...CALL.metadata, call_booking_link_text: entry3 } };
    const conn3 = makeDb();
    const result3 = await dispatchClaimedCall(conn3, call3, nextMorning);
    expect(result3.deferred).toBeUndefined();
    expect(result3.skipped).toBe('send_retry_timeout'); // caught by the pre-send deadline check
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1); // only round 1 ever reached the sender
  });

  // ── handoff_started_at — the fact that decides safe-to-retry vs
  // leave-for-review after a failure (codex r3 P2) ────────────────────────
  describe('handoff_started_at is stamped right before the provider call', () => {
    function lastMetadataPatch(conn) {
      const call = [...conn.raw.mock.calls].reverse().find(([sql, bindings]) => sql.includes('jsonb') && Array.isArray(bindings) && typeof bindings[0] === 'string');
      return call ? JSON.parse(call[1][0]).call_booking_link_text : null;
    }

    test('the stamp lands before sendCustomerMessage is ever called, and survives a subsequent successful send', async () => {
      const conn = makeDb();
      let stampWrittenBeforeSend = null;
      sendCustomerMessage.mockImplementation(async () => {
        stampWrittenBeforeSend = lastMetadataPatch(conn);
        return { sent: true, providerMessageId: 'SM_test_sid', deliveryOutcome: 'accepted' };
      });
      const result = await dispatchClaimedCall(conn, CALL, NOW);
      expect(result.sent).toBe(true);
      expect(stampWrittenBeforeSend).toMatchObject({ status: 'claimed' });
      expect(stampWrittenBeforeSend.handoff_started_at).toBeTruthy();
    });

    test('a throw from sendCustomerMessage AFTER the stamp leaves handoff_started_at on the row — recoverAbandonedClaim then treats it as ambiguous, never resent', async () => {
      sendCustomerMessage.mockRejectedValue(new Error('provider timeout, no result'));
      const conn = makeDb();
      await expect(dispatchClaimedCall(conn, CALL, NOW)).rejects.toThrow('provider timeout, no result');
      const patch = lastMetadataPatch(conn);
      expect(patch.handoff_started_at).toBeTruthy(); // the stamp survived the throw

      const stampedCall = { ...CALL, metadata: { ...CALL.metadata, call_booking_link_text: patch } };
      const outcome = await recoverAbandonedClaim(conn, stampedCall, NOW);
      expect(outcome).toEqual({ ambiguous: true });
    });

    test('a throw BEFORE the stamp (the link builder itself throws) leaves no handoff_started_at — safe for recoverAbandonedClaim to requeue', async () => {
      buildLeadConsultationSmsLine.mockRejectedValue(new Error('db hiccup'));
      const conn = makeDb();
      await expect(dispatchClaimedCall(conn, CALL, NOW)).rejects.toThrow('db hiccup');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      const patch = lastMetadataPatch(conn);
      expect(patch).toBeNull(); // the stamp write never happened at all

      const outcome = await recoverAbandonedClaim(conn, CALL, NOW); // CALL's own metadata never carried handoff_started_at
      expect(outcome.ambiguous).toBe(false);
    });
  });
});

// ── recoverAbandonedClaim — the shared before/after-handoff decision ─────
describe('recoverAbandonedClaim', () => {
  const NOW = new Date('2026-09-26T18:00:00Z');

  function rawCapturingConn() {
    const chain = {};
    ['where', 'whereNull', 'whereRaw', 'orderBy', 'limit', 'select'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.update = jest.fn(async () => 1);
    chain.insert = jest.fn(async () => {});
    chain.first = jest.fn(async () => undefined);
    const conn = jest.fn(() => chain);
    conn.raw = jest.fn((sql, bindings) => { conn.raw.captured = conn.raw.captured || []; conn.raw.captured.push(bindings); return 'RAW'; });
    return conn;
  }

  function lastPatch(conn) {
    const [json] = conn.raw.captured[conn.raw.captured.length - 1];
    return JSON.parse(json).call_booking_link_text;
  }

  test('no handoff_started_at, within the retry deadline: requeues as pending, preserving original_send_at (no activity_log entry)', async () => {
    const conn = rawCapturingConn();
    const entry = {
      status: 'claimed', lead_id: 'lead-1', send_at: NOW.toISOString(),
      original_send_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    };
    const outcome = await recoverAbandonedClaim(conn, { id: 'call-1', metadata: { call_booking_link_text: entry } }, NOW);
    expect(outcome).toEqual({ ambiguous: false, terminal: false });
    const patch = lastPatch(conn);
    expect(patch.status).toBe('pending');
    expect(patch.original_send_at).toBe(entry.original_send_at);
    expect(new Date(patch.send_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  test('no handoff_started_at, past the 24h retry deadline (measured from original_send_at): terminal skip, worker_error', async () => {
    const conn = rawCapturingConn();
    const entry = {
      status: 'claimed', lead_id: 'lead-1', send_at: NOW.toISOString(),
      original_send_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    };
    const outcome = await recoverAbandonedClaim(conn, { id: 'call-1', metadata: { call_booking_link_text: entry } }, NOW);
    expect(outcome).toEqual({ ambiguous: false, terminal: true });
    const patch = lastPatch(conn);
    expect(patch).toMatchObject({ status: 'skipped', reason: 'worker_error' });
  });

  test('handoff_started_at present: leaves the row claimed with no further write — the provider may already have this attempt', async () => {
    const conn = rawCapturingConn();
    const entry = { status: 'claimed', lead_id: 'lead-1', send_at: NOW.toISOString(), handoff_started_at: NOW.toISOString() };
    const outcome = await recoverAbandonedClaim(conn, { id: 'call-1', metadata: { call_booking_link_text: entry } }, NOW);
    expect(outcome).toEqual({ ambiguous: true });
    expect(conn.raw).not.toHaveBeenCalled(); // no metadata write at all
  });
});

// ── recoverStaleClaims — the safety net for a worker that died mid-dispatch
// (codex r3 P2) ────────────────────────────────────────────────────────────
describe('recoverStaleClaims', () => {
  const NOW = new Date('2026-09-26T18:00:00Z');

  function connFor(row) {
    const chain = {};
    ['whereRaw', 'orderBy', 'limit', 'where'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.select = jest.fn(async () => (row ? [{ id: row.id }] : []));
    chain.first = jest.fn(async () => row);
    chain.update = jest.fn(async () => 1);
    chain.insert = jest.fn(async () => {});
    const conn = jest.fn(() => chain);
    conn.raw = jest.fn((sql, bindings) => { conn.raw.captured = conn.raw.captured || []; conn.raw.captured.push(bindings); return 'RAW'; });
    return conn;
  }

  test('a stale claimed row with no handoff is requeued and counted', async () => {
    const row = {
      id: 'call-stale-1',
      metadata: { call_booking_link_text: { status: 'claimed', lead_id: 'lead-1', send_at: NOW.toISOString(), original_send_at: NOW.toISOString() } },
    };
    const conn = connFor(row);
    const recovered = await recoverStaleClaims(conn, NOW);
    expect(recovered).toBe(1);
    expect(conn.raw).toHaveBeenCalled(); // recoverAbandonedClaim actually wrote a requeue
  });

  test('a stale-looking candidate already resolved by a concurrent tick (no longer claimed) is skipped, never double-recovered', async () => {
    const row = { id: 'call-stale-2', metadata: { call_booking_link_text: { status: 'sent' } } };
    const conn = connFor(row);
    const recovered = await recoverStaleClaims(conn, NOW);
    expect(recovered).toBe(0);
    expect(conn.raw).not.toHaveBeenCalled(); // recoverAbandonedClaim never even ran
  });

  test('a stale claimed row WITH handoff_started_at is left claimed (ambiguous) and not counted', async () => {
    const row = { id: 'call-stale-3', metadata: { call_booking_link_text: { status: 'claimed', handoff_started_at: NOW.toISOString() } } };
    const conn = connFor(row);
    const recovered = await recoverStaleClaims(conn, NOW);
    expect(recovered).toBe(0);
  });

  test('a row no longer found at all (deleted/merged since the candidate SELECT) is skipped without throwing', async () => {
    const conn = connFor(undefined);
    conn.mockImplementation((table) => {
      const chain = {};
      ['whereRaw', 'orderBy', 'limit', 'where'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.select = jest.fn(async () => [{ id: 'call-gone' }]);
      chain.first = jest.fn(async () => undefined);
      chain.update = jest.fn(async () => 1);
      chain.insert = jest.fn(async () => {});
      return chain;
    });
    await expect(recoverStaleClaims(conn, NOW)).resolves.toBe(0);
  });
});
