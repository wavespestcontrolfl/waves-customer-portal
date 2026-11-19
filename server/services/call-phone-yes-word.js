/**
 * The customer's word on calls since an estimate was sent, for the phone-yes cards (GATE_CALL_PHONE_YES_ACCEPT, owner
 * 2026-11-18 "ok go"; the cards land in call-phone-yes-accept.js, and a person acts on each one). It reads only: it
 * writes nothing and sends nothing.
 *
 * The call reader (the V2 extraction) judges what the caller chose: service_request.billing_choice (never consent on
 * its own, the extraction schema says so), and a cancellation or one-time ask in service_request.service_intent. This
 * module does not judge the conversation again. It keeps a choice's words only when its evidence quote is the
 * caller's, found word for word in a caller turn of that call's transcript, inside a sentence the triage flags' shared
 * screen reads as a plain statement (quoteIsPlainStatement). And it waits for any call the processor still owes a
 * read, by the processor's own rules (owedReadSql).
 */

const { CALL_EXTRACTION_MAX_ATTEMPTS, EXTRACTION_RETRY_WINDOW_DAYS } = require('../config/call-extraction-retry');

const CALL_COLUMNS = ['id', 'customer_id', 'created_at', 'direction', 'processing_status', 'answered_by', 'v2_extraction_status', 'ai_extraction_enriched'];
// The extraction's evidence pointer for the caller's plan choice (JSON pointer; a dotted path in older rows).
const BILLING_CHOICE_PATHS = new Set(['/service_request/billing_choice', 'service_request.billing_choice']);
const CALLER_WORDS_CHARS = 200;
const CHOICE_SCAN_LIMIT = 50;
// A later call with one of these intents takes back an earlier yes: the customer asked to cancel, or for a one-time
// visit instead of the plan. It is the latest word even with no billing choice.
const CONTRARY_INTENTS = new Set(['cancellation_request', 'preventative_one_time']);

// A call the pipeline still owes a read: a pass holds it now, or the processor's sweep will (re)read it, by the
// processor's own rules (pendingCandidatesQuery without its 10-minute settle gates; the retry budget in
// config/call-extraction-retry): a recording over 10 seconds that is not started, queued, waiting for its transcript,
// or failed with retries left; or a masked transcript (card-number quarantine) not started, queued or failed with
// retries left. A row the processor will not read again is never waited on. The DB test holds this to
// pendingCandidatesQuery row for row. Never NULL, so NOT owed is the read calls exactly.
function owedReadSql(t) {
  const underCap = `COALESCE(${t}.extraction_attempts, 0) < ${Number(CALL_EXTRACTION_MAX_ATTEMPTS)}`;
  const failedRetry = `(${t}.processing_status = 'extraction_failed' AND ${underCap}`
    + ` AND ${t}.created_at > now() - interval '${Number(EXTRACTION_RETRY_WINDOW_DAYS)} days')`;
  const masked = `(${t}.transcription_metadata::jsonb ->> 'pan_detected') = 'true'`;
  const unstarted = `(${t}.processing_status IS NULL OR ${t}.processing_status = 'pending')`;
  const recorded = `(COALESCE(${t}.recording_url, '') <> ''`
    + ` AND (COALESCE(${t}.recording_duration_seconds, ${t}.duration_seconds, 0) > 10 OR ${masked})`
    + ` AND (${unstarted} OR (${t}.transcription_status = 'pending' AND ${t}.transcription IS NULL)`
    + ` OR (${t}.processing_status = 'no_transcription' AND ${underCap}) OR ${failedRetry}))`;
  const quarantined = `(${masked} AND ${t}.transcription IS NOT NULL AND (${unstarted} OR ${failedRetry}))`;
  return `COALESCE((${t}.processing_status = 'processing' OR ${recorded} OR ${quarantined}), false)`;
}

// A sentence break: end punctuation, then a space, then a capital letter. "$49.99" and "8 a.m. bill me" stay one
// sentence, so a condition before them is screened with the quote (a longer sentence only fails closed).
const SENTENCE_BREAK = /[.!?]+\s+(?=[A-Z])/g;
const wordsOf = (text) => [...String(text || '').matchAll(/[a-z0-9]+/gi)].map((m) => ({ w: m[0].toLowerCase(), at: m.index, end: m.index + m[0].length }));

// The words to show: the whole sentences, or, when they run past CALLER_WORDS_CHARS, a cut around the quote. The
// quote's own words are never cut, so the office always sees what the caller chose.
function excerptOf(text, [from, to], [qs, qe]) {
  const tidy = (x) => x.replace(/\s+/g, ' ').trim();
  if (tidy(text.slice(from, to)).length <= CALLER_WORDS_CHARS) return tidy(text.slice(from, to));
  const room = Math.max(0, CALLER_WORDS_CHARS - 2 - (qe - qs));
  const start = Math.max(from, qs - Math.floor(room / 2));
  const end = Math.min(to, Math.max(qe, start + (qe - qs) + room));
  return `${start > from ? '…' : ''}${tidy(text.slice(start, end))}${end < to ? '…' : ''}`;
}

