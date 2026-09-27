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
  outboundPriorContactMissing,
  outboundStagingReason,
  dispatchClaimedCall,
  claimForDispatch,
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

  // codex pre-push P1: callEndedAt(call) can read a future instant for a
  // post-call fallback row (a bogus/huge duration_seconds). Unclamped,
  // computeSendAt on that future end could push send_at arbitrarily late;
  // clamping to `now` bounds the delay instead.
  test('a recovered row whose computed end is in the future computes send_at from `now`, not that future reading', async () => {
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
