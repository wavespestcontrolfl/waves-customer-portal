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
// Two instances may both see the row. Each retry runs under its own advisory
// lock (`deploy-kill-retry:<job>`, held for the whole run), and every check
// is made again under that lock. An instance that gets the lock after the
// other finished reads a row that is no longer "killed" and does nothing, so
// the job never replays back to back. The retry calls the job's own entry
// point: same gates, same job lock, same job_health record as the cron tick.
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
const { runExclusive, DEAD_RUN_ERROR } = require('./cron-lock');

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

async function readKilledRows() {
  // Every dead-run row, filtered to the registry by the caller: the set is a
  // handful of rows, and the query keeps the settle sweep's own shape.
  return db('job_health')
    .where({ last_status: 'failed', last_error: DEAD_RUN_ERROR })
    .select('job_name', 'last_started_at', 'consecutive_failures');
}

function withinBounds(row, now) {
  const startedAtMs = row.last_started_at ? new Date(row.last_started_at).getTime() : NaN;
  if (!Number.isFinite(startedAtMs) || now - startedAtMs > RETRY_MAX_AGE_MS) return false;
  const failures = Number(row.consecutive_failures);
  return Number.isFinite(failures) && failures <= RETRY_MAX_CONSECUTIVE_FAILURES;
}

// Runs under the retry lock. Reads the row again: the first read was only a
// cheap filter, and another instance may have retried the job since.
async function retryUnderLock(jobName, entry, now) {
  const row = (await readKilledRows()).find((r) => r.job_name === jobName);
  if (!row || !withinBounds(row, now)) return false;
  if (entry.shouldRetry && !(await entry.shouldRetry(row))) return false;
  logger.warn(`[deploy-kill-retry] ${jobName}: re-running after a deploy killed it mid-run`);
  await entry.run();
  return true;
}

async function retryDeployKilledJobs({ now = Date.now() } = {}) {
  if (!registry.size) return [];
  let rows;
  try {
    rows = await readKilledRows();
  } catch (err) {
    logger.warn(`[deploy-kill-retry] job_health unreadable, retry left for the next pass (${err.message})`);
    return [];
  }
  const retried = [];
  await Promise.all((rows || []).map(async (row) => {
    const jobName = row.job_name;
    const entry = registry.get(jobName);
    if (!entry || !withinBounds(row, now)) return;
    try {
      const ran = await runAsScheduledTick(() => runExclusive(
        `deploy-kill-retry:${jobName}`,
        () => retryUnderLock(jobName, entry, now),
        { recordHealth: false },
      ));
      if (ran === true) retried.push(jobName);
    } catch (err) {
      logger.error(`[deploy-kill-retry] ${jobName}: retry failed, left for the next pass (${err.message})`);
    }
  }));
  return retried;
}

module.exports = {
  registerDeployKillRetry,
  retryDeployKilledJobs,
  RETRY_MAX_AGE_MS,
  RETRY_MAX_CONSECUTIVE_FAILURES,
  _private: { registry },
};
