/**
 * Read adapter: autonomous_runs (Blog Content Engine) → canonical runs.
 * Stage order and outcome mapping come from agent-activity.js
 * (RUN_STAGES / runStatus) — the one place the runner's vocabulary lives.
 */

const db = require('../../../models/db');
const { RUN_STAGES, runStatus, TERMINAL_APPROVAL } = require('../../agent-activity');
const { canonicalRun, humanize, keyset, notMirrored, isMissingSchema } = require('./shape');

const SOURCE = 'autonomous_runs';
const LANE = 'blog_draft';
// The newest emailed approval on the run (see COLUMNS): while the poller
// is executing its decision — and once that execution FAILED — the
// decision's time is the run's start (the failed execution keeps its span:
// decided_at → the approval row's updated_at, Codex r5).
const NEWEST_APPROVAL = 'FROM content_email_approvals a WHERE a.run_id = autonomous_runs.id ORDER BY a.created_at DESC LIMIT 1';
const EXECUTION_STARTED_AT = `(SELECT CASE WHEN a.status IN ('executing', 'failed') THEN a.decided_at END ${NEWEST_APPROVAL})`;
// An in-app approval of a parked draft flips its outcome to publishing_*
// IN PLACE (autonomous-runner: outcome + updated_at only; completed_at and
// claimed_at stay) — agent-activity's runStatus reads publishing* as
// running, and so does this adapter: live however old, active again from
// that claim (updated_at is the only stamp it writes).
const PUBLISHING = "outcome LIKE 'publishing%'";
const PUBLISHING_RE = /^publishing/;
// Sort / page key = the run's startedAt in fromRow (spanFor), at ms precision.
const START = () => db.raw(`date_trunc('milliseconds', COALESCE(${EXECUTION_STARTED_AT}, CASE WHEN ${PUBLISHING} THEN updated_at END, claimed_at, created_at))`);
const ID = 'id';
const COLUMNS = () => [
  'id', 'action_type', 'page_type', 'shadow_mode', 'outcome', 'skip_reason', 'failure_message',
  db.raw("draft_payload->>'title' AS draft_title"),
  db.raw("draft_payload->'frontmatter'->>'title' AS draft_frontmatter_title"),
  'published_url', 'claimed_at', 'completed_at', 'created_at', 'updated_at', 'total_ms', 'agent_session_id',
  'claim_ms', 'brief_ms', 'agent_ms', 'uniqueness_gate_ms', 'quality_gate_ms', 'seo_completion_gate_ms',
  'publish_ms', 'index_submit_ms', 'link_plan_ms',
  'uniqueness_gate_result', 'quality_gate_result', 'seo_completion_gate_result', 'trust_build_approved_at',
  // the NEWEST emailed approval on the run decides whether the owner still owes a reply
  db.raw(`(SELECT a.status ${NEWEST_APPROVAL}) AS approval_status`),
  // the approval's latest event: a failed execution's finish is its updated_at
  db.raw(`(SELECT COALESCE(CASE WHEN a.status = 'failed' THEN a.updated_at END, a.decided_at, a.created_at) ${NEWEST_APPROVAL}) AS approval_at`),
  db.raw(`${EXECUTION_STARTED_AT} AS execution_started_at`),
  db.raw(`(SELECT a.last_error ${NEWEST_APPROVAL}) AS approval_error`),
];
// A run parked for the owner (completed_pending_review) stays live until a
// terminal emailed decision or the in-review approval stamp lands.
const PARKED = "(outcome = 'completed_pending_review' AND trust_build_approved_at IS NULL"
  + " AND NOT EXISTS (SELECT 1 FROM content_email_approvals a WHERE a.run_id = autonomous_runs.id AND a.status IN ('approved', 'rejected', 'superseded', 'failed')))";
// emailed decision → (lifecycle, result, disposition); executing = the poller is applying it
const DECIDED = Object.freeze({
  approved: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied', verification: 'passed' },
  rejected: { lifecycle: 'terminal', result: 'succeeded', disposition: 'rejected', verification: 'failed' },
  superseded: { lifecycle: 'terminal', result: 'canceled', disposition: 'no_action' },
  failed: { lifecycle: 'terminal', result: 'errored', failureClass: 'infrastructure' },
  executing: { lifecycle: 'running' },
});

// agent-activity status → (lifecycle, result, disposition, failureClass)
const STATUS_MAP = Object.freeze({
  running: { lifecycle: 'running' },
  awaiting_review: { lifecycle: 'waiting_human', disposition: 'drafted', verification: 'unjudged' },
  blocked: { lifecycle: 'terminal', result: 'errored', failureClass: 'instruction', disposition: 'no_action' },
  completed: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' },
  skipped: { lifecycle: 'terminal', result: 'canceled', disposition: 'no_action' },
  failed: { lifecycle: 'terminal', result: 'errored' },
});

function verdict(result) {
  if (!result || typeof result !== 'object') return null;
  for (const k of ['ok', 'pass', 'passed']) if (typeof result[k] === 'boolean') return result[k];
  return null;
}

