/**
 * Read adapter: agent_decisions (the message-lane decision ledger: SMS
 * suggest / auto modes, completion-comms guard, dedupe …) → canonical
 * runs. The row IS the decision, so the run is one step; the owner's
 * verdict is the verification.
 */

const db = require('../../../models/db');
const { canonicalRun, humanize, modelLabel, isMissingSchema } = require('./shape');

const SOURCE = 'agent_decisions';
const START = 'created_at';
const COLUMNS = [
  'id', 'workflow', 'agent_name', 'mode', 'status', 'entity_type', 'entity_id', 'customer_id', 'lead_id',
  'detected_intent', 'confidence', 'confidence_label', 'safety_flags', 'model', 'prompt_version',
  'human_verdict', 'reviewed_at', 'created_at', 'updated_at',
];

// Only the decision statuses with a lifecycle meaning; a workflow-specific
// status (match / conflict / …) is a terminal decision with no disposition.
const STATUS_MAP = Object.freeze({
  pending_review: { lifecycle: 'waiting_human', disposition: 'drafted' },
  scheduled: { lifecycle: 'waiting_external' },
  active: { lifecycle: 'running' },
  reviewed: { lifecycle: 'terminal', result: 'succeeded' },
  superseded: { lifecycle: 'terminal', result: 'canceled', disposition: 'no_action' },
  expired: { lifecycle: 'terminal', result: 'canceled', disposition: 'no_action' },
  ignored: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
  shadow: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
});

// Which switchboard lane made this decision: the message drafter's two
// modes are lanes; the rest are business workflows without a model lane.
const WORKFLOW_LANE = Object.freeze({ sms_suggest: 'sms_draft', sms_auto: 'sms_draft', sms_shadow_judge: 'sms_shadow_judge' });

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
  const map = STATUS_MAP[d.status] || { lifecycle: 'terminal', result: 'succeeded' };
  const verdict = VERDICT[d.human_verdict] || NO_VERDICT;
  const flags = flagNames(d.safety_flags);
  const workflow = d.workflow || d.agent_name;
  const confidence = d.confidence == null ? d.confidence_label : `confidence ${Math.round(Number(d.confidence) * 100)} %`;
  const decidedAt = d.reviewed_at || d.updated_at || d.created_at;
  const waiting = map.lifecycle === 'waiting_human';
  return canonicalRun({
    source: SOURCE,
    id: d.id,
    laneId: WORKFLOW_LANE[d.workflow] || null,
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

async function list({ from, before = null, limit = 200 } = {}) {
  try {
    const rows = await db('agent_decisions')
      .select(COLUMNS)
      .where((q) => {
        q.whereIn('status', ['pending_review', 'scheduled', 'active']);
        q.orWhere(START, '>=', from);
      })
      .modify((q) => { if (before) q.where(START, '<=', before); })
      .orderBy(START, 'desc')
      .limit(limit);
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

module.exports = { SOURCE, WORKFLOW_LANE, list, get, fromRow };
