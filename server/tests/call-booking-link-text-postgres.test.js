/**
 * Real-PostgreSQL coverage for call-booking-link-text.js's raw SQL — a
 * mocked knex proved it cannot catch a genuine Postgres parser rejection
 * (codex r3 P1: jsonb_build_object(:key, ...) left the bare named
 * parameter's type ambiguous and every claimForDispatch call would have
 * failed in production with "could not determine data type of parameter
 * $1," while 131+ mocked unit tests in call-booking-link-text.test.js all
 * stayed green). This file drives the actual SQL end to end — the
 * activation-boundary read/write in system_settings, stage()'s real
 * WHERE/jsonb filters, the atomic single-row claim, a full send through
 * dispatchClaimedCall with the metadata/activity_log writes it makes, and
 * the three send-time skips that live entirely in SQL (a real
 * scheduled_services row, a real short_codes + sms_log pair including the
 * review-ask reservation exclusion, and two leads sharing one
 * twilio_call_sid). sendCustomerMessage and the link builder are mocked —
 * neither makes a real network call, but mocking them keeps this file free
 * of Twilio/consultation-token signing setup and focused on the SQL this
 * lane actually depends on.
 *
 * Self-skips without CALL_BOOKING_LINK_TEST_DATABASE_URL, e.g.:
 *   CALL_BOOKING_LINK_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest server/tests/call-booking-link-text-postgres.test.js --runInBand
 * Never a shared or prod database — this creates one throwaway schema,
 * clones the already-migrated public tables into it, and drops the whole
 * schema in afterAll.
 */
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/lead-consultation-link', () => ({
  ...jest.requireActual('../services/lead-consultation-link'),
  buildLeadConsultationSmsLine: jest.fn(),
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const callBookingLinkText = require('../services/call-booking-link-text');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { buildLeadConsultationSmsLine } = require('../services/lead-consultation-link');

const connection = process.env.CALL_BOOKING_LINK_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `call_booking_link_${randomUUID().replaceAll('-', '')}`;
const TABLES = ['customers', 'leads', 'call_log', 'system_settings', 'scheduled_services', 'short_codes', 'sms_log', 'activity_log'];
let admin;
let mockPg;
jest.setTimeout(30000);

// A fixed instant, decoupled from real wall-clock time — dispatchClaimedCall
// takes `now` as an explicit argument, so every ET-window / retry-deadline
// check below is evaluated against this, never the moment the test happens
// to run. 18:00Z in January is 13:00 ET (EST, no DST) — inside the 8am-8pm
// send window.
const NOW = new Date('2027-01-15T18:00:00.000Z');

// Every STAGING_CHECKS entry that isn't the one thing a given test is
// exercising must read as eligible — this is the minimal extraction shape
// that clears every one of them (see call-booking-link-text.js's own table).
function eligibleExtraction() {
  return {
    meta: {},
    call_nature: 'new_lead',
    recommended_disposition: 'callback_needed',
    triage_flags: [],
    caller: {},
    property: { property_type: 'single_family' },
    service_request: { service_intent: 'inspection_only' },
    scheduling: {},
    consent: {},
    sentiment_and_lead: {},
  };
}

async function insertLead(conn, overrides = {}) {
  const id = overrides.id || randomUUID();
  await conn('leads').insert({
    id, phone: '+15555550111', first_name: 'Lead', last_name: 'Person', status: 'new', ...overrides,
  });
  return id;
}

async function insertCall(conn, overrides = {}) {
  const id = overrides.id || randomUUID();
  await conn('call_log').insert({
    id,
    direction: 'inbound',
    duration_seconds: 120,
    v2_extraction_status: 'valid',
    processing_token: null,
    ai_address_validation: JSON.stringify({ inServiceArea: true }),
    ai_extraction_enriched: JSON.stringify(eligibleExtraction()),
    metadata: JSON.stringify({}),
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
    ...(overrides.ai_extraction_enriched !== undefined ? { ai_extraction_enriched: JSON.stringify(overrides.ai_extraction_enriched) } : {}),
    ...(overrides.ai_address_validation !== undefined ? { ai_address_validation: JSON.stringify(overrides.ai_address_validation) } : {}),
    ...(overrides.metadata !== undefined ? { metadata: JSON.stringify(overrides.metadata) } : {}),
  });
  return id;
}

