/**
 * The customer's word on calls since an estimate was sent, for the phone-yes cards (GATE_CALL_PHONE_YES_ACCEPT, owner
 * 2026-11-18 "ok go"; the cards land in call-phone-yes-accept.js, and a person acts on each one). It reads only: it
 * writes nothing and sends nothing.
 *
 * The call reader (the V2 extraction) judges what the caller chose: service_request.billing_choice (never consent on
 * its own, the extraction schema says so), and a cancellation or one-time ask in service_request.service_intent. This
 * module adds no word lists of its own (a list cannot keep up with free speech). It checks that the choice's evidence
 * quote is the caller's, word for word in a caller turn of that call's transcript. It gives the office that whole
 * turn, cut around the quote, so any condition or "no" the caller said is in front of the person who decides. It
 * calls the choice a yes only when every caller turn that says the quote passes the triage flags' shared
 * plain-statement screen (quoteIsPlainStatement) as it is, whole: a turn is the unit the grounding tools trust, so no
 * sentence split decides it. A choice that fails is no yes (yes_not_plain): any "if", "when", "not" or question in
 * those turns fails closed, and the office reads the call. A later word that does not repeat the quote is the call
 * reader's to judge (billing_choice reads the whole call). And it waits, for a bounded time, for any recent call that
 * is not read yet (owedReadSql).
 */

const { CALL_EXTRACTION_MAX_ATTEMPTS } = require('../config/call-extraction-retry');

const CALL_COLUMNS = ['id', 'customer_id', 'created_at', 'direction', 'processing_status', 'answered_by', 'v2_extraction_status', 'ai_extraction_enriched'];
// A call's columns for its word: the extraction and the transcript come from one row read.
const WORD_COLUMNS = [...CALL_COLUMNS, 'transcription'];
// The extraction's evidence pointer for the caller's plan choice (JSON pointer; a dotted path in older rows).
const BILLING_CHOICE_PATHS = new Set(['/service_request/billing_choice', 'service_request.billing_choice']);
const CALLER_WORDS_CHARS = 200;
const CHOICE_SCAN_LIMIT = 50;
// A later call with one of these intents takes back an earlier yes: the customer asked to cancel, or for a one-time
// visit instead of the plan. It is the latest word even with no billing choice.
const CONTRARY_INTENTS = new Set(['cancellation_request', 'preventative_one_time']);

// How long a call can still be read for the first time or retried: the processor reads a call within minutes, its
// retries come 10 minutes apart, and a call with no recording is recovered from its live text soon after it ends.
const OWED_READ_HOURS = 2;

// A call that still owes a read: a recent call (OWED_READ_HOURS) not in a final state, or one a pass holds now. Final:
// read ('processed'), judged not a conversation ('voicemail', 'spam'), or failed at its retry cap (the
// exhaustedExtractionSql rule in call-commitments; its 7-day window never applies inside 2 hours). Bounded in time on
// purpose, so no processor path is copied here: a row no pass will finish (a missed call with nothing to read, a dead
// claim) delays a card by at most OWED_READ_HOURS and never blocks it. Never NULL, so NOT owed is exact.
function owedReadSql(t) {
  const atCap = `COALESCE(${t}.extraction_attempts, 0) >= ${Number(CALL_EXTRACTION_MAX_ATTEMPTS)}`;
  const final = `(${t}.processing_status IN ('processed', 'voicemail', 'spam')`
    + ` OR (${t}.processing_status IN ('extraction_failed', 'no_transcription') AND ${atCap}))`;
  const recent = (column) => `${t}.${column} > now() - interval '${OWED_READ_HOURS} hours'`;
  return `COALESCE((((${t}.processing_status IS NULL OR NOT ${final}) AND ${recent('created_at')})`
    + ` OR (${t}.processing_status = 'processing' AND ${recent('updated_at')})), false)`;
}

const wordsOf = (text) => [...String(text || '').matchAll(/[a-z0-9]+/gi)].map((m) => ({ w: m[0].toLowerCase(), at: m.index, end: m.index + m[0].length }));

// Where a turn first says the quote, as [start, end] in its text, or null (then the whole turn is shown).
function spanOf(text, quote) {
  const tokens = wordsOf(text);
  const q = wordsOf(quote).map((t) => t.w);
  for (let i = 0; q.length && i + q.length <= tokens.length; i += 1) {
    if (q.every((w, k) => tokens[i + k].w === w)) return [tokens[i].at, tokens[i + q.length - 1].end];
  }
  return null;
}

