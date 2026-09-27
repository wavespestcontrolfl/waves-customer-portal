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
// hasPriorContact reads the db singleton, so it's stubbed here. The staging
// SELECT that feeds it (the dialed number) still runs for real.
jest.mock('../services/outbound-call-reason', () => ({
  ...jest.requireActual('../services/outbound-call-reason'),
  hasPriorContact: jest.fn(async () => true),
}));
jest.mock('../services/lead-consultation-link', () => ({
  ...jest.requireActual('../services/lead-consultation-link'),
  buildLeadConsultationSmsLine: jest.fn(),
}));
// codex #5018 r11 pre-push P1: neverSendRecheck's handoff_started_at stamp
// now writes through markerDb() rather than dbi/mockPg's own withSmsHandoff
// transaction — this dedicated connection would otherwise open against
// whatever database this process's OWN config resolves to (never this
// file's throwaway schema), so it must be redirected to mockPg like every
// other write here. The inner function is evaluated lazily (mockPg is
// assigned later, in beforeAll), matching visit-completion-summary-
// postgres.test.js's own established pattern for this exact mock.
jest.mock('../models/marker-db', () => () => mockPg);

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const callBookingLinkText = require('../services/call-booking-link-text');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { buildLeadConsultationSmsLine } = require('../services/lead-consultation-link');

const connection = process.env.CALL_BOOKING_LINK_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `call_booking_link_${randomUUID().replaceAll('-', '')}`;
// call_booking_link_text_handoffs (codex #5018 r13 P1, migration
// 20260927160000) is the ONE table this lane adds — the throwaway database
// this file runs against must be FULLY migrated (never the possibly-stale
// waves_test template alone) for it to exist in `public` before the clone
// below runs.
const TABLES = ['customers', 'leads', 'call_log', 'system_settings', 'scheduled_services', 'short_codes', 'sms_log', 'activity_log', 'call_booking_link_text_handoffs'];
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
// codex #5018 r11 P1: a populated service_address so
// computeDeterministicTriageFlags' address branch (fed through the
// canonical merge) never reads a real new-lead extraction's blank address
// as missing_service_address — real extractions always carry the caller's
// stated address.
function eligibleExtraction() {
  return {
    meta: {},
    call_nature: 'new_lead',
    recommended_disposition: 'callback_needed',
    triage_flags: [],
    caller: {},
    property: { property_type: 'single_family', service_address: { street_line_1: '123 Main St', city: 'Bradenton', postal_code: '34205' } },
    service_request: { service_intent: 'inspection_only' },
    scheduling: {},
    consent: {},
    sentiment_and_lead: {},
  };
}

