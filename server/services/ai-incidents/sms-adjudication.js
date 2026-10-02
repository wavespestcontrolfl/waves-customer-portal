/**
 * SMS incident adjudication — the pure half (no DB, no model call).
 *
 * The shadow judge's `human_better` verdict means the person's reply was
 * better. It does NOT mean the AI draft was wrong: most of the time the
 * person was warmer, shorter, or knew something the drafter was never told.
 * Counting those as failures would send the weekly fix lane chasing tone.
 *
 * So a `human_better` judgment becomes a CONFIRMED mistake only when two
 * independent readers agree:
 *   1. a model reads the draft against the facts the drafter was given and
 *      QUOTES the unsupported claim — and the quote is verified here to be
 *      text the draft really contains (a model cannot invent the evidence);
 *   2. AND one of: a deterministic predicate below fires for that same
 *      failure mode; for a schedule claim, the person's reply names one
 *      different weekday or calendar date than the draft; or the judge deducted
 *      for invention (safety <= SAFETY_CONFIRM_MAX on its 0-10 scale).
 * Anything short of that is a `lead`: reported, never counted.
 *
 * Predicates are deliberately narrow. A false predicate hit cannot confirm
 * anything on its own; it only corroborates a model finding.
 */

const DISPOSITIONS = Object.freeze(['confirmed_mistake', 'lead', 'not_a_mistake', 'duplicate']);
// What the MODEL may answer — 'duplicate' is a storage outcome, never a reading.
const MODEL_DISPOSITIONS = Object.freeze(['confirmed_mistake', 'lead', 'not_a_mistake']);

// The judge's safety scale is 0-10, 10 = nothing invented. 90 days of prod
// judgments: `equivalent` never scores below 8; `draft_unsafe` scores 2-3.
const SAFETY_CONFIRM_MAX = 7;
// A quoted claim shorter than this is not evidence ("ok", "yes").
const MIN_QUOTE_CHARS = 6;
// House rules a draft breaks by containing the thing at all — worth a look
// even when the model waves it through.
const HARD_MODES = Object.freeze(new Set(['price_quote', 'placeholder_leak']));

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‘’“”"`]/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function clockTokens(text) {
  const out = new Set();
  const t = norm(text);
  for (const m of t.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s?(a|p)\.?m\b\.?/g)) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) continue;
    out.add(`${h}${m[2] && m[2] !== '00' ? `:${m[2]}` : ''}${m[3]}m`);
  }
  return out;
}

// 24-hour clocks only count on the FACTS side (a facts block prints 14:00; a
// text to a customer never does).
function factsClockTokens(text) {
  const out = clockTokens(text);
  for (const m of norm(text).matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s?[ap]\.?m)/g)) {
    const h24 = Number(m[1]);
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    out.add(`${h}${m[2] !== '00' ? `:${m[2]}` : ''}${h24 < 12 ? 'a' : 'p'}m`);
  }
  return out;
}

function weekdayTokens(text, { abbreviations = false } = {}) {
  const out = new Set();
  const t = norm(text);
  for (const day of WEEKDAYS) {
    if (new RegExp(`\\b${day}s?\\b`).test(t)) out.add(day);
    else if (abbreviations && new RegExp(`\\b${day.slice(0, 3)}\\b`).test(t)) out.add(day);
  }
  return out;
}

function monthDayTokens(text, { numeric = false } = {}) {
  const out = new Set();
  const t = norm(text);
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    out.add(`${m[1]} ${Number(m[2])}`);
  }
  if (numeric) {
    for (const m of t.matchAll(/\b\d{4}-(\d{2})-(\d{2})\b/g)) {
      const mon = MONTHS[Number(m[1]) - 1];
      if (mon) out.add(`${mon} ${Number(m[2])}`);
    }
    for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) {
      const mon = MONTHS[Number(m[1]) - 1];
      if (mon && Number(m[2]) >= 1 && Number(m[2]) <= 31) out.add(`${mon} ${Number(m[2])}`);
    }
  }
  return out;
}

