/**
 * Read adapter: agent_decisions (the message-lane decision ledger: SMS
 * suggest / auto modes, completion-comms guard, dedupe …) → canonical
 * runs. The row IS the decision, so the run is one step; the owner's
 * verdict is the verification.
 */

const db = require('../../../models/db');
const { pagedAtColumn, canonicalRun, humanize, modelLabel, keyset, notMirrored, isMissingSchema } = require('./shape');

const SOURCE = 'agent_decisions';
// A scheduled send (admin-communications queues an sms_log row with
// status 'scheduled' and metadata.agent_decision_id) is waiting normally
// until it is due: the decision's active span starts at the scheduling
// transition (updated_at — markSuggestionScheduled writes it) or at the
// send's scheduled_for when that is later, never at the original decision
// (Codex r3). The dispatcher claims the row to 'sending' while the
// decision is still 'scheduled' (scheduler.claimDueScheduledSms), so the
// claimed row still anchors the span (Codex r4). Sort / page key = that
// start, so the cursor and rows agree.
// `t` = the agent_decisions alias (message-drafts projects the same span
// onto a suggested draft through its linked decision).
function activeFrom(t) {
  // the send links its decision as agent_decision_id, and every sibling it
  // parked (parkThreadSuggestions → 'scheduled') in parked_decision_ids —
  // both are live links (sms-suggest-mode's orphan recovery; Codex r8)
  const scheduledSend = `(SELECT s.scheduled_for FROM sms_log s WHERE s.status IN ('scheduled', 'sending') AND ((s.metadata::jsonb ->> 'agent_decision_id') = ${t}.id::text OR jsonb_exists(COALESCE(s.metadata::jsonb -> 'parked_decision_ids', '[]'::jsonb), ${t}.id::text)) ORDER BY s.scheduled_for DESC LIMIT 1)`;
  return `CASE WHEN ${t}.status = 'scheduled' THEN GREATEST(${t}.updated_at, COALESCE(${scheduledSend}, ${t}.updated_at)) ELSE ${t}.created_at END`;
}
const ACTIVE_FROM = activeFrom('agent_decisions');
const START = () => db.raw(`date_trunc('milliseconds', ${ACTIVE_FROM})`);
// the page key: the row's raw creation, immutable (ACTIVE_FROM moves when
// the decision is scheduled and back when it resolves; Codex r14); the
// stamp beside it (pagedAtColumn) keeps the compare on the indexed column
const PAGED = 'created_at';
const ID = 'id';
const COLUMNS = () => [
  pagedAtColumn(db, 'created_at'), // the page stamp (see PAGED)
  'id', 'workflow', 'agent_name', 'mode', 'status', 'entity_type', 'entity_id', 'customer_id', 'lead_id',
  'detected_intent', 'confidence', 'confidence_label', 'safety_flags', 'model', 'prompt_version',
  'human_verdict', 'reviewed_at', 'created_at', 'updated_at',
  // the producers' one free-text field: sms-auto-send's failClaim / orphan
  // recovery write WHY a send did not go out here (Codex r4)
  'correction_note',
  db.raw(`${ACTIVE_FROM} AS active_from`),
];

// agent_decisions.status → lifecycle. The vocabulary is the producers' own
// (sms-suggest-mode, sms-auto-send, admin-communications, the reschedule
// flagger / watcher, contact-correction, reply-training-capture;
// tests/agent-control-run-index drift-checks the constants they export).
const STATUS_MAP = Object.freeze({
  pending_review: { lifecycle: 'waiting_human', disposition: 'drafted' },
  pending: { lifecycle: 'queued' },
  scheduled: { lifecycle: 'waiting_external' }, // send scheduled (admin-communications / suggest mode)
  sending: { lifecycle: 'running' }, // sms-auto-send CLAIM_STATUS
  initiated: { lifecycle: 'running' },
  active: { lifecycle: 'running' },
  auto_sent: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' }, // sms-auto-send SENT_STATUS
  auto_send_failed: { lifecycle: 'terminal', result: 'errored', failureClass: 'provider' }, // sms-auto-send FAILED_STATUS
  failed: { lifecycle: 'terminal', result: 'errored', failureClass: 'provider' },
  auto_applied: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' }, // contact-correction
  auto_resolved: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' }, // reschedule-intent-watcher
  reviewed: { lifecycle: 'terminal', result: 'succeeded' },
  // the owner's verdict is persisted as the row status too (admin-agent-
  // decisions' review route, the SMS composer send in admin-communications,
  // sms-suggest-mode's scheduled send): accepted / corrected = the draft
  // went out (as written / edited), dismissed = the owner refused it
  accepted: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' },
  corrected: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' },
  dismissed: { lifecycle: 'terminal', result: 'succeeded', disposition: 'rejected' },
  superseded: { lifecycle: 'terminal', result: 'canceled', disposition: 'no_action' },
  expired: { lifecycle: 'terminal', result: 'canceled', disposition: 'no_action' },
  ignored: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
  shadow: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
});
// A status this map does not know is NOT a success: terminal with no
// result, which the index buckets as failed / attention so it surfaces.
const UNKNOWN_STATUS = Object.freeze({ lifecycle: 'terminal', result: null });
// The statuses the index treats as live (derived, so it agrees with the map).
const LIVE_STATUSES = Object.freeze(Object.entries(STATUS_MAP).filter(([, m]) => m.lifecycle !== 'terminal').map(([k]) => k));

