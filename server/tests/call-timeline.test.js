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

describe('callEndedAt — start + duration always, including a bridged (outbound-connect) row (codex #4919 round-4 P1)', () => {
  test('a normal row: created_at + duration', () => {
    const row = { created_at: '2026-09-26T18:00:00Z', duration_seconds: 300 };
    expect(callEndedAt(row).toISOString()).toBe('2026-09-26T18:05:00.000Z');
  });

  test('a post-call fallback row: created_at IS already the end (back out then add back nets to created_at, never double-subtracted)', () => {
    const row = { created_at: '2026-09-26T18:30:00Z', duration_seconds: 3600, metadata: { source: 'status_callback' } };
    expect(callEndedAt(row).toISOString()).toBe('2026-09-26T18:30:00.000Z');
  });

  // codex #4919 round-4 P1 (correcting a round-3 attempt): the ONLY writer
  // of bridged_at is /outbound-connect — staff pressing 1 on an OUTBOUND
  // admin-connect call, with a long wait BEFORE the customer is even
  // dialed. /call-status's duration_seconds for that row is the parent
  // leg's Twilio CallDuration, measured from created_at (when the admin's
  // leg answered) — it already SPANS the pre-bridge wait, so created_at +
  // duration is the correct end. Adding duration to bridged_at instead
  // would double-count that wait and push the end PAST the true one.
  test('an outbound-connect-shaped row (bridged_at set, long pre-bridge wait): created_at + duration, bridged_at is NOT added', () => {
    const row = {
      created_at: '2026-09-26T21:00:00Z', // admin's leg answered at 21:00
      bridged_at: '2026-09-26T21:08:00Z', // staff pressed 1 eight minutes later
      duration_seconds: 300, // parent CallDuration: the WHOLE call from 21:00, 5 min total
      direction: 'outbound-api',
    };
    // bridged_at + duration would wrongly give 21:13 — 8 minutes late.
    expect(callEndedAt(row).toISOString()).toBe('2026-09-26T21:05:00.000Z');
  });

  test('null on an unusable created_at', () => {
    expect(callEndedAt({})).toBeNull();
  });
});

describe('recordingReadyAt — call end, or later if the recording landed later', () => {
  test('an outbound-connect-shaped row: readiness anchors off created_at + duration, not bridged_at + duration', () => {
    const row = {
      created_at: '2026-09-26T21:00:00Z',
      bridged_at: '2026-09-26T21:08:00Z',
      duration_seconds: 300,
      processing_status: null,
    };
    expect(recordingReadyAt(row).toISOString()).toBe('2026-09-26T21:05:00.000Z');
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
