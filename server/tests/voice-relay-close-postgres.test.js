let mockFixtureDb;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockFixtureDb(...args);
  proxy.raw = (...args) => mockFixtureDb.raw(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn(async () => {}) }));
/** Isolated loopback PostgreSQL only; creates and drops its own fixture schema. */
const knex = require('knex');
const { randomUUID } = require('crypto');
const { buildSegment, segmentsText } = require('../services/voice-agent/relay-segments');
const connection = process.env.VOICE_RECOVERY_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `relay_segments_${randomUUID().replaceAll('-', '')}`;
let admin;
let db;

postgres('atomic relay segment append and composition', () => {
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) throw new Error('Use an isolated loopback PostgreSQL fixture');
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: { connectionString: connection, application_name: schema }, searchPath: [schema], pool: { min: 0, max: 3 } });
    mockFixtureDb = db;
    await db.schema.createTable('call_log', (t) => {
      t.text('id').primary(); t.text('twilio_call_sid').unique(); t.jsonb('metadata'); t.text('transcription');
      t.text('transcription_provider'); t.text('transcription_status'); t.text('transcription_model');
      t.text('call_summary'); t.jsonb('transcription_metadata'); t.integer('duration_seconds'); t.timestamp('created_at').defaultTo(db.fn.now());
      t.text('source'); t.text('call_outcome'); t.jsonb('transcript_structured'); t.timestamp('updated_at');
      t.text('status'); t.text('answered_by');
    });
    await db.schema.createTable('call_commitments', (t) => {
      t.increments('id');
      for (const key of ['call_log_id', 'commitment_key', 'party', 'kind', 'description', 'channel', 'due_basis', 'source', 'extractor_version', 'recording_sid', 'status', 'human_state']) t.text(key);
      t.timestamp('due_at'); t.timestamp('updated_at'); t.float('confidence'); t.jsonb('evidence');
      t.integer('processing_generation'); t.integer('last_seen_generation');
      t.unique(['call_log_id', 'commitment_key']);
    });
  });
  afterAll(async () => {
    if (db) await db.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => { await db('call_commitments').delete(); await db('call_log').delete(); });

  test.each(['conversation_relay', 'recorded_fixture'])('late close metrics cover both sockets without replacing %s provenance', async (provider) => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const makeLeg = (key, generation, firstSendAt) => buildSegment({ sessionKey: key, generation,
      text: `Caller: segment ${generation}`, startedAt: Date.now() - 10000,
      reason: 'fixture-close', model: 'relay-fixture-model', versions: { prompt: 'fixture-v2' },
      turnCounts: { caller_turns: 1, agent_turns: 2, tool_calls: 3 },
      turnStats: [{ promptAt: 0, firstSendAt, toolMs: 40, modelMs: 100 }],
    });
    const later = makeLeg('second', 2, 900);
    const prior = { relay_segment_owners: ['first', 'second'], relay_segments: [later] };
    const complete = { ...prior, relay_lead_id: 'lead-fixture', relay_reservice_filed: true,
      relay_segments: [later, makeLeg('first', 1, 100)] };
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: complete,
      transcription_provider: provider, call_summary: 'Owner-authored summary',
      transcription_metadata: { source: 'existing', model: 'fixture-model', caller_turns: 99, summary_source: 'model' },
    });
    const convo = Object.assign(Object.create(RelayConversation.prototype), { callSid: 'CA-fixture' });
    await convo._refreshCallSummary(complete);
    let row = await db('call_log').first();
    const metrics = provider === 'conversation_relay' ? row.transcription_metadata : row.transcription_metadata.relay;
    expect(metrics).toMatchObject({ caller_turns: 2, agent_turns: 4, tool_calls: 6,
      lead_captured: true, reservice_filed: true, end_reason: 'fixture-close', model: 'relay-fixture-model', versions: { prompt: 'fixture-v2' },
      latency: { turns: 2, prompt_to_first_send_p95: 900, tool_ms_total: 80 },
      segments: { count: 2, complete: true, telemetry_complete: true } });
    expect(row.transcription_metadata).toMatchObject({ source: 'existing', model: provider === 'conversation_relay' ? 'relay-fixture-model' : 'fixture-model' });
    expect(row.transcription_model).toBe(provider === 'conversation_relay' ? 'relay-fixture-model' : null);
    expect(row.call_summary).toBe('Owner-authored summary');
    if (provider !== 'conversation_relay') expect(row.transcription_metadata.caller_turns).toBe(99);
    await convo._refreshCallSummary(prior, false); // a stale in-flight repair cannot regress the aggregate
    row = await db('call_log').first();
    expect((provider === 'conversation_relay' ? row.transcription_metadata : row.transcription_metadata.relay).caller_turns).toBe(2);
  });

  test('a commitment pass waiting on the call lock uses the latest same-owner promise', async () => {
    const { recordRelayCommitments } = require('../services/call-commitments');
    const at = new Date();
    const old = buildSegment({ generation: 1, sessionKey: 'a', text: 'Agent: I will send you an estimate.',
      promises: [{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at }] });
    const newer = buildSegment({ generation: 2, sessionKey: 'b', text: 'Agent: I will send you an estimate when the office opens.',
      promises: [{ kind: 'send_estimate', verdict: true, expectation: 'when_office_opens', at }] });
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', transcription: old.text, call_outcome: 'ai_handled',
      metadata: { relay_session_claim_owner: 'b', relay_segments: [old] } });
    const trx = await db.transaction();
    let pass;
    try {
      await trx('call_log').where('id', 'fixture').forUpdate().first();
      pass = recordRelayCommitments(db, { callSid: 'CA-fixture', sessionKey: 'b', transcript: old.text,
        estimateQueued: true, estimateExpectation: 'about_15_minutes', estimatePromisedAt: at });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await db.raw('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ? AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked', [schema]);
        if (activity.rows[0].blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      // The stale arguments survive the race; the transaction must replace
      // them with the row state visible once its lock is acquired.
      await trx('call_log').where('id', 'fixture').update({ transcription: segmentsText([old, newer]),
        metadata: { relay_session_claim_owner: 'b', relay_segments: [old, newer] } });
      await trx.commit();
      expect(await pass).toMatchObject({ written: 1 });
      const owed = await db('call_commitments').where('kind', 'send_estimate').first();
      expect(owed.due_at).toBeNull();
      expect(owed.due_basis).not.toBe('stated');
    } finally { if (!trx.isCompleted()) await trx.rollback(); if (pass) await pass; }
  });

  test.each([true, false])('summary repair uses explicit provenance, model-written=%s', async (modelWritten) => {
    const { buildTranscriptUpdate } = require('../services/voice-agent/relay-transcript');
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const modelSummary = modelWritten ? 'AI phone assistant discussed a termite follow-up.' : null;
    const patch = buildTranscriptUpdate({ modelSummary, turns: [{ role: 'caller', text: 'first leg' }] });
    const meta = { relay_segments: [buildSegment({ generation: 1, text: 'Caller: first leg' }), buildSegment({ generation: 2, text: 'Caller: second leg' })] };
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: meta,
      call_summary: patch.call_summary, transcription_metadata: patch.transcription_metadata });
    const convo = Object.assign(Object.create(RelayConversation.prototype), { callSid: 'CA-fixture' });
    const refreshed = await convo._refreshCallSummary(meta);
    const row = await db('call_log').first();
    expect(refreshed).toBe(!modelWritten);
    if (modelWritten) expect(row.call_summary).toBe(modelSummary);
    else expect(row.call_summary).toContain('first leg | second leg');
  });

  test.each([null, 'Caller requested help with ants.'])('silent reconnect summary can be repaired according to its model provenance %s', async (modelSummary) => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const prior = buildSegment({ generation: 1, sessionKey: 'first', text: 'Caller: first leg' });
    const meta = { relay_session_claim_owner: 'resumed', relay_reconnect_ms: 2, relay_segments: [prior] };
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: meta,
      transcription_metadata: { pan_detected: true } });
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    try {
      const convo = new RelayConversation({ callSid: 'CA-fixture', sessionKey: 'resumed', sessionGeneration: 2, sandbox: true });
      convo._resume = { callerTurns: ['first leg'] };
      convo._modelSummary = modelSummary;
      await convo.end('ws_close');
      let row = await db('call_log').first();
      expect(row.call_summary).toContain(modelSummary || 'first leg');
      expect(row.transcription_metadata.summary_source).toBe(modelSummary ? 'model' : 'deterministic');
      if (!modelSummary) expect(row.transcription_metadata.pan_detected).toBe(true);
      const late = { ...meta, relay_segments: [...meta.relay_segments,
        buildSegment({ generation: 2, sessionKey: 'resumed', text: 'Caller: later recovered detail' })] };
      await db('call_log').update({ metadata: late });
      expect(await convo._refreshCallSummary(late)).toBe(!modelSummary);
      row = await db('call_log').first();
      expect(row.call_summary).toContain(modelSummary || 'first leg | later recovered detail');
    } finally { delete process.env.GATE_VOICE_RELAY_RECOVERY; }
  });

  test.each([['first', true], ['replacement', false], [null, true]])('post-floor linkage is fenced against owner %s', async (owner, expected) => {
    const { stampCallLeadLinkage } = require('../services/voice-agent/relay-context');
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: {
      relay_session_claim_owner: owner, relay_lead_id: 'existing-lead',
    } });
    expect(await stampCallLeadLinkage('CA-fixture', 'floor-lead', { sessionKey: 'first' })).toBe(expected);
    expect((await db('call_log').first()).metadata.relay_lead_id).toBe(expected ? 'floor-lead' : 'existing-lead');
  });

  test.each([null, 'deterministic', 'model'])('late owning repair preserves model summary provenance over %s', async (source) => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', call_outcome: 'ai_handled',
      metadata: { relay_session_claim_owner: 'first', relay_segments: [buildSegment({ generation: 1, sessionKey: 'first', text: 'Caller: ants' })] },
      call_summary: source ? 'Previously stored summary' : null,
      transcription_metadata: source ? { summary_source: source } : null });
    const convo = Object.assign(Object.create(RelayConversation.prototype), { callSid: 'CA-fixture', sessionKey: 'first',
      _modelSummary: 'Caller requested help with ants and a callback.',
      _recordCommitments: jest.fn(async () => {}), _refreshFloorLeadSummary: jest.fn(async () => {}),
    });
    await convo._reconcileLateSegment();
    const row = await db('call_log').first();
    expect(row.call_summary).toBe(source === 'model' ? 'Previously stored summary' : convo._modelSummary);
    expect(row.transcription_metadata.summary_source).toBe('model');
  });

  test('a summary repair retries from a changed segment snapshot instead of overwriting with stale text', async () => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const old = { relay_segments: [buildSegment({ generation: 1, text: 'Caller: first leg' })] };
    const current = { relay_segments: [...old.relay_segments, buildSegment({ generation: 2, text: 'Caller: second leg' })] };
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: current,
      call_summary: 'AI phone assistant handled this call. Caller said: first leg | second leg',
      transcription_metadata: { summary_source: 'deterministic' } });
    const convo = Object.assign(Object.create(RelayConversation.prototype), { callSid: 'CA-fixture' });
    expect(await convo._refreshCallSummary(old)).toBe(true);
    expect((await db('call_log').first()).call_summary).toContain('first leg | second leg');
  });

  test.each([
    ['relay_failed', {}, 0], ['voicemail', {}, 0],
    ['ai_handled', {}, 1], ['ai_transferred', {}, 1],
    ['voicemail', { relay_handoff: { reason: 'fixture' } }, 1],
    ['voicemail', { relay_reconnects: 1 }, 1],
  ])('late commitment eligibility follows durable outcome %s and evidence %j', async (outcome, evidence, expected) => {
    const { recordRelayCommitments } = require('../services/call-commitments');
    const segment = buildSegment({ generation: 1, sessionKey: 'a', text: 'Agent: I will send you an estimate.',
      promises: [{ kind: 'send_estimate', verdict: true }] });
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', call_outcome: outcome,
      metadata: { relay_session_claim_owner: 'a', relay_segments: [segment], ...evidence } });
    expect(await recordRelayCommitments(db, { callSid: 'CA-fixture', sessionKey: 'a', transcript: null }))
      .toMatchObject({ written: expected });
    expect(await db('call_commitments').select()).toHaveLength(expected);
  });

  test('both recording summary writes atomically replace deterministic provenance before late repair', async () => {
    const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    // Execute each actual call_log extraction-summary patch against PostgreSQL.
    // This covers the veto/early-finalization and normal checkpoint writers.
    const patches = [...source.matchAll(/ai_extraction: JSON.stringify\(extracted\),\s*call_summary: extracted.call_summary \|\| null,\s*([\s\S]*?)sentiment:/g)];
    expect(patches.length).toBeGreaterThan(0);
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const meta = { relay_segments: [buildSegment({ generation: 1, text: 'Caller: earlier leg' })] };
    for (const [, expression] of patches) {
      expect(expression).toContain('transcription_metadata:');
      const patch = new Function('db', 'trx', `return ({ ${expression} });`)(db, db);
      await db('call_log').delete();
      await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: meta,
        call_summary: 'Old deterministic summary', transcription_metadata: { summary_source: 'deterministic', pan_detected: true } });
      await db('call_log').update({ call_summary: 'Recording model summary', ...patch });
      const convo = Object.assign(Object.create(RelayConversation.prototype), { callSid: 'CA-fixture' });
      expect(await convo._refreshCallSummary(meta)).toBe(false);
      const row = await db('call_log').first();
      expect(row.call_summary).toBe('Recording model summary');
      expect(row.transcription_metadata).toMatchObject({ summary_source: 'model', pan_detected: true });
    }
  });

  test.each([
    [null, null, 'Caller: retained unverified text'],
    ['foreign', null, null],
    [null, 'fixture_recording', 'Recorded caller message.'],
  ])('trusted late repair respects owner %s and provider %s', async (owner, provider, expected) => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const segment = buildSegment({ generation: 1, sessionKey: 'first', text: 'Caller: retained unverified text' });
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', call_outcome: 'ai_handled',
      metadata: { relay_session_claim_owner: owner, relay_segments: [segment] },
      transcription_provider: provider, transcription: provider ? 'Recorded caller message.' : null });
    const convo = Object.assign(Object.create(RelayConversation.prototype), {
      callSid: 'CA-fixture', sessionKey: 'first', _callTokenVerified: true,
      _recordCommitments: jest.fn(async () => {}), _refreshFloorLeadSummary: jest.fn(async () => {}), _refreshCallSummary: jest.fn(async () => {}),
    });
    await convo._reconcileLateSegment();
    const row = await db('call_log').first();
    expect(row.transcription).toBe(expected);
    expect(row.metadata.relay_session_claim_owner).toBe(owner);
  });

});
