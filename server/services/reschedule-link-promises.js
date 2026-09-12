'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { normalizePhone, phoneMatchDigits } = require('../utils/phone');
const { etParts, addETDays } = require('../utils/datetime-et');
const { isWithinSendWindowET, nextSendWindowOpenET } = require('./messaging/send-window');
const { lockTriageCall } = require('../utils/triage-locks');
const { recordAuditEvent } = require('./audit-log');

const KIND = 'send_reschedule_link';
// How long a send waits after losing the customer's advisory interlock.
const LOCK_RETRY_MINUTES = 5;
// Must name EXACTLY the same columns and predicate as the partial unique
// index in migration 20260911000030_outbox_messages_commitment_generation.js
// — Postgres only accepts an ON CONFLICT target that matches an existing
// unique index verbatim, predicate included.
const COMMITMENT_GENERATION_CONFLICT_TARGET = '(commitment_id, commitment_generation) WHERE commitment_id IS NOT NULL';
// Shared by every write that must not act on a row a concurrent markLinkUsed
// has already closed for good: the customer moving themselves is terminal
// (see markLinkUsed), and a write racing behind it on stale, pre-stamp data
// must lose instead of undoing that closure.
const LINK_NOT_YET_RECONCILED = "(payload->>'link_used_reconciled_at') IS NULL";
// Delivery uncertainty ("a provider may already have accepted THIS specific
// commitment_generation's attempt, with no persisted evidence yet") and a
// context error ("we could not evaluate this row on THIS pass") are
// different kinds of knowledge with different lifetimes — the first is a
// permanent fact about one outbox attempt that only definitive provider
// evidence or an explicit office verdict may retire, the second is
// transient and re-derivable on the very next sweep. Overloading last_error
// with both let a stale_extraction or call_not_ready reprocess erase the
// uncertainty the moment it re-parked the row for an unrelated reason, and
// let it silently vanish from a 'sending' row too (codex #4293 P1). Storing
// it under its OWN payload key sidesteps that by construction: parkReview's
// ordinary status/last_error UPDATE never names this key, so every write
// path that does not explicitly ask to touch it leaves it alone.
const DELIVERY_UNCERTAIN_KEY = 'delivery_outcome_uncertain';
// A jsonb-merge fragment for `.update({ payload: ... })` wherever the
// current payload has not already been fetched into JS (a bulk update
// across more than one row, or a caller with no in-hand snapshot) — merges
// under the row's own lock, exactly like markLinkUsed's reconciliation
// stamp, so it can never clobber a sibling payload key written elsewhere.
function deliveryUncertainPatch(conn, value) {
  return conn.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [DELIVERY_UNCERTAIN_KEY]: value })]);
}
const sendContext = new AsyncLocalStorage();
function mode() {
  const value = String(process.env.GATE_RESCHEDULE_LINK_ON_PROMISE || '').toLowerCase();
  return isEnabled('callCommitments') && ['shadow', 'true'].includes(value) ? value : 'off';
}

// A human 'confirm' (or 'reopen') on this commitment stamps human_state
// 'confirmed' while deliberately leaving status 'open' — an affirmative
// review, not a fulfilment or a dismissal. Every place that judges whether
// this promise is still live must read it the same way: null (never
// touched) or 'confirmed' (touched and affirmed) keep it eligible; anything
// else ('dismissed', an edited description that is a NEW obligation) is
// genuinely terminal or superseded and stays excluded (codex #4293 P1 r4).
// Before this, contextFor's bare `commitment.human_state` truthiness check
// treated a Confirm exactly like a Dismiss — closed for good, never staged;
// stagePromises and fulfilPromise carried the identical bug at their own
// human_state filters.
function humanStateBlocksPromise(humanState) {
  return humanState != null && humanState !== 'confirmed';
}

// The extractor has been building send_reschedule_link commitments the
// whole time GATE_CALL_COMMITMENTS was on, independent of whether THIS
// delivery gate was live — days of them can sit open before anyone flips
// GATE_RESCHEDULE_LINK_ON_PROMISE. Staging them all unconditionally the
// moment the gate goes live would text a backlog of stale reschedule links
// at once, on a promise the caller made days ago (codex #4293 P1 r8).
// RESCHEDULE_LINK_PROMISE_ACTIVATED_AT (an ISO instant), when set, always
// wins — read fresh each call so a live env change takes effect without a
// restart, exactly like mode() itself.
const ACTIVATION_SETTINGS_KEY = 'reschedule_link_promise_activated_at';

// Unset, the boundary is READ FROM system_settings (this repo's existing
// generic key/value store — server/models/migrations/
// 20260414000029_geofence_timers.js) rather than derived from anything about
// THIS process. An earlier round used this process's own start time, which
// moved the boundary forward on every restart: a commitment created after
// the last sweep but before a routine deploy would read as pre_activation
// on the very next sweep — a live promise silently lost (codex #4293 P1 r9).
// The first live sweep ANYWHERE to find nothing stored writes now() under
// this key; onConflict + a re-read means a multi-process race still
// converges every process on the SAME winning instant, and every later
// sweep — on this process or after any future restart — just reads it back.
async function persistedActivationBoundary(conn) {
  const existing = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  if (existing?.value) return new Date(existing.value);
  // The DATABASE's clock, not this process's JS clock: call-commitments.
  // upsertCommitments calls recordLiveActivation FIRST inside the very same
  // transaction that later inserts the send_reschedule_link commitment row
  // this boundary is meant to admit, and that row's created_at defaults to
  // CURRENT_TIMESTAMP — which Postgres fixes at TRANSACTION START, not at
  // the moment the INSERT statement runs. A JS `new Date()` read here is a
  // wall-clock sample taken strictly after that transaction already opened,
  // so it lands AFTER the CURRENT_TIMESTAMP the later INSERT will stamp —
  // the very commitment establishing the boundary is born a moment before
  // it and gets silently cancelled as pre_activation on the next sweep, the
  // exact failure this boundary exists to prevent (codex #4293 P1).
  // now()/transaction_timestamp() evaluated in this same transaction is
  // pinned to that identical transaction-start instant, so a commitment
  // this transaction writes is never before its own activation boundary.
  const { rows } = await conn.raw('SELECT now() AS now');
  const now = rows[0].now;
  await conn('system_settings').insert({ key: ACTIVATION_SETTINGS_KEY, value: now.toISOString(), category: 'reschedule_link_promises',
    description: 'First live-activation instant for GATE_RESCHEDULE_LINK_ON_PROMISE; a send_reschedule_link commitment recorded before it is historical, not a live promise.' })
    .onConflict('key').ignore();
  const settled = await conn('system_settings').where({ key: ACTIVATION_SETTINGS_KEY }).first('value');
  return settled?.value ? new Date(settled.value) : now;
}

// The activation concept only means anything once sends are actually LIVE.
// A shadow run (mode 'shadow') never sends anything, but it DOES walk every
// open commitment through runOne exactly like a live sweep — reading (and,
// on the very first LIVE run anywhere, WRITING) the persisted boundary from
// shadow mode fixed that instant at whatever moment shadow testing happened
// to start, weeks before anyone actually went live. Returning null here
// keeps shadow purely observational: it never touches system_settings at
// all, and isPreActivationRow below treats a null boundary as "nothing to
// judge" rather than cancelling anything (codex #4293 P1, round 2 on
// baa4cf295).
async function activationBoundary(conn) {
  if (mode() !== 'true') return null;
  const configured = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
  const parsed = configured ? new Date(configured) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : persistedActivationBoundary(conn);
}

// The boundary has to exist BEFORE the first live commitment does, not on
// the first sweep after it. With the gate live and no env set, every call
// processed between the gate flip and the next five-minute tick recorded a
// legitimate live promise; that first tick then wrote now() as the boundary
// and cancelled all of them as pre_activation, silently (codex #4293 P1 r3).
// call-commitments.upsertCommitments calls this FIRST, inside the very same
// transaction that writes the commitment row, whenever this gate is live —
// so the stored instant is the EARLIER of the first live extraction and the
// first live sweep: insert-if-absent means whichever runs first fixes it and
// nothing later moves it. Shadow and off are no-ops exactly as in
// activationBoundary. THROWS on a genuine write failure — swallowing it here
// used to let the commitment upsert still commit un-boundaried; a later
// healthy sweep would then persist a LATER boundary and silently cancel that
// legitimate live promise as pre_activation, with no card and no send (codex
// #4293 P2 r4). Sharing the transaction means the failure now rolls the
// commitment write back with it instead: nothing is left half-recorded, and
// the next pass retries both together.
async function recordLiveActivation(conn = db) {
  await activationBoundary(conn);
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dateOnly = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10);
const snapshot = (v) => ({ id: v.id, customer_id: v.customer_id, date: dateOnly(v.scheduled_date),
  start: String(v.window_start || '').slice(0, 5), end: String(v.window_end || '').slice(0, 5), property_id: v.property_id || null });

const sameVisitSnapshot = (a, b) => ['id', 'customer_id', 'date', 'start', 'end', 'property_id']
  .every((key) => (a[key] ?? null) === (b[key] ?? null));

// ── The promise ───────────────────────────────────────────────────────────
// The kind label alone never proves the promised link MOVES this appointment.
// "I'll text you a link" fits a website or a first booking just as well, and
// an account with one eligible visit would then be sent a live reschedule
// link for a conversation that never asked for one (codex #4293 r1/r2 P1).

// Unambiguous — the word itself means moving something already scheduled.
const RESCHEDULE_WORD = /\breschedul\w*\b|\bre schedul\w*\b/;
// A move verb applied to a time or to the appointment itself. "pick a time" /
// "choose a time" are deliberately absent: generic slot selection reads the
// same on a first booking (codex #4293 r2 P1).
const MOVE_INTENT = /\b(?:move|moving|change|changing|switch|switching|push|pushing)\b[a-z0-9 ]{0,40}\b(?:time|times|day|days|date|dates|slot|slots|window|appointment|appt|visit)\b/;
// A different slot named AGAINST the appointment the caller already has.
const EXISTING_SLOT = /\b(?:new|another|different|better) (?:time|day|date|slot|window)\b[a-z0-9 ]{0,40}\b(?:appointment|appt|visit|service)\b|\b(?:your|that|the) (?:existing|current|upcoming|scheduled) (?:appointment|appt|visit)\b/;
// Wording that means a FIRST appointment. It vetoes the promise however the
// rest of the quote reads — "a link to choose a time for your new service" is
// a booking link, not a reschedule link.
const NEW_BOOKING = /\b(?:new|first|initial) (?:service|customer|account|appointment|appt|visit|booking|job|treatment)\b|\bget (?:you |your )?(?:set up|started|scheduled|on the schedule|on our schedule)\b|\bsign (?:you )?up\b|\b(?:book|schedule) (?:a|an|your) (?:new|first)\b/;
// The agent taking it back after promising it ("actually I can't send that
// link, the office will call"). The caller's own refusal is handled
// separately — this one scans the agent's LATER turns (codex #4293 r2 P1).
const AGENT_RETRACTION = /\b(?:can t|cannot|won t|will not|unable to|not able to|don t|do not|no longer)\b[a-z0-9 ]{0,25}\b(?:send|text|email|link)\b|\b(?:scratch that|never mind|nevermind|disregard that|forget that)\b|\bthe office will (?:call|reach out|follow up|handle)\b/;
const CONDITIONAL = /\b(?:not|never|unless|if|until|once|maybe|might|cannot)\b|\b(?:don|won|can) t\b/;
// The caller's own refusal, with the channel it names: "don't email it" is
// group 1, "don't send me a text" is group 2, and a bare "don't send the
// link" names no channel at all (both groups empty — refuses everything).
// The second branch's object phrase has to reach a channel word named via
// "by/via/through" against a pronoun object too — "do not send the link by
// text" and "please don't send that by text" both name the link's OBJECT
// ("the link" / "that") before the preposition that actually names the
// channel, and a determiner list that stopped at "the link" (with no
// preposition option at all) left the match ending right after "send",
// stranding "by text" outside it — the exact gap that let the bare word
// "text" a few characters later misread as a NEW request superseding a
// refusal that, in truth, named text all along (codex #4293 P1).
const CALLER_REFUSAL = /\b(?:don t|do not|no need|never mind|nevermind)\b[a-z0-9 ]{0,20}?\b(?:(email|emailing|e mail|text|texting|sms)|(?:link|send|sending)(?:\s+(?:me|us)?\s*(?:a|an|the|any|another|that|it)?\s*(?:link\s+)?(?:by\s+|via\s+|through\s+)?(email|e mail|text|sms)\b)?)/g;
// "no texts please" / "no more emails" — a refusal shape CALLER_REFUSAL's own
// prefix list never covered (it names no "don't"/"do not"/etc. at all), but
// one this worker still has to honor. Scoped tight — the channel word must be
// the very next word after "no" (an optional "more" aside) — so it cannot
// fire on an unrelated "no" earlier in an otherwise affirmative turn ("no,
// that works, text it") the way a wide "no ... text" window would.
const NO_CHANNEL_REFUSAL = /\bno\s+(?:more\s+)?(texts?|texting|sms|emails?|emailing|e mail)\b/g;
// Which channel a matched refusal word names — shared by both CALLER_REFUSAL
// (via refusedChannel) and NO_CHANNEL_REFUSAL, so there is exactly one place
// that decides what "text"/"texts"/"sms" vs. "email"/"emails" means.
function refusalChannelWord(word) {
  if (/^(?:email|emailing|e mail|emails)$/.test(word)) return 'email';
  return /^(?:text|texting|sms|texts)$/.test(word) ? 'sms' : 'any';
}
// An explicit ASK for the text — the caller telling the agent to send it, not
// merely the channel noun surfacing again later in the same breath ("...by
// text", already inside the refusal's own match above) or in an entirely
// separate refusal of its own ("no texts please", its own NO_CHANNEL_REFUSAL
// match). Round 4's genuine supersession ("don't email me the link... actually,
// text it to me") is exactly this shape: an affirmative ask, in a later
// clause, naming the channel the caller now wants. A bare "text" with no ask
// around it must never flip a standing refusal back to permitted (codex
// #4293 P1) — this is a consent boundary, so the phrasing that counts as a
// request has to be a genuine one: "text it/that/me/us", "send me/us a/the
// text", or an explicit "yes/actually/instead/please, text" turn.
const TEXT_REQUEST = /\btext (?:it|that|this|me|us)\b|\b(?:send|shoot) (?:me|us) (?:a |an |the )?text\b|\b(?:yes|actually|instead|please) (?:just )?text\b/g;
// This worker has exactly ONE pipeline: an SMS to the caller's own phone.
// "I'll EMAIL you a reschedule link" is a promise it cannot keep, and quietly
// texting it instead delivers the link on a channel the agent never named (or
// is blocked outright by the SMS consent check). Those go to the office
// (codex #4293 r3 P2) — the email pipeline is separate work.
const SENDABLE_CHANNELS = new Set(['', 'sms', 'text', 'texts', 'text message', 'unknown']);
const EMAIL_PROMISE = /\bemail\b|\be mail\b|\bemailing\b/;
const TEXT_PROMISE = /\btext\b|\btexting\b|\bsms\b/;

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

