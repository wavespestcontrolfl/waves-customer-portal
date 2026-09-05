/**
 * Read adapter: autonomous_runs (Blog Content Engine) → canonical runs.
 * Stage order and outcome mapping come from agent-activity.js
 * (RUN_STAGES / runStatus) — the one place the runner's vocabulary lives.
 */

const db = require('../../../models/db');
const { RUN_STAGES, runStatus } = require('../../agent-activity');
const { canonicalRun, humanize, keyset, isMissingSchema } = require('./shape');

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
  'uniqueness_gate_result', 'quality_gate_result', 'seo_completion_gate_result',
];

// agent-activity status → (lifecycle, result, disposition, failureClass)
const STATUS_MAP = Object.freeze({
  running: { lifecycle: 'running' },
  awaiting_review: { lifecycle: 'waiting_human', disposition: 'drafted' },
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

function fromRow(run) {
  const status = runStatus(run);
  const map = STATUS_MAP[status] || STATUS_MAP.completed;
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
    finishedAt: run.completed_at,
    lastHeartbeatAt: run.updated_at || run.claimed_at,
    lastProgressAt: run.updated_at || run.claimed_at,
    durationMs: run.total_ms,
    steps,
    link: status === 'awaiting_review' ? REVIEW_LINK : run.published_url,
    detail: run.failure_message || skipReason || run.published_url,
    entity: { type: 'autonomous_run', id: run.id },
  });
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(db('autonomous_runs')
      .select(COLUMNS)
      .where((q) => {
        q.whereNull('completed_at');
        q.orWhere(START, '>=', from);
      }), { start: START, id: ID, cursor, limit });
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
