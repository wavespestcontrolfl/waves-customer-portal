// SIGTERM hands a call-processing claim back (GATE_CALL_PROC_SHUTDOWN_RELEASE).
//
// Why: 2026-10-09 a 56-second lead call took 30 minutes to process — three
// deploys in ten minutes killed the pass mid-transcription and the row waited
// for the 10-minute quiet reclaim plus a sweep tick. With the gate on, the
// draining process releases the claim (status restored, token cleared,
// metadata.shutdown_released_at stamped) and the next pod's sweep takes the
// row without the 10-minute CDN-settle age gate — once.
//
// The claim and the sweep predicates are raw SQL a mocked builder cannot
// evaluate, so the behavior suite runs the REAL processRecording /
// processAllPending against a real call_log row (DATABASE_URL only, same
// convention as call-processing-claim-concurrency.test.js). The download is
// stubbed: a hanging fetch keeps the pass in flight; a 404 maps to the
// recording-not-ready release. No provider key is ever used. Fixtures are
// fictitious: 555-01xx numbers, fake SIDs, no transcript text.
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const SID = 'CA' + '8'.repeat(30) + 'd1';
const REC = 'RE' + '8'.repeat(32);
const RECORDING_URL = `https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/${REC}.mp3`;

describe('releaseInFlightForShutdown with the gate off (unit)', () => {
  test('is a no-op that reports counts only, and processRecording is not refused', async () => {
    let processor;
    jest.isolateModules(() => {
      delete process.env.GATE_CALL_PROC_SHUTDOWN_RELEASE;
      processor = require('../services/call-recording-processor');
    });
    const summary = await processor.releaseInFlightForShutdown({ graceMs: 0 });
    expect(summary).toEqual({ enabled: false, inFlight: 0, finished: 0, released: 0, lost: 0 });
    expect(processor.inFlightPassCount()).toBe(0);
  });
});

