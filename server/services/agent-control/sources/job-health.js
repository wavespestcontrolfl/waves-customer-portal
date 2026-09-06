/**
 * Read adapter: job_health (one row per cron, utils/cron-lock.js) → the
 * latest run of every job as a canonical run keyed by job name. A cron
 * whose lane policy names it as `workflow_id` carries that lane; the rest
 * are workflow-only runs in the office area.
 */

const db = require('../../../models/db');
const { LANE_RUNTIME } = require('../lane-policies');
const { pagedAtColumn, canonicalRun, humanize, keyset, notMirrored, isMissingSchema } = require('./shape');

const SOURCE = 'job_health';
// One row per job, and its tick start is its only stamp: a job that ticks
// between two pages is a NEW run under the same key, so it may appear
// again — the one source with no immutable page key (Codex r14).
const START = () => db.raw("date_trunc('milliseconds', last_started_at)");
const PAGED = 'last_started_at';
const ID = 'job_name';
const COLUMNS = () => ['job_name', 'last_started_at', 'last_finished_at', 'last_success_at', 'last_status', 'last_error', 'last_duration_ms', 'consecutive_failures', 'updated_at', pagedAtColumn(db, 'last_started_at')];

let workflowLane = null;
function laneForJob(jobName) {
  if (!workflowLane) {
    workflowLane = new Map();
    for (const [laneId, policy] of Object.entries(LANE_RUNTIME)) {
      if (policy && policy.workflow_id) workflowLane.set(policy.workflow_id, laneId);
    }
  }
  return workflowLane.get(jobName) || null;
}

// One state per job: running | errored | ok.
const STATE = Object.freeze({
  running: { lifecycle: 'running', result: null, failureClass: null, step: 'running' },
  errored: { lifecycle: 'terminal', result: 'errored', failureClass: 'infrastructure', step: 'failed' },
  ok: { lifecycle: 'terminal', result: 'succeeded', failureClass: null, step: 'done' },
});

function stateOf(job) {
  if (job.last_status === 'running') return STATE.running;
  if (job.last_status === 'failed' || Number(job.consecutive_failures || 0) > 0) return STATE.errored;
  return STATE.ok;
}

function fromRow(job) {
  const state = stateOf(job);
  const running = state === STATE.running;
  const failures = Number(job.consecutive_failures || 0);
  // recordJobStart rewrites only last_started_at / last_status: while a job
  // runs, the finish, error and duration columns belong to its previous run
  const finishedAt = running ? null : job.last_finished_at;
  const error = state === STATE.errored ? job.last_error : null;
  const durationMs = running || job.last_duration_ms == null ? null : Number(job.last_duration_ms);
  return canonicalRun({
    source: SOURCE,
    id: job.job_name,
    laneId: laneForJob(job.job_name),
    workflowId: job.job_name,
    title: humanize(job.job_name),
    subtitle: failures > 1 ? `${failures} consecutive failures` : 'scheduled job',
    lifecycle: state.lifecycle,
    result: state.result,
    failureClass: state.failureClass,
    errorMessage: error,
    createdAt: job.last_started_at,
    pagedAt: job.paged_at,
    startedAt: job.last_started_at,
    finishedAt,
    lastHeartbeatAt: finishedAt ?? job.last_started_at,
    lastProgressAt: finishedAt ?? job.last_started_at,
    durationMs,
    // The row is the LATEST tick: one execution, and the schedule keeps
    // invoking the job (runExclusive caps nothing), so no attempt limit.
    // The failure streak is a diagnostic (the subtitle), not attempts
    // against a cap it never had (Codex r12).
    attempts: 1,
    maxAttempts: null,
    steps: [{ key: 'tick', label: 'Run', status: state.step, detail: error, ms: durationMs, toolName: null }],
    detail: error,
  });
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(db('job_health')
      .select(COLUMNS())
      .where((q) => {
        q.where('last_status', 'running').orWhere('last_status', 'failed').orWhere('consecutive_failures', '>', 0);
        q.orWhere(START(), '>=', from);
      }), { source: SOURCE, idColumn: 'job_health.job_name' }), { start: PAGED, id: ID, cursor, limit });
    return { runs: rows.map(fromRow), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(jobName) {
  try {
    const row = await db('job_health').select(COLUMNS()).where({ job_name: jobName }).first();
    return row ? { run: fromRow(row) } : null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, list, get, fromRow, laneForJob };
