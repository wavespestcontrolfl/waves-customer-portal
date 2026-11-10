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
 *     office, so the report counts how many such requests the draft escalated.
 *
 * Every rate counts the drafts one judge graded, never two judges' drafts together: judge j2 is stricter
 * than the first judge, so a mix of the two moves a rate without any change in the drafts.
 */
const { redactText } = require('../agent-decision-training');
const { redact: redactPii } = require('../content/pii-redactor');

// The voice corpus's two-pass redaction (sms-voice-corpus-miner redactCorpusText): the customer's own
// names first, then the generic PII pass for names the record does not know.
const redactCorpusText = (text, context) => redactPii(redactText(text, context)).text;

const GRADED = new Set(['draft_better', 'equivalent', 'human_better', 'draft_unsafe']);
const SMALL_SAMPLE = 20;
// The judge that graded a row: its judge_version stamp, or FIRST_JUDGE for a row graded before judge v2
// (sms-shadow-judge.js stamps 'j2'; older rows carry no stamp). Null for a draft no judge has seen.
const FIRST_JUDGE = 'first';
const judgeOf = (row) => (row.verdict ? row.judge_version || FIRST_JUDGE : null);

// Actions the portal agent never completes on its own (owner 2026-11-05): cancelling a plan, issuing a
// refund, charging a card. A text that only names one is a mention, not a request ("thanks for the
// refund yesterday", "has my plan been cancelled?", "when will I be charged?").
const RESTRICTED_WORD_RE = /\b(?:cancel\w*|refund\w*|money\s+back|(?:over|double[\s-]?)?charg(?:e|es|ed|ing)|chargebacks?|disput\w*)\b/i;
// A request is read from the wording of one sentence. The rules are narrow on purpose: wording they do
// not cover stays a mention, which the report lists apart for a person to read.
// 1. Ask wording that leads straight to the action ("please cancel", "I want a refund", "can you charge
//    my card", "how do I cancel"). Only the filler words below may stand between the two, so a negation
//    ("I don't want to cancel") or a status question ("can you tell me if my refund went through") does
//    not match; nor does "I" or "we" inside a question or a condition ("do I need to cancel if it rains",
//    "what happens if I want to cancel").
const ASK_SUBJECT = String.raw`(?<!\b(?:do|did|does|should|if|whether|when|unless)\s+)(?:i|we)`;
const ASK_CUE = String.raw`(?:please|pls|plz|kindly|${ASK_SUBJECT}(?:\s+would|'d)?\s+(?:really\s+)?(?:want|need|like|wish)|${ASK_SUBJECT}\s+(?:have|had|plan|intend|decided)\s+to|${ASK_SUBJECT}(?:\s+am|\s+are|'m|'re)\s+(?:going|gonna|planning|asking|requesting)|(?:can|could|may|would)\s+(?:i|we|you|u)|how\s+(?:do|can|could|would)\s+(?:i|we)|is\s+(?:it\s+possible|there\s+(?:a|any)\s+way))`;
const ASK_FILL = String.raw`(?:\s+(?:to|please|just|you|u|go|ahead|and|get|have|request|be|a|an|my|our|the|full|partial|me|us|for))*`;
const ASK_ACTION = String.raw`\s+(?:cancel(?:l?ation)?\b|refund\w*(?!\s+(?:confirmation|receipt|status|number|policy))|money\s+back|charge\b)`;
const ASK_RE = new RegExp(String.raw`\b${ASK_CUE}${ASK_FILL}${ASK_ACTION}`, 'i');
// 2. An instruction: the sentence opens with the verb and its object ("Cancel my plan", "Refund me").
const INSTRUCTION_RE = /^\W*(?:(?:ok(?:ay)?|yes|yeah|hi|hello|hey)\W+)?(?:cancel|refund|charge)\s+(?:my|our|the|me|us|this|that|it|all|everything|both)\b/i;
// 3. The customer says they are doing it ("I'm cancelling", "we are disputing the charge").
const DOING_RE = /\b(?:i|we)(?:(?:\s+am|\s+are|'m|'re)|(?:\s+will|'ll)\s+be)\s+(?:cancell?ing|disputing)\b/i;
// 4. A disputed charge asks for money back in other words ("charged twice", "overcharged", "dispute"),
//    unless the sentence says it did not happen ("I was not charged twice").
const DISPUTED_RE = /\b(?:over|double)[\s-]?charg\w*|\bcharg(?:e|ed)\b[^.!?]{0,40}\b(?:twice|double|two\s+times|2x|wrong\w*|incorrect\w*|too\s+much|by\s+mistake|in\s+error)\b|\b(?:unauthori[sz]ed|fraudulent)\s+charg\w*|\bshould(?:n't|\s+not)\s+have\s+(?:been\s+)?charged\b|\bchargebacks?\b|\bdisput\w*/i;
const NOT_CHARGED_RE = /\b(?:not|never|wasn't|weren't|didn't|isn't|no)\s+(?:been\s+|a\s+|an\s+|any\s+)?(?:(?:over|double)[\s-]?)?(?:charg|disput)/i;
// Thanks for a finished action is never a request ("thanks for the refund", "thank you for cancelling").
const THANKS_FOR_RE = /\bthank(?:s|\s+you|\s+u)?\s+(?:so\s+much\s+|again\s+)?for\b[^,.!?]{0,40}\b(?:cancel|refund|charg|disput)/i;

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
// these kinds counts as "escalate:other". A test keeps this list equal to the kinds in the drafter's source.
const ESCALATION_KINDS = ['send_reservice_link', 'reservice_times', 'followup_promised', 'cancel_request'];

// The kind an escalation note opens with, or null. Never any other part of the note.
function escalationKind(action) {
  if (action.type !== 'escalate' || !action.note) return null;
  const kind = action.note.split(':')[0].trim();
  return ESCALATION_KINDS.includes(kind) ? kind : null;
}

function actionLabel(action) {
  const type = ACTION_TYPES.includes(action.type) ? action.type : 'other';
  if (type !== 'escalate' || !action.note) return type;
  return `escalate:${escalationKind(action) || 'other'}`;
}

function sentenceAsks(sentence) {
  if (THANKS_FOR_RE.test(sentence)) return false;
  if (ASK_RE.test(sentence) || INSTRUCTION_RE.test(sentence) || DOING_RE.test(sentence)) return true;
  return DISPUTED_RE.test(sentence) && !NOT_CHARGED_RE.test(sentence);
}

function asksForRestricted(text) {
  return String(text || '').replace(/[\u2018\u2019]/g, "'").split(/[.!?;\n]+/).some(sentenceAsks);
}

// 'request': the customer asks to cancel, for a refund or for a charge (the wording rules above), or the
// drafter itself read the text as a cancellation (its cancel_request escalation).
// 'mention': the text names such an action with no request wording. null: it names none.
function restrictedOf(row, actions) {
  if (actions.some((a) => escalationKind(a) === 'cancel_request')) return 'request';
  const text = String(row.inbound_message || '');
  if (!RESTRICTED_WORD_RE.test(text)) return null;
  return asksForRestricted(text) ? 'request' : 'mention';
}

function emptyGroup() {
  return { drafts: 0, judged: 0, graded: 0, unsafe: 0, human_better: 0, equivalent: 0, draft_better: 0, scored: 0, overall_sum: 0, could_send: { yes: 0, yes_with_edit: 0, no: 0 } };
}

// Counts the draft always, and its verdict only when `judge` graded it (see the header note).
function addRow(g, row, judge) {
  g.drafts += 1;
  if (!row.verdict || judgeOf(row) !== judge) return;
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

// The judge whose drafts the rates count: the one that graded the newest judged draft, i.e. the rules in
// use at the end of the window. Null when no draft has a verdict.
function ratesJudge(rows) {
  let newest = null;
  for (const row of rows) {
    if (!row.verdict) continue;
    const at = new Date(row.created_at).getTime();
    if (!newest || at > newest.at) newest = { at, judge: judgeOf(row) };
  }
  return newest ? newest.judge : null;
}

// rows: message_drafts joined to shadow_draft_judgments. Returns counts and rates only, never text.
// overall, by_intent and by_prompt_version count every draft, and the verdicts of judge_version only;
// by_judge_version lists each judge's own drafts, so another judge's results stay visible but apart.
function summarize(rows, { since = null, until = null } = {}) {
  const judge = ratesJudge(rows);
  const overall = emptyGroup();
  const byIntent = new Map();
  const byVersion = new Map();
  const byJudge = new Map();
  const actionCounts = {};
  const restricted = { requests: 0, escalated: 0, not_escalated: 0, mentions_only: 0 };
  for (const row of rows) {
    addRow(overall, row, judge);
    const intent = row.intent || 'GENERAL';
    if (!byIntent.has(intent)) byIntent.set(intent, emptyGroup());
    addRow(byIntent.get(intent), row, judge);
    const version = row.prompt_version || '(none)';
    if (!byVersion.has(version)) byVersion.set(version, emptyGroup());
    addRow(byVersion.get(version), row, judge);
    const rowJudge = judgeOf(row);
    if (rowJudge) {
      if (!byJudge.has(rowJudge)) byJudge.set(rowJudge, emptyGroup());
      addRow(byJudge.get(rowJudge), row, rowJudge);
    }
    const actions = actionsOf(row.intended_actions);
    for (const label of new Set(actions.map(actionLabel))) actionCounts[label] = (actionCounts[label] || 0) + 1;
    const kind = restrictedOf(row, actions);
    if (kind === 'mention') restricted.mentions_only += 1;
    if (kind === 'request') {
      restricted.requests += 1;
      if (actions.some((a) => a.type === 'escalate')) restricted.escalated += 1;
      else restricted.not_escalated += 1;
    }
  }
  const sorted = (map) => [...map.entries()].map(([key, g]) => ({ key, ...finishGroup(g) })).sort((a, b) => b.drafts - a.drafts);
  return {
    since, until,
    judge_version: judge,
    overall: finishGroup(overall),
    by_intent: sorted(byIntent),
    by_prompt_version: sorted(byVersion),
    by_judge_version: sorted(byJudge),
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
    judge_version: judgeOf(row),
    could_send: row.could_send || null,
    scores: parseJson(row.scores),
    actions: actions.map(actionLabel),
    // 'request', 'mention' or null (restrictedOf): read the mentions, the wording rules are narrow.
    restricted: restrictedOf(row, actions),
    customer_text: redact(row.inbound_message),
    waves_ai_draft: redact(row.draft_response),
    person_reply: row.human_replied ? redact(row.human_reply_text) : null,
  };
}

module.exports = { summarize, caseOf, actionsOf, actionLabel, restrictedOf, SMALL_SAMPLE, ACTION_TYPES, ESCALATION_KINDS, FIRST_JUDGE };
