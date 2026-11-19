/**
 * The customer's word on calls since an estimate was sent, for the phone-yes cards (GATE_CALL_PHONE_YES_ACCEPT, owner
 * 2026-11-18 "ok go"; the cards land in call-phone-yes-accept.js, and a person acts on each one). It reads only: it
 * writes nothing and sends nothing.
 *
 * The call reader (the V2 extraction) judges what the caller chose, over the whole call: service_request.billing_choice,
 * and a cancellation or one-time ask in service_request.service_intent. Its billing_choice rule
 * (prompts/call-extraction-v1.js) already holds the language judgment: staff offering a plan, a caller question, an
 * "okay" after a price question and an unclear word are no choice; the caller must name or plainly pick the plan; a
 * changed mind takes the final choice. This module judges no words itself, because a word screen cannot keep up with
 * free speech. It checks only what code can check: the choice's evidence is the caller's own words, word for word in a
 * caller turn of the call's recording transcript (the shared grounding tools; the voice agent's own text and the
 * live-text backup are never evidence). It gives the office the caller's latest turn that says them, whole, so any
 * condition or "no" is in front of the person who decides, and that person decides every card. And it waits, for a
 * bounded time, for any recent call that is not read yet (owedReadSql).
 */

const { callStartedAt } = require('../utils/call-timeline');

// A call's columns, with what callStartedAt reads: a row inserted after the call (a recording recovery, a terminal
// status callback) backs its own length out of created_at, so every time here is when the call began.
const CALL_COLUMNS = ['id', 'customer_id', 'created_at', 'metadata', 'duration_seconds', 'recording_duration_seconds',
  'direction', 'processing_status', 'answered_by', 'v2_extraction_status', 'ai_extraction_enriched'];
// A call's columns for its word: the extraction and the transcript come from one row read.
const WORD_COLUMNS = [...CALL_COLUMNS, 'transcription', 'transcription_provider'];
// The extraction's evidence pointer for the caller's plan choice (JSON pointer; a dotted path in older rows).
const BILLING_CHOICE_PATHS = new Set(['/service_request/billing_choice', 'service_request.billing_choice']);
const CHOICE_SCAN_LIMIT = 50;
// A later call with one of these intents takes back an earlier yes: the customer asked to cancel, or for a one-time
// visit instead of the plan. It is the latest word even with no billing choice.
const CONTRARY_INTENTS = new Set(['cancellation_request', 'preventative_one_time']);
// The call reader's cancel flag (triage_flags) takes it back the same way, whatever service_intent says.
const CANCEL_FLAG = 'cancellation_request';

// How long a call can still be read for the first time or retried after its row last changed: the processor reads a
// call within minutes, its retries come 10 minutes apart, and a call with no recording is recovered from its live text
// soon after it ends.
const OWED_READ_HOURS = 2;

// A call that still owes a read: one not in a final state whose row changed in the last OWED_READ_HOURS. Final: read
// ('processed'), judged not a conversation ('voicemail', 'spam'), or a failed read no pass revisits (call-commitments'
// exhaustedExtractionSql: a failed extraction at its retry cap or past its 7-day creation window, a missing transcript
// at its cap). The row's last change is its insert, a
// claim, the heartbeat a running pass writes every minute (processing_heartbeat_at only), or replaced audio (the
// recording webhook sets the status back to NULL and bumps updated_at), so a long read and an old call with new audio
// are waited for too. Bounded in time on purpose, so no processor path is copied here: a row no pass will finish (a
// missed call with nothing to read, a dead claim) delays a card by at most OWED_READ_HOURS after its last change and
// never blocks it. Never NULL, so NOT owed is exact. SQL over the alias `t`, call_log by default.
function owedReadSql(t = 'call_log') {
  const { exhaustedExtractionSql } = require('./call-commitments');
  const final = `(${t}.processing_status IN ('processed', 'voicemail', 'spam') OR ${exhaustedExtractionSql(t)})`;
  // GREATEST skips NULLs: a row with no update or no heartbeat counts from its insert.
  const changed = `GREATEST(${t}.created_at, ${t}.updated_at, ${t}.processing_heartbeat_at)`;
  return `COALESCE(((${t}.processing_status IS NULL OR NOT ${final})`
    + ` AND ${changed} > now() - interval '${OWED_READ_HOURS} hours'), false)`;
}

