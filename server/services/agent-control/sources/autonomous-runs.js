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
// Sort / page key = the run's startedAt in fromRow, at ms precision.
const START = db.raw("date_trunc('milliseconds', COALESCE(claimed_at, created_at))");
const ID = 'id';
const COLUMNS = [
  'id', 'action_type', 'page_type', 'shadow_mode', 'outcome', 'skip_reason', 'failure_message',
  db.raw("draft_payload->>'title' AS draft_title"),
  db.raw("draft_payload->'frontmatter'->>'title' AS draft_frontmatter_title"),
  'published_url', 'claimed_at', 'completed_at', 'created_at', 'updated_at', 'total_ms', 'agent_session_id',
  'claim_ms', 'brief_ms', 'agent_ms', 'uniqueness_gate_ms', 'quality_gate_ms', 'seo_completion_gate_ms',
  'publish_ms', 'index_submit_ms', 'link_plan_ms',
  'uniqueness_gate_result', 'quality_gate_result', 'seo_completion_gate_result', 'trust_build_approved_at',
  // the NEWEST emailed approval on the run decides whether the owner still owes a reply
  db.raw("(SELECT a.status FROM content_email_approvals a WHERE a.run_id = autonomous_runs.id ORDER BY a.created_at DESC LIMIT 1) AS approval_status"),
  db.raw("(SELECT COALESCE(a.decided_at, a.created_at) FROM content_email_approvals a WHERE a.run_id = autonomous_runs.id ORDER BY a.created_at DESC LIMIT 1) AS approval_at"),
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

function fromRow(run) {
  const status = runStatus(run);
  const decided = decisionFor(run, status);
  const map = decided || STATUS_MAP[status] || STATUS_MAP.completed;
  // an emailed approval (raised or decided) or the in-review stamp is the run's latest event
  const decidedAt = run.approval_at || run.trust_build_approved_at;
  const steps = stepsFor(run, status);
  const errored = map.result === 'errored';
  const skipReason = run.skip_reason ? humanize(run.skip_reason) : null;
  return canonicalRun({
    source: SOURCE,
    id: run.id,
    laneId: LANE,
    title: run.draft_title || run.draft_frontmatter_title
      || [humanize(run.action_type), humanize(run.page_type)].filter(Boolean).join(' · ') || 'Content run',
    subtitle: [humanize(run.action_type), humanize(run.page_type), SHADOW_LABEL[run.shadow_mode]].filter(Boolean).join(' · ') || null,
    ...map,
    errorCode: errored ? run.outcome : null,
    errorMessage: run.failure_message,
    createdAt: run.created_at,
    startedAt: run.claimed_at || run.created_at,
    finishedAt: decided ? decidedAt || run.completed_at : run.completed_at,
    lastHeartbeatAt: run.updated_at || run.claimed_at,
    lastProgressAt: decidedAt || run.updated_at || run.claimed_at,
    durationMs: run.total_ms,
    steps,
    link: map.lifecycle === 'waiting_human' ? REVIEW_LINK : run.published_url,
    detail: run.failure_message || skipReason || run.published_url,
    entity: { type: 'autonomous_run', id: run.id },
  });
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(db('autonomous_runs')
      .select(COLUMNS)
      .where((q) => {
        q.whereNull('completed_at');
        q.orWhereRaw(PARKED);
        q.orWhere(START, '>=', from);
      }), { source: SOURCE, idColumn: 'autonomous_runs.id' }), { start: START, id: ID, cursor, limit });
    return { runs: rows.map(fromRow), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(id) {
  try {
    const row = await db('autonomous_runs').select(COLUMNS).where({ id }).first();
    return row ? { run: fromRow(row) } : null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, LANE, list, get, fromRow };
