/**
 * Read adapter: message_drafts (SMS drafter, sms_draft lane) → canonical
 * runs. A draft is a run whose last step is the owner's approval.
 */

const db = require('../../../models/db');
const { canonicalRun, humanize, modelLabel, keyset, notMirrored, isMissingSchema } = require('./shape');
const decisions = require('./agent-decisions');

const SOURCE = 'message_drafts';
const LANE = 'sms_draft';
const START = () => db.raw("date_trunc('milliseconds', d.created_at)");
const ID = 'd.id';
// A suggested draft's owner decision lives on its agent_decisions row
// (sms-suggest-mode: entity_type message_draft, entity_id = the draft):
// sending / editing / ignoring it resolves THAT row and deliberately
// leaves the draft 'suggested' for the nightly judge — so the newest
// linked decision says whether the owner still owes anything (Codex r3).
const DECISION = "FROM agent_decisions ad WHERE ad.entity_type = 'message_draft' AND ad.entity_id = d.id ORDER BY ad.created_at DESC LIMIT 1";
const DECISION_STATUS = `(SELECT ad.status ${DECISION})`;
const COLUMNS = () => [
  'd.id', 'd.intent', 'd.drafter', 'd.draft_ms', 'd.created_at', 'd.approved_at', 'd.sent_at', 'd.status',
  'd.campaign_type', 'd.purpose', 'd.customer_id', 'd.sms_log_id', 'd.model', 'd.prompt_version',
  db.raw("NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name"),
  db.raw(`${DECISION_STATUS} AS decision_status`),
  db.raw(`(SELECT ad.human_verdict ${DECISION}) AS decision_verdict`),
  db.raw(`(SELECT COALESCE(ad.reviewed_at, ad.updated_at) ${DECISION}) AS decision_at`),
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
const APPROVAL = Object.freeze({ waiting_human: 'running', rejected: 'blocked' });
const DRAFTS_LINK = '/admin/agents?tab=drafts';

// The decision that closed a suggested draft: its status / verdict through
// the decisions adapter's own maps (one vocabulary), else null while it
// is still live (or the draft has no decision row).
function closingDecision(d) {
  if (d.status !== 'suggested' || !d.decision_status || decisions.LIVE_STATUSES.includes(d.decision_status)) return null;
  const status = decisions.STATUS_MAP[d.decision_status] || { lifecycle: 'terminal', result: null };
  const verdict = decisions.VERDICT[d.decision_verdict] || {};
  return { ...status, verification: verdict.verification, disposition: verdict.disposition ?? status.disposition ?? null, at: d.decision_at, label: humanize(d.decision_status) };
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

function approvalDetail(d, approval, label) {
  if (approval !== 'running') return label;
  return d.status === 'suggested' ? 'Suggested in the thread' : 'Waiting in Pending Drafts';
}

function fromRow(d) {
  const decided = closingDecision(d);
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
    startedAt: d.created_at,
    finishedAt: outcome.finishedAt,
    lastProgressAt: outcome.lastProgressAt,
    durationMs: draftMs,
    steps: [
      { key: 'inbound', label: kind === 'proactive' ? 'Trigger' : 'Inbound text', status: 'done', detail: null, ms: null, toolName: null },
      { key: 'draft', label: 'Draft reply', status: 'done', detail: modelLabel(d), ms: draftMs, toolName: null },
      { key: 'approve', label: 'Owner approval', status: approval, detail: approvalDetail(d, approval, outcome.label), ms: null, toolName: null },
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
      }), { source: SOURCE, idColumn: 'd.id' }), { start: START(), id: ID, cursor, limit });
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