maybeDescribe('releaseInFlightForShutdown with the gate on (live Postgres)', () => {
  let db;
  let processor;
  let fetchSpy;
  const rowIds = [];

  const readRow = () => db('call_log').where({ twilio_call_sid: SID }).first();

  beforeAll(async () => {
    process.env.GATE_CALL_PROC_SHUTDOWN_RELEASE = 'true';
    jest.resetModules();
    db = require('../models/db');
    processor = require('../services/call-recording-processor');
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('not found', { status: 404 }));
    await db('call_log').where({ twilio_call_sid: SID }).del();
    const [row] = await db('call_log').insert({
      twilio_call_sid: SID,
      direction: 'inbound',
      from_phone: '+15555550133',
      to_phone: '+15555550100',
      status: 'completed',
      duration_seconds: 60,
      recording_sid: REC,
      recording_url: RECORDING_URL,
      recording_duration_seconds: 60,
      transcription_status: 'pending',
      processing_status: null,
      metadata: JSON.stringify({ source: 'voice_webhook', fixture: 'shutdown-release' }),
    }).returning('id');
    rowIds.push(row.id);
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    delete process.env.GATE_CALL_PROC_SHUTDOWN_RELEASE;
    if (rowIds.length) await db('call_log').whereIn('id', rowIds).del();
    await db.destroy();
  });

  test('a pass in flight at SIGTERM hands its claim back; its own later write matches no rows; the sweep takes the row at once, once', async () => {
    // Hold the download open so the pass is genuinely mid-flight when the
    // shutdown path runs.
    let releaseDownload;
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => {
      releaseDownload = () => resolve(new Response('not found', { status: 404 }));
    }));
    const pass = processor.processRecording(SID);
    await new Promise((r) => setTimeout(r, 400));
    expect(processor.inFlightPassCount()).toBe(1);
    const claimed = await readRow();
    expect(claimed.processing_status).toBe('processing');
    expect(claimed.processing_token).toBeTruthy();

    const summary = await processor.releaseInFlightForShutdown({ graceMs: 100 });
    expect(summary).toEqual({ enabled: true, inFlight: 1, finished: 0, released: 1, lost: 0 });

    const released = await readRow();
    // Pre-claim status restored (NULL: a fresh row), token cleared, stamped.
    expect(released.processing_status).toBeNull();
    expect(released.processing_token).toBeNull();
    expect(released.metadata.shutdown_released_at).toEqual(expect.any(String));
    expect(Number(released.processing_generation)).toBe(1);

    // The dying pass wakes up: its not-ready release is token-fenced and
    // changes nothing; the row keeps the handed-back state.
    releaseDownload();
    const result = await pass;
    expect(result.reason).toBe('recording_not_ready');
    const afterPass = await readRow();
    expect(afterPass.processing_status).toBeNull();
    expect(afterPass.processing_token).toBeNull();
    expect(afterPass.metadata.shutdown_released_at).toEqual(released.metadata.shutdown_released_at);
    expect(processor.inFlightPassCount()).toBe(0);

    // The draining process itself refuses a new claim.
    const refused = await processor.processRecording(SID);
    expect(refused).toEqual({ success: false, skipped: true, reason: 'shutting_down' });

    // The replacing pod (same module, drain flag reset) sweeps: updated_at is
    // seconds old, so only the stamp lets the row in; the claim clears the
    // stamp and the 404 releases the row as not ready.
    processor._test.resetShutdownForTests();
    const before = fetchSpy.mock.calls.length;
    await processor.processAllPending();
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
    const swept = await readRow();
    expect(Number(swept.processing_generation)).toBe(2);
    expect(swept.processing_status).toBeNull();
    expect(swept.processing_token).toBeNull();
    expect(swept.metadata.shutdown_released_at).toBeUndefined();
    expect(swept.metadata.fixture).toBe('shutdown-release');

    // Stamp gone, updated_at fresh: the age gate holds again.
    await processor.processAllPending();
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
    expect(Number((await readRow()).processing_generation)).toBe(2);
  });

  test('a stamped extraction_failed retry is swept and claimed inside the 10-minute backoff, once (Codex r1 P1)', async () => {
    processor._test.resetShutdownForTests();
    // A retry pass handed back at a deploy: status restored to
    // extraction_failed, attempts under the cap, updated_at seconds old, stamped.
    await db('call_log').where({ twilio_call_sid: SID }).update({
      processing_status: 'extraction_failed',
      extraction_attempts: 1,
      processing_token: null,
      // Not 'pending': only the extraction_failed sweep branch may admit it.
      transcription_status: 'completed',
      updated_at: new Date(),
      metadata: JSON.stringify({ fixture: 'shutdown-release', shutdown_released_at: new Date().toISOString() }),
    });
    const generation = Number((await readRow()).processing_generation);
    const before = fetchSpy.mock.calls.length;
    await processor.processAllPending();
    // Swept AND claimed (the claim's own backoff guard honours the stamp too):
    // the 404 releases the row as not ready with the retry status restored.
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
    const swept = await readRow();
    expect(Number(swept.processing_generation)).toBe(generation + 1);
    expect(swept.processing_status).toBe('extraction_failed');
    expect(Number(swept.extraction_attempts)).toBe(1);
    expect(swept.metadata.shutdown_released_at).toBeUndefined();
    // Stamp cleared, updated_at fresh: the backoff holds again.
    await processor.processAllPending();
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
    await db('call_log').where({ twilio_call_sid: SID }).update({
      processing_status: null, extraction_attempts: 0, transcription_status: 'pending', metadata: JSON.stringify({ fixture: 'shutdown-release' }),
    });
  });

  test('a pass that finishes inside the grace is counted finished and nothing is written', async () => {
    processor._test.resetShutdownForTests();
    // Instant 404: the pass claims and releases itself within the grace.
    const pass = processor.processRecording(SID);
    const summary = await processor.releaseInFlightForShutdown({ graceMs: 5000 });
    await pass;
    expect(summary.enabled).toBe(true);
    expect(summary.released).toBe(0);
    expect(summary.finished + (summary.inFlight === 0 ? 1 : 0)).toBeGreaterThanOrEqual(1);
    const row = await readRow();
    expect(row.processing_token).toBeNull();
    expect(row.metadata.shutdown_released_at).toBeUndefined();
  });
});
