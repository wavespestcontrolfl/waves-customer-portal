// Agent Activity feed — one timeline of what the agents and crons did,
// built from the ledgers that already exist (no new tables):
//
//   autonomous_runs          → content runs (Blog Content Engine), with the
//                              per-stage timings as steps and gate verdicts
//   content_email_approvals  → runs still waiting on the owner's emailed reply
//   message_drafts           → inbound-SMS drafts parked for approval
//   job_health               → crons that are failing or mid-run (healthy ones
//                              are only counted — exception-based feed)
//
// Read-only. Behind GATE_AGENT_ACTIVITY (feature-gates.js `agentActivity`):
// the route answers { available: false } while the gate is off.
//
// Item shape (the client renders exactly this):
//   { id, kind, agent, title, subtitle, status, startedAt, finishedAt,
//     durationMs, steps: [{ key, label, status, detail, ms }],
//     stepsDone, stepsTotal, link, detail }
// status ∈ running | awaiting_review | blocked | completed | failed | skipped

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');

const STATUSES = ['running', 'awaiting_review', 'blocked', 'completed', 'failed', 'skipped'];
const MAX_WINDOW_HOURS = 24 * 14;
const DEFAULT_WINDOW_HOURS = 24;
const MAX_ITEMS = 200;
const MISSING_TABLE_SQLSTATE = '42P01';

const CONTENT_AGENT = 'Blog Content Engine';
const SMS_AGENT = 'Customer Assistant';
const SYSTEM_AGENT = 'System';

