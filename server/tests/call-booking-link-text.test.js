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
// Real registry (never mocked in this file — see managedLineForCall's own
// tests below, which already assert against real registered numbers).
const TWILIO_NUMBERS = require('../config/twilio-numbers');
jest.mock('../models/marker-db', () => jest.fn());
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
// hasPriorContact (codex #5012) always queries the real db singleton, never
// a passed-in conn — mocked at the module boundary so these unit tests
// exercise this lane's OWN wiring (what it passes in, how it reacts to the
// answer) without depending on outbound-call-reason.js's own DB probes.
// nanpStoredPhoneClause (codex #5018 r15 P2) is the real implementation —
// it is a pure string builder (never touches the DB), and bookedSinceCall's
// own mocked chain.whereRaw ignores whatever string it returns, so there is
// no reason to fake it.
jest.mock('../services/outbound-call-reason', () => ({
  hasPriorContact: jest.fn(),
  nanpStoredPhoneClause: jest.requireActual('../services/outbound-call-reason').nanpStoredPhoneClause,
}));

const db = require('../models/db');
const markerDb = require('../models/marker-db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const { buildLeadConsultationSmsLine } = require('../services/lead-consultation-link');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { hasPriorContact } = require('../services/outbound-call-reason');
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
  STAGING_STALE_MS,
  QUEUE_SCAN_LOOKBACK_MS,
  HANDOFF_MARKER_TABLE,
  HANDOFF_MARKER_RETENTION_MS,
  DISPATCH_BATCH,
  CONSULTATION_ATTEMPT_TABLE,
  linkSentRecently,
  _private,
} = require('../services/call-booking-link-text');
const { normalizeExtractionV2 } = require('../utils/normalize-extraction-v2');

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

  // codex #5018 P2: config/twilio-numbers.js's own findByNumber treats an
  // env-configured internalAlertCallerId() as a REGISTERED line (its last
  // branch: "office semantics, like unassigned") — without this exclusion,
  // a call whose from_phone/to_phone happened to be the internal alert
  // leg would pass findByNumber, isTechLine, isStaffForwardNumber and the
  // toll-free check, and get returned as a valid customer-facing reply
  // line, when it is never customer-facing at all (the new-lead ring to
  // Adam's cell).
  test('the env-configured internal alert line is never used — falls back to a customer-facing line', () => {
    const ALERT_LINE = '+19415557777'; // distinct from every other fixture number above
    process.env.INTERNAL_ALERT_CALLER_ID = ALERT_LINE;
    try {
      // Confirms findByNumber really does resolve it (the exact registered-
      // line trap this exclusion exists for), so a null result below is
      // this fix, never an unrelated "not registered at all" no-op.
      expect(TWILIO_NUMBERS.findByNumber(ALERT_LINE)).toBeTruthy();
      expect(managedLineForCall({ direction: 'inbound', to_phone: ALERT_LINE })).toBeNull();
    } finally {
      delete process.env.INTERNAL_ALERT_CALLER_ID;
    }
  });

  // Negative control: internalAlertCallerId() ITSELF falls back to the
  // ordinary main line when the env var is unset — this exclusion must
  // never reject that fallback value (main line traffic is genuinely
  // customer-facing) or a naive comparison would silently change today's
  // ordinary, unconfigured behavior for every other registered line.
  test('with INTERNAL_ALERT_CALLER_ID unset, an ordinary registered line is unaffected', () => {
    delete process.env.INTERNAL_ALERT_CALLER_ID;
    expect(TWILIO_NUMBERS.internalAlertLine()).toBeNull(); // falls back to main line — no distinct alert line to exclude
    expect(managedLineForCall({ direction: 'inbound', to_phone: PARRISH })).toBe(PARRISH);
  });
});

