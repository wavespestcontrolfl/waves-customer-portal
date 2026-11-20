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
// deploy wipes. It takes a recording over 10 seconds; with
// GATE_SHORT_CALL_RECORDING_SWEEP on it also takes a shorter one (over 0 s)
// while the call is under 24 hours old, so a short call that ended during a
// deploy (often a cancel) still gets its transcript. Every reader that mirrors
// the sweep's eligibility (getStats, the stall watchdog, the ops queue, the
// agent-control run list) uses this rule, so none of them can disagree with
// the sweep. Callers keep their own PAN-quarantine exemption, as before.
const SWEEP_MIN_SECONDS = 10; // the sweep takes a recording OVER this many seconds
const SHORT_RECORDING_SWEEP_HOURS = 24;
const RECORDING_SECONDS_SQL = 'COALESCE(recording_duration_seconds, duration_seconds, 0)';

// Optional chaining: a test's whole-module feature-gates mock reads as off.
const shortRecordingSweepLive = () => require('./feature-gates').shortCallRecordingSweepLive?.() === true;

// SQL over unqualified call_log columns. Gate off = the old floor, byte for byte.
function sweepLengthSql() {
  const floor = `${RECORDING_SECONDS_SQL} > ${SWEEP_MIN_SECONDS}`;
  if (!shortRecordingSweepLive()) return floor;
  return `(${floor} OR (${RECORDING_SECONDS_SQL} > 0 AND created_at > NOW() - INTERVAL '${SHORT_RECORDING_SWEEP_HOURS} hours'))`;
}

// The same rule with no age limit: over 10 s, or, gate on, any recording over
// 0 s. Only for a reader that REPORTS a failure the sweep already had its
// chance at, so a short call's failure stays in a 7-day report after its
// 24-hour sweep window closes. Never for "will the sweep retry it" (that is
// sweepLengthSql). Gate off = the old floor, byte for byte.
function sweepLengthAnyAgeSql() {
  return `${RECORDING_SECONDS_SQL} > ${shortRecordingSweepLive() ? 0 : SWEEP_MIN_SECONDS}`;
}

// The same rule for one call_log row. COALESCE semantics: a recorded 0 is
// authoritative and never borrows the longer call duration.
function sweepLengthOk(row, now = Date.now()) {
  const seconds = Number(row?.recording_duration_seconds ?? row?.duration_seconds ?? 0) || 0;
  if (seconds > SWEEP_MIN_SECONDS) return true;
  if (seconds <= 0 || !shortRecordingSweepLive()) return false;
  const created = new Date(row?.created_at).getTime();
  return Number.isFinite(created) && created > new Date(now).getTime() - SHORT_RECORDING_SWEEP_HOURS * 3600 * 1000;
}

module.exports = {
  CALL_EXTRACTION_MAX_ATTEMPTS,
  EXTRACTION_RETRY_WINDOW_DAYS,
  SWEEP_MIN_SECONDS,
  SHORT_RECORDING_SWEEP_HOURS,
  sweepLengthSql,
  sweepLengthAnyAgeSql,
  sweepLengthOk,
};
