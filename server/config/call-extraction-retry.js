// The extraction retry predicate, in one place: the processor's sweep retries
// an extraction_failed row only under this many attempts and only while the
// call is younger than this window; anything that DESCRIBES the retry state
// (the call intelligence panel's processing phase) reads the same values,
// so it can never promise a retry the sweep will not make or call retries
// exhausted while one is scheduled (Codex #3738 P2).
const CALL_EXTRACTION_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.CALL_EXTRACTION_MAX_ATTEMPTS || '3', 10) || 3);
const EXTRACTION_RETRY_WINDOW_DAYS = 7;

// The sweep's recording-length rule, in one place (owner 2026-11-19, "FIX").
// processAllPending is the restart-safe backstop for the in-memory timers a
// deploy wipes. It takes a recording over 10 seconds. With
// GATE_SHORT_CALL_RECORDING_SWEEP on, it also takes a shorter one (over 0 s)
// for a FIRST pass (processing_status NULL or pending, or a processing claim
// the sweep finds stale) while the call is under 24 hours old, so a short
// call that ended during a deploy (often a cancel) still gets its transcript.
// Every other state keeps the 10-second floor, gate on or off: a short call
// that ended in no_transcription or extraction_failed is not retried, and a
// finished one is not run again. So the gate adds no retries, and a reader
// that judges a retry by the attempt cap alone (callback reconciliation, the
// estimate guard) meets no new state.
// Every reader that mirrors the sweep's eligibility (getStats, the stall
// watchdog, the ops queue, the agent-control run list) uses this rule, so
// none of them can disagree with the sweep. Callers keep their own
// PAN-quarantine exemption, as before.
const SWEEP_MIN_SECONDS = 10; // the sweep takes a recording OVER this many seconds
const SHORT_RECORDING_SWEEP_HOURS = 24;
const RECORDING_SECONDS_SQL = 'COALESCE(recording_duration_seconds, duration_seconds, 0)';
// The states a first pass leaves (with NULL): queued, or claimed by a pass
// that may have died. The sweep's own branches decide which are due.
const FIRST_PASS_STATUSES = ['pending', 'processing'];
const FIRST_PASS_SQL = `(processing_status IS NULL OR processing_status IN (${FIRST_PASS_STATUSES.map((s) => `'${s}'`).join(', ')}))`;

// Optional chaining: a test's whole-module feature-gates mock reads as off.
const shortRecordingSweepLive = () => require('./feature-gates').shortCallRecordingSweepLive?.() === true;

// SQL over unqualified call_log columns. Gate off = the old floor, byte for byte.
function sweepLengthSql() {
  const floor = `${RECORDING_SECONDS_SQL} > ${SWEEP_MIN_SECONDS}`;
  if (!shortRecordingSweepLive()) return floor;
  return `(${floor} OR (${RECORDING_SECONDS_SQL} > 0 AND created_at > NOW() - INTERVAL '${SHORT_RECORDING_SWEEP_HOURS} hours' AND ${FIRST_PASS_SQL}))`;
}

// The length rule for REPORTING a failure the sweep will not retry: over
// 10 s, or, gate on, any recording over 0 s, so a short call that failed on
// the pass the gate gave it stays visible (the ops queue's failure scans).
// Never for "will the sweep take it" (that is sweepLengthSql). Gate off = the
// old floor, byte for byte.
function failureReportLengthSql() {
  return `${RECORDING_SECONDS_SQL} > ${shortRecordingSweepLive() ? 0 : SWEEP_MIN_SECONDS}`;
}

// The same rule for one call_log row: it reads processing_status (NULL or
// absent = a first pass). COALESCE semantics: a recorded 0 is authoritative
// and never borrows the longer call duration.
function sweepLengthOk(row, now = Date.now()) {
  const seconds = Number(row?.recording_duration_seconds ?? row?.duration_seconds ?? 0) || 0;
  if (seconds > SWEEP_MIN_SECONDS) return true;
  if (seconds <= 0 || !shortRecordingSweepLive()) return false;
  if (row?.processing_status != null && !FIRST_PASS_STATUSES.includes(row.processing_status)) return false;
  const created = new Date(row?.created_at).getTime();
  return Number.isFinite(created) && created > new Date(now).getTime() - SHORT_RECORDING_SWEEP_HOURS * 3600 * 1000;
}

module.exports = {
  CALL_EXTRACTION_MAX_ATTEMPTS,
  EXTRACTION_RETRY_WINDOW_DAYS,
  SWEEP_MIN_SECONDS,
  SHORT_RECORDING_SWEEP_HOURS,
  sweepLengthSql,
  failureReportLengthSql,
  sweepLengthOk,
};
