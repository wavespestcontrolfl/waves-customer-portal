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

function createdAfterTheCall(row) {
  return POST_CALL_ROW_SOURCES.has(parseMetadata(row?.metadata).source);
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
 * When the call ENDED. Start + duration — EXCEPT a bridged inbound call
 * (codex #4919 round-3 P1): created_at is ring time, but Twilio's
 * `bridged_at` is when the conversation actually began, and duration_seconds
 * measures FROM the bridge, not from ring. Adding duration to
 * callStartedAt()'s ring-time start would UNDERSTATE the true end by the
 * whole ring delay on a call that rang a while before pickup. This mirrors
 * call-commitments.js's own callEndedAt for the bridged case exactly (same
 * two duplicated definitions this module doesn't yet fully unify with —
 * that one's non-bridged branches key on call DIRECTION rather than this
 * module's metadata.source signal, a wider reconciliation left for its own
 * change). callStartedAt() itself stays ring-time-anchored regardless —
 * the SLA "how long did the caller wait" clock this module's docblock
 * describes needs ring time, not the bridge.
 */
function callEndedAt(row) {
  if (row?.bridged_at) {
    const bridged = new Date(row.bridged_at);
    if (!Number.isNaN(bridged.getTime())) return new Date(bridged.getTime() + callDurationSeconds(row) * 1000);
  }
  const started = callStartedAt(row);
  if (!started) return null;
  return new Date(started.getTime() + callDurationSeconds(row) * 1000);
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
  const callEnded = callEndedAt(row);
  if (!callEnded) return null;
  const status = row?.processing_status == null ? null : String(row.processing_status);
  const touched = (status === null || status === 'pending') && row?.updated_at
    ? new Date(row.updated_at).getTime() : NaN;
  return new Date(Number.isNaN(touched) ? callEnded.getTime() : Math.max(callEnded.getTime(), touched));
}

module.exports = {
  POST_CALL_ROW_SOURCES,
  callStartedAt,
  callEndedAt,
  recordingReadyAt,
  callDurationSeconds,
};
