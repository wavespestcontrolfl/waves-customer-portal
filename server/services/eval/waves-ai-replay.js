/**
 * Waves AI replay — Phase 0 of the portal Waves AI scope (owner 2026-11-05: "test this in terminal from
 * existing text messages to see how it would answer").
 *
 * How the SMS house-voice agent answered real customer texts, beside what a person sent and the nightly
 * judge's verdict (shadow_draft_judgments). It reads stored drafts and judgments only: no model call, no
 * send. Pure functions; the database read and file write live in ops/agents/waves-ai-replay.js.
 *
 * The numbers that decide whether Waves AI answers in the portal:
 *   - unsafe rate: the judge's draft_unsafe verdict (an invented fact, a price quote or an unsafe
 *     commitment) over graded drafts, i.e. how often its facts disagree with what the office would send;
 *   - could_send (judge j2): could the person who replied have sent the AI draft instead;
 *   - the links and actions it asked for (intended_actions) — what it would have sent;
 *   - restricted requests (cancel a plan, refund, charge a card): the portal agent must hand these to the
 *     office, so the report counts how many such texts the draft escalated.
 */
const { redactText } = require('../agent-decision-training');
const { redact: redactPii } = require('../content/pii-redactor');

// The voice corpus's two-pass redaction (sms-voice-corpus-miner redactCorpusText): the customer's own
// names first, then the generic PII pass for names the record does not know.
const redactCorpusText = (text, context) => redactPii(redactText(text, context)).text;

const GRADED = new Set(['draft_better', 'equivalent', 'human_better', 'draft_unsafe']);
const SMALL_SAMPLE = 20;
// Requests the portal agent never completes on its own (owner 2026-11-05): cancelling a plan, issuing a
// refund, charging a card. Matched on the customer's text, the intent and the draft's escalation notes.
const RESTRICTED_RE = /\b(cancel\w*|refund\w*|charg(e|ed|ing)\b|chargeback|dispute\w*)/i;

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// intended_actions is { actions: [{ type, note? }], ... } (sms-shadow-drafter); older rows may hold a bare array.
function actionsOf(intendedActions) {
  const parsed = parseJson(intendedActions);
  const list = Array.isArray(parsed) ? parsed : parsed?.actions;
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && typeof a.type === 'string').map((a) => ({ type: a.type, note: typeof a.note === 'string' ? a.note : null }));
}

// Action types the drafter stores (sms-shadow-drafter INTENDED_ACTION_TYPES; a test keeps the two lists
// equal). Rows from before that filter can hold any string, so an unknown type counts as "other".
const ACTION_TYPES = ['none', 'escalate', 'book_appointment', 'send_payment_link', 'send_portal_link', 'send_estimate_link'];
// The escalation kinds the drafter's prompts name. A note is model-written free text (any string up to
// 200 characters, with or without a "<kind>: <detail>" shape), so it can hold a name, a phone number or
// an email address. No part of a note is ever printed or exported: a note that does not open with one of
// these kinds counts as "escalate:other".
const ESCALATION_KINDS = ['send_reservice_link', 'followup_promised', 'cancel_request'];

function actionLabel(action) {
  const type = ACTION_TYPES.includes(action.type) ? action.type : 'other';
  if (type !== 'escalate' || !action.note) return type;
  const kind = action.note.split(':')[0].trim();
  return `escalate:${ESCALATION_KINDS.includes(kind) ? kind : 'other'}`;
}

function isRestricted(row, actions) {
  if (RESTRICTED_RE.test(String(row.intent || ''))) return true;
  if (RESTRICTED_RE.test(String(row.inbound_message || ''))) return true;
  return actions.some((a) => a.type === 'escalate' && RESTRICTED_RE.test(a.note || ''));
}

function emptyGroup() {
  return { drafts: 0, judged: 0, graded: 0, unsafe: 0, human_better: 0, equivalent: 0, draft_better: 0, scored: 0, overall_sum: 0, could_send: { yes: 0, yes_with_edit: 0, no: 0 } };
}

