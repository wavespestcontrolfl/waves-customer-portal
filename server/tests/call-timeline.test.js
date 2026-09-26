const { callStartedAt, recordingReadyAt, callDurationSeconds } = require('../utils/call-timeline');

describe('callStartedAt — created_at means different things on different rows', () => {
  test('a normal /voice-inserted row: created_at IS the start', () => {
    const row = { created_at: '2026-09-26T18:00:00Z' };
    expect(callStartedAt(row).toISOString()).toBe('2026-09-26T18:00:00.000Z');
  });

  test('a post-call fallback row (status_callback): created_at is the END — back out the duration', () => {
    const row = { created_at: '2026-09-26T18:10:00Z', duration_seconds: 600, metadata: { source: 'status_callback' } };
    expect(callStartedAt(row).toISOString()).toBe('2026-09-26T18:00:00.000Z');
  });

  // codex #4919 round-3 P1: a call that started 11:50 PM ET and whose
  // status_callback row lands after ET midnight resolves to the PRIOR
  // calendar day's wall clock, not the row's own created_at date — the
  // exact case that made a caller's "tonight"/"tomorrow" resolve one day
  // late when call-recording-processor.js read call.created_at directly
  // instead of this function.
  test('a post-midnight status_callback row for a call that started before midnight resolves the PRIOR day', () => {
    // 2026-09-27T04:05:00Z = 2026-09-27 00:05 ET (EDT, UTC-4) — created AFTER
    // midnight, 15 minutes into the call's own 15-minute duration.
    const row = { created_at: '2026-09-27T04:05:00Z', duration_seconds: 900, metadata: { source: 'status_callback' } };
    const started = callStartedAt(row);
    // 2026-09-26T23:50:00Z would be a mistaken same-instant-shifted read;
    // the correct start is 2026-09-26 23:50 ET = 2026-09-27T03:50:00Z.
    expect(started.toISOString()).toBe('2026-09-27T03:50:00.000Z');
  });

  // codex #4919 round-14 P1: a /call-status fallback row created by a
  // NON-terminal event was inserted near the call's start.
  test('a status_callback row inserted on a non-terminal event keeps created_at as the start', () => {
    for (const status of ['initiated', 'ringing', 'in-progress']) {
      const row = { created_at: '2026-09-27T04:02:00Z', duration_seconds: 600, metadata: { source: 'status_callback', inserted_on_status: status } };
      expect(callStartedAt(row).toISOString()).toBe('2026-09-27T04:02:00.000Z');
    }
  });

  test('a status_callback row inserted on a terminal event (or with no stamp) is still post-call', () => {
    for (const meta of [{ source: 'status_callback', inserted_on_status: 'completed' }, { source: 'status_callback', inserted_on_status: 'no-answer' }, { source: 'status_callback' }]) {
      const row = { created_at: '2026-09-27T04:02:00Z', duration_seconds: 600, metadata: meta };
      expect(callStartedAt(row).toISOString()).toBe('2026-09-27T03:52:00.000Z');
    }
  });

  test('every documented POST_CALL_ROW_SOURCES value is treated as post-call', () => {
    for (const source of ['status_callback', 'twilio_recording_status_recovered', 'twilio_studio_recording_status']) {
      const row = { created_at: '2026-09-26T18:10:00Z', duration_seconds: 600, metadata: { source } };
      expect(callStartedAt(row).toISOString()).toBe('2026-09-26T18:00:00.000Z');
    }
  });

  test('an unrecognized/absent metadata.source is read as a normal (start-time) row', () => {
    const row = { created_at: '2026-09-26T18:10:00Z', duration_seconds: 600, metadata: null };
    expect(callStartedAt(row).toISOString()).toBe('2026-09-26T18:10:00.000Z');
  });

  test('null on an unusable created_at', () => {
    expect(callStartedAt({})).toBeNull();
    expect(callStartedAt({ created_at: 'not-a-date' })).toBeNull();
  });
});

describe('callDurationSeconds — largest positive of duration_seconds / recording_duration_seconds', () => {
  test('a stored 0 duration_seconds (post-call fallback, Twilio CallDuration unavailable) yields to recording_duration_seconds', () => {
    expect(callDurationSeconds({ duration_seconds: 0, recording_duration_seconds: 300 })).toBe(300);
  });
  test('no usable duration on either column is 0, not NaN', () => {
    expect(callDurationSeconds({})).toBe(0);
  });
});

describe('recordingReadyAt — call end, or later if the recording landed later', () => {
  test('updated_at is folded in only while pending, and only if later than the call end', () => {
    const pending = {
      created_at: '2026-09-26T18:00:00Z', duration_seconds: 300, processing_status: 'pending', updated_at: '2026-09-26T18:20:00Z',
    };
    expect(recordingReadyAt(pending).toISOString()).toBe('2026-09-26T18:20:00.000Z');
    const claimed = {
      created_at: '2026-09-26T18:00:00Z', duration_seconds: 300, processing_status: 'processing', updated_at: '2026-09-26T18:20:00Z',
    };
    expect(recordingReadyAt(claimed).toISOString()).toBe('2026-09-26T18:05:00.000Z');
  });
});
