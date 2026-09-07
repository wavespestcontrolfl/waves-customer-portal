/**
 * Read adapter: message_drafts (SMS drafter, sms_draft lane) → canonical
 * runs. A draft is a run whose last step is the owner's approval.
 */

const db = require('../../../models/db');
const { pagedAtColumn, canonicalRun, humanize, modelLabel, keyset, notMirrored, isMissingSchema } = require('./shape');
const decisions = require('./agent-decisions');

const SOURCE = 'message_drafts';
const LANE = 'sms_draft';
const ID = 'd.id';
// A suggested draft's owner decision lives on its agent_decisions row
// (sms-suggest-mode: entity_type message_draft, entity_id = the draft):
// sending / editing / ignoring it resolves THAT row and deliberately
// leaves the draft 'suggested' for the nightly judge — so the newest
// linked decision says whether the owner still owes anything (Codex r3).
const DECISION = "FROM agent_decisions ad WHERE ad.entity_type = 'message_draft' AND ad.entity_id = d.id ORDER BY ad.created_at DESC LIMIT 1";
const DECISION_STATUS = `(SELECT ad.status ${DECISION})`;
// The decision's active span (agent-decisions.activeFrom: the scheduling
// transition / the queued send's due time) — a suggested draft whose owner
// already scheduled it waits on the SEND, from that span, not on the owner.
const DECISION_ACTIVE = `(SELECT ${decisions.activeFrom('ad')} ${DECISION})`;
// every live decision state but the owner's own review — projected onto the draft
const PROJECTED_LIVE = decisions.LIVE_STATUSES.filter((s) => s !== 'pending_review');
// The window is judged on the run's startedAt in fromRow: the decision's
// span while it is projected, else the draft's creation. The page key is
// the creation alone (immutable — the span moves when the owner schedules
// the send and back when it lands; Codex r14).
const PAGED = 'd.created_at';
const START = () => db.raw(`date_trunc('milliseconds', COALESCE(CASE WHEN d.status = 'suggested' AND ${DECISION_STATUS} IN (${PROJECTED_LIVE.map(() => '?').join(', ')}) THEN ${DECISION_ACTIVE} END, d.created_at))`, PROJECTED_LIVE);
const COLUMNS = () => [
  pagedAtColumn(db, 'd.created_at'), // the page stamp (see PAGED)
  'd.id', 'd.intent', 'd.drafter', 'd.draft_ms', 'd.created_at', 'd.approved_at', 'd.sent_at', 'd.status',
  'd.campaign_type', 'd.purpose', 'd.customer_id', 'd.sms_log_id', 'd.model', 'd.prompt_version',
  db.raw("NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name"),
  db.raw(`${DECISION_STATUS} AS decision_status`),
  db.raw(`(SELECT ad.human_verdict ${DECISION}) AS decision_verdict`),
  db.raw(`(SELECT COALESCE(ad.reviewed_at, ad.updated_at) ${DECISION}) AS decision_at`),
  db.raw(`${DECISION_ACTIVE} AS decision_active_from`),
];

// message_drafts.status → (lifecycle, result, disposition, verification).
// The vocabulary is the table's CHECK constraint (message_drafts_status_check,
// latest definition in models/migrations — drift-tested):
//   pending    parked in Pending Drafts for the owner
//   suggested  published into the thread as a suggestion (sms-suggest-mode):
//              the owner sends, edits or ignores it there — still their call
//   approved / revised / sent   the owner used it (revised = edited first)
//   auto_sent  the executor sent it with no human (sms-auto-send)
//   rejected   the owner declined it
//   shadow     a shadow-mode draft never shown to anyone
const STATUS_MAP = Object.freeze({
  pending: { lifecycle: 'waiting_human', disposition: 'drafted' },
  suggested: { lifecycle: 'waiting_human', disposition: 'drafted' },
  approved: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied', verification: 'passed' },
  revised: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied', verification: 'warning' },
  sent: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' },
  auto_sent: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' },
  rejected: { lifecycle: 'terminal', result: 'succeeded', disposition: 'rejected', verification: 'failed' },
  shadow: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
});
// A status this map does not know is NOT a success: terminal with no
// result, which the index buckets as failed / attention so it surfaces.
const UNKNOWN_STATUS = Object.freeze({ lifecycle: 'terminal', result: null });
const LIVE_STATUSES = Object.freeze(Object.entries(STATUS_MAP).filter(([, m]) => m.lifecycle !== 'terminal').map(([k]) => k));

// Title by (proactive, has a customer name); approval step by outcome.
const TITLE = Object.freeze({
  reply: Object.freeze({ named: (n) => `Reply draft for ${n}`, anon: () => 'Reply draft for inbound text' }),
  proactive: Object.freeze({ named: (n) => `Draft for ${n}`, anon: () => 'Proactive draft' }),
});
const APPROVAL = Object.freeze({ waiting_human: 'running', waiting_external: 'running', running: 'running', queued: 'running', rejected: 'blocked' });
const DRAFTS_LINK = '/admin/agents?tab=drafts';

