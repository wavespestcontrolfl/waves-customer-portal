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
 *
 * codex #4919 finding D: those same three fallback paths ALSO stamp the
 * PROVIDER's own instant when they have one — a fetched Twilio Call
 * resource's startTime/endTime, or the webhook body's Timestamp/
 * RecordingStartTime — as metadata.provider_started_at / provider_ended_at
 * (twilio-voice-webhook.js). When either is present and parses, it is
 * authoritative over the duration-backed-out estimate below; the other end
 * is derived from duration_seconds when only one provider time landed.
 * Missing/invalid on a row (an older row, or a fetch that failed with no
 * RecordingStartTime either) falls back to this file's original logic,
 * unchanged.
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

function parseProviderInstant(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// The row's PROVIDER-supplied start/end, if metadata carries either (codex
// #4919 finding D). Both valid: used as-is. Exactly one valid: the other is
// DERIVED from duration_seconds (0 means "not yet known" — see
// callDurationSeconds — so the derived value then just equals the known
// one, same convention as everywhere else in this file). Neither
// present/parseable: both null, and callers fall back to the original
// duration-backed-out logic unchanged.
function providerTimes(row) {
  const meta = parseMetadata(row?.metadata);
  const started = parseProviderInstant(meta.provider_started_at);
  const ended = parseProviderInstant(meta.provider_ended_at);
  if (started && ended) return { started, ended };
  const durationMs = callDurationSeconds(row) * 1000;
  if (started) return { started, ended: new Date(started.getTime() + durationMs) };
  if (ended) return { started: new Date(ended.getTime() - durationMs), ended };
  return { started: null, ended: null };
}

/** When the CUSTOMER placed the call. Null if the row carries no usable time. */
function callStartedAt(row) {
  const provided = providerTimes(row).started;
  if (provided) return provided;
  const created = row?.created_at ? new Date(row.created_at) : null;
  if (!created || Number.isNaN(created.getTime())) return null;
  if (!createdAfterTheCall(row)) return created;
  // Post-call row: back out the call's own length to reach its start.
  return new Date(created.getTime() - callDurationSeconds(row) * 1000);
}

/**
 * When the call ENDED (start + duration). Null if the start is unknown.
 *
 * codex #4919 round-4 P1 (correcting a round-3 attempt to add `bridged_at`
 * handling here): the ONLY writer of `call_log.bridged_at` in this codebase
 * is /outbound-connect (twilio-voice-webhook.js) — staff pressing 1 on an
 * OUTBOUND admin-connect call, before the customer is even dialed. That
 * row's duration_seconds comes from /call-status's parent-leg CallDuration,
 * which Twilio measures from created_at (when the admin's leg answered),
 * NOT from the bridge — it already SPANS the pre-bridge wait (the prompt,
 * the button press) through the customer conversation. `created_at +
 * duration` is already the correct end; adding duration to `bridged_at`
 * instead would double-count that pre-bridge wait and push the computed end
 * PAST the true one — the opposite of the understatement bug this file
 * exists to fix, and one that could reject a genuinely bookable start as
 * "already past". There is no genuinely bridge-relative duration this
 * codebase writes today, so `bridged_at` needs no special case here.
 *
 * codex #4919 finding D: a provider-supplied end (metadata.provider_ended_at,
 * or one derived from provider_started_at + duration — see providerTimes)
 * takes precedence over this start-plus-duration estimate when present.
 */
function callEndedAt(row) {
  const provided = providerTimes(row).ended;
  if (provided) return provided;
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
