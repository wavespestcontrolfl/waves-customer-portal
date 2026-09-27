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
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
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
  stagingIneligibleReason,
  dispatchClaimedCall,
  claimForDispatch,
  sweep,
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

  test('an existing customer is never eligible, whatever the call says', () => {
    expect(stagingIneligibleReason({ ...baseCall, customer_id: 'cust-1' }, baseExtraction(), leadId)).toBe('existing_customer');
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
    metadata: { call_booking_link_text: { status: 'claimed', lead_id: 'lead-1', send_at: NOW.toISOString() } },
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

  function makeDb({ lead = OPEN_LEAD, bookedSince = null, linkSentRecently = null, callLogUpdate = jest.fn(async () => 1),
    activityInsert = jest.fn(async () => {}) } = {}) {
    const conn = jest.fn((table) => {
      const chain = {};
      ['where', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'limit', 'select', 'modify']
        .forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.first = jest.fn(async () => {
        if (table === 'leads') return lead;
        if (table === 'scheduled_services') return bookedSince;
        if (table === 'short_codes') return linkSentRecently;
        return undefined;
      });
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

  test('booked since the call (any time after call end) blocks the send', async () => {
    const conn = makeDb({ lead: { ...OPEN_LEAD, customer_id: 'cust-1' }, bookedSince: { id: 'visit-1' } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('booked_since_call');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a booking link already sent in the last 14 days blocks a second one', async () => {
    const conn = makeDb({ linkSentRecently: { id: 'sc-1' } });
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('link_sent_recently');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('outside the 8am-8pm ET send window at dispatch time blocks the send', async () => {
    const conn = makeDb();
    const lateNight = new Date('2026-09-27T03:00:00Z'); // 11 PM ET
    const result = await dispatchClaimedCall(conn, CALL, lateNight);
    expect(result.skipped).toBe('outside_send_window');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the link builder refusing (e.g. GATE_LEAD_INSPECTION_LINK dark) blocks the send with its reason', async () => {
    buildLeadConsultationSmsLine.mockResolvedValue({ url: null, line: '', reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)' });
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.skipped).toBe('link_unavailable:Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a policy-blocked send (e.g. opted out since the call) is recorded as skipped, not sent', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED_OPT_OUT' });
    const conn = makeDb();
    const result = await dispatchClaimedCall(conn, CALL, NOW);
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('SUPPRESSED_OPT_OUT');
  });
});
