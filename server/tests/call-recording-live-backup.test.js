/** GATE_LIVE_CALL_BACKUP_TRANSCRIPT: a call with no recording keeps its live text as the transcript. */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false), isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null), getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));
jest.mock('../services/live-call-transcription', () => ({
  liveTranscriptFor: jest.fn(), purgeLiveUtterances: jest.fn(async () => 0),
}));
const mockGate = { on: false };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn((key) => (key === 'liveCallBackupTranscript' ? mockGate.on : actual.isEnabled(key))) };
});

const db = require('../models/db');
const { liveTranscriptFor } = require('../services/live-call-transcription');
const processor = require('../services/call-recording-processor');

const SID = 'CA00000000000000000000000000000456';
const liveText = 'Caller: I need a termite inspection.\nAgent: Sure, what is the address?';

// Rows + patches the fixture db holds. liveSweepRows feeds recoverMissingRecentRecordings.
// callStatus / createdAt: the call itself (by default an inbound call that completed 40 minutes ago, past the
// unrecorded-call watchdog's 30-minute grace, so no recording is still coming).
function primeDb({ recordingUrl = null, recordingSid = null, status = null, attempts = 0, transcription = null, provider = null,
  callStatus = 'completed', metadata = {}, createdAt = new Date(Date.now() - 40 * 60 * 1000) } = {}) {
  const row = {
    id: 'live-backup-fixture', twilio_call_sid: SID, direction: 'inbound',
    from_phone: '+19415550123', to_phone: '+19415550124', recording_url: recordingUrl, recording_sid: recordingSid,
    recording_duration_seconds: 90, duration_seconds: 90, transcription, transcription_provider: provider, processing_status: status,
    extraction_attempts: attempts, created_at: createdAt, metadata, status: callStatus,
  };
  const patches = [];
  db.mockImplementation((table) => {
    const builder = {};
    let owner;
    const chain = (...args) => {
      if (args[0] === 'processing_token') owner = args[1];
      for (const arg of args) if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    };
    for (const method of ['where', 'whereRaw', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'orWhere', 'orWhereRaw', 'andWhere', 'select', 'orderBy', 'limit', 'leftJoin', 'forUpdate', 'clone', 'onConflict', 'ignore', 'modify']) builder[method] = chain;
    builder.first = async () => (table === 'call_log' && (!owner || owner === row.processing_token) ? { ...row } : null);
    builder.insert = jest.fn(() => builder);
    builder.update = (patch, returning) => {
      if (table === 'call_log') {
        patches.push(patch);
        if (patch.processing_status !== undefined) row.processing_status = patch.processing_status;
        if (patch.processing_token !== undefined) row.processing_token = patch.processing_token;
        if (patch.extraction_attempts !== undefined) row.extraction_attempts += 1;
        if (typeof patch.transcription === 'string') row.transcription = patch.transcription;
        if (patch.transcription_provider !== undefined) row.transcription_provider = patch.transcription_provider;
      }
      return {
        returning: async () => [{ extraction_attempts: row.extraction_attempts }],
        then: (resolve, reject) => Promise.resolve(Array.isArray(returning) ? [{ extraction_attempts: row.extraction_attempts, transcription: row.transcription }] : 1).then(resolve, reject),
      };
    };
    builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return builder;
  });
  db.raw = jest.fn((sql) => sql);
  db.transaction = async (fn) => fn(db);
  return { row, patches };
}

const extractionPrompts = (fetchSpy) => fetchSpy.mock.calls
  .map(([, opts]) => (opts?.body ? JSON.parse(opts.body).contents?.[0]?.parts?.[0]?.text : null))
  .filter((t) => t && t.includes('Extract'));