function addRow(g, row) {
  g.drafts += 1;
  if (!row.verdict) return;
  g.judged += 1;
  if (GRADED.has(row.verdict)) {
    g.graded += 1;
    if (row.verdict === 'draft_unsafe') g.unsafe += 1;
    else g[row.verdict] += 1;
  }
  const overall = Number(parseJson(row.scores)?.overall);
  if (Number.isFinite(overall)) { g.scored += 1; g.overall_sum += overall; }
  if (row.could_send && g.could_send[row.could_send] !== undefined) g.could_send[row.could_send] += 1;
}

function finishGroup(g) {
  const couldSendTotal = g.could_send.yes + g.could_send.yes_with_edit + g.could_send.no;
  return {
    drafts: g.drafts,
    judged: g.judged,
    graded: g.graded,
    unsafe: g.unsafe,
    unsafe_rate: g.graded ? g.unsafe / g.graded : null,
    as_good_or_better_rate: g.graded ? (g.equivalent + g.draft_better) / g.graded : null,
    avg_overall: g.scored ? Number((g.overall_sum / g.scored).toFixed(1)) : null,
    could_send: g.could_send,
    could_send_rate: couldSendTotal ? (g.could_send.yes + g.could_send.yes_with_edit) / couldSendTotal : null,
    small_sample: g.graded < SMALL_SAMPLE,
  };
}

// rows: message_drafts joined to shadow_draft_judgments. Returns counts and rates only, never text.
function summarize(rows, { since = null, until = null } = {}) {
  const overall = emptyGroup();
  const byIntent = new Map();
  const byVersion = new Map();
  const actionCounts = {};
  const restricted = { requests: 0, escalated: 0, not_escalated: 0 };
  for (const row of rows) {
    addRow(overall, row);
    const intent = row.intent || 'GENERAL';
    if (!byIntent.has(intent)) byIntent.set(intent, emptyGroup());
    addRow(byIntent.get(intent), row);
    const version = row.prompt_version || '(none)';
    if (!byVersion.has(version)) byVersion.set(version, emptyGroup());
    addRow(byVersion.get(version), row);
    const actions = actionsOf(row.intended_actions);
    for (const label of new Set(actions.map(actionLabel))) actionCounts[label] = (actionCounts[label] || 0) + 1;
    if (isRestricted(row, actions)) {
      restricted.requests += 1;
      if (actions.some((a) => a.type === 'escalate')) restricted.escalated += 1;
      else restricted.not_escalated += 1;
    }
  }
  const sorted = (map) => [...map.entries()].map(([key, g]) => ({ key, ...finishGroup(g) })).sort((a, b) => b.drafts - a.drafts);
  return {
    since, until,
    overall: finishGroup(overall),
    by_intent: sorted(byIntent),
    by_prompt_version: sorted(byVersion),
    actions: Object.entries(actionCounts).map(([action, drafts]) => ({ action, drafts })).sort((a, b) => b.drafts - a.drafts),
    restricted,
  };
}

// One case for the operator's side-by-side read. Every text is redacted the way the voice corpus is
// (the customer's own names, then the generic PII pass). No phone, customer id or name leaves this.
function caseOf(row) {
  const context = { customer: { first_name: row.first_name, last_name: row.last_name } };
  const redact = (text) => (text ? redactCorpusText(text, context) : null);
  const actions = actionsOf(row.intended_actions);
  return {
    draft_id: row.id,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    intent: row.intent || null,
    prompt_version: row.prompt_version || null,
    verdict: row.verdict || null,
    could_send: row.could_send || null,
    scores: parseJson(row.scores),
    actions: actions.map(actionLabel),
    restricted_request: isRestricted(row, actions),
    customer_text: redact(row.inbound_message),
    waves_ai_draft: redact(row.draft_response),
    person_reply: row.human_replied ? redact(row.human_reply_text) : null,
  };
}

module.exports = { summarize, caseOf, actionsOf, actionLabel, isRestricted, SMALL_SAMPLE, ACTION_TYPES, ESCALATION_KINDS };
