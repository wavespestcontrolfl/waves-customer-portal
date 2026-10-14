// A deploy stamps the call-processing passes it interrupts
// (GATE_CALL_PROC_SHUTDOWN_RELEASE).
//
// Why: 2026-10-09 a 56-second lead call took 30 minutes to process — three
// deploys in ten minutes killed the pass mid-transcription and the row waited
// for the 10-minute quiet reclaim plus a sweep tick. With the gate on, SIGTERM
// stamps every row this process holds a claim for (metadata
// .shutdown_interrupted_at) and changes nothing else: the dying pass keeps its
// claim, so no second pass can overlap it. On the replacing pod a stamped
// claim is reclaimable after 2 quiet heartbeat minutes instead of 10; a
// stamped claim that is still beating is never taken; the claim that takes
// the row clears the stamp.
//
// The claim and sweep predicates are raw SQL a mocked builder cannot evaluate,
// so the behavior suite runs the REAL processRecording / processAllPending
// against real call_log rows (DATABASE_URL only, same convention as
// call-processing-claim-concurrency.test.js). The download is stubbed: a held
// fetch keeps a pass in flight; a 404 maps to the recording-not-ready release.
// No provider key is ever used. Fixtures are fictitious: 555-01xx numbers,
// fake SIDs, no transcript text.
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const sid = (tail) => 'CA' + '8'.repeat(30) + tail;
const SID = sid('d1');
const SID_DEAD = sid('d2');
const SID_BEATING = sid('d3');
const SID_UNSTAMPED = sid('d4');
const SID_LATE = sid('d5');
const SID_QUAR_STAMPED = sid('d6');
const SID_QUAR_UNSTAMPED = sid('d7');
const REC = 'RE' + '8'.repeat(32);
const RECORDING_URL = `https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/${REC}.mp3`;
const ALL_SIDS = [SID, SID_DEAD, SID_BEATING, SID_UNSTAMPED, SID_LATE, SID_QUAR_STAMPED, SID_QUAR_UNSTAMPED];

describe('markInFlightForShutdown with the gate off (unit)', () => {
  test('is a no-op that reports counts only', async () => {
    let processor;
    jest.isolateModules(() => {
      delete process.env.GATE_CALL_PROC_SHUTDOWN_RELEASE;
      processor = require('../services/call-recording-processor');
    });
    const summary = await processor.markInFlightForShutdown({ deadlineMs: 0 });
    expect(summary).toEqual({ enabled: false, inFlight: 0, stamped: 0, failed: 0 });
    expect(processor.inFlightPassCount()).toBe(0);
    // Rollback is complete: a gate-off pod ignores stamps a gate-on pod left.
    expect(processor._test.reclaimableClaimSql(10)).not.toContain('shutdown_interrupted_at');
  });
});

