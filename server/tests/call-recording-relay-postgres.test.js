/** Execute the processor's actual composition expressions against isolated PostgreSQL. */
const knex = require('knex');
const { randomUUID } = require('crypto');
const sourcePath = require.resolve('../services/call-recording-processor');
const source = require('fs').readFileSync(sourcePath, 'utf8');
const processorRequire = require('module').createRequire(sourcePath);
const connection = process.env.VOICE_RECOVERY_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let db;
const table = `recording_relay_${randomUUID().replaceAll('-', '')}`;

function expression(name, text = null) {
  const match = source.match(new RegExp(`const ${name} = (?:\\([^)]*\\) => )?db\\.raw\\(([\\s\\S]*?)\\n\\s{4,6}\\);`));
  if (!match) throw new Error(`Missing processor expression ${name}`);
  return new Function('db', 'require', 'RELAY_TRANSCRIPTION_PROVIDER', 'relayTextSql', 'text', `return db.raw(${match[1]});`)(
    db, processorRequire, 'conversation_relay', () => expression('relayTextSql'), text,
  );
}

postgres('recording composition retains legacy relay columns', () => {
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) throw new Error('Use isolated loopback PostgreSQL');
    db = knex({ client: 'pg', connection });
    await db.schema.createTable(table, (t) => {
      t.text('id').primary(); t.jsonb('metadata'); t.text('transcription'); t.text('transcription_provider'); t.text('call_outcome');
    });
  });
  afterAll(async () => { if (db) { await db.schema.dropTableIfExists(table); await db.destroy(); } });

  test('the first recording write preserves column-only AI text, and a second pass retains it', async () => {
    const ai = 'Caller: I requested a termite inspection.';
    await db(table).insert({ id: 'fixture', metadata: { relay_reconnects: 1 },
      transcription: ai, transcription_provider: 'conversation_relay', call_outcome: 'voicemail' });
    for (const recording of ['Caller: Please call me back.', 'Caller: Please use the updated details.']) {
      await db(table).where('id', 'fixture').update({
        metadata: expression('relayStash'), transcription: expression('composeInSql', recording), transcription_provider: 'fixture-recording',
      });
      const row = await db(table).first();
      expect(row.transcription).toBe(`[AI segment]\n${ai}\n\n[Voicemail segment]\n${recording}`);
      expect(row.metadata.relay_transcript.text).toBe(ai);
      expect(row.metadata.relay_reconnects).toBe(1);
    }
  });

  test.each([20000, 70000])('the actual processor UPDATE shares the composite budget for a %s-character recording', async (length) => {
    const { composeRelayTranscript } = require('../services/voice-agent/relay-transcript');
    const ai = '🌊'.repeat(60000);
    const recorded = '🌊'.repeat(length);
    await db(table).insert({ id: `budget-${length}`, metadata: { relay_transcript: { text: ai } }, call_outcome: 'voicemail' });
    await db(table).where('id', `budget-${length}`).update({ transcription: expression('composeInSql', recorded) });
    expect((await db(table).where('id', `budget-${length}`).first()).transcription)
      .toBe(composeRelayTranscript(ai, '\n\n[Voicemail segment]\n' + recorded));
  });
});
