/**
 * SMS incident adjudication — the pure half (no DB, no model call).
 *
 * The shadow judge's `human_better` verdict means the person's reply was
 * better. It does NOT mean the AI draft was wrong: most of the time the
 * person was warmer, shorter, or knew something the drafter was never told.
 * Counting those as failures would send the weekly fix lane chasing tone.
 *
 * So a `human_better` judgment becomes a CONFIRMED mistake only when TWO
 * MODELS ON DIFFERENT PROVIDERS, each reading the same evidence blind, both
 * return confirmed_mistake for the SAME failure mode, each quoting the
 * unsupported claim — and each quote is verified here to be text the draft
 * really contains (a model cannot invent the evidence). Anything short of
 * that is a `lead`: reported, never counted.
 *
 * Nothing deterministic in this file can confirm. The readings below are
 * SIGNALS, stored beside the decision for whoever investigates:
 *   - Pattern checks cannot prove "the facts do not support this". Facts and
 *     drafts word the same thing differently ("Autopay: on" / "your autopay
 *     is on"; a date in the facts / "tomorrow" in the draft), and whether a
 *     promise is authorized ("we'll get back to you within the hour" under
 *     the follow-up SLA fact) is not a pattern question at all.
 *   - A different day in the person's reply may be about something else.
 *   - The judge's safety score is one number with no failure-mode identity.
 * Review rounds on #5594 found a false confirmation through each of these in
 * turn; the rule is now that none of them votes.
 */

const DISPOSITIONS = Object.freeze(['confirmed_mistake', 'lead', 'not_a_mistake', 'duplicate']);
// What the MODEL may answer — 'duplicate' is a storage outcome, never a reading.
const MODEL_DISPOSITIONS = Object.freeze(['confirmed_mistake', 'lead', 'not_a_mistake']);

// A quoted claim shorter than this is not evidence ("ok", "yes").
const MIN_QUOTE_CHARS = 6;
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

// Is this dollar amount (or "N dollars") one the facts block carries?
function amountInFacts(token, facts) {
  const digits = String(token).replace(/[^\d.]/g, '').replace(/\.00$/, '');
  if (!digits) return false;
  return new RegExp(`(?<![\\d.])${digits.replace('.', '\\.')}(?:\\.00)?(?![\\d])`).test(norm(facts).replace(/,/g, ''));
}

/**
 * Deterministic readings of ONE draft: SIGNALS, never a confirmation. Each
 * hit is { mode, token } where mode is a FAILURE_MODES value from
 * sms-pathology-ledger and token is a span of the AI's own draft (never the
 * customer's text), capped. A hit means "this wording is present and a plain
 * text comparison did not find it in the facts", which is a reason to look,
 * not proof of invention.
 */
function runPredicates({ draft, facts }) {
  const hits = [];
  const d = norm(draft);
  if (!d) return hits;
  const first = (re) => { const m = d.match(re); return m ? m[0].slice(0, 80) : null; };

  const price = first(PRICE_RE);
  if (price && !amountInFacts(price, facts)) hits.push({ mode: 'price_quote', token: price });
  const placeholder = first(PLACEHOLDER_RE);
  if (placeholder) hits.push({ mode: 'placeholder_leak', token: placeholder });
  const missing = unsupportedScheduleTokens(draft, facts);
  if (missing.length) hits.push({ mode: 'invented_schedule_eta', token: missing.slice(0, 4).join(', ') });
  const billing = first(BILLING_RE);
  if (billing && !norm(facts).includes(billing)) hits.push({ mode: 'invented_billing', token: billing });
  const commitment = first(COMMITMENT_RE);
  if (commitment) hits.push({ mode: 'invented_commitment', token: commitment });
  const callRef = first(CALL_REFERENCE_RE);
  if (callRef) hits.push({ mode: 'invented_call_reference', token: callRef });
  return hits;
}

/**
 * SIGNAL: the draft named ONE weekday (or ONE calendar date) and the person's
 * reply named ONE different one. Stored for the investigator; it does not
 * vote (the person's day may be about something else entirely).
 *
 * Kept narrow so the signal means something: clock times are not compared
 * (arrival times are spoken as windows), either side naming two or more
 * values is a list or a range, and a component is compared only with itself
 * and only when both sides state it.
 */
function humanContradictsSchedule({ draft, humanReply }) {
  const conflicts = (mine, theirs) => mine.size === 1 && theirs.size === 1 && !mine.has([...theirs][0]);
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
 * The two-model rule.
 *   model      — the first reader's parsed answer.
 *   second     — a second, different-provider model's parsed answer. Omitted
 *                on the first pass: when the first reader confirmed with a
 *                verified quote the result carries `needsSecondReader: true`
 *                and the caller asks for one, then calls again with it (null
 *                = the second reader answered but was unusable).
 *   predicates — runPredicates' output. Used ONLY to keep a draft that
 *                breaks a house rule (a price, a placeholder) visible as a
 *                lead when the first reader waved it through.
 */
function decideDisposition({ model, predicates = [], draft, second }) {
  const quoteVerified = quoteInDraft(model.quote, draft);
  const cell = { surface: model.surface, failure_mode: model.failure_mode };

  if (model.disposition === 'confirmed_mistake') {
    if (!quoteVerified) return { disposition: 'lead', rule: 'model_quote_unverified', quoteVerified, ...cell };
    if (second === undefined) {
      return { disposition: 'lead', rule: 'model_only', needsSecondReader: true, quoteVerified, ...cell };
    }
    const secondAgrees = Boolean(second)
      && second.disposition === 'confirmed_mistake'
      && second.failure_mode === model.failure_mode
      && quoteInDraft(second.quote, draft);
    if (secondAgrees) return { disposition: 'confirmed_mistake', rule: 'two_models', quoteVerified, ...cell };
    return { disposition: 'lead', rule: 'model_only', quoteVerified, ...cell };
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
  MIN_QUOTE_CHARS,
  runPredicates,
  humanContradictsSchedule,
  quoteInDraft,
  decideDisposition,
  _test: { norm, clockTokens, factsClockTokens, weekdayTokens, monthDayTokens, scheduleTokens, unsupportedScheduleTokens, amountInFacts },
};
