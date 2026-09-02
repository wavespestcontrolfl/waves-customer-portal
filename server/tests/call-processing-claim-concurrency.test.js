// Two processing attempts against ONE recording, on a real Postgres.
//
// The claim is a conditional UPDATE whose predicates are raw SQL
// (reclaimableClaim / CURRENT_BEAT); a mocked builder cannot evaluate them,
// so this suite drives the REAL processRecording twice concurrently against
// a real call_log row. The recording download is stubbed to Twilio's
// "still propagating" 404, so the pass runs the whole claim → download →
// release path without any provider key, and every assertion is about the
// row: exactly one attempt holds the claim, the loser is refused, the
// winner releases the row untouched, and a worker holding a superseded
// token cannot write.
//
// Runs only with DATABASE_URL (repo convention — CI's DB-gated step sets it
// against the migrated database; the main jest step does not). Fixtures are
// fictitious: 555-01xx numbers, fake SIDs, no transcript text.
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const SID = 'CA' + '7'.repeat(30) + 'c1';
const SID_STALE = 'CA' + '7'.repeat(30) + 'c2';
const SID_QUIET = 'CA' + '7'.repeat(30) + 'c3';
const REC = 'RE' + '7'.repeat(32);
const RECORDING_URL = `https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/${REC}.mp3`;

maybeDescribe('processRecording claim concurrency (live Postgres)', () => {
  let db;
  let processor;
  let fetchSpy;
  const rowIds = [];

  async function insertCall(sid, overrides = {}) {
    const [row] = await db('call_log').insert({
      twilio_call_sid: sid,
      direction: 'inbound',
      from_phone: '+15555550123',
      to_phone: '+15555550100',
      status: 'completed',
      duration_seconds: 60,
      recording_sid: REC,
      recording_url: RECORDING_URL,
      recording_duration_seconds: 60,
      transcription_status: 'pending',
      processing_status: null,
      metadata: JSON.stringify({ source: 'voice_webhook', fixture: 'claim-concurrency' }),
      ...overrides,
    }).returning('id');
    rowIds.push(row.id);
    return row.id;
  }

  const readRow = (sid) => db('call_log').where({ twilio_call_sid: sid }).first();

  beforeAll(async () => {
    db = require('../models/db');
    processor = require('../services/call-recording-processor');
    // Twilio CDN not propagated yet: every download 404s, which the
    // processor maps to a "recording not ready" release (no status stamp,
    // no attempt counter). No provider is ever reached.
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('not found', { status: 404 }));
    await db('call_log').whereIn('twilio_call_sid', [SID, SID_STALE, SID_QUIET]).del();
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    if (rowIds.length) await db('call_log').whereIn('id', rowIds).del();
    await db.destroy();
  });

  test('two concurrent attempts: exactly one claims, the other is refused, the row is released untouched', async () => {
    await insertCall(SID);
    // Hold the (stubbed) download open so the two passes genuinely overlap:
    // an instant 404 let the first pass claim AND release before the second
    // pass reached its claim, which then legitimately claimed in sequence —
    // that is not the race this test exists to prove.
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response('not found', { status: 404 })), 600);
    }));
    const [a, b] = await Promise.all([
      processor.processRecording(SID),
      new Promise((resolve) => setTimeout(resolve, 150)).then(() => processor.processRecording(SID)),
    ]);
    const reasons = [a.reason, b.reason].sort();
    expect(reasons).toEqual(['already_processing', 'recording_not_ready']);
    expect(a.success).toBe(false);
    expect(b.success).toBe(false);

    const row = await readRow(SID);
    // The winner released the claim with the pre-claim status restored: no
    // terminal stamp, no attempt burned, token cleared, one generation used.
    expect(row.processing_status).toBeNull();
    expect(row.processing_token).toBeNull();
    expect(Number(row.processing_generation)).toBe(1);
    expect(Number(row.extraction_attempts || 0)).toBe(0);
    expect(row.transcription).toBeNull();
    expect(row.recording_url).toBe(RECORDING_URL);
    // The download was attempted exactly once — the refused attempt never
    // reached the provider leg.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a claim whose heartbeat stopped is reclaimed; the superseded worker\'s fenced write matches no rows', async () => {
    fetchSpy.mockClear();
    const staleToken = 'deadbeef'.repeat(4);
    const twelveMinutesAgo = new Date(Date.now() - 12 * 60 * 1000);
    await insertCall(SID_STALE, {
      processing_status: 'processing',
      processing_token: staleToken,
      processing_generation: 3,
      processing_started_at: twelveMinutesAgo,
      processing_heartbeat_at: twelveMinutesAgo,
    });

    const result = await processor.processRecording(SID_STALE);
    expect(result.reason).toBe('recording_not_ready');

    const row = await readRow(SID_STALE);
    expect(Number(row.processing_generation)).toBe(4);
    expect(row.processing_token).toBeNull();
    // A phantom in-flight marker is not restored: the pre-claim status was
    // 'processing' (a dead pass), which maps to NULL so the row re-enters
    // the sweep instead of blocking for another stale window.
    expect(row.processing_status).toBeNull();

    // The dead worker wakes up and tries to finalize with its old token.
    const staleWrite = await db('call_log')
      .where({ id: row.id })
      .where('processing_token', staleToken)
      .update({ processing_status: 'processed', transcription: 'stale text' });
    expect(staleWrite).toBe(0);
    const after = await readRow(SID_STALE);
    expect(after.processing_status).toBeNull();
    expect(after.transcription).toBeNull();
  });

  test('a claim that is still beating is honoured by an automatic pass and taken over only by an operator after the short quiet window', async () => {
    fetchSpy.mockClear();
    const liveToken = 'feedface'.repeat(4);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    await insertCall(SID_QUIET, {
      processing_status: 'processing',
      processing_token: liveToken,
      processing_generation: 1,
      processing_started_at: new Date(Date.now() - 6 * 60 * 1000),
      // Last beat five minutes ago: inside the 10-minute automatic window,
      // outside the 3-minute operator window.
      processing_heartbeat_at: fiveMinutesAgo,
    });

    const automatic = await processor.processRecording(SID_QUIET);
    expect(automatic).toEqual({
      success: false, skipped: true, reason: 'already_processing', retryAfterMinutes: 10,
    });
    expect((await readRow(SID_QUIET)).processing_token).toBe(liveToken);
    expect(fetchSpy).not.toHaveBeenCalled();

    const operator = await processor.processRecording(SID_QUIET, { operator: true });
    expect(operator.reason).toBe('recording_not_ready');
    const row = await readRow(SID_QUIET);
    expect(row.processing_token).toBeNull();
    expect(Number(row.processing_generation)).toBe(2);
  });
});
