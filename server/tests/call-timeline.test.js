const { callStartedAt, callEndedAt, recordingReadyAt, callDurationSeconds } = require('../utils/call-timeline');

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

describe('callEndedAt — start + duration, except a bridged call ends at bridge + duration (codex #4919 round-3 P1)', () => {
  test('a normal row: created_at + duration', () => {
    const row = { created_at: '2026-09-26T18:00:00Z', duration_seconds: 300 };
    expect(callEndedAt(row).toISOString()).toBe('2026-09-26T18:05:00.000Z');
  });

  test('a post-call fallback row: created_at IS already the end (back out then add back nets to created_at, never double-subtracted)', () => {
    const row = { created_at: '2026-09-26T18:30:00Z', duration_seconds: 3600, metadata: { source: 'status_callback' } };
    expect(callEndedAt(row).toISOString()).toBe('2026-09-26T18:30:00.000Z');
  });

  // The actual codex finding: created_at is RING time on an inbound bridged
  // call, and duration_seconds measures the CONVERSATION from the bridge —
  // a long ring must not be silently absorbed into the end time.
  test('a bridged inbound call with a long ring: bridge + duration, not created_at + duration', () => {
    const row = {
      created_at: '2026-09-26T21:00:00Z', // rang at 21:00
      bridged_at: '2026-09-26T21:05:00Z', // answered 5 minutes later
      duration_seconds: 300, // 5-minute conversation from the bridge
      direction: 'inbound',
    };
    // created_at + duration would wrongly give 21:05 — 5 minutes early.
    expect(callEndedAt(row).toISOString()).toBe('2026-09-26T21:10:00.000Z');
  });

  test('bridged_at takes precedence even with no explicit direction on the row', () => {
    const row = { created_at: '2026-09-26T21:00:00Z', bridged_at: '2026-09-26T21:05:00Z', duration_seconds: 300 };
    expect(callEndedAt(row).toISOString()).toBe('2026-09-26T21:10:00.000Z');
  });

  test('an unusable bridged_at falls back to the normal start+duration path', () => {
    const row = { created_at: '2026-09-26T21:00:00Z', bridged_at: 'not-a-date', duration_seconds: 300 };
    expect(callEndedAt(row).toISOString()).toBe('2026-09-26T21:05:00.000Z');
  });

  test('null on an unusable created_at', () => {
    expect(callEndedAt({})).toBeNull();
  });
});

describe('recordingReadyAt — call end, or later if the recording landed later (unaffected by, but reuses, the bridged fix)', () => {
  test('a bridged call: readiness anchors off the bridge-based end, not created_at + duration', () => {
    const row = {
      created_at: '2026-09-26T21:00:00Z',
      bridged_at: '2026-09-26T21:05:00Z',
      duration_seconds: 300,
      processing_status: null,
    };
    expect(recordingReadyAt(row).toISOString()).toBe('2026-09-26T21:10:00.000Z');
  });

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
