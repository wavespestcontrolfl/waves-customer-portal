/** A late socket append must reach extraction, not only the stored transcript. */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false), isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null), getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const db = require('../models/db');
const { syncVoiceMessageForCall } = require('../services/conversations');
const processor = require('../services/call-recording-processor');
const recorded = 'Caller: Please call me back about the details I gave Sandy.';
const composite = `[AI segment]\nCaller: I need a termite inspection.\n\n[Voicemail segment]\n${recorded}`;

function primeDb({ loseOwnership = false, extractionRead = null, emptyRecording = false } = {}) {
  const row = {
    id: 'late-relay-fixture', twilio_call_sid: 'CA00000000000000000000000000000123',
    direction: 'inbound', from_phone: '+19415550123', to_phone: '+19415550124',
    recording_url: null, recording_duration_seconds: 90, duration_seconds: 90,
    transcription: recorded, transcription_provider: 'twilio_builtin', call_outcome: 'voicemail',
    created_at: new Date(), metadata: { relay_reconnects: 1, relay_reconnect_ms: 2, relay_session_claim_gen: 2 },
  };
  if (emptyRecording) {
    row.transcription = null;
    row.metadata.relay_segments = [{ generation: 1, text: 'Caller: I need a termite inspection.' }];
  }
  let appended = false;
  db.mockImplementation((table) => {
    const builder = {};
    let owner;
    let lockRequested = false;
    const chain = (...args) => {
      if (args[0] === 'processing_token') owner = args[1];
      for (const arg of args) if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    };
    for (const method of ['where', 'whereRaw', 'whereNull', 'whereNotNull', 'whereIn', 'orWhere', 'orWhereRaw', 'andWhere', 'select', 'orderBy', 'limit', 'leftJoin', 'forUpdate']) builder[method] = chain;
    builder.forUpdate = () => { lockRequested = true; return builder; };
    builder.first = async (...columns) => {
      if (table === 'call_log' && owner && columns[0] === 'transcription' && extractionRead) return extractionRead({ lockRequested, owner });
      return table === 'call_log' && (!owner || owner === row.processing_token) ? { ...row } : null;
    };
    builder.update = (patch, returning) => {
      if (table === 'call_log') {
        if (patch.processing_token !== undefined) row.processing_token = patch.processing_token;
        if (patch.transcription) row.transcription = recorded; // no relay segment existed at the UPDATE
      }
      return {
        returning: async () => [{ extraction_attempts: 1 }],
        then: (resolve, reject) => Promise.resolve(returning?.includes('transcription') ? [{ transcription: row.transcription }] : 1).then(resolve, reject),
      };
    };
    builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return builder;
  });
  db.raw = jest.fn((sql) => sql);
  db.transaction = async (fn) => fn(db);
  syncVoiceMessageForCall.mockImplementation(async () => {
    if (appended) return;
    appended = true;
    // appendSegmentPatch has repaired the column AFTER writeTranscript
    // returned the recording-only value. The processor's local copy is stale.
    if (!extractionRead) row.transcription = composite;
    if (loseOwnership) row.processing_token = 'replacement-worker';
  });
  return row;
}

describe('late relay transcript at the extraction boundary', () => {
  let fetchSpy;
  let geminiKey;
  beforeEach(() => {
    jest.clearAllMocks();
    geminiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'fixture-only';
    // Capture the actual extraction prompt and stop before routing; no network.
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('fixture extraction boundary'));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (geminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = geminiKey;
  });

  test('extraction consumes a composite appended after the recording UPDATE', async () => {
    const row = primeDb();
    const result = await processor.processRecording(row.twilio_call_sid);
    expect(result.error).toContain('fixture extraction boundary');
    const prompt = JSON.parse(fetchSpy.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain(composite);
  });

  test('an empty recording still extracts the durable AI conversation', async () => {
    const row = primeDb({ emptyRecording: true });
    const result = await processor.processRecording(row.twilio_call_sid);
    expect(result.error).toContain('fixture extraction boundary');
    const prompt = JSON.parse(fetchSpy.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('I need a termite inspection.');
  });

  const postgres = process.env.VOICE_RECOVERY_TEST_DATABASE_URL ? test : test.skip;
  postgres('extraction waits for a segment writer holding the call row lock', async () => {
    const knex = require('knex');
    const connection = process.env.VOICE_RECOVERY_TEST_DATABASE_URL;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) throw new Error('Use isolated loopback PostgreSQL');
    const pg = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
    const table = `extraction_lock_${require('crypto').randomUUID().replaceAll('-', '')}`;
    let writer;
    let release;
    let processing;
    try {
      await pg.schema.createTable(table, (t) => { t.text('id').primary(); t.text('transcription'); t.text('processing_token'); });
      await pg(table).insert({ id: 'fixture', transcription: recorded });
      let started;
      const pending = new Promise((resolve) => { started = resolve; });
      const finish = new Promise((resolve) => { release = resolve; });
      writer = pg.transaction(async (trx) => {
        await trx(table).where('id', 'fixture').update({ transcription: composite });
        started();
        await finish;
      });
      await pending;
      let reading;
      const reachedRead = new Promise((resolve) => { reading = resolve; });
      const row = primeDb({ extractionRead: async ({ lockRequested }) => {
        const query = pg(table).where('id', 'fixture');
        if (lockRequested) query.forUpdate();
        reading();
        return query.first('transcription');
      } });
      processing = processor.processRecording(row.twilio_call_sid);
      await reachedRead;
      // Wait until PostgreSQL reports the extraction read blocked on the
      // writer. An unlocked read instead proceeds to the intercepted model.
      let waited = false;
      for (let attempt = 0; attempt < 50 && !fetchSpy.mock.calls.length; attempt += 1) {
        const locks = await pg('pg_stat_activity').where('wait_event_type', 'Lock').where('query', 'like', `%${table}%`).first('pid');
        if (locks) { waited = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      release();
      await writer;
      await processing;
      expect(waited).toBe(true);
      const prompt = JSON.parse(fetchSpy.mock.calls[0][1].body).contents[0].parts[0].text;
      expect(prompt).toContain(composite);
    } finally {
      release?.();
      await writer?.catch(() => {});
      await processing?.catch(() => {});
      await pg.schema.dropTableIfExists(table);
      await pg.destroy();
    }
  });

  test('a reclaimed worker stops before extracting the replacement transcript', async () => {
    const row = primeDb({ loseOwnership: true });
    expect(await processor.processRecording(row.twilio_call_sid))
      .toMatchObject({ skipped: true, reason: 'terminal_write_ownership_lost' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
