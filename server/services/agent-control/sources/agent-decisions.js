/**
 * Read adapter: agent_decisions (the message-lane decision ledger: SMS
 * suggest / auto modes, completion-comms guard, dedupe …) → canonical
 * runs. The row IS the decision, so the run is one step; the owner's
 * verdict is the verification.
 */

const db = require('../../../models/db');
const { canonicalRun, humanize, modelLabel, keyset, notMirrored, isMissingSchema } = require('./shape');

const SOURCE = 'agent_decisions';
const START = () => db.raw("date_trunc('milliseconds', created_at)");
const ID = 'id';
const COLUMNS = [
  'id', 'workflow', 'agent_name', 'mode', 'status', 'entity_type', 'entity_id', 'customer_id', 'lead_id',
  'detected_intent', 'confidence', 'confidence_label', 'safety_flags', 'model', 'prompt_version',
  'human_verdict', 'reviewed_at', 'created_at', 'updated_at',
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
const VERDICT = Object.freeze({
  approved: { verification: 'passed', disposition: 'applied' },
  corrected: { verification: 'warning', disposition: 'applied' },
  rejected: { verification: 'failed', disposition: 'rejected' },
  overridden: { verification: 'overridden', disposition: null },
});
const TRIAGE_LINK = '/admin/agents?tab=triage';

function flagNames(flags) {
  if (!Array.isArray(flags)) return [];
  return flags.map((f) => (typeof f === 'string' ? f : f?.code || f?.name)).filter(Boolean);
}

function fromRow(d) {
  const map = STATUS_MAP[d.status] || UNKNOWN_STATUS;
  const lane = WORKFLOW_MAP[d.workflow] || NO_WORKFLOW;
  const verdict = VERDICT[d.human_verdict] || NO_VERDICT;
  const flags = flagNames(d.safety_flags);
  const workflow = d.workflow || d.agent_name;
  const confidence = d.confidence == null ? d.confidence_label : `confidence ${Math.round(Number(d.confidence) * 100)} %`;
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
    verification: verdict.verification,
    disposition: verdict.disposition ?? map.disposition ?? null,
    createdAt: d.created_at,
    startedAt: d.created_at,
    finishedAt: map.lifecycle === 'terminal' ? decidedAt : null,
    lastProgressAt: decidedAt,
    steps: [
      { key: 'decide', label: 'Decide', status: 'done', detail: modelLabel(d), ms: null, toolName: null },
      ...(flags.length ? [{ key: 'safety', label: 'Safety flags', status: 'blocked', detail: flags.slice(0, 4).join(' · '), ms: null, toolName: null }] : []),
      { key: 'review', label: 'Owner review', status: waiting ? 'running' : verdict === NO_VERDICT ? 'skipped' : 'done', detail: humanize(d.human_verdict) || null, ms: null, toolName: null },
    ],
    link: TRIAGE_LINK,
    entity: d.entity_type ? { type: d.entity_type, id: d.entity_id } : null,
  });
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(db('agent_decisions')
      .select(COLUMNS)
      .where((q) => {
        q.whereIn('status', LIVE_STATUSES);
        q.orWhere(START(), '>=', from);
      }), { source: SOURCE, idColumn: 'agent_decisions.id' }), { start: START(), id: ID, cursor, limit });
    return { runs: rows.map(fromRow), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(id) {
  try {
    const row = await db('agent_decisions').select(COLUMNS).where({ id }).first();
    return row ? { run: fromRow(row) } : null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, WORKFLOW_MAP, STATUS_MAP, LIVE_STATUSES, list, get, fromRow };
