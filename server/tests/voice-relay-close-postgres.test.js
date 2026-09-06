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
      t.text('transcription_provider'); t.text('transcription_status');
      t.text('call_summary'); t.jsonb('transcription_metadata'); t.integer('duration_seconds'); t.timestamp('created_at').defaultTo(db.fn.now());
      t.text('source'); t.text('call_outcome'); t.jsonb('transcript_structured'); t.timestamp('updated_at');
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

});