// Who the call is with, and whether it can be read at all.
function callerIdentityReason(call, customer) {
  if (!call?.customer_id || call.customer_id !== customer?.id || !normalizePhone(customer.phone)
    || !phoneMatchDigits(customer.phone).length
    || normalizePhone(customer.phone) !== normalizePhone(String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone)) return 'customer_identity';
  // /reschedule/:token refuses a non-active account (accountInactive), so a
  // link promising a cancelled customer a new time is a dead end — hold the
  // same explicit `active === true` the page requires (codex #4293 r1 P1).
  if (customer.active !== true) return 'customer_inactive';
  if (call.v2_extraction_status !== 'valid' || call.ai_extraction_enriched?.meta?.is_spam
    || call.ai_extraction_enriched?.meta?.is_voicemail || call.processing_token) return 'call_not_ready';
  return null;
}

// The channel this promise named, when it named one the worker cannot keep.
// Both halves matter: the extracted channel field, and a quote that says
// "email" without also saying "text" — a model that leaves channel null still
// must not turn an emailed link into an SMS.
function unsendableChannel(commitment, promisedQuotes) {
  if (!SENDABLE_CHANNELS.has(String(commitment.channel || '').toLowerCase().trim())) return true;
  return promisedQuotes.length > 0
    && promisedQuotes.every((quote) => EMAIL_PROMISE.test(quote) && !TEXT_PROMISE.test(quote));
}

// The agent quotes that still STAND as a promise to text a link: spoken by
// the agent, unconditional in their own turn, and not withdrawn later in the
// call.
// norm() strips apostrophes to a bare space, so "I'll" reads as "i ll",
// "I'm going to" as "i m going to", and "we're going to" as "we re going
// to". The alternation below has to spell out every contracted form
// norm() can produce for these tenses, not just the uncontracted ones —
// "i m going to" and "we re going to" were missing outright, dropping a
// high-confidence, uniquely-grounded standing promise into
// promise_needs_review for wording that means exactly the same thing as
// "I am going to" (codex #4293 P2 r4).
const STANDING_PROMISE_TENSE = /\b(?:i|we) (?:ll|will|am going to|m going to|are going to|re going to|am sending|m sending|are sending|re sending)\b|\blet me\b/;
function standingPromiseQuotes(commitment, turns) {
  if (!turns?.agent?.length) return [];
  return (commitment.evidence || []).filter((e) => e.speaker === 'agent').map((e) => norm(e.quote))
    .filter((quote) => /\blink\b/.test(quote) && /\b(send|text|email|sending|texting)\b/.test(quote)
      && STANDING_PROMISE_TENSE.test(quote))
    .filter((quote) => {
      const spokenAt = turns.agent.findIndex((turn) => turn.includes(quote) && !CONDITIONAL.test(turn));
      return spokenAt >= 0 && !turns.agent.slice(spokenAt + 1).some((turn) => AGENT_RETRACTION.test(turn));
    });
}

// Which channel a caller refusal names: this worker only ever texts, so a
// refusal of email alone leaves its promise standing.
function refusedChannel(match) {
  return refusalChannelWord(match[1] || match[2] || '');
}

// Whether the caller's refusal of the TEXT still stands once the agent has
// promised it. Only turns AFTER the promise count — a caller who opened with
// "don't email me the link" and then asked for a text has refused nothing the
// agent went on to promise — and the refusal has to reach this channel:
// "don't email it, text it" refuses the email and asks for the text in one
// breath, and a later "text it to me" withdraws an earlier refusal of the
// text. A whole-call, channel-blind scan parked every one of those as
// promise_needs_review (codex #4293 P2 r3). Events are replayed in spoken
// order, so the last word on the text wins; the agent's own retraction is
// standingPromiseQuotes' business and unchanged.
function callerRefusedText(ordered, promiseAt) {
  let refused = false;
  for (const turn of ordered.slice(promiseAt + 1)) {
    if (turn.speaker !== 'caller') continue;
    // Both refusal shapes this turn might carry — CALLER_REFUSAL's own
    // negation prefixes, and the bare "no text(s)" shape it never covered —
    // feed the SAME event stream, so a request below is checked against
    // every refusal clause on the turn, not just one family of them.
    const events = [
      ...[...turn.text.matchAll(CALLER_REFUSAL)].map((m) => ({ at: m.index, end: m.index + m[0].length, refuses: refusedChannel(m) })),
      ...[...turn.text.matchAll(NO_CHANNEL_REFUSAL)].map((m) => ({ at: m.index, end: m.index + m[0].length, refuses: refusalChannelWord(m[1]) })),
    ];
    for (const m of turn.text.matchAll(TEXT_REQUEST)) {
      // An affirmative ask whose own match falls inside a refusal's clause
      // (e.g. the "text" that CALLER_REFUSAL's widened object phrase already
      // consumed out of "send the link by text") is that refusal's own
      // object, not a later request overturning it — the refusal's own
      // clause can never supply the token that reverses it (codex #4293 P1).
      if (!events.some((e) => m.index >= e.at && m.index < e.end)) events.push({ at: m.index, requests: true });
    }
    for (const event of events.sort((a, b) => a.at - b.at)) {
      if (event.requests) refused = false;
      else if (event.refuses !== 'email') refused = true;
    }
  }
  return refused;
}

// A subject is grounded only when it NAMES the visit — a bare quote with no
// date/service/address binds nothing, so it cannot stand in for rescheduling
// language.
function subjectNotGrounded(subject, call) {
  return !!subject && (!subject.quote || !norm(call.transcription).includes(norm(subject.quote))
    || [subject.service, subject.address].some((value) => value && !norm(subject.quote).includes(norm(value))));
}

// Ground a stated date against an EXISTING appointment. quoteBindsConfirmedSlot
// is the NEW-BOOKING slot validator — it demands a slot 1–6 ET days out plus a
// weekday word and a time word, so ordinary subjects like "my September 20
// appointment", or any visit more than a week away, were thrown out even when
// the date matched exactly (codex #4293 r3 P2). An existing appointment has a
// date of record instead: the candidate's own ET date must equal the stated
// one, and nothing the quote SAYS about the date may contradict it.
function quoteContradictsVisitDate(quote, ymd) {
  const q = ` ${norm(quote)} `;
  const [year, month, day] = String(ymd).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return true;
  // A calendar date is timezone-free, so the UTC weekday of the ET wall date
  // is exact.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  // "August 9" against a September visit, or "September 27" against the 20th.
  for (const [index, name] of MONTH_NAMES.entries()) {
    const spoken = q.match(new RegExp(`\\b${name}\\b\\s*(\\d{1,2})?`));
    if (!spoken) continue;
    // "may" is an ordinary verb too — it only reads as a month with a day on it.
    if (name === 'may' && !spoken[1]) continue;
    if (index + 1 !== month) return true;
    if (spoken[1] && Number(spoken[1]) !== day) return true;
  }
  // "the 27th" against the 20th.
  const ordinal = q.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ordinal && Number(ordinal[1]) !== day) return true;
  // "Friday" against a Tuesday visit.
  return WEEKDAY_NAMES.some((name, index) => index !== weekday && new RegExp(`\\b${name}\\b`).test(q));
}

// Positive grounding for an extracted appointment date: quoteContradictsVisitDate
// only rejects a quote that says something ELSE, so "my appointment tomorrow"
// sails through unexamined and binds whatever date the model happened to pick
// — right or wrong — the moment some candidate visit shares it. With more than
// one open visit that is not a check, it is a coin flip (codex #4293 P1).
//
// An EXPLICIT claim — an absolute month+day, an ordinal-only day, or a
// today/tomorrow/next-<weekday> token resolved against the call's own Eastern
// date — must be checked FIRST and must match the extracted date exactly; a
// bare weekday name is a DAY OF WEEK, not a date, and is only trusted as a
// last resort when the quote makes no explicit claim at all. Checking the
// weekday first — as an earlier round of this fix did — let "my appointment
// tomorrow, Tuesday" ground Jan 15 for a Jan 7 (Tuesday) call with visits on
// Jan 8 AND Jan 15 (also a Tuesday): the bare "Tuesday" matched before
// "tomorrow" (which actually resolves to Jan 8) ever got a look (codex #4293
// P1 r2).
function explicitQuoteDate(q, reference) {
  for (const [index, name] of MONTH_NAMES.entries()) {
    const spoken = q.match(new RegExp(`\\b${name}\\b\\s*(\\d{1,2})?`));
    // "may" is an ordinary verb too — it only reads as a month with a day on it.
    if (spoken?.[1]) return { month: index + 1, day: Number(spoken[1]) };
  }
  const ordinal = q.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ordinal) return { day: Number(ordinal[1]) }; // "the 14th" — month-agnostic.
  if (!(reference instanceof Date) || Number.isNaN(reference.getTime())) return null;
  const ref = etParts(reference);
  if (/\btoday\b/.test(q)) return ref;
  if (/\btomorrow\b/.test(q)) return etParts(addETDays(reference, 1));
  for (const [index, name] of WEEKDAY_NAMES.entries()) {
    if (!new RegExp(`\\bnext ${name}\\b`).test(q)) continue;
    const aheadFromToday = (index - ref.dayOfWeek + 7) % 7;
    return etParts(addETDays(reference, aheadFromToday === 0 ? 7 : aheadFromToday + 7));
  }
  return null;
}

