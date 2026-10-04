/**
 * Where a call_log row sits on the clock.
 *
 * `created_at` does NOT mean the same thing on every row. The /voice webhook
 * inserts when the call BEGINS, so created_at is the call's start. Three
 * fallback paths insert AFTER the call has ended — the status callback when
 * a Studio Flow bypassed /voice, and the two recording-status recovery
 * inserts — so on those rows created_at is already a post-call timestamp.
 *
 * Reading created_at as call-start on all of them costs money twice: the SLA
 * clock understates how long a caller actually waited (by the call's whole
 * length), and the stall watchdog pushes its readiness deadline into the
 * future by that same length, delaying the alert on a stuck call.
 *
 * The rows say which they are: the insert stamps metadata.source.
 */

// metadata.source values written by the three POST-CALL insert paths
// (twilio-voice-webhook.js /recording-status and /call-status).
const POST_CALL_ROW_SOURCES = new Set([
  'status_callback',
  'twilio_recording_status_recovered',
  'twilio_studio_recording_status',
]);

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// How much wall clock the call consumed — a different question from the
// processor's ELIGIBILITY duration, where COALESCE makes a stored 0
// authoritative. Here 0 means "this column doesn't know yet": a post-call
// fallback row inserts duration_seconds: 0 when Twilio's CallDuration was
// unavailable and picks up recording_duration_seconds later, and taking the
// 0 would place the call's start at its completion. Largest positive wins.
function callDurationSeconds(row) {
  const candidates = [row?.duration_seconds, row?.recording_duration_seconds]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

// Twilio's terminal call statuses (matches twilio-voice-webhook.js).
const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

function createdAfterTheCall(row) {
  const meta = parseMetadata(row?.metadata);
  if (!POST_CALL_ROW_SOURCES.has(meta.source)) return false;
  // A /call-status fallback row inserted on a NON-terminal event
  // (initiated/ringing/in-progress) was created near the call's start, so
  // created_at is the start (codex #4919 round-14 P1). Rows without the
  // stamp (older inserts) keep the post-call reading.
  if (meta.source === 'status_callback' && meta.inserted_on_status
    && !TERMINAL_CALL_STATUSES.has(String(meta.inserted_on_status))) return false;
  return true;
}

/** When the CUSTOMER placed the call. Null if the row carries no usable time. */
function callStartedAt(row) {
  const created = row?.created_at ? new Date(row.created_at) : null;
  if (!created || Number.isNaN(created.getTime())) return null;
  if (!createdAfterTheCall(row)) return created;
  // Post-call row: back out the call's own length to reach its start.
  return new Date(created.getTime() - callDurationSeconds(row) * 1000);
}

/**
 * When the recording could FIRST have been processable — where the
 * pipeline's clock starts. Call end, or later if the recording only landed
 * later: recoverMissingRecentRecordings can attach an OLD call's recording
 * today, and processAllPending then waits 10 minutes from that write.
 * `updated_at` is folded in only for NULL/pending rows; on a claimed row it
 * is bumped by the claim itself.
 */
function recordingReadyAt(row) {
  const started = callStartedAt(row);
  if (!started) return null;
  const callEnded = started.getTime() + callDurationSeconds(row) * 1000;
  const status = row?.processing_status == null ? null : String(row.processing_status);
  const touched = (status === null || status === 'pending') && row?.updated_at
    ? new Date(row.updated_at).getTime() : NaN;
  return new Date(Number.isNaN(touched) ? callEnded : Math.max(callEnded, touched));
}

module.exports = {
  POST_CALL_ROW_SOURCES,
  TERMINAL_CALL_STATUSES,
  callStartedAt,
  recordingReadyAt,
  callDurationSeconds,
};
