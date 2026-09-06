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

function primeDb({ loseOwnership = false, emptyRecording = false, pendingSegment = false, recordingUrl = null, attempts = 0 } = {}) {
  const row = {
    extraction_attempts: attempts,
    id: 'late-relay-fixture', twilio_call_sid: 'CA00000000000000000000000000000123',
    direction: 'inbound', from_phone: '+19415550123', to_phone: '+19415550124',
    recording_url: recordingUrl, recording_duration_seconds: 90, duration_seconds: 90,
    transcription: recorded, transcription_provider: 'twilio_builtin', call_outcome: 'voicemail',
    created_at: new Date(), metadata: {
      relay_reconnects: 1, relay_reconnect_ms: 2, relay_session_claim_gen: 2,
      relay_segment_owners: ['first', 'second'],
      relay_segments: [
        ...(!pendingSegment ? [{ session_key: 'first', generation: 1, text: 'Caller: I need a termite inspection.' }] : []),
        { session_key: 'second', generation: 2, text: '' },
      ],
    },
  };
  if (emptyRecording) {
    row.transcription = null;
  }
  let appended = false;
  db.mockImplementation((table) => {
    const builder = {};
    let owner;
    const chain = (...args) => {
      if (args[0] === 'processing_token') owner = args[1];
      for (const arg of args) if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    };
    for (const method of ['where', 'whereRaw', 'whereNull', 'whereNotNull', 'whereIn', 'orWhere', 'orWhereRaw', 'andWhere', 'select', 'orderBy', 'limit', 'leftJoin', 'forUpdate', 'clone', 'onConflict', 'ignore']) builder[method] = chain;
    builder.first = async () => {
      return table === 'call_log' && (!owner || owner === row.processing_token) ? { ...row } : null;
    };
    builder.insert = jest.fn(() => builder);
    builder.update = (patch, returning) => {
      if (table === 'call_log') {
        if (patch.extraction_attempts !== undefined) row.extraction_attempts += 1;
        if (patch.processing_status !== undefined) row.processing_status = patch.processing_status;
        if (patch.processing_token !== undefined) row.processing_token = patch.processing_token;
        if (patch.transcription) row.transcription = recorded; // no relay segment existed at the UPDATE
      }
      return {
        returning: async () => [{ extraction_attempts: row.extraction_attempts }],
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
    row.transcription = composite;
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

  test('a predecessor starting after the checkpoint defers processing until its close is durable', async () => {
    const row = primeDb({ pendingSegment: true });
    await expect(processor.processRecording(row.twilio_call_sid))
      .rejects.toThrow('Relay close records are missing');
    expect(row.processing_status).toBe('extraction_failed');
    expect(row.processing_token).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    row.metadata.relay_segments.push({ session_key: 'first', generation: 1, text: 'Caller: I need a termite inspection.' });
    const result = await processor.processRecording(row.twilio_call_sid);
    expect(result.error).toContain('fixture extraction boundary');
    const prompt = JSON.parse(fetchSpy.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('I need a termite inspection.');
  });

  test('an abandoned socket reaches the existing exhausted-retry triage instead of retrying indefinitely', async () => {
    const row = primeDb({ pendingSegment: true, attempts: processor.CALL_EXTRACTION_MAX_ATTEMPTS - 1 });
    await expect(processor.processRecording(row.twilio_call_sid))
      .rejects.toThrow('Relay close records are missing');
    expect(row.extraction_attempts).toBe(processor.CALL_EXTRACTION_MAX_ATTEMPTS);
    expect(row.processing_status).toBe('extraction_failed');
    expect(db).toHaveBeenCalledWith('triage_items');
    const index = db.mock.calls.findIndex(([table]) => table === 'triage_items');
    expect(db.mock.results[index].value.insert).toHaveBeenCalledWith(expect.objectContaining({
      call_log_id: row.id, reason_code: 'extraction_failed_permanent',
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('an unavailable recorded leg remains retryable even when durable relay text exists', async () => {
    const row = primeDb({ emptyRecording: true, recordingUrl: 'https://api.twilio.com/fixture-recording' });
    const result = await processor.processRecording(row.twilio_call_sid);
    expect(result.error || result.reason).toMatch(/transcription/i);
    expect(row.processing_status).toBe('no_transcription');
    expect(fetchSpy.mock.calls.some(([, opts]) => {
      if (!opts?.body) return false;
      const payload = JSON.parse(opts.body);
      return payload.contents?.[0]?.parts?.[0]?.text?.includes('Extract');
    })).toBe(false);
  });

  test('a reclaimed worker stops before extracting the replacement transcript', async () => {
    const row = primeDb({ loseOwnership: true });
    expect(await processor.processRecording(row.twilio_call_sid))
      .toMatchObject({ skipped: true, reason: 'terminal_write_ownership_lost' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