function weekdayOf(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// A bare weekday name only grounds the pick when it could not have meant
// anything else: exactly one of the customer's open visits falls on that
// weekday at all, and it is the very one the model selected. Two Tuesdays
// open ("Jan 8" and "Jan 15") leaves "Tuesday" unable to tell them apart, so
// neither is grounded by the word alone.
function quoteNamesWeekday(q, weekday, candidates, ymd) {
  if (!new RegExp(`\\b${WEEKDAY_NAMES[weekday]}\\b`).test(q)) return false;
  const onWeekday = candidates.filter((v) => weekdayOf(dateOnly(v.scheduled_date)) === weekday);
  return onWeekday.length === 1 && dateOnly(onWeekday[0].scheduled_date) === ymd;
}

function quoteHasWeekdayToken(q) {
  return WEEKDAY_NAMES.some((name) => new RegExp(`\\b${name}\\b`).test(q));
}

// True once the quote itself grounds the extracted date. An explicit claim
// (absolute date, ordinal day, or today/tomorrow/next-weekday) must equal it
// exactly, with NO exemption for a sole remaining candidate: a caller on
// 2030-01-07 saying "tomorrow" (2030-01-08) while the model extracts
// 2030-01-15 must still park even when 2030-01-15 is the only open visit —
// letting a single candidate through unchecked sent the link for the wrong
// appointment the moment the model's bad pick happened to be the one row on
// file (codex #4293 P1 r3). Absent any explicit claim, a bare weekday name
// must likewise match the visit it names; only when the quote gives NEITHER
// an explicit claim NOR a weekday name at all is there nothing to check the
// pick against, and a single open candidate is trusted.
//
// An explicit claim that leaves a component unsaid is NOT a wildcard for the
// model to fill in: "my appointment on the 20th" resolves a day and nothing
// else, and treating the missing month as "whatever the model picked" let a
// February extraction narrow Jan 20 / Feb 20 to one and send the link for a
// visit the quote never identified (codex #4293 P1 r3). The claim grounds
// the pick only when the components it DID resolve single that date out
// among the open visits — two candidates that agree on everything the quote
// said leave the quote grounding neither.
function claimFitsDate(claim, ymd) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  return claim.day === day && (claim.month == null || claim.month === month) && (claim.year == null || claim.year === year);
}

function quoteGroundsVisitDate(quote, ymd, reference, candidates = []) {
  const q = ` ${norm(quote)} `;
  const [year, month, day] = String(ymd).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return false;
  const explicit = explicitQuoteDate(q, reference);
  if (explicit) {
    if (!claimFitsDate(explicit, ymd)) return false;
    const fitting = new Set(candidates.map((v) => dateOnly(v.scheduled_date)).filter((date) => claimFitsDate(explicit, date)));
    return fitting.size <= 1;
  }
  if (quoteHasWeekdayToken(q)) return quoteNamesWeekday(q, weekdayOf(ymd), candidates, ymd);
  return candidates.length <= 1;
}

function narrowBySubject(candidates, subject) {
  let selected = candidates;
  if (subject?.visit_date) {
    selected = selected.filter((v) => dateOnly(v.scheduled_date) === subject.visit_date
      && !quoteContradictsVisitDate(subject.quote, subject.visit_date));
  }
  if (subject?.service) selected = selected.filter((v) => norm(v.service_type || v.service_name).includes(norm(subject.service)));
  if (subject?.address) selected = selected.filter((v) => require('./estimator-engine/address-compare').sameStreetAddress(
    [v.service_address_line1 || v.property_address, v.service_address_line2 || v.property_unit].filter(Boolean).join(' '),
    subject.address, { requireExactUnit: true }));
  return selected;
}

// Can the customer actually move THIS row from the public page? The page's own
// verdict answers the time AND status question: a pending/confirmed visit
// whose window has passed was MISSED, not served, and /reschedule/:token
// still lets the customer pick a new time — the call that follows a missed
// visit is the one most likely to be promised this link, and a local "two
// hours past the start" rule turned every one of them away (codex #4293 r3
// P2). A separate local status allowlist made the same mistake for
// 'rescheduled': the page's own eligibility() already treats a future
// 'rescheduled' row as self-service (RESCHEDULABLE_STATUSES), so a
// duplicate, narrower allowlist here parked a link the customer could
// already use the page for (codex #4293 P1 r8). Group membership and the
// token stay here; eligibility() alone decides status AND missed-vs-past.
function visitNotSelfServiceReason(visit, now) {
  if (!visit.reschedule_token || (visit.visit_id && visit.follow_through_group_eligible !== true)) return 'visit_not_self_service';
  const verdict = require('./reschedule-eligibility').eligibility(visit, now);
  if (verdict.ok) return null;
  return verdict.reason === 'past' ? 'visit_elapsed' : 'visit_not_self_service';
}

// A wrong extraction cannot be trusted on the quote's own say-so — see
// quoteGroundsVisitDate for the full rule, including why a sole remaining
// candidate is NOT exempt from a contradicted explicit claim.
function extractedDateUngrounded({ subject, call, candidates, callCommitments }) {
  return !!subject?.visit_date
    && !quoteGroundsVisitDate(subject.quote, subject.visit_date, callCommitments.callEndedAt(call) || call.created_at, candidates);
}

// Whether the caller ever refused the SMS channel AFTER the agent's own
// promise turn — split out of selectDiscussedVisit so that function's own
// branch count stays where a reviewer can still take it in at a glance.
function revokedAfterPromise(promisedQuotes, ordered) {
  const promiseAt = ordered.findIndex((turn) => turn.speaker === 'agent' && !CONDITIONAL.test(turn.text)
    && promisedQuotes.some((quote) => turn.text.includes(quote)));
  return promiseAt >= 0 && callerRefusedText(ordered, promiseAt);
}

function selectDiscussedVisit({ commitment, call, customer, candidates = [], now = new Date() }) {
  const skip = (reason) => ({ reason });
  const identity = callerIdentityReason(call, customer);
  if (identity) return skip(identity);
  const callCommitments = require('./call-commitments');
  const turns = callCommitments.speakerTurns(call.transcription);
  const promisedQuotes = standingPromiseQuotes(commitment, turns);
  const revoked = revokedAfterPromise(promisedQuotes, turns?.ordered || []);
  const subject = commitment.subject;
  if (subjectNotGrounded(subject, call)) return skip('subject_not_grounded');
  const groundedSubject = !!subject && [subject.visit_date, subject.service, subject.address].some(Boolean);
  if (unsendableChannel(commitment, promisedQuotes)) return skip('channel_unsupported');
  const aboutThisAppointment = !promisedQuotes.some((quote) => NEW_BOOKING.test(quote))
    && (groundedSubject || promisedQuotes.some((quote) => RESCHEDULE_WORD.test(quote) || MOVE_INTENT.test(quote) || EXISTING_SLOT.test(quote)));
  if (revoked || !promisedQuotes.length || !aboutThisAppointment
    || !Number.isFinite(Number(commitment.confidence)) || Number(commitment.confidence) < 0.9) return skip('promise_needs_review');
  if (extractedDateUngrounded({ subject, call, candidates, callCommitments })) return skip('date_not_grounded');
  const selected = narrowBySubject(candidates, subject);
  if (selected.length !== 1) return skip(selected.length ? 'ambiguous_visit' : 'discussed_visit_unavailable');
  const notReady = visitNotSelfServiceReason(selected[0], now);
  return notReady ? skip(notReady) : { visit: selected[0] };
}