// ── stagingIneligibleReason — every "never" rule + the happy path ────────
describe('stagingIneligibleReason', () => {
  // A genuine 4-turn, 2-speaker exchange — every case in this describe is
  // otherwise-eligible by default, so hasRealTwoWayConversation (codex
  // #5018 r11 P2) must not false-block them the way a blank/one-speaker
  // fixture transcript would (never true of a real completed call).
  const TWO_WAY_TRANSCRIPT = 'Caller: Hi, I have a bug problem.\nAgent: Sure, let me help with that.\nCaller: Can someone come out this week?\nAgent: Let me check the schedule.';
  // direction/from_phone/to_phone (codex #5018 r11 P1): every real call_log
  // row has a dialable ANI — resolveCallContactPhone(baseCall, null) needs
  // one so the canonical merge's own caller_phone_missing check (fed
  // contactPhone) doesn't false-block every case in this suite the way an
  // ANI-less test fixture would (never true of a real row).
  const baseCall = {
    customer_id: null, duration_seconds: 90, ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    direction: 'inbound', from_phone: '+19415550100', to_phone: '+19415550199', transcription: TWO_WAY_TRANSCRIPT,
  };
  const baseExtraction = () => ({
    meta: { is_voicemail: false, is_spam: false },
    call_nature: 'new_lead',
    recommended_disposition: 'lead_response_flow_triggered',
    triage_flags: [],
    caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
    // A populated service_address (codex #5018 r11 P1): computeDeterministicTriageFlags'
    // OWN address branch (fed through the canonical merge) treats a
    // genuinely blank address as missing_service_address whenever AV isn't
    // decisive — real new-lead extractions always carry the caller's
    // stated address, so an empty one here is a test-fixture gap, not a
    // realistic call.
    property: { property_type: 'single_family', service_address: { street_line_1: '123 Main St', city: 'Bradenton', postal_code: '34205' } },
    service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
    scheduling: { status: 'requested' },
    consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
    sentiment_and_lead: { lead_quality: 'warm' },
  });
  const leadId = 'lead-1';

  test('eligible call returns null', () => {
    expect(stagingIneligibleReason(baseCall, baseExtraction(), leadId)).toBeNull();
  });

  // consent.sms_declined (schema 1.19.0, codex P1 on #5292) survives the
  // REAL normalizeExtractionV2 (not just a hand-built fixture) before the
  // staging check reads it — pre-push review's exact concern: if the
  // model-output-to-persisted normalizer ever started copying consent
  // fields by name instead of passing the object through, sms_declined
  // would silently stop reaching this check.
  test('sms_declined survives real normalizeExtractionV2 before the staging check reads it', () => {
    const declined = normalizeExtractionV2({ ...baseExtraction(), consent: { ...baseExtraction().consent, sms_declined: true } });
    expect(declined.consent.sms_declined).toBe(true);
    expect(stagingIneligibleReason(baseCall, declined, leadId)).toBe('sms_declined');

    const notDeclined = normalizeExtractionV2(baseExtraction());
    expect(notDeclined.consent.sms_declined).toBe(false);
    expect(stagingIneligibleReason(baseCall, notDeclined, leadId)).toBeNull();
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
    // codex #5018 r10 P1: a home_buyer (schema 1.15.0) is under contract,
    // not the owner yet — the owner's WDO-buyer authorization is narrow
    // (a confirmed booking on the call) and this lane never reaches an
    // already-booked call, so any home_buyer that reaches this check is
    // never that authorized case.
    ['a home buyer (under contract, not the owner yet) calling', { caller: { relationship_to_property: 'home_buyer' } }, 'third_party_caller'],
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
    // schema 1.19.0, codex P1 on #5292: sms_consent_given=false also covered
    // an explicit "no" to "may I text you?", so the dry-run removal above
    // stopped catching that refusal along with the "never asked" majority
    // it was meant to unblock. sms_declined is the dedicated field.
    ['the caller explicitly declined texting', { consent: { sms_declined: true } }, 'sms_declined'],
    // A pre-1.19 extraction never has sms_declined at all (not null —
    // simply absent, since the persisted schema doesn't require it) and
    // must fail CLOSED rather than assume no refusal was made.
    ['a pre-1.19 extraction with no sms_declined field at all', { consent: { sms_declined: undefined } }, 'sms_refusal_unrecorded'],
    ['caller prefers a phone call', { caller: { preferred_contact_method: 'phone' } }, 'prefers_phone_contact'],
    ['wrong-number lead quality', { sentiment_and_lead: { lead_quality: 'wrong_number' } }, 'lead_quality_wrong_number'],
    ['spam/solicitation lead quality', { sentiment_and_lead: { lead_quality: 'spam_or_solicitation' } }, 'lead_quality_spam_or_solicitation'],
    // codex #5018 r11 P1: computeDeterministicTriageFlags derives
    // low_extraction_confidence from confidence.overall alone — the model
    // reported NO triage_flags of its own (triage_flags stays []), so only
    // the canonical merge this fix adds catches it.
    ['low overall extraction confidence, with the model reporting no flags of its own', { confidence: { overall: 0.2 } }, 'triage_flag_low_extraction_confidence'],
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

  // codex #5018 r11 P1: the canonical merge (model + deterministic flags)
  // must not introduce a false block on an otherwise perfectly normal call
  // — high confidence, a dialable ANI, nothing address-related to flag.
  test('a normal, high-confidence extraction proceeds despite the new canonical-flags merge', () => {
    const extraction = { ...baseExtraction(), confidence: { overall: 0.92 } };
    expect(stagingIneligibleReason(baseCall, extraction, leadId)).toBeNull();
  });

  // OWNER RULING 2026-09-28: this transactional follow-up may go to a
  // caller who never explicitly opted in to SMS, as long as it rides the
  // consented destination (consentedDestination's ANI/dialed-number path) —
  // no_sms_consent_captured removed from EXCLUDED_TRIAGE_FLAGS. Every OTHER
  // block still holds: do_not_contact_requested (test below) and the
  // explicit do-not-contact request (table above).
  test('no_sms_consent_captured alone no longer blocks (owner ruling 2026-09-28)', () => {
    const extraction = { ...baseExtraction(), triage_flags: ['no_sms_consent_captured'] };
    expect(stagingIneligibleReason(baseCall, extraction, leadId)).toBeNull();
  });

  // Dry run 2026-09-28: sms_consent_given is a required boolean that the
  // prompt sets true only on an explicit yes, so false = "never asked". It
  // blocked 151 of 159 real new-lead calls; it must not block staging.
  test('sms_consent_given: false (never asked) does not block', () => {
    const extraction = { ...baseExtraction(), consent: { ...baseExtraction().consent, sms_consent_given: false }, triage_flags: ['no_sms_consent_captured'] };
    expect(stagingIneligibleReason(baseCall, extraction, leadId)).toBeNull();
  });

  // codex #5018 r11 P1: the model's own raw out_of_service_area triage flag
  // still blocks via the canonical-merge safety net — moved out of the
  // shared test.each above because baseCall's AV (validated_accept,
  // in area) makes suppressAddressFlagsForAV correctly treat a model claim
  // of out_of_service_area as STALE and drop it (AV is authoritative over a
  // contradicting model guess — the same suppression the canonical pipeline
  // itself applies) — this scenario needs an AV verdict that is decisive
  // enough not to trip the earlier not_in_service_area check on its own
  // (inServiceArea: true) but NOT validated_accept/corrected, so the model's
  // flag is never suppressed.
  test('the model\'s own out_of_service_area triage flag blocks, when AV has not decisively accepted the address', () => {
    const call = { ...baseCall, ai_address_validation: { status: 'confirm_needed', inServiceArea: true } };
    const extraction = { ...baseExtraction(), triage_flags: ['out_of_service_area'] };
    expect(stagingIneligibleReason(call, extraction, leadId)).toBe('triage_flag_out_of_service_area');
  });

  // codex #5018 r11 P2: duration alone (conversationSeconds/call_too_short
  // above) proves the clock ran, never that both parties actually spoke.
  test('a one-speaker 45-second transcript (no real back-and-forth) is skipped', () => {
    const oneSided = { ...baseCall, duration_seconds: 45, transcription: 'Caller: Hi, is anyone there? Hello? I have a bug problem, please call me back.' };
    expect(stagingIneligibleReason(oneSided, baseExtraction(), leadId)).toBe('not_two_way_conversation');
  });

  test('a real two-way exchange proceeds', () => {
    expect(stagingIneligibleReason({ ...baseCall, transcription: TWO_WAY_TRANSCRIPT }, baseExtraction(), leadId)).toBeNull();
  });

  test('the raw, unattributed "Speaker 1:"/"Speaker 2:" diarization form still proceeds', () => {
    const raw = 'Speaker 1: Hi, I have a bug problem.\nSpeaker 2: Sure, let me help with that.\nSpeaker 1: Can someone come out this week?\nSpeaker 2: Let me check the schedule.';
    expect(stagingIneligibleReason({ ...baseCall, transcription: raw }, baseExtraction(), leadId)).toBeNull();
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

// ── Gate off: staging/dispatch are a true no-op, but manual-attempt
// housekeeping still runs (codex round-3 P2) ──────────────────────────────
test('gate off: sweep stages and dispatches nothing, but still prunes stale consultation-link attempt rows', async () => {
  isEnabled.mockReturnValue(false);
  const calledTables = [];
  const conn = jest.fn((table) => {
    calledTables.push(table);
    const chain = {};
    ['where', 'limit', 'whereIn'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.select = jest.fn(async () => []);
    chain.del = jest.fn(async () => 0);
    return chain;
  });
  const result = await sweep(conn, { now: new Date() });
  expect(result).toEqual({ staged: 0, ineligible: 0, sent: 0, dispatchSkipped: 0 });
  // The only table this touches is CONSULTATION_ATTEMPT_TABLE (the select-
  // then-delete pair pruneConsultationLinkAttempts issues) — never call_log,
  // leads, or the handoff marker table: nothing may stage, claim or send
  // while the gate is off.
  expect(calledTables).toEqual([CONSULTATION_ATTEMPT_TABLE, CONSULTATION_ATTEMPT_TABLE]);
  isEnabled.mockReturnValue(true);
});

// A pruning failure while the gate is off must not throw — logged and
// swallowed, same as the gate-on housekeeping calls.
test('gate off: a pruning failure is caught and logged, never thrown', async () => {
  isEnabled.mockReturnValue(false);
  const conn = jest.fn(() => { throw new Error('connection reset'); });
  await expect(sweep(conn, { now: new Date() })).resolves.toEqual({ staged: 0, ineligible: 0, sent: 0, dispatchSkipped: 0 });
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('consultation-link attempt housekeeping failed while gate is off'));
  isEnabled.mockReturnValue(true);
});

// codex #5018 r10 P2: sweep()'s own due-row query bounds created_at the
// same way recoverStaleClaims' own SELECT does — see QUEUE_SCAN_LOOKBACK_MS's
// own doc comment. stage()'s own call_log query issues its OWN, SMALLER
// (STAGING_LOOKBACK_DAYS-only) created_at bound first — this test simply
// asserts the LARGER, distinct QUEUE_SCAN_LOOKBACK_MS bound appears
// somewhere among every call_log where() call this sweep tick issues,
// which only the due-query (and recoverStaleClaims' own, tested separately
// above) ever apply.
test('sweep\'s own due-row query bounds created_at to QUEUE_SCAN_LOOKBACK_MS', async () => {
  const now = new Date('2026-09-26T18:00:00Z');
  const wheres = [];
  const conn = jest.fn(() => {
    const chain = {};
    ['whereRaw', 'whereNull', 'whereIn', 'orderBy', 'limit', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.where = jest.fn((...args) => { wheres.push(args); return chain; });
    chain.select = jest.fn(async () => []);
    chain.del = jest.fn(async () => 0); // housekeeping's own bounded DELETE (codex #5018 r13 P1)
    // activationBoundary's own system_settings read/insert, reached via
    // stage() before the due-query this test cares about ever runs —
    // pinned to the epoch so pre_activation never trips.
    chain.first = jest.fn(async () => ({ value: '1970-01-01T00:00:00.000Z' }));
    chain.insert = jest.fn(() => ({ onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) }));
    return chain;
  });
  conn.raw = jest.fn();
  await sweep(conn, { now });
  const bound = wheres.find(([col, op, value]) => col === 'created_at' && op === '>=' && now.getTime() - value.getTime() === QUEUE_SCAN_LOOKBACK_MS);
  expect(bound).toBeTruthy();
});

// codex #5018 r13 P1: housekeeping — every handoff marker row this old has
// long since resolved through recoverAbandonedClaim/recoverStaleClaims, so
// it is never read again; the live sweep prunes it in one bounded DELETE.
test('sweep\'s own housekeeping deletes handoff marker rows older than HANDOFF_MARKER_RETENTION_MS, bounded at DISPATCH_BATCH', async () => {
  const now = new Date('2026-09-26T18:00:00Z');
  const marker = { wheres: [], selectLimit: null, whereInArg: null, deleted: false };
  const conn = jest.fn((table) => {
    const chain = {};
    ['whereRaw', 'whereNull', 'orderBy', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.where = jest.fn((...args) => { if (table === HANDOFF_MARKER_TABLE) marker.wheres.push(args); return chain; });
    chain.limit = jest.fn((n) => { if (table === HANDOFF_MARKER_TABLE) marker.selectLimit = n; return chain; });
    chain.select = jest.fn(async () => []);
    chain.whereIn = jest.fn((col, sub) => { if (table === HANDOFF_MARKER_TABLE) marker.whereInArg = { col, sub }; return chain; });
    chain.del = jest.fn(async () => { marker.deleted = true; return 0; });
    chain.first = jest.fn(async () => ({ value: '1970-01-01T00:00:00.000Z' }));
    chain.insert = jest.fn(() => ({ onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) }));
    return chain;
  });
  conn.raw = jest.fn();
  await sweep(conn, { now });
  const bound = marker.wheres.find(([col, op, value]) => col === 'handoff_started_at' && op === '<' && now.getTime() - value.getTime() === HANDOFF_MARKER_RETENTION_MS);
  expect(bound).toBeTruthy();
  expect(marker.selectLimit).toBe(DISPATCH_BATCH);
  expect(marker.whereInArg.col).toBe('call_log_id');
  expect(marker.deleted).toBe(true);
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
  // codex #5018 r11 P1/P2: every real call_log row has a dialable ANI and,
  // once transcribed, a real transcript — the "otherwise fully eligible"
  // fixtures below need both so the canonical triage-flags merge
  // (caller_phone_missing) and hasRealTwoWayConversation don't false-block
  // them ahead of whatever this test itself is actually proving.
  const STAGE_FROM_PHONE = '+19415550100';
  const STAGE_TWO_WAY_TRANSCRIPT = 'Caller: Hi, I have a bug problem.\nAgent: Sure, let me help with that.\nCaller: Can someone come out this week?\nAgent: Let me check the schedule.';

  function spyingConn() {
    const wheres = [];
    const whereNulls = [];
    const conn = jest.fn(() => {
      const chain = {};
      ['where', 'orderBy', 'limit', 'select', 'whereRaw', 'modify'].forEach((m) => {
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
      ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-recovered', direction: 'inbound', from_phone: STAGE_FROM_PHONE, created_at: new Date(now.getTime() - 60000), duration_seconds: 999999999,
      transcription: STAGE_TWO_WAY_TRANSCRIPT,
      metadata: { lead_id: 'lead-1' },
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { status: 'validated_accept', inServiceArea: true },
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
      ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-555pm', direction: 'inbound', from_phone: STAGE_FROM_PHONE, created_at: new Date('2026-09-26T21:55:00Z'), duration_seconds: 300, // 5:55 PM ET, 5 min
      transcription: STAGE_TWO_WAY_TRANSCRIPT,
      metadata: { lead_id: 'lead-1', source: 'status_callback', inserted_on_status: 'completed' }, // post-call row
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { status: 'validated_accept', inServiceArea: true },
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
      ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-fresh-lead', direction: 'inbound', from_phone: STAGE_FROM_PHONE, created_at: new Date(now.getTime() - 60000), duration_seconds: 90,
      transcription: STAGE_TWO_WAY_TRANSCRIPT,
      metadata: {}, twilio_call_sid: 'CAxxx', // no lead_id stamp — SID-only linkage
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { status: 'validated_accept', inServiceArea: true },
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
      ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
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
      ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-fresh-2', direction: 'inbound', from_phone: STAGE_FROM_PHONE, created_at: new Date(now.getTime() - 60000), duration_seconds: 90,
      transcription: STAGE_TWO_WAY_TRANSCRIPT,
      metadata: {}, twilio_call_sid: 'CAyyy',
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { status: 'validated_accept', inServiceArea: true },
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
      ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.update = jest.fn(async () => 1);
      return chain;
    });
    conn.raw = jest.fn();
    // This IS the first-ever establishment — exactly what a real first
    // cron tick would do too, just via the same MODULE_LOAD_AT anchor.
    const boundary = await activationBoundary(conn);
    expect(boundary.getTime()).toBe(MODULE_LOAD_AT.getTime());

    const call = {
      id: 'call-boot-gap', direction: 'inbound', from_phone: STAGE_FROM_PHONE, created_at: new Date(MODULE_LOAD_AT.getTime() + 60 * 1000), duration_seconds: 90,
      transcription: STAGE_TWO_WAY_TRANSCRIPT,
      metadata: { lead_id: 'lead-1' }, // isolates the boundary check from lead-linkage resolution
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now, boundary);
    expect(decided).toBe('pending'); // NOT skipped as pre_activation
  });

  // codex r6 P2: replaces the removed activation-boundary heartbeat/
  // self-heal mechanism, which could not tell a genuine gate-off interval
  // apart from ordinary worker/deploy downtime. A computed send_at already
  // more than an hour in the past AT STAGING TIME — whatever caused the
  // gap (an off->on re-enable, long downtime, or a backlog) — is skipped
  // outright rather than queued, so re-enabling never bursts a pile of
  // hours-stale texts.
  test('a call whose computed send_at is already hours in the past at staging is skipped stale_at_staging, never queued', async () => {
    const now = new Date('2026-09-26T18:00:00Z'); // 2:00 PM ET
    const conn = jest.fn(() => { const chain = {}; ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); }); chain.update = jest.fn(async () => 1); return chain; });
    const rawBindings = [];
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-off-period', direction: 'inbound', from_phone: STAGE_FROM_PHONE, created_at: new Date('2026-09-26T13:00:00Z'), duration_seconds: 90, // ended ~5h before `now`
      transcription: STAGE_TWO_WAY_TRANSCRIPT,
      metadata: { lead_id: 'lead-1' },
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now, new Date('2020-01-01')); // long-past boundary — never blocks
    expect(decided).toBe('skipped');
    const parsed = rawBindings.map(([json]) => JSON.parse(json)).find((v) => v.call_booking_link_text);
    expect(parsed.call_booking_link_text.reason).toBe('stale_at_staging');
  });

  test('a call from a short (~20 min) gap, whose send_at is still within the hour, stages normally', async () => {
    const now = new Date('2026-09-26T18:00:00Z'); // 2:00 PM ET
    const conn = jest.fn(() => { const chain = {}; ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); }); chain.update = jest.fn(async () => 1); return chain; });
    conn.raw = jest.fn(() => 'RAW');
    const call = {
      id: 'call-short-gap', direction: 'inbound', from_phone: STAGE_FROM_PHONE, created_at: new Date('2026-09-26T15:50:00Z'), duration_seconds: 90, // 2h delay elapsed only ~8.5 min ago
      transcription: STAGE_TWO_WAY_TRANSCRIPT,
      metadata: { lead_id: 'lead-1' },
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now, new Date('2020-01-01'));
    expect(decided).toBe('pending'); // sent on schedule, nothing lost to the cap
  });

  // codex #5018 round-2 P2: computeSendAt's call-end + 2h offset can itself
  // land before the 8 AM ET send window even opens — a call ending at
  // 1 AM ET computes a nominal send_at around 3 AM. The staleness cap must
  // measure from the WINDOW-ADJUSTED first legal send moment (today's 8 AM
  // ET here), never that too-early nominal instant — a 1 AM call staged at
  // 4:30 AM is barely over an hour past the (illegal) 3 AM offset, but
  // more than three hours BEFORE its actual first legal send.
  test('a 1 AM ET call staged at 4:30 AM ET is not stale — its nominal offset is before the window even opens', async () => {
    const now = new Date('2026-09-26T08:30:00Z'); // 4:30 AM ET
    const conn = jest.fn(() => { const chain = {}; ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); }); chain.update = jest.fn(async () => 1); return chain; });
    conn.raw = jest.fn(() => 'RAW');
    const call = {
      id: 'call-1am', direction: 'inbound', from_phone: STAGE_FROM_PHONE, created_at: new Date('2026-09-26T05:00:00Z'), duration_seconds: 90, // 1:00 AM ET, ends ~1:01:30 AM ET
      transcription: STAGE_TWO_WAY_TRANSCRIPT,
      metadata: { lead_id: 'lead-1' },
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now, new Date('2020-01-01'));
    expect(decided).toBe('pending'); // NOT stale_at_staging — the actual first legal send is still hours away
  });

  // The other half of the same fix: a call whose WINDOW-ADJUSTED send time
  // (not its raw nominal offset) is genuinely more than an hour in the past
  // must still be caught as stale — the fix narrows the false positive, it
  // does not disable the cap for early-morning calls.
  test('a 1 AM ET call staged more than an hour past its window-adjusted (8 AM ET) send time is still stale_at_staging', async () => {
    const now = new Date('2026-09-26T13:05:00Z'); // 9:05 AM ET — 65 minutes past the 8 AM ET window open
    const conn = jest.fn(() => { const chain = {}; ['where', 'whereRaw', 'whereNull', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); }); chain.update = jest.fn(async () => 1); return chain; });
    const rawBindings = [];
    conn.raw = jest.fn((sql, bindings) => { rawBindings.push(bindings); return 'RAW'; });
    const call = {
      id: 'call-1am-late', direction: 'inbound', from_phone: STAGE_FROM_PHONE, created_at: new Date('2026-09-26T05:00:00Z'), duration_seconds: 90, // 1:00 AM ET
      transcription: STAGE_TWO_WAY_TRANSCRIPT,
      metadata: { lead_id: 'lead-1' },
      ai_extraction_enriched: {
        meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
        caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
        property: { property_type: 'single_family' },
        service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
        scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
        sentiment_and_lead: { lead_quality: 'warm' },
      },
      ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    };
    const decided = await stageOne(conn, call, now, new Date('2020-01-01'));
    expect(decided).toBe('skipped');
    const parsed = rawBindings.map(([json]) => JSON.parse(json)).find((v) => v.call_booking_link_text);
    expect(parsed.call_booking_link_text.reason).toBe('stale_at_staging');
  });

  test('STAGING_STALE_MS is exactly one hour', () => {
    expect(STAGING_STALE_MS).toBe(60 * 60 * 1000);
  });
});

