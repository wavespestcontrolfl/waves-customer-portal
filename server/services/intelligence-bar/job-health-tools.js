/**
 * Intelligence Bar — Scheduled Job Health Tools
 * server/services/intelligence-bar/job-health-tools.js
 *
 * One read over job_health (one row per named cron, upserted by the
 * cron-lock recorder): last run, last success, failure streaks, and
 * stuck-mid-run detection. This is the INTERNAL-automation half of the
 * observability story — the external services all have their own ops
 * modules; this answers "did the Monday pricing sweep / GA4 sync /
 * mileage sync actually run?"
 *
 * Coverage note: only advisory-locked sweep jobs (runExclusive) report
 * here. Queue-claim jobs (FOR UPDATE SKIP LOCKED) are fleet-safe without
 * the lock and do not appear.
 */

const db = require('../../models/db');
const logger = require('../logger');

// A job still marked running whose start is older than this has almost
// certainly died mid-run (deploy restart, crash) — the recorder never got
// to write the end state.
const STUCK_RUNNING_MINUTES = 60;

const JOB_HEALTH_TOOLS = [
  {
    name: 'get_scheduled_job_health',
    description: `Health of the portal's own scheduled jobs (pricing sweeps, syncs, reminder/digest crons): last run, last success, consecutive failures, and jobs stuck mid-run. Failing-first ordering. The internal-automation counterpart to the external infra tools.
Use for: "did the Monday pricing sweep run?", "are the crons healthy?", "is anything failing repeatedly or stuck?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

function classify(row, now) {
  if (row.last_status === 'failed') return 'failing';
  if (row.last_status === 'running') {
    const startedMs = row.last_started_at ? new Date(row.last_started_at).getTime() : 0;
    if (now - startedMs > STUCK_RUNNING_MINUTES * 60 * 1000) return 'stuck';
    return 'running';
  }
  return 'healthy';
}

async function getScheduledJobHealth() {
  const rows = await db('job_health').orderBy('job_name');
  const now = Date.now();
  const jobs = rows.map(row => ({
    job: row.job_name,
    state: classify(row, now),
    last_status: row.last_status,
    last_started_at: row.last_started_at ? new Date(row.last_started_at).toISOString() : null,
    last_success_at: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    consecutive_failures: row.consecutive_failures || 0,
    last_duration_ms: row.last_duration_ms ?? null,
    last_error: row.last_error || null,
  }));
  const stateRank = { failing: 0, stuck: 0, running: 2, healthy: 3 };
  jobs.sort((a, b) => {
    const rank = (stateRank[a.state] ?? 3) - (stateRank[b.state] ?? 3);
    if (rank !== 0) return rank;
    return (b.consecutive_failures || 0) - (a.consecutive_failures || 0);
  });
  const unhealthy = jobs.filter(j => j.state === 'failing' || j.state === 'stuck').length;
  return {
    jobs,
    total: jobs.length,
    unhealthy,
    note: `One row per advisory-locked sweep job, recorded on every run. state=stuck means marked running for over ${STUCK_RUNNING_MINUTES} minutes — the process likely died mid-run (deploy restart); the next tick will overwrite it. Queue-claim jobs do not report here. Compare last_success_at to the job's cadence for staleness. Fixing a failing job means reading its error and the code — nothing is restartable from here.`,
  };
}

async function executeJobHealthTool(toolName) {
  try {
    switch (toolName) {
      case 'get_scheduled_job_health': return await getScheduledJobHealth();
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:job-health] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { JOB_HEALTH_TOOLS, executeJobHealthTool };
