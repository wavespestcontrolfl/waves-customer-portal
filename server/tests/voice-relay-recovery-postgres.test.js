/**
 * Real PostgreSQL proof for the reconnect/capture boundary. Opt in with
 * VOICE_RECOVERY_TEST_DATABASE_URL pointing at an isolated loopback fixture.
 * Creates and drops only its own schema; never uses the app DATABASE_URL.
 */
jest.mock('../models/db', () => {
  const db = (...args) => {
    const query = mockPg(...args);
    const update = query.update;
    query.update = function(patch, ...rest) {
      const result = update.call(this, patch, ...rest);
      if (mockDelayRingResult && String(patch.metadata).includes("jsonb_build_object('relay_transfer_ring_at'")) {
        return Promise.resolve(result).then((rows) => new Promise((resolve) => setTimeout(() => resolve(rows), 1600)));
      }
      return result;
    };
    return query;
  };
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/reservice-scheduler', () => ({
  openReserviceCallbacks: jest.fn(async () => ({})), reserviceLanesForCustomer: jest.fn(async () => ['pest']),
  RESERVICE_LANES: { pest: { serviceKey: 'pest_reservice' } }, openCallbackExistsForLane: jest.fn(async () => false),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notification-fixture' })) }));
jest.mock('../services/voice-agent/relay-alert', () => ({ alertOwnerReservice: jest.fn(async () => true) }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn(async () => {}) }));
jest.mock('../services/voice-agent/relay-context', () => ({
  ...jest.requireActual('../services/voice-agent/relay-context'),
  loadOfficeHours: jest.fn(async () => ({ open: true })),
  isOfficeOpenAt: jest.fn(() => true),
}));
const knex = require('knex');
const { randomUUID } = require('crypto');
const { claimOwnedElsewhere, beginRelaySessionClaim, stampCallLeadLinkage } = require('../services/voice-agent/relay-context');
const NotificationService = jest.requireActual('../services/notification-service');
jest.mock('../services/notification-bell-policy', () => ({ isBellPolicyEnabled: () => false }));
const { fallbackFence } = require('../services/voice-agent/relay-recovery');
const { requestReserviceText } = require('../services/voice-agent/relay-reservice');
const connection = process.env.VOICE_RECOVERY_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
let mockDelayRingResult = false;
let admin;
const schema = `relay_recovery_${randomUUID().replaceAll('-', '')}`;
const callSid = 'CA-fixture';

postgres('PostgreSQL capture transaction versus reconnect takeover', () => {
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) throw new Error('Use an isolated loopback PostgreSQL fixture');
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection: { connectionString: connection, application_name: schema }, searchPath: [schema], pool: { min: 0, max: 4 } });
    await mockPg.schema.createTable('call_log', (t) => { t.text('id').primary(); t.text('twilio_call_sid').unique(); t.text('customer_id'); t.text('from_phone'); t.jsonb('metadata'); t.timestamp('voicemail_callback_alerted_at'); t.integer('duration_seconds'); t.text('call_summary'); t.text('call_outcome'); t.text('answered_by'); t.text('status'); t.timestamp('created_at', { useTz: true }); t.timestamp('updated_at', { useTz: true }); });
    await mockPg.schema.alterTable('call_log', (t) => { t.text('transcription_provider'); t.jsonb('transcription_metadata'); });
    await mockPg.schema.createTable('notifications', (t) => {
      t.increments('id');
      for (const field of ['recipient_type', 'recipient_id', 'category', 'title', 'body', 'icon', 'link']) t.text(field);
      t.jsonb('metadata'); t.timestamp('created_at').defaultTo(mockPg.fn.now());
    });
    await mockPg.schema.createTable('artifacts', (t) => { t.text('id').primary(); });
    await mockPg.schema.createTable('leads', (t) => { t.text('id').primary(); t.text('twilio_call_sid'); t.text('transcript_summary'); t.timestamp('updated_at'); });
    await mockPg.schema.createTable('triage_items', (t) => {
      t.text('id').primary(); t.text('call_log_id'); t.text('reason_code'); t.text('status'); t.jsonb('payload');
      t.timestamp('created_at').defaultTo(mockPg.fn.now()); t.timestamp('updated_at');
    });
    await mockPg.schema.createTable('customers', (t) => { t.text('id').primary(); t.timestamp('deleted_at'); t.boolean('active'); t.text('waveguard_tier'); t.decimal('monthly_rate'); });
    await mockPg.schema.createTable('service_requests', (t) => {
      t.increments('id');
      for (const field of ['customer_id', 'category', 'subject', 'description', 'urgency', 'status', 'source']) t.text(field);
      t.jsonb('photos'); t.timestamp('created_at').defaultTo(mockPg.fn.now()); t.timestamp('updated_at'); t.timestamp('owner_alerted_at'); t.timestamp('owner_alert_claimed_at');
    });
  });
  afterAll(async () => {
    delete process.env.GATE_VOICE_RELAY_RECOVERY;
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  test('a reconnect token bound to the older render cannot take over after reissue', async () => {
    await mockPg('call_log').where('id', 'call-1').update({ metadata: { relay_reconnect_ms: 110 } });
    expect(await beginRelaySessionClaim(callSid, 'old-render', 100)).toBe(false);
    expect(await beginRelaySessionClaim(callSid, 'new-render', 110)).toBe(true);
  });

  beforeEach(async () => {
    delete process.env.GATE_VOICE_RELAY_RECOVERY;
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    jest.restoreAllMocks();
    await mockPg('notifications').delete();
    await mockPg('service_requests').delete();
    await mockPg('artifacts').delete();
    await mockPg('leads').delete();
    await mockPg('triage_items').delete();
    await mockPg('call_log').delete();
    await mockPg('call_log').insert({ id: 'call-1', twilio_call_sid: callSid, metadata: {
      relay_session_claimed_at: new Date().toISOString(), relay_session_claim_owner: 'old', relay_session_claim_gen: 1,
      relay_reconnect_ms: 2, relay_reconnects: 1,
    } });
  });

  function fileCallback(owner = 'old', isActive = () => true) {
    return NotificationService.notifyAdmin('voicemail_callback', 'Callback fixture', 'Callback required', {
      dedupeKey: `relay-failure:${callSid}`, relayFailureCall: { callSid, owner, isActive },
    });
  }

  test('callback bell and shared delivery evidence commit once in the same transaction', async () => {
    const first = await fileCallback();
    expect(first.id).toBeTruthy();
    expect((await fileCallback()).suppressed).toBe(true);
    expect(await mockPg('notifications')).toHaveLength(1);
    const row = await mockPg('call_log').first();
    expect(row.voicemail_callback_alerted_at).toBeTruthy();
    expect(row.metadata.relay_failure_callback_filed_at).toBeTruthy();
  });

  test('callback compensation survives a row lock beyond the caller deadline', async () => {
    let receipt;
    await NotificationService.notifyAdmin('voicemail_callback', 'Callback fixture', 'Callback required', {
      dedupeKey: `relay-failure:${callSid}`, relayFailureCall: { callSid, owner: 'old', onCommitted: (value) => { receipt = value; } },
    });
    const trx = await mockPg.transaction();
    let compensation;
    let completed = false;
    try {
      await trx('call_log').where('twilio_call_sid', callSid).forUpdate().first();
      compensation = NotificationService.revertRelayFailureCallback(receipt).then(() => { completed = true; });
      await waitForBlockedClaim();
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(completed).toBe(false);
      expect(await mockPg('notifications')).toHaveLength(1);
      expect((await mockPg('call_log').first()).metadata.relay_failure_callback_filed_at).toBe(receipt.callbackStamp);
    } finally { await trx.rollback(); if (compensation) await compensation; }
    expect(await mockPg('notifications')).toHaveLength(0);
    expect((await mockPg('call_log').first()).voicemail_callback_alerted_at).toBeNull();
  });

  test.each(['floor', 'staff', 'legacy'])('late close refreshes only the complete %s-owned lead summary', async (source) => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const partial = 'Inbound voice call (auto-captured on hangup). Caller said: second';
    const placeholder = 'Inbound voice call (auto-captured on hangup). No transcript captured.';
    await mockPg('leads').insert({ id: 'lead-1', twilio_call_sid: callSid, transcript_summary: source === 'legacy' ? placeholder : partial });
    const meta = { relay_segment_owners: ['old', 'new'], relay_segments: [{ session_key: 'new', generation: 2, text: 'Caller: second' }] };
    await mockPg('call_log').where('id', 'call-1').update({ metadata: meta });
    await mockPg.transaction(async (trx) => {
      await trx('call_log').where('id', 'call-1').forUpdate().first();
      await stampCallLeadLinkage(callSid, 'lead-1', { trx, floorSummary: source === 'legacy' ? null : partial });
    });
    const convo = Object.assign(Object.create(RelayConversation.prototype), { callSid });
    expect(await convo._refreshFloorLeadSummary()).toBe(false); // not all owners have closed
    if (source === 'staff') await mockPg('leads').where('id', 'lead-1').update({ transcript_summary: 'Staff-authored fixture summary' });
    const trx = await mockPg.transaction();
    let repair;
    try {
      const call = await trx('call_log').where('id', 'call-1').forUpdate().first();
      const complete = { ...call.metadata, relay_segments: [...meta.relay_segments, { session_key: 'old', generation: 1, text: 'Caller: first' }] };
      await trx('call_log').where('id', 'call-1').update({ metadata: complete });
      repair = convo._refreshFloorLeadSummary();
      await waitForBlockedClaim();
      await trx.commit();
      expect(await repair).toBe(source !== 'staff');
    } finally { if (!trx.isCompleted()) await trx.rollback(); if (repair) await repair; }
    expect((await mockPg('leads').first()).transcript_summary).toBe(source === 'staff'
      ? 'Staff-authored fixture summary' : 'Inbound voice call (auto-captured on hangup). Caller said: first | second');
  });

  test.each(['recording', 'capture'])('floor repair serializes with the %s lock order without a deadlock', async (writer) => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const partial = 'Inbound voice call (auto-captured on hangup). Caller said: second';
    await mockPg('leads').insert({ id: 'lead-1', twilio_call_sid: callSid, transcript_summary: partial });
    await mockPg('call_log').where('id', 'call-1').update({ metadata: {
      relay_segment_owners: ['old'], relay_segments: [{ session_key: 'old', text: 'Caller: complete fixture' }],
    } });
    await mockPg.transaction((trx) => stampCallLeadLinkage(callSid, 'lead-1', { trx, floorSummary: partial }));
    const trx = await mockPg.transaction();
    const convo = Object.assign(Object.create(RelayConversation.prototype), { callSid });
    let repair;
    try {
      if (writer === 'capture') {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['voice-lead-capture', callSid]);
        await trx('call_log').where('id', 'call-1').forUpdate().first();
      } else await trx('leads').where('id', 'lead-1').forUpdate().first();
      repair = convo._refreshFloorLeadSummary();
      await waitForBlockedClaim();
      // Finish the other writer's normal second lock. The old call -> lead
      // repair order deadlocked here against the recording reconciler.
      await trx(writer === 'capture' ? 'leads' : 'call_log').where('id', writer === 'capture' ? 'lead-1' : 'call-1').forUpdate().first();
      await trx.commit();
      expect(await repair).toBe(true);
      expect((await mockPg('leads').first()).transcript_summary).toContain('complete fixture');
    } finally { if (!trx.isCompleted()) await trx.rollback(); if (repair) await repair; }
  });

  test('a moved linkage while waiting for the lead lock cannot rewrite the old lead', async () => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    await mockPg('leads').insert({ id: 'lead-1', twilio_call_sid: callSid,
      transcript_summary: 'Inbound voice call (auto-captured on hangup). No transcript captured.' });
    await mockPg('call_log').where('id', 'call-1').update({ metadata: { relay_lead_id: 'lead-1',
      relay_segments: [{ text: 'Caller: complete fixture' }] } });
    const trx = await mockPg.transaction();
    let repair;
    try {
      await trx('leads').where('id', 'lead-1').forUpdate().first();
      repair = RelayConversation.prototype._refreshFloorLeadSummary.call({ callSid });
      await waitForBlockedClaim();
      await trx('call_log').where('id', 'call-1').update({ metadata: { relay_lead_id: 'replacement' } });
      await trx.commit();
      expect(await repair).toBe(false);
      expect((await mockPg('leads').first()).transcript_summary).toContain('No transcript captured.');
    } finally { if (!trx.isCompleted()) await trx.rollback(); if (repair) await repair; }
  });

  test('end-frame compensation removes exactly its committed callback and is idempotent', async () => {
    let receipt;
    const bell = await NotificationService.notifyAdmin('voicemail_callback', 'Callback fixture', 'Callback required', {
      dedupeKey: `relay-failure:${callSid}`,
      relayFailureCall: { callSid, owner: 'old', onCommitted: (value) => { receipt = value; } },
    });
    expect(receipt.notificationId).toBe(bell.id);
    await NotificationService.revertRelayFailureCallback(receipt);
    await NotificationService.revertRelayFailureCallback(receipt);
    expect(await mockPg('notifications')).toHaveLength(0);
    expect((await mockPg('call_log').first()).voicemail_callback_alerted_at).toBeNull();
    expect((await fileCallback()).id).toBeTruthy();
    await NotificationService.revertRelayFailureCallback(receipt);
    expect(await mockPg('notifications')).toHaveLength(1); // newer attempt survives a stale undo
    expect((await mockPg('call_log').first()).voicemail_callback_alerted_at).toBeTruthy();
  });

  test('callback filing waits for in-flight compensation and promises only its replacement receipt', async () => {
    let oldReceipt;
    await NotificationService.notifyAdmin('voicemail_callback', 'Callback fixture', 'Callback required', {
      dedupeKey: `relay-failure:${callSid}`,
      relayFailureCall: { callSid, owner: 'old', onCommitted: (value) => { oldReceipt = value; } },
    });
    const { triggerNotification } = require('../services/notification-triggers');
    triggerNotification.mockImplementationOnce(async (_key, _payload, options) => {
      const result = await NotificationService.notifyAdmin('voicemail_callback', 'Callback fixture', 'Callback required', {
        dedupeKey: `relay-failure:${callSid}`, relayFailureCall: options.relayFailureCall,
      });
      const bellWritten = Boolean(result && !result.suppressed);
      options.onBell(bellWritten);
      return { bellWritten };
    });
    let entered;
    let release;
    const compensating = new Promise((resolve) => { entered = resolve; });
    const proceed = new Promise((resolve) => { release = resolve; });
    const transaction = mockPg.transaction.bind(mockPg);
    jest.spyOn(require('../models/db'), 'transaction').mockImplementationOnce((fn) => transaction(async (trx) => {
      const result = await fn(trx); // actual compensation has deleted the receipt, but has not committed
      entered();
      await proceed;
      return result;
    }));
    const compensation = NotificationService.revertRelayFailureCallback(oldReceipt);
    await compensating;
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const convo = Object.assign(Object.create(RelayConversation.prototype), {
      callSid, sessionKey: 'old', from: '+19415550123', _callerVerified: true,
    });
    let settled = false;
    const filing = convo._fileFailureCallback().then((result) => { settled = true; return result; });
    try {
      await waitForBlockedClaim();
      expect(settled).toBe(false); // plain SELECT still sees the old stamp, but cannot authorize a promise
    } finally { release(); }
    await compensation;
    expect(await filing).toBe(true);
    expect(convo._failureCallbackReceipt.notificationId).not.toBe(oldReceipt.notificationId);
    await NotificationService.revertRelayFailureCallback(oldReceipt);
    expect((await mockPg('notifications').first()).id).toBe(convo._failureCallbackReceipt.notificationId);
  });

  test.each(['false', 'throw'])('a promised callback remains durable when the end frame %s fails', async (failure) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { triggerNotification } = require('../services/notification-triggers');
    triggerNotification.mockImplementationOnce(async (_key, _payload, options) => {
      const result = await NotificationService.notifyAdmin('voicemail_callback', 'Callback fixture', 'Callback required', {
        dedupeKey: `relay-failure:${callSid}`, relayFailureCall: options.relayFailureCall,
      });
      const bellWritten = Boolean(result && !result.suppressed);
      options.onBell(bellWritten);
      return { bellWritten };
    });
    const service = require('../services/notification-service');
    service.revertRelayFailureCallback = jest.fn(NotificationService.revertRelayFailureCallback.bind(NotificationService));
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const convo = Object.assign(Object.create(RelayConversation.prototype), {
      callSid, sessionKey: 'old', from: '+19415550123', _callerVerified: true,
      _inFlightWrites: new Map(), _modelFailures: 2,
      _sessionSuperseded: jest.fn(async () => false), say: jest.fn(),
      _endSession: jest.fn(() => { if (failure === 'throw') throw new Error('fixture end frame failure'); return false; }),
    });
    await convo._maybeHandoffForFailure(null);
    expect(convo.say).toHaveBeenCalledWith(expect.stringContaining('call you back'));
    expect(service.revertRelayFailureCallback).not.toHaveBeenCalled();
    const receipt = convo._failureCallbackReceipt;
    expect((await mockPg('notifications').first()).id).toBe(receipt.notificationId);
    expect((await mockPg('call_log').first()).metadata.relay_failure_callback_filed_at).toBe(receipt.callbackStamp);
    convo.ended = true; // no further caller turn is required to retain the office task
    expect(await convo._maybeHandoffForFailure(null)).toBe(false);
    expect(await mockPg('notifications')).toHaveLength(1);
  });

  test('post-commit takeover permits compensation without changing the replacement owner', async () => {
    let receipt;
    await NotificationService.notifyAdmin('voicemail_callback', 'Callback fixture', 'Callback required', {
      dedupeKey: `relay-failure:${callSid}`,
      relayFailureCall: { callSid, owner: 'old', onCommitted: (value) => { receipt = value; } },
    });
    expect(await beginRelaySessionClaim(callSid, 'replacement', 2)).toBe(true);
    await NotificationService.revertRelayFailureCallback(receipt);
    expect(await mockPg('notifications')).toHaveLength(0);
    const row = await mockPg('call_log').first();
    expect(row.metadata.relay_session_claim_owner).toBe('replacement');
    expect(row.metadata.relay_failure_callback_filed_at).toBeUndefined();
    expect(row.voicemail_callback_alerted_at).toBeNull();
  });

  test('an insertion or evidence failure rolls back the bell and callback stamp', async () => {
    await mockPg.raw("CREATE FUNCTION reject_callback_evidence() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture evidence failure''; END;'");
    await mockPg.raw('CREATE TRIGGER reject_callback BEFORE UPDATE ON call_log FOR EACH ROW EXECUTE FUNCTION reject_callback_evidence()');
    try {
      expect(await fileCallback()).toBeNull();
      expect(await mockPg('notifications')).toHaveLength(0);
      expect((await mockPg('call_log').first()).voicemail_callback_alerted_at).toBeNull();
    } finally {
      await mockPg.raw('DROP TRIGGER reject_callback ON call_log');
      await mockPg.raw('DROP FUNCTION reject_callback_evidence()');
    }
    expect((await fileCallback()).id).toBeTruthy(); // retry can deliver; no orphaned claim
  });

  test('a socket already superseded at the notification boundary cannot file a bell', async () => {
    expect(await beginRelaySessionClaim(callSid, 'new', 2)).toBe(true);
    expect((await fileCallback()).suppressed).toBe(true);
    expect(await mockPg('notifications')).toHaveLength(0);
    expect((await mockPg('call_log').first()).voicemail_callback_alerted_at).toBeNull();
  });

  test('an unverified socket may file only while the call has no owner', async () => {
    expect((await fileCallback(null)).suppressed).toBe(true);
    expect(await mockPg('notifications')).toHaveLength(0);
    await mockPg('call_log').update({ metadata: {} });
    expect((await fileCallback(null)).id).toBeTruthy();
  });

  test('closing while the insert is pending rolls back before takeover', async () => {
    let active = true;
    let entered;
    let release;
    const inCreate = new Promise((resolve) => { entered = resolve; });
    const proceed = new Promise((resolve) => { release = resolve; });
    const create = NotificationService.create.bind(NotificationService);
    jest.spyOn(NotificationService, 'create').mockImplementation(async (opts) => { entered(); await proceed; return create(opts); });
    const pending = fileCallback('old', () => active);
    await inCreate;
    active = false;
    const takeover = beginRelaySessionClaim(callSid, 'new', 2);
    release();
    expect(await pending).toBeNull();
    expect(await takeover).toBe(true);
    expect(await mockPg('notifications')).toHaveLength(0);
    const row = await mockPg('call_log').first();
    expect(row.voicemail_callback_alerted_at).toBeNull();
    expect(row.metadata.relay_failure_callback_filed_at).toBeUndefined();
  });

  test('closing during commit compensates only this callback before reporting delivery', async () => {
    let active = true;
    const transaction = mockPg.transaction.bind(mockPg);
    jest.spyOn(require('../models/db'), 'transaction').mockImplementationOnce(async (...args) => {
      const result = await transaction(...args);
      active = false; // COMMIT won the race with socket close.
      return result;
    });
    expect(await fileCallback('old', () => active)).toBeNull();
    expect(await mockPg('notifications')).toHaveLength(0);
    const row = await mockPg('call_log').first();
    expect(row.voicemail_callback_alerted_at).toBeNull();
    expect(row.metadata.relay_failure_callback_filed_at).toBeUndefined();
    expect((await fileCallback()).id).toBeTruthy();
  });

  test('takeover waits for the callback bell transaction before changing ownership', async () => {
    let entered;
    let release;
    const inCreate = new Promise((resolve) => { entered = resolve; });
    const proceed = new Promise((resolve) => { release = resolve; });
    const create = NotificationService.create.bind(NotificationService);
    jest.spyOn(NotificationService, 'create').mockImplementation(async (opts) => { entered(); await proceed; return create(opts); });
    const pending = fileCallback();
    await inCreate;
    const takeover = beginRelaySessionClaim(callSid, 'new', 2);
    try { await waitForBlockedClaim(); } finally { release(); }
    expect((await pending).id).toBeTruthy();
    expect(await takeover).toBe(true);
    expect(await mockPg('notifications')).toHaveLength(1);
  });

  test('a lost transaction connection leaves no permanent callback claim', async () => {
    const create = NotificationService.create.bind(NotificationService);
    jest.spyOn(NotificationService, 'create').mockImplementationOnce(async (opts) => {
      const result = await create(opts);
      const { rows } = await opts.connection.raw('SELECT pg_backend_pid() AS pid');
      await admin.raw('SELECT pg_terminate_backend(?)', [rows[0].pid]);
      return result;
    });
    expect(await fileCallback()).toBeNull();
    expect(await mockPg('notifications')).toHaveLength(0);
    expect((await mockPg('call_log').first()).voicemail_callback_alerted_at).toBeNull();
    expect((await fileCallback()).id).toBeTruthy();
  });

  test.each([null, 'own-lead'])('late resume backfills a committed booking while retaining this leg lead %s', async (ownLeadId) => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const { buildSegment } = require('../services/voice-agent/relay-segments');
    await mockPg('triage_items').insert({ id: 'booking-card', call_log_id: 'call-1', reason_code: 'outbound_booking_review',
      status: 'open', payload: { origin: 'voice_agent', lead_id: null, fixture_marker: 'retained' } });
    const convo = new RelayConversation({ callSid, sessionKey: 'new', sessionGeneration: 2, sandbox: true });
    convo._bookingRequested = true;
    convo._leadId = ownLeadId;
    // The earlier lead is absent from the scalar stamp, then arrives in a late segment.
    await mockPg('call_log').update({ metadata: { relay_session_claim_owner: 'new', relay_reconnects: 1,
      relay_segments: [buildSegment({ generation: 1, sessionKey: 'old', text: 'Caller: first leg',
        leadCaptured: true, leadId: 'restored-lead' })] } });
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    convo._callerVerified = true;
    await convo._reloadResumeState();
    expect(convo._resume.relayLeadId).toBe('restored-lead');
    expect((await mockPg('triage_items').first()).payload).toEqual({
      origin: 'voice_agent', lead_id: ownLeadId || 'restored-lead', fixture_marker: 'retained',
    });
  });

  test.each([null, 'A model-written summary'])('late segments repair duration independently of the summary (%s)', async (summary) => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    await mockPg('call_log').where('id', 'call-1').update({ duration_seconds: 20, call_summary: summary, created_at: new Date('2026-01-01T12:00:00Z') });
    const meta = { relay_segments: [
      { started_at: '2026-01-01T12:00:00Z', ended_at: '2026-01-01T12:01:00Z', text: 'Caller: need pest service' },
      { started_at: '2026-01-01T12:01:00Z', ended_at: '2026-01-01T12:01:20Z', text: 'Caller: please continue' },
    ] };
    await mockPg('call_log').where('id', 'call-1').update({ metadata: meta });
    await RelayConversation.prototype._refreshCallSummary.call({ callSid }, meta);
    expect((await mockPg('call_log').first()).duration_seconds).toBe(80);
    if (summary) expect((await mockPg('call_log').first()).call_summary).toBe(summary);
    await mockPg('call_log').where('id', 'call-1').update({ duration_seconds: 100 });
    await RelayConversation.prototype._refreshCallSummary.call({ callSid }, meta);
    expect((await mockPg('call_log').first()).duration_seconds).toBe(100);
    // Silent segments and missing segment start use the call's creation time.
    const silent = { relay_segments: [{ ended_at: '2026-01-01T12:02:00Z' }] };
    await mockPg('call_log').where('id', 'call-1').update({ duration_seconds: 0, metadata: silent });
    await RelayConversation.prototype._refreshCallSummary.call({ callSid }, silent);
    expect((await mockPg('call_log').first()).duration_seconds).toBe(120);
  });

  async function waitForBlockedClaim() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await mockPg.raw('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ? AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked', [schema]);
      if (result.rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Takeover did not wait for the artifact transaction');
  }

  test.each([true, false])('takeover observes only committed capture evidence (commit=%s)', async (commit) => {
    const trx = await mockPg.transaction();
    let takeover;
    try {
      expect(await claimOwnedElsewhere(trx, callSid, 'old')).toBe(false);
      await trx('artifacts').insert({ id: 'lead-1' });
      await stampCallLeadLinkage(callSid, 'lead-1', { trx, floorSummary: 'Synthetic floor summary' });
      takeover = beginRelaySessionClaim(callSid, 'new', 2);
      await waitForBlockedClaim();
      if (commit) await trx.commit(); else await trx.rollback();
      expect(await takeover).toBe(true);
      const row = await mockPg('call_log').where('twilio_call_sid', callSid).first('metadata');
      expect(row.metadata.relay_lead_id || null).toBe(commit ? 'lead-1' : null);
      expect(row.metadata.relay_floor_summary?.lead_id || null).toBe(commit ? 'lead-1' : null);
      expect(await mockPg('artifacts').select('id')).toHaveLength(commit ? 1 : 0);
      // A detached old write resolving after both sockets close cannot now
      // commit a second artifact: the transaction sees the new owner.
      await mockPg.transaction(async (late) => {
        expect(await claimOwnedElsewhere(late, callSid, 'old')).toBe(true);
      });
    } finally {
      if (!trx.isCompleted()) await trx.rollback();
      if (takeover) await takeover;
    }
  });

  test('an evidence-write error rolls back the capture instead of claiming success', async () => {
    await expect(mockPg.transaction(async (trx) => {
      expect(await claimOwnedElsewhere(trx, callSid, 'old')).toBe(false);
      await trx('artifacts').insert({ id: 'lead-1' });
      await trx.schema.alterTable('call_log', (t) => t.renameColumn('metadata', 'unavailable_metadata'));
      await stampCallLeadLinkage(callSid, 'lead-1', { trx });
    })).rejects.toThrow();
    expect(await mockPg('artifacts').select('id')).toEqual([]);
    expect(await beginRelaySessionClaim(callSid, 'new', 2)).toBe(true);
    expect((await mockPg('call_log').where('twilio_call_sid', callSid).first('metadata')).metadata.relay_lead_id).toBeUndefined();
  });
  test('the production re-service writer commits its recovery evidence with the ticket', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    const ctx = { customerId: 'customer-fixture', customerTier: 'full', callSid, sessionKey: 'old', from: '+19415550123', markCaptured: jest.fn(), markReserviceFiled: jest.fn() };
    await requestReserviceText({ lane: 'pest', issue: 'Synthetic service issue' }, ctx);
    expect(await mockPg('service_requests').select('id')).toHaveLength(1);
    expect(await beginRelaySessionClaim(callSid, 'new', 2)).toBe(true);
    expect((await mockPg('call_log').where('twilio_call_sid', callSid).first('metadata')).metadata.relay_reservice_filed).toBe(true);
  });

  test('a failed re-service evidence UPDATE rolls back the production ticket insert', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    // Existing evidence survives unchanged, but this fixture refuses the
    // commit stamp. The actual writer must propagate that error through trx.
    await mockPg.raw("ALTER TABLE call_log ADD CONSTRAINT reject_reservice_evidence CHECK (NOT COALESCE((metadata->>'relay_reservice_filed')::boolean, false))");
    try {
      const ctx = { customerId: 'customer-fixture', customerTier: 'full', callSid, sessionKey: 'old', from: '+19415550123', markCaptured: jest.fn(), markReserviceFiled: jest.fn() };
      await expect(requestReserviceText({ lane: 'pest', issue: 'Synthetic service issue' }, ctx)).rejects.toThrow();
      expect(await mockPg('service_requests').select('id')).toEqual([]);
      expect(ctx.markCaptured).not.toHaveBeenCalled();
      expect(await beginRelaySessionClaim(callSid, 'new', 2)).toBe(true);
      expect((await mockPg('call_log').where('twilio_call_sid', callSid).first('metadata')).metadata.relay_reservice_filed).toBeUndefined();
    } finally {
      await mockPg.raw('ALTER TABLE call_log DROP CONSTRAINT reject_reservice_evidence');
    }
  });

  test.each([false, true])('second-failure ring compensation reaches voicemail; late result = %s', async (lateResult) => {
    mockDelayRingResult = lateResult;
    const savedNumbers = process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
    const savedTransfer = process.env.GATE_VOICE_RELAY_TRANSFER;
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    process.env.WAVES_FALLBACK_FORWARD_NUMBERS = ',';
    try {
      await mockPg('call_log').where('twilio_call_sid', callSid).update({ metadata: {
        relay_session_claim_owner: 'nonce-1', relay_reconnects: 1, relay_reconnect_ms: 777, relay_session_claim_gen: 500,
      } });
      const router = require('../routes/twilio-voice-webhook');
      const handler = router.stack.find((layer) => layer.route?.path === '/relay-complete').route.stack[0].handle;
      const res = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
      await handler({ body: { CallSid: callSid, ErrorCode: '64105' }, query: { gen: '777' } }, res);
      expect(res.send.mock.calls[0][0]).toContain('<Record');
      const row = await mockPg('call_log').where('twilio_call_sid', callSid).first();
      expect(row.call_outcome).toBe('voicemail');
      expect(row.metadata.relay_transfer_ring_at).toBeTruthy();
      if (lateResult) await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      mockDelayRingResult = false;
      if (savedNumbers === undefined) delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS; else process.env.WAVES_FALLBACK_FORWARD_NUMBERS = savedNumbers;
      if (savedTransfer === undefined) delete process.env.GATE_VOICE_RELAY_TRANSFER; else process.env.GATE_VOICE_RELAY_TRANSFER = savedTransfer;
    }
  });

  test.each([{ call_outcome: 'ai_transferred' }, { metadata: { relay_transfer_ring_at: '2026-01-01T00:00:00Z' } }])('fallback atomically preserves a concurrent transfer: %j', async (transfer) => {
    await mockPg('call_log').where('twilio_call_sid', callSid).update({ ...transfer, metadata: {
      relay_reconnect_ms: 777, relay_session_claim_gen: 500, ...transfer.metadata,
    } });
    expect(await fallbackFence(mockPg('call_log').where('twilio_call_sid', callSid), { generation: 777, callbackGeneration: 0 })
      .update({ call_outcome: 'voicemail' })).toBe(0);
  });

  test.each([
    [0, 1, 0, 0, 1], // first failure, no reconnect
    [777, 900, 777, 0, 0], // first-leg retry, resumed socket claimed
    [777, 900, 777, 777, 1], // resumed leg's own failure
    [888, 900, 777, 777, 0], // reconnect reissued after the read
    [777, 500, 777, 0, 1], // compensated reconnect, no resumed socket
    [777, 900, 0, 0, 0], // reconnect landed after a no-reconnect read
  ])('fallback fences row generation %s / claim %s against proven %s / callback %s', async (rowGeneration, claimGeneration, generation, callbackGeneration, expected) => {
    await mockPg('call_log').where('twilio_call_sid', callSid).update({ metadata: { relay_reconnect_ms: rowGeneration, relay_session_claim_gen: claimGeneration } });
    const rows = await fallbackFence(mockPg('call_log').where('twilio_call_sid', callSid), { generation, callbackGeneration }).update({ id: 'call-1' });
    expect(rows).toBe(expected);
  });

});
