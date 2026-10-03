// One retry for a daily job a deploy killed mid-run.
//
// A deploy restarts the server; a job body running at that moment dies and
// cron-lock.settleDeadRunningJobs marks its job_health row failed ("process
// exited mid-run"). A daily job then waits a full day for its next tick, and
// on nights when main merges every few minutes the same job dies every night
// (2026-10-02 and 10-03: property-enrich-backfill and property-lookup-canary,
// both in the 3:55–4:18 AM ET merge window).
//
// OPT-IN: only a job registered here re-runs. Most cron bodies are not safe
// to run at an arbitrary later hour (customer sends, billing cohorts keyed to
// the wall clock), so there is no blanket retry. Register a job only when a
// second run on the same day is harmless.
//
// Two bounds keep a deploy storm from looping:
// - the killed run must have started within RETRY_MAX_AGE_MS, so a stale row
//   found days later never starts a job at an odd hour;
// - consecutive_failures (already incremented by the settle) must be at most
//   RETRY_MAX_CONSECUTIVE_FAILURES, so a job that keeps dying stops retrying
//   until one run succeeds and resets the counter.
//
// Only the instance whose pinned update settled the row gets the job name
// back, so a rolling deploy retries once, not once per instance. The retry
// runs the job's own entry point: same gates, same advisory lock, same
// job_health record as the cron tick.
const db = require('../models/db');
const logger = require('../services/logger');
const { runAsScheduledTick } = require('./scheduled-cron');

const RETRY_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const RETRY_MAX_CONSECUTIVE_FAILURES = 4;

const registry = new Map();

function registerDeployKillRetry(jobName, run) {
  if (typeof jobName !== 'string' || !jobName || typeof run !== 'function') {
    throw new Error('registerDeployKillRetry needs a job name and a function');
  }
  registry.set(jobName, run);
}

async function retryDeployKilledJobs(settledNames, { now = Date.now() } = {}) {
  const runs = [];
  const retried = [];
  for (const jobName of settledNames || []) {
    const run = registry.get(jobName);
    if (!run) continue;
    let row;
    try {
      row = await db('job_health')
        .where({ job_name: jobName })
        .first('last_status', 'last_started_at', 'consecutive_failures');
    } catch (err) {
      logger.warn(`[deploy-kill-retry] ${jobName}: job_health unreadable, no retry (${err.message})`);
      continue;
    }
    // A tick that restarted the job after the settle owns the row now.
    if (!row || row.last_status !== 'failed') continue;
    const startedAtMs = row.last_started_at ? new Date(row.last_started_at).getTime() : NaN;
    if (!Number.isFinite(startedAtMs) || now - startedAtMs > RETRY_MAX_AGE_MS) {
      logger.info(`[deploy-kill-retry] ${jobName}: killed run is too old, no retry`);
      continue;
    }
    const failures = Number(row.consecutive_failures);
    if (!Number.isFinite(failures) || failures > RETRY_MAX_CONSECUTIVE_FAILURES) {
      logger.warn(`[deploy-kill-retry] ${jobName}: ${row.consecutive_failures} consecutive failures, no retry`);
      continue;
    }
    logger.warn(`[deploy-kill-retry] ${jobName}: re-running after a deploy killed it mid-run`);
    retried.push(jobName);
    runs.push(
      Promise.resolve()
        .then(() => runAsScheduledTick(run))
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