// ── outbound "return call" evidence ───────────────────────────────────────
// codex #5012 P1: replaced this lane's own first_contact_at comparison with
// the canonical, shared hasPriorContact probe (outbound-call-reason.js) —
// mocked at the module boundary since it always queries the real db
// singleton, never a passed-in conn.
describe('outboundPriorContactMissing / outboundStagingReason', () => {
  const callEnd = new Date('2026-09-26T18:00:00Z');

  // A call with no customer_id never touches conn at all (the customers
  // lookup is inside `if (call.customer_id)`) — throwing proves that.
  function throwingConn() {
    return jest.fn(() => { throw new Error('conn must not be queried without a customer_id'); });
  }
  function customerLookupConn(customerRow) {
    const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), first: jest.fn(async () => customerRow) };
    return jest.fn(() => chain);
  }

  beforeEach(() => { hasPriorContact.mockReset(); });

  test('an inbound call never needs prior-contact evidence — hasPriorContact is never called', async () => {
    expect(await outboundPriorContactMissing(throwingConn(), { direction: 'inbound', created_at: callEnd })).toBe(false);
    expect(hasPriorContact).not.toHaveBeenCalled();
    const reason = await outboundStagingReason(throwingConn(), { direction: 'inbound', created_at: callEnd });
    expect(reason).toBeNull();
    expect(hasPriorContact).not.toHaveBeenCalled();
  });

  test('an outbound call with prior inbound contact proceeds (hasPriorContact resolves true)', async () => {
    hasPriorContact.mockResolvedValue(true);
    const call = { direction: 'outbound', created_at: callEnd, to_phone: '+19415550100' };
    expect(await outboundPriorContactMissing(throwingConn(), call)).toBe(false);
    expect(await outboundStagingReason(throwingConn(), call)).toBeNull();
  });

  test('an outbound call to a manual/cold lead (no prior contact at all) is skipped', async () => {
    hasPriorContact.mockResolvedValue(false);
    const call = { direction: 'outbound', created_at: callEnd, to_phone: '+19415550100' };
    expect(await outboundPriorContactMissing(throwingConn(), call)).toBe(true);
    expect(await outboundStagingReason(throwingConn(), call)).toBe('outbound_without_prior_contact');
  });

  // codex r7 P1: customerId now goes through outboundPriorContactCustomerId
  // (call-recording-processor.js, promoted to a real export) — the
  // ALREADY-FIXED canonical resolver — never customerPredatesThisCall,
  // which has no comparison against the customer ROW'S OWN created_at at
  // all. A customer linked to this call whose OWN row postdates the call
  // (a concurrent web-form signup, a different reprocess, an unrelated
  // later signup on the same number) must NOT count as prior contact just
  // because this call itself didn't mint it.
  test('a customer_id that predates this call (both by provenance AND its own created_at) is passed to hasPriorContact', async () => {
    hasPriorContact.mockResolvedValue(true);
    const predating = { direction: 'outbound', created_at: callEnd, to_phone: '+19415550100', customer_id: 'cust-old', metadata: {} };
    const conn = customerLookupConn({ created_at: new Date('2026-09-01T00:00:00Z') }); // well before callEnd
    await outboundPriorContactMissing(conn, predating);
    expect(hasPriorContact).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-old', phone: '+19415550100' }));
  });

  test('a customer_id THIS call itself minted is never passed, regardless of the customer row\'s own created_at', async () => {
    hasPriorContact.mockResolvedValue(true);
    // The legacy call-created-customer path stamps BOTH customer_id and
    // metadata.created_customer_id in the same transaction — this call
    // itself just minted 'cust-new', so it proves nothing about PRIOR
    // contact and must never be passed to hasPriorContact's own automatic
    // customerId-true branch.
    const mintedNow = { direction: 'outbound', created_at: callEnd, to_phone: '+19415550100', customer_id: 'cust-new', metadata: { created_customer_id: 'cust-new' } };
    const conn = customerLookupConn({ created_at: new Date('2026-09-01T00:00:00Z') }); // predates the call, but excluded anyway
    await outboundPriorContactMissing(conn, mintedNow);
    expect(hasPriorContact).toHaveBeenCalledWith(expect.objectContaining({ customerId: null }));
  });

  // codex r7 P1's own core regression: a customer linked to this call but
  // whose OWN row was created AFTER the call started must not count either,
  // even though it was never created BY this call.
  test('a customer_id NOT minted by this call, but whose own row postdates the call, is still excluded', async () => {
    hasPriorContact.mockResolvedValue(true);
    const call = { direction: 'outbound', created_at: callEnd, to_phone: '+19415550100', customer_id: 'cust-later', metadata: {} };
    const conn = customerLookupConn({ created_at: new Date(callEnd.getTime() + 60 * 1000) }); // created a minute AFTER the call started
    await outboundPriorContactMissing(conn, call);
    expect(hasPriorContact).toHaveBeenCalledWith(expect.objectContaining({ customerId: null }));
  });

  // codex #5018 r15/r16 P1 follow-up: this used to catch the linked
  // customer's own created_at lookup and read a transient failure as "no
  // customerId" — silently proceeding to hasPriorContact and, on that
  // narrowed evidence, potentially stamping the PERMANENT
  // outbound_without_prior_contact skip on nothing but a DB hiccup. Now
  // propagates, exactly like every other prior-contact probe in this
  // describe block (see 'a probe failure PROPAGATES...' below) — never
  // resolves, and hasPriorContact (and so the outbound_without_prior_contact
  // stamp) is never reached at all.
  test('a live-customer lookup failure propagates — never resolved, never stamped outbound_without_prior_contact', async () => {
    hasPriorContact.mockResolvedValue(false);
    const call = { direction: 'outbound', created_at: callEnd, to_phone: '+19415550100', customer_id: 'cust-broken', metadata: {} };
    const conn = jest.fn(() => ({ where: () => ({ whereNull: () => ({ first: async () => { throw new Error('db down'); } }) }) }));
    await expect(outboundPriorContactMissing(conn, call)).rejects.toThrow('db down');
    expect(hasPriorContact).not.toHaveBeenCalled();
    await expect(outboundStagingReason(conn, call)).rejects.toThrow('db down');
  });

  // codex pre-push P1 regression, preserved from the original first_contact_at
  // check: `before` is callStartedAt(call), never the later created_at of a
  // post-call fallback row (Studio Flow's /call-status on a TERMINAL event,
  // or a recording-status recovery insert — call-timeline.js's
  // POST_CALL_ROW_SOURCES).
  test('before is callStartedAt(call), not the later created_at of a post-call fallback row', async () => {
    hasPriorContact.mockResolvedValue(true);
    const created_at = new Date('2026-09-26T18:10:00Z'); // stamped after the call ended
    const duration_seconds = 300; // 5 minutes
    const call = {
      direction: 'outbound', created_at, duration_seconds, to_phone: '+19415550100',
      metadata: { source: 'status_callback', inserted_on_status: 'completed' }, // terminal ⇒ post-call row
    };
    await outboundPriorContactMissing(throwingConn(), call);
    const [[arg]] = hasPriorContact.mock.calls;
    expect(arg.before.getTime()).toBe(created_at.getTime() - duration_seconds * 1000); // NOT created_at itself
  });

  // codex #5018 pre-push P1: hasPriorContact's own probes must run on the
  // SAME connection this caller was handed — during dispatchClaimedCall/
  // neverSendRecheck, that's the phone-locked handoff's own transaction —
  // instead of reaching for the shared pool, which starves under the
  // supported DB_POOL_MAX=2 while a cron lock and a handoff transaction
  // both hold a slot. Real probe-level proof (the actual conn each probe
  // queries through) lives in outbound-call-reason.test.js; this pins the
  // one hop this module owns: outboundPriorContactMissing must forward its
  // OWN `conn` argument into hasPriorContact, never drop it.
  test('outboundPriorContactMissing forwards its own conn into hasPriorContact, never the shared pool', async () => {
    hasPriorContact.mockResolvedValue(true);
    const call = { direction: 'outbound', created_at: callEnd, to_phone: '+19415550100' };
    const heldConnection = customerLookupConn(null);
    await outboundPriorContactMissing(heldConnection, call);
    expect(hasPriorContact).toHaveBeenCalledWith(expect.objectContaining({ conn: heldConnection }));
  });

  // codex #5018 pre-push P1's own core regression: this used to catch a
  // probe failure and read it as "no prior contact" (a PERMANENT skip via
  // outboundStagingReason ⇒ dispatchIneligibleReason ⇒ dispatchClaimedCall's
  // own terminal `skip()`). hasPriorContact no longer swallows an infra
  // failure, so outboundPriorContactMissing must let it propagate — never
  // catch it and return true/false itself — for its callers' own retry
  // rails (sweep()'s per-row catch → recoverAbandonedClaim, stage()'s own
  // per-call catch, neverSendRecheck's own catch) to take over.
  test('a probe failure PROPAGATES out of outboundPriorContactMissing, never resolves', async () => {
    hasPriorContact.mockRejectedValue(new Error('pool timeout'));
    const call = { direction: 'outbound', created_at: callEnd, to_phone: '+19415550100' };
    await expect(outboundPriorContactMissing(throwingConn(), call)).rejects.toThrow('pool timeout');
    await expect(outboundStagingReason(throwingConn(), call)).rejects.toThrow('pool timeout');
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

// ── linkSentRecently: consultation_link_send_attempts scoping (codex #5196) ──
// Query-construction proof on a mocked conn — the real cross-sender,
// rollback-surviving behavior is proven against a real Postgres connection
// in call-booking-link-text-postgres.test.js (the P1/P2 scenarios).
describe('linkSentRecently: consultation_link_send_attempts scoping (codex #5196)', () => {
  const LEAD_ID = 'lead-attempt-1';
  const NOW = new Date('2026-09-28T18:00:00Z');

  function attemptConn({ attemptRow = undefined } = {}) {
    const calls = { whereRaw: [], where: [] };
    const conn = jest.fn((table) => {
      const chain = {};
      ['whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereExists', 'orderBy', 'limit', 'modify', 'forUpdate', 'join', 'select']
        .forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.whereRaw = jest.fn((...args) => { if (table === CONSULTATION_ATTEMPT_TABLE) calls.whereRaw.push(args); return chain; });
      chain.where = jest.fn((...args) => { if (table === CONSULTATION_ATTEMPT_TABLE) calls.where.push(args); return chain; });
      chain.first = jest.fn(async () => (table === CONSULTATION_ATTEMPT_TABLE ? attemptRow : undefined));
      return chain;
    });
    conn.calls = calls;
    return conn;
  }

  // The lane's own 14-day dedupe call (dispatchIneligibleReason, no
  // matchPhone) stays lead-wide — "has ANY current number for this lead
  // already gotten this link."
  test('lead-wide (no matchPhone): scoped by lead_id + started_at only, never phone-scoped', async () => {
    const conn = attemptConn();
    await linkSentRecently(conn, LEAD_ID, NOW);
    expect(conn.calls.where).toEqual(expect.arrayContaining([['lead_id', LEAD_ID]]));
    expect(conn.calls.whereRaw).toEqual([]); // no phone scope applied to the attempts table
  });

  // codex #5196 P2: the manual guards pass matchPhone — an attempt to
  // phone A must never block a send to a DIFFERENT phone B for the same
  // lead (the exact false refusal the old lead-wide handoff join produced).
  test('matchPhone with a full NANP number scopes the attempts query to that destination', async () => {
    const conn = attemptConn();
    await linkSentRecently(conn, LEAD_ID, NOW, { matchPhone: '+19415550111' });
    expect(conn.calls.whereRaw).toHaveLength(1);
    expect(conn.calls.whereRaw[0][1]).toEqual(['9415550111']);
  });

  // An international/partial number never NANP-matches 10 digits — the
  // same fallback applyPhoneScope already uses for sms_log.to_phone.
  test('a non-10-digit matchPhone key is never applied as a phone scope', async () => {
    const conn = attemptConn();
    await linkSentRecently(conn, LEAD_ID, NOW, { matchPhone: '+442071234567' });
    expect(conn.calls.whereRaw).toEqual([]);
  });

  test('a recent attempt row (within the window) short-circuits the whole check to true', async () => {
    const conn = attemptConn({ attemptRow: { id: 1 } });
    await expect(linkSentRecently(conn, LEAD_ID, NOW)).resolves.toBe(true);
  });

  test('no attempt row falls through to the sms_log/short-code checks (still false when those are empty too)', async () => {
    const conn = attemptConn({ attemptRow: undefined });
    await expect(linkSentRecently(conn, LEAD_ID, NOW)).resolves.toBe(false);
  });

  // windowMs bounds `started_at >= since` — rows outside the passed window
  // are never even matched by the WHERE clause a real Postgres connection
  // would send (the mocked chain can't prove the boundary itself; that
  // proof is the Postgres suite's own "rows outside window ignored" case).
  test('the started_at filter uses `since` derived from windowMs, not the default 14-day window', async () => {
    const conn = attemptConn();
    const windowMs = 10 * 60 * 1000;
    await linkSentRecently(conn, LEAD_ID, NOW, { windowMs });
    const sinceCall = conn.calls.where.find(([col]) => col === 'started_at');
    expect(sinceCall[2].getTime()).toBe(NOW.getTime() - windowMs);
  });
});

// ── smsDeclinedOnEarlierCall — codex P1 on #5292 ──────────────────────────
// The dedicated consent.sms_declined check (STAGING_CHECKS) judges only the
// CURRENT call's own extraction — a caller who declined on an EARLIER call
// then makes a later, eligible call where texting is never discussed would
// otherwise read as clear. Query-construction proof on a mocked conn, same
// idiom as the linkSentRecently/neverSendRecheck suites above — the real
// cross-call SQL behavior against a live Postgres connection is proven in
// call-booking-link-text-postgres.test.js.
describe('smsDeclinedOnEarlierCall', () => {
  const { smsDeclinedOnEarlierCall } = _private;
  const PHONE = '+19415550100';
  const ORIGIN_CALL_ID = 'call-current';
  const AS_OF = new Date('2026-09-28T18:00:00Z');

  // Builds a mocked call_log query chain that answers `.first(...)` with
  // `row` regardless of which where/whereRaw/orderBy calls preceded it —
  // the real filtering (phone match, v2_extraction_status, created_at,
  // the decisive-consent OR, ORDER BY) is SQL the Postgres suite proves;
  // this suite proves the function's OWN interpretation of whatever the
  // query hands back, plus the bindings it sends for the phone scope.
  function declineConn(row) {
    const raws = [];
    const chain = {};
    ['where', 'orWhere', 'whereNot'].forEach((m) => {
      chain[m] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0](chain);
        return chain;
      });
    });
    ['whereRaw', 'orWhereRaw'].forEach((m) => {
      chain[m] = jest.fn((...args) => { raws.push(args); return chain; });
    });
    chain.orderBy = jest.fn(() => chain);
    chain.modify = jest.fn((fn) => { fn(chain); return chain; });
    chain.first = jest.fn(async () => row);
    const conn = jest.fn(() => chain);
    conn.raws = raws;
    return conn;
  }

  test('an earlier decisive call that declined blocks', async () => {
    const conn = declineConn({ ai_extraction_enriched: { consent: { sms_declined: true, sms_consent_given: false } } });
    await expect(smsDeclinedOnEarlierCall(conn, PHONE, { originCallId: ORIGIN_CALL_ID, asOf: AS_OF })).resolves.toBe(true);
  });

  // OWNER RULING 2026-09-29: a later opt-in never clears an earlier decline.
  // The query asks only for declines, never for opt-ins, so there is no
  // "most recent decisive row" for an opt-in to win.
  test('the query asks only for declines — a later opt-in cannot clear one', async () => {
    const conn = declineConn({ ai_extraction_enriched: { consent: { sms_declined: true, sms_consent_given: true } } });
    await expect(smsDeclinedOnEarlierCall(conn, PHONE, { originCallId: ORIGIN_CALL_ID, asOf: AS_OF })).resolves.toBe(true);
    const sql = conn.raws.map((args) => String(args[0])).join(' ');
    expect(sql).toContain("->>'sms_declined' = 'true'");
    expect(sql).not.toContain('sms_consent_given');
  });

  test('no earlier decisive call at all does not block', async () => {
    const conn = declineConn(undefined);
    await expect(smsDeclinedOnEarlierCall(conn, PHONE, { originCallId: ORIGIN_CALL_ID, asOf: AS_OF })).resolves.toBe(false);
  });

  // A decline recorded against a DIFFERENT phone is never this phone's
  // concern — the query itself scopes to `phone` via nanpStoredPhoneClause,
  // so a mocked "no row for this phone" answer (the SAME shape as "no
  // earlier decisive call") is the correct behavior here; the bindings
  // assertion below proves this phone's own key is what actually reaches
  // the matcher, not some other number's.
  test('a decline on another phone does not block — the query is scoped to this phone', async () => {
    const conn = declineConn(undefined); // simulates the real query finding nothing for THIS phone
    await expect(smsDeclinedOnEarlierCall(conn, PHONE, { originCallId: ORIGIN_CALL_ID, asOf: AS_OF })).resolves.toBe(false);
    const { phoneIdentityKey } = require('../utils/phone');
    const expectedKey = phoneIdentityKey(PHONE);
    expect(conn.raws.some(([, bindings]) => Array.isArray(bindings) && bindings[0] === expectedKey)).toBe(true);
  });

  test('an unusable phone (too short / missing) never queries at all', async () => {
    const conn = declineConn(undefined);
    await expect(smsDeclinedOnEarlierCall(conn, null, { originCallId: ORIGIN_CALL_ID, asOf: AS_OF })).resolves.toBe(false);
    await expect(smsDeclinedOnEarlierCall(conn, '555', { originCallId: ORIGIN_CALL_ID, asOf: AS_OF })).resolves.toBe(false);
    expect(conn).not.toHaveBeenCalled();
  });

  test('the origin call id joins the phone match via orWhere, when given', async () => {
    const conn = declineConn(undefined);
    await smsDeclinedOnEarlierCall(conn, PHONE, { originCallId: ORIGIN_CALL_ID, asOf: AS_OF });
    const orWhereCall = conn.mock.results[0].value.orWhere.mock.calls.find(([col]) => col === 'id');
    expect(orWhereCall).toEqual(['id', ORIGIN_CALL_ID]);
  });
});