// The words to show: the caller's whole turn, or, past CALLER_WORDS_CHARS, a cut around the quote. The quote's own
// words are never cut, so the office always sees what the caller chose; with no span, nothing is cut.
function excerptOf(text, span) {
  const tidy = (x) => x.replace(/\s+/g, ' ').trim();
  if (!span || tidy(text).length <= CALLER_WORDS_CHARS) return tidy(text);
  const [qs, qe] = span;
  const room = Math.max(0, CALLER_WORDS_CHARS - 2 - (qe - qs));
  const start = Math.max(0, qs - Math.floor(room / 2));
  const end = Math.min(text.length, Math.max(qe, start + (qe - qs) + room));
  return `${start > 0 ? '…' : ''}${tidy(text.slice(start, end))}${end < text.length ? '…' : ''}`;
}

// The caller's own words for the plan choice, from the caller turns that hold an evidence quote for billing_choice
// (labeled the caller's) word for word, with outbound labels oriented the way the triage flags read them:
// { words, plain }. The shared tools ground the quote (a short one must be a whole caller turn); then every caller turn
// that says it, at any length, is screened. plain = in every such turn, the whole turn, each of its sentences (the
// grounding tools' split, so each sentence start meets the question check) and the quote pass the shared screen.
// words = the first turn that does not (so the office sees the "no"), else the latest turn, cut around the quote. Null
// when no caller turn holds a quote; an unlabeled or one-speaker transcript grounds nothing.
function callerWordsOf(extraction, { transcript, outbound = false } = {}) {
  const quotes = (Array.isArray(extraction?.evidence) ? extraction.evidence : [])
    .filter((e) => BILLING_CHOICE_PATHS.has(e?.field_path) && e.speaker === 'caller' && typeof e.quote === 'string' && e.quote.trim());
  if (!quotes.length) return null;
  const { parseTurns, turnsHolding, normalize } = require('./call-reschedule-agreement').groundingTools;
  const { orientTranscriptForOutbound, quoteIsPlainStatement } = require('./call-triage-flags');
  const turns = parseTurns(orientTranscriptForOutbound(transcript, outbound));
  if (!turns || new Set(turns.map((t) => t.agent)).size < 2) return null;
  // The grounding tools' own normalization ("9am" = "9 a.m."), so a turn that says the quote is always found.
  const grounded = quotes.filter((e) => turnsHolding(turns, e.quote, 'caller').length).map((e) => ({ quote: e.quote, ns: normalize(e.quote) }));
  const held = [];
  for (const turn of turns.filter((t) => !t.agent)) {
    const hit = grounded.find((g) => g.ns && ` ${turn.ns} `.includes(` ${g.ns} `));
    if (!hit) continue;
    const text = String(turn.raw || '');
    const plain = quoteIsPlainStatement(text) && quoteIsPlainStatement(hit.quote)
      && turn.sentences.every((x) => !x.question && quoteIsPlainStatement(x.ns));
    held.push({ words: excerptOf(text, spanOf(text, hit.quote)), plain });
  }
  if (!held.length) return null;
  return held.find((h) => !h.plain) || held[held.length - 1];
}

// One call's word (row: WORD_COLUMNS, one read): a cancellation or one-time ask ({ contrary: true, callLogId, at }), a
// billing choice with the caller's words ({ choice, callLogId, at, quote, plain }; quote and plain from callerWordsOf,
// quote null without words), or null (no word, not a two-party conversation, or not read: only a 'processed' row's
// extraction is its last read, as a failed re-read keeps the old one).
function wordOfCall(row) {
  if (row.processing_status !== 'processed' || row.v2_extraction_status !== 'valid') return null;
  const { parseExtraction, isRealConversation } = require('./call-held-visits');
  const extraction = parseExtraction(row.ai_extraction_enriched);
  if (!extraction || !isRealConversation(row, extraction)) return null;
  // Checked before the choice: a call that both names a plan and asks to cancel or for a one-time visit is no yes.
  if (CONTRARY_INTENTS.has(extraction.service_request?.service_intent)) return { contrary: true, callLogId: row.id, at: row.created_at };
  const choice = require('./call-prepay-choice').billingChoiceOf(extraction);
  if (!choice) return null;
  const heard = callerWordsOf(extraction, { transcript: row.transcription, outbound: String(row.direction || '').startsWith('outbound') });
  return { choice, callLogId: row.id, at: row.created_at, quote: heard?.words || null, plain: heard?.plain === true };
}