// Which switchboard lane made this decision, and its product area — keyed
// by the workflow id each producer writes (its WORKFLOW constant). A
// deterministic workflow (comms_guards) has no model lane but still lives
// in the SMS area.
const WORKFLOW_MAP = Object.freeze({
  sms_house_voice_suggest: { laneId: 'sms_suggest', area: 'sms' }, // sms-suggest-mode SUGGEST_WORKFLOW
  sms_house_voice_auto_send: { laneId: 'sms_draft', area: 'sms' }, // sms-auto-send AUTOSEND_WORKFLOW (sends the drafter's draft)
  comms_guards: { laneId: null, area: 'sms' }, // reschedule-intent-flagger / completion-comms-guard
  contact_correction: { laneId: 'contact_correction', area: null }, // contact-correction
  estimate_conversion_sms: { laneId: 'estimate_followup', area: null }, // estimate-conversion-agent
  service_scheduling_sms: { laneId: 'estimate_followup', area: null },
  customer_sms_triage: { laneId: 'estimate_followup', area: null },
});
const NO_WORKFLOW = Object.freeze({ laneId: null, area: null });

const NO_VERDICT = Object.freeze({ verification: 'unjudged', disposition: null });
// human_verdict → verification: the values the producers write (drift-
// tested) — accepted / corrected / dismissed from the review paths,
// ignored when staff replied their own way and the suggestion was set aside
const VERDICT = Object.freeze({
  accepted: { verification: 'passed', disposition: 'applied' },
  corrected: { verification: 'warning', disposition: 'applied' },
  dismissed: { verification: 'failed', disposition: 'rejected' },
  ignored: { verification: 'overridden', disposition: 'no_action' },
});
// The hub's Triage & Decisions tab (AgentsHubPage TABS.DECISIONS — an
// unknown tab key falls back to Overview; Codex r13). A house-voice
// suggestion is actionable only in its comms thread — the tab keeps its
// pending rows out of the queue and the review route rejects them
// (admin-agent-decisions): it links to the thread, the deep link the
// ops digest and alerts already use.
const DECISIONS_LINK = '/admin/agents?tab=decisions';
const SUGGEST_WORKFLOW = 'sms_house_voice_suggest';
function linkFor(d) {
  if (d.workflow !== SUGGEST_WORKFLOW) return DECISIONS_LINK;
  return d.customer_id ? `/admin/communications?thread=${d.customer_id}` : '/admin/communications';
}

function flagNames(flags) {
  if (!Array.isArray(flags)) return [];
  return flags.map((f) => (typeof f === 'string' ? f : f?.code || f?.name)).filter(Boolean);
}

// An errored decision's cause: the status is the code, the producer's note
// (sms-auto-send failClaim / orphan recovery) the message.
const NO_FAILURE = Object.freeze({ errorCode: null, errorMessage: null, detail: null });
function failureOf(d, map) {
  return map.result === 'errored' ? { errorCode: d.status, errorMessage: d.correction_note, detail: d.correction_note } : NO_FAILURE;
}

function confidenceLabel(d) {
  return d.confidence == null ? d.confidence_label : `confidence ${Math.round(Number(d.confidence) * 100)} %`;
}

function fromRow(d) {
  const map = STATUS_MAP[d.status] || UNKNOWN_STATUS;
  const lane = WORKFLOW_MAP[d.workflow] || NO_WORKFLOW;
  const verdict = VERDICT[d.human_verdict] || NO_VERDICT;
  const flags = flagNames(d.safety_flags);
  const workflow = d.workflow || d.agent_name;
  const confidence = confidenceLabel(d);
  const decidedAt = d.reviewed_at || d.updated_at || d.created_at;
  const waiting = map.lifecycle === 'waiting_human';
  return canonicalRun({
    source: SOURCE,
    id: d.id,
    laneId: lane.laneId,
    area: lane.area,
    workflowId: workflow || 'decision',
    title: [humanize(workflow), humanize(d.detected_intent)].filter(Boolean).join(' · ') || 'Decision',
    subtitle: [d.mode ? `${d.mode} mode` : null, confidence].filter(Boolean).join(' · ') || null,
    ...map,
    ...failureOf(d, map),
    verification: verdict.verification,
    disposition: verdict.disposition ?? map.disposition ?? null,
    createdAt: d.created_at,
    pagedAt: d.paged_at,
    startedAt: d.active_from || d.created_at,
    finishedAt: map.lifecycle === 'terminal' ? decidedAt : null,
    lastProgressAt: decidedAt,
    steps: [
      { key: 'decide', label: 'Decide', status: 'done', detail: modelLabel(d), ms: null, toolName: null },
      ...(flags.length ? [{ key: 'safety', label: 'Safety flags', status: 'blocked', detail: flags.slice(0, 4).join(' · '), ms: null, toolName: null }] : []),
      { key: 'review', label: 'Owner review', status: waiting ? 'running' : verdict === NO_VERDICT ? 'skipped' : 'done', detail: humanize(d.human_verdict) || null, ms: null, toolName: null },
    ],
    link: linkFor(d),
    entity: d.entity_type ? { type: d.entity_type, id: d.entity_id } : null,
  });
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(db('agent_decisions')
      .select(COLUMNS())
      .where((q) => {
        q.whereIn('status', LIVE_STATUSES);
        q.orWhere(START(), '>=', from);
      }), { source: SOURCE, idColumn: 'agent_decisions.id' }), { start: PAGED, id: ID, cursor, limit });
    return { runs: rows.map(fromRow), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(id) {
  try {
    const row = await db('agent_decisions').select(COLUMNS()).where({ id }).first();
    return row ? { run: fromRow(row) } : null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, WORKFLOW_MAP, STATUS_MAP, VERDICT, LIVE_STATUSES, activeFrom, list, get, fromRow };