postgres('call-booking-link-text against PostgreSQL', () => {
  let priorActivatedAtEnv;

  beforeAll(async () => {
    if (!/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(new URL(connection).pathname)) {
      throw new Error('Use an explicitly selected synthetic Waves QA database');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    // Clone the MIGRATED public schema, never application records — catches
    // real column/type/CHECK drift instead of a hand-written stand-in. This
    // lane adds no new table and no new column to any of these, so no
    // trailing migration needs to be replayed forward into the clone.
    for (const table of TABLES) {
      await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
  });

  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  beforeEach(async () => {
    for (const table of TABLES) await mockPg(table).delete();
    jest.clearAllMocks();
    priorActivatedAtEnv = process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT;
    delete process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT;
  });

  afterEach(() => {
    if (priorActivatedAtEnv === undefined) delete process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT;
    else process.env.CALL_BOOKING_LINK_TEXT_ACTIVATED_AT = priorActivatedAtEnv;
  });

  test('persistedActivationBoundary reads an existing system_settings row back verbatim instead of overwriting it with MODULE_LOAD_AT', async () => {
    const stored = new Date('2026-11-01T00:00:00.000Z');
    await mockPg('system_settings').insert({
      key: callBookingLinkText.ACTIVATION_SETTINGS_KEY, value: stored.toISOString(), category: 'call_booking_link_text',
    });
    const boundary = await callBookingLinkText.persistedActivationBoundary(mockPg);
    expect(boundary.getTime()).toBe(stored.getTime());
    // onConflict('key').ignore() must never have touched the row — a second
    // call still reads the SAME stored instant, not MODULE_LOAD_AT.
    const row = await mockPg('system_settings').where({ key: callBookingLinkText.ACTIVATION_SETTINGS_KEY }).first('value');
    expect(new Date(row.value).getTime()).toBe(stored.getTime());
  });

  test('persistedActivationBoundary INSERTs and then reads back its own fallback when nothing is stored yet', async () => {
    const before = await mockPg('system_settings').where({ key: callBookingLinkText.ACTIVATION_SETTINGS_KEY }).first();
    expect(before).toBeUndefined();
    const boundary = await callBookingLinkText.persistedActivationBoundary(mockPg);
    expect(boundary.getTime()).toBe(callBookingLinkText.MODULE_LOAD_AT.getTime());
    const row = await mockPg('system_settings').where({ key: callBookingLinkText.ACTIVATION_SETTINGS_KEY }).first('value');
    expect(new Date(row.value).getTime()).toBe(callBookingLinkText.MODULE_LOAD_AT.getTime());
  });

  test('stage() stages one eligible call and skips a call that started before the activation boundary, via the real jsonb/WHERE filters', async () => {
    const boundary = new Date('2027-01-13T00:00:00.000Z');
    await mockPg('system_settings').insert({ key: callBookingLinkText.ACTIVATION_SETTINGS_KEY, value: boundary.toISOString(), category: 'call_booking_link_text' });

    const eligibleLeadId = await insertLead(mockPg);
    const eligibleCallId = await insertCall(mockPg, {
      metadata: { lead_id: eligibleLeadId },
      created_at: new Date('2027-01-14T12:00:00.000Z'),
      updated_at: new Date('2027-01-15T17:00:00.000Z'), // 1h before NOW — past the 15-min grace window
    });

    const preBoundaryLeadId = await insertLead(mockPg);
    const preBoundaryCallId = await insertCall(mockPg, {
      metadata: { lead_id: preBoundaryLeadId },
      created_at: new Date('2027-01-12T20:00:00.000Z'), // within the 3-day lookback, before `boundary`
      updated_at: new Date('2027-01-12T20:00:00.000Z'),
    });

    const result = await callBookingLinkText.stage(mockPg, { now: NOW });
    expect(result).toEqual({ staged: 1, ineligible: 1 });

    const eligibleRow = await mockPg('call_log').where({ id: eligibleCallId }).first('metadata');
    expect(eligibleRow.metadata.call_booking_link_text).toMatchObject({ status: 'pending', lead_id: eligibleLeadId });
    expect(eligibleRow.metadata.call_booking_link_text.send_at).toBe(eligibleRow.metadata.call_booking_link_text.original_send_at);

    const preBoundaryRow = await mockPg('call_log').where({ id: preBoundaryCallId }).first('metadata');
    expect(preBoundaryRow.metadata.call_booking_link_text).toMatchObject({ status: 'skipped', reason: 'pre_activation' });
  });

  test('stage() fails closed on two leads sharing one twilio_call_sid (ambiguous_lead_linkage), a real leads-table lookup', async () => {
    await mockPg('system_settings').insert({ key: callBookingLinkText.ACTIVATION_SETTINGS_KEY, value: new Date('2020-01-01').toISOString(), category: 'call_booking_link_text' });
    const sid = `CA${randomUUID().replaceAll('-', '').slice(0, 32)}`;
    await insertLead(mockPg, { twilio_call_sid: sid });
    await insertLead(mockPg, { twilio_call_sid: sid });
    const callId = await insertCall(mockPg, {
      twilio_call_sid: sid,
      created_at: new Date('2027-01-14T12:00:00.000Z'),
      updated_at: new Date('2027-01-15T17:00:00.000Z'),
    });

    const result = await callBookingLinkText.stage(mockPg, { now: NOW });
    expect(result).toEqual({ staged: 0, ineligible: 1 });
    const row = await mockPg('call_log').where({ id: callId }).first('metadata');
    expect(row.metadata.call_booking_link_text).toMatchObject({ status: 'skipped', reason: 'ambiguous_lead_linkage' });
  });

  test('claimForDispatch atomically claims a pending row exactly once, preserving a sibling metadata key', async () => {
    const leadId = await insertLead(mockPg);
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'pending', lead_id: leadId, send_at, original_send_at: send_at } },
    });

    const claimed = await callBookingLinkText.claimForDispatch(mockPg, callId);
    expect(claimed).toBe(true);
    const afterFirst = await mockPg('call_log').where({ id: callId }).first('metadata');
    expect(afterFirst.metadata.call_booking_link_text.status).toBe('claimed');
    expect(afterFirst.metadata.call_booking_link_text.claimed_at).toBeTruthy();
    expect(afterFirst.metadata.lead_id).toBe(leadId); // sibling key survives the jsonb merge

    const claimedAgain = await callBookingLinkText.claimForDispatch(mockPg, callId);
    expect(claimedAgain).toBe(false);
    const afterSecond = await mockPg('call_log').where({ id: callId }).first('metadata');
    expect(afterSecond.metadata.call_booking_link_text.status).toBe('claimed'); // unchanged, not re-claimed
  });

  test('dispatchClaimedCall sends once through the mocked provider and writes the metadata + activity_log rows', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550111' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-1', line: 'Pick a time.\n\n', phone: '+15555550111' });
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000001' });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: true, providerMessageId: 'SMtest0000000000000000000000001' });
    const row = await mockPg('call_log').where({ id: callId }).first('metadata');
    expect(row.metadata.call_booking_link_text).toMatchObject({ status: 'sent', lead_id: leadId, provider_message_id: 'SMtest0000000000000000000000001' });
    expect(row.metadata.call_booking_link_text.sent_at).toBeTruthy();
    const activity = await mockPg('activity_log').where({ action: 'call_booking_link_text_sent' });
    expect(activity).toHaveLength(1);
    expect(activity[0].metadata).toMatchObject({ call_log_id: callId, lead_id: leadId });
  });

  test('dispatchClaimedCall skips booked_since_call against a real scheduled_services row created after the call', async () => {
    const customerId = randomUUID();
    await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone: '+15555550222', address_line1: '1 Example St', city: 'Bradenton', zip: '34205' });
    const leadId = await insertLead(mockPg, { phone: '+15555550222', customer_id: customerId });
    const callCreatedAt = new Date('2027-01-15T10:00:00.000Z');
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      created_at: callCreatedAt, updated_at: callCreatedAt,
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    await mockPg('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: '2027-01-20', service_type: 'Pest Control', status: 'pending',
      created_at: new Date(callCreatedAt.getTime() + 60 * 60 * 1000), // booked an hour after the call started
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: false, skipped: 'booked_since_call' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const activity = await mockPg('activity_log').where({ action: 'call_booking_link_text_skipped' });
    expect(activity).toHaveLength(1);
    expect(activity[0].metadata).toMatchObject({ reason: 'booked_since_call' });
  });

  test('link_sent_recently: a same-code sending reservation does not block, but a real accepted send does', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550333' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const mintedAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    await mockPg('short_codes').insert({ id: randomUUID(), code: 'ab12', target_url: 'https://portal.example.com/inspection/tok-x', kind: 'consultation', entity_type: 'leads', entity_id: leadId, created_at: mintedAt, updated_at: mintedAt });
    // A pre-provider reservation placeholder — excludeUnresolvedSendReservations
    // must hide this from linkSentRecently even though it carries the code.
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: '+15555550333', status: 'sending',
      message_body: 'Pick a time: https://portal.example.com/l/ab12', metadata: { review_ask_reservation: true }, created_at: mintedAt,
    });

    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-x', line: 'Pick a time.\n\n', phone: '+15555550333' });
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000002' });

    const firstCallId = await insertCall(mockPg, {
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    const firstCall = await mockPg('call_log').where({ id: firstCallId }).first();
    const firstResult = await callBookingLinkText.dispatchClaimedCall(mockPg, firstCall, NOW);
    expect(firstResult.sent).toBe(true); // the bare reservation alone never blocks a send

    // Now a REAL accepted send (evidence, not just a mint) exists for the same
    // code — a second, independently-staged call for the same lead must skip.
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: '+15555550333', status: 'accepted',
      message_body: 'Pick a time: https://portal.example.com/l/ab12', created_at: mintedAt,
    });
    const secondCallId = await insertCall(mockPg, {
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    const secondCall = await mockPg('call_log').where({ id: secondCallId }).first();
    const secondResult = await callBookingLinkText.dispatchClaimedCall(mockPg, secondCall, NOW);
    expect(secondResult).toEqual({ sent: false, skipped: 'link_sent_recently' });
  });

  // codex r3 P1/P2 (this round) — new raw SQL added alongside the earlier
  // jsonb_build_object fix: refreshLiveActivationBoundary's onConflict().
  // merge() write and recoverStaleClaims'/recoverAbandonedClaim's own
  // named-binding comparisons. The same class of bug (a mocked knex cannot
  // see a real Postgres parser rejection) could just as easily hide here.
  test('refreshLiveActivationBoundary advances a stale boundary via a real onConflict().merge() write', async () => {
    const oldBoundary = new Date('2020-01-01T00:00:00.000Z');
    await mockPg('system_settings').insert({ key: callBookingLinkText.ACTIVATION_SETTINGS_KEY, value: oldBoundary.toISOString(), category: 'call_booking_link_text' });
    // No heartbeat row at all — a real gap.
    await callBookingLinkText.refreshLiveActivationBoundary(mockPg, NOW);

    const boundaryRow = await mockPg('system_settings').where({ key: callBookingLinkText.ACTIVATION_SETTINGS_KEY }).first('value');
    expect(new Date(boundaryRow.value).getTime()).toBe(callBookingLinkText.MODULE_LOAD_AT.getTime());
    const heartbeatRow = await mockPg('system_settings').where({ key: callBookingLinkText.LAST_LIVE_SETTINGS_KEY }).first('value');
    expect(new Date(heartbeatRow.value).getTime()).toBe(NOW.getTime());

    // Calling it again immediately (heartbeat now fresh) must NOT regress
    // the just-advanced boundary — a real round trip through the same
    // onConflict().merge() write, not just a JS-level assertion.
    await callBookingLinkText.refreshLiveActivationBoundary(mockPg, new Date(NOW.getTime() + 1000));
    const boundaryAfter = await mockPg('system_settings').where({ key: callBookingLinkText.ACTIVATION_SETTINGS_KEY }).first('value');
    expect(new Date(boundaryAfter.value).getTime()).toBe(callBookingLinkText.MODULE_LOAD_AT.getTime());
  });

  test('recoverStaleClaims finds a real stale claimed row via its named-binding timestamptz comparison and requeues it through recoverAbandonedClaim', async () => {
    const leadId = await insertLead(mockPg);
    const staleClaimedAt = new Date(NOW.getTime() - callBookingLinkText.STALE_CLAIM_MS - 5 * 60 * 1000);
    const originalSendAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      metadata: {
        lead_id: leadId,
        call_booking_link_text: {
          status: 'claimed', lead_id: leadId, send_at: originalSendAt, original_send_at: originalSendAt, claimed_at: staleClaimedAt.toISOString(),
        },
      },
    });
    // A row that is NOT yet stale (claimed a moment ago) must be left alone.
    const freshLeadId = await insertLead(mockPg);
    const freshCallId = await insertCall(mockPg, {
      metadata: { lead_id: freshLeadId, call_booking_link_text: { status: 'claimed', lead_id: freshLeadId, send_at: originalSendAt, original_send_at: originalSendAt, claimed_at: NOW.toISOString() } },
    });

    const recovered = await callBookingLinkText.recoverStaleClaims(mockPg, NOW);
    expect(recovered).toBe(1);

    const row = await mockPg('call_log').where({ id: callId }).first('metadata');
    expect(row.metadata.call_booking_link_text).toMatchObject({ status: 'pending', lead_id: leadId, original_send_at: originalSendAt });

    const freshRow = await mockPg('call_log').where({ id: freshCallId }).first('metadata');
    expect(freshRow.metadata.call_booking_link_text.status).toBe('claimed'); // untouched — not yet stale
  });
});