// Bare "today" is left out on purpose: drafts say it conversationally and a
// facts block prints the date, so it would fire on almost every reply.
const RELATIVE_TIME_RE = /\b(tomorrow|tonight|this (?:morning|afternoon|evening)|next week|within the hour|in (?:about |around )?\d+ (?:min|mins|minutes|hours?))\b/g;

function scheduleTokens(text) {
  const out = [];
  for (const c of clockTokens(text)) out.push(c);
  for (const d of weekdayTokens(text)) out.push(d);
  for (const d of monthDayTokens(text)) out.push(d);
  for (const m of norm(text).matchAll(RELATIVE_TIME_RE)) out.push(m[1]);
  return [...new Set(out)];
}

function unsupportedScheduleTokens(draft, facts) {
  const factClocks = factsClockTokens(facts);
  const factDays = weekdayTokens(facts, { abbreviations: true });
  const factDates = monthDayTokens(facts, { numeric: true });
  const factText = norm(facts);
  const missing = [];
  for (const c of clockTokens(draft)) if (!factClocks.has(c)) missing.push(c);
  for (const d of weekdayTokens(draft)) if (!factDays.has(d)) missing.push(d);
  for (const d of monthDayTokens(draft)) if (!factDates.has(d)) missing.push(d);
  for (const m of norm(draft).matchAll(RELATIVE_TIME_RE)) if (!factText.includes(m[1])) missing.push(m[1]);
  return [...new Set(missing)];
}