// A suggested draft's linked decision, projected through the decisions
// adapter's own maps (one vocabulary): the owner's verdict closes the run;
// a scheduled / sending decision makes it wait on the send (from the
// decision's span); null while the owner still owes the review (or the
// draft has no decision row). A SHADOW draft consults only a terminal
// linked decision: revertDraftsToShadow (sms-suggest-mode) sets an
// ignored / expired / superseded suggestion back to 'shadow' after writing
// that decision, so the outcome lives on the decision row (Codex r13).
function decisionState(d) {
  if (!d.decision_status || d.decision_status === 'pending_review') return null;
  const status = decisions.STATUS_MAP[d.decision_status] || { lifecycle: 'terminal', result: null };
  const consulted = d.status === 'suggested' || (d.status === 'shadow' && status.lifecycle === 'terminal');
  if (!consulted) return null;
  const verdict = decisions.VERDICT[d.decision_verdict] || {};
  return {
    ...status,
    verification: verdict.verification,
    disposition: verdict.disposition ?? status.disposition ?? null,
    at: d.decision_at,
    startedAt: status.lifecycle === 'terminal' ? d.created_at : d.decision_active_from || d.decision_at,
    label: humanize(d.decision_status),
  };
}

// When the run finished and what the approval step reads, by outcome: the
// owner's stamp on the draft, else the closing decision's, else the row.
function outcomeOf(d, decided, map) {
  const at = decided ? decided.at : null;
  return {
    finishedAt: d.sent_at || d.approved_at || (map.lifecycle === 'terminal' ? at || d.created_at : null),
    lastProgressAt: d.approved_at || at || d.created_at,
    label: decided ? decided.label : humanize(d.status),
  };
}

function approvalDetail(d, decided, approval, label) {
  if (approval !== 'running') return label;
  if (decided) return label; // scheduled / sending — the owner already acted
  return d.status === 'suggested' ? 'Suggested in the thread' : 'Waiting in Pending Drafts';
}

function fromRow(d) {
  const decided = decisionState(d);
  const map = decided || STATUS_MAP[d.status] || UNKNOWN_STATUS;
  const kind = d.campaign_type || d.purpose ? 'proactive' : 'reply';
  const draftMs = d.draft_ms == null ? null : Number(d.draft_ms);
  const approval = APPROVAL[map.lifecycle] || APPROVAL[map.disposition] || 'done';
  const lane = d.campaign_type ? `${humanize(d.campaign_type)} campaign` : humanize(d.purpose || d.intent);
  const outcome = outcomeOf(d, decided, map);
  return canonicalRun({
    source: SOURCE,
    id: d.id,
    laneId: LANE,
    title: TITLE[kind][d.customer_name ? 'named' : 'anon'](d.customer_name),
    subtitle: [lane, d.drafter ? `drafter ${d.drafter}` : null].filter(Boolean).join(' · ') || null,
    ...map,
    createdAt: d.created_at,
    pagedAt: d.paged_at,
    startedAt: decided ? decided.startedAt : d.created_at,
    finishedAt: outcome.finishedAt,
    lastProgressAt: outcome.lastProgressAt,
    // the drafting time — unless a live decision replaced the span (then the span's own)
    durationMs: decided && decided.lifecycle !== 'terminal' ? null : draftMs,
    steps: [
      { key: 'inbound', label: kind === 'proactive' ? 'Trigger' : 'Inbound text', status: 'done', detail: null, ms: null, toolName: null },
      { key: 'draft', label: 'Draft reply', status: 'done', detail: modelLabel(d), ms: draftMs, toolName: null },
      { key: 'approve', label: 'Owner approval', status: approval, detail: approvalDetail(d, decided, approval, outcome.label), ms: null, toolName: null },
    ],
    link: DRAFTS_LINK,
    entity: { type: 'message_draft', id: d.id },
  });
}

function baseQuery() {
  return db('message_drafts as d').leftJoin('customers as c', 'c.id', 'd.customer_id').select(COLUMNS());
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(baseQuery()
      .where((q) => {
        // live: pending, or suggested with no decision yet / a decision still open
        q.where('d.status', 'pending');
        q.orWhere((s) => s.where('d.status', 'suggested').whereIn(db.raw(`COALESCE(${DECISION_STATUS}, 'pending_review')`), decisions.LIVE_STATUSES));
        q.orWhere(START(), '>=', from);
      }), { source: SOURCE, idColumn: 'd.id' }), { start: PAGED, id: ID, cursor, limit });
    return { runs: rows.map(fromRow), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(id) {
  try {
    const row = await baseQuery().where('d.id', id).first();
    return row ? { run: fromRow(row) } : null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, LANE, STATUS_MAP, LIVE_STATUSES, list, get, fromRow };
