// Catch-up rerun for the weekly vendor price scan.
//
// 2026-10-26: a deploy sent SIGTERM two and a half minutes into the Monday scan.
// The scan used to record "success" with nothing scanned and nobody reran it, so
// the week had no draft. Now a scan that a deploy cuts short (or that mostly hit
// fetch failures) throws inside runExclusive, which writes job_health 'failed'.
// An hourly cron reads that row and reruns the scan. The row is the whole retry
// request: nothing is held in memory, so a pass that dies leaves it for the next.
//
// This module is the pure decision. The cron (scheduler.js) reads the row, calls
// decidePriceScanCatchUp, and on run:true calls the same body as the weekly cron
// under runExclusive('price-scan-weekly'). The lock already stops overlap.

const JOB_NAME = 'price-scan-weekly';

// A failed row is only worth rerunning for a day, so a stale failure found later
// never launches an 80-minute live scrape at an odd time.
const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
// A normal run takes about 80 minutes. A row still 'running' after this long is a
// run that was killed before it could record anything.
const STALLED_RUNNING_MS = 3 * 60 * 60 * 1000;
// Let a rolling deploy settle: a failed run ended a moment ago, the old instance
// may still be shutting down.
const MIN_GAP_AFTER_FINISH_MS = 10 * 60 * 1000;
// job_health.consecutive_failures counts the original failure and every failed
// rerun. At most this many failures still allow a rerun, so a scan that keeps
// failing stops after three catch-up attempts until one run succeeds.
const MAX_CONSECUTIVE_FAILURES = 3;

const toMs = (v) => {
  if (v == null) return NaN;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : NaN;
};

// PURE. row: the job_health row for 'price-scan-weekly' (or null/undefined).
// Returns { run: boolean, reason: string }.
function decidePriceScanCatchUp(row, now = Date.now()) {
  if (!row) return { run: false, reason: 'no_row' };
  const startedMs = toMs(row.last_started_at);
  if (!Number.isFinite(startedMs)) return { run: false, reason: 'no_start_time' };
  const age = now - startedMs;
  if (age < 0) return { run: false, reason: 'start_in_future' };
  if (age > CATCH_UP_WINDOW_MS) return { run: false, reason: 'too_old' };
  const failures = row.consecutive_failures == null ? NaN : Number(row.consecutive_failures);
  if (!Number.isFinite(failures) || failures > MAX_CONSECUTIVE_FAILURES) {
    return { run: false, reason: 'attempts_exhausted' };
  }
  if (row.last_status === 'failed') {
    const finishedMs = toMs(row.last_finished_at);
    if (Number.isFinite(finishedMs) && now - finishedMs < MIN_GAP_AFTER_FINISH_MS) {
      return { run: false, reason: 'too_soon' };
    }
    return { run: true, reason: 'failed_recently' };
  }
  if (row.last_status === 'running' && age > STALLED_RUNNING_MS) {
    return { run: true, reason: 'stalled_running' };
  }
  return { run: false, reason: 'healthy' };
}

module.exports = {
  JOB_NAME,
  decidePriceScanCatchUp,
  CATCH_UP_WINDOW_MS,
  STALLED_RUNNING_MS,
  MIN_GAP_AFTER_FINISH_MS,
  MAX_CONSECUTIVE_FAILURES,
};
