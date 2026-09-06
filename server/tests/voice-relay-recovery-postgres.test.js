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
    await mockPg.schema.createTable('call_log', (t) => { t.text('id').primary(); t.text('twilio_call_sid').unique(); t.jsonb('metadata'); t.integer('duration_seconds'); t.text('call_summary'); t.text('call_outcome'); t.text('answered_by'); t.text('status'); t.timestamp('created_at', { useTz: true }); t.timestamp('updated_at', { useTz: true }); });
    await mockPg.schema.createTable('artifacts', (t) => { t.text('id').primary(); });
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
    await mockPg('service_requests').delete();
    await mockPg('artifacts').delete();
    await mockPg('triage_items').delete();
    await mockPg('call_log').delete();
    await mockPg('call_log').insert({ id: 'call-1', twilio_call_sid: callSid, metadata: {
      relay_session_claimed_at: new Date().toISOString(), relay_session_claim_owner: 'old', relay_session_claim_gen: 1,
      relay_reconnect_ms: 2, relay_reconnects: 1,
    } });
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
    await RelayConversation.prototype._refreshCallSummary.call({ callSid }, meta);
    expect((await mockPg('call_log').first()).duration_seconds).toBe(80);
    if (summary) expect((await mockPg('call_log').first()).call_summary).toBe(summary);
    await mockPg('call_log').where('id', 'call-1').update({ duration_seconds: 100 });
    await RelayConversation.prototype._refreshCallSummary.call({ callSid }, meta);
    expect((await mockPg('call_log').first()).duration_seconds).toBe(100);
    // Silent segments and missing segment start use the call's creation time.
    await mockPg('call_log').where('id', 'call-1').update({ duration_seconds: 0 });
    await RelayConversation.prototype._refreshCallSummary.call({ callSid }, { relay_segments: [{ ended_at: '2026-01-01T12:02:00Z' }] });
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
      await stampCallLeadLinkage(callSid, 'lead-1', { trx });
      takeover = beginRelaySessionClaim(callSid, 'new', 2);
      await waitForBlockedClaim();
      if (commit) await trx.commit(); else await trx.rollback();
      expect(await takeover).toBe(true);
      const row = await mockPg('call_log').where('twilio_call_sid', callSid).first('metadata');
      expect(row.metadata.relay_lead_id || null).toBe(commit ? 'lead-1' : null);
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
