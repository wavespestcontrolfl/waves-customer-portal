// Retry for a daily job a deploy killed mid-run.
//
// A deploy restarts the server; a job body running at that moment dies and
// cron-lock.settleDeadRunningJobs marks its job_health row failed with
// DEAD_RUN_ERROR. A daily job then waits a full day for its next tick, and
// on nights when main merges every few minutes the same job dies every night
// (2026-10-02 and 10-03: property-enrich-backfill and property-lookup-canary,
// both in the 3:55–4:18 AM ET merge window).
//
// OPT-IN: only a job registered here re-runs. Most cron bodies are not safe
// to run at an arbitrary later hour (customer sends, billing cohorts keyed to
// the wall clock), so there is no blanket retry. Register a job only when a
// second run on the same day is harmless, or pass shouldRetry to refuse the
// retry when the killed run already did the part that must not repeat.
//
// The job_health row is the retry request. Each pass (the scheduler runs one
// after every settle: boot, then :03/:18/:33/:48) reads the registered jobs
// whose row still says "failed with DEAD_RUN_ERROR" and runs them. Nothing is
// held in memory, so a pass that dies before the retry starts, or a transient
// read failure, leaves the row for the next pass or the next instance. The
// row leaves that state when the retry starts (running), ends (success, or
// failed with its own error), or the next cron tick runs.
//
// Two instances may both see the row; the job's own runExclusive lock lets
// one run and the other skip. The retry calls the job's own entry point:
// same gates, same advisory lock, same job_health record as the cron tick.
//
// Two bounds keep a deploy storm from looping:
// - the killed run must have started within RETRY_MAX_AGE_MS, so a stale row
//   found later never starts a job at an odd hour;
// - consecutive_failures (already incremented by the settle) must be at most
//   RETRY_MAX_CONSECUTIVE_FAILURES, so a job that keeps dying stops retrying
//   until one run succeeds and resets the counter.
const db = require('../models/db');
const logger = require('../services/logger');
const { runAsScheduledTick } = require('./scheduled-cron');
const { DEAD_RUN_ERROR } = require('./cron-lock');

const RETRY_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const RETRY_MAX_CONSECUTIVE_FAILURES = 4;

const registry = new Map();

function registerDeployKillRetry(jobName, run, { shouldRetry } = {}) {
  if (typeof jobName !== 'string' || !jobName || typeof run !== 'function') {
    throw new Error('registerDeployKillRetry needs a job name and a function');
  }
  if (shouldRetry !== undefined && typeof shouldRetry !== 'function') {
    throw new Error('registerDeployKillRetry: shouldRetry must be a function');
  }
  registry.set(jobName, { run, shouldRetry });
}

async function retryDeployKilledJobs({ now = Date.now() } = {}) {
  if (!registry.size) return [];
  let rows;
  try {
    // Every dead-run row, filtered to the registry below: the set is a
    // handful of rows, and the query keeps the settle sweep's own shape.
    rows = await db('job_health')
      .where({ last_status: 'failed', last_error: DEAD_RUN_ERROR })
      .select('job_name', 'last_started_at', 'consecutive_failures');
  } catch (err) {
    logger.warn(`[deploy-kill-retry] job_health unreadable, retry left for the next pass (${err.message})`);
    return [];
  }
  const runs = [];
  const retried = [];
  for (const row of rows || []) {
    const jobName = row.job_name;
    const entry = registry.get(jobName);
    if (!entry) continue;
    const startedAtMs = row.last_started_at ? new Date(row.last_started_at).getTime() : NaN;
    if (!Number.isFinite(startedAtMs) || now - startedAtMs > RETRY_MAX_AGE_MS) continue;
    const failures = Number(row.consecutive_failures);
    if (!Number.isFinite(failures) || failures > RETRY_MAX_CONSECUTIVE_FAILURES) continue;
    if (entry.shouldRetry) {
      let ok;
      try {
        ok = await entry.shouldRetry(row);
      } catch (err) {
        logger.warn(`[deploy-kill-retry] ${jobName}: retry check failed, left for the next pass (${err.message})`);
        continue;
      }
      if (!ok) continue;
    }
    logger.warn(`[deploy-kill-retry] ${jobName}: re-running after a deploy killed it mid-run`);
    retried.push(jobName);
    runs.push(
      Promise.resolve()
        .then(() => runAsScheduledTick(entry.run))
        .catch((err) => logger.error(`[deploy-kill-retry] ${jobName}: retry failed: ${err.message}`)),
    );
  }
  await Promise.all(runs);
  return retried;
}

module.exports = {
  registerDeployKillRetry,
  retryDeployKilledJobs,
  RETRY_MAX_AGE_MS,
  RETRY_MAX_CONSECUTIVE_FAILURES,
  _private: { registry },
};
