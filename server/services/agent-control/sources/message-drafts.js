/**
 * Read adapter: message_drafts (SMS drafter, sms_draft lane) → canonical
 * runs. A draft is a run whose last step is the owner's approval.
 */

const db = require('../../../models/db');
const { canonicalRun, humanize, modelLabel, keyset, notMirrored, isMissingSchema } = require('./shape');

const SOURCE = 'message_drafts';
const LANE = 'sms_draft';
const START = () => db.raw("date_trunc('milliseconds', d.created_at)");
const ID = 'd.id';
const COLUMNS = () => [
  'd.id', 'd.intent', 'd.drafter', 'd.draft_ms', 'd.created_at', 'd.approved_at', 'd.sent_at', 'd.status',
  'd.campaign_type', 'd.purpose', 'd.customer_id', 'd.sms_log_id', 'd.model', 'd.prompt_version',
  db.raw("NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name"),
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

function fromRow(d) {
  const map = STATUS_MAP[d.status] || UNKNOWN_STATUS;
  const kind = d.campaign_type || d.purpose ? 'proactive' : 'reply';
  const draftMs = d.draft_ms == null ? null : Number(d.draft_ms);
  const terminalAt = map.lifecycle === 'terminal' ? d.created_at : null;
  const approval = APPROVAL[map.lifecycle] || APPROVAL[map.disposition] || 'done';
  const lane = d.campaign_type ? `${humanize(d.campaign_type)} campaign` : humanize(d.purpose || d.intent);
  return canonicalRun({
    source: SOURCE,
    id: d.id,
    laneId: LANE,
    title: TITLE[kind][d.customer_name ? 'named' : 'anon'](d.customer_name),
    subtitle: [lane, d.drafter ? `drafter ${d.drafter}` : null].filter(Boolean).join(' · ') || null,
    ...map,
    createdAt: d.created_at,
    startedAt: d.created_at,
    finishedAt: d.sent_at || d.approved_at || terminalAt,
    lastProgressAt: d.approved_at || d.created_at,
    durationMs: draftMs,
    steps: [
      { key: 'inbound', label: kind === 'proactive' ? 'Trigger' : 'Inbound text', status: 'done', detail: null, ms: null, toolName: null },
      { key: 'draft', label: 'Draft reply', status: 'done', detail: modelLabel(d), ms: draftMs, toolName: null },
      { key: 'approve', label: 'Owner approval', status: approval, detail: approval === 'running' ? (d.status === 'suggested' ? 'Suggested in the thread' : 'Waiting in Pending Drafts') : humanize(d.status), ms: null, toolName: null },
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
        q.whereIn('d.status', LIVE_STATUSES);
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
