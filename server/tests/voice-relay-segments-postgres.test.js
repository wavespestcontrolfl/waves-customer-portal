/** Isolated loopback PostgreSQL only; creates and drops its own fixture schema. */
const knex = require('knex');
const { randomUUID } = require('crypto');
const { buildSegment, appendSegment } = require('../services/voice-agent/relay-segments');
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
    db = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.schema.createTable('call_log', (t) => {
      t.text('id').primary(); t.text('twilio_call_sid').unique(); t.jsonb('metadata'); t.text('transcription');
      t.text('transcription_provider'); t.text('transcription_status');
      t.text('call_outcome'); t.jsonb('transcript_structured'); t.timestamp('updated_at');
    });
  });
  afterAll(async () => {
    if (db) await db.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });
  beforeEach(async () => { await db('call_log').delete(); });

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

});
