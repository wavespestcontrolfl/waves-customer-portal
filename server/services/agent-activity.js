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
// gateEnvValue at CALL time (the techTips idiom): the `gates` object in
// feature-gates.js is evaluated once at boot, so isEnabled() would freeze
// the flag until a redeploy — a kill switch has to work on the next request.
const { gateEnvValue } = require('../config/feature-gates');

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
  // Runner error shape: { ok: false, error: 'uniqueness_gate_unavailable' }
  if (typeof result.error === 'string' && result.error) return humanize(result.error);
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
  // publishing_named_competitor: the approved draft is being published now.
  if (outcome.startsWith('publishing')) return 'running';
  // deferred_publish_cap / deferred_gate_retry: parked for a later tick.
  if (outcome.startsWith('deferred')) return 'skipped';
  if (outcome === 'skipped_gate_fail') return 'blocked';
  if (outcome.startsWith('skipped')) return 'skipped';
  if (outcome.startsWith('failed')) return 'failed';
  return 'completed';
}

const TERMINAL_APPROVAL = { approved: 'completed', rejected: 'skipped', superseded: 'skipped', failed: 'failed' };

function contentRunItem(run, awaitingReplyByRun, decidedByRun = new Map()) {
  // Titles come from the two projected JSON paths (draft_title /
  // draft_frontmatter_title) so the query never pulls whole article bodies;
  // a raw draft_payload is still honoured for callers that pass one.
  const draft = run.draft_payload ? parseJson(run.draft_payload, {}) || {} : {};
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
  // A pending-review outcome never changes once decided (decideReviewItem
  // stamps the run, not its outcome): a terminal emailed approval or the
  // trust-build approval stamp means "decided". reviewer_notes is NOT a
  // signal — the runner seeds it with gate summaries when the run parks.
  // An awaiting row whose email never left (email_sent_at null, last_error
  // set on the SMTP failure, status kept for retry) is a delivery problem,
  // not an owner action.
  const decided = decidedByRun.get(String(run.id));
  let decidedStatus = null;
  let decidedDetail = null;
  if (!awaiting && status === 'awaiting_review') {
    if (decided) {
      decidedStatus = TERMINAL_APPROVAL[decided.status] || null;
      decidedDetail = decidedStatus ? `${humanize(decided.status)} by email reply` : null;
    } else if (run.trust_build_approved_at) {
      decidedStatus = 'completed';
      decidedDetail = 'Approved in review';
    }
  }
  const awaitingUnsent = awaiting && !awaiting.email_sent_at;
  const title =
    run.draft_title ||
    run.draft_frontmatter_title ||
    draft.title ||
    draft.frontmatter?.title ||
    [humanize(run.action_type), humanize(run.page_type)].filter(Boolean).join(' · ') ||
    'Content run';
  // An open approval is the owner's action; it outranks the run's own
  // skip_reason (every emailed approval sits on a run that was parked).
  const detail =
    (awaitingUnsent
      ? `Approval email not delivered yet (${awaiting.token})${awaiting.last_error ? `: ${awaiting.last_error}` : ''}`
      : awaiting
        ? `Awaiting emailed reply (${awaiting.token})`
        : null) ||
    decidedDetail ||
    run.failure_message ||
    (run.skip_reason ? humanize(run.skip_reason) : null) ||
    (run.published_url ? run.published_url : null);
  return {
    id: `run:${run.id}`,
    kind: 'content_run',
    agent: CONTENT_AGENT,
    title,
    subtitle: [humanize(run.action_type), humanize(run.page_type), run.shadow_mode ? 'shadow' : null]
      .filter(Boolean)
      .join(' · '),
    status: awaitingUnsent
      ? 'blocked'
      : awaiting && status !== 'failed'
        ? 'awaiting_review'
        : decidedStatus || status,
    // An open approval is the current event: date the row by when it was
    // raised, not by the (possibly much older) run it belongs to.
    startedAt: iso(awaiting?.created_at || run.claimed_at || run.created_at),
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
      ? `${draft.campaign_type || draft.purpose ? 'Draft' : 'Reply draft'} for ${draft.customer_name}`
      : draft.campaign_type || draft.purpose
        ? 'Proactive draft'
        : 'Reply draft for inbound text',
    // Proactive lanes (campaign / purpose) describe the row better than the
    // inbound intent classifier, which only applies to reply drafts.
    subtitle: [
      draft.campaign_type
        ? `${humanize(draft.campaign_type)} campaign`
        : draft.purpose
          ? humanize(draft.purpose)
          : humanize(draft.intent),
      draft.drafter ? `drafter ${draft.drafter}` : null,
    ]
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
    // recordJobStart only rewrites last_started_at/last_status, so while a
    // job is running the finish/duration columns belong to its previous run.
    finishedAt: status === 'running' ? null : iso(job.last_finished_at),
    durationMs: status === 'running' || job.last_duration_ms == null ? null : Number(job.last_duration_ms),
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
  // Newest approval per run wins in each class (a run can be re-requested:
  // an older approved/failed row must not mask the current awaiting one and
  // vice versa) — compare created_at rather than trusting input order.
  const awaitingReplyByRun = new Map();
  const decidedByRun = new Map();
  const keepNewest = (map, key, row) => {
    const current = map.get(key);
    if (!current || String(row.created_at || '') > String(current.created_at || '')) map.set(key, row);
  };
  for (const a of approvals) {
    if (!a.run_id) continue;
    if (a.status === 'awaiting_reply') keepNewest(awaitingReplyByRun, String(a.run_id), a);
    else if (TERMINAL_APPROVAL[a.status]) keepNewest(decidedByRun, String(a.run_id), a);
  }
  const exceptionJobs = jobs.filter(jobIsException);
  const items = []
    .concat(runs.map((run) => contentRunItem(run, awaitingReplyByRun, decidedByRun)))
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
  const runQuery = () =>
    db('autonomous_runs')
        .select(
          'id', 'action_type', 'page_type', 'shadow_mode', 'outcome', 'skip_reason', 'failure_message',
          db.raw("draft_payload->>'title' AS draft_title"),
          db.raw("draft_payload->'frontmatter'->>'title' AS draft_frontmatter_title"),
          'published_url', 'claimed_at', 'completed_at', 'created_at', 'total_ms',
          'trust_build_approved_at',
          'claim_ms', 'brief_ms', 'agent_ms', 'uniqueness_gate_ms', 'quality_gate_ms', 'seo_completion_gate_ms',
          'publish_ms', 'index_submit_ms', 'link_plan_ms',
          'uniqueness_gate_result', 'quality_gate_result', 'seo_completion_gate_result',
        );
  const [runs, drafts, jobs] = await Promise.all([
    safe('autonomous_runs', () =>
      runQuery()
        .where('created_at', '>=', since)
        .orderBy('created_at', 'desc')
        .limit(MAX_ITEMS)),
    safe('message_drafts', () =>
      db('message_drafts as d')
        .leftJoin('customers as c', 'c.id', 'd.customer_id')
        .select(
          'd.id', 'd.intent', 'd.drafter', 'd.draft_ms', 'd.created_at', 'd.inbound_message', 'd.draft_response',
          'd.campaign_type', 'd.purpose',
          db.raw("NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name"),
        )
        .where('d.status', 'pending')
        .where('d.created_at', '>=', since)
        .orderBy('d.created_at', 'desc')
        .limit(MAX_ITEMS)),
    safe('job_health', () =>
      db('job_health')
        .select('job_name', 'last_started_at', 'last_finished_at', 'last_status', 'last_error', 'last_duration_ms', 'consecutive_failures')
        // A job still marked running (a process that died after
        // recordJobStart) must stay visible however old its start is.
        .where((q) => q.where('last_started_at', '>=', since).orWhere('last_status', 'running'))
        .orderBy('last_started_at', 'desc')
        .limit(MAX_ITEMS)),
  ]);
  // Approvals (any status — a terminal one tells us a pending-review run
  // was decided): every row on a loaded run, PLUS any still awaiting that
  // was raised inside the window for an older run — the owner's open
  // decision is what matters, not the run's age. Runs for those stragglers
  // are loaded by id so they render like the rest.
  const runIds = runs.map((r) => r.id);
  const approvals = await safe('content_email_approvals', () =>
    db('content_email_approvals')
      .select('run_id', 'token', 'status', 'kind', 'created_at', 'email_sent_at', 'last_error')
      .where((q) => {
        q.where({ status: 'awaiting_reply' }).andWhere('created_at', '>=', since);
        if (runIds.length) q.orWhereIn('run_id', runIds);
      })
      .orderBy('created_at', 'desc')
      .limit(MAX_ITEMS * 2));
  const loaded = new Set(runIds.map(String));
  const missingRunIds = approvals
    .filter((a) => a.status === 'awaiting_reply')
    .map((a) => a.run_id)
    .filter((id) => id && !loaded.has(String(id)));
  const stragglers = missingRunIds.length
    ? await safe('autonomous_runs', () => runQuery().whereIn('id', missingRunIds))
    : [];
  return { runs: runs.concat(stragglers), approvals, drafts, jobs, unavailable };
}

async function getActivity({ windowHours } = {}) {
  if (gateEnvValue('GATE_AGENT_ACTIVITY') !== true) return { available: false, items: [], agents: [], summary: summarize([]) };
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