// The customer's latest word on a call since `since`: the newest read, valid, two-party call whose extraction names a
// billing choice or a cancellation or one-time ask, as wordOfCall gives it, or null. SQL keeps only rows that name a
// word; pages of CHOICE_SCAN_LIMIT follow until one is a two-party conversation, so voicemails never hide the last
// word. Sandbox calls do not count.
async function latestBillingChoice(conn, { customerId, since }) {
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const { BILLING_CHOICES } = require('./call-prepay-choice');
  const query = conn('call_log')
    .where({ customer_id: customerId, processing_status: 'processed', v2_extraction_status: 'valid' })
    .where('created_at', '>=', since)
    .whereRaw(`NOT ${owedReadSql('call_log')}`)
    .where((qb) => qb
      .whereRaw("ai_extraction_enriched -> 'service_request' ->> 'billing_choice' = ANY(?)", [[...BILLING_CHOICES]])
      .orWhereRaw("ai_extraction_enriched -> 'service_request' ->> 'service_intent' = ANY(?)", [[...CONTRARY_INTENTS]]))
    .modify((qb) => whereNotSandboxCall(qb))
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .select(WORD_COLUMNS);
  for (let offset = 0; ; offset += CHOICE_SCAN_LIMIT) {
    const rows = await query.clone().offset(offset).limit(CHOICE_SCAN_LIMIT);
    for (const row of rows) {
      const word = wordOfCall(row);
      if (word) return word;
    }
    if (rows.length < CHOICE_SCAN_LIMIT) return null;
  }
}

// True when a call from the customer since `since` still owes a read (owedReadSql): it may hold the yes or take it
// back. Sandbox calls do not count.
async function unreadCallSince(conn, { customerId, since }) {
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  return !!(await conn('call_log')
    .where({ customer_id: customerId })
    .where('created_at', '>=', since)
    .whereRaw(owedReadSql('call_log'))
    .modify((qb) => whereNotSandboxCall(qb))
    .first('id'));
}

// What stands between the caller's word and the call that booked the visit (`booking`, a CALL_COLUMNS row), or null:
//   yes_after_booking    the yes came on a later call than the booking (the visit was not booked for the plan);
//   booking_call_unread  the booking call's last read did not finish (a failed re-read or an invalid extraction may
//                        hide a no);
//   newer_call           another call from the customer came since the yes (or, with no yes, since the booking).
// Call it once every call in the window is read (unreadCallSince). Sandbox calls do not count.
async function laterWordProblem(conn, { customerId, yes, booking }) {
  if (yes && new Date(yes.at) > new Date(booking.created_at)) return 'yes_after_booking';
  if (booking.processing_status !== 'processed' || booking.v2_extraction_status !== 'valid') return 'booking_call_unread';
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const later = await conn('call_log')
    .where({ customer_id: customerId })
    .where('created_at', '>', yes ? yes.at : booking.created_at)
    .whereNotIn('id', [yes?.callLogId, booking.id].filter(Boolean))
    .modify((qb) => whereNotSandboxCall(qb))
    .first('id');
  return later ? 'newer_call' : null;
}

// The customer's word since `since`, as the cards read it: a reason for no card ({ skip: 'took_back' |
// 'chose_annual_prepay' }), or the yes and, when there is none, why ({ yes: null, noYes: 'no_yes_heard' |
// 'yes_without_words' | 'yes_not_plain' }). A yes is the caller's pay-per-application choice WITH the caller's own
// words in a plain statement ({ yes: { callLogId, at, quote }, noYes: null }); any other choice is no yes a card shows.
async function callerWord(conn, { customerId, since }) {
  const word = await latestBillingChoice(conn, { customerId, since });
  if (word?.contrary) return { skip: 'took_back' };
  if (word?.choice === 'annual_prepay') return { skip: 'chose_annual_prepay' };
  if (word?.choice !== 'per_application') return { yes: null, noYes: 'no_yes_heard' };
  if (!word.quote) return { yes: null, noYes: 'yes_without_words' };
  if (!word.plain) return { yes: null, noYes: 'yes_not_plain' };
  return { yes: { callLogId: word.callLogId, at: word.at, quote: word.quote }, noYes: null };
}

module.exports = {
  CALL_COLUMNS,
  WORD_COLUMNS,
  owedReadSql,
  callerWordsOf,
  wordOfCall,
  latestBillingChoice,
  unreadCallSince,
  laterWordProblem,
  callerWord,
};