// ── neverSendRecheck — the providerPreSendCheck hook ──────────────────────
// codex r2 P2: re-runs the MUTABLE never-send predicates on the connection
// send-customer-message.js hands this callback, right before Twilio's own
// messages.create() — never this module's own outer `conn`.
describe('neverSendRecheck', () => {
  const CALL_FOR_RECHECK = { id: 'call-1', created_at: new Date('2026-09-26T15:30:00Z'), direction: 'inbound', from_phone: '+19415550100' };
  const DESTINATION = '+19415550100'; // matches CALL_FOR_RECHECK's own ANI — consent isolated from these tests' own concerns
  const OPEN = { id: 'lead-1', status: 'new', converted_at: null, estimate_id: null, customer_id: null, deleted_at: null, phone: DESTINATION };
  // codex #5018 r13 P1: neverSendRecheck now reloads + locks call_log too —
  // a fully eligible default row (dialable ANI, a real two-way transcript,
  // a populated address, not mid-reprocess, linked to the SAME lead every
  // test here uses) so every test not specifically exercising THAT reload
  // still resolves { ok: true } same as before.
  const FRESH_TRANSCRIPT = 'Caller: Hi, I have a bug problem.\nAgent: Sure, let me help with that.\nCaller: Can someone come out this week?\nAgent: Let me check the schedule.';
  const FRESH_CALL_LOG = {
    id: 'call-1', direction: 'inbound', from_phone: '+19415550100', duration_seconds: 90,
    processing_token: null, v2_extraction_status: 'valid', transcription: FRESH_TRANSCRIPT,
    metadata: { lead_id: 'lead-1' },
    ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    ai_extraction_enriched: {
      meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
      caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
      property: { property_type: 'single_family', service_address: { street_line_1: '123 Main St', city: 'Bradenton', postal_code: '34205' } },
      service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
      scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
      sentiment_and_lead: { lead_quality: 'warm' },
    },
  };

  // earlierDeclineCall (codex P1 on #5292): the row smsDeclinedOnEarlierCall's
  // OWN plain (un-locked) call_log query answers with, distinct from the
  // call_log FOR UPDATE reload above (freshCall) — both query the same
  // table, on the same mocked conn, so the chain distinguishes them by
  // whether THIS chain instance's own .forUpdate() was ever called (a new
  // chain object is built per conn(table) invocation, so the two queries
  // never share one). Defaults to freshCall, so every existing test that
  // never overrides it keeps seeing the SAME row either way, as before.
  function dbi({
    lead = OPEN, bookedSince = null, smsWithLink = null, freshCall = FRESH_CALL_LOG, earlierDeclineCall = freshCall,
  } = {}) {
    const conn = jest.fn((table) => {
      const chain = {};
      // codex #5018 P2: 'select' chains here like every other builder call —
      // linkSentRecently's own long-form fallback (`.select('sms_log.message_body')`)
      // then awaits the plain chain object itself; its `.length` is
      // undefined, so `!longFormCandidates.length` is true and it returns
      // `false` (no long-form candidates) without ever needing an array —
      // the SAME safe default every no-match path here already assumes.
      ['where', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'whereExists', 'orderBy', 'limit', 'modify', 'join', 'select']
        .forEach((m) => { chain[m] = jest.fn(() => chain); });
      let callLogLocked = false;
      chain.forUpdate = jest.fn(() => { callLogLocked = true; return chain; });
      chain.first = jest.fn(async () => {
        if (table === 'leads') return lead;
        if (table === 'scheduled_services') return bookedSince;
        if (table === 'sms_log') return smsWithLink;
        if (table === 'call_log') return callLogLocked ? freshCall : earlierDeclineCall;
        return undefined;
      });
      chain.pluck = jest.fn(async () => []);
      chain.update = jest.fn(async () => 1);
      // The handoff marker (codex #5018 r13 P1) is an INSERT ... ON
      // CONFLICT DO NOTHING on its own table, never an UPDATE on call_log.
      chain.insert = jest.fn(() => ({ onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) }));
      return chain;
    });
    conn.raw = jest.fn(() => 'RAW');
    // The handoff marker (codex #5018 r13 P1, migration 20260927160000)
    // writes through markerDb(), never dbi/call_log itself — pointed at
    // this SAME conn so it still lands somewhere these tests can observe.
    markerDb.mockReturnValue(conn);
    return conn;
  }

  test('an open lead with no estimate, not booked, no recent link: ok', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    await expect(check({ dbi: dbi() })).resolves.toEqual({ ok: true });
  });

  // codex #5018 r12 P1: the lead read must be locked FOR UPDATE, on dbi —
  // the SAME connection the phone-locked handoff already holds — so a
  // concurrent phone correction (admin-leads.js's own forUpdate write)
  // waits until this whole handoff finishes instead of landing in the gap
  // before messages.create(). Real lock-collision proof (a mocked knex
  // cannot prove a lock is genuinely held) lives in
  // call-booking-link-text-postgres.test.js.
  test('the leads read is locked FOR UPDATE, on the same connection the handoff holds', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi();
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: true });
    const leadsCallIndex = conn.mock.calls.findIndex(([table]) => table === 'leads');
    expect(leadsCallIndex).toBeGreaterThanOrEqual(0);
    expect(conn.mock.results[leadsCallIndex].value.forUpdate).toHaveBeenCalled();
  });

  // codex #5018 r13 P1: call_log gets the SAME treatment, LOCKED AFTER
  // leads — the established processor order (see the service file's own
  // doc comment for the file:line evidence), never reversed.
  test('the call_log read is ALSO locked FOR UPDATE, taken AFTER the leads lock', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi();
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: true });
    const leadsCallIndex = conn.mock.calls.findIndex(([table]) => table === 'leads');
    const callLogCallIndex = conn.mock.calls.findIndex(([table]) => table === 'call_log');
    expect(leadsCallIndex).toBeGreaterThanOrEqual(0);
    expect(callLogCallIndex).toBeGreaterThan(leadsCallIndex); // leads BEFORE call_log
    expect(conn.mock.results[callLogCallIndex].value.forUpdate).toHaveBeenCalled();
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

  // codex #5018 r10 P2: re-checked on the freshest possible read, the same
  // reason every other check on this hook exists — a manual merge into an
  // existing customer can land in the gap between dispatchIneligibleReason's
  // own earlier check and the actual provider request.
  test('a lead newly linked to an existing customer blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    await expect(check({ dbi: dbi({ lead: { ...OPEN, customer_id: 'cust-existing' } }) })).resolves.toEqual({ ok: false, code: 'existing_customer' });
  });

  test('a lead linked to a customer THIS call itself created (created_customer_id exception) still passes', async () => {
    const callWithOwnCustomer = { ...CALL_FOR_RECHECK, metadata: { created_customer_id: 'cust-new' } };
    const check = neverSendRecheck(callWithOwnCustomer, 'lead-1', DESTINATION);
    await expect(check({ dbi: dbi({ lead: { ...OPEN, customer_id: 'cust-new' } }) })).resolves.toEqual({ ok: true });
  });

  // codex #5018 r10 P2: a commercial correction can land in the same gap.
  test('a lead corrected to commercial since dispatch blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    await expect(check({ dbi: dbi({ lead: { ...OPEN, is_commercial: true } }) })).resolves.toEqual({ ok: false, code: 'commercial_lead' });
  });

  // codex r6 P1: staff correcting the phone in the gap between
  // dispatchClaimedCall's own earlier phone_changed_before_send check and
  // this hook (the actual last check before messages.create()) would
  // otherwise deliver the minted bearer link to a number this lead no
  // longer owns — worse than losing the send, since the token exposes the
  // lead's current name/address to whoever holds that number now. Terminal
  // (no retryable flag) — never resent to the OLD number, and a human can
  // always text the corrected one by hand.
  test('a phone corrected since the token was minted blocks the send with phone_changed_before_send, terminally', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const corrected = dbi({ lead: { ...OPEN, phone: '+19415559999' } });
    await expect(check({ dbi: corrected })).resolves.toEqual({ ok: false, code: 'phone_changed_before_send' });
  });

  test('the SAME phone in a differently-formatted string (canonical identity, not a raw match) still passes', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const sameNumberDifferentFormat = dbi({ lead: { ...OPEN, phone: '(941) 555-0100' } });
    await expect(check({ dbi: sameNumberDifferentFormat })).resolves.toEqual({ ok: true });
  });

  // codex #5018 r14 P1: consentedDestination's EARLIER check (this hook's
  // own opening lines) judges the STALE `call` — a reprocess can correct
  // the spoken alternate number or withdraw its explicit sms_consent_given
  // (to undefined or false — stagingIneligibleReason never judges the
  // destination number itself) between that
  // check and this hook's own call_log reload. Sending on stale consent
  // evidence would violate the TCPA-consent-before-SMS invariant, so the
  // SAME check must re-run against the FRESH row too.
  test('consent for a spoken alternate destination withdrawn on reprocess blocks the send, even though the earlier (stale) check passed', async () => {
    const SPOKEN_DESTINATION = '+19415559999'; // never the ANI — only the spoken-number consent branch can cover it
    const callWithSpokenConsent = {
      ...CALL_FOR_RECHECK,
      ai_extraction_enriched: { caller: { phone_e164: SPOKEN_DESTINATION }, consent: { sms_consent_given: true } },
    };
    const check = neverSendRecheck(callWithSpokenConsent, 'lead-1', SPOKEN_DESTINATION);
    const withdrawnConsent = {
      ...FRESH_CALL_LOG,
      ai_extraction_enriched: {
        ...FRESH_CALL_LOG.ai_extraction_enriched,
        caller: { ...FRESH_CALL_LOG.ai_extraction_enriched.caller, phone_e164: SPOKEN_DESTINATION },
        // Withdrawn to undefined, not `false` — never trips the earlier,
        // broader sms_consent_refused staging check, which is the whole
        // point: this narrower recheck must catch it independently.
        consent: { ...FRESH_CALL_LOG.ai_extraction_enriched.consent, sms_consent_given: undefined },
      },
    };
    const conn = dbi({ lead: { ...OPEN, phone: SPOKEN_DESTINATION }, freshCall: withdrawnConsent });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'destination_not_consented' });
  });

  test('consent for a spoken alternate destination still explicit on the fresh row proceeds', async () => {
    const SPOKEN_DESTINATION = '+19415559999';
    const callWithSpokenConsent = {
      ...CALL_FOR_RECHECK,
      ai_extraction_enriched: { caller: { phone_e164: SPOKEN_DESTINATION }, consent: { sms_consent_given: true } },
    };
    const check = neverSendRecheck(callWithSpokenConsent, 'lead-1', SPOKEN_DESTINATION);
    const stillConsented = {
      ...FRESH_CALL_LOG,
      ai_extraction_enriched: {
        ...FRESH_CALL_LOG.ai_extraction_enriched,
        caller: { ...FRESH_CALL_LOG.ai_extraction_enriched.caller, phone_e164: SPOKEN_DESTINATION },
        consent: { ...FRESH_CALL_LOG.ai_extraction_enriched.consent, sms_consent_given: true },
      },
    };
    const conn = dbi({ lead: { ...OPEN, phone: SPOKEN_DESTINATION }, freshCall: stillConsented });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: true });
  });

  // codex #5018 r15 P1: stagingIneligibleReason's own table never
  // re-derives outbound eligibility — outboundStagingReason is a SEPARATE
  // staging-only check dispatchIneligibleReason already ran once, against
  // the (by-then already stale) call. The evidence itself (a prior
  // qualifying inbound call/text, or a non-call customer-originated lead)
  // can be reassigned to a DIFFERENT lead by a concurrent merge/correction
  // in the gap between that check and this hook's own reload — re-deriving
  // it fresh here, against the FRESH row, closes that race.
  test('outbound prior-contact evidence withdrawn on reprocess blocks the send, even though the earlier (stale) check passed', async () => {
    const outboundCall = { ...CALL_FOR_RECHECK, direction: 'outbound' };
    const check = neverSendRecheck(outboundCall, 'lead-1', DESTINATION);
    hasPriorContact.mockResolvedValueOnce(false); // withdrawn by the time THIS hook's own probe runs
    const conn = dbi({ freshCall: { ...FRESH_CALL_LOG, direction: 'outbound' } });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'outbound_without_prior_contact' });
  });

  test('an outbound call still confirmed against the fresh row proceeds', async () => {
    const outboundCall = { ...CALL_FOR_RECHECK, direction: 'outbound' };
    const check = neverSendRecheck(outboundCall, 'lead-1', DESTINATION);
    hasPriorContact.mockResolvedValueOnce(true);
    const conn = dbi({ freshCall: { ...FRESH_CALL_LOG, direction: 'outbound' } });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: true });
  });

  // codex #5018 pre-push P1: hasPriorContact no longer swallows an infra
  // failure into "no prior contact" — an uncaught throw here must land in
  // THIS function's own outer catch (already returns a retryable refusal
  // for any uncaught throw, see the "transient DB failure" test above),
  // never resolve as the permanent `outbound_without_prior_contact` block
  // the negative-answer test above proves.
  test('an infra failure in the outbound-prior-contact probe is a retryable refusal, never the permanent outbound_without_prior_contact block', async () => {
    const outboundCall = { ...CALL_FOR_RECHECK, direction: 'outbound' };
    const check = neverSendRecheck(outboundCall, 'lead-1', DESTINATION);
    hasPriorContact.mockRejectedValueOnce(new Error('pool timeout'));
    const conn = dbi({ freshCall: { ...FRESH_CALL_LOG, direction: 'outbound' } });
    await expect(check({ dbi: conn })).resolves.toEqual({
      ok: false, retryable: true, code: 'never_send_recheck_failed', reason: 'pool timeout',
    });
  });

  test('booked since the call started blocks the send', async () => {
    // metadata.created_customer_id matches the lead's customer_id — THIS
    // call's own legacy path minted it, isolating this test from the new
    // existing_customer check (codex #5018 r10 P2) so it still exercises
    // booked_since_call specifically.
    const callWithOwnCustomer = { ...CALL_FOR_RECHECK, metadata: { created_customer_id: 'cust-1' } };
    const check = neverSendRecheck(callWithOwnCustomer, 'lead-1', DESTINATION);
    const conn = dbi({ lead: { ...OPEN, customer_id: 'cust-1' }, bookedSince: { id: 'visit-1' } });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'booked_since_call' });
  });

  // codex #5018 r15 P2: staff quick-adding a customer straight from the
  // appointment modal, without ever linking this lead, books a real visit
  // the customer_id check above can never see (lead.customer_id stays
  // null). Matched instead by the lead's own phone against that new
  // customer's stored phone.
  test('booked through a customer staff quick-added, never linked to this lead, still blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi({ lead: { ...OPEN, customer_id: null }, bookedSince: { id: 'visit-unlinked' } });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'booked_since_call' });
  });

  // codex P1 on #5292: wiring proof — the send-time recheck must also catch
  // a decline spoken on an EARLIER call for this phone, not only the
  // CURRENT call's own extraction (FRESH_CALL_LOG, unchanged here, carries
  // sms_declined: false — this block comes from the OTHER call entirely).
  test('a decline on an earlier call for this phone blocks the send at recheck time', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi({ earlierDeclineCall: { ai_extraction_enriched: { consent: { sms_declined: true } } } });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'sms_declined_earlier_call' });
  });

  test('a link delivered in the last 14 days blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi();
    conn.mockImplementation((table) => {
      const chain = {};
      ['where', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'whereExists', 'orderBy', 'limit', 'modify', 'forUpdate', 'join', 'select']
        .forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.first = jest.fn(async () => {
        if (table === 'leads') return OPEN;
        if (table === 'sms_log') return { id: 'sms-1' };
        if (table === 'call_log') return FRESH_CALL_LOG;
        return undefined;
      });
      chain.pluck = jest.fn(async () => (table === 'short_codes' ? ['abcd'] : []));
      return chain;
    });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'link_sent_recently' });
  });

  // codex #5018 r13 P1: a forced reprocess can claim call_log.processing_token
  // AFTER dispatchIneligibleReason ran, while this handoff is already in
  // flight — an in-flight reprocess is a reason to WAIT (retryable), never
  // a permanent block, mirroring dispatchClaimedCall's own pre-handoff
  // readiness check.
  test('a reprocess claim (processing_token set) between dispatch and handoff blocks the send, retryably', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi({ freshCall: { ...FRESH_CALL_LOG, processing_token: 'reprocess-tok' } });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, retryable: true, code: 'call_reprocessing' });
  });

  test('a reprocess reset (v2_extraction_status null) between dispatch and handoff blocks the send, retryably', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi({ freshCall: { ...FRESH_CALL_LOG, v2_extraction_status: null } });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, retryable: true, code: 'call_reprocessing' });
  });

  // codex #5018 r13 P1: a completed reprocess whose extraction now reads
  // low-confidence, commercial, or any other blocking/excluded flag must
  // still catch the send — the canonical merge (finalTriageFlagsFor, folded
  // into stagingIneligibleReason's own last entry) is re-run against the
  // FRESH row, not the stale one dispatchIneligibleReason already cleared.
  test('a fresh extraction now low-confidence (no model flags) blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const reclassified = {
      ...FRESH_CALL_LOG,
      ai_extraction_enriched: { ...FRESH_CALL_LOG.ai_extraction_enriched, confidence: { overall: 0.2 } },
    };
    const conn = dbi({ freshCall: reclassified });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'triage_flag_low_extraction_confidence' });
  });

  test('a fresh extraction now commercial blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const reclassified = {
      ...FRESH_CALL_LOG,
      ai_extraction_enriched: { ...FRESH_CALL_LOG.ai_extraction_enriched, property: { property_type: 'commercial' } },
    };
    const conn = dbi({ freshCall: reclassified });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'not_residential' });
  });

  // codex #5018 r13 P1: an attribution correction/merge landing in the same
  // gap must skip rather than send under a linkage this dispatch was never
  // judged against (mirrors dispatchClaimedCall's own pre-handoff check).
  test('the lead linkage rewritten on the fresh call_log row between dispatch and handoff blocks the send', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const relinked = { ...FRESH_CALL_LOG, metadata: { lead_id: 'lead-2' } };
    const conn = dbi({ freshCall: relinked });
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: false, code: 'lead_linkage_changed' });
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

  // codex #5018 r15 P1: neverSendRecheck (invoked as providerPreSendCheck)
  // no longer writes the handoff marker itself at all — that write moved to
  // onDispatchStart, twilio.js's own REAL attempt boundary, immediately
  // before dispatchStarted flips true and messages.create() runs, AFTER
  // disclaimedNumberBlocksSend/preSendCheck.isStillValid have also cleared.
  // Marking here left exactly that gap uncovered. See the
  // 'handoff_started_at is stamped right before the provider call' describe
  // block (under dispatchClaimedCall) for the marker's own coverage.
  test('never writes the handoff marker itself, even though dbi/call_log is held FOR UPDATE for the rest of this handoff', async () => {
    const check = neverSendRecheck(CALL_FOR_RECHECK, 'lead-1', DESTINATION);
    const conn = dbi();
    await expect(check({ dbi: conn })).resolves.toEqual({ ok: true });
    expect(markerDb).not.toHaveBeenCalled();
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
    // A genuine 4-turn, 2-speaker exchange (codex #5018 r11 P2) — every
    // dispatchClaimedCall test in this describe is otherwise-eligible by
    // default, and hasRealTwoWayConversation is re-run at dispatch through
    // DISPATCH_CHECKS' own stagingIneligibleReason recheck.
    transcription: 'Caller: Hi, I have a bug problem.\nAgent: Sure, let me help with that.\nCaller: Can someone come out this week?\nAgent: Let me check the schedule.',
    v2_extraction_status: 'valid', processing_token: null,
    metadata: { lead_id: 'lead-1', call_booking_link_text: { status: 'claimed', lead_id: 'lead-1', send_at: NOW.toISOString() } },
    ai_extraction_enriched: {
      meta: {}, call_nature: 'new_lead', recommended_disposition: 'lead_response_flow_triggered', triage_flags: [],
      caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
      property: { property_type: 'single_family' },
      service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week' },
      scheduling: { status: 'requested' }, consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
      sentiment_and_lead: { lead_quality: 'warm' },
    },
    ai_address_validation: { status: 'validated_accept', inServiceArea: true } };
  const OPEN_LEAD = { id: 'lead-1', status: 'new', converted_at: null, phone: '+19415550100', first_name: 'Jamie',
    customer_id: null, estimate_id: null, is_commercial: false, deleted_at: null };

  // `visitCreatedAt`, when given, makes the scheduled_services stub a REAL
  // comparison against whatever lower-bound date the code under test
  // actually queries with (captured via the `where('created_at', '>=', X)`
  // call) — rather than a canned true/false — so a test can prove the bound
  // is callStartedAt(call) and not some other instant. `bookedSince` (a
  // canned row/null) still works for tests that don't care about the exact
  // bound.
  // codex #5018 r13 P1: neverSendRecheck now reloads + locks call_log too —
  // CALL itself is already a fully eligible default row, so reloading it
  // unchanged keeps every test below resolving exactly as before unless it
  // explicitly overrides `freshCall`.
  // earlierDeclineCall (codex P1 on #5292): the row DISPATCH_CHECKS' OWN
  // plain (un-locked) call_log query for smsDeclinedOnEarlierCall answers
  // with — distinct from the call_log FOR UPDATE reload neverSendRecheck
  // would do later (never reached here since sendCustomerMessage is
  // mocked), distinguished the same way dbi() above does, for consistency.
  // Defaults to freshCall, so every existing test keeps seeing the SAME row.
  function makeDb({ lead = OPEN_LEAD, bookedSince = null, visitCreatedAt = null, consultationCodes = [], smsWithLink = null,
    callLogUpdate = jest.fn(async () => 1), activityInsert = jest.fn(async () => {}), capture = {}, freshCall = CALL,
    earlierDeclineCall = freshCall,
    markerInsert = jest.fn(() => ({ onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) })),
    markerDel = jest.fn(async () => 1),
    // codex #5196: the shared consultation_link_send_attempts row — the
    // automated lane's own onDispatchStart INSERTs it in the SAME markerDb()
    // transaction as the handoff marker (insertConsultationLinkAttempt's
    // own `.insert(...).returning('id')` shape, unlike the marker's plain
    // ON CONFLICT DO NOTHING insert).
    consultationAttemptInsert = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'attempt-mock-1' }]) })),
    // codex #5018 r15/r16 P1 follow-up: withSmsHandoff's phone-match
    // customer lookup, called TWICE per handoff (once before locks, once as
    // the post-lock re-check) — a plain array default keeps every existing
    // test's two calls identical (never widened); a test proving the
    // widened-set defer supplies a stateful function instead.
    customersPluck = jest.fn(async () => []) } = {}) {
    const conn = jest.fn((table) => {
      const chain = {};
      ['whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'whereExists', 'orderBy', 'limit', 'modify', 'join', 'select']
        .forEach((m) => { chain[m] = jest.fn(() => chain); });
      let callLogLocked = false;
      chain.forUpdate = jest.fn(() => { callLogLocked = true; return chain; });
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
        if (table === 'call_log') return callLogLocked ? freshCall : earlierDeclineCall;
        return undefined;
      });
      chain.pluck = jest.fn(async () => {
        if (table === 'short_codes') return consultationCodes;
        if (table === 'customers') return customersPluck();
        return [];
      });
      chain.update = table === 'call_log' ? callLogUpdate : jest.fn(async () => 1);
      // The handoff marker (codex #5018 r13 P1) INSERTs into its own table,
      // never call_log — activity_log keeps its own dedicated insert stub.
      // consultation_link_send_attempts (codex #5196) gets its own too —
      // its insert chain ends in `.returning('id')`, never ON CONFLICT.
      chain.insert = table === 'activity_log' ? activityInsert
        : table === HANDOFF_MARKER_TABLE ? markerInsert
          : table === CONSULTATION_ATTEMPT_TABLE ? consultationAttemptInsert
            : jest.fn(async () => {});
      // codex #5018 pre-push P1 (round 3): recordSendOutcome's own stale-
      // marker cleanup DELETEs from this same table on a definitely
      // retryable outcome. consultation_link_send_attempts (codex #5196)
      // is cleared alongside it — no dedicated tracking needed by default,
      // the generic no-op below is enough unless a test opts in.
      chain.del = table === HANDOFF_MARKER_TABLE ? markerDel : jest.fn(async () => 0);
      return chain;
    });
    conn.raw = jest.fn(() => 'RAW_FRAGMENT');
    // codex #5018 r11 P1: dispatchClaimedCall's withSmsHandoff opens
    // conn.transaction — mirrors a real knex instance closely enough
    // (calling the passed-in callback with the same connection as its
    // "trx") for lockSmsPhone's own trx.raw call above to work unmocked.
    conn.transaction = jest.fn(async (fn) => fn(conn));
    // The handoff marker (codex #5018 r13 P1, migration 20260927160000)
    // INSERTs through markerDb(), never dbi/conn/call_log itself — pointed
    // at this SAME conn by default so every ordinary test here still
    // observes it via markerInsert. Tests that need to prove the marker's
    // OWN independence from a rolled-back dbi override this explicitly.
    markerDb.mockReturnValue(conn);
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

  // OWNER RULING 2026-09-28: no_sms_consent_captured alone no longer blocks
  // this transactional follow-up, sent only to the consented ANI
  // destination — CALL.from_phone === OPEN_LEAD.phone here, the ANI path
  // consentedDestination grants on implied consent alone.
  test('no_sms_consent_captured whose destination is the ANI is staged and sent (owner ruling 2026-09-28)', async () => {
    const withFlag = { ...CALL, ai_extraction_enriched: { ...CALL.ai_extraction_enriched, triage_flags: ['no_sms_consent_captured'] } };
    const conn = makeDb({ freshCall: withFlag });
    const result = await dispatchClaimedCall(conn, withFlag, NOW);
    expect(result.sent).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  // Contrast: an explicit do_not_contact_requested triage flag still blocks
  // — every OTHER block in EXCLUDED_TRIAGE_FLAGS is unaffected by the
  // removal above.
  test('the same caller with do_not_contact_requested is not sent', async () => {
    const withFlag = { ...CALL, ai_extraction_enriched: { ...CALL.ai_extraction_enriched, triage_flags: ['do_not_contact_requested'] } };
    const conn = makeDb({ freshCall: withFlag });
    const result = await dispatchClaimedCall(conn, withFlag, NOW);
    expect(result.skipped).toBe('triage_flag_do_not_contact_requested');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
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

  // codex #5018 r10 P2: a lead can be open (no customer_id) at STAGING
  // time and get linked to an existing customer afterward — a manual
  // merge, a different call, or this same call's own later reprocessing —
  // before DISPATCH ever runs. Re-checked fresh here, never trusted from
  // the staged decision.
  test('a lead newly linked to an existing customer since staging blocks the send', async () => {
    const conn = makeDb({ lead: { ...OPEN_LEAD, customer_id: 'cust-existing' } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('existing_customer');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a lead linked to a customer THIS call itself created (created_customer_id exception) still sends', async () => {
    const callWithOwnCustomer = { ...CALL, metadata: { ...CALL.metadata, created_customer_id: 'cust-new' } };
    const conn = makeDb({ lead: { ...OPEN_LEAD, customer_id: 'cust-new' } });
    const result = await dispatchClaimedCall(conn, callWithOwnCustomer, NOW);
    expect(result.sent).toBe(true);
  });

  test('a cold outbound call (no prior inbound contact) blocks the send', async () => {
    hasPriorContact.mockResolvedValue(false);
    const outboundCall = { ...CALL, direction: 'outbound' };
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, outboundCall, NOW);
    expect(result.skipped).toBe('outbound_without_prior_contact');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // codex #5018 pre-push P1: a genuine probe failure (a starved connection
  // pool under DB_POOL_MAX=2, not a real "no prior contact" answer) must
  // never resolve as the terminal `outbound_without_prior_contact` skip
  // above — dispatchClaimedCall has no try/catch of its own around
  // dispatchIneligibleReason, so this propagates out to sweep()'s own
  // per-row catch, which hands it to recoverAbandonedClaim (no handoff
  // marker exists yet at this point) to requeue as pending/retryable
  // instead of a permanent skip.
  test('an infra failure in the outbound-prior-contact probe propagates, never resolves as a terminal skip', async () => {
    hasPriorContact.mockRejectedValue(new Error('pool timeout'));
    const outboundCall = { ...CALL, direction: 'outbound' };
    const conn = makeDb();
    await expect(dispatchClaimedCall(conn, outboundCall, NOW)).rejects.toThrow('pool timeout');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an outbound RETURN call (lead contacted us first) still sends', async () => {
    hasPriorContact.mockResolvedValue(true);
    const outboundCall = { ...CALL, direction: 'outbound' };
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, outboundCall, NOW);
    expect(result.sent).toBe(true);
  });

  test('booked since the call (any time after call end) blocks the send', async () => {
    // metadata.created_customer_id matches the lead's customer_id — isolates
    // this test from the new existing_customer check (codex #5018 r10 P2).
    const callWithOwnCustomer = { ...CALL, metadata: { ...CALL.metadata, created_customer_id: 'cust-1' } };
    const conn = makeDb({ lead: { ...OPEN_LEAD, customer_id: 'cust-1' }, bookedSince: { id: 'visit-1' } });
    const result = await dispatchClaimedCall(conn, callWithOwnCustomer, NOW);
    expect(result.skipped).toBe('booked_since_call');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a visit created during the call (after it started, before it ended) is caught as booked since the call', async () => {
    const callDuring = {
      ...CALL, direction: 'inbound', created_at: new Date('2026-09-26T15:00:00Z'), duration_seconds: 300, // 15:00–15:05
      metadata: { ...CALL.metadata, created_customer_id: 'cust-1' },
    };
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
    const recovered = {
      ...CALL, direction: 'inbound', created_at: new Date('2026-09-26T15:00:00Z'), duration_seconds: 999999999,
      metadata: { ...CALL.metadata, created_customer_id: 'cust-1' },
    };
    const visitCreatedAt = new Date('2026-09-26T15:10:00Z'); // minutes after the real call, decades before callEndedAt's reading
    const conn = makeDb({ lead: { ...OPEN_LEAD, customer_id: 'cust-1' }, visitCreatedAt });
    const result = await dispatchClaimedCall(conn, recovered, NOW);
    expect(result.skipped).toBe('booked_since_call');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // codex P1 on #5292: wiring proof — DISPATCH_CHECKS must also catch a
  // decline spoken on an EARLIER call for this lead's phone, even though
  // CALL's own extraction (unchanged here) carries sms_declined: false.
  test('a decline on an earlier call for this phone blocks the dispatch', async () => {
    const conn = makeDb({ earlierDeclineCall: { ai_extraction_enriched: { consent: { sms_declined: true } } } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('sms_declined_earlier_call');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // codex #5018 r15 P2: a booking for a customer staff quick-added from the
  // appointment modal, without ever linking this lead — OPEN_LEAD.customer_id
  // stays null, the ONLY signal is a phone match against the new customer's
  // own stored phone. Skipping the send is the safe direction.
  test('booked through a customer staff quick-added, never linked to this lead, blocks the send', async () => {
    const conn = makeDb({ lead: { ...OPEN_LEAD, customer_id: null }, bookedSince: { id: 'visit-unlinked' } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
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

  // codex #5018 r10 P2: sendReadiness used to measure this timeout from
  // entry.send_at, not original_send_at — send_at itself ADVANCES on every
  // retry deferral (the next attempt time), so a row that kept getting
  // deferred just under the 24h line would never time out, no matter how
  // long it had genuinely been stuck (unlike pastRetryDeadline, which
  // already measured from the fixed original_send_at). Here send_at was
  // advanced to just 1h ago by an earlier retry, but the TRUE original
  // send_at is 25h old — past NOT_READY_GIVE_UP_MS — so this must still
  // time out.
  test('a row whose send_at was advanced by a retry still times out 24h after the ORIGINAL send time, not the advanced one', async () => {
    const conn = makeDb();
    const advancedButRecentSendAt = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(); // only 1h old
    const trueOriginalSendAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(); // 25h old — past the 24h bound
    const staleEntry = { status: 'claimed', lead_id: 'lead-1', send_at: advancedButRecentSendAt, original_send_at: trueOriginalSendAt };
    const stuck = { ...CALL, processing_token: 'tok-1', metadata: { ...CALL.metadata, call_booking_link_text: staleEntry } };
    const result = await dispatchClaimedCall(conn, stuck, NOW);
    expect(result.skipped).toBe('call_not_ready_timeout');
    expect(result.deferred).toBeUndefined();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a row whose ORIGINAL send time is still within 24h keeps waiting, even though send_at itself is older (a clock skew edge case)', async () => {
    const conn = makeDb();
    // Deliberately inverted from the ordinary case, to isolate that this
    // reads original_send_at and not merely "the older of the two":
    // original_send_at is recent, so this must still be 'wait', never a
    // timeout.
    const entry = {
      status: 'claimed', lead_id: 'lead-1',
      send_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      original_send_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
    };
    const stuck = { ...CALL, processing_token: 'tok-1', metadata: { ...CALL.metadata, call_booking_link_text: entry } };
    const result = await dispatchClaimedCall(conn, stuck, NOW);
    expect(result.skipped).toBe('call_not_ready');
    expect(result.deferred).toBe(true);
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

  // codex #5018 r11 P1: without a locked handoff, a STOP committed after
  // send-customer-message.js's FIRST suppression/consent read and before
  // the provider request is never re-caught for this lane — neverSendRecheck
  // re-derives only this lane's own never-send conditions, not suppression
  // or consent. withSmsHandoff supplies the missing lock, matching the
  // inbound STOP writer's own lockSmsPhone key (proven against a real
  // Postgres advisory lock in call-booking-link-text-postgres.test.js —
  // a mocked knex cannot prove a lock is actually held).
  test('sendCustomerMessage receives a withSmsHandoff that locks the destination phone, then runs the caller-supplied handoff on that same connection', async () => {
    const conn = makeDb();
    await dispatchClaimedCall(conn, CALL, NOW);
    const sendInput = sendCustomerMessage.mock.calls[0][0];
    expect(typeof sendInput.withSmsHandoff).toBe('function');

    const handoff = jest.fn(async (trx) => ({ ok: true, trx }));
    const verdict = await sendInput.withSmsHandoff(handoff);

    expect(conn.transaction).toHaveBeenCalledTimes(1);
    // lockSmsPhone's own pg_advisory_xact_lock call, on the SAME
    // destination phone the actual send targets.
    expect(conn.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [OPEN_LEAD.phone]);
    // The caller's handoff ran on the transaction's own connection (the
    // mock's stand-in for a real trx), not a second, unlocked one.
    expect(handoff).toHaveBeenCalledWith(conn);
    expect(verdict).toEqual({ ok: true, trx: conn });
  });

  // codex #5018 r15/r16 P1 follow-up: the phone-match candidate customer
  // ids withSmsHandoff locks with lockCustomerComms are read BEFORE those
  // locks — a customer quick-added for this exact destination phone in the
  // gap is never locked, so a booking committed for it between
  // bookedSinceCall's own read and the actual provider request is never
  // fenced. The handoff now re-resolves the SAME phone-match query after
  // every lock is held and bails out retryable, never calling the
  // caller-supplied handoff, when that re-check finds an id the first pass
  // missed — proven here with a real Postgres advisory lock in
  // call-booking-link-text-postgres.test.js (a mocked knex cannot prove a
  // concurrent insert actually happened in the gap).
  test('a customer newly matching the destination phone after the initial lock snapshot defers to the next sweep instead of sending unfenced', async () => {
    let calls = 0;
    const customersPluck = jest.fn(async () => (calls++ === 0 ? [] : ['new-cust-1']));
    const conn = makeDb({ customersPluck });
    await dispatchClaimedCall(conn, CALL, NOW);
    const sendInput = sendCustomerMessage.mock.calls[0][0];
    const handoff = jest.fn(async (trx) => ({ ok: true, trx }));
    const verdict = await sendInput.withSmsHandoff(handoff);

    expect(customersPluck).toHaveBeenCalledTimes(2);
    expect(handoff).not.toHaveBeenCalled();
    expect(verdict).toEqual({
      ok: false,
      code: 'candidate_customer_set_changed',
      reason: expect.any(String),
      retryable: true,
    });
  });

  // The mirror case: a re-check that finds exactly the SAME ids (however
  // many) already locked is not a widened set — the handoff proceeds
  // normally. Guards against a false positive from set-membership order or
  // an id appearing in both passes.
  test('a re-check that resolves the SAME candidate ids as the first pass proceeds normally', async () => {
    const customersPluck = jest.fn(async () => ['same-cust-1']);
    const conn = makeDb({ customersPluck });
    await dispatchClaimedCall(conn, CALL, NOW);
    const sendInput = sendCustomerMessage.mock.calls[0][0];
    const handoff = jest.fn(async (trx) => ({ ok: true, trx }));
    const verdict = await sendInput.withSmsHandoff(handoff);

    expect(customersPluck).toHaveBeenCalledTimes(2);
    expect(handoff).toHaveBeenCalledWith(conn);
    expect(verdict).toEqual({ ok: true, trx: conn });
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

  // codex round-3 P2: recordRetryableDecision's OWN pastRetryDeadline exit
  // must clear both marker tables too, not only the ordinary requeue path
  // below it — dispatchClaimedCall's own earlier pre-send deadline check
  // (proven above) already keeps this branch unreachable through the public
  // entry point, so recordRetryableDecision is exercised directly via the
  // module's _private reach-in, the same way its own doc comment upgrade
  // describes the risk: a marker written by onDispatchStart during THIS
  // retryable send must not survive a deadline give-up.
  test("recordRetryableDecision's past-deadline exit still clears both dispatch marker tables", async () => {
    const now = new Date('2026-09-27T13:00:00Z');
    const originalSendAt = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const entry = { status: 'claimed', lead_id: 'lead-1', send_at: originalSendAt, original_send_at: originalSendAt };
    const call = { id: 'call-past-deadline', metadata: { call_booking_link_text: entry } };

    const del = jest.fn(async () => 1);
    const deletedTables = [];
    const markerConn = jest.fn((table) => {
      deletedTables.push(table);
      return { where: jest.fn(() => ({ del })) };
    });
    markerConn.transaction = jest.fn(async (fn) => fn(markerConn));
    markerDb.mockReturnValue(markerConn);

    const skip = jest.fn(async (reason) => ({ sent: false, skipped: reason }));
    const result = { retryable: true, code: 'PROVIDER_FAILURE' };

    const outcome = await _private.recordRetryableDecision(db, call, entry, 'lead-1', now, result, skip);

    expect(skip).toHaveBeenCalledWith('PROVIDER_FAILURE', { failed: true }); // a delivery that never happened (codex #5358 r1 P1)
    expect(del).toHaveBeenCalledTimes(2);
    expect(deletedTables).toEqual([HANDOFF_MARKER_TABLE, CONSULTATION_ATTEMPT_TABLE]);
    expect(outcome).toEqual({ sent: false, skipped: 'PROVIDER_FAILURE' });
  });

  // ── handoff_started_at — the fact that decides safe-to-retry vs
  // leave-for-review after a failure (codex r3 P2) ────────────────────────
  describe('handoff_started_at is stamped right before the provider call', () => {
    // codex #5018 r13 P1: the marker is an INSERT into its own table
    // (call_booking_link_text_handoffs) via markerDb() — a connection
    // OUTSIDE dbi's own transaction — never an UPDATE on call_log itself.
    // A timeout/throw from messages.create() rolls dbi's transaction back;
    // a marker written on THAT transaction would roll back with it even
    // though Twilio may already have the request. makeDb() already points
    // markerDb() at its own conn by default, so a custom `markerInsert`
    // spy below keeps observing the real write site.

    // codex #5018 r15 P1: the write moved OFF providerPreSendCheck (still
    // neverSendRecheck, invoked exactly as before) and onto a NEW
    // onDispatchStart hook — twilio.js's own REAL attempt boundary,
    // invoked immediately before dispatchStarted flips true and
    // messages.create() runs, AFTER disclaimedNumberBlocksSend and
    // preSendCheck.isStillValid have ALSO cleared. Marking inside
    // providerPreSendCheck left exactly that gap uncovered: a disclaimed-
    // number hold or a closed send window committing between
    // neverSendRecheck returning ok and messages.create() would have left
    // a marker for an SMS that was never actually attempted. These tests
    // invoke both hooks explicitly, in the SAME order twilio.js's real
    // dispatch() does, since the mock otherwise never calls either.
    test('onDispatchStart writes the marker, as the REAL attempt boundary — providerPreSendCheck itself writes nothing', async () => {
      const markerInsert = jest.fn(() => ({ onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) }));
      const conn = makeDb({ markerInsert });
      let insertedBeforeOnDispatchStart;
      let insertedAfterOnDispatchStart;
      sendCustomerMessage.mockImplementation(async (opts) => {
        const verdict = await opts.providerPreSendCheck({ dbi: conn });
        expect(verdict).toEqual({ ok: true });
        insertedBeforeOnDispatchStart = markerInsert.mock.calls.length;
        // Simulates twilio.js's own disclaimedNumberBlocksSend/
        // preSendCheck.isStillValid gate, between providerPreSendCheck and
        // onDispatchStart, clearing without incident.
        await opts.onDispatchStart();
        insertedAfterOnDispatchStart = markerInsert.mock.calls.length;
        return { sent: true, providerMessageId: 'SM_test_sid', deliveryOutcome: 'accepted' };
      });
      const result = await dispatchClaimedCall(conn, CALL, NOW);
      expect(result.sent).toBe(true);
      expect(insertedBeforeOnDispatchStart).toBe(0); // not inserted while providerPreSendCheck ran
      expect(insertedAfterOnDispatchStart).toBe(1);
      expect(markerInsert).toHaveBeenCalledWith(expect.objectContaining({ call_log_id: CALL.id }));
    });

    // Codex #5018 r15 P1's own named scenario: a disclaimed-number hold (or
    // any other refusal in the gap twilio.js keeps between
    // providerPreSendCheck and the real attempt) means onDispatchStart is
    // NEVER reached — no marker, so a later retry is never wrongly treated
    // as ambiguous.
    test('a disclaimed-number refusal AFTER providerPreSendCheck but BEFORE onDispatchStart leaves no marker — safe to retry', async () => {
      const markerInsert = jest.fn(() => ({ onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) }));
      const conn = makeDb({ markerInsert });
      sendCustomerMessage.mockImplementation(async (opts) => {
        const verdict = await opts.providerPreSendCheck({ dbi: conn });
        expect(verdict).toEqual({ ok: true });
        // twilio.js's own disclaimedNumberBlocksSend gate refuses here —
        // opts.onDispatchStart is never invoked for this attempt.
        const err = new Error('disclaimed number on hold');
        err.retryable = true;
        throw err;
      });
      await expect(dispatchClaimedCall(conn, CALL, NOW)).rejects.toThrow('disclaimed number on hold');
      expect(markerInsert).not.toHaveBeenCalled();
      const outcome = await recoverAbandonedClaim(conn, CALL, NOW); // makeDb()'s default marker lookup finds no row
      expect(outcome.ambiguous).toBe(false);
    });

    // Codex #5018 r15 P1's second named scenario: a crash AFTER
    // dispatchStarted (i.e. after onDispatchStart already ran) leaves the
    // marker in place — recoverAbandonedClaim then treats it as ambiguous,
    // never resent, since Twilio may already have the request.
    test('a crash AFTER onDispatchStart (dispatchStarted already true) leaves the marker in place — ambiguous, never resent', async () => {
      let markerInserted = false;
      const markerInsert = jest.fn(() => {
        markerInserted = true;
        return { onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) };
      });
      const conn = makeDb({ markerInsert });
      sendCustomerMessage.mockImplementation(async (opts) => {
        const verdict = await opts.providerPreSendCheck({ dbi: conn });
        expect(verdict).toEqual({ ok: true });
        await opts.onDispatchStart(); // the REAL attempt boundary — dispatchStarted flips true here in twilio.js
        throw new Error('provider timeout, no result'); // messages.create() itself failed AFTER the marker insert
      });
      await expect(dispatchClaimedCall(conn, CALL, NOW)).rejects.toThrow('provider timeout, no result');
      expect(markerInserted).toBe(true); // the marker survived the throw

      // recoverAbandonedClaim reads the marker table fresh, on this SAME
      // conn — reconfigure it to reflect the row the insert above created.
      conn.mockImplementation((table) => {
        const chain = {};
        ['whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'limit', 'modify', 'forUpdate', 'where', 'join']
          .forEach((m) => { chain[m] = jest.fn(() => chain); });
        chain.first = jest.fn(async () => (table === HANDOFF_MARKER_TABLE ? { call_log_id: CALL.id } : undefined));
        chain.update = jest.fn(async () => 1);
        chain.insert = jest.fn(async () => {});
        return chain;
      });
      const outcome = await recoverAbandonedClaim(conn, CALL, NOW);
      expect(outcome).toEqual({ ambiguous: true });
    });

    // codex #5018 pre-push P1 (round 3): a DEFINITELY retryable rejection
    // (e.g. Twilio's own 429/20429 rate-limit response) can arrive AFTER
    // onDispatchStart already wrote the marker — this is never the
    // isAmbiguousProviderOutcome branch, since send-customer-message.js/
    // twilio.js have already determined the attempt did NOT reach an
    // ambiguous state. recordSendOutcome's own retryable/deferred requeue
    // must clear that marker: left in place, a LATER attempt that crashes
    // before ever reaching Twilio again would find it and
    // recoverAbandonedClaim would wrongly call THAT unsent follow-up
    // 'ambiguous, never resend'.
    test('a definite retryable rejection AFTER onDispatchStart clears the stale marker when requeuing, so a later pre-provider crash is safe to retry', async () => {
      const markerDel = jest.fn(async () => 1);
      const conn = makeDb({ markerDel });
      sendCustomerMessage.mockImplementation(async (opts) => {
        const verdict = await opts.providerPreSendCheck({ dbi: conn });
        expect(verdict).toEqual({ ok: true });
        await opts.onDispatchStart(); // the marker is written here
        // Twilio's own definite rejection (429/20429) — retryable, never
        // ambiguous, unlike a thrown timeout/network error.
        return { sent: false, retryable: true, code: 'TWILIO_RATE_LIMITED', reason: '429 Too Many Requests' };
      });
      const result = await dispatchClaimedCall(conn, CALL, NOW);
      expect(result).toMatchObject({ sent: false, skipped: 'TWILIO_RATE_LIMITED', deferred: true });
      // The stale marker from THIS attempt was cleared as part of the requeue.
      expect(markerDel).toHaveBeenCalledTimes(1);

      // A later attempt (a fresh claim of the now-'pending' row) that
      // crashes before ever reaching Twilio again must be safe to retry —
      // recoverAbandonedClaim reads the marker table fresh, and with the
      // stale row cleared it correctly finds none.
      conn.mockImplementation((table) => {
        const chain = {};
        ['whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'limit', 'modify', 'forUpdate', 'where', 'join']
          .forEach((m) => { chain[m] = jest.fn(() => chain); });
        chain.first = jest.fn(async () => undefined); // no marker row — cleared above
        chain.update = jest.fn(async () => 1);
        chain.insert = jest.fn(async () => {});
        return chain;
      });
      const outcome = await recoverAbandonedClaim(conn, CALL, NOW);
      expect(outcome.ambiguous).toBe(false);
    });

    // codex #5196 pre-push P1 (Claude fallback audit, round 2): an outright
    // non-retryable block (e.g. Twilio's own terminal 21211/21610/21614
    // rejection — classifyProviderFailure's retryable:false, never merely
    // a pre-dispatch policy refusal) can ALSO arrive AFTER onDispatchStart
    // already wrote both marker tables — this reaches recordSendOutcome's
    // generic `skip()` branch, not recordRetryableDecision, and previously
    // left both markers stale: a manual resend would 409 for
    // MANUAL_SEND_RACE_GUARD_WINDOW_MS and this lane's own next call to
    // the same lead would refuse link_sent_recently for the full 14-day
    // window, even though nothing was ever delivered.
    test('a definite NON-retryable block AFTER onDispatchStart also clears the stale marker', async () => {
      const markerDel = jest.fn(async () => 1);
      const conn = makeDb({ markerDel });
      sendCustomerMessage.mockImplementation(async (opts) => {
        const verdict = await opts.providerPreSendCheck({ dbi: conn });
        expect(verdict).toEqual({ ok: true });
        await opts.onDispatchStart(); // the marker is written here
        // Twilio's own terminal rejection (e.g. 21211 invalid To number) —
        // retryable: false, never ambiguous, never merely a pre-dispatch
        // policy block.
        return { sent: false, blocked: true, code: 'TWILIO_INVALID_NUMBER', reason: 'invalid To number' };
      });
      const result = await dispatchClaimedCall(conn, CALL, NOW);
      expect(result).toEqual({ sent: false, skipped: 'TWILIO_INVALID_NUMBER' });
      expect(markerDel).toHaveBeenCalledTimes(1);

      // recoverAbandonedClaim reads the marker table fresh — with the
      // stale row cleared it correctly finds none, matching the retryable
      // case's own proof above.
      conn.mockImplementation((table) => {
        const chain = {};
        ['whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'limit', 'modify', 'forUpdate', 'where', 'join']
          .forEach((m) => { chain[m] = jest.fn(() => chain); });
        chain.first = jest.fn(async () => undefined);
        chain.update = jest.fn(async () => 1);
        chain.insert = jest.fn(async () => {});
        return chain;
      });
      const outcome = await recoverAbandonedClaim(conn, CALL, NOW);
      expect(outcome.ambiguous).toBe(false);
    });

    // codex #5196 r4 P2: onDispatchRejected fires from INSIDE twilio.js's
    // own dispatch() when messages.create() throws a definitive rejection —
    // still holding lockSmsPhone, before sendCustomerMessage ever returns.
    // The lane passes it clearDispatchMarkers(call) directly, the SAME
    // both-tables clear onDispatchAbort already uses.
    test('onDispatchRejected clears both dispatch marker tables, the same as onDispatchAbort', async () => {
      // makeDb() below points markerDb() at its OWN conn by default (whose
      // consultation-attempt del is an untracked no-op) — override it,
      // AFTER makeDb() runs, to a dedicated double that tracks every
      // table a delete lands on, the same way onDispatchAbort's own
      // clearDispatchMarkers call needs to be observed.
      const del = jest.fn(async () => 1);
      const deletedTables = [];
      const markerConn = jest.fn((table) => {
        deletedTables.push(table);
        return { where: jest.fn(() => ({ del })) };
      });
      markerConn.transaction = jest.fn(async (fn) => fn(markerConn));

      const conn = makeDb();
      markerDb.mockReturnValue(markerConn);
      let deletedAfterHook;
      sendCustomerMessage.mockImplementation(async (opts) => {
        expect(typeof opts.onDispatchRejected).toBe('function');
        const verdict = await opts.providerPreSendCheck({ dbi: conn });
        expect(verdict).toEqual({ ok: true });
        // twilio.js's own messages.create() throw, reclassified as a
        // definitive rejection — fires onDispatchRejected INSTEAD of
        // onDispatchStart/onDispatchAbort, still inside the handoff.
        await opts.onDispatchRejected();
        deletedAfterHook = del.mock.calls.length;
        return { sent: false, blocked: true, code: 'TWILIO_INVALID_NUMBER', reason: 'invalid To number' };
      });
      await dispatchClaimedCall(conn, CALL, NOW);

      expect(deletedAfterHook).toBe(2); // both tables, cleared by the hook itself
      expect(deletedTables.slice(0, 2)).toEqual([HANDOFF_MARKER_TABLE, CONSULTATION_ATTEMPT_TABLE]);
    });

    // The actual r8 P2 fix: a failure in sendCustomerMessage's OWN
    // pre-provider work — before it ever reaches providerPreSendCheck —
    // must leave NO handoff_started_at at all, unlike the old behavior
    // (stamped unconditionally before sendCustomerMessage was even called).
    test('a throw from sendCustomerMessage\'s OWN pre-provider work, before providerPreSendCheck is ever called, leaves no marker row — safe to requeue', async () => {
      const markerInsert = jest.fn(() => ({ onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) }));
      const conn = makeDb({ markerInsert });
      sendCustomerMessage.mockImplementation(async () => {
        throw new Error('reservation acquisition failed'); // never invokes providerPreSendCheck at all
      });
      await expect(dispatchClaimedCall(conn, CALL, NOW)).rejects.toThrow('reservation acquisition failed');
      expect(markerInsert).not.toHaveBeenCalled(); // no marker written — providerPreSendCheck never ran

      const outcome = await recoverAbandonedClaim(conn, CALL, NOW); // makeDb()'s default marker lookup finds no row
      expect(outcome.ambiguous).toBe(false);
    });

    test('a throw BEFORE the marker insert (the link builder itself throws) leaves no marker row — safe for recoverAbandonedClaim to requeue', async () => {
      buildLeadConsultationSmsLine.mockRejectedValue(new Error('db hiccup'));
      const markerInsert = jest.fn(() => ({ onConflict: jest.fn(() => ({ ignore: jest.fn(async () => {}) })) }));
      const conn = makeDb({ markerInsert });
      await expect(dispatchClaimedCall(conn, CALL, NOW)).rejects.toThrow('db hiccup');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(markerInsert).not.toHaveBeenCalled(); // the marker insert never happened at all

      const outcome = await recoverAbandonedClaim(conn, CALL, NOW); // makeDb()'s default marker lookup finds no row
      expect(outcome.ambiguous).toBe(false);
    });
  });
});

// ── recoverAbandonedClaim — the shared before/after-handoff decision ─────
describe('recoverAbandonedClaim', () => {
  const NOW = new Date('2026-09-26T18:00:00Z');

  // codex #5018 r13 P1: recoverAbandonedClaim now reads the handoff marker
  // TABLE (call_booking_link_text_handoffs), never call_log.metadata's own
  // handoff_started_at field — `hasHandoff` stands in for whether a row
  // exists there.
  function rawCapturingConn(hasHandoff = false) {
    const chain = {};
    ['where', 'whereNull', 'whereRaw', 'orderBy', 'limit', 'select'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.update = jest.fn(async () => 1);
    chain.insert = jest.fn(async () => {});
    chain.first = jest.fn(async () => (hasHandoff ? { call_log_id: 'call-1' } : undefined));
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

  // codex r8 P2: previously left 'claimed' with NO write at all — which
  // matched recoverStaleClaims' own WHERE clause on every future sweep
  // forever, since claimed_at never changes on a row nothing ever touches
  // again. Moved to its own terminal 'ambiguous' status instead (never
  // 'pending', never 'claimed') so a future stale-claim sweep never
  // selects it again — see recoverStaleClaims' own "60 ambiguous rows"
  // test for the actual starvation this fixes.
  test('a handoff marker row present: moves the call to its own terminal ambiguous status, logged — the provider may already have this attempt', async () => {
    const conn = rawCapturingConn(true);
    const entry = { status: 'claimed', lead_id: 'lead-1', send_at: NOW.toISOString() };
    const outcome = await recoverAbandonedClaim(conn, { id: 'call-1', metadata: { call_booking_link_text: entry } }, NOW);
    expect(outcome).toEqual({ ambiguous: true });
    const patch = lastPatch(conn);
    expect(patch).toMatchObject({ status: 'ambiguous', lead_id: 'lead-1' });
  });
});

// ── recoverStaleClaims — the safety net for a worker that died mid-dispatch
// (codex r3 P2) ────────────────────────────────────────────────────────────
describe('recoverStaleClaims', () => {
  const NOW = new Date('2026-09-26T18:00:00Z');

  // codex #5018 r13 P1: recoverAbandonedClaim (called from inside
  // recoverStaleClaims) now reads the handoff marker TABLE, not call_log's
  // own metadata — `row`'s own `handoff_started_at` field is kept ONLY as
  // this mock's stand-in signal for "a marker row exists," to avoid
  // rewriting every existing fixture below.
  function connFor(row) {
    const chain = {};
    ['whereRaw', 'orderBy', 'limit', 'where', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.select = jest.fn(async () => (row ? [{ id: row.id }] : []));
    chain.update = jest.fn(async () => 1);
    chain.insert = jest.fn(async () => {});
    const conn = jest.fn((table) => {
      chain.first = jest.fn(async () => {
        if (table === HANDOFF_MARKER_TABLE) {
          return row?.metadata?.call_booking_link_text?.handoff_started_at ? { call_log_id: row.id } : undefined;
        }
        return row;
      });
      return chain;
    });
    conn.raw = jest.fn((sql, bindings) => { conn.raw.captured = conn.raw.captured || []; conn.raw.captured.push(bindings); return 'RAW'; });
    return conn;
  }

  // codex #5018 r10 P2: the SELECT scans call_log via a metadata->>'status'
  // JSON expression with no index of its own — bounding created_at (which
  // IS indexed) keeps the scan itself small as history grows, rather than
  // adding a migration for a JSON-path index.
  test('the candidate SELECT bounds created_at to QUEUE_SCAN_LOOKBACK_MS', async () => {
    const wheres = [];
    const chain = {};
    ['whereRaw', 'orderBy', 'limit', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.where = jest.fn((...args) => { wheres.push(args); return chain; });
    chain.select = jest.fn(async () => []);
    const conn = jest.fn(() => chain);
    conn.raw = jest.fn();
    await recoverStaleClaims(conn, NOW);
    const bound = wheres.find(([col, op]) => col === 'created_at' && op === '>=');
    expect(bound).toBeTruthy();
    expect(NOW.getTime() - bound[2].getTime()).toBe(QUEUE_SCAN_LOOKBACK_MS);
  });

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

  // codex r8 P2: moved OUT of 'claimed' into 'ambiguous' (never resent),
  // not left 'claimed' with no write — see the "60 ambiguous rows" test
  // below for the starvation this specifically fixes.
  test('a stale claimed row WITH handoff_started_at moves to ambiguous and is not counted', async () => {
    const row = { id: 'call-stale-3', metadata: { call_booking_link_text: { status: 'claimed', handoff_started_at: NOW.toISOString() } } };
    const conn = connFor(row);
    const recovered = await recoverStaleClaims(conn, NOW);
    expect(recovered).toBe(0);
    const [json] = conn.raw.captured[conn.raw.captured.length - 1];
    expect(JSON.parse(json).call_booking_link_text).toMatchObject({ status: 'ambiguous' });
  });

  // The actual starvation this round's fix closes: a batch's worth (and
  // more) of permanently-ambiguous rows, all OLDER than one genuinely
  // recoverable row, must not block that row forever — each ambiguous row
  // is moved out of the 'claimed' pool the FIRST time it is found, so a
  // later sweep's batch is no longer full of rows nothing will ever
  // resolve.
  test('60 ambiguous rows, all older than one recoverable row, do not starve it across repeated sweeps', async () => {
    const AMBIGUOUS_COUNT = 60;
    const rows = new Map();
    for (let i = 0; i < AMBIGUOUS_COUNT; i += 1) {
      const id = `ambiguous-${i}`;
      rows.set(id, {
        id, createdAt: i, // older than the recoverable row (created_at index AMBIGUOUS_COUNT)
        metadata: { call_booking_link_text: { status: 'claimed', lead_id: 'lead-x', send_at: NOW.toISOString(), handoff_started_at: NOW.toISOString() } },
      });
    }
    const recoverableId = 'recoverable-1';
    rows.set(recoverableId, {
      id: recoverableId, createdAt: AMBIGUOUS_COUNT, // the newest row — sorts LAST in oldest-first order
      metadata: { call_booking_link_text: { status: 'claimed', lead_id: 'lead-y', send_at: NOW.toISOString(), original_send_at: NOW.toISOString() } },
    });

    // ONE shared chain + a single pendingId set by where() — read by both
    // first() and raw() (raw() is evaluated as an argument to update(),
    // strictly after the SAME chain's own where() already ran), so a real
    // jsonb merge can be applied in-memory and seen by the NEXT sweep's own
    // select() — a stateless per-call mock can't reproduce that across
    // repeated sweeps, and this fix is specifically about repeated sweeps.
    let pendingId;
    const chain = {};
    ['whereRaw', 'orderBy', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
    chain.limit = jest.fn((n) => { chain._limit = n; return chain; });
    chain.where = jest.fn((cond) => {
      if (cond && typeof cond === 'object' && cond.id) pendingId = cond.id;
      return chain;
    });
    chain.select = jest.fn(async () => [...rows.values()]
      .filter((r) => r.metadata.call_booking_link_text.status === 'claimed')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, chain._limit)
      .map((r) => ({ id: r.id })));
    // Table-aware (codex #5018 r13 P1): recoverAbandonedClaim's own handoff
    // marker lookup shares this SAME chain/pendingId — the pending row's
    // OWN (still-named) handoff_started_at field stands in for "a marker
    // row exists," so nothing about the rows Map above needed rewriting.
    chain.first = jest.fn(async () => {
      if (!pendingId || !rows.has(pendingId)) return undefined;
      if (chain._table === HANDOFF_MARKER_TABLE) {
        return rows.get(pendingId).metadata.call_booking_link_text.handoff_started_at ? { call_log_id: pendingId } : undefined;
      }
      return { id: pendingId, metadata: rows.get(pendingId).metadata };
    });
    chain.update = jest.fn(async () => 1);
    chain.insert = jest.fn(async () => {}); // the ambiguous write's own activity_log row
    const conn = jest.fn((table) => { chain._table = table; return chain; });
    conn.raw = jest.fn((sql, bindings) => {
      const patchValue = JSON.parse(bindings[0]).call_booking_link_text;
      if (pendingId && rows.has(pendingId)) rows.get(pendingId).metadata = { call_booking_link_text: patchValue };
      return 'RAW';
    });

    // Sweep 1: DISPATCH_BATCH (50) oldest 'claimed' rows are ALL ambiguous
    // (indices 0-49) — none recovered, but each moved to 'ambiguous', so
    // they leave the 'claimed' pool for good.
    const firstSweep = await recoverStaleClaims(conn, NOW);
    expect(firstSweep).toBe(0);
    const stillClaimedAfterFirst = [...rows.values()].filter((r) => r.metadata.call_booking_link_text.status === 'claimed');
    expect(stillClaimedAfterFirst).toHaveLength(11); // 10 remaining ambiguous + the 1 recoverable

    // Sweep 2: the remaining 11 easily fit in one batch — the recoverable
    // row is finally reached and requeued.
    const secondSweep = await recoverStaleClaims(conn, NOW);
    expect(secondSweep).toBe(1);
    const recoverableRow = rows.get(recoverableId);
    expect(recoverableRow.metadata.call_booking_link_text.status).toBe('pending'); // recovered, never starved
    const stillClaimedAfterSecond = [...rows.values()].filter((r) => r.metadata.call_booking_link_text.status === 'claimed');
    expect(stillClaimedAfterSecond).toHaveLength(0);
  });

  test('a row no longer found at all (deleted/merged since the candidate SELECT) is skipped without throwing', async () => {
    const conn = connFor(undefined);
    conn.mockImplementation((table) => {
      const chain = {};
      ['whereRaw', 'orderBy', 'limit', 'where', 'modify'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.select = jest.fn(async () => [{ id: 'call-gone' }]);
      chain.first = jest.fn(async () => undefined);
      chain.update = jest.fn(async () => 1);
      chain.insert = jest.fn(async () => {});
      return chain;
    });
    await expect(recoverStaleClaims(conn, NOW)).resolves.toBe(0);
  });
});

// codex #5358 r3 P1: only a known refusal is a healthy skip. A blocked
// result from the pipeline itself, or a provider rejection, is a failure
// the weekly check must surface.
describe('isExpectedRefusal', () => {
  const { isExpectedRefusal } = _private;
  test('opt-outs, suppression and missing consent are expected refusals', () => {
    for (const code of ['SMS_OPTED_OUT', 'SUPPRESSED_MANUAL_DNC', 'NO_CONSENT_RECORD', 'NON_MOBILE_SMS_RECIPIENT']) {
      expect(isExpectedRefusal({ sent: false, blocked: true, code })).toBe(true);
    }
  });
  test('pipeline and provider failures are not', () => {
    for (const code of ['CONTRACT_VIOLATION', 'UNKNOWN_POLICY', 'CONSENT_LOOKUP_FAILED', 'SOME_NEW_CODE']) {
      expect(isExpectedRefusal({ sent: false, blocked: true, code })).toBe(false);
    }
    expect(isExpectedRefusal({ sent: false, code: 'SMS_OPTED_OUT' })).toBe(false);
  });
});