// When the call began, as SQL over call_log (callStartedAtSql's default alias; the twin of callStartedAt).
const startedSql = () => require('./sms-pending-conversations').callStartedAtSql();

// The caller's own words for the plan choice (a string), or null. The shared grounding tools ground each billing_choice
// evidence quote labeled the caller's in a recording transcript (a short quote must be a whole caller turn), with
// outbound labels oriented the way the triage flags read them. A turn is all of one speaker's lines until the other
// speaks: a condition on the caller's next line ("but only if the price stays the same") is part of the same answer.
// Nothing is grounded in an unlabeled or one-speaker transcript, or where the labels may be swapped: on any call when
// the caller side introduces itself as Waves staff (the triage flags' test, on each line), and on an outbound call
// unless the agent side, and only it, does. The words are the caller's latest turn that says a grounded quote at any
// length, found with the tools' own normalization ("9am" = "9 a.m."), and always the whole turn: a later turn, or a
// later sentence, that takes the choice back is in front of the office.
function callerWordsOf(extraction, { transcript, outbound = false } = {}) {
  const quotes = (Array.isArray(extraction?.evidence) ? extraction.evidence : [])
    .filter((e) => BILLING_CHOICE_PATHS.has(e?.field_path) && e.speaker === 'caller' && typeof e.quote === 'string' && e.quote.trim());
  if (!quotes.length) return null;
  const { parseTurns, turnsHolding, normalize } = require('./call-reschedule-agreement').groundingTools;
  const { orientTranscriptForOutbound, STAFF_INTRO_RE } = require('./call-triage-flags');
  const lines = parseTurns(orientTranscriptForOutbound(transcript, outbound));
  if (!lines || new Set(lines.map((t) => t.agent)).size < 2) return null;
  const introduces = (agent) => lines.some((t) => t.agent === agent && STAFF_INTRO_RE.test(t.raw));
  if (introduces(false) || (outbound && !introduces(true))) return null;
  const turns = [];
  for (const line of lines) {
    const last = turns[turns.length - 1];
    if (last && last.agent === line.agent) last.raw = `${last.raw} ${line.raw}`;
    else turns.push({ agent: line.agent, raw: line.raw });
  }
  for (const turn of turns) turn.ns = normalize(turn.raw);
  const grounded = quotes.filter((e) => turnsHolding(turns, e.quote, 'caller').length).map((e) => normalize(e.quote)).filter(Boolean);
  const turn = turns.filter((t) => !t.agent).reverse().find((t) => grounded.some((ns) => ` ${t.ns} `.includes(` ${ns} `)));
  return turn ? String(turn.raw || '').replace(/\s+/g, ' ').trim() : null;
}

