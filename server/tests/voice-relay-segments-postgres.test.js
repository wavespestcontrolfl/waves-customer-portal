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
      t.text('processing_token'); t.text('source'); t.text('call_outcome'); t.jsonb('transcript_structured'); t.timestamp('updated_at');
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

  test.each([{ relay_handoff: {} }, { relay_transfer_ring_at: '2026-01-01T00:00:00Z' }])('late append restores the AI half of a transfer that never reconnected: %j', async (evidence) => {
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture',
      metadata: { relay_session_claim_owner: 'first', ...evidence },
      transcription: 'Recorded caller message.', transcription_provider: 'fixture_recording', call_outcome: 'voicemail' });
    await appendSegment(db, 'CA-fixture', buildSegment({ generation: 1, sessionKey: 'first', text: 'Caller: ants' }));
    expect((await db('call_log').first()).transcription).toBe('[AI segment]\nCaller: ants\n\n[Voicemail segment]\nRecorded caller message.');
  });

  test.each(['voicemail', 'ai_transferred'])('late text composes around a provider-null rejected recording (%s)', async (outcome) => {
    const sentinel = '[Recording had no usable speech; an implausible transcription was rejected.]';
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture',
      metadata: { relay_reconnects: 1, relay_reconnect_ms: 3 },
      transcription: sentinel, transcription_provider: null, call_outcome: outcome,
      transcription_metadata: { recorded_segment_rejected: { reason: 'primary_hallucinated_no_fallback' } } });
    await appendSegment(db, 'CA-fixture', buildSegment({ generation: 1, sessionKey: 'first', text: 'Caller: ants in kitchen' }));
    const row = await db('call_log').first();
    expect(row.transcription).toBe(`[AI segment]\nCaller: ants in kitchen\n\n[${outcome === 'voicemail' ? 'Voicemail' : 'Staff'} segment]\n${sentinel}`);
    expect(row.transcription_provider).toBeNull();
  });

  test('the superseded same-generation nonce retains its segment after reconnect takeover', async () => {
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', metadata: {
      relay_reconnects: 1, relay_reconnect_ms: 2, relay_session_claim_gen: 2, relay_session_claim_owner: 'nonce-z',
    } });
    expect(await appendSegment(db, 'CA-fixture', buildSegment({ generation: 2, sessionKey: 'nonce-a', text: 'Caller: earlier leg' }))).toBe(1);
    expect(await appendSegment(db, 'CA-fixture', buildSegment({ generation: 2, sessionKey: 'nonce-zz', text: 'Caller: not a prior owner' }))).toBe(0);
    expect((await db('call_log').first()).metadata.relay_segments[0].text).toBe('Caller: earlier leg');
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

  test('SQL and memory apply the whole-call cap after ordering and scrubbing', async () => {
    const { MAX_TRANSCRIPT_CHARS } = require('../services/voice-agent/relay-transcript');
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture',
      metadata: { relay_reconnects: 1, relay_reconnect_ms: 3 } });
    for (const generation of [2, 1]) await appendSegment(db, 'CA-fixture', buildSegment({
      generation, sessionKey: `session-${generation}`, text: Array(20).fill('Caller: ' + 'x'.repeat(2000)).join('\n'),
    }));
    const row = await db('call_log').first();
    expect(row.transcription).toHaveLength(MAX_TRANSCRIPT_CHARS);
    expect(row.transcription).toBe(segmentsText(row.metadata.relay_segments));
    expect(row.metadata.relay_segments).toHaveLength(2);
  });

  test('an uncommitted predecessor defers the seal; a completed set forbids later claims and appends', async () => {
    const { beginRelaySessionClaim } = require('../services/voice-agent/relay-context');
    const { sealSegmentsForExtraction } = require('../services/voice-agent/relay-segments');
    const gate = process.env.GATE_VOICE_RELAY_RECOVERY;
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    try {
      await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', processing_token: 'processor' });
      expect(await beginRelaySessionClaim('CA-fixture', 'first', 1)).toBe(true);
      expect(await beginRelaySessionClaim('CA-fixture', 'second', 2)).toBe(true);
      await db('call_log').update({ metadata: db.raw("metadata || '{\"relay_reconnects\":1,\"relay_reconnect_ms\":2}'::jsonb") });
      await appendSegment(db, 'CA-fixture', buildSegment({ generation: 2, sessionKey: 'second', text: '' }));
      expect(await sealSegmentsForExtraction(db, 'fixture', 'processor')).toEqual({ status: 'pending' });
      // This writer STARTS after the extraction checkpoint, the race that a
      // standalone SELECT FOR UPDATE could not prevent.
      await appendSegment(db, 'CA-fixture', buildSegment({ generation: 1, sessionKey: 'first', text: 'Caller: termite inspection' }));
      const sealed = await sealSegmentsForExtraction(db, 'fixture', 'processor');
      expect(sealed.status).toBe('ready');
      expect(sealed.row.transcription).toContain('termite inspection');
      expect(await beginRelaySessionClaim('CA-fixture', 'third', 3)).toBe(false);
      const before = await db('call_log').first();
      expect(await appendSegment(db, 'CA-fixture', buildSegment({ generation: 0, sessionKey: 'unknown', text: 'Caller: late' }))).toBe(0);
      expect(await appendSegment(db, 'CA-fixture', buildSegment({ generation: 1, sessionKey: 'first', text: 'Caller: changed' }))).toBe(1);
      expect(await db('call_log').first()).toEqual(before);
      expect(await sealSegmentsForExtraction(db, 'fixture', 'replacement')).toEqual({ status: 'ownership_lost' });
    } finally {
      if (gate === undefined) delete process.env.GATE_VOICE_RELAY_RECOVERY;
      else process.env.GATE_VOICE_RELAY_RECOVERY = gate;
    }
  });

  test('authenticated unclaimed sockets join the same barrier without gaining a customer claim', async () => {
    const { registerSegmentSession, sealSegmentsForExtraction } = require('../services/voice-agent/relay-segments');
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', processing_token: 'processor' });
    expect(await registerSegmentSession(db, 'CA-fixture', 'withheld')).toBe(true);
    expect(await sealSegmentsForExtraction(db, 'fixture', 'processor')).toEqual({ status: 'pending' });
    expect(await appendSegment(db, 'CA-fixture', buildSegment({ sessionKey: 'withheld', text: 'Caller: ants' }))).toBe(1);
    expect((await sealSegmentsForExtraction(db, 'fixture', 'processor')).status).toBe('ready');
    const row = await db('call_log').first();
    expect(row.metadata.relay_session_claim_owner).toBeUndefined();
    expect(row.metadata.relay_segments[0].text).toContain('ants');
    expect(await registerSegmentSession(db, 'CA-fixture', 'late')).toBe(false);
  });

  test('legacy recordings seal their existing evidence without requiring retroactive close records', async () => {
    const { registerSegmentSession, sealSegmentsForExtraction } = require('../services/voice-agent/relay-segments');
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture', processing_token: 'processor', transcription: 'Legacy recording' });
    const result = await sealSegmentsForExtraction(db, 'fixture', 'processor');
    expect(result.status).toBe('ready');
    expect(result.row.transcription).toBe('Legacy recording');
    expect(await registerSegmentSession(db, 'CA-fixture', 'late')).toBe(false);
  });

  test('a superseded equal-generation nonce cannot finalize through the shared close fence', async () => {
    const { closeFenceSql } = require('../services/voice-agent/relay-segments');
    await db('call_log').insert({ id: 'fixture', twilio_call_sid: 'CA-fixture',
      metadata: { relay_reconnect_ms: 2, relay_session_claim_gen: 2, relay_session_claim_owner: 'nonce-z' } });
    expect(await closeFenceSql(db('call_log').where('id', 'fixture'), 2, 'nonce-a').update({ call_summary: 'stale' })).toBe(0);
    expect(await closeFenceSql(db('call_log').where('id', 'fixture'), 2, 'nonce-z').update({ call_summary: 'current' })).toBe(1);
  });

});