// Stage order of the autonomous content runner; the *_ms columns are null
// for stages a run never reached.
const RUN_STAGES = [
  { key: 'claim', label: 'Claim opportunity', ms: 'claim_ms' },
  { key: 'brief', label: 'Build brief', ms: 'brief_ms' },
  { key: 'agent', label: 'Write draft', ms: 'agent_ms' },
  { key: 'uniqueness_gate', label: 'Uniqueness gate', ms: 'uniqueness_gate_ms', result: 'uniqueness_gate_result' },
  { key: 'quality_gate', label: 'Quality gate', ms: 'quality_gate_ms', result: 'quality_gate_result' },
  { key: 'seo_completion_gate', label: 'SEO completion gate', ms: 'seo_completion_gate_ms', result: 'seo_completion_gate_result' },
  { key: 'publish', label: 'Publish', ms: 'publish_ms' },
  { key: 'index_submit', label: 'Submit to index', ms: 'index_submit_ms' },
  { key: 'link_plan', label: 'Plan internal links', ms: 'link_plan_ms' },
];

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function humanize(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Gate result objects differ per gate; each carries an ok/pass/passed flag.
function gateVerdict(result) {
  if (!result || typeof result !== 'object') return null;
  if (typeof result.ok === 'boolean') return result.ok;
  if (typeof result.pass === 'boolean') return result.pass;
  if (typeof result.passed === 'boolean') return result.passed;
  return null;
}

function gateDetail(result) {
  if (!result || typeof result !== 'object') return null;
  const names = []
    .concat(Array.isArray(result.hard_failures) ? result.hard_failures : [])
    .concat(Array.isArray(result.soft_failures) ? result.soft_failures : [])
    .concat(Array.isArray(result.failed_reasons) ? result.failed_reasons : [])
    .map((f) => (typeof f === 'string' ? f : f?.name || f?.reason || f?.code))
    .filter(Boolean);
  if (names.length) return names.slice(0, 4).join(' · ');
  if (typeof result.total_score === 'number' && typeof result.min_total_score === 'number') {
    return `score ${result.total_score} / min ${result.min_total_score}`;
  }
  return null;
}

function runStatus(run) {
  const outcome = String(run.outcome || '');
  if (!outcome) return run.completed_at ? 'completed' : 'running';
  if (outcome === 'completed_published') return 'completed';
  if (outcome === 'completed_pending_review') return 'awaiting_review';
  if (outcome === 'skipped_gate_fail') return 'blocked';
  if (outcome.startsWith('skipped')) return 'skipped';
  if (outcome.startsWith('failed')) return 'failed';
  return 'completed';
}

function contentRunItem(run, awaitingReplyByRun) {
  const draft = parseJson(run.draft_payload, {}) || {};
  const status = runStatus(run);
  const steps = [];
  let reachedEnd = false;
  for (const stage of RUN_STAGES) {
    const ms = run[stage.ms];
    const result = stage.result ? parseJson(run[stage.result], null) : null;
    const verdict = gateVerdict(result);
    if (ms == null && verdict === null) {
      // A stage without a timing was never reached — everything after the
      // last reached stage is "not started" (or the run is still inside it).
      if (!reachedEnd && status === 'running' && steps.length) {
        steps.push({ key: stage.key, label: stage.label, status: 'running', detail: null, ms: null });
        reachedEnd = true;
      } else {
        steps.push({ key: stage.key, label: stage.label, status: 'not_started', detail: null, ms: null });
      }
      continue;
    }
    steps.push({
      key: stage.key,
      label: stage.label,
      status: verdict === false ? 'blocked' : 'done',
      detail: verdict === false ? gateDetail(result) : null,
      ms: ms == null ? null : Number(ms),
    });
  }
  const stepsDone = steps.filter((s) => s.status === 'done').length;
  const stepsTotal = steps.length;
  const awaiting = awaitingReplyByRun.get(String(run.id));
  const title =
    draft.title ||
    draft.frontmatter?.title ||
    [humanize(run.action_type), humanize(run.page_type)].filter(Boolean).join(' · ') ||
    'Content run';
  const detail =
    run.failure_message ||
    (run.skip_reason ? humanize(run.skip_reason) : null) ||
    (awaiting ? `Awaiting emailed reply (${awaiting.token})` : null) ||
    (run.published_url ? run.published_url : null);
  return {
    id: `run:${run.id}`,
    kind: 'content_run',
    agent: CONTENT_AGENT,
    title,
    subtitle: [humanize(run.action_type), humanize(run.page_type), run.shadow_mode ? 'shadow' : null]
      .filter(Boolean)
      .join(' · '),
    status: awaiting && status !== 'failed' ? 'awaiting_review' : status,
    startedAt: iso(run.claimed_at || run.created_at),
    finishedAt: iso(run.completed_at),
    durationMs: run.total_ms == null ? null : Number(run.total_ms),
    steps,
    stepsDone,
    stepsTotal,
    link: status === 'awaiting_review' || awaiting ? '/admin/blog?tab=autopilot' : run.published_url || null,
    detail,
  };
}

function smsDraftItem(draft) {
  return {
    id: `draft:${draft.id}`,
    kind: 'sms_draft',
    agent: SMS_AGENT,
    title: draft.customer_name
      ? `Reply draft for ${draft.customer_name}`
      : 'Reply draft for inbound text',
    subtitle: [humanize(draft.intent), draft.drafter ? `drafter ${draft.drafter}` : null]
      .filter(Boolean)
      .join(' · '),
    status: 'awaiting_review',
    startedAt: iso(draft.created_at),
    finishedAt: null,
    durationMs: draft.draft_ms == null ? null : Number(draft.draft_ms),
    steps: [
      { key: 'inbound', label: 'Inbound text', status: 'done', detail: draft.inbound_message ? String(draft.inbound_message).slice(0, 160) : null, ms: null },
      { key: 'draft', label: 'Draft reply', status: 'done', detail: draft.draft_response ? String(draft.draft_response).slice(0, 160) : null, ms: draft.draft_ms == null ? null : Number(draft.draft_ms) },
      { key: 'approve', label: 'Owner approval', status: 'running', detail: 'Waiting in Pending Drafts', ms: null },
    ],
    stepsDone: 2,
    stepsTotal: 3,
    link: '/admin/agents?tab=drafts',
    detail: null,
  };
}

function jobItem(job) {
  const failing = Number(job.consecutive_failures || 0) > 0 || job.last_status === 'failed';
  const status = job.last_status === 'running' ? 'running' : failing ? 'failed' : 'completed';
  return {
    id: `job:${job.job_name}`,
    kind: 'job',
    agent: SYSTEM_AGENT,
    title: humanize(job.job_name),
    subtitle: failing && Number(job.consecutive_failures) > 1
      ? `${job.consecutive_failures} consecutive failures`
      : 'scheduled job',
    status,
    startedAt: iso(job.last_started_at),
    finishedAt: iso(job.last_finished_at),
    durationMs: job.last_duration_ms == null ? null : Number(job.last_duration_ms),
    steps: [],
    stepsDone: status === 'completed' ? 1 : 0,
    stepsTotal: 1,
    link: null,
    detail: failing ? job.last_error || null : null,
  };
}

function summarize(items, healthyJobs = 0) {
  const summary = { total: items.length, healthyJobs };
  for (const s of STATUSES) summary[s] = 0;
  for (const item of items) summary[item.status] = (summary[item.status] || 0) + 1;
  return summary;
}

// Exception-based (CLAUDE.md rule 14): a cron that ran and succeeded is a
// count in the summary, not a row — otherwise the every-minute pollers bury
// the agent runs the feed exists to show.
function jobIsException(job) {
  return job.last_status === 'running' || job.last_status === 'failed' || Number(job.consecutive_failures || 0) > 0;
}

// Pure: rows in → feed out. The route loads the rows; tests feed fixtures.
function buildActivity({ runs = [], approvals = [], drafts = [], jobs = [] }) {
  const awaitingReplyByRun = new Map();
  for (const a of approvals) {
    if (a.status === 'awaiting_reply' && a.run_id) awaitingReplyByRun.set(String(a.run_id), a);
  }
  const exceptionJobs = jobs.filter(jobIsException);
  const items = []
    .concat(runs.map((run) => contentRunItem(run, awaitingReplyByRun)))
    .concat(drafts.map(smsDraftItem))
    .concat(exceptionJobs.map(jobItem))
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  const agents = Array.from(new Set(items.map((i) => i.agent))).sort();
  return { items, agents, summary: summarize(items, jobs.length - exceptionJobs.length) };
}

function clampWindowHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_HOURS;
  return Math.min(Math.floor(n), MAX_WINDOW_HOURS);
}