// One call's word (row: WORD_COLUMNS, one read): a word from someone who is not the account holder ({ notHolder: true,
// callLogId, at }), a cancellation or one-time ask ({ contrary: true, callLogId, at }), a price the caller said no to
// ({ declined: true, callLogId, at }), a billing choice with the caller's words ({ choice, callLogId, at, quote }; quote
// from callerWordsOf, null without words), or null (no word, not a two-party conversation, or not read: only a
// 'processed' row's extraction is its last read, as a failed re-read keeps the old one).
function wordOfCall(row) {
  if (row.processing_status !== 'processed' || row.v2_extraction_status !== 'valid') return null;
  const { parseExtraction, isRealConversation } = require('./call-held-visits');
  const extraction = parseExtraction(row.ai_extraction_enriched);
  if (!extraction || !isRealConversation(row, extraction)) return null;
  const cancelFlag = Array.isArray(extraction.triage_flags) && extraction.triage_flags.includes(CANCEL_FLAG);
  const contrary = cancelFlag || CONTRARY_INTENTS.has(extraction.service_request?.service_intent);
  // The call reader's price.caller_response, on the triage rule: the caller said no to the price staff stated and yes
  // to no other price on the call.
  const declined = require('./call-triage-flags').callerDeclinedThePrice(extraction.service_request);
  const choice = require('./call-prepay-choice').billingChoiceOf(extraction);
  if (!contrary && !declined && !choice) return null;
  // Only the account holder's side speaks for the account. A caller the call reader names as anyone else (a tenant, a
  // relative, an agent: the processor's isExplicitlyNonOwner; owner, spouse or partner, and unknown are the holder's
  // side) is never the customer's yes, choice or cancellation, and their word still hides an older yes. Booking keeps
  // its own exceptions (a relative with a confirmed time, owner 2026-09-28); agreeing to a price takes none here, so
  // the office decides. A caller who says the phone is not theirs (caller_id_disclaimed) and does not say they are the
  // owner or the owner's spouse or partner is not shown to be the holder either: the phone linked the call, and
  // 'unknown' is the holder's side (owner 2026-07-31) only because the phone vouches for it.
  const caller = extraction.caller || {};
  const relationship = String(caller.relationship_to_property || '').trim().toLowerCase();
  const statedHolder = relationship === 'owner' || relationship === 'spouse_partner';
  if (require('./call-triage-flags').isExplicitlyNonOwner(relationship) || (caller.caller_id_disclaimed === true && !statedHolder)) {
    return { notHolder: true, callLogId: row.id, at: callStartedAt(row) };
  }
  // Checked before the choice: a call that both names a plan and asks to cancel or for a one-time visit is no yes, and
  // neither is a call that names a plan and says no to its price.
  if (contrary) return { contrary: true, callLogId: row.id, at: callStartedAt(row) };
  if (declined) return { declined: true, callLogId: row.id, at: callStartedAt(row) };
  // Only the recording's transcript is evidence (the processor's recordedFallbackOf). The voice agent's own text and
  // the live-text backup are not: their writers (voice-agent/relay-transcript.js, live-call-transcription.js) cut a
  // long turn at 4,000 characters with no mark, so a cut turn can look whole. A call the agent handed to staff is read
  // in its recorded part only.
  const { isOutboundCall, recordedFallbackOf } = require('./call-recording-processor');
  const quote = callerWordsOf(extraction, { transcript: recordedFallbackOf(row), outbound: isOutboundCall(row) });
  return { choice, callLogId: row.id, at: callStartedAt(row), quote };
}

// The extraction as jsonb in both storage eras: a jsonb object, or a JSON string inside the jsonb column (the unwrap
// day-agreement-shadow.js uses; call-prepay-choice.js reads both eras too).
const EXTRACTION_SQL = "(CASE WHEN jsonb_typeof(call_log.ai_extraction_enriched) = 'string' THEN (call_log.ai_extraction_enriched #>> '{}')::jsonb ELSE call_log.ai_extraction_enriched END)";

// The customer's latest word on a call that began since `since`: the newest read, valid, two-party call whose
// extraction names a billing choice, a cancellation (intent or flag), a one-time ask or a price the caller declined, as
// wordOfCall gives it, or null. SQL keeps only rows that name a word; pages of CHOICE_SCAN_LIMIT follow until one is a two-party conversation,
// so voicemails never hide the last word. Each page starts after the last row read (start time, then id), never at an
// offset: a row that leaves the set between pages (a re-read starts) cannot shift another row past a page. The start
// time is carried as text, so no microsecond is lost. Sandbox calls do not count. `until` (a timestamptz as text, or
// null) keeps only calls that began before it: from then on a call may be about another estimate.
async function latestBillingChoice(conn, { customerId, since, until = null }) {
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const { BILLING_CHOICES } = require('./call-prepay-choice');
  const query = conn('call_log')
    .where({ customer_id: customerId, processing_status: 'processed', v2_extraction_status: 'valid' })
    .whereRaw(`${startedSql()} >= ?`, [since])
    .modify((qb) => { if (until) qb.whereRaw(`${startedSql()} < ?::timestamptz`, [until]); })
    .whereRaw(`NOT ${owedReadSql('call_log')}`)
    .where((qb) => qb
      .whereRaw(`${EXTRACTION_SQL} -> 'service_request' ->> 'billing_choice' = ANY(?)`, [[...BILLING_CHOICES]])
      .orWhereRaw(`${EXTRACTION_SQL} -> 'service_request' ->> 'service_intent' = ANY(?)`, [[...CONTRARY_INTENTS]])
      .orWhereRaw(`${EXTRACTION_SQL} -> 'triage_flags' @> ?::jsonb`, [JSON.stringify([CANCEL_FLAG])])
      .orWhereRaw(`${EXTRACTION_SQL} -> 'service_request' -> 'price' ->> 'caller_response' = 'declined'`))
    .modify((qb) => whereNotSandboxCall(qb))
    .orderByRaw(`${startedSql()} DESC, id DESC`)
    .limit(CHOICE_SCAN_LIMIT)
    .select([...WORD_COLUMNS, conn.raw(`(${startedSql()})::text AS started_key`)]);
  for (let after = null; ;) {
    const page = after ? query.clone().whereRaw(`(${startedSql()}, id) < (?::timestamptz, ?::uuid)`, [after.started_key, after.id]) : query;
    const rows = await page;
    for (const row of rows) {
      const word = wordOfCall(row);
      if (word) return word;
    }
    if (rows.length < CHOICE_SCAN_LIMIT) return null;
    after = rows[rows.length - 1];
  }
}