async function contextFor(conn, commitmentId, now) {
  const raw = await conn('call_commitments').where({ id: commitmentId, kind: KIND, party: 'waves' }).first();
  const commitment = raw ? require('./call-commitments').normalizeRow(raw) : null;
  if (!commitment?.call_log_id || commitment.status !== 'open' || humanStateBlocksPromise(commitment.human_state)) return { reason: 'promise_closed' };
  const call = await conn('call_log').where({ id: commitment.call_log_id }).first();
  if (!call || (commitment.source === 'ai' && Number(commitment.last_seen_generation) !== Number(call.processing_generation))) return { reason: 'stale_extraction' };
  const customer = call.customer_id ? await conn('customers').where({ id: call.customer_id }).whereNull('deleted_at').first() : null;
  if (require('./internal-test-customers').isInternalTestCustomerId(customer?.id)) return { reason: 'internal_test_customer' };
  const candidates = customer ? await conn('scheduled_services as s').leftJoin('customer_properties as p', 'p.id', 's.property_id')
    .where('s.customer_id', customer.id).whereIn('s.status', ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'])
    .select('s.*', 'p.address_line1 as property_address', 'p.address_line2 as property_unit') : [];
  for (const candidate of candidates) {
    candidate.follow_through_group_eligible = await require('./reschedule-link').hasUnblockedVisitGroup(conn, candidate.visit_id);
  }
  return { commitment, call, customer, ...selectDiscussedVisit({ commitment, call, customer, candidates, now }) };
}

async function visitLinkNeedles(conn, visit) {
  const target = require('../utils/portal-url').portalUrl(`/reschedule/${visit.reschedule_token}`);
  const codes = await conn('short_codes').where({ kind: 'reschedule', entity_type: 'scheduled_services', entity_id: visit.id, target_url: target }).pluck('code');
  return [target, ...codes.map((code) => `${require('./short-url').baseUrl()}/l/${code}`)].map((url) => url.replace(/^https?:\/\//, ''));
}

function carriesVisitLink(body, needles) {
  return needles.some((needle) => new RegExp(`(?:^|[\\s<(\"'])(?:https?:\\/\\/)?${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s>),.!?;:#])`).test(String(body || '')));
}

async function matchingSend(conn, context, since) {
  if (!context.visit || !context.customer) return null;
  const needles = await visitLinkNeedles(conn, context.visit);
  const messages = await conn('sms_log').where({ customer_id: context.customer.id, direction: 'outbound' })
    .where('created_at', '>=', since).whereIn('status', ['queued', 'accepted', 'sending', 'sent', 'delivered', 'read'])
    .whereIn(conn.raw("regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g')"), phoneMatchDigits(context.customer.phone))
    // Only a row the provider actually accepted is evidence, and the
    // provider's own id is the one thing every real send carries
    // (twilio.js writes twilio_sid: message.sid on the row it inserts after
    // the handoff). Two SID-less sms_log shapes otherwise pass the status
    // allowlist above: push-channel-routing's App-notification proof row
    // (status 'sent', from_phone 'push', twilio_sid null — codex #4293 P2
    // r8), and a scheduled operator text that claimDueScheduledSms
    // (scheduler.js) has moved to 'sending' BEFORE the provider call — if
    // that send is then blocked or returned to 'scheduled', a promise
    // settled 'sent' against it has no provider id, no delivery evidence,
    // and no pending row left to claim: the link is never sent and never
    // surfaced (codex #4293 P2 r3). Requiring the SID covers both.
    .whereNotNull('twilio_sid')
    .where(function carriesLink() { for (const needle of needles) this.orWhere('message_body', 'like', `%${needle}%`); })
    .orderBy('created_at', 'desc').limit(201).select('id', 'twilio_sid', 'status', 'created_at', 'customer_id', 'to_phone', 'message_body');
  if (messages.length > 200) throw new Error('Promised-link delivery evidence is truncated');
  return messages.find((sms) => carriesVisitLink(sms.message_body, needles)) || null;
}

// Retiring delivery uncertainty is its OWN operation with its own trigger —
// definitive provider evidence for THIS attempt (a delivered/read receipt, or
// a failed/undelivered one), or an explicit office verdict — and it must
// never be threaded as an option through some OTHER transition's write. That
// threading is exactly what kept breaking this: a parked-state guard ate the
// clear when a failure receipt arrived after the attempt was already parked,
// a generation guard ate it when a success receipt arrived for a generation
// the commitment had already moved past, and — the shape named here —
// parkReview's own reason-unchanged no-op optimisation ate it when a receipt
// arrived whose park reason happened to match the reason already on the row
// (codex #4293 P1, three separate rounds). This function carries no reason
// and no status predicate belonging to any other concern — only the
// COALESCE jsonb merge every other payload write in this file uses, so it
// can never collide with whatever else a concurrent writer does to the row's
// payload in the same breath. The one guard it DOES keep — an already
// delivered/cancelled row — is a legitimate no-op, not a borrowed one: that
// row's own transition already retired the flag, or it never mattered.
async function retireDeliveryUncertainty(conn, rowId) {
  await conn('outbox_messages').where({ id: rowId }).whereNotIn('status', ['delivered', 'cancelled'])
    .update({ payload: deliveryUncertainPatch(conn, false), updated_at: new Date() });
}

async function parkReview(conn, row, reason) {
  await conn.transaction(async (trx) => {
    await lockTriageCall(trx, row.related_call_log_id);
    // runOne reads row.payload.link_used_reconciled_at (its "already
    // settled, terminal" check) from a snapshot fetched BEFORE this
    // function's own call lock is acquired. A concurrent public reschedule
    // can run markLinkUsed — which takes the SAME lock, closes the card, and
    // stamps the row — in the gap between that read and this transaction
    // starting; the lock only serializes the two writers, it doesn't make
    // the stale read behind this call valid. Without the stamp-is-null
    // condition here, this UPDATE would go ahead and re-park a row
    // markLinkUsed already closed for good, reopening a card that later
    // reconciliation (unreconciledPromiseRows) will never revisit because
    // the stamp already excludes it (codex #4293 P1).
    const changed = await trx('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
      .whereRaw(LINK_NOT_YET_RECONCILED)
      .whereRaw("(status <> 'review' OR last_error IS DISTINCT FROM ?)", [reason])
      .update({ status: 'review', last_error: reason, updated_at: new Date() });
    if (!changed) return;
    // One card per CALL, but it has to name every promise parked against that
    // call. A card carrying only the first commitment id was resolved the
    // moment that first promise settled, marking the call resolved while a
    // second row sat in review with nothing pointing at it (codex #4293 r3
    // P2). commitment_id stays for older rows; commitment_ids is the list.
    const existing = await trx('triage_items').where({ call_log_id: row.related_call_log_id, reason_code: 'reschedule_link_promise' })
      .whereIn('status', ['open', 'in_progress']).first('id', 'payload');
    if (!existing) {
      await trx('triage_items').insert({ call_log_id: row.related_call_log_id, related_customer_id: row.related_customer_id,
        related_scheduled_service_id: row.related_scheduled_service_id, category: 'customer_followup', severity: 'advisory',
        reason_code: 'reschedule_link_promise', status: 'open', summary: 'A promised reschedule link needs attention.',
        payload: { reschedule_link_promise: { commitment_id: row.commitment_id, commitment_ids: [row.commitment_id], reason } } });
    } else {
      const parked = promiseCommitmentIds(existing.payload);
      if (!parked.includes(row.commitment_id)) {
        await trx('triage_items').where({ id: existing.id }).update({
          payload: { ...existing.payload, reschedule_link_promise: { ...(existing.payload?.reschedule_link_promise || {}),
            commitment_ids: [...parked, row.commitment_id], reason } },
          summary: `${parked.length + 1} promised reschedule links need attention.`, updated_at: new Date() });
      }
    }
    await trx('call_log').where({ id: row.related_call_log_id }).update({ review_status: 'open', updated_at: new Date() });
    await recordAuditEvent({ actor_type: 'system', action: 'reschedule_link_needs_review', resource_type: 'call_commitment', resource_id: row.commitment_id,
      metadata: { reason, outbox_id: row.id }, critical: true, trx });
  });
}

// Which promises a reschedule_link_promise card still speaks for.
function promiseCommitmentIds(payload) {
  const promise = payload?.reschedule_link_promise || {};
  const ids = Array.isArray(promise.commitment_ids) ? promise.commitment_ids : [];
  return ids.length ? ids : [promise.commitment_id].filter(Boolean);
}

// admin-triage.js's specialized-card hook, exactly like property_role_confirm
// (applyPropertyRoleProposals) and the email review cards (first_touch_holds
// release): a triage action on THIS reason code is not a call-routing
// judgment, and closing the card without settling the promise it names left
// the call_commitments row open and the outbox row parked in 'review'
// forever, with nothing left to ever raise a card for it again — parkReview
// only (re)creates one when the outbox row's own status or last_error
// actually changes (codex #4293 P1). Called from transitionCore INSIDE the
// same transaction that flips the card's own status, for both terminal
// actions: 'resolved' ("office handled it") and 'dismissed' ("not needed").
// Settlement rides the SAME human-verdict mechanism every other commitment
// action uses (call-commitments.applyHumanUpdate) rather than a second
// status writer (AGENTS.md L417-L422), so the audit trail and human_state
// semantics stay one path. Only a commitment STILL open is touched — one an
// actual delivery already fulfilled in the interim is left exactly as
// delivery left it, and its own card-clearing already ran through
// clearPromiseException.
async function settleParkedPromiseCard(trx, item, { action, reviewedBy = null, note = null } = {}) {
  const ids = promiseCommitmentIds(item.payload);
  if (!ids.length) return;
  const openIds = await trx('call_commitments')
    .where({ call_log_id: item.call_log_id, kind: KIND, party: 'waves', status: 'open' })
    .whereIn('id', ids).pluck('id');
  const { applyHumanUpdate } = require('./call-commitments');
  for (const id of openIds) {
    await applyHumanUpdate(trx, id, { action: action === 'dismissed' ? 'dismiss' : 'fulfill', reviewedBy, note, renewalAudit: false });
  }
  // Every outbox row this card still speaks for, whatever lane it is
  // sitting in (review, or — a card can be reviewed before a send is even
  // attempted — pending/shadow) and not already terminal, stops here: no
  // further sweep may retry, park, or re-park it once the office has ruled.
  // This IS an explicit office verdict, so it also retires any delivery
  // uncertainty those rows were carrying — a bulk update over however many
  // rows this card names, so the jsonb merge (not an in-hand payload spread)
  // is what keeps each row's OTHER payload keys intact.
  await trx('outbox_messages').where({ related_call_log_id: item.call_log_id }).whereIn('commitment_id', ids)
    .whereNotIn('status', ['delivered', 'cancelled'])
    .update({ status: 'cancelled', last_error: action === 'dismissed' ? 'dismissed_by_office' : 'resolved_by_office', updated_at: new Date(),
      payload: deliveryUncertainPatch(trx, false) });
  await recordAuditEvent({ actor_type: reviewedBy ? 'technician' : 'system', actor_id: reviewedBy,
    action: action === 'dismissed' ? 'reschedule_link_promise_dismissed' : 'reschedule_link_promise_resolved',
    resource_type: 'triage_item', resource_id: item.id, metadata: { commitment_ids: ids, settled_ids: openIds }, critical: true, trx });
}

// The card this promise's own exceptions raise. One promise reaching a
// terminal state — delivered, or closed by the office — drops only ITS id;
// the card resolves when the last parked promise on the call is gone, so a
// second obligation never disappears with the first. Unrelated call flags are
// untouched, and review_status re-syncs the way admin-triage transitionCore
// does.
async function clearPromiseException(trx, callLogId, commitmentId, note) {
  const cards = await trx('triage_items').where({ call_log_id: callLogId, reason_code: 'reschedule_link_promise' })
    .whereIn('status', ['open', 'in_progress']).select('id', 'payload');
  // A normal, never-parked delivery calls this too (fulfilPromise runs on
  // EVERY successful send, not only a recovered one) — with no card ever
  // raised for this commitment, there is nothing to clear, and the
  // unconditional resync below used to force review_status to 'resolved'
  // regardless, clobbering an intentional null (never touched) or a
  // 'dismissed' the office set independently of this promise's own card
  // (codex #4293 P2). Only a card THIS commitment actually changed may
  // resync the call's aggregate status.
  let changed = false;
  for (const card of cards) {
    const parked = promiseCommitmentIds(card.payload);
    if (!parked.includes(commitmentId)) continue;
    changed = true;
    const rest = parked.filter((id) => id !== commitmentId);
    if (rest.length) {
      await trx('triage_items').where({ id: card.id }).update({
        payload: { ...card.payload, reschedule_link_promise: { ...(card.payload?.reschedule_link_promise || {}), commitment_ids: rest } },
        summary: rest.length > 1 ? `${rest.length} promised reschedule links need attention.` : 'A promised reschedule link needs attention.',
        updated_at: new Date() });
    } else {
      await trx('triage_items').where({ id: card.id })
        .update({ status: 'resolved', resolution_source: 'auto', resolution_note: note, resolved_at: new Date(), updated_at: new Date() });
    }
  }
  if (!changed) return;
  const remaining = await trx('triage_items').where({ call_log_id: callLogId }).whereIn('status', ['open', 'in_progress']).first('id');
  await trx('call_log').where({ id: callLogId }).update({ review_status: remaining ? 'open' : 'resolved', updated_at: new Date() });
}

// Proof that THIS message is the promised handoff: one customer across the
// call, the outbox row, the message and the visit; the caller's own phone on
// both ends; the same extraction generation the plan was made from; and the
// message itself tied to the planned visit, the claimed provider id, or the
// minted link.
function deliveryIdentityMatches({ call, commitment, current, visit, customer, sms, context, visitId, generation }) {
  const link = current.payload?.link;
  return !!customer && call.customer_id === current.related_customer_id
    && sms.customer_id === call.customer_id && visit?.customer_id === call.customer_id
    && normalizePhone(customer.phone) === normalizePhone(sms.to_phone)
    && normalizePhone(customer.phone) === normalizePhone(String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone)
    && Number(call.processing_generation) === Number(generation)
    && Number(commitment.last_seen_generation) === Number(generation)
    && (context?.visit?.id === visitId || (current.provider_message_id && current.provider_message_id === sms.twilio_sid) || (link && String(sms.message_body).includes(link.replace(/^https?:\/\//, ''))));
}

// Delivery — and only delivery — keeps the promise. A staff Confirm racing
// this receipt must not block it: human_state 'confirmed' is an affirmative
// review, not a claim on the row (codex #4293 P1 r4) — excluding only
// 'confirmed' with whereNotIn (rather than requiring NULL) still refuses a
// genuinely terminal human_state ('dismissed').
//
// settleDelivery's own caller already proved this attempt's generation
// still matches the live commitment (deliveryIdentityMatches, before this
// function is ever reached). settleReconciledReceipt's late-receipt path
// does not: a replacement recording can reopen the SAME commitment_id under
// a NEW generation between when this row's link was used and when its
// carrier receipt finally arrives, so a stale receipt must not be trusted
// to speak for whatever the commitment has become. Re-checking here, rather
// than trusting every caller to have already checked, is what stops a late
// receipt for a SUPERSEDED generation from fulfilling the REPLACEMENT
// commitment's live obligation and clearing its still-open exception card
// (codex #4293 P1). A row with no recorded generation (older data, or a
// caller that never stamped one) falls through to the old, ungated
// behavior rather than block on data that was never captured.
//
// Shared with markLinkUsed, whose own late-arriving-customer-move path is
// the identical shape: an OLDER generation's outbox row (the one whose link
// the customer actually clicked) speaking for whatever the commitment has
// become since a replacement recording reopened it (codex #4293 P1).
async function attemptOwnsCurrentGeneration(trx, row, commitmentId, payload = row.payload) {
  const generation = payload?.call_generation;
  if (generation == null) return true;
  const commitment = await trx('call_commitments').where({ id: commitmentId }).forUpdate().first('id', 'last_seen_generation');
  return !commitment || Number(commitment.last_seen_generation) === Number(generation);
}

async function fulfilPromise(trx, row, sms, call) {
  if (!(await attemptOwnsCurrentGeneration(trx, row, row.commitment_id))) return;
  const updated = await trx('call_commitments').where({ id: row.commitment_id, status: 'open' })
    .where((q) => q.whereNull('human_state').orWhere('human_state', 'confirmed'))
    .update({ status: 'fulfilled', fulfilled_at: new Date(), updated_at: new Date(), fulfillment: {
      kind: 'reschedule_link_delivered', strength: 'direct', record_type: 'sms_log', record_id: sms.id,
      matched_at: new Date().toISOString(), basis: 'linked_visit_reschedule_link_delivered',
    } });
  if (updated) await recordAuditEvent({ actor_type: 'system', action: 'reschedule_link_delivered', resource_type: 'call_commitment', resource_id: row.commitment_id,
    metadata: { sms_log_id: sms.id, outbox_id: row.id }, critical: true, trx });
  // The provider recovered (or staff sent the exact link).
  await clearPromiseException(trx, call.id, row.commitment_id, 'The promised link was delivered.');
}

// What the row looks like once the provider's own record is attached:
// delivery closes it, anything else keeps the lane it is already in, so a
// parked row stays parked for the office. Reaching this function AT ALL
// means `sms` came from a real, twilio_sid-bearing sms_log row (matchingSend
// and reconcileAttempt's own lookups both require one) — the exact
// definitive-provider-evidence rule that retires delivery uncertainty, so
// every call here clears the flag regardless of the delivered/sent split.
function settledOutboxPatch(current, sms, context, { delivered, visitId, generation }) {
  const parked = current.status === 'review';
  return {
    status: delivered ? 'delivered' : (parked ? 'review' : 'sent'),
    ...(delivered ? { last_error: null } : {}),
    related_scheduled_service_id: visitId, provider_message_id: sms.twilio_sid, sent_at: sms.created_at,
    payload: { ...current.payload, call_generation: generation, visit_snapshot: current.payload?.visit_snapshot || (context?.visit ? snapshot(context.visit) : null),
      [DELIVERY_UNCERTAIN_KEY]: false },
    updated_at: new Date(),
  };
}

async function settleDelivery(conn, row, sms, context = null) {
  const delivered = ['delivered', 'read'].includes(sms.status);
  return conn.transaction(async (trx) => {
    await lockTriageCall(trx, row.related_call_log_id);
    const call = await trx('call_log').where({ id: row.related_call_log_id }).forShare().first();
    const commitment = await trx('call_commitments').where({ id: row.commitment_id }).forUpdate().first();
    const current = await trx('outbox_messages').where({ id: row.id }).forUpdate().first();
    if (!current || !commitment || ['delivered', 'cancelled'].includes(current.status)) return null;
    const visitId = current.related_scheduled_service_id || context?.visit?.id;
    const generation = current.payload?.call_generation ?? context?.call?.processing_generation;
    const visit = visitId ? await trx('scheduled_services').where({ id: visitId }).first('customer_id') : null;
    const customer = call?.customer_id ? await trx('customers').where({ id: call.customer_id }).whereNull('deleted_at').first('phone') : null;
    if (!deliveryIdentityMatches({ call, commitment, current, visit, customer, sms, context, visitId, generation })) return { needsReview: true };
    await trx('outbox_messages').where({ id: row.id }).update(settledOutboxPatch(current, sms, context, { delivered, visitId, generation }));
    if (delivered) await fulfilPromise(trx, row, sms, call);
    return null;
  // deliveryIdentityMatches failing (context changed — most often reprocessing
  // advancing the generation before this receipt arrived) says nothing about
  // whether the PROVIDER delivered THIS attempt: `delivered` above is that
  // separate, definitive fact about the one outbox row named by this sms's
  // twilio_sid, independent of what the commitment has since become.
  // Settling the attempt (retiring delivery_outcome_uncertain) and fulfilling
  // the commitment are two different questions with two different guards —
  // conflating them is exactly the bug reconcileAttempt's parallel
  // delivery_failed branch was already fixed for (codex #4293 P1); this is
  // that same fix for the delivered/read receipt instead of the failed one.
  // Leaving the flag true here left stagePromises blocked forever on an
  // attempt whose outcome was, in fact, known (codex #4293 P1). The
  // commitment itself stays untouched either way: fulfilPromise was never
  // reached above (identity mismatch short-circuited before it), so the
  // generation guard on MUTATING the commitment is exactly as strict as it
  // was before this fix.
  }).then(async (result) => {
    if (!result?.needsReview) return result;
    // retireDeliveryUncertainty runs as its OWN write, independent of
    // whatever parkReview below decides — including when parkReview turns
    // out to be a no-op because this row is already parked for the SAME
    // 'delivery_scope_changed' reason from an earlier pass (this attempt was
    // 'sent' when it first scope-changed, then the SAME sms later reached
    // 'delivered'). Threading the clear through parkReview's own
    // reason-unchanged optimisation left it stranded behind that no-op
    // forever — the exact sequence Codex named (codex #4293 P1).
    if (delivered) await retireDeliveryUncertainty(conn, row.id);
    return parkReview(conn, row, 'delivery_scope_changed');
  });
}

// A replacement/adopted recording (call-commitments.js upsertCommitments)
// resets an untouched AI commitment back to status 'open' and hands it a
// NEW processing_generation the moment the next reprocess pass detects it
// on the newly adopted audio. A commitment_id that already owns a
// delivered/cancelled outbox row from a PRIOR generation must still be
// eligible for a fresh one: "NOT EXISTS an outbox row for this commitment
// at or past its CURRENT generation" covers both never-staged (no row at
// all) and reopened-since-last-staged (every existing row is for an older
// generation) in one predicate, so a reopened promise is not stuck open in
// call_commitments forever with nothing left driving it toward delivery
// (codex #4293 P1, an earlier round on 5ce420509 that was missed).
async function stagePromises(conn) {
  if (mode() === 'off') return 0;
  const rows = await conn('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
    .where({ 'cc.kind': KIND, 'cc.party': 'waves', 'cc.status': 'open' })
    // A staff Confirm ('confirmed') is an affirmative review, not a claim
    // on the row — it must stay eligible for staging exactly like a
    // never-touched (NULL) commitment; only a genuinely terminal
    // human_state stays excluded (codex #4293 P1 r4).
    .where((q) => q.whereNull('cc.human_state').orWhere('cc.human_state', 'confirmed'))
    .whereRaw(`NOT EXISTS (
      SELECT 1 FROM outbox_messages o
      WHERE o.commitment_id = cc.id
        AND COALESCE(o.commitment_generation, -1) >= COALESCE(cc.processing_generation, 0)
    )`)
    // An older-generation attempt whose own outcome is still genuinely
    // unknown — mid-claim ('sending', the process could have died between
    // the claim and the provider call) or parked specifically because the
    // provider never confirmed one way or the other — may already have
    // reached Twilio. Staging a second row here risks a literal duplicate
    // send of the same promised link if that uncertain attempt in fact went
    // through with no sms_log evidence ever landing. This is distinct from
    // an attempt that was simply never made (still 'pending'/'shadow',
    // handled below by explicit retirement, not a hold): only a row that
    // MIGHT have reached the customer blocks a fresh dispatch, until
    // reconcileAttempt resolves it from delivery evidence or the office
    // rules on it via the review lane (codex #4293 P1).
    //
    // This reads the DELIVERY_UNCERTAIN_KEY payload flag, never status or
    // last_error: an attempt without a provider id falls through to
    // contextFor on every sweep, and a stale_extraction or call_not_ready
    // context error during call reprocessing calls parkReview for that
    // unrelated reason — overwriting last_error (and, for a 'sending' row,
    // status too) with no idea an uncertain attempt was recorded underneath
    // it. Inferring uncertainty from those two churny fields let that
    // context error erase it, silently reopening this exact hole on the
    // very next generation bump (codex #4293 P1). The flag is immune: it is
    // set only at claim time and cleared only by settledOutboxPatch,
    // reconcileAttempt's own definitive 'delivery_failed' evidence, or an
    // explicit office verdict (settleParkedPromiseCard, applyContextSkip's
    // promise_closed branch) — nothing else ever names this payload key, so
    // a plain status/last_error UPDATE (parkReview's ordinary case) cannot
    // touch it. A row that predates this flag simply has none set, which
    // reads as NOT uncertain — no retroactive blocking of historical rows.
    .whereRaw(`NOT EXISTS (
      SELECT 1 FROM outbox_messages o
      WHERE o.commitment_id = cc.id
        AND COALESCE(o.commitment_generation, -1) < COALESCE(cc.processing_generation, 0)
        AND (o.payload->>'${DELIVERY_UNCERTAIN_KEY}') = 'true'
    )`)
    .select('cc.id', 'cc.call_log_id', 'cc.created_at', 'cc.processing_generation', 'cl.customer_id').limit(200);
  // commitment_created_at rides along on the outbox row itself so runOne can
  // judge pre-activation without a second call_commitments query per row —
  // the exact check the r8 activation boundary needs to run before anything
  // else, for every historical row a live sweep might otherwise touch at
  // once. commitment_generation is what makes THIS row distinct from any
  // earlier one staged for the same commitment_id — see the composite
  // (commitment_id, commitment_generation) uniqueness in migration
  // 20260911000030_outbox_messages_commitment_generation.js.
  for (const row of rows) {
    // The unattempted counterpart to the uncertain-attempt hold above: an
    // older-generation row that never got past claimForDispatch (still
    // 'pending'/'shadow') is not uncertain — it never reached the provider
    // at all — just stale. Retiring it explicitly here, rather than leaving
    // it to rot in the sweep beside the fresh row this loop is about to
    // insert, is what keeps the two cases from being collapsed into one
    // handling (codex #4293 P1).
    await conn('outbox_messages').where({ commitment_id: row.id }).whereIn('status', ['pending', 'shadow'])
      .whereRaw('COALESCE(commitment_generation, -1) < ?', [row.processing_generation ?? 0])
      .update({ status: 'cancelled', last_error: 'superseded_generation', updated_at: new Date() });
    await conn('outbox_messages').insert({ channel: 'sms', status: mode() === 'shadow' ? 'shadow' : 'pending',
      payload: { kind: KIND, commitment_created_at: row.created_at }, commitment_id: row.id, commitment_generation: row.processing_generation ?? 0,
      related_call_log_id: row.call_log_id, related_customer_id: row.customer_id, available_at: new Date() })
      // The index this must match (migration 20260911000030) is PARTIAL —
      // WHERE commitment_id IS NOT NULL, to keep it off the many ordinary
      // outbox rows with no commitment at all. Postgres accepts an ON
      // CONFLICT target only when it names the SAME columns AND the SAME
      // predicate as an existing unique index; a bare column-list conflict
      // target here does not match a partial index at all, so every insert
      // would raise "no unique or exclusion constraint matching the ON
      // CONFLICT specification" instead of silently no-op'ing a duplicate
      // (codex #4293 P1, round 2 on baa4cf295).
      .onConflict(conn.raw(COMMITMENT_GENERATION_CONFLICT_TARGET)).ignore();
  }
  return rows.length;
}

// An attempt that already reached the provider OWNS the row until its
// outcome is known: delivery settles it, a failure or a receipt that never
// arrives parks it for the office, and an accepted-but-undecided send waits
// for the next sweep. Returns false when the row is still the worker's to
// plan. Never resends — the claim is what survives process death.
async function reconcileAttempt(conn, row, now) {
  const sms = await conn('sms_log').where({ twilio_sid: row.provider_message_id })
    .first('id', 'twilio_sid', 'status', 'created_at', 'customer_id', 'to_phone', 'message_body');
  const failed = sms && ['failed', 'undelivered'].includes(sms.status);
  const unparked = row.status !== 'review';
  // A real twilio_sid-bearing sms_log row saying the provider itself
  // rejected this exact attempt IS the definitive evidence that retires
  // delivery uncertainty: the message never reached the customer, so
  // staging a fresh generation afterward carries no duplicate risk. That
  // holds independently of whether the row is still live or already
  // parked — a failure is a failure either way (codex #4293 P1). The clear
  // runs as retireDeliveryUncertainty's own independent write, not as an
  // option threaded through parkReview — parkReview owns the status/
  // last_error transition (and, when unparked, always fires it, so ordering
  // the clear before or after it makes no difference here), but the clear
  // itself must not depend on parkReview's own reason-unchanged guard ever
  // agreeing to write.
  if (failed && unparked) { await retireDeliveryUncertainty(conn, row.id); await parkReview(conn, row, 'delivery_failed'); }
  // An already-parked failed attempt has nothing further THIS function can
  // settle — but it must not report "handled" the way the live branches
  // above and below do. Returning true here (as this used to, unconditionally)
  // made runOne return immediately, so it never reached contextFor and the
  // promise_closed cleanup there: an office dismissal or hand-fulfilment
  // recorded on the commitment ledger after this exact SMS had already
  // failed and parked left the exception card open forever, with no future
  // sweep ever revisiting it (codex #4293 P1). Returning false — the same
  // signal the final `return false` below already uses for "still parked,
  // nothing definitive yet" — is safe: holdBeforeSend's very first check
  // (`row.status === 'review'`) still refuses to plan a fresh send off this
  // row, so contextFor's terminal read runs without ever retrying the
  // failed dispatch.
  else if (failed) { await retireDeliveryUncertainty(conn, row.id); return false; }
  else if (sms && ['delivered', 'read'].includes(sms.status)) await settleDelivery(conn, row, sms);
  else if (unparked && new Date(row.sent_at || row.last_attempt_at).getTime() + 24 * 3600000 < now.getTime()) await parkReview(conn, row, 'delivery_receipt_unavailable');
  else if (sms && !failed && unparked) await settleDelivery(conn, row, sms);
  else if (unparked) await conn('outbox_messages').where({ id: row.id }).update({ updated_at: now });
  else return false;
  return true;
}

// A reconciled row (the customer already used this exact link to move
// themselves) must never be re-planned, re-parked, or have its exception
// card REOPENED again from ANY path — not the context re-evaluation in
// runOne, and not the ordinary receipt reconciliation either.
// reconcileAttempt's own branches (delivery_failed, delivery_receipt_unavailable,
// and settleDelivery's scope-changed escape hatch) all call parkReview, which
// would recreate the very card markLinkUsed just closed — the sibling of the
// contextFor re-plan bug, at the receipt path instead (codex #4293 P1 r5).
// The receipt is still worth settling properly: a genuine delivery still
// fulfils the linked call_commitments row exactly as the normal
// settleDelivery path does (fulfilPromise, reused not copied — codex #4293
// P1 r6), and a failed one stays bookkeeping only. Neither ever calls
// parkReview, and neither ever creates or reopens a triage_items row.
async function settleReconciledReceipt(conn, row) {
  if (!row.provider_message_id) return;
  const sms = await conn('sms_log').where({ twilio_sid: row.provider_message_id }).first('id', 'status');
  if (!sms) return;
  // Either branch below is definitive provider evidence for THIS attempt —
  // the twilio_sid lookup just above only ever matches a real sms_log row —
  // so both retire whatever delivery uncertainty this row was carrying.
  if (['delivered', 'read'].includes(sms.status)) {
    // A delivered receipt still means the promise was KEPT — fulfilPromise
    // is the one step of settleDelivery that belongs here too, reused
    // rather than copied. Its own clearPromiseException call is a safe
    // no-op (the exception card is already closed); it never re-parks.
    // `row` is the sweep's own pre-lock read, same as everywhere else in
    // this file — the raw jsonb merge (not a JS spread on that snapshot)
    // is what keeps this safe against a concurrent payload writer on the
    // same row (codex #4293 P1).
    await conn.transaction(async (trx) => {
      await lockTriageCall(trx, row.related_call_log_id);
      const changed = await trx('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
        .update({ status: 'delivered', last_error: null, updated_at: new Date(), payload: deliveryUncertainPatch(trx, false) });
      if (changed) await fulfilPromise(trx, row, sms, { id: row.related_call_log_id });
    });
  } else if (['failed', 'undelivered'].includes(sms.status)) {
    await conn('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
      .update({ status: 'failed', last_error: sms.status, updated_at: new Date(), payload: deliveryUncertainPatch(conn, false) });
  }
}

// The promise is no longer sendable: a closed promise cancels the row, shadow
// mode records the reason without touching the customer, and live mode hands
// the promise to the office.
async function applyContextSkip(conn, row, reason, now) {
  // The office dismissed or hand-fulfilled the promise. Cancelling the outbox
  // row alone would leave this promise's own exception card open forever —
  // classifyTriageItem deliberately keeps it out of the generic sweep, so the
  // call would sit in review against a decision already made (codex #4293 r2
  // P2). An explicit office verdict is also the OTHER thing (besides
  // definitive provider evidence) allowed to retire delivery uncertainty —
  // the office has ruled, so no future sweep will ever act on this row again.
  if (reason === 'promise_closed') return conn.transaction(async (trx) => {
    await lockTriageCall(trx, row.related_call_log_id);
    // Same class as retireDeliveryUncertainty and settleReconciledReceipt:
    // `row` is a pre-lock snapshot, so the payload write has to merge at the
    // database level rather than replace from it — a customer using the link
    // (markLinkUsed, serialized behind the SAME lockTriageCall above) could
    // otherwise have its stamp erased by whichever transaction commits second
    // (codex #4293 P1).
    await trx('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
      .update({ status: 'cancelled', updated_at: now, payload: deliveryUncertainPatch(trx, false) });
    await clearPromiseException(trx, row.related_call_log_id, row.commitment_id, 'The promise was closed by the office.');
  });
  if (mode() === 'shadow') return conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow'])
    .update({ status: 'shadow', last_error: reason, updated_at: now });
  return parkReview(conn, row, reason);
}

// The one customer handoff: render, claim, hand to the central send pipeline
// with a final source recheck at both the dispatch and provider boundaries,
// then record what the provider said. Anything unknown parks.
// An operator can relink the call to a different customer between staging
// and this claim (e.g. correcting a call-ingest mismatch by hand) —
// contextFor already re-derives the visit from the REVALIDATED customer, but
// related_customer_id on the row was stamped at staging time against the OLD
// one. Left stale, the SMS still reaches the right (new) customer, but
// settleDelivery's own identity check compares the call's CURRENT
// customer_id against this row's related_customer_id and fails — a
// delivered promise parks as delivery_scope_changed for no reason the
// office can act on (codex #4293 P2). Rebinding happens under the SAME
// transaction as the claim itself (a locked re-read, then the claim update),
// so a row is never claimed without also carrying the identity it was
// actually claimed for; a rebind that cannot complete atomically refuses
// the claim entirely rather than dispatch on a half-updated row.
async function claimForDispatch(conn, row, context, { now, planned, link }) {
  const { call, customer, visit } = context;
  try {
    return await conn.transaction(async (trx) => {
      const current = await trx('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow'])
        .forUpdate().first('id', 'payload', 'related_customer_id');
      if (!current) return { claimed: 0 };
      const relinked = current.related_customer_id !== customer.id;
      const claimed = await trx('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow'])
        .update({ status: 'sending', attempts: trx.raw('attempts + 1'), last_attempt_at: now, updated_at: now,
          related_scheduled_service_id: visit.id, related_customer_id: customer.id,
          // From this instant until definitive provider evidence or an
          // office verdict says otherwise, THIS attempt might reach Twilio
          // with no persisted trace if the process dies mid-send — the
          // window stagePromises must never stage a duplicate generation
          // into (codex #4293 P1).
          payload: { ...current.payload, call_generation: call.processing_generation, visit_snapshot: planned, link: link.url,
            [DELIVERY_UNCERTAIN_KEY]: true,
            ...(relinked ? { rebound_from_customer_id: current.related_customer_id, rebound_at: now.toISOString() } : {}) } });
      return { claimed, relinked };
    });
  } catch (err) {
    require('./logger').warn(`[reschedule-link-promises] send claim failed for ${row.id} (${err.code || err.name || 'error'})`);
    return { claimed: 0, error: err };
  }
}

async function dispatch(conn, row, context, { now, send, buildLink, render, planned, evidenceSince }) {
  const { commitment, customer, visit } = context;
  const link = await (buildLink || require('./reschedule-link').buildRescheduleLink)(visit.id, { customerId: customer.id });
  if (!link?.url) return parkReview(conn, row, 'link_unavailable');
  const body = await (render || require('../routes/admin-sms-templates').getTemplate)('reschedule_link_promise', {
    first: customer.first_name || 'there', link: link.url,
  }, { customerId: customer.id }, { noVariants: true, requiredVars: ['link'] });
  if (!body) return parkReview(conn, row, 'template_unavailable');
  // A committed claim survives process death. Unknown provider outcomes are
  // reconciled from delivery evidence or parked, never blindly resent.
  const { claimed, error } = await claimForDispatch(conn, row, context, { now, planned, link });
  if (error) return parkReview(conn, row, 'claim_rebind_failed');
  if (!claimed) return;
  row.related_scheduled_service_id = visit.id;
  row.related_customer_id = customer.id;
  let manual = null;
  const check = async () => {
    if (mode() !== 'true') return { ok: false, code: 'LINK_GATE_OFF', reason: 'Reschedule link automation is off' };
    if (!isWithinSendWindowET()) return { ok: false, code: 'LINK_QUIET_HOURS', reason: 'Waiting for the next send window' };
    const live = await contextFor(conn, commitment.id, new Date());
    if (live.reason || !sameVisitSnapshot(snapshot(live.visit), planned)) return { ok: false, code: 'LINK_SOURCE_CHANGED', reason: 'The discussed visit changed' };
    manual = await matchingSend(conn, live, evidenceSince);
    return manual ? { ok: false, code: 'LINK_ALREADY_SENT', reason: 'The link was already sent' } : { ok: true };
  };
  try {
    const result = await (send || require('./messaging/send-customer-message').sendCustomerMessage)({
      to: customer.phone, body, channel: 'sms', audience: 'customer', purpose: 'appointment', customerId: customer.id,
      appointmentId: visit.id, entryPoint: 'reschedule-link-promise', identityTrustLevel: 'phone_matches_customer',
      metadata: { original_message_type: 'reschedule_link_promise', followThroughCommitmentId: commitment.id, outbox_id: row.id },
      preDispatchCheck: check, preProviderCheck: check,
    });
    if (manual) return settleDelivery(conn, row, manual, context);
    if (result.sent && /^SM[0-9a-f]{32}$/i.test(result.providerMessageId || '')) {
      return conn('outbox_messages').where({ id: row.id, status: 'sending' }).update({ status: 'sent',
        provider_message_id: result.providerMessageId, sent_at: new Date(), updated_at: new Date() });
    }
    // The interlock was busy — nothing reached the provider, so this is a
    // retry in a few minutes, not an unknown outcome for the office (codex
    // #4293 r2 P2). `blocked: true` is send-customer-message's own boundary
    // for "refused before dispatchToProvider ever ran": withSendLock returns
    // LOCK_BUSY before sendCore is even invoked, and every other blocked
    // code here comes back from `check()` — used as BOTH preDispatchCheck
    // (step 6.5, strictly before the step-7 dispatch call) and preProviderCheck
    // (the literal Twilio-handoff seam, awaited inside sendViaTwilio before
    // messages.create()) — so for the sms channel this call always uses,
    // `blocked` and "never reached the provider" are the same fact; the
    // push-only in-flight/retry shapes that WOULD imply an actual provider
    // attempt (appPending/appRetryable) can't come back on this channel.
    // `result.success === false` below (the one shape `blocked` is NOT set
    // on) is Twilio actually having been asked, or an SDK call that never
    // returned a definitive verdict — that one keeps the flag set, same as
    // the exception path. A definitively-unsent attempt returning to a
    // pre-send state (pending here, review below) with the flag still true
    // is indistinguishable from one that might have reached the customer,
    // which is exactly what let a later reprocessing pass advance the
    // generation and have stagePromises block the replacement forever on an
    // attempt nothing was ever actually unsure about (codex #4293 P1,
    // follow-up round — the earlier round deliberately left the two named
    // branches alone; Codex has since shown that call was not fail-safe
    // caution but an indefinite block). Every clear below rides in the SAME
    // update as the status write it accompanies, so there is no window
    // where the row is pending/review but still flagged uncertain.
    if (result.blocked && result.code === 'LINK_LOCK_BUSY') return conn('outbox_messages').where({ id: row.id, status: 'sending' })
      .update({ status: 'pending', available_at: new Date(now.getTime() + LOCK_RETRY_MINUTES * 60000), last_error: result.code, updated_at: new Date(),
        payload: deliveryUncertainPatch(conn, false) });
    if (result.blocked && ['LINK_QUIET_HOURS', 'QUIET_HOURS_HOLD', 'LINK_GATE_OFF'].includes(result.code)) return conn('outbox_messages').where({ id: row.id, status: 'sending' })
      .update({ status: 'pending', available_at: nextSendWindowOpenET(new Date()), last_error: result.code, updated_at: new Date(),
        payload: deliveryUncertainPatch(conn, false) });
    // Any other blocked refusal — a changed source visit or an already-sent
    // duplicate from the same `check()` (LINK_SOURCE_CHANGED, LINK_ALREADY_SENT
    // — the latter is normally intercepted by the `manual` branch above before
    // it ever reaches here), or a shared send-customer-message pipeline guard
    // (owned-number recipient, the move-hold boundary, a consent/suppression
    // recheck failure at the handoff) — is equally definitive that no request
    // reached Twilio. parkReview only ever writes status/last_error, never
    // payload (deliberately — threading a clear through its own
    // reason-unchanged no-op guard is exactly what stranded this flag before,
    // codex #4293 P1, three earlier rounds), so the clear runs as
    // retireDeliveryUncertainty's own independent write ahead of it, the same
    // shape reconcileAttempt's delivery_failed branch already uses.
    if (result.blocked) { await retireDeliveryUncertainty(conn, row.id); return parkReview(conn, row, result.code || 'provider_outcome_unknown'); }
    return parkReview(conn, row, result.code || 'provider_outcome_unknown');
  } catch {
    return parkReview(conn, row, 'provider_outcome_unknown');
  }
}

// Every reason this promise does NOT hand off to the customer on this pass:
// the office already owns it, an in-flight claim has not timed out, the
// discussed visit changed under the plan, shadow mode only records, or the
// send window is closed. Returns true when the row is settled for now.
async function holdBeforeSend(conn, row, context, planned, now) {
  const { call, visit } = context;
  const plan = { ...row.payload, call_generation: call.processing_generation, visit_snapshot: planned };
  if (row.status === 'review') {
    await conn('outbox_messages').where({ id: row.id }).update({ updated_at: now });
    return true;
  }
  if (row.status === 'sending') {
    if (new Date(row.last_attempt_at).getTime() + 20 * 60000 <= now.getTime()) await parkReview(conn, row, 'provider_outcome_unknown');
    return true;
  }
  if (row.payload.visit_snapshot && !sameVisitSnapshot(row.payload.visit_snapshot, planned)) {
    await parkReview(conn, row, 'appointment_changed');
    return true;
  }
  if (mode() === 'shadow') {
    await conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow']).update({ status: 'shadow', last_error: null,
      related_scheduled_service_id: visit.id, payload: { ...plan, would_send_at: (isWithinSendWindowET(now) ? now : nextSendWindowOpenET(now)).toISOString() }, updated_at: now });
    return true;
  }
  if (!isWithinSendWindowET(now)) {
    await conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow']).update({ status: 'pending',
      related_scheduled_service_id: visit.id, payload: plan, available_at: nextSendWindowOpenET(now), updated_at: now });
    return true;
  }
  return false;
}

// True when the commitment behind this row predates the activation
// boundary — see stagePromises for where commitment_created_at is stamped.
async function isPreActivationRow(conn, row) {
  const createdAt = row.payload?.commitment_created_at;
  if (!createdAt) return false;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const boundary = await activationBoundary(conn);
  return boundary != null && created < boundary;
}

// Terminal, exactly like a promise the office already closed
// (applyContextSkip's promise_closed branch): no send, and no card raised,
// because there is no new office work here — only a historical extraction
// nobody asked this feature to act on. 'cancelled' (not 'review') so the
// row also drops out of every future sweep's status whitelist instead of
// costing a scan slot forever (codex #4293 P1 r8).
async function cancelPreActivation(conn, row) {
  await conn('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
    .update({ status: 'cancelled', last_error: 'pre_activation', updated_at: new Date() });
}

async function runOne(conn, row, { now = new Date(), send = null, buildLink = null, render = null } = {}) {
  if (mode() === 'off') return;
  // Another sweep may have completed this item since it was listed.
  row = await conn('outbox_messages').where({ id: row.id }).first();
  if (!row || ['delivered', 'cancelled'].includes(row.status)) return;
  // The customer already used this exact link to move themselves.
  // markLinkUsed stamps this and clears the row's exception card, but
  // deliberately leaves status alone — a missing carrier receipt is still
  // not proof of delivery. NO further path below may re-plan, re-park, or
  // reopen this promise's exception card: not the context re-evaluation
  // (contextFor would find the visit's NOW-MOVED date no longer matches the
  // original promise and park it discussed_visit_unavailable), and not the
  // ordinary receipt reconciliation either (its own delivery_failed /
  // delivery_receipt_unavailable / scope-changed branches all call
  // parkReview too). Either would resurrect the very card just closed, and
  // permanently: unreconciledPromiseRows never revisits a row once this
  // stamp is set, so nothing would ever close it again (codex #4293 P1
  // r4/r5). settleReconciledReceipt still records a late carrier outcome for
  // accurate bookkeeping, but never touches triage_items or call_log.
  if (row.payload?.link_used_reconciled_at) return settleReconciledReceipt(conn, row);
  // A commitment recorded before this delivery gate's own activation
  // boundary is a historical observation, not a live promise to keep —
  // see isPreActivationRow / cancelPreActivation (codex #4293 P1 r8).
  if (await isPreActivationRow(conn, row)) return cancelPreActivation(conn, row);
  // Reconcile accepted/ambiguous attempts before planning any new send.
  if (row.provider_message_id && await reconcileAttempt(conn, row, now)) return;
  // A row still 'sending' with no provider id yet (the process died between
  // the claim and the provider call), or already parked with delivery
  // uncertain, falls straight through to here on every sweep. A context
  // error below (stale_extraction during call reprocessing, call_not_ready,
  // etc.) is transient and re-derivable next pass, so applyContextSkip's
  // ordinary parkReview call must not — and, being a plain status/last_error
  // UPDATE that never names DELIVERY_UNCERTAIN_KEY, does not — touch
  // whatever the payload flag already recorded (codex #4293 P1: this exact
  // fall-through used to overwrite provider_outcome_unknown, or replace
  // 'sending', with the unrelated context reason, silently losing the only
  // signal stagePromises had to hold back a duplicate generation).
  const context = await contextFor(conn, row.commitment_id, now);
  if (context.reason) return applyContextSkip(conn, row, context.reason, now);
  const { call, visit } = context;
  // Evidence starts at the END of the call: an exact link sent while the
  // caller was still on the line cannot keep a promise made later in that
  // same call — the boundary the commitment ledger already uses (codex
  // #4293 r1 P2).
  const evidenceSince = require('./call-commitments').callEndedAt(call) || call.created_at;
  const prior = await matchingSend(conn, context, evidenceSince);
  if (prior) return settleDelivery(conn, row, prior, context);
  const planned = snapshot(visit);
  if (await holdBeforeSend(conn, row, context, planned, now)) return;
  return dispatch(conn, row, context, { now, send, buildLink, render, planned, evidenceSince });
}

// Oldest-SCANNED-first, falling back to oldest-updated-first for a row that
// has never been scanned (fresh, or predating this column) — the fairness
// ordering every LIMIT-100 sweep over outbox_messages shares.
const SCAN_FAIRNESS_ORDER = [{ column: 'last_scanned_at', order: 'asc', nulls: 'first' }, { column: 'updated_at', order: 'asc' }];
// Every non-terminal lane the send sweep still has work in.
const SWEEP_STATUSES = ['pending', 'shadow', 'sending', 'sent', 'review'];

// Marks every row a sweep looked at as scanned, regardless of what else
// happened to it. A row a sweep examines but leaves unchanged (context still
// invalid, a review row parked for the same reason as last time, a promise
// with no matching evidence yet) never advances updated_at on its own — that
// is exactly the row an oldest-updated-first LIMIT 100 keeps re-selecting
// forever once 100 of them accumulate, starving every newer row behind them
// (codex #4293 P1). Stamping this unconditionally, independent of whatever
// else the row's own processing does, is what SCAN_FAIRNESS_ORDER relies on.
async function stampScanned(conn, rows, now) {
  const ids = rows.map((row) => row.id);
  if (ids.length) await conn('outbox_messages').whereIn('id', ids).update({ last_scanned_at: now });
}

async function sweep(conn = db, options = {}) {
  if (mode() === 'off') return { processed: 0 };
  // Live mode must fix the activation boundary on its OWN first tick,
  // whether or not there happens to be anything to stage yet — otherwise an
  // empty queue defers the write to whatever LATER sweep finally sees a
  // row, and every commitment created between gate-on and that later sweep
  // reads as pre_activation against a boundary that arrived too late
  // (codex #4293 P1, folded into round 2 on baa4cf295). This is the
  // FALLBACK writer: a call processed live before this tick has already
  // fixed the instant through recordLiveActivation, and insert-if-absent
  // keeps whichever of the two came first (codex #4293 P1 r3).
  if (mode() === 'true') await activationBoundary(conn);
  await stagePromises(conn);
  const now = options.now || new Date();
  // Terminal rows ('delivered', 'cancelled') stay in the table for good but
  // are NOT in this allowlist: they would otherwise occupy scan slots and
  // last_scanned_at stamps forever, and once 100 of them accumulated a
  // retried pending row behind them would wait a full rotation for a send
  // it is due now. Delivered rows still needed for used-link reconciliation
  // are selected separately by reconcileUsedLinks (codex #4293 P2 r3).
  const rows = await conn('outbox_messages').whereNotNull('commitment_id').whereIn('status', SWEEP_STATUSES)
    .where(function due() { this.whereNull('available_at').orWhere('available_at', '<=', now); }).orderBy(SCAN_FAIRNESS_ORDER).limit(100);
  await stampScanned(conn, rows, now);
  // One row must never starve the tick. There is an explicit row-specific
  // throw in matchingSend (a customer with more than 200 matching link
  // messages), and that row is by definition the oldest unchanged item, so an
  // unguarded loop would abort every later promise AND used-link
  // reconciliation on every sweep, forever (codex #4293 r3 P2). An
  // unprocessable row parks for the office, which is this worker's answer to
  // every other unknown; a park that itself fails is swallowed so the loop
  // still moves on.
  let failed = 0;
  for (const row of rows) {
    try {
      await runOne(conn, row, options);
    } catch (err) {
      failed += 1;
      require('./logger').warn(`[reschedule-link-promises] row ${row.id} failed (${err.code || err.name || 'error'})`);
      await parkReview(conn, row, 'worker_error').catch((parkErr) => {
        require('./logger').warn(`[reschedule-link-promises] row ${row.id} could not be parked (${parkErr.code || parkErr.name || 'error'})`);
      });
    }
  }
  const reconciled = await reconcileUsedLinks(conn, now);
  return { processed: rows.length, failed, reconciled, mode: mode() };
}

// A manual Comms message that carries the SAME visit's link while an
// automatic send of it is in flight (or landed after this operator opened the
// conversation) is a duplicate, not a second message.
async function manualDuplicateOfPromisedLink(customerId, body, started) {
  const active = await db('outbox_messages').where({ related_customer_id: customerId }).whereNotNull('commitment_id')
    .whereIn('status', ['sending', 'sent', 'delivered']).select('status', 'sent_at', 'related_scheduled_service_id');
  for (const row of active) {
    if (row.status !== 'sending' && new Date(row.sent_at) < started) continue;
    const visit = await db('scheduled_services').where({ id: row.related_scheduled_service_id, customer_id: customerId }).first('id', 'reschedule_token');
    if (visit && carriesVisitLink(body, await visitLinkNeedles(db, visit))) return true;
  }
  return false;
}

// Take the customer's advisory interlock, or say so. statement_timeout aborts
// the wait rather than queueing behind a slow unrelated send — no provider
// attempt has been made at that point, so the caller retries instead of
// treating it as an unknown outcome (codex #4293 r2 P2). A failed query on
// this connection also means the interlock is not held, so `held` records it.
async function acquireSendLock(connection, customerId, held) {
  try {
    await connection.query("SET statement_timeout = '10s'");
    await connection.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', ['reschedule-link-send', String(customerId)]);
    return !held.lost;
  } catch (err) {
    held.lost = true;
    require('./logger').warn(`[reschedule-link-promises] send interlock not acquired for ${customerId} (${err.code || err.name || 'error'})`);
    return false;
  }
}

// Whether this session STILL holds the interlock, tracked by us. The previous
// guard read knex's private `__knex__disposed`, which simply does not exist on
// another knex or pool build: there it reads undefined, the guard fails OPEN,
// and a send goes to the provider on exactly the lost-interlock race the guard
// was written for (local codex audit P1). An unpooled connection's own
// error/end/close events are the authority instead — and listening for 'error'
// also keeps a dead raw connection from taking the process down with it.
function trackInterlockLoss(connection, held) {
  if (typeof connection?.on !== 'function') return;
  const lost = () => { held.lost = true; };
  for (const event of ['error', 'end', 'close']) connection.on(event, lost);
}

// The interlock runs OUTSIDE the pool, so it has to be bounded in both time
// and count: with the gate on, every operator text reaches withSendLock, and
// one unpooled connection per send would exhaust the database's slots and hang
// the admin messaging pipeline behind a connect that never returns (local
// codex audit P1). Returns null when the interlock cannot be taken cheaply —
// the caller decides whether that is a retry or an ordinary send.
const INTERLOCK_CONNECT_MS = 5000;
const MAX_OPEN_INTERLOCKS = 4;
let openInterlocks = 0;

async function openInterlockConnection() {
  if (openInterlocks >= MAX_OPEN_INTERLOCKS) {
    require('./logger').warn(`[reschedule-link-promises] send interlock at its connection cap (${MAX_OPEN_INTERLOCKS})`);
    return null;
  }
  openInterlocks += 1;
  let timer = null;
  let opening = null;
  try {
    opening = Promise.resolve(db.client.acquireRawConnection());
    return await Promise.race([
      opening,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('interlock connect timed out')), INTERLOCK_CONNECT_MS); }),
    ]);
  } catch (err) {
    if (err.message === 'interlock connect timed out') {
      // The timer winning the race proves nothing about the underlying
      // connect — it is still in flight, and freeing the slot on the timer
      // alone (as an earlier round did) let a burst of slow connects each
      // release their slot while the real sockets stayed open underneath,
      // so the cap no longer bounded the true number of concurrent raw
      // connections (codex #4293 P1 r8). Keep the slot counted until the
      // attempt actually settles: a late-arriving connection is destroyed —
      // ITS destroy, not this timeout, is what frees the slot — and a late
      // rejection (the connect failed on its own after all) frees it
      // directly, with nothing left to destroy.
      opening.then((late) => closeInterlockConnection(late), () => { openInterlocks -= 1; });
    } else {
      // acquireRawConnection() itself rejected before the timer ever fired —
      // the attempt is already over, with nothing left to wait for.
      openInterlocks -= 1;
    }
    require('./logger').warn(`[reschedule-link-promises] send interlock connection unavailable (${err.code || err.name || 'error'})`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeInterlockConnection(connection, counted = true) {
  if (counted) openInterlocks -= 1;
  if (!connection) return;
  await db.client.destroyRawConnection(connection).catch((err) => {
    require('./logger').warn(`[reschedule-link-promises] send interlock close failed (${err.code || err.name || 'error'})`);
  });
}

const LOCK_BUSY = Object.freeze({ sent: false, blocked: true, retryable: true, code: 'LINK_LOCK_BUSY',
  reason: 'Another message to this customer is in flight. Try again shortly.' });
const LINK_IN_PROGRESS = Object.freeze({ sent: false, blocked: true, code: 'PROMISED_LINK_IN_PROGRESS',
  reason: 'The promised link is already being sent. Refresh the conversation before sending it again.' });

// Which side of the interlock a send sits on. Anything else passes straight
// through — the interlock exists only between the promise worker and an
// operator's own message to the same customer.
function sendLockRole(input) {
  return {
    automatic: !!input?.metadata?.followThroughCommitmentId,
    manual: input?.operatorInitiated === true || input?.metadata?.humanAuthored === true || !!input?.metadata?.adminUserId,
  };
}

// A promised link this worker could put on the wire for this customer right
// now: in flight, or waiting for the next sweep. Rows already sent, delivered,
// parked or cancelled are nothing to serialize against — manualDuplicateOf-
// PromisedLink only cares about rows that land after the operator started.
const LIVE_PROMISE_STATUSES = ['pending', 'shadow', 'sending'];

// Does this send need the interlock AT ALL? With the gate on, EVERY staff text
// to EVERY customer reaches withSendLock, and paying an unpooled connection
// plus an advisory lock for customers who have no promised link is a new
// failure mode across the whole admin messaging pipeline (local codex audit
// P1). One cheap pooled lookup decides; if the lookup itself fails, the send
// goes out as it does today, because this interlock must never be the reason
// an ordinary admin message does not send.
async function needsSendInterlock(input, { automatic, manual }) {
  if (mode() !== 'true' || !input?.customerId || (!automatic && !manual)) return false;
  if (sendContext.getStore()?.customerId === input.customerId) return false;
  if (automatic) return true;
  try {
    const live = await db('outbox_messages').where({ related_customer_id: input.customerId })
      .whereNotNull('commitment_id').whereIn('status', LIVE_PROMISE_STATUSES).first('id');
    return !!live;
  } catch (err) {
    require('./logger').warn(`[reschedule-link-promises] promise pre-check failed for ${input.customerId} (${err.code || err.name || 'error'})`);
    return false;
  }
}

// The automatic promise send and manual Comms send serialize for this
// customer. A manual message already underway wins; the automated final
// check sees its receipt. An overlapping manual duplicate is held visibly.
async function withSendLock(input, sendCore) {
  const role = sendLockRole(input);
  if (!(await needsSendInterlock(input, role))) return sendCore(input);
  const started = new Date();
  // This session holds only the advisory interlock. The provider pipeline
  // needs the normal pool for consent/audit; holding a pool transaction
  // here deadlocks two simultaneous sends when that pool has two slots.
  const connection = await openInterlockConnection();
  // No interlock available: the worker retries its own send, an operator's
  // message goes out rather than failing on a lock it does not own.
  if (!connection) return role.automatic ? LOCK_BUSY : sendCore(input);
  const held = { lost: false };
  trackInterlockLoss(connection, held);
  try {
    if (!(await acquireSendLock(connection, input.customerId, held))) return LOCK_BUSY;
    if (role.manual && !role.automatic && await manualDuplicateOfPromisedLink(input.customerId, input.body, started)) return LINK_IN_PROGRESS;
    const lockedInput = { ...input, preProviderCheck: async (args) => {
      const verdict = typeof input.preProviderCheck === 'function' ? await input.preProviderCheck(args) : { ok: true };
      if (held.lost) return { ok: false, code: 'LINK_LOCK_LOST', reason: 'The send interlock was lost. Refresh before retrying.' };
      return verdict;
    } };
    return await sendContext.run({ customerId: input.customerId }, () => sendCore(lockedInput));
  } finally {
    held.lost = true;
    await closeInterlockConnection(connection);
  }
}

const USED_LINK_NOTE = 'Customer chose a new time using the promised reschedule link.';
// The mover stamps every /reschedule/:token commit with this initiator — the
// durable proof that the customer, not the office, moved the visit.
const SELF_SERVE_INITIATOR = 'customer_self_serve';
// Rows whose link actually reached the provider. A parked ('review') row
// counts too — a missing carrier receipt does not stop the customer from
// following the permanent link, and its cards are just as moot once they do
// (codex #4293 r2 P2) — but only when an attempt was really made.
const ATTEMPTED_STATUSES = ['sent', 'delivered', 'review'];

// At-most-once per promise row: the stamp is what makes the reconciliation
// safe to retry from anywhere. It is also the row's terminal marker for
// runOne's send-sweep path (codex #4293 P1 r4) — set it only once the promise
// truly needs no further planning or re-parking.
//
// Everything below runs in ONE call-locked transaction — not three separate
// operations — because a concurrent five-minute sweep pass (runOne /
// settleDelivery / parkReview) takes the SAME advisory lock: without it, the
// sweep can observe the cards resolved but the stamp not yet written (or the
// reverse), see the moved appointment as unaccounted for, and call
// parkReview again — recreating the very exception this reconciliation just
// closed, this time for good, since the stamp then makes every later pass
// skip the row outright (codex #4293 P2 r4). The status check also reads the
// row FRESH under the lock rather than trusting the caller's snapshot: a row
// the caller observed as 'sent' can have been parked to 'review' by a
// concurrent pass in the gap since that read, and the stale value used to
// skip clearPromiseException for a card that, right now, is actually open.
//
// This row's own STAMP always lands — the customer really did use THIS
// attempt's link, whatever generation it was staged under, and that fact is
// worth recording regardless. Clearing the shared exception CARD is a
// different question: a replacement recording can reopen this same
// commitment_id under a NEW generation and park a fresh attempt of its own
// before the customer ever gets around to using the OLD attempt's still-live
// link (the token lives on the visit, not on any one generation). Closing
// the card on that stale click would erase the office's only visibility into
// the REPLACEMENT commitment's still-open obligation — the same
// generation-ownership hole fulfilPromise was fenced against, at the
// used-link path instead (codex #4293 P1).
async function markLinkUsed(conn, row) {
  await conn.transaction(async (trx) => {
    await lockTriageCall(trx, row.related_call_log_id);
    await require('./triage-auto-resolve').resolveRescheduleCards(trx, row.related_call_log_id, USED_LINK_NOTE, row.related_scheduled_service_id);
    // A row parked for a missing carrier receipt raised this promise's own
    // exception card, and classifyTriageItem keeps that card out of the
    // generic sweep. The customer following the same link answers it: there
    // is no office work left to chase. The card closes; the promise's own
    // status does NOT move, because a missing receipt is still not proof of
    // delivery (codex #4293 r2 P2).
    const current = await trx('outbox_messages').where({ id: row.id }).first('status', 'payload');
    if (current?.status === 'review' && await attemptOwnsCurrentGeneration(trx, row, row.commitment_id, current.payload)) {
      await clearPromiseException(trx, row.related_call_log_id, row.commitment_id, USED_LINK_NOTE);
    }
    await trx('outbox_messages').where({ id: row.id })
      .update({ payload: trx.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ link_used_reconciled_at: new Date().toISOString() })]), updated_at: new Date() });
  });
}

function unreconciledPromiseRows(conn) {
  return conn('outbox_messages').whereNotNull('commitment_id').whereIn('status', ATTEMPTED_STATUSES)
    .whereNotNull('related_scheduled_service_id').whereNotNull('related_call_log_id')
    .where(function attempted() { this.whereNot('status', 'review').orWhereNotNull('provider_message_id'); })
    .whereRaw(LINK_NOT_YET_RECONCILED);
}

// The customer moved the visit THEMSELVES, after the link went out. This is
// the only evidence that closes the cards: a caller who replays the POST with
// the appointment's current date and start never moved anything, and must not
// be able to hide outstanding office work (codex #4293 r2 P2).
async function selfServeMoveAfterSend(conn, row) {
  return conn('reschedule_log')
    .where({ scheduled_service_id: row.related_scheduled_service_id, initiated_by: SELF_SERVE_INITIATOR })
    .modify((q) => { if (row.sent_at) q.where('created_at', '>=', row.sent_at); })
    .first('id');
}

async function reconcileRows(conn, rows) {
  let reconciled = 0;
  for (const row of rows) {
    if (!(await selfServeMoveAfterSend(conn, row))) continue;
    await markLinkUsed(conn, row);
    reconciled += 1;
  }
  return reconciled;
}

// Called straight off a committed move (and off its idempotent replay) for
// one visit.
async function resolveUsedLink(conn, visitId) {
  return reconcileRows(conn, await unreconciledPromiseRows(conn).where({ related_scheduled_service_id: visitId })
    .select('id', 'status', 'commitment_id', 'related_call_log_id', 'related_scheduled_service_id', 'sent_at'));
}

// Only a row whose visit HAS a self-serve move on record, made after the
// link went out, can ever be reconciled; a promised-link row whose customer
// never touched /reschedule/:token is nothing for this pass to look at, and
// letting such rows compete for the LIMIT-100 scan slots let a backlog of
// them starve the rows that could resolve (codex #4293 P1). An earlier round
// answered that by plucking EVERY visit id in reschedule_log with a
// self-serve move — the whole table's history, materialized on every tick
// and then pushed back as an unbounded WHERE IN list (codex #4293 P2 r3).
// The evidence check belongs INSIDE the bounded query instead: a correlated
// EXISTS against reschedule_log's own (scheduled_service_id) index, evaluated
// per candidate row as the fairness-ordered scan walks toward its LIMIT, so
// nothing about the log's size is ever fetched or carried in the query.
// selfServeMoveAfterSend below still re-checks the exact after-sent_at
// boundary on each row it stamps as used.
function whereSelfServeMoveExists(query) {
  return query.whereRaw(`EXISTS (
      SELECT 1 FROM reschedule_log rl
      WHERE rl.scheduled_service_id = outbox_messages.related_scheduled_service_id
        AND rl.initiated_by = ?
        AND (outbox_messages.sent_at IS NULL OR rl.created_at >= outbox_messages.sent_at)
    )`, [SELF_SERVE_INITIATOR]);
}

// The post-commit hook in reschedule-public is best-effort: a transient DB
// failure or a process death after the move commits would otherwise leave the
// linked triage cards open forever, because a delivered row has left the
// worker sweep and a client retry returns from the idempotent-replay branch
// (codex #4293 r1 P2). This is the last chance — same evidence, run from the
// sweep until it lands.
async function reconcileUsedLinks(conn, now = new Date()) {
  const rows = await whereSelfServeMoveExists(unreconciledPromiseRows(conn)).orderBy(SCAN_FAIRNESS_ORDER)
    .limit(100).select('id', 'status', 'commitment_id', 'related_call_log_id', 'related_scheduled_service_id', 'sent_at');
  await stampScanned(conn, rows, now);
  return reconcileRows(conn, rows);
}

module.exports = { mode, selectDiscussedVisit, snapshot, stagePromises, matchingSend, claimForDispatch, runOne, sweep, withSendLock, resolveUsedLink, reconcileUsedLinks, recordLiveActivation, settleParkedPromiseCard, contextFor, fulfilPromise, markLinkUsed };