describe('live-text backup transcript in processRecording', () => {
  let fetchSpy;
  let geminiKey;
  beforeEach(() => {
    jest.clearAllMocks();
    mockGate.on = true;
    liveTranscriptFor.mockResolvedValue({ text: liveText, utterances: 3, panMasked: false });
    geminiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'fixture-only';
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('fixture extraction boundary'));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (geminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = geminiKey;
  });

  // Local pre-push audit P1s: a pass while the call is live (the admin process button) never extracts half a call,
  // and the live text never stands in while Twilio may still post a late recording (the watchdog's 30-minute grace).
  test('the live text stands in only once the call ended 30 minutes ago: never while live, never inside the grace', async () => {
    primeDb({ callStatus: 'in-progress' });
    await processor.processRecording(SID);
    expect(liveTranscriptFor).not.toHaveBeenCalled();

    // Ended 10 s ago (90 s call), and ended 28 minutes ago even with the transcription stopped: a recording may still come.
    const justEnded = primeDb({ createdAt: new Date(Date.now() - 100 * 1000) });
    await processor.processRecording(SID);
    expect(justEnded.row.processing_status).toBe('no_transcription');
    primeDb({ createdAt: new Date(Date.now() - (28 * 60 + 90) * 1000), metadata: { live_transcription: { stopped_at: new Date().toISOString() } } });
    await processor.processRecording(SID);
    expect(liveTranscriptFor).not.toHaveBeenCalled();

    const settled = primeDb({ createdAt: new Date(Date.now() - (31 * 60 + 90) * 1000) });
    await processor.processRecording(SID);
    expect(liveTranscriptFor).toHaveBeenCalledWith(SID);
    expect(settled.row.transcription).toBe(liveText);
  });

  test('gate on, no recording, live text: written as the transcript and extraction runs on it', async () => {
    const { row, patches } = primeDb();
    const result = await processor.processRecording(SID);
    expect(liveTranscriptFor).toHaveBeenCalledWith(SID);
    const write = patches.find((p) => p.transcription_provider === 'twilio_realtime');
    expect(write).toMatchObject({ transcription: liveText, transcription_status: 'completed', transcription_model: null, transcript_structured: null });
    expect(row.transcription).toBe(liveText);
    expect(result.error).toContain('fixture extraction boundary');
    const prompt = JSON.parse(fetchSpy.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('Agent: Sure, what is the address?');
    expect(row.processing_status).not.toBe('no_transcription');
  });

  test('the write carries the live provenance and the card-masked flag', async () => {
    liveTranscriptFor.mockResolvedValue({ text: liveText, utterances: 3, panMasked: true });
    const { patches } = primeDb();
    await processor.processRecording(SID);
    const write = patches.find((p) => p.transcription_provider === 'twilio_realtime');
    const [, bindings] = db.raw.mock.calls.find(([sql]) => String(sql).includes('jsonb_object_agg'));
    expect(JSON.parse(bindings[bindings.length - 1])).toEqual({
      source: 'live_transcription', recording_transcription_unavailable: true, utterances: 3, pan_detected_live: true,
    });
    expect(write.transcription_metadata).toBeDefined();
  });

  test('gate off: no recording stays no_transcription and the live text is never read', async () => {
    mockGate.on = false;
    const { row } = primeDb();
    const result = await processor.processRecording(SID);
    expect(result.error).toMatch(/transcription/i);
    expect(row.processing_status).toBe('no_transcription');
    expect(liveTranscriptFor).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('gate on but no utterances: no_transcription as today', async () => {
    liveTranscriptFor.mockResolvedValue(null);
    const { row } = primeDb();
    const result = await processor.processRecording(SID);
    expect(result.error).toMatch(/transcription/i);
    expect(row.processing_status).toBe('no_transcription');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a read failure on the live text falls through to no_transcription', async () => {
    liveTranscriptFor.mockRejectedValue(new Error('db down'));
    const { row } = primeDb();
    await processor.processRecording(SID);
    expect(row.processing_status).toBe('no_transcription');
  });

  test('a call WITH a recording whose transcription failed stays no_transcription; live text unused', async () => {
    const { row } = primeDb({ recordingUrl: 'https://api.twilio.com/fixture-recording', recordingSid: 'RE00000000000000000000000000000001' });
    const result = await processor.processRecording(SID);
    expect(result.error || result.reason).toMatch(/transcription/i);
    expect(row.processing_status).toBe('no_transcription');
    expect(liveTranscriptFor).not.toHaveBeenCalled();
    expect(extractionPrompts(fetchSpy)).toHaveLength(0);
  });

  test('a quarantined recording (SID kept, url cleared) never uses the live text', async () => {
    const { row } = primeDb({ recordingSid: 'RE00000000000000000000000000000002' });
    await processor.processRecording(SID);
    expect(row.processing_status).toBe('no_transcription');
    expect(liveTranscriptFor).not.toHaveBeenCalled();
  });

  test('a retry after a failed extraction goes through the live branch again and keeps the live provenance', async () => {
    const { row, patches } = primeDb();
    await processor.processRecording(SID);
    expect(row.transcription_provider).toBe('twilio_realtime');
    // A later utterance arrived; the retry must read it, not reuse the stored copy.
    const longer = `${liveText}\nCaller: It is 12 Palm Street.`;
    liveTranscriptFor.mockResolvedValue({ text: longer, utterances: 4, panMasked: false });
    row.processing_status = 'extraction_failed';
    row.processing_token = null;
    patches.length = 0;
    fetchSpy.mockClear();
    await processor.processRecording(SID);
    expect(liveTranscriptFor).toHaveBeenCalledTimes(2);
    expect(patches.some((p) => p.transcription_provider === 'twilio_builtin')).toBe(false);
    expect(patches.find((p) => p.transcription_provider === 'twilio_realtime')).toMatchObject({ transcription: longer });
    expect(row.transcription_provider).toBe('twilio_realtime');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).contents[0].parts[0].text).toContain('It is 12 Palm Street.');
  });

  test('a stored live transcript is not recorded evidence when a recording later arrives and fails to transcribe', async () => {
    const { row, patches } = primeDb({
      recordingUrl: 'https://api.twilio.com/fixture-recording', recordingSid: 'RE00000000000000000000000000000003',
      status: 'extraction_failed', transcription: liveText, provider: 'twilio_realtime',
    });
    const result = await processor.processRecording(SID);
    expect(result.error || result.reason).toMatch(/transcription/i);
    expect(row.processing_status).toBe('no_transcription');
    expect(patches.some((p) => p.transcription_provider === 'twilio_builtin')).toBe(false);
    expect(liveTranscriptFor).not.toHaveBeenCalled();
    expect(extractionPrompts(fetchSpy)).toHaveLength(0);
  });

  test('a stored RECORDED transcript still serves as the cached fallback (unchanged)', async () => {
    const { patches } = primeDb({
      recordingUrl: 'https://api.twilio.com/fixture-recording', recordingSid: 'RE00000000000000000000000000000004',
      status: 'extraction_failed', transcription: liveText, provider: 'twilio_builtin',
    });
    await processor.processRecording(SID);
    expect(patches.some((p) => p.transcription_provider === 'twilio_builtin')).toBe(true);
  });

  test('a lost write fence abandons the pass without extracting', async () => {
    const { row } = primeDb();
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      const builder = base(table);
      const update = builder.update;
      builder.update = (patch, returning) => (patch.transcription_provider === 'twilio_realtime' ? 0 : update(patch, returning));
      return builder;
    });
    expect(await processor.processRecording(SID)).toMatchObject({ skipped: true, reason: 'terminal_write_ownership_lost' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(row.transcription).toBeNull();
  });
});

describe('missing-recording sweep with live text', () => {
  let procSpy;
  let recoverSpy;
  // The sweep reads candidates, then per no_completed_recording result the live row and the call state.
  // state: the call's row as the sweep reads it, over an inbound call that completed 40 minutes ago (past the grace).
  function primeSweep({ liveRow = { id: 1 }, state = {} } = {}) {
    const callState = { direction: 'inbound', status: 'completed', created_at: new Date(Date.now() - 40 * 60 * 1000), duration_seconds: 120,
      processing_status: null, extraction_attempts: 0, ...state };
    db.mockImplementation((table) => {
      const builder = {};
      const chain = (...args) => { for (const arg of args) if (typeof arg === 'function') arg.call(builder, builder); return builder; };
      for (const method of ['where', 'whereRaw', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'orWhere', 'orWhereRaw', 'select', 'orderBy', 'orderByRaw', 'limit', 'modify']) builder[method] = chain;
      builder.first = async () => (table === 'call_live_utterances' ? (liveRow || undefined) : table === 'call_log' ? callState : null);
      builder.then = (resolve, reject) => Promise.resolve(table === 'call_log'
        ? [{ twilio_call_sid: SID, direction: 'inbound', duration_seconds: 120 }] : []).then(resolve, reject);
      return builder;
    });
    db.raw = jest.fn((sql) => sql);
  }
  beforeEach(() => {
    jest.clearAllMocks();
    mockGate.on = true;
    recoverSpy = jest.spyOn(processor, 'recoverRecordingForCall').mockResolvedValue({ success: false, reason: 'no_completed_recording' });
    procSpy = jest.spyOn(processor, 'processRecording').mockResolvedValue({ success: true });
  });
  afterEach(() => { recoverSpy.mockRestore(); procSpy.mockRestore(); });

  test('no_completed_recording + live text + gate on: one processRecording call', async () => {
    primeSweep();
    await processor.recoverMissingRecentRecordings();
    expect(procSpy).toHaveBeenCalledTimes(1);
    expect(procSpy).toHaveBeenCalledWith(SID);
  });

  test('a call inside the unrecorded-call grace gets no pass yet: its recording may still come', async () => {
    primeSweep({ state: { created_at: new Date(Date.now() - 5 * 60 * 1000) } });
    await processor.recoverMissingRecentRecordings();
    expect(procSpy).not.toHaveBeenCalled();
  });

  test('gate off: no processRecording call', async () => {
    mockGate.on = false;
    primeSweep();
    await processor.recoverMissingRecentRecordings();
    expect(procSpy).not.toHaveBeenCalled();
  });

  test('no live text: no processRecording call', async () => {
    primeSweep({ liveRow: null });
    await processor.recoverMissingRecentRecordings();
    expect(procSpy).not.toHaveBeenCalled();
  });

  test('a stale processing claim (stopped beating) is admitted through the reclaim predicate', async () => {
    primeSweep({ state: { processing_status: 'processing', extraction_attempts: 0, claim_stale: true } });
    await processor.recoverMissingRecentRecordings();
    expect(procSpy).toHaveBeenCalledTimes(1);
    const rawSql = db.raw.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('claim_stale'));
    expect(rawSql).toBe(`${processor._test.reclaimableClaimSql(10)} AS claim_stale`);
  });

  test('a fresh processing claim is left alone', async () => {
    primeSweep({ state: { processing_status: 'processing', extraction_attempts: 0, claim_stale: false } });
    await processor.recoverMissingRecentRecordings();
    expect(procSpy).not.toHaveBeenCalled();
  });

  test('a stale claim at the retry cap is left alone', async () => {
    primeSweep({ state: { processing_status: 'processing', extraction_attempts: 99, claim_stale: true } });
    await processor.recoverMissingRecentRecordings();
    expect(procSpy).not.toHaveBeenCalled();
  });

  test('a call already processed is left alone', async () => {
    primeSweep({ state: { processing_status: 'processed', extraction_attempts: 0 } });
    await processor.recoverMissingRecentRecordings();
    expect(procSpy).not.toHaveBeenCalled();
  });

  test('a pass that throws is logged with the SID masked and the sweep still returns', async () => {
    primeSweep();
    procSpy.mockRejectedValue(new Error('boom'));
    const result = await processor.recoverMissingRecentRecordings();
    expect(result.checked).toBe(1);
    const warn = require('../services/logger').warn.mock.calls.map((c) => c[0]).find((m) => /live backup transcript pass failed/.test(m));
    expect(warn).toBeDefined();
    expect(warn).not.toContain(SID);
  });
});