// The customer's numbers as lookup keys (customerPhoneLookupKey: 10 digits for a NANP number, all digits otherwise),
// from every identity column a call is attributed by (KNOWN_CALLER_PHONE_COLS), on the relink job's rules: only a
// number it may link by (isLinkableKey), never a Waves number (forwarding legs show ours as the contact).
async function customerPhoneKeys(conn, customerId) {
  const { KNOWN_CALLER_PHONE_COLS, customerPhoneLookupKey } = require('../utils/known-caller-phone');
  const { isLinkableKey } = require('./call-log-relink');
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  const row = await conn('customers').where({ id: customerId }).first(KNOWN_CALLER_PHONE_COLS);
  const keys = KNOWN_CALLER_PHONE_COLS.map((col) => row?.[col])
    .filter((phone) => phone && isLinkableKey(phone) && !TWILIO_NUMBERS.isInternalNumber(phone))
    .map(customerPhoneLookupKey);
  return [...new Set(keys)];
}

// A call_log phone column holds one of the numbers, on intake's identity rule (findCustomerPhoneMatches): all its
// digits equal a key, or a NANP key with the country code 1 (contactForms).
const contactMatchSql = (col) => `regexp_replace(call_log.${col}, '\\D', '', 'g') = ANY(?::text[])`;
const contactForms = (keys) => keys.flatMap((key) => (key.length === 10 ? [key, `1${key}`] : [key]));

// Calls with the customer, for the two hold checks only: linked to them, or linked to no one with one of their numbers
// (customerPhoneKeys) as the contact (the caller; on an outbound call, the number called: call-log-relink's
// pickContactPhone, with the processor's case-blind outbound test). Intake links by the primary phone alone, and the
// processor links a service-contact number only after its read (findCustomerForCallContact), so until then a call from
// the customer's other number has no customer. A deliberate unlink stays one, as in the relink job: an operator's
// explicit unlink (NOT_EXPLICITLY_UNLINKED_SQL), or a rejected empty voicemail the processor unlinked. A word is read
// from linked calls only (latestBillingChoice).
function whereWithCustomer(qb, customerId, keys) {
  return qb.where((w) => {
    w.where('call_log.customer_id', customerId);
    if (!keys.length) return;
    const { NOT_EXPLICITLY_UNLINKED_SQL } = require('../utils/call-link-override');
    const { TRANSCRIPTION_REJECTED_SENTINEL } = require('./call-log-relink');
    const forms = contactForms(keys);
    w.orWhere((unlinked) => unlinked.whereNull('call_log.customer_id')
      .whereRaw(NOT_EXPLICITLY_UNLINKED_SQL)
      .whereRaw('call_log.transcription IS DISTINCT FROM ?', [TRANSCRIPTION_REJECTED_SENTINEL])
      .where((contact) => contact
        .where((inbound) => inbound.whereRaw("lower(COALESCE(call_log.direction, '')) NOT LIKE 'outbound%'")
          .whereRaw(contactMatchSql('from_phone'), [forms]))
        .orWhere((outbound) => outbound.whereRaw("lower(call_log.direction) LIKE 'outbound%'")
          .whereRaw(contactMatchSql('to_phone'), [forms]))));
  });
}