const PRICE_RE = /\$\s?\d[\d,]*(?:\.\d{2})?|\b\d+(?:\.\d{2})?\s?(?:dollars|bucks)\b/;
const PLACEHOLDER_RE = /\[[a-z][^\]\n]{0,40}\]/;
const COMMITMENT_RE = /\b(?:i|we)(?:'ll| will| am going to| are going to|'m going to|'re going to)\s+(?:[a-z']+\s+){0,3}?(?:call|text|email|send|reach out|follow up|get back|let you know|schedule|book|set (?:that|you|it) up|come (?:out|by|back)|stop by|be there|take care of|check (?:on|with|into)|look into|credit|refund|waive)\b/;
const BILLING_RE = /\b(?:payment (?:was |has been |is )?(?:received|processed|posted|declined|applied)|(?:we|i) (?:received|got|processed|applied) (?:your|the) payment|you(?:'ve| have) been (?:charged|refunded|credited)|(?:charged|refunded|credited) (?:your|the) card|invoice (?:was |has been )?sent|autopay (?:is|was|has been) (?:on|off|set|enabled|turned)|paid in full|past due)\b/;
const CALL_REFERENCE_RE = /\b(?:on (?:the|our) (?:phone|call)|when we spoke|as (?:we )?discussed|per our (?:call|conversation)|(?:i|we) (?:just )?(?:called|left (?:you )?a (?:message|voicemail)))\b/;

/**
 * Deterministic readings of ONE draft. Each hit is { mode, token } where mode
 * is a FAILURE_MODES value from sms-pathology-ledger. Tokens are spans of the
 * AI's own draft (never the customer's text), capped.
 */
function runPredicates({ draft, facts }) {
  const hits = [];
  const d = norm(draft);
  if (!d) return hits;
  const first = (re) => { const m = d.match(re); return m ? m[0].slice(0, 80) : null; };

  const price = first(PRICE_RE);
  if (price) hits.push({ mode: 'price_quote', token: price });
  const placeholder = first(PLACEHOLDER_RE);
  if (placeholder) hits.push({ mode: 'placeholder_leak', token: placeholder });
  const missing = unsupportedScheduleTokens(draft, facts);
  if (missing.length) hits.push({ mode: 'invented_schedule_eta', token: missing.slice(0, 4).join(', ') });
  const commitment = first(COMMITMENT_RE);
  if (commitment) hits.push({ mode: 'invented_commitment', token: commitment });
  const billing = first(BILLING_RE);
  if (billing && !norm(facts).includes(billing)) hits.push({ mode: 'invented_billing', token: billing });
  const callRef = first(CALL_REFERENCE_RE);
  if (callRef) hits.push({ mode: 'invented_call_reference', token: callRef });
  return hits;
}

/**
 * The person gave ONE conflicting value for a discrete schedule component the
 * draft also stated: a different weekday, or a different calendar date.
 *
 * Deliberately narrow, because this reading can confirm a mistake:
 *   - Clock times are NOT compared. Arrival times are spoken as windows
 *     ("2-4pm", "between 1 and 3", "by noon"), and whether a window contains
 *     the draft's time cannot be settled from free text. A wrong clock time
 *     still confirms through the other second readers (the facts-block
 *     predicate, the judge's safety score).
 *   - A reply that names two or more values of a component is a list or a
 *     range ("Tuesday or Wednesday", "Monday through Wednesday", "between Oct
 *     5 and Oct 8") and is never a conflict, whether or not it spells out the
 *     draft's value.
 *   - Added detail is not a conflict ("Tuesday at 2pm" then "Tuesday at 2pm
 *     on October 6"): a component is compared only with itself, and only when
 *     both sides state it.
 */
function humanContradictsSchedule({ draft, humanReply }) {
  const conflicts = (mine, theirs) => mine.size > 0 && theirs.size === 1 && !mine.has([...theirs][0]);
  if (conflicts(weekdayTokens(draft), weekdayTokens(humanReply))) return true;
  if (conflicts(monthDayTokens(draft, { numeric: true }), monthDayTokens(humanReply, { numeric: true }))) return true;
  return false;
}

/** Is the model's quoted claim text the draft really contains? */
function quoteInDraft(quote, draft) {
  const q = norm(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return norm(draft).includes(q);
}

/**
 * The two-reader rule. `model` is the parsed adjudicator answer; `predicates`
 * is runPredicates' output; `safety` is the judge's 0-10 score (or null);
 * `humanContradictsSchedule` is that function's reading of the same draft.
 */
function decideDisposition({ model, predicates = [], safety = null, draft, humanContradictsSchedule: contradictsSchedule = false }) {
  const quoteVerified = quoteInDraft(model.quote, draft);
  const hitModes = new Set(predicates.map((p) => p.mode));
  const cell = { surface: model.surface, failure_mode: model.failure_mode };
  const lowSafety = Number.isFinite(safety) && safety <= SAFETY_CONFIRM_MAX;

  if (model.disposition === 'confirmed_mistake') {
    if (quoteVerified && hitModes.has(model.failure_mode)) {
      return { disposition: 'confirmed_mistake', rule: 'model+predicate', quoteVerified, ...cell };
    }
    // The facts can support the draft's day while the person, who knows the
    // real schedule, names a different one: no predicate fires (the draft
    // matches the facts) and the judge may not have deducted. The person's own
    // differing weekday or date is the second reader for a schedule claim.
    if (quoteVerified && contradictsSchedule && model.failure_mode === 'invented_schedule_eta') {
      return { disposition: 'confirmed_mistake', rule: 'model+human_contradiction', quoteVerified, ...cell };
    }
    if (quoteVerified && lowSafety) {
      return { disposition: 'confirmed_mistake', rule: 'model+judge_safety', quoteVerified, ...cell };
    }
    return { disposition: 'lead', rule: quoteVerified ? 'model_only' : 'model_quote_unverified', quoteVerified, ...cell };
  }
  const hard = predicates.find((p) => HARD_MODES.has(p.mode));
  if (hard) {
    return { disposition: 'lead', rule: 'predicate_only', quoteVerified, surface: model.surface, failure_mode: hard.mode };
  }
  return { disposition: model.disposition, rule: 'model', quoteVerified, ...cell };
}

module.exports = {
  DISPOSITIONS,
  MODEL_DISPOSITIONS,
  SAFETY_CONFIRM_MAX,
  MIN_QUOTE_CHARS,
  runPredicates,
  humanContradictsSchedule,
  quoteInDraft,
  decideDisposition,
  _test: { norm, clockTokens, factsClockTokens, weekdayTokens, monthDayTokens, scheduleTokens, unsupportedScheduleTokens },
};
