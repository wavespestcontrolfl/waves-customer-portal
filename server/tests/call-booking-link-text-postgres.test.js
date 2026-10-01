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
// codex #5018 P2: the long-form /inspection/<token> section below is the
// one exception to "free of consultation-token signing setup" above — a
// long-form match genuinely requires composer-customer-links.js's real
// signature verification (never hand-rolled), so a JWT_SECRET fallback is
// unavoidable there. Harmless for every other test in this file, which
// never touches token minting/verification.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
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
// codex #5196 P1-A: required at module scope, not inside the test that uses
// it — routes/admin-customers.js's own require graph is large enough that
// loading it for the first time costs several real seconds under Jest's
// transform, which blew past that one test's own timeout when the require
// sat inside its body. Paying that cost once here, during this file's
// normal module-load phase, keeps it out of any individual test's budget.
const { ensureCustomerAccount } = require('../routes/admin-customers');

const connection = process.env.CALL_BOOKING_LINK_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `call_booking_link_${randomUUID().replaceAll('-', '')}`;
// call_booking_link_text_handoffs (codex #5018 r13 P1, migration
// 20260927160000) and consultation_link_send_attempts (codex #5196
// follow-up, migration 20260928130000) are the two tables this lane adds —
// the throwaway database this file runs against must be FULLY migrated
// (never the possibly-stale waves_test template alone) for either to exist
// in `public` before the clone below runs.
// customer_accounts (codex #5196 P1-A): ensureCustomerAccount's own account
// row — needed once the quick-add lock-fence test below drives that real
// function, not merely a `customers` insert.
const TABLES = ['customers', 'customer_accounts', 'leads', 'call_log', 'system_settings', 'scheduled_services', 'short_codes', 'sms_log', 'activity_log', 'call_booking_link_text_handoffs', 'consultation_link_send_attempts', 'estimates'];
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
    consent: { sms_declined: false },
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
  // codex #5196 P1 scenario: the SAME rollback also proves
  // consultation_link_send_attempts — written in the SAME markerDb()
  // transaction as the handoff marker — survives too, and that a QUEUED
  // WAITER's own linkSentRecently read (on a genuinely separate connection,
  // never mockPg's own trx) sees it despite the outer transaction's
  // rollback. This is the durable evidence that closes the gap twilio.js's
  // own comment describes: an accepted send whose outer transaction then
  // fails to commit releases lockSmsPhone before a competing sender can see
  // either the rolled-back sms_log row or a marker.
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

    // codex #5196 P1: the shared attempt row survived the SAME rollback,
    // and a queued waiter's own linkSentRecently read (its own connection,
    // never mockPg's trx) sees it — the exact evidence the P1 finding says
    // a competing sender needs.
    const attempt = await mockPg(callBookingLinkText.CONSULTATION_ATTEMPT_TABLE).where({ call_log_id: callId }).first();
    expect(attempt).toMatchObject({ lead_id: leadId, to_phone: '+15555550444', source: 'call_booking_link_text' });
    // The attempt row is stamped with the real clock (started_at: new
    // Date(), as in production), not this file's fixed NOW, so the waiter's
    // read uses the real clock too.
    const readAt = new Date();
    await expect(callBookingLinkText.linkSentRecently(mockPg, leadId, readAt)).resolves.toBe(true);
    await expect(callBookingLinkText.linkSentRecently(mockPg, leadId, readAt, { matchPhone: '+15555550444' })).resolves.toBe(true);

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
        consent: { sms_consent_given: true, sms_declined: false },
      },
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-8', line: 'Pick a time.\n\n', phone: SPOKEN_DESTINATION });
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck }) => {
      // Simulates a reprocess landing in the gap between dispatch's own
      // (stale) consent check and this handoff's own reload — withdrawn
      // to null — staging never judges the destination number itself.
      await mockPg('call_log').where({ id: callId }).update({
        ai_extraction_enriched: JSON.stringify({ ...eligibleExtraction(), caller: { phone_e164: SPOKEN_DESTINATION }, consent: { sms_declined: false } }),
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

  // ── smsDeclinedOnEarlierCall — codex P1 on #5292 ────────────────────────
  // The dedicated consent.sms_declined check judges only the CURRENT call's
  // own extraction — this cross-call query is the raw SQL a mocked knex
  // cannot prove: the phone-scoped OR across from_phone/to_phone, the
  // valid-only + created_at <= asOf filters, the sandbox exclusion, and the
  // "most recent decisive row wins" ORDER BY.
  describe('smsDeclinedOnEarlierCall (codex P1 on #5292)', () => {
    test('an earlier call with an explicit decline blocks, even though the call under judgment never discussed texting', async () => {
      const phone = '+15555550301';
      const leadId = await insertLead(mockPg, { phone });
      const earlierCallId = await insertCall(mockPg, {
        from_phone: phone,
        ai_extraction_enriched: { ...eligibleExtraction(), consent: { sms_declined: true } },
        created_at: new Date('2027-01-10T12:00:00.000Z'), updated_at: new Date('2027-01-10T12:00:00.000Z'),
      });
      // The call actually under judgment: its OWN extraction never mentions
      // consent either way — the exact gap the dedicated per-call check
      // cannot close on its own.
      const currentCallId = await insertCall(mockPg, {
        from_phone: phone, metadata: { lead_id: leadId },
        ai_extraction_enriched: { ...eligibleExtraction(), consent: {} },
        created_at: new Date('2027-01-15T10:00:00.000Z'), updated_at: new Date('2027-01-15T10:00:00.000Z'),
      });

      const result = await callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, phone, { originCallId: currentCallId, asOf: NOW },
      );
      expect(result).toBe(true);
      void earlierCallId;
    });

    // codex r5 P1: a decline about the number the caller SPOKE on an
    // earlier call (from ANI A, "call me at B, don't text it") blocks a
    // later send to B.
    test('a decline about a spoken callback number on an earlier call blocks that number', async () => {
      const ani = '+15555550311';
      const spoken = '+15555550312';
      await insertLead(mockPg, { phone: spoken });
      await insertCall(mockPg, {
        from_phone: ani,
        ai_extraction_enriched: { ...eligibleExtraction(), caller: { ...eligibleExtraction().caller, phone_e164: spoken }, consent: { sms_declined: true } },
        created_at: new Date('2027-01-05T12:00:00.000Z'), updated_at: new Date('2027-01-05T12:00:00.000Z'),
      });

      const result = await callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, spoken, { originCallId: null, asOf: NOW },
      );
      expect(result).toBe(true);
    });

    // Pre-1.19 earlier calls carry no sms_declined, so an explicit "no" on
    // them is unrecoverable. They count as a possible decline (fail closed);
    // the call under judgment itself is exempt.
    test('an earlier pre-1.19 call (no sms_declined recorded) blocks; the origin call itself does not', async () => {
      const phone = '+15555550321';
      await insertLead(mockPg, { phone });
      const legacyConsent = { sms_consent_given: false, do_not_contact_request: false };
      const originId = await insertCall(mockPg, {
        from_phone: phone,
        ai_extraction_enriched: { ...eligibleExtraction(), consent: legacyConsent },
        created_at: new Date('2027-01-10T12:00:00.000Z'), updated_at: new Date('2027-01-10T12:00:00.000Z'),
      });
      await expect(callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, phone, { originCallId: originId, asOf: NOW },
      )).resolves.toBe(false);

      await insertCall(mockPg, {
        from_phone: phone,
        ai_extraction_enriched: { ...eligibleExtraction(), consent: legacyConsent },
        created_at: new Date('2027-01-05T12:00:00.000Z'), updated_at: new Date('2027-01-05T12:00:00.000Z'),
      });
      await expect(callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, phone, { originCallId: originId, asOf: NOW },
      )).resolves.toBe(true);
    });

    test('an earlier call with sms_declined: null also blocks (fail closed)', async () => {
      const phone = '+15555550331';
      await insertLead(mockPg, { phone });
      await insertCall(mockPg, {
        from_phone: phone,
        ai_extraction_enriched: { ...eligibleExtraction(), consent: { sms_declined: null } },
        created_at: new Date('2027-01-05T12:00:00.000Z'), updated_at: new Date('2027-01-05T12:00:00.000Z'),
      });
      await expect(callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, phone, { originCallId: null, asOf: NOW },
      )).resolves.toBe(true);
    });

    test('a later explicit opt-in does NOT clear an earlier decline (owner ruling 2026-09-29)', async () => {
      const phone = '+15555550302';
      await insertLead(mockPg, { phone });
      await insertCall(mockPg, {
        from_phone: phone,
        ai_extraction_enriched: { ...eligibleExtraction(), consent: { sms_declined: true } },
        created_at: new Date('2027-01-05T12:00:00.000Z'), updated_at: new Date('2027-01-05T12:00:00.000Z'),
      });
      await insertCall(mockPg, {
        from_phone: phone,
        ai_extraction_enriched: { ...eligibleExtraction(), consent: { sms_declined: false, sms_consent_given: true } },
        created_at: new Date('2027-01-10T12:00:00.000Z'), updated_at: new Date('2027-01-10T12:00:00.000Z'),
      });

      const result = await callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, phone, { originCallId: null, asOf: NOW },
      );
      expect(result).toBe(true);
    });

    test('no earlier decisive call at all does not block', async () => {
      const phone = '+15555550303';
      await insertLead(mockPg, { phone });
      // A 1.19+ call where texting never came up (sms_declined: false). A
      // pre-1.19 call would count as a possible decline (test above).
      await insertCall(mockPg, {
        from_phone: phone, ai_extraction_enriched: { ...eligibleExtraction(), consent: { sms_declined: false } },
        created_at: new Date('2027-01-10T12:00:00.000Z'), updated_at: new Date('2027-01-10T12:00:00.000Z'),
      });

      const result = await callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, phone, { originCallId: null, asOf: NOW },
      );
      expect(result).toBe(false);
    });

    test('a decline recorded against a DIFFERENT phone does not block', async () => {
      const otherPhone = '+15555550304';
      await insertLead(mockPg, { phone: otherPhone });
      await insertCall(mockPg, {
        from_phone: otherPhone,
        ai_extraction_enriched: { ...eligibleExtraction(), consent: { sms_declined: true } },
        created_at: new Date('2027-01-10T12:00:00.000Z'), updated_at: new Date('2027-01-10T12:00:00.000Z'),
      });

      const result = await callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, '+15555550399', { originCallId: null, asOf: NOW },
      );
      expect(result).toBe(false);
    });

    // A voice-relay sandbox test call's extraction says nothing about a
    // real caller — excluded here the same way callsWith/whereNotSandboxCall
    // exclude it everywhere else in this lane.
    test('a decline on a sandbox test call is excluded', async () => {
      const phone = '+15555550305';
      await insertLead(mockPg, { phone });
      await insertCall(mockPg, {
        from_phone: phone, source: 'voice_relay_sandbox',
        ai_extraction_enriched: { ...eligibleExtraction(), consent: { sms_declined: true } },
        created_at: new Date('2027-01-10T12:00:00.000Z'), updated_at: new Date('2027-01-10T12:00:00.000Z'),
      });

      const result = await callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, phone, { originCallId: null, asOf: NOW },
      );
      expect(result).toBe(false);
    });

    // A decline that, from the point of view of the call under judgment,
    // has not happened yet must never count — asOf bounds the search to
    // calls strictly at or before the instant being judged.
    test('a decline recorded AFTER asOf does not block', async () => {
      const phone = '+15555550306';
      await insertLead(mockPg, { phone });
      await insertCall(mockPg, {
        from_phone: phone,
        ai_extraction_enriched: { ...eligibleExtraction(), consent: { sms_declined: true } },
        created_at: new Date(NOW.getTime() + 60 * 60 * 1000), updated_at: new Date(NOW.getTime() + 60 * 60 * 1000),
      });

      const result = await callBookingLinkText._private.smsDeclinedOnEarlierCall(
        mockPg, phone, { originCallId: null, asOf: NOW },
      );
      expect(result).toBe(false);
    });

    // Full wiring, end to end: dispatchClaimedCall itself must skip on this
    // cross-call evidence, not only the bare helper.
    test('dispatchClaimedCall skips sms_declined_earlier_call against a real earlier call, even though this call\'s own extraction never declined', async () => {
      const phone = '+15555550307';
      const leadId = await insertLead(mockPg, { phone });
      await insertCall(mockPg, {
        from_phone: phone,
        ai_extraction_enriched: { ...eligibleExtraction(), consent: { sms_declined: true } },
        created_at: new Date('2027-01-10T12:00:00.000Z'), updated_at: new Date('2027-01-10T12:00:00.000Z'),
      });
      const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
      const currentCallId = await insertCall(mockPg, {
        from_phone: phone,
        metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
        created_at: new Date('2027-01-15T10:00:00.000Z'), updated_at: new Date('2027-01-15T10:00:00.000Z'),
      });

      const call = await mockPg('call_log').where({ id: currentCallId }).first();
      const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

      expect(result).toEqual({ sent: false, skipped: 'sms_declined_earlier_call' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  // codex #5018 pre-push P2 (2nd finding): a booking for a customer staff
  // quick-added straight from the appointment modal — matched only by
  // phone, never linked to this lead — can commit BETWEEN the earlier
  // (staging-time) bookedSinceCall SELECT above and this handoff's own
  // final recheck. neverSendRecheck now takes lockCustomerComms for every
  // customer bookedSinceCall would consider (the phone match here) BEFORE
  // its own final bookedSinceCall lookup — the SAME lock the booking writer
  // (admin-schedule.js POST /api/admin/schedule, and admin-leads.js's own
  // lead-conversion booking flow) takes before its customer row lock and
  // scheduled_services insert. A concurrent booking writer holding that
  // lock genuinely blocks this handoff (a mocked knex cannot prove a lock
  // is really held) until it commits, and the handoff's own recheck then
  // sees the just-committed booking and refuses to send.
  test('a booking writer holding customer-comms for a phone-matched customer makes the handoff wait, then the handoff sees the booking and does not send', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550999', customer_id: null });
    const unlinkedCustomerId = randomUUID();
    await mockPg('customers').insert({
      id: unlinkedCustomerId, first_name: 'Quick', last_name: 'Added', phone: '+15555550999',
      address_line1: '3 Example St', city: 'Bradenton', zip: '34205',
    });
    const callCreatedAt = new Date('2027-01-15T10:00:00.000Z');
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550999', created_at: callCreatedAt, updated_at: callCreatedAt,
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-9b', line: 'Pick a time.\n\n', phone: '+15555550999' });
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck, onDispatchStart }) => {
      const verdict = await withSmsHandoff(async (trx) => {
        const v = await providerPreSendCheck({ dbi: trx });
        if (v.ok) await onDispatchStart();
        return v;
      });
      return verdict.ok
        ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest000000000000000000000000b' }
        : { sent: false, ...verdict };
    });

    const { lockCustomerComms } = require('../utils/customer-comms-lock');
    let releaseBookingWriter;
    const bookingWriterHeld = new Promise((resolve) => { releaseBookingWriter = resolve; });
    const bookingWriterTx = mockPg.transaction(async (trx) => {
      // The real booking writers' own order: customer-comms FIRST, then the
      // scheduled_services insert — while still holding the lock.
      await lockCustomerComms(trx, unlinkedCustomerId);
      await trx('scheduled_services').insert({
        id: randomUUID(), customer_id: unlinkedCustomerId, scheduled_date: '2027-01-20', service_type: 'Pest Control', status: 'pending',
        created_at: new Date(callCreatedAt.getTime() + 60 * 60 * 1000), // booked an hour after the call started
      });
      await bookingWriterHeld; // held open until this test explicitly releases it
    });

    // Give the booking-writer transaction a moment to actually acquire the
    // lock (and commit its own INSERT within it) before the handoff starts.
    await new Promise((r) => setTimeout(r, 100));

    const call = await mockPg('call_log').where({ id: callId }).first();
    const handoffPromise = callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    // The handoff's own withSmsHandoff is now genuinely blocked on the SAME
    // advisory key the booking writer holds (pg_advisory_xact_lock waits,
    // it does not error) — this is the real proof no mocked knex can give.
    await new Promise((r) => setTimeout(r, 200));
    releaseBookingWriter();
    await bookingWriterTx;

    const result = await handoffPromise;
    expect(result).toEqual({ sent: false, skipped: 'booked_since_call' });
  }, 10000);

  // codex #5018 r15/r16 P1 follow-up: the phone-match candidate ids
  // withSmsHandoff locks with lockCustomerComms are read BEFORE any of its
  // own locks — a customer quick-added for this exact destination phone in
  // the gap between that read and the handoff's own lockSmsPhone
  // acquisition is never locked at all, so a booking committed for it could
  // race straight past bookedSinceCall's own fenced read. Proof a mocked
  // knex cannot give: hold the REAL phone lock before the handoff starts
  // (forcing it to block AFTER its own initial, empty candidate read but
  // BEFORE its post-lock re-check), insert the new customer while it waits,
  // then release — the re-check must see the widened set and defer through
  // the ordinary retry rail rather than sending to someone the handoff
  // never actually fenced.
  test('a customer inserted for this destination phone while the handoff waits on the phone lock defers to the next sweep, never sending unfenced', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555551050', customer_id: null });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555551050',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-9c', line: 'Pick a time.\n\n', phone: '+15555551050' });
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck, onDispatchStart }) => {
      const verdict = await withSmsHandoff(async (trx) => {
        const v = await providerPreSendCheck({ dbi: trx });
        if (v.ok) await onDispatchStart();
        return v;
      });
      // deliveryOutcome: 'not_sent' (real twilio.js's own mapping for a
      // withSmsHandoff verdict that never reached dispatch — see its
      // `preSendBlocked` branch) — without it, isAmbiguousProviderOutcome's
      // OWN real implementation (unmocked in this file) reads a bare
      // `retryable: true` with no deliveryOutcome as ambiguous, not
      // retryable, the same way a genuinely uncertain provider outcome
      // would. The candidate-set-changed verdict below is never ambiguous
      // — dispatch was never entered at all.
      return verdict.ok
        ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest000000000000000000000000c' }
        : { sent: false, deliveryOutcome: 'not_sent', ...verdict };
    });

    const { lockSmsPhone } = require('../utils/customer-comms-lock');
    let releasePhoneHold;
    const phoneHoldHeld = new Promise((resolve) => { releasePhoneHold = resolve; });
    const phoneHoldTx = mockPg.transaction(async (trx) => {
      await lockSmsPhone(trx, '+15555551050');
      await phoneHoldHeld; // held open until this test explicitly releases it
    });

    // Give the phone-hold transaction a moment to actually acquire the
    // lock before the handoff starts — its own initial (empty) candidate
    // read runs BEFORE it ever reaches lockSmsPhone, so this only blocks
    // the handoff AFTER that first read has already found nothing.
    await new Promise((r) => setTimeout(r, 100));

    const call = await mockPg('call_log').where({ id: callId }).first();
    const handoffPromise = callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    // The handoff is now genuinely blocked on lockSmsPhone. Quick-add the
    // matching customer WHILE it waits — landing squarely in the gap this
    // follow-up closes.
    await new Promise((r) => setTimeout(r, 200));
    const quickAddedCustomerId = randomUUID();
    await mockPg('customers').insert({
      id: quickAddedCustomerId, first_name: 'Quick', last_name: 'Added', phone: '+15555551050',
      address_line1: '9 Example St', city: 'Bradenton', zip: '34205',
    });
    releasePhoneHold();
    await phoneHoldTx;

    const result = await handoffPromise;
    expect(result).toEqual({ sent: false, skipped: 'candidate_customer_set_changed', deferred: true });
    expect(sendCustomerMessage).toHaveBeenCalled();
    // The row requeues as pending rather than a permanent skip — the next
    // sweep tick re-resolves the full candidate set, quick-added customer
    // included, under its own fresh locks.
    const refreshed = await mockPg('call_log').where({ id: callId }).first('metadata');
    expect(refreshed.metadata.call_booking_link_text.status).toBe('pending');
  }, 10000);

  // codex #5196 P1-A: the structural fix for the race the test above proves
  // — quick-add's own customer CREATION (routes/admin-customers.js
  // ensureCustomerAccount, lockPhone: true) now takes this SAME lockSmsPhone
  // key as the first statement of its own insert transaction, before its
  // own duplicate/phone lookup. Proof a mocked knex cannot give: hold the
  // real phone lock, start quick-add's own ensureCustomerAccount against a
  // SEPARATE real connection, and show it genuinely blocks — never even
  // reaching its duplicate lookup or insert — until the phone lock releases.
  test('quick-add customer creation blocks on the SAME phone lock a handoff holds, and only lands once it releases', async () => {
    const phone = '+15555551090';

    const { lockSmsPhone } = require('../utils/customer-comms-lock');
    let releasePhoneHold;
    const phoneHoldHeld = new Promise((resolve) => { releasePhoneHold = resolve; });
    const phoneHoldTx = mockPg.transaction(async (trx) => {
      await lockSmsPhone(trx, phone);
      await phoneHoldHeld; // held open until this test explicitly releases it
    });

    // Give the phone-hold transaction a moment to actually acquire the lock
    // before quick-add starts.
    await new Promise((r) => setTimeout(r, 100));

    let quickAddSettled = false;
    const quickAddPromise = mockPg.transaction(async (trx) => {
      // The exact call quick-add's own route makes (routes/admin-customers.js
      // POST /quick-add): lockPhone: true, before findAccountByContact's own
      // duplicate/phone lookup.
      const account = await ensureCustomerAccount(trx, {
        firstName: 'Quick', lastName: 'Added', phone, email: null, lockPhone: true, fenceAttach: true,
      });
      const [created] = await trx('customers').insert({
        account_id: account.accountId, is_primary_profile: true, profile_label: 'Primary',
        first_name: 'Quick', last_name: 'Added', phone, address_line1: '9 Example St', city: 'Bradenton', zip: '34205',
      }).returning('*');
      return created;
    }).then((row) => { quickAddSettled = true; return row; });

    // Give quick-add's own transaction a moment to reach — and genuinely
    // block on — the same phone lock (pg_advisory_xact_lock waits, it does
    // not error).
    await new Promise((r) => setTimeout(r, 200));
    expect(quickAddSettled).toBe(false);

    releasePhoneHold();
    await phoneHoldTx;
    const created = await quickAddPromise;

    expect(quickAddSettled).toBe(true);
    expect(created.phone).toBe(phone);
    const row = await mockPg('customers').where({ id: created.id }).first();
    expect(row).toBeTruthy();
  }, 10000);

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

  // codex #5018 pre-push P2: the Communications composer (admin-
  // communications.js POST /sms) now takes this SAME lockSmsPhone handoff
  // before a send, mirroring admin-leads.js's manual send above — a
  // consultation link can ride the composer's body too, racing this
  // worker's own final linkSentRecently check. Since lockSmsPhone keys
  // purely on the destination phone (pg_advisory_xact_lock, the two-key
  // family), any holder of it — admin-leads.js's manual send or the
  // composer's — blocks the worker identically; this test drives that same
  // mechanism directly (no HTTP layer) to pin the composer's own code path.
  test('a Communications composer send holding the phone lock makes the worker wait, then the worker sees the delivered link and skips', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550777' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550777',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    const mintedAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    await mockPg('short_codes').insert({ id: randomUUID(), code: 'zz88', target_url: 'https://portal.example.com/inspection/tok-8', kind: 'consultation', entity_type: 'leads', entity_id: leadId, created_at: mintedAt, updated_at: mintedAt });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-8', line: 'Pick a time.\n\n', phone: '+15555550777' });
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck, onDispatchStart }) => {
      const verdict = await withSmsHandoff(async (trx) => {
        const v = await providerPreSendCheck({ dbi: trx });
        if (v.ok) await onDispatchStart();
        return v;
      });
      return verdict.ok
        ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000008' }
        : { sent: false, ...verdict };
    });

    const { lockSmsPhone } = require('../utils/customer-comms-lock');
    let releaseComposerSend;
    const composerSendHeld = new Promise((resolve) => { releaseComposerSend = resolve; });
    const composerSendTx = mockPg.transaction(async (trx) => {
      // admin-communications.js's own new withSmsHandoff, verbatim: lock
      // the phone, then send and record — while it still holds the lock.
      await lockSmsPhone(trx, '+15555550777');
      await trx('sms_log').insert({
        id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: '+15555550777', status: 'accepted',
        message_body: 'Pick a time: https://portal.example.com/l/zz88', created_at: new Date(),
      });
      await composerSendHeld; // held open until this test explicitly releases it
    });

    // Give the composer transaction a moment to actually acquire the lock
    // (and commit its own INSERT within it) before the worker starts.
    await new Promise((r) => setTimeout(r, 100));

    const call = await mockPg('call_log').where({ id: callId }).first();
    const workerPromise = callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    // The worker's own withSmsHandoff is now genuinely blocked on the SAME
    // advisory key the composer holds (pg_advisory_xact_lock waits, it does
    // not error) — this is the real proof no mocked knex can give.
    await new Promise((r) => setTimeout(r, 200));
    releaseComposerSend();
    await composerSendTx;

    const result = await workerPromise;
    expect(result).toEqual({ sent: false, skipped: 'link_sent_recently' });
  }, 10000);

  /**
   * codex #5018 pre-push P2 (round 2 finding): withSmsHandoff used to take
   * the phone lock (lockSmsPhone) FIRST and only reach customer-comms
   * (lockCustomerComms) afterward, inside its own bookedSinceCall guard —
   * the OPPOSITE of the order every withSmsConsentLock caller
   * (previsit-balance-reminder.js, lead-auto-reply.js, lead-response-
   * tools.js) uses for the SAME two locks: comms, then phone. A concurrent
   * send to a customer who also owns the exact phone this handoff is
   * texting could deadlock — this handoff holding phone and wanting comms,
   * that caller holding comms and wanting phone. Separate advisory-lock
   * namespaces (lockSmsPhone's two-key family vs lockCustomerComms's
   * single-key family) only guarantee the two are never the SAME lock;
   * they do nothing to prevent this opposite-order cycle between two
   * DIFFERENT locks. The fix takes customer-comms first, matching
   * customer-comms-lock.js's own established order.
   */
  describe('lock ordering: withSmsHandoff locks customer-comms before the phone lock (codex #5018 pre-push P2, round 2)', () => {
    test('mechanism: phone-then-comms deadlocks against a comms-then-phone withSmsConsentLock-shaped writer — the exact pre-fix hazard', async () => {
      const customerId = randomUUID();
      const phone = '+15555551111';
      await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone, address_line1: '1 Example St', city: 'Bradenton', zip: '34205' });

      const { lockSmsPhone, lockCustomerComms } = require('../utils/customer-comms-lock');
      // txHandoff: the PRE-FIX withSmsHandoff shape (phone first).
      // txConsentLock: withSmsConsentLock's real, unchanged order (comms first).
      const txHandoff = await mockPg.transaction();
      const txConsentLock = await mockPg.transaction();
      try {
        // Step 1 (sequenced, not raced): txHandoff takes the phone lock.
        await lockSmsPhone(txHandoff, phone);
        // Step 2 (sequenced): txConsentLock takes customer-comms.
        await lockCustomerComms(txConsentLock, customerId);

        // Step 3: cross, concurrently, the resource the OTHER side already
        // holds — a genuine wait-for cycle by construction, exactly like
        // this file's other lock-order mechanism tests.
        const crossed = await Promise.allSettled([
          lockCustomerComms(txHandoff, customerId),
          lockSmsPhone(txConsentLock, phone),
        ]);

        const rejected = crossed.filter((r) => r.status === 'rejected');
        const fulfilled = crossed.filter((r) => r.status === 'fulfilled');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(String(rejected[0].reason?.code || rejected[0].reason?.message || '')).toMatch(/40P01|deadlock/i);
      } finally {
        await txHandoff.rollback().catch(() => {});
        await txConsentLock.rollback().catch(() => {});
      }
    }, 15000);

    test('fix: the real withSmsHandoff transaction and a real withSmsConsentLock caller for the same phone+customer never deadlock', async () => {
      const customerId = randomUUID();
      const phone = '+15555552222';
      await mockPg('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Customer', phone, address_line1: '1 Example St', city: 'Bradenton', zip: '34205' });
      const leadId = await insertLead(mockPg, { phone, customer_id: null });
      const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
      const callId = await insertCall(mockPg, {
        from_phone: phone,
        metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
      });
      buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-lock2', line: 'Pick a time.\n\n', phone });

      let providerEntered;
      const entered = new Promise((resolve) => { providerEntered = resolve; });
      let releaseProvider;
      const providerDone = new Promise((resolve) => { releaseProvider = resolve; });
      sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck, onDispatchStart }) => {
        const verdict = await withSmsHandoff(async (trx) => {
          const v = await providerPreSendCheck({ dbi: trx });
          if (v.ok) {
            // By now the real withSmsHandoff transaction holds BOTH
            // customer-comms(customerId) [this handoff's phone-matched
            // candidate] and the phone lock — held open here so the
            // concurrent withSmsConsentLock call below has something real
            // to contend with.
            providerEntered();
            await providerDone;
            await onDispatchStart();
          }
          return v;
        });
        return verdict.ok
          ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest000000000000000000000000c' }
          : { sent: false, ...verdict };
      });

      const call = await mockPg('call_log').where({ id: callId }).first();
      const handoffPromise = callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

      // Wait until the real handoff transaction is genuinely holding both
      // locks (inside the held provider callback) before racing it.
      await entered;

      const { withSmsConsentLock } = require('../utils/customer-comms-lock');
      let consentLockSettled = false;
      const consentLockCall = withSmsConsentLock(mockPg, { phone, customerId }, async () => {})
        .then(() => { consentLockSettled = true; });

      // The consent-lock caller wants customer-comms(customerId) FIRST —
      // already held by the handoff — so it must genuinely wait, not
      // deadlock (pg_advisory_xact_lock waits, it does not error).
      await new Promise((r) => setTimeout(r, 150));
      expect(consentLockSettled).toBe(false);

      releaseProvider();
      await Promise.all([handoffPromise, consentLockCall]);
      expect(consentLockSettled).toBe(true);
    }, 15000);
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

  // codex #5018 pre-push P1 (round 4): the 14-day exclusion this function
  // answers for is about when the SMS carrying the link went out, not when
  // the underlying short_code was minted. A code minted well outside the
  // window (15 days ago here) but manually texted just 3 days ago — still
  // a valid, delivered link — used to be invisible: short_codes carried its
  // own `since` filter, so this candidate never reached the EXISTS join at
  // all, and an automated text could go out a second time inside the
  // promised 14-day exclusion.
  test('linkSentRecently finds a real send on a code minted OUTSIDE the 14-day window but sent WITHIN it', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550778' });
    const mintedAt = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000); // minted 15 days ago — outside the window
    const sentAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000); // sent only 3 days ago — inside it
    await mockPg('short_codes').insert({
      id: randomUUID(), code: 'oo001', target_url: 'https://portal.example.com/inspection/tok-old2',
      kind: 'consultation', entity_type: 'leads', entity_id: leadId,
      created_at: mintedAt, updated_at: mintedAt,
    });
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: '+15555550778', status: 'accepted',
      message_body: 'Pick a time: https://portal.example.com/l/oo001', created_at: sentAt,
    });

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

  // codex #5196: same housekeeping proof for consultation_link_send_attempts
  // — CONSULTATION_ATTEMPT_RETENTION_MS (15 days) is longer than
  // LINK_SENT_RECENTLY_DEFAULT_WINDOW_MS (14 days), so a row is never
  // pruned while a dedupe read could still consult it.
  test('pruneConsultationLinkAttempts deletes only attempt rows older than CONSULTATION_ATTEMPT_RETENTION_MS', async () => {
    const leadId = await insertLead(mockPg);
    const oldStamp = new Date(NOW.getTime() - callBookingLinkText.CONSULTATION_ATTEMPT_RETENTION_MS - 60 * 60 * 1000);
    const recentStamp = new Date(NOW.getTime() - 60 * 60 * 1000);
    await mockPg(callBookingLinkText.CONSULTATION_ATTEMPT_TABLE).insert({ lead_id: leadId, to_phone: '+15555550991', source: 'test', started_at: oldStamp });
    await mockPg(callBookingLinkText.CONSULTATION_ATTEMPT_TABLE).insert({ lead_id: leadId, to_phone: '+15555550992', source: 'test', started_at: recentStamp });

    const deleted = await callBookingLinkText.pruneConsultationLinkAttempts(mockPg, NOW);
    expect(deleted).toBe(1);
    const oldRow = await mockPg(callBookingLinkText.CONSULTATION_ATTEMPT_TABLE).where({ to_phone: '+15555550991' }).first();
    expect(oldRow).toBeUndefined(); // pruned
    const recentRow = await mockPg(callBookingLinkText.CONSULTATION_ATTEMPT_TABLE).where({ to_phone: '+15555550992' }).first();
    expect(recentRow).toBeTruthy(); // kept — still inside the dedupe window
  });

  // codex #5196 P2 scenario: an automated attempt to phone A, then staff
  // correct the lead's phone to B — a manual send to B must NOT be refused
  // by the stale attempt evidence at A. Exercises insertConsultationLinkAttempt
  // (the shared writer every sender uses) and linkSentRecently's own
  // matchPhone scoping together, against a real Postgres connection.
  test('a manual send to a corrected phone B is not refused by an automated attempt recorded against the OLD phone A', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550601' });
    await callBookingLinkText.insertConsultationLinkAttempt(
      { leadId, toPhone: '+15555550601', source: 'call_booking_link_text' },
      mockPg,
    );

    // Real clock, not NOW: insertConsultationLinkAttempt stamps started_at
    // with new Date(), as in production.
    const readAt = new Date();
    // Lead-wide (the automated lane's own 14-day dedupe call) still sees it.
    await expect(callBookingLinkText.linkSentRecently(mockPg, leadId, readAt)).resolves.toBe(true);
    // Phone-scoped to the OLD number A also sees it.
    await expect(callBookingLinkText.linkSentRecently(mockPg, leadId, readAt, { matchPhone: '+15555550601' })).resolves.toBe(true);
    // Phone-scoped to the NEW, corrected number B does not — the manual
    // send to B must be allowed through.
    await expect(callBookingLinkText.linkSentRecently(mockPg, leadId, readAt, { matchPhone: '+15555550602' })).resolves.toBe(false);
  });

  // codex #5196 P2 scenario, extended: with insertConsultationLinkAttempt's
  // returned id deleted (the same cleanup an onDispatchAbort/definite-
  // failure path runs), the row is gone entirely — proving deleteConsultationLinkAttempt
  // genuinely removes it, not merely masks it.
  test('deleteConsultationLinkAttempt removes exactly the row its id names', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550701' });
    const keptId = await callBookingLinkText.insertConsultationLinkAttempt(
      { leadId, toPhone: '+15555550701', source: 'admin_leads_send_sms' },
      mockPg,
    );
    const deletedId = await callBookingLinkText.insertConsultationLinkAttempt(
      { leadId, toPhone: '+15555550702', source: 'admin_communications_manual_sms' },
      mockPg,
    );
    await callBookingLinkText.deleteConsultationLinkAttempt(deletedId);
    const kept = await mockPg(callBookingLinkText.CONSULTATION_ATTEMPT_TABLE).where({ id: keptId }).first();
    const deleted = await mockPg(callBookingLinkText.CONSULTATION_ATTEMPT_TABLE).where({ id: deletedId }).first();
    expect(kept).toBeTruthy();
    expect(deleted).toBeUndefined();
  });

  // codex #5018 P2: leads.estimate_id is only the FK RESCUED at send/view
  // (admin-estimates.js's own "Prefer the FK... fall back to the public-
  // quote mirror" comment) — a quote-wizard draft the lead never opened
  // stores the link ONLY in estimates.estimate_data.lead_id (public-
  // quote.js's findPriorOpenWizardLeadId: "A wizard draft is mirrored
  // through estimate_data.lead_id, not the FK"). dispatchIneligibleReason's
  // own estimate_linked check (DISPATCH_CHECKS, run before the handoff even
  // opens) must catch this too — a mocked knex cannot compile the real
  // jsonb ->> lookup leadHasOpenEstimateMirror needs.
  test('dispatchClaimedCall skips estimate_linked for a quote-wizard draft that only mirrors this lead through estimate_data.lead_id (never the FK)', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550777' });
    await mockPg('estimates').insert({ id: randomUUID(), status: 'draft', estimate_data: { lead_id: leadId }, created_at: NOW });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550777',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: false, skipped: 'estimate_linked' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // The same mirror, but landing in the gap AFTER dispatchIneligibleReason's
  // own (already-cleared) check and BEFORE neverSendRecheck's — the final
  // provider-boundary recheck must catch it too, on the freshest possible
  // read (dbi), the same discipline every other mutable fact on this hook
  // already follows.
  test('neverSendRecheck skips estimate_linked for a quote-wizard mirror created between dispatch and the handoff', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550778' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550778',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-est', line: 'Pick a time.\n\n', phone: '+15555550778' });
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck }) => {
      // Simulates a quote-wizard submission landing in this exact gap.
      await mockPg('estimates').insert({ id: randomUUID(), status: 'sent', estimate_data: { lead_id: leadId }, created_at: NOW });
      const verdict = await withSmsHandoff((trx) => providerPreSendCheck({ dbi: trx }));
      return verdict.ok ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000009' } : { sent: false, ...verdict };
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: false, skipped: 'estimate_linked' });
  });

  // codex #5018 P2: the handoff now joins public-quote.js's OWN estimate-
  // automation duplicate lock (acquireAutomatedEstimateLocks, the SAME
  // helper/key withAutomatedEstimatePhoneLock uses) before its own mirror
  // recheck — a real Postgres proof no mocked knex can give: a concurrent
  // quote-wizard insert holding that lock genuinely blocks the handoff
  // until it commits, so the handoff's own recheck cannot race past it and
  // always sees the estimate it left behind.
  test('a quote-wizard draft insert holding the estimate-automation lock blocks the final check, then the handoff sees the estimate and does not send', async () => {
    const WIZARD_PHONE = '+15555550779';
    const leadId = await insertLead(mockPg, { phone: WIZARD_PHONE });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: WIZARD_PHONE,
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.example.com/inspection/tok-lock', line: 'Pick a time.\n\n', phone: WIZARD_PHONE });
    sendCustomerMessage.mockImplementation(async ({ withSmsHandoff, providerPreSendCheck }) => {
      const verdict = await withSmsHandoff((trx) => providerPreSendCheck({ dbi: trx }));
      return verdict.ok ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000lk' } : { sent: false, ...verdict };
    });

    const { acquireAutomatedEstimateLocks } = require('../services/estimate-automation-duplicates');
    let releaseWizardWriter;
    const wizardWriterHeld = new Promise((resolve) => { releaseWizardWriter = resolve; });
    const wizardWriterTx = mockPg.transaction(async (trx) => {
      // public-quote.js's own real order inside withAutomatedEstimatePhoneLock:
      // the lock first, then the estimates insert, while still holding it.
      await acquireAutomatedEstimateLocks(trx, WIZARD_PHONE);
      await trx('estimates').insert({ id: randomUUID(), status: 'draft', estimate_data: { lead_id: leadId }, created_at: NOW });
      await wizardWriterHeld; // held open until this test explicitly releases it
    });

    // Give the wizard-writer transaction a moment to actually acquire the
    // lock (and commit its own INSERT within it) before the handoff starts.
    await new Promise((r) => setTimeout(r, 100));

    const call = await mockPg('call_log').where({ id: callId }).first();
    const handoffPromise = callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    // The handoff's own final check is now genuinely blocked on the SAME
    // advisory key the wizard writer holds (pg_advisory_xact_lock waits, it
    // does not error) — this is the real proof a mocked knex cannot give.
    await new Promise((r) => setTimeout(r, 200));
    releaseWizardWriter();
    await wizardWriterTx;

    const result = await handoffPromise;
    expect(result).toEqual({ sent: false, skipped: 'estimate_linked' });
  }, 10000);

  // codex #5018 P2: linkSentRecently used to match ONLY a short /l/<code>
  // bearer via short_codes — a manual composer send or a forwarded resolved
  // page URL can carry the long-form /inspection/<token> instead, which
  // never appears in short_codes at all. Reuses composer-customer-links.js's
  // own consultationLinkRows (real signature verification) — never
  // hand-rolled token parsing.
  test('linkSentRecently matches a long-form /inspection/<token> sms_log body with no short_codes row at all', async () => {
    const { mintLeadConsultationToken } = require('../utils/lead-consultation-token');
    const leadId = await insertLead(mockPg, { phone: '+15555550444' });
    const sentAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: '+15555550444', status: 'delivered',
      message_body: `Pick a time: https://portal.wavespestcontrol.com/inspection/${mintLeadConsultationToken(leadId)}`,
      created_at: sentAt,
    });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550444',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: false, skipped: 'link_sent_recently' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  // Negative control: a long-form link decoding to a DIFFERENT lead must
  // never block this one — proves the fix matches by resolved lead_id, not
  // merely by the presence of an /inspection/ substring.
  test('linkSentRecently ignores a long-form link that decodes to a DIFFERENT lead', async () => {
    const { mintLeadConsultationToken } = require('../utils/lead-consultation-token');
    const otherLeadId = await insertLead(mockPg, { phone: '+15555550445' });
    const leadId = await insertLead(mockPg, { phone: '+15555550446' });
    const sentAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    await mockPg('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+15555550100', to_phone: '+15555550445', status: 'delivered',
      message_body: `Pick a time: https://portal.wavespestcontrol.com/inspection/${mintLeadConsultationToken(otherLeadId)}`,
      created_at: sentAt,
    });
    buildLeadConsultationSmsLine.mockResolvedValue({ url: 'https://portal.wavespestcontrol.com/inspection/tok-new2', line: 'Pick a time.\n\n', phone: '+15555550446' });
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMtest0000000000000000000000010' });
    const send_at = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const callId = await insertCall(mockPg, {
      from_phone: '+15555550446',
      metadata: { lead_id: leadId, call_booking_link_text: { status: 'claimed', lead_id: leadId, send_at, original_send_at: send_at } },
    });

    const call = await mockPg('call_log').where({ id: callId }).first();
    const result = await callBookingLinkText.dispatchClaimedCall(mockPg, call, NOW);

    expect(result).toEqual({ sent: true, providerMessageId: 'SMtest0000000000000000000000010' });
  });

  // codex #5018 P2: stage()'s own SELECT requires processing_token IS NULL,
  // v2_extraction_status = 'valid', and updated_at past the grace window —
  // but stageOne makes further real DB awaits (resolveLeadLinkage,
  // outboundStagingReason) before ever reaching claimMetadata's UPDATE. A
  // forced reprocess claiming the row in that gap must not have its own
  // claim silently overwritten by a decision stamped against the STALE row
  // stage()'s SELECT observed. `staleCall` below is exactly what that
  // SELECT would have read — handed to stageOne directly (it never re-reads
  // the row itself) while the REAL row underneath has already moved on.
  test('stageOne\'s claimMetadata UPDATE is a no-op — never a stamped decision — when a reprocess claims the row after the SELECT that fed it', async () => {
    const leadId = await insertLead(mockPg, { phone: '+15555550999' });
    const callId = await insertCall(mockPg, { metadata: { lead_id: leadId } });
    const staleCall = await mockPg('call_log').where({ id: callId }).first();
    // The reprocess lands AFTER stage()'s own SELECT already ran.
    await mockPg('call_log').where({ id: callId }).update({
      processing_token: 'reprocess-claim', v2_extraction_status: null, updated_at: new Date(),
    });

    const decided = await callBookingLinkText.stageOne(mockPg, staleCall, NOW, null);
    expect(decided).toBe('pending'); // stageOne's own in-memory logic never re-reads the row

    const row = await mockPg('call_log').where({ id: callId }).first('metadata', 'processing_token', 'v2_extraction_status');
    expect(row.metadata?.call_booking_link_text).toBeUndefined(); // never stamped over the claimed row
    expect(row.processing_token).toBe('reprocess-claim'); // the reprocess's own claim survives untouched
    expect(row.v2_extraction_status).toBeNull();
  });

  // codex #5018 P2, closed further by its own r15/r16 follow-up: twilio.js's
  // accepted-send sms_log recovery insert (services/twilio.js, the
  // "Authority guard failed after provider acceptance" branch) serializes
  // its own check-then-insert with a transaction-scoped advisory lock keyed
  // on the twilio_sid, because twilio_sid carries no UNIQUE constraint. The
  // "fix" test's tx1 below is no longer a hypothetical stand-in — the
  // ORIGINAL in-handoff insert (dispatch()'s own `if (options.logInHandoff)`
  // block, on its own held trx) now takes this SAME lock for real, right
  // before it inserts, so this test genuinely proves both sides of the
  // real mechanism: a recovery attempt racing a still-open original
  // transaction blocks on this exact key until that original commits or
  // rolls back, and only then re-checks — hand-replicated here exactly as
  // twilio.js derives it (never re-exported for tests), the same
  // mechanism/fix methodology this file's own lock-ordering tests above
  // already use, since a mocked knex cannot prove a real Postgres lock is
  // genuinely held.
  describe('twilio.js sms_log recovery: an advisory lock serializes concurrent check-then-insert for the SAME twilio_sid (codex #5018 P2)', () => {
    async function acquireRecoveryLock(trx, sid) {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`sms_log_sid:${sid}`]);
    }
    function smsLogRow(sid) {
      return {
        id: randomUUID(), direction: 'outbound', from_phone: '+19410000000', to_phone: '+19415550100',
        message_body: 'recovery race', twilio_sid: sid, status: 'sent', created_at: NOW, message_type: 'manual',
      };
    }

    test('mechanism: an unlocked SELECT-then-INSERT for the SAME sid across two sequenced transactions duplicates the row — the exact pre-fix hazard', async () => {
      const sid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      const tx1 = await mockPg.transaction();
      const tx2 = await mockPg.transaction();
      try {
        // Sequenced, not raced (this file's own established mechanism-test
        // pattern) — deterministic without relying on real network timing:
        // both see "not logged" before either commits its own insert.
        expect(await tx1('sms_log').where({ twilio_sid: sid }).first('id')).toBeUndefined();
        expect(await tx2('sms_log').where({ twilio_sid: sid }).first('id')).toBeUndefined();
        await tx1('sms_log').insert(smsLogRow(sid));
        await tx1.commit();
        await tx2('sms_log').insert(smsLogRow(sid)); // tx2 never re-checked — it already "knew" the row didn't exist
        await tx2.commit();

        const rows = await mockPg('sms_log').where({ twilio_sid: sid });
        expect(rows).toHaveLength(2); // the duplicate this fix prevents
      } finally {
        await tx1.rollback().catch(() => {});
        await tx2.rollback().catch(() => {});
      }
    });

    test('fix: the SAME sequencing, with the advisory lock twilio.js now takes, never duplicates the row', async () => {
      const sid = `SM${randomUUID().replaceAll('-', '').slice(0, 32)}`;
      const tx1 = await mockPg.transaction();
      const tx2 = await mockPg.transaction();
      try {
        await acquireRecoveryLock(tx1, sid);
        let tx2Done = false;
        const tx2Work = (async () => {
          // tx2's own lock request blocks until tx1 COMMITS (releasing it)
          // — it cannot even reach its own SELECT before then.
          await acquireRecoveryLock(tx2, sid);
          const already = await tx2('sms_log').where({ twilio_sid: sid }).first('id');
          if (!already) await tx2('sms_log').insert(smsLogRow(sid));
          await tx2.commit();
          tx2Done = true;
        })();
        expect(await tx1('sms_log').where({ twilio_sid: sid }).first('id')).toBeUndefined();
        await tx1('sms_log').insert(smsLogRow(sid));
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(tx2Done).toBe(false); // still waiting on tx1's lock
        await tx1.commit();
        await tx2Work;
        expect(tx2Done).toBe(true);

        const rows = await mockPg('sms_log').where({ twilio_sid: sid });
        expect(rows).toHaveLength(1); // tx2's own check now sees tx1's committed row and skips
      } finally {
        await tx1.rollback().catch(() => {});
        await tx2.rollback().catch(() => {});
      }
    });
  });
});