// Each place the quote is said in a turn: the whole sentences that hold it (a fragment is read with its "don't"), and
// the words to show.
function placesOf(turnText, quote) {
  const text = String(turnText || '');
  const tokens = wordsOf(text);
  const q = wordsOf(quote).map((t) => t.w);
  const breaks = [...text.matchAll(SENTENCE_BREAK)].map((m) => m.index + m[0].length);
  const places = [];
  for (let i = 0; q.length && i + q.length <= tokens.length; i += 1) {
    if (!q.every((w, k) => tokens[i + k].w === w)) continue;
    const span = [tokens[i].at, tokens[i + q.length - 1].end];
    const from = Math.max(0, ...breaks.filter((b) => b <= span[0]));
    const to = Math.min(text.length, ...breaks.filter((b) => b >= span[1]));
    places.push({ said: text.slice(from, to).trim(), shown: excerptOf(text, [from, to], span) });
  }
  return places;
}

// The caller's own words choosing the plan: an evidence quote for billing_choice labeled as the caller's AND found
// word for word in a caller turn of the transcript (outbound labels oriented the way the triage flags read them), in
// whole sentences that are a plain statement; given as those sentences, cut around the quote to fit. Null when no
// quote is. An unlabeled or one-speaker transcript grounds nothing.
function callerWordsOf(extraction, { transcript, outbound = false } = {}) {
  const quotes = (Array.isArray(extraction?.evidence) ? extraction.evidence : [])
    .filter((e) => BILLING_CHOICE_PATHS.has(e?.field_path) && e.speaker === 'caller' && typeof e.quote === 'string' && e.quote.trim());
  if (!quotes.length) return null;
  const { parseTurns, turnsHolding } = require('./call-reschedule-agreement').groundingTools;
  const { orientTranscriptForOutbound, quoteIsPlainStatement } = require('./call-triage-flags');
  const turns = parseTurns(orientTranscriptForOutbound(transcript, outbound));
  if (!turns || new Set(turns.map((t) => t.agent)).size < 2) return null;
  for (const e of quotes) {
    for (const turn of turnsHolding(turns, e.quote, 'caller')) {
      const place = placesOf(turn.raw, e.quote).find((x) => quoteIsPlainStatement(x.said));
      if (place) return place.shown;
    }
  }
  return null;
}

// One call's word (row: CALL_COLUMNS): a cancellation or one-time ask ({ contrary: true, callLogId, at }), a billing
// choice with the caller's own words ({ choice, callLogId, at, quote }; quote = callerWordsOf, null without them), or
// null (no word, not a two-party conversation, or not read: only a 'processed' row's extraction is its last read, as
// a failed re-read keeps the old one).
async function wordOfCall(conn, row) {
  if (row.processing_status !== 'processed' || row.v2_extraction_status !== 'valid') return null;
  const { parseExtraction, isRealConversation } = require('./call-held-visits');
  const extraction = parseExtraction(row.ai_extraction_enriched);
  if (!extraction || !isRealConversation(row, extraction)) return null;
  // Checked before the choice: a call that both names a plan and asks to cancel or for a one-time visit is no yes.
  if (CONTRARY_INTENTS.has(extraction.service_request?.service_intent)) return { contrary: true, callLogId: row.id, at: row.created_at };
  const choice = require('./call-prepay-choice').billingChoiceOf(extraction);
  if (!choice) return null;
  const { transcription } = (await conn('call_log').where({ id: row.id }).first('transcription')) || {};
  const quote = callerWordsOf(extraction, { transcript: transcription, outbound: String(row.direction || '').startsWith('outbound') });
  return { choice, callLogId: row.id, at: row.created_at, quote };
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
    .select(CALL_COLUMNS);
  for (let offset = 0; ; offset += CHOICE_SCAN_LIMIT) {
    const rows = await query.clone().offset(offset).limit(CHOICE_SCAN_LIMIT);
    for (const row of rows) {
      const word = await wordOfCall(conn, row);
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
// 'yes_without_words' }). A yes is the caller's pay-per-application choice WITH the caller's own words
// ({ yes: { callLogId, at, quote }, noYes: null }); a choice without them is no yes a card can show.
async function callerWord(conn, { customerId, since }) {
  const word = await latestBillingChoice(conn, { customerId, since });
  if (word?.contrary) return { skip: 'took_back' };
  if (word?.choice === 'annual_prepay') return { skip: 'chose_annual_prepay' };
  if (word?.choice !== 'per_application') return { yes: null, noYes: 'no_yes_heard' };
  if (!word.quote) return { yes: null, noYes: 'yes_without_words' };
  return { yes: { callLogId: word.callLogId, at: word.at, quote: word.quote }, noYes: null };
}

module.exports = {
  CALL_COLUMNS,
  owedReadSql,
  callerWordsOf,
  wordOfCall,
  latestBillingChoice,
  unreadCallSince,
  laterWordProblem,
  callerWord,
};