function stepsFor(run, status) {
  const steps = [];
  let reachedEnd = false;
  for (const stage of RUN_STAGES) {
    const ms = run[stage.ms];
    const result = stage.result ? run[stage.result] : null;
    const v = verdict(result);
    if (ms == null && v === null) {
      if (!reachedEnd && status === 'running' && steps.length) {
        steps.push({ key: stage.key, label: stage.label, status: 'running', detail: null, ms: null, toolName: null });
        reachedEnd = true;
      } else {
        steps.push({ key: stage.key, label: stage.label, status: 'skipped', detail: null, ms: null, toolName: null });
      }
      continue;
    }
    steps.push({ key: stage.key, label: stage.label, status: v === false ? 'blocked' : 'done', detail: null, ms: ms == null ? null : Number(ms), toolName: null });
  }
  return steps;
}

const SHADOW_LABEL = Object.freeze({ true: 'shadow' });
const REVIEW_LINK = '/admin/blog?tab=autopilot';

// The agent-activity rule: a pending-review outcome never changes once
// decided (the poller stamps the run, not its outcome) — the newest emailed
// approval or the in-review stamp says whether the owner already decided.
function decisionFor(run, status) {
  if (status !== 'awaiting_review') return null;
  if (run.approval_status && TERMINAL_APPROVAL[run.approval_status]) return DECIDED[run.approval_status] || null;
  if (run.trust_build_approved_at) return DECIDED.approved;
  return null;
}

// The run's active span. Normally the claim → completion (a decided run
// closes at its decision). While the poller executes an emailed decision
// the run is active AGAIN from that decision: judged from its own start
// (a draft parked past the hard timeout is not stalled the moment the
// owner replies) and with no finish yet (Codex r1).
function spanFor(run, decided, decidedAt) {
  if (decided === DECIDED.executing) return { startedAt: decidedAt, finishedAt: null, lastHeartbeatAt: decidedAt };
  // a failed execution keeps its own span: the decision → the failure
  if (decided === DECIDED.failed) return { startedAt: run.execution_started_at || run.claimed_at || run.created_at, finishedAt: decidedAt, lastHeartbeatAt: decidedAt };
  if (PUBLISHING_RE.test(run.outcome || '')) return { startedAt: run.updated_at || run.claimed_at || run.created_at, finishedAt: null, lastHeartbeatAt: run.updated_at };
  return {
    startedAt: run.claimed_at || run.created_at,
    finishedAt: decided ? decidedAt || run.completed_at : run.completed_at,
    lastHeartbeatAt: run.updated_at || run.claimed_at,
  };
}

// What failed: a failed emailed approval names ITS failure (the executor
// keeps it in content_email_approvals.last_error) — not the generation-
// time outcome, which was a parked success (Codex r2).
function failureFor(run, decided) {
  if (decided === DECIDED.failed) return { code: 'approval_failed', message: run.approval_error };
  return { code: run.outcome, message: run.failure_message };
}

function fromRow(run) {
  const status = runStatus(run);
  const decided = decisionFor(run, status);
  const map = decided || STATUS_MAP[status] || STATUS_MAP.completed;
  // an emailed approval (raised or decided) or the in-review stamp is the run's latest event
  const decidedAt = run.approval_at || run.trust_build_approved_at;
  const steps = stepsFor(run, status);
  const errored = map.result === 'errored';
  const failure = failureFor(run, decided);
  const skipReason = run.skip_reason ? humanize(run.skip_reason) : null;
  return canonicalRun({
    source: SOURCE,
    id: run.id,
    laneId: LANE,
    title: run.draft_title || run.draft_frontmatter_title
      || [humanize(run.action_type), humanize(run.page_type)].filter(Boolean).join(' · ') || 'Content run',
    subtitle: [humanize(run.action_type), humanize(run.page_type), SHADOW_LABEL[run.shadow_mode]].filter(Boolean).join(' · ') || null,
    ...map,
    errorCode: errored ? failure.code : null,
    errorMessage: failure.message,
    createdAt: run.created_at,
    ...spanFor(run, decided, decidedAt),
    lastProgressAt: decidedAt || run.updated_at || run.claimed_at,
    durationMs: run.total_ms,
    steps,
    link: map.lifecycle === 'waiting_human' ? REVIEW_LINK : run.published_url,
    detail: failure.message || skipReason || run.published_url,
    entity: { type: 'autonomous_run', id: run.id },
  });
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(db('autonomous_runs')
      .select(COLUMNS())
      .where((q) => {
        q.whereNull('completed_at');
        q.orWhereRaw(PARKED);
        q.orWhereRaw(PUBLISHING);
        q.orWhere(START(), '>=', from);
      }), { source: SOURCE, idColumn: 'autonomous_runs.id' }), { start: START(), id: ID, cursor, limit });
    return { runs: rows.map(fromRow), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(id) {
  try {
    const row = await db('autonomous_runs').select(COLUMNS()).where({ id }).first();
    return row ? { run: fromRow(row) } : null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, LANE, PUBLISHING, list, get, fromRow };