async function loadRows(windowHours) {
  const since = new Date(Date.now() - windowHours * 3600 * 1000);
  // Only a MISSING table (Postgres 42P01 — a ledger not yet migrated on
  // this deployment) degrades to an empty source, reported back as
  // unavailable. Any other failure (outage, permissions, broken query) is
  // thrown so the endpoint 500s and the tab shows a load error — a
  // monitoring surface must never present a failure as "nothing happened".
  const unavailable = [];
  const safe = async (label, query) => {
    try {
      return await query();
    } catch (err) {
      if (err && err.code === MISSING_TABLE_SQLSTATE) {
        unavailable.push(label);
        return [];
      }
      throw err;
    }
  };
  const [runs, drafts, jobs] = await Promise.all([
    safe('autonomous_runs', () =>
      db('autonomous_runs')
        .select(
          'id', 'action_type', 'page_type', 'shadow_mode', 'outcome', 'skip_reason', 'failure_message',
          'draft_payload', 'published_url', 'claimed_at', 'completed_at', 'created_at', 'total_ms',
          'claim_ms', 'brief_ms', 'agent_ms', 'uniqueness_gate_ms', 'quality_gate_ms', 'seo_completion_gate_ms',
          'publish_ms', 'index_submit_ms', 'link_plan_ms',
          'uniqueness_gate_result', 'quality_gate_result', 'seo_completion_gate_result',
        )
        .where('created_at', '>=', since)
        .orderBy('created_at', 'desc')
        .limit(MAX_ITEMS)),
    safe('message_drafts', () =>
      db('message_drafts as d')
        .leftJoin('customers as c', 'c.id', 'd.customer_id')
        .select(
          'd.id', 'd.intent', 'd.drafter', 'd.draft_ms', 'd.created_at', 'd.inbound_message', 'd.draft_response',
          db.raw("NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name"),
        )
        .where('d.status', 'pending')
        .where('d.created_at', '>=', since)
        .orderBy('d.created_at', 'desc')
        .limit(MAX_ITEMS)),
    safe('job_health', () =>
      db('job_health')
        .select('job_name', 'last_started_at', 'last_finished_at', 'last_status', 'last_error', 'last_duration_ms', 'consecutive_failures')
        .where('last_started_at', '>=', since)
        .orderBy('last_started_at', 'desc')
        .limit(MAX_ITEMS)),
  ]);
  // Approvals are scoped to the runs actually loaded (one awaiting row per
  // run_id, unique in the schema), so no cap can drop a loaded run's row.
  const runIds = runs.map((r) => r.id);
  const approvals = runIds.length
    ? await safe('content_email_approvals', () =>
      db('content_email_approvals')
        .select('run_id', 'token', 'status', 'kind', 'created_at')
        .where({ status: 'awaiting_reply' })
        .whereIn('run_id', runIds))
    : [];
  return { runs, approvals, drafts, jobs, unavailable };
}

async function getActivity({ windowHours } = {}) {
  if (!isEnabled('agentActivity')) return { available: false, items: [], agents: [], summary: summarize([]) };
  const hours = clampWindowHours(windowHours);
  const rows = await loadRows(hours);
  const feed = buildActivity(rows);
  return {
    available: true,
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    unavailableSources: rows.unavailable,
    ...feed,
  };
}

module.exports = { getActivity, buildActivity, runStatus, STATUSES, clampWindowHours, MISSING_TABLE_SQLSTATE };