// A genuine 4-turn, 2-speaker exchange (codex #5018 r11 P2) — every
// insertCall row below is otherwise-eligible by default, and
// hasRealTwoWayConversation must not false-block them.
const TWO_WAY_TRANSCRIPT = 'Caller: Hi, I have a bug problem.\nAgent: Sure, let me help with that.\nCaller: Can someone come out this week?\nAgent: Let me check the schedule.';

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
    // from_phone/transcription (codex #5018 r11 P1/P2): every real call_log
    // row has a dialable ANI and, once transcribed, a real transcript — the
    // canonical triage-flags merge's caller_phone_missing check and
    // hasRealTwoWayConversation both need them so an otherwise-eligible
    // fixture below isn't false-blocked ahead of whatever it's proving.
    from_phone: '+15555550100',
    transcription: TWO_WAY_TRANSCRIPT,
    duration_seconds: 120,
    v2_extraction_status: 'valid',
    processing_token: null,
    ai_address_validation: JSON.stringify({ status: 'validated_accept', inServiceArea: true }),
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
    // real column/type/CHECK drift instead of a hand-written stand-in.
    // call_booking_link_text_handoffs (codex #5018 r13 P1) is this lane's
    // one new table — every other table here needs no trailing migration
    // replayed forward into the clone, but the CONNECTION database itself
    // must already be fully migrated for that one to exist in `public`.
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
      // Timed so the computed send_at (call end + the 2h delay) lands only
      // ~3 minutes before NOW — within STAGING_STALE_MS's 60-minute cap,
      // not just the activation boundary and the 3-day lookback.
      created_at: new Date('2027-01-15T15:55:00.000Z'),
      updated_at: new Date('2027-01-15T15:55:00.000Z'), // well past the 15-min grace window
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

  test('stage() hands an OUTBOUND return call\'s dialed number to the prior-contact check (the real SELECT carries it)', async () => {
    const { hasPriorContact } = require('../services/outbound-call-reason');
    await mockPg('system_settings').insert({ key: callBookingLinkText.ACTIVATION_SETTINGS_KEY, value: new Date('2027-01-13T00:00:00.000Z').toISOString(), category: 'call_booking_link_text' });
    const leadId = await insertLead(mockPg, { phone: '+19415550123' });
    const callId = await insertCall(mockPg, {
      direction: 'outbound', from_phone: '+19412972817', to_phone: '+19415550123',
      metadata: { lead_id: leadId },
      created_at: new Date('2027-01-15T15:55:00.000Z'),
      updated_at: new Date('2027-01-15T15:55:00.000Z'),
    });

    await callBookingLinkText.stage(mockPg, { now: NOW });

    expect(hasPriorContact).toHaveBeenCalledWith(expect.objectContaining({ phone: '+19415550123' }));
    const row = await mockPg('call_log').where({ id: callId }).first('metadata');
    expect(row.metadata.call_booking_link_text).toMatchObject({ status: 'pending', lead_id: leadId });
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
      from_phone: '+15555550111', // the ANI — implied consent requires the destination to match it
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

  // codex #5018 r11 P1: dispatchClaimedCall's own withSmsHandoff must
  // acquire the SAME per-phone advisory lock the inbound STOP writer takes
  // (applyInboundOptout via lockSmsPhone) and hold it through the whole
  // handoff — proof a mocked knex cannot give, since pg_advisory_xact_lock
  // is a real Postgres primitive. sendCustomerMessage is mocked, so this
  // drives the mock to actually invoke the lane's withSmsHandoff (exactly
  // as send-customer-message.js's own wrapper does) with a dispatch that
  // probes the same lock key from a second real connection with a short
  // lock_timeout — a concurrent STOP write to this phone would collide the
  // same way.
  test('dispatchClaimedCall\'s withSmsHandoff holds the real per-phone lock the inbound STOP writer takes, through the whole handoff', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550333' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550333',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-2', line: 'Pick a time.\n\n', phone: '+15555550333' });
    let concurrentLockErrorCode = null;
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff }) => {
      expect(typeof withSmsHandoff).toBe('function');
      const verdict = await withSmsHandoff(async () => {
        // A second connection racing for the SAME phone key (the shape
        // applyInboundOptout's own lockSmsPhone call takes) must wait —
        // proving the handoff's transaction genuinely holds it, not just
        // reads a fresh row.
        await mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await require('../utils/customer-comms-lock').lockSmsPhone(trx, '+15555550333');
        }).catch((err) => { concurrentLockErrorCode = err.code; });
        return { ok: true };
      });
      return verdict.ok ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000003' } : { sent: false, ...verdict };
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: true, providerMessageId: 'SMtest0000000000000000000000003' });
    expect(concurrentLockErrorCode).toBe('55P03'); // lock_timeout — the real advisory lock was held
  });

  // codex #5018 r13 P1: the real proof a mocked knex cannot give — the
  // withSmsHandoff transaction (dbi) genuinely ROLLS BACK on a thrown error
  // (simulating messages.create() timing out), and dbi ALSO holds call_log
  // FOR UPDATE for the whole handoff, yet the handoff marker survives —
  // because it lives on its OWN table (call_booking_link_text_handoffs),
  // written through markerDb() (mocked to mockPg here, but via a call
  // OUTSIDE the handoff's own trx, on its own committed statement, and on
  // a DIFFERENT table than the one dbi/trx has locked). Before this fix
  // the marker lived on call_log.metadata itself and the ROLLBACK would
  // have discarded it right along with the throw; before THIS round's
  // fix, writing it to call_log at all — even via a separate connection —
  // would have deadlocked against dbi's own FOR UPDATE lock on that row.
  test('a thrown error inside the real withSmsHandoff transaction rolls that transaction back, but the handoff marker — on its own table, never call_log — survives', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550444' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550444',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-4', line: 'Pick a time.\n\n', phone: '+15555550444' });
    // Mirrors twilio.js's own real dispatch(): providerPreSendCheck runs
    // INSIDE the held handoff transaction, THEN onDispatchStart (codex
    // #5018 r15 P1 — the REAL attempt boundary, immediately before
    // dispatchStarted flips true and messages.create() runs, moved OFF
    // providerPreSendCheck itself), then the (simulated) SDK request fails
    // — a genuine post-marker throw, exactly like a provider timeout.
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck, onDispatchStart }) => withSmsHandoff(async (trx) => {
      const verdict = await providerPreSendCheck({ dbi: trx });
      if (!verdict.ok) return verdict;
      await onDispatchStart();
      throw new Error('provider timeout, no result');
    }));

    const call = await mockPg('call_log').where({ id: callId }).first();
    await expect(callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW)).rejects.toThrow('provider timeout, no result');

    const row = await mockPg('call_log').where({ id: callId }).first('metadata');
    expect(row.metadata.call_booking_link_text.status).toBe('claimed');
    expect(row.metadata.call_booking_link_text.handoff_started_at).toBeUndefined(); // never written to call_log at all
    const marker = await mockPg(callBookingLinkText.HANDOFF_MARKER_TABLE).where({ call_log_id: callId }).first();
    expect(marker).toBeTruthy(); // the marker row survived the rollback

    const outcome = await callBookingLinkText.recoverAbandonedClaim(mockPg, { ...call, metadata: row.metadata }, NOW);
    expect(outcome).toEqual({ ambiguous: true }); // never resent, exactly the contract this marker exists to prove
  });

  // codex #5018 r13 P1: the deadlock a mocked knex could not prove — dbi
  // holds call_log FOR UPDATE for the whole handoff, and the marker INSERT
  // (via markerDb(), a genuinely separate connection) must still complete
  // immediately, because it targets a DIFFERENT table with no lock on it.
  // Bounded jest timeout below: a regression that reintroduces the
  // call_log-targeting marker (or any other lock on the SAME row from a
  // second connection) would hang this test instead of failing it, so the
  // timeout itself is the safety net.
  test('the marker INSERT via markerDb() does not block while dbi holds call_log locked', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550777' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550777',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-7', line: 'Pick a time.\n\n', phone: '+15555550777' });
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck, onDispatchStart }) => {
      const verdict = await withSmsHandoff(async (trx) => {
        const v = await providerPreSendCheck({ dbi: trx });
        // codex #5018 r15 P1: onDispatchStart — never providerPreSendCheck
        // itself — is the write site now; invoked exactly as twilio.js
        // invokes it, immediately before the (simulated) provider request.
        if (v.ok) await onDispatchStart();
        return v;
      });
      return verdict.ok
        ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000007' }
        : { sent: false, ...verdict };
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await Promise.race([
      callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('TIMED OUT — the marker insert deadlocked against call_log\'s own FOR UPDATE lock')), 5000)),
    ]);

    expect(result).toEqual({ sent: true, providerMessageId: 'SMtest0000000000000000000000007' });
    const marker = await mockPg(callBookingLinkText.HANDOFF_MARKER_TABLE).where({ call_log_id: callId }).first();
    expect(marker).toBeTruthy();
  }, 10000);

  // codex #5018 r12 P1: neverSendRecheck's lead read must be locked FOR
  // UPDATE, on dbi — the SAME connection the phone-locked handoff holds —
  // so a concurrent phone correction (admin-leads.js's own shape:
  // `UPDATE leads SET phone = …` under a row lock) waits until this whole
  // handoff finishes rather than landing in the gap before
  // messages.create(). A mocked knex cannot prove a lock is genuinely
  // held; this drives a second real connection against the SAME row with
  // a short lock_timeout.
  test('neverSendRecheck\'s FOR UPDATE lead lock blocks a concurrent leads.phone UPDATE until the handoff finishes', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550555' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550555',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-5', line: 'Pick a time.\n\n', phone: '+15555550555' });
    let concurrentUpdateErrorCode = null;
    // Mirrors twilio.js's own real dispatch(): providerPreSendCheck runs
    // INSIDE the held handoff transaction, exactly where the real FOR
    // UPDATE lead lock is taken, before the (simulated) SDK request.
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck }) => {
      const verdict = await withSmsHandoff(async (trx) => {
        const check = await providerPreSendCheck({ dbi: trx });
        if (!check.ok) return check;
        await mockPg.transaction(async (trx2) => {
          await trx2.raw("SET LOCAL lock_timeout = '200ms'");
          await trx2('leads').where({ id: leadId }).update({ phone: '+15555559999' });
        }).catch((err) => { concurrentUpdateErrorCode = err.code; });
        return { ok: true };
      });
      return verdict.ok
        ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000005' }
        : { sent: false, ...verdict };
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: true, providerMessageId: 'SMtest0000000000000000000000005' });
    expect(concurrentUpdateErrorCode).toBe('55P03'); // lock_timeout — the real FOR UPDATE lock was held
    const lead = await mockPg('leads').where({ id: leadId }).first('phone');
    expect(lead.phone).toBe('+15555550555'); // the concurrent write never landed
  });

  // codex #5018 r13 P1: call_log gets the SAME treatment, taken AFTER
  // leads (the established processor order — see the service file's own
  // doc comment for the file:line evidence). A concurrent reprocessor
  // claim UPDATE (call-recording-processor.js's own shape:
  // processing_token/processing_status) on the SAME row must wait until
  // this whole handoff finishes.
  test('neverSendRecheck\'s FOR UPDATE call_log lock blocks a concurrent reprocessor claim UPDATE until the handoff finishes', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550666' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550666',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-6', line: 'Pick a time.\n\n', phone: '+15555550666' });
    let concurrentClaimErrorCode = null;
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck }) => {
      const verdict = await withSmsHandoff(async (trx) => {
        const check = await providerPreSendCheck({ dbi: trx });
        if (!check.ok) return check;
        await mockPg.transaction(async (trx2) => {
          await trx2.raw("SET LOCAL lock_timeout = '200ms'");
          await trx2('call_log').where({ id: callId }).update({ processing_token: 'reprocess-tok', processing_status: 'processing' });
        }).catch((err) => { concurrentClaimErrorCode = err.code; });
        return { ok: true };
      });
      return verdict.ok
        ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000006' }
        : { sent: false, ...verdict };
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: true, providerMessageId: 'SMtest0000000000000000000000006' });
    expect(concurrentClaimErrorCode).toBe('55P03'); // lock_timeout — the real FOR UPDATE call_log lock was held
    const row = await mockPg('call_log').where({ id: callId }).first('metadata', 'processing_token');
    expect(row.metadata.call_booking_link_text.status).toBe('sent'); // sent normally
    expect(row.processing_token).toBeNull(); // the concurrent reprocess claim never landed during the handoff
  });

  // codex #5018 r14 P1: consentedDestination's own check must re-run
  // against the FRESH extraction, not the stale one dispatchIneligibleReason
  // already cleared — a reprocess withdrawing a spoken alternate number's
  // consent (to null, not an explicit `false`) between there and the
  // handoff must still block the send.
  test('a reprocess withdrawing consent for the spoken destination between dispatch and the handoff blocks the send', async () => {
    const SPOKEN_DESTINATION = '+15555550888';
    const leadId = await insertLead(mockPg, { phone: SPOKEN_DESTINATION });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      // from_phone deliberately NOT the destination — only the spoken-
      // number consent branch (never the ANI-implied one) can cover it.
      from_phone: '+15555550100',
      ai_extraction_enriched: {
        ...eligibleExtraction(),
        caller: { phone_e164: SPOKEN_DESTINATION },
        consent: { sms_consent_given: true },
      },
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-8', line: 'Pick a time.\n\n', phone: SPOKEN_DESTINATION });
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck }) => {
      // Simulates a reprocess landing in the gap between dispatch's own
      // (stale) consent check and this handoff's own reload — withdrawn
      // to null, never an explicit `false`, the exact shape the earlier,
      // broader sms_consent_refused staging check cannot catch.
      await mockPg('call_log').where({ id: callId }).update({
        ai_extraction_enriched: JSON.stringify({ ...eligibleExtraction(), caller: { phone_e164: SPOKEN_DESTINATION }, consent: {} }),
      });
      const verdict = await withSmsHandoff((trx) => providerPreSendCheck({ dbi: trx }));
      return verdict.ok ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000008' } : { sent: false, ...verdict };
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: false, skipped: 'destination_not_consented' });
  });

  test('dispatchClaimedCall skips booked_since_call against a real scheduled_services row created after the call', async () => {
    const customerId = randomUUID();
    await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone: '+15555550222', address_line1: '1 Example St', city: 'Bradenton', zip: '34205' });
    const leadId = await insertLead(mockPg, { phone: '+15555550222', customer_id: customerId });
    const callCreatedAt = new Date('2027-01-15T10:00:00.000Z');
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      created_at: callCreatedAt, updated_at: callCreatedAt,
      // created_customer_id matches the lead's customer_id: this call itself
      // created/owns that customer, so the new existing_customer check (fix
      // #2, codex #5018 r10) exempts it and lets the booked_since_call check
      // below be the one this test actually exercises.
      metadata: { lead_id: leadId, created_customer_id: customerId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
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

  // codex #5018 r15 P2: a booking for a customer staff quick-added straight
  // from the appointment modal, WITHOUT ever linking this lead — the lead's
  // own customer_id stays null throughout, so only a phone match (via the
  // real nanpStoredPhoneClause join, a mocked knex cannot compile) catches
  // it.
  test('dispatchClaimedCall skips booked_since_call for a booking through a customer never linked to the lead, matched only by phone', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550666', customer_id: null });
    const unlinkedCustomerId = randomUUID();
    await mockPg('customers').insert({
      id: unlinkedCustomerId, first_name: 'Quick', last_name: 'Added', phone: '+15555550666',
      address_line1: '2 Example St', city: 'Bradenton', zip: '34205',
    });
    const callCreatedAt = new Date('2027-01-15T10:00:00.000Z');
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550666', created_at: callCreatedAt, updated_at: callCreatedAt,
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    await mockPg('scheduled_services').insert({
      id: randomUUID(), customer_id: unlinkedCustomerId, scheduled_date: '2027-01-20', service_type: 'Pest Control', status: 'pending',
      created_at: new Date(callCreatedAt.getTime() + 60 * 60 * 1000), // booked an hour after the call started
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: false, skipped: 'booked_since_call' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // codex #5018 r15 P2: proof a mocked knex/sendCustomerMessage cannot give
  // — a manual send (admin-leads.js's own withSmsHandoff, the SAME
  // lockSmsPhone key) already holding the phone lock genuinely blocks this
  // worker's own attempt until the manual send's transaction commits, so
  // the two can never interleave. Once released, the worker's own final
  // linkSentRecently recheck sees the now-delivered link and skips, rather
  // than sending a second one.
  test('a manual send holding the phone lock makes the worker wait, then the worker sees the delivered link and skips', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550888' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550888',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    const mintedAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    await mockPg('short_codes').insert({ id: randomUUID(), code: 'zz99', target_url: 'https://portal.example.com/inspection/tok-9', kind: 'consultation', entity_type: 'leads', entity_id: leadId, created_at: mintedAt, updated_at: mintedAt });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-9', line: 'Pick a time.\n\n', phone: '+15555550888' });
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck, onDispatchStart }) => {
      const verdict = await withSmsHandoff(async (trx) => {
        const v = await providerPreSendCheck({ dbi: trx });
        if (v.ok) await onDispatchStart();
        return v;
      });
      return verdict.ok
        ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000009' }
        : { sent: false, ...verdict };
    });

    const { lockSmsPhone } = require('../utils/customer-comms-lock');
    let releaseManualSend;
    const manualSendHeld = new Promise((resolve) => { releaseManualSend = resolve; });
    const manualSendTx = mockPg.transaction(async (trx) => {
      await lockSmsPhone(trx, '+15555550888');
      // The manual send's own write, landing WHILE it still holds the lock
      // — matching admin-leads.js's real ordering (lock the phone, then
      // send and record) — is the evidence the worker's own recheck must
      // see AFTER the lock releases.
      await trx('sms_log').insert({
        id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: '+15555550888', status: 'accepted',
        message_body: 'Pick a time: https://portal.example.com/l/zz99', created_at: new Date(),
      });
      await manualSendHeld; // held open until this test explicitly releases it
    });

    // Give the manual transaction a moment to actually acquire the lock
    // (and commit its own INSERT within it) before the worker starts.
    await new Promise((r) => setTimeout(r, 100));

    const call = await mockPg('call_log').where({ id: callId }).first();
    const workerPromise = callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    // The worker's own withSmsHandoff is now genuinely blocked on the SAME
    // advisory key (pg_advisory_xact_lock waits, it does not error) — this
    // is the real proof no mocked knex can give.
    await new Promise((r) => setTimeout(r, 200));
    releaseManualSend();
    await manualSendTx;

    const result = await workerPromise;
    expect(result).toEqual({ sent: false, skipped: 'link_sent_recently' });
  }, 10000);

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
      from_phone: '+15555550333', // the ANI — implied consent requires the destination to match it
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

  // #5018 follow-up: linkSentRecently used to pull only the 20 newest
  // short_codes minted in the window (the manual composer mints one on
  // every open, sent or not, so a busy lead can easily mint more than 20 in
  // 14 days) and check sms_log only for those. A lead with 21+ minted codes
  // could hide an older code that WAS actually texted behind 20 newer opens
  // that never sent, so this worker would text the same person twice inside
  // the 14-day window. Mint 21 codes, oldest first, and put the ONLY real
  // accepted send on the OLDEST one — the one a `.limit(20)` newest-first
  // read would have dropped. linkSentRecently must still see it and skip.
  test('linkSentRecently finds a real send on the OLDEST of 21+ minted codes, past any old newest-20 cap', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550777' });
    const oldestCode = 'aa000';
    const oldestMintedAt = new Date(NOW.getTime() - 13 * 24 * 60 * 60 * 1000);
    await mockPg('short_codes').insert({
      id: randomUUID(), code: oldestCode, target_url: 'https://portal.example.com/inspection/tok-old',
      kind: 'consultation', entity_type: 'leads', entity_id: leadId,
      created_at: oldestMintedAt, updated_at: oldestMintedAt,
    });
    // The evidence: a real accepted outbound send carrying the OLDEST code.
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: '+15555550777', status: 'accepted',
      message_body: 'Pick a time: https://portal.example.com/l/aa000', created_at: oldestMintedAt,
    });
    // 21 more, newer, never-sent codes — every open of the manual composer
    // that closed without a Send. These are the ones a `.limit(20)`
    // newest-first read would have kept instead of the real send above.
    for (let i = 0; i < 21; i += 1) {
      const mintedAt = new Date(oldestMintedAt.getTime() + (i + 1) * 60 * 60 * 1000);
      await mockPg('short_codes').insert({
        id: randomUUID(), code: `nn${String(i).padStart(3, '0')}`, target_url: `https://portal.example.com/inspection/tok-${i}`,
        kind: 'consultation', entity_type: 'leads', entity_id: leadId, created_at: mintedAt, updated_at: mintedAt,
      });
    }

    const result = await callBookingLinkText._private.linkSentRecently(mockPg, leadId, NOW);
    expect(result).toBe(true);
  });

  // codex r3 P2 (this round) — new raw SQL added alongside the earlier
  // jsonb_build_object fix: recoverStaleClaims'/recoverAbandonedClaim's own
  // named-binding comparisons. The same class of bug (a mocked knex cannot
  // see a real Postgres parser rejection) could just as easily hide here.
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

  // codex r8 P2 — the real batch-ordering behavior a mocked query can't
  // fully prove: 60 permanently-ambiguous rows (handoff_started_at set),
  // all OLDER than one genuinely recoverable row, sorted oldest-first
  // under a real ORDER BY/LIMIT. Before this fix, each stayed 'claimed'
  // forever with no write, so they occupied the whole batch window on
  // every future sweep; now each is moved to 'ambiguous' the first time
  // it's found, so a second sweep's own real SELECT reaches the
  // recoverable row.
  test('60 real ambiguous rows older than one recoverable row do not starve it across repeated real sweeps', async () => {
    const leadId = await insertLead(mockPg);
    const staleClaimedAt = new Date(NOW.getTime() - callBookingLinkText.STALE_CLAIM_MS - 5 * 60 * 1000);
    const originalSendAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 60; i += 1) {
      // created_at strictly increasing but all older than the recoverable
      // row below — oldest-first ORDER BY puts every one of these ahead of
      // it, the worst case for the starvation this fixes.
      const createdAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000 + i * 1000);
      const ambiguousCallId = await insertCall(mockPg, {
        created_at: createdAt, updated_at: createdAt,
        metadata: {
          lead_id: leadId,
          call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at: originalSendAt, original_send_at: originalSendAt, claimed_at: staleClaimedAt.toISOString() },
        },
      });
      // codex #5018 r13 P1: "already-ambiguous" now means a marker row
      // exists, not a call_log.metadata field.
      await mockPg(callBookingLinkText.HANDOFF_MARKER_TABLE).insert({ call_log_id: ambiguousCallId, handoff_started_at: staleClaimedAt });
    }
    const recoverableCreatedAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000 + 60 * 1000); // the newest — sorts LAST
    const recoverableCallId = await insertCall(mockPg, {
      created_at: recoverableCreatedAt, updated_at: recoverableCreatedAt,
      metadata: {
        lead_id: leadId,
        call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at: originalSendAt, original_send_at: originalSendAt, claimed_at: staleClaimedAt.toISOString() },
      },
    });

    const firstSweep = await callBookingLinkText.recoverStaleClaims(mockPg, NOW);
    expect(firstSweep).toBe(0); // the first batch is entirely the older, ambiguous rows
    const stillClaimedAfterFirst = await mockPg('call_log').whereRaw("metadata->'call_booking_link_text'->>'status' = 'claimed'").count('* as n').first();
    expect(Number(stillClaimedAfterFirst.n)).toBe(11); // 10 remaining ambiguous + the 1 recoverable

    const secondSweep = await callBookingLinkText.recoverStaleClaims(mockPg, NOW);
    expect(secondSweep).toBe(1); // the recoverable row is finally reached
    const recoverableRow = await mockPg('call_log').where({ id: recoverableCallId }).first('metadata');
    expect(recoverableRow.metadata.call_booking_link_text.status).toBe('pending'); // recovered, never starved
    const stillClaimedAfterSecond = await mockPg('call_log').whereRaw("metadata->'call_booking_link_text'->>'status' = 'claimed'").count('* as n').first();
    expect(Number(stillClaimedAfterSecond.n)).toBe(0);
  });

  // codex #5018 r10 P2: the candidate SELECT bounds created_at to
  // QUEUE_SCAN_LOOKBACK_MS via a real WHERE, not just a JS-level
  // assertion — an "ancient" claimed row (older than any row could
  // LEGITIMATELY still be) is excluded from the scan outright, while a
  // genuinely stale (but recent) one is still found and recovered.
  test('the real created_at bound excludes an ancient claimed row from the scan while still recovering a recent stale one', async () => {
    const leadId = await insertLead(mockPg);
    const staleClaimedAt = new Date(NOW.getTime() - callBookingLinkText.STALE_CLAIM_MS - 5 * 60 * 1000);
    const originalSendAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const ancientCreatedAt = new Date(NOW.getTime() - callBookingLinkText.QUEUE_SCAN_LOOKBACK_MS - 24 * 60 * 60 * 1000); // a day past the bound
    const ancientCallId = await insertCall(mockPg, {
      created_at: ancientCreatedAt, updated_at: ancientCreatedAt,
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at: originalSendAt, original_send_at: originalSendAt, claimed_at: staleClaimedAt.toISOString() } },
    });
    const recentCallId = await insertCall(mockPg, {
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at: originalSendAt, original_send_at: originalSendAt, claimed_at: staleClaimedAt.toISOString() } },
    });

    const recovered = await callBookingLinkText.recoverStaleClaims(mockPg, NOW);
    expect(recovered).toBe(1); // only the recent row — the ancient one is outside the scan's own bound

    const ancientRow = await mockPg('call_log').where({ id: ancientCallId }).first('metadata');
    expect(ancientRow.metadata.call_booking_link_text.status).toBe('claimed'); // untouched — never even scanned
    const recentRow = await mockPg('call_log').where({ id: recentCallId }).first('metadata');
    expect(recentRow.metadata.call_booking_link_text.status).toBe('pending'); // recovered normally
  });

  // codex #5018 r13 P1: housekeeping — a real Postgres proof that the
  // bounded DELETE prunes only rows past HANDOFF_MARKER_RETENTION_MS,
  // leaving a recent marker (still meaningful to recoverAbandonedClaim)
  // untouched.
  test('pruneHandoffMarkers deletes only handoff marker rows older than HANDOFF_MARKER_RETENTION_MS', async () => {
    const oldCallId = await insertCall(mockPg);
    const recentCallId = await insertCall(mockPg);
    const oldStamp = new Date(NOW.getTime() - callBookingLinkText.HANDOFF_MARKER_RETENTION_MS - 60 * 60 * 1000); // a day-ish past retention
    const recentStamp = new Date(NOW.getTime() - 60 * 60 * 1000); // well within retention
    await mockPg(callBookingLinkText.HANDOFF_MARKER_TABLE).insert({ call_log_id: oldCallId, handoff_started_at: oldStamp });
    await mockPg(callBookingLinkText.HANDOFF_MARKER_TABLE).insert({ call_log_id: recentCallId, handoff_started_at: recentStamp });

    const deleted = await callBookingLinkText.pruneHandoffMarkers(mockPg, NOW);
    expect(deleted).toBe(1);
    const oldMarker = await mockPg(callBookingLinkText.HANDOFF_MARKER_TABLE).where({ call_log_id: oldCallId }).first();
    expect(oldMarker).toBeUndefined(); // pruned
    const recentMarker = await mockPg(callBookingLinkText.HANDOFF_MARKER_TABLE).where({ call_log_id: recentCallId }).first();
    expect(recentMarker).toBeTruthy(); // kept — still meaningful to recoverAbandonedClaim
  });
});
