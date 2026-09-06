let mockFixtureDb;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockFixtureDb(...args);
  proxy.raw = (...args) => mockFixtureDb.raw(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
/** Isolated loopback PostgreSQL only; creates and drops its own fixture schema. */
const knex = require('knex');
const { randomUUID } = require('crypto');
const { buildSegment, appendSegment, segmentsText, latestPromises } = require('../services/voice-agent/relay-segments');
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

  test('concurrent closes retain both segments and compose by generation', async () => {
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: { relay_reconnects: 1, relay_reconnect_ms: 3 } });
    await Promise.all([2, 1].map((generation) => appendSegment(db, 'CA-fixture',
      buildSegment({ generation, sessionKey: `session-${generation}`, text: `Caller: segment ${generation}` }),
    )));
    const row = await db('call_log').first();
    expect(row.metadata.relay_segments).toHaveLength(2);
    expect(row.transcription).toBe('Caller: segment 1\n\n[Reconnected]\nCaller: segment 2');
    expect(row.transcription_provider).toBe('conversation_relay');
    expect(row.transcription_status).toBe('completed');
  });

  test('a late append preserves an existing recorded segment', async () => {
    const recorded = '\n\n[Voicemail segment]\nRecorded caller message.';
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: { relay_reconnects: 1, relay_reconnect_ms: 3 },
      transcription: `[AI segment]\nCaller: first${recorded}`, transcription_provider: 'fixture_recording', call_outcome: 'voicemail' });
    await appendSegment(db, 'CA-fixture',
      buildSegment({ generation: 1, sessionKey: 'first', text: 'Caller: first and more' }),
    );
    const row = await db('call_log').first();
    expect(row.transcription).toBe(`[AI segment]\nCaller: first and more${recorded}`);
    expect(row.transcription_provider).toBe('fixture_recording');
  });

  test.each([[1, 2], [2, 1]])('concurrent split PAN closes %j sanitize metadata, stash and composed copies atomically', async (first, second) => {
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture',
      metadata: { relay_reconnects: 1, relay_reconnect_ms: 3, relay_transcript: { text: 'old' } },
      transcription: '[AI segment]\nold\n\n[Voicemail segment]\nRecorded caller message.',
      transcription_provider: 'fixture_recording', call_outcome: 'voicemail' });
    const text = { 1: 'Caller: 4111 1111\nAgent: Please use the payment link.', 2: 'Agent: I am back.\nCaller: 1111 1111' };
    await Promise.all([first, second].map((generation) => appendSegment(db, 'CA-fixture',
      buildSegment({ generation, sessionKey: `session-${generation}`, text: text[generation] }),
    )));
    const row = await db('call_log').first();
    expect(row.metadata.relay_segments).toHaveLength(2);
    for (const value of [JSON.stringify(row.metadata), row.transcription]) {
      expect(value).toContain('[card ending 1111]');
      expect(value).not.toContain('4111 1111');
      expect(value).not.toContain('1111 1111');
    }
    expect(row.transcription).toContain('[Voicemail segment]\nRecorded caller message.');
    // A retry must not restore the raw fragment that this socket once held.
    await appendSegment(db, 'CA-fixture', buildSegment({ generation: 1, sessionKey: 'session-1', text: text[1] }));
    expect(await db('call_log').first()).toEqual(row);
  });

  test('scrub failure rolls back without publishing the new fragment', async () => {
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture',
      metadata: { relay_session_claim_owner: 'session-1' } });
    const before = await db('call_log').first();
    const scrub = jest.spyOn(require('../services/voice-agent/relay-transcript'), 'scrubTurnsForStorage').mockReturnValueOnce(null);
    try {
      await expect(appendSegment(db, 'CA-fixture', buildSegment({ generation: 1, sessionKey: 'session-1', text: 'Caller: 4111 1111' }))).rejects.toThrow('scrub unavailable');
      expect(await db('call_log').first()).toEqual(before);
    } finally { scrub.mockRestore(); }
  });

  test('same-generation late closes follow the claim nonce order for text and promises', async () => {
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: { relay_reconnects: 1, relay_reconnect_ms: 3 } });
    for (const key of ['b', 'a']) await appendSegment(db, 'CA-fixture', buildSegment({ generation: 1, sessionKey: key, text: `Caller: ${key}`,
      promises: [{ kind: 'send_estimate', verdict: true, expectation: key }] }));
    const row = await db('call_log').first();
    expect(row.transcription).toBe('Caller: a\n\n[Reconnected]\nCaller: b');
    expect(segmentsText(row.metadata.relay_segments)).toBe(row.transcription);
    expect(latestPromises(row.metadata.relay_segments)[0].expectation).toBe('b');
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

});