maybeDescribe('deploy-interrupted call passes with the gate on (live Postgres)', () => {
  let db;
  let processor;
  let fetchSpy;

  const readRow = (s) => db('call_log').where({ twilio_call_sid: s }).first();
  const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
  const insertCall = async (s, overrides = {}) => {
    const [row] = await db('call_log').insert({
      twilio_call_sid: s,
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
      ...overrides,
    }).returning('id');
    return row.id;
  };

  beforeAll(async () => {
    process.env.GATE_CALL_PROC_SHUTDOWN_RELEASE = 'true';
    jest.resetModules();
    db = require('../models/db');
    processor = require('../services/call-recording-processor');
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('not found', { status: 404 }));
    await db('call_log').whereIn('twilio_call_sid', ALL_SIDS).del();
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    delete process.env.GATE_CALL_PROC_SHUTDOWN_RELEASE;
    await db('call_log').whereIn('twilio_call_sid', ALL_SIDS).del();
    await db.destroy();
  });

  test('SIGTERM stamps a pass in flight and leaves its claim with it; the pass still owns its own release', async () => {
    await insertCall(SID);
    let releaseDownload;
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => {
      releaseDownload = () => resolve(new Response('not found', { status: 404 }));
    }));
    const pass = processor.processRecording(SID);
    await new Promise((r) => setTimeout(r, 400));
    expect(processor.inFlightPassCount()).toBe(1);
    const claimed = await readRow(SID);
    expect(claimed.processing_status).toBe('processing');

    const summary = await processor.markInFlightForShutdown({ deadlineMs: 5000 });
    expect(summary).toEqual({ enabled: true, inFlight: 1, stamped: 1, failed: 0 });

    // Stamp only: claim, token and status untouched, so nothing can overlap
    // the pass while it is alive.
    const stamped = await readRow(SID);
    expect(stamped.processing_status).toBe('processing');
    expect(stamped.processing_token).toBe(claimed.processing_token);
    expect(stamped.metadata.shutdown_interrupted_at).toEqual(expect.any(String));
    // The stamp refreshed the beat: the 2-minute silence starts at SIGTERM.
    expect(new Date(stamped.processing_heartbeat_at).getTime()).toBeGreaterThanOrEqual(new Date(claimed.processing_heartbeat_at).getTime());
    expect(processor._test.reclaimableClaimSql(10)).toContain('shutdown_interrupted_at');

    // The pass finishes on its own: its release lands as before.
    releaseDownload();
    expect((await pass).reason).toBe('recording_not_ready');
    const after = await readRow(SID);
    expect(after.processing_status).toBeNull();
    expect(after.processing_token).toBeNull();
    expect(processor.inFlightPassCount()).toBe(0);
  });

  test('the replacing pod reclaims a stamped dead claim after 2 quiet minutes, never a stamped claim that still beats, and an unstamped dead claim waits its 10', async () => {
    processor._test.resetShutdownForTests();
    const stamp = { fixture: 'shutdown-release', shutdown_interrupted_at: minutesAgo(3).toISOString() };
    const claimedRow = (heartbeatMinutesAgo, metadata) => ({
      processing_status: 'processing',
      processing_token: 'deadbeef'.repeat(4),
      processing_generation: 3,
      processing_started_at: minutesAgo(heartbeatMinutesAgo + 1),
      processing_heartbeat_at: minutesAgo(heartbeatMinutesAgo),
      updated_at: minutesAgo(heartbeatMinutesAgo + 1),
      metadata: JSON.stringify(metadata),
    });
    await insertCall(SID_DEAD, claimedRow(3, stamp));
    await insertCall(SID_BEATING, claimedRow(1, stamp));
    await insertCall(SID_UNSTAMPED, claimedRow(3, { fixture: 'shutdown-release' }));
    fetchSpy.mockClear();

    await processor.processAllPending();

    // Exactly one download: the dead, stamped claim was taken.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const dead = await readRow(SID_DEAD);
    expect(Number(dead.processing_generation)).toBe(4);
    expect(dead.processing_token).toBeNull();
    // Takeover of a dead pass maps the pre-claim 'processing' to NULL on the
    // not-ready release, and the claim consumed the stamp.
    expect(dead.processing_status).toBeNull();
    expect(dead.metadata.shutdown_interrupted_at).toBeUndefined();
    expect(dead.metadata.fixture).toBe('shutdown-release');

    for (const s of [SID_BEATING, SID_UNSTAMPED]) {
      const row = await readRow(s);
      expect(row.processing_status).toBe('processing');
      expect(row.processing_token).toBe('deadbeef'.repeat(4));
      expect(Number(row.processing_generation)).toBe(3);
    }
    expect((await readRow(SID_BEATING)).metadata.shutdown_interrupted_at).toEqual(expect.any(String));

    // A refused claim (blocked behind the beating one) registers itself
    // before its transaction and leaves the registry when refused, so a
    // SIGTERM in that window stamps nothing it does not own.
    expect((await processor.processRecording(SID_BEATING)).reason).toBe('already_processing');
    expect(processor.inFlightPassCount()).toBe(0);
  });

  test('a losing contender for a row in flight does not evict the owner from the registry', async () => {
    processor._test.resetShutdownForTests();
    await db('call_log').where({ twilio_call_sid: SID }).del();
    await insertCall(SID);
    let releaseDownload;
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => {
      releaseDownload = () => resolve(new Response('not found', { status: 404 }));
    }));
    const owner = processor.processRecording(SID);
    await new Promise((r) => setTimeout(r, 400));
    expect(processor.inFlightPassCount()).toBe(1);
    // The ring-first flow's duplicate webhook: a second pass for the same
    // row loses the claim and leaves; the owner must still be stampable.
    expect((await processor.processRecording(SID)).reason).toBe('already_processing');
    expect(processor.inFlightPassCount()).toBe(1);
    expect(await processor.markInFlightForShutdown({ deadlineMs: 5000 })).toEqual({ enabled: true, inFlight: 1, stamped: 1, failed: 0 });
    releaseDownload();
    expect((await owner).reason).toBe('recording_not_ready');
    expect(processor.inFlightPassCount()).toBe(0);
  });

  test('a claim taken while the process is already draining stamps itself', async () => {
    processor._test.resetShutdownForTests();
    await insertCall(SID_LATE);
    // Nothing in flight: the mark only sets the drain flag.
    expect(await processor.markInFlightForShutdown({ deadlineMs: 0 })).toEqual({ enabled: true, inFlight: 0, stamped: 0, failed: 0 });
    fetchSpy.mockClear();
    expect((await processor.processRecording(SID_LATE)).reason).toBe('recording_not_ready');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const row = await readRow(SID_LATE);
    expect(row.metadata.shutdown_interrupted_at).toEqual(expect.any(String));
    expect(Number(row.processing_generation)).toBe(1);
    // The stamp speaks only for a claimed row: back to NULL it changes nothing
    // (the fresh-row age gate still holds), and the next claim clears it.
    processor._test.resetShutdownForTests();
    await processor.processAllPending();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('SIGTERM while a claim write is blocked on the row lock: the marker waits for it and stamps the committed claim', async () => {
    processor._test.resetShutdownForTests();
    await db('call_log').where({ twilio_call_sid: SID }).del();
    await insertCall(SID);
    // Hold the row lock from a second connection: the pass's claim UPDATE
    // blocks on it with its drain read already taken as false.
    const holder = await db.transaction();
    await holder('call_log').where({ twilio_call_sid: SID }).forUpdate().first('id');
    let releaseDownload;
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => {
      releaseDownload = () => resolve(new Response('not found', { status: 404 }));
    }));
    const pass = processor.processRecording(SID);
    await new Promise((r) => setTimeout(r, 400));
    expect(processor._test.pendingClaimWriteCount()).toBe(1);
    expect((await readRow(SID)).processing_status).toBeNull();

    // SIGTERM lands now; the lock lets go 300 ms later, inside the budget.
    setTimeout(() => { holder.commit().catch(() => {}); }, 300);
    const summary = await processor.markInFlightForShutdown({ deadlineMs: 5000 });
    expect(summary).toEqual({ enabled: true, inFlight: 1, stamped: 1, failed: 0 });
    const stamped = await readRow(SID);
    expect(stamped.processing_status).toBe('processing');
    expect(stamped.metadata.shutdown_interrupted_at).toEqual(expect.any(String));

    releaseDownload();
    expect((await pass).reason).toBe('recording_not_ready');
    expect(processor.inFlightPassCount()).toBe(0);
    expect(processor._test.pendingClaimWriteCount()).toBe(0);
  });

  test('a stamped dead claim on a PAN-quarantined row re-enters the backstop before its 10-minute outer age', async () => {
    processor._test.resetShutdownForTests();
    const quarantined = (metadata) => ({
      recording_url: null,
      recording_sid: null,
      transcription: 'masked fixture transcript',
      transcription_status: 'completed',
      transcription_metadata: JSON.stringify({ pan_detected: 'true' }),
      processing_status: 'processing',
      processing_token: 'deadbeef'.repeat(4),
      processing_generation: 3,
      processing_started_at: minutesAgo(4),
      processing_heartbeat_at: minutesAgo(3),
      // The claim refreshed updated_at: the outer 10-minute gate alone
      // would hold both rows until minute ten.
      updated_at: minutesAgo(1),
      metadata: JSON.stringify(metadata),
    });
    await insertCall(SID_QUAR_STAMPED, quarantined({ fixture: 'shutdown-release', shutdown_interrupted_at: minutesAgo(3).toISOString() }));
    await insertCall(SID_QUAR_UNSTAMPED, quarantined({ fixture: 'shutdown-release' }));

    const sids = (await processor.pendingCandidatesQuery().select('twilio_call_sid')).map((r) => r.twilio_call_sid);
    expect(sids).toContain(SID_QUAR_STAMPED);
    expect(sids).not.toContain(SID_QUAR_UNSTAMPED);
    // Candidate rows only: never run extraction on a fixture transcript.
    await db('call_log').whereIn('twilio_call_sid', [SID_QUAR_STAMPED, SID_QUAR_UNSTAMPED]).del();
  });
});