// True when a call with the customer (whereWithCustomer) that began since `since` still owes a read (owedReadSql): it
// may hold the yes or take it back. Sandbox calls do not count. A call begins at or before its row's insert, so the
// created_at bound drops no row; it lets the created_at index serve the unlinked calls.
async function unreadCallSince(conn, { customerId, since }) {
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const keys = await customerPhoneKeys(conn, customerId);
  return !!(await conn('call_log')
    .modify(whereWithCustomer, customerId, keys)
    .where('call_log.created_at', '>=', since)
    .whereRaw(`${startedSql()} >= ?`, [since])
    .whereRaw(owedReadSql('call_log'))
    .modify((qb) => whereNotSandboxCall(qb))
    .first('id'));
}

// What stands between the caller's word and the call that booked the visit (`booking`, a CALL_COLUMNS row), or null:
//   yes_after_booking    the yes came on a later call than the booking (the visit was not booked for the plan);
//   booking_call_unread  the booking call's last read did not finish (a failed re-read or an invalid extraction may
//                        hide a no);
//   newer_call           another call with the customer (whereWithCustomer) began since the yes (or, with no yes,
//                        since the booking).
// Times are when each call began (callStartedAt). Call it once every call in the window is read (unreadCallSince).
// Sandbox calls do not count.
async function laterWordProblem(conn, { customerId, yes, booking }) {
  // Start times are compared in SQL, at database precision: a JS Date drops microseconds, so two calls that began in
  // one millisecond would compare equal.
  const startOf = (alias) => require('./sms-pending-conversations').callStartedAtSql(alias);
  const startOfCall = `(SELECT ${startOf('anchor')} FROM call_log anchor WHERE anchor.id = ?)`;
  if (yes && await conn('call_log').where('call_log.id', yes.callLogId).whereRaw(`${startedSql()} > ${startOfCall}`, [booking.id]).first('call_log.id')) {
    return 'yes_after_booking';
  }
  if (booking.processing_status !== 'processed' || booking.v2_extraction_status !== 'valid') return 'booking_call_unread';
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const keys = await customerPhoneKeys(conn, customerId);
  const later = await conn('call_log')
    .modify(whereWithCustomer, customerId, keys)
    // Never cuts a later call (a call begins at or before its insert, and a JS Date only drops microseconds); it lets
    // the created_at index serve the unlinked calls.
    .where('call_log.created_at', '>', yes ? yes.at : callStartedAt(booking))
    .whereRaw(`${startedSql()} > ${startOfCall}`, [yes ? yes.callLogId : booking.id])
    .whereNotIn('id', [yes?.callLogId, booking.id].filter(Boolean))
    .modify((qb) => whereNotSandboxCall(qb))
    .first('id');
  return later ? 'newer_call' : null;
}

// The customer's word since `since` (and before `until`, when given), as the cards read it: a reason for no card ({ skip: 'took_back' |
// 'chose_annual_prepay' }), or the yes and, when there is none, why ({ yes: null, noYes: 'no_yes_heard' |
// 'yes_without_words' | 'caller_not_account_holder' | 'caller_declined_price' }). A yes is the call reader's pay-per-application choice WITH the
// caller's own words ({ yes: { callLogId, at, quote }, noYes: null }); any other choice is no yes a card shows.
async function callerWord(conn, { customerId, since, until = null }) {
  const word = await latestBillingChoice(conn, { customerId, since, until });
  if (word?.notHolder) return { yes: null, noYes: 'caller_not_account_holder' };
  if (word?.contrary) return { skip: 'took_back' };
  if (word?.declined) return { yes: null, noYes: 'caller_declined_price' };
  if (word?.choice === 'annual_prepay') return { skip: 'chose_annual_prepay' };
  if (word?.choice !== 'per_application') return { yes: null, noYes: 'no_yes_heard' };
  if (!word.quote) return { yes: null, noYes: 'yes_without_words' };
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
