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
const sendContext = new AsyncLocalStorage();
function mode() {
  const value = String(process.env.GATE_RESCHEDULE_LINK_ON_PROMISE || '').toLowerCase();
  return isEnabled('callCommitments') && ['shadow', 'true'].includes(value) ? value : 'off';
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
function standingPromiseQuotes(commitment, turns) {
  if (!turns?.agent?.length) return [];
  return (commitment.evidence || []).filter((e) => e.speaker === 'agent').map((e) => norm(e.quote))
    .filter((quote) => /\blink\b/.test(quote) && /\b(send|text|email|sending|texting)\b/.test(quote)
      && /\b(?:i|we) (?:ll|will|am going to|are going to|am sending|m sending)\b|\blet me\b/.test(quote))
    .filter((quote) => {
      const spokenAt = turns.agent.findIndex((turn) => turn.includes(quote) && !CONDITIONAL.test(turn));
      return spokenAt >= 0 && !turns.agent.slice(spokenAt + 1).some((turn) => AGENT_RETRACTION.test(turn));
    });
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

// True once the quote itself grounds the extracted date: an explicit claim
// (absolute date, ordinal day, or today/tomorrow/next-weekday) must equal it
// exactly; absent any explicit claim, a bare weekday name may ground it only
// when it names exactly one open visit.
function quoteGroundsVisitDate(quote, ymd, reference, candidates = []) {
  const q = ` ${norm(quote)} `;
  const [year, month, day] = String(ymd).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return false;
  const explicit = explicitQuoteDate(q, reference);
  if (explicit) {
    return explicit.day === day && (explicit.month == null || explicit.month === month)
      && (explicit.year == null || explicit.year === year);
  }
  return quoteNamesWeekday(q, weekdayOf(ymd), candidates, ymd);
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
// verdict answers the time question: a pending/confirmed visit whose window has
// passed was MISSED, not served, and /reschedule/:token still lets the customer
// pick a new time — the call that follows a missed visit is the one most likely
// to be promised this link, and a local "two hours past the start" rule turned
// every one of them away (codex #4293 r3 P2). Group membership and the token
// stay here; only reschedule-eligibility decides missed-vs-past.
function visitNotSelfServiceReason(visit, now) {
  if (!['pending', 'confirmed'].includes(visit.status) || !visit.reschedule_token
    || (visit.visit_id && visit.follow_through_group_eligible !== true)) return 'visit_not_self_service';
  const verdict = require('./reschedule-eligibility').eligibility(visit, now);
  if (verdict.ok) return null;
  return verdict.reason === 'past' ? 'visit_elapsed' : 'visit_not_self_service';
}

// A wrong extraction cannot be trusted to disambiguate on its own once more
// than one visit is open: the quote itself must name the picked date. Exactly
// one open visit needs no such check — there is nothing left to disambiguate.
function extractedDateUngrounded({ subject, call, candidates, callCommitments }) {
  return !!subject?.visit_date && candidates.length > 1
    && !quoteGroundsVisitDate(subject.quote, subject.visit_date, callCommitments.callEndedAt(call) || call.created_at, candidates);
}

function selectDiscussedVisit({ commitment, call, customer, candidates = [], now = new Date() }) {
  const skip = (reason) => ({ reason });
  const identity = callerIdentityReason(call, customer);
  if (identity) return skip(identity);
  const callCommitments = require('./call-commitments');
  const turns = callCommitments.speakerTurns(call.transcription);
  const revoked = (turns?.caller || []).some((turn) => /\b(?:don t|do not|no need|never mind)\b/.test(turn) && /\b(?:link|text|send|email)\b/.test(turn));
  const promisedQuotes = standingPromiseQuotes(commitment, turns);
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
  if (!commitment?.call_log_id || commitment.status !== 'open' || commitment.human_state) return { reason: 'promise_closed' };
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
    .where(function carriesLink() { for (const needle of needles) this.orWhere('message_body', 'like', `%${needle}%`); })
    .orderBy('created_at', 'desc').limit(201).select('id', 'twilio_sid', 'status', 'created_at', 'customer_id', 'to_phone', 'message_body');
  if (messages.length > 200) throw new Error('Promised-link delivery evidence is truncated');
  return messages.find((sms) => carriesVisitLink(sms.message_body, needles)) || null;
}

async function parkReview(conn, row, reason) {
  await conn.transaction(async (trx) => {
    await lockTriageCall(trx, row.related_call_log_id);
    const changed = await trx('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
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

// The card this promise's own exceptions raise. One promise reaching a
// terminal state — delivered, or closed by the office — drops only ITS id;
// the card resolves when the last parked promise on the call is gone, so a
// second obligation never disappears with the first. Unrelated call flags are
// untouched, and review_status re-syncs the way admin-triage transitionCore
// does.
async function clearPromiseException(trx, callLogId, commitmentId, note) {
  const cards = await trx('triage_items').where({ call_log_id: callLogId, reason_code: 'reschedule_link_promise' })
    .whereIn('status', ['open', 'in_progress']).select('id', 'payload');
  for (const card of cards) {
    const parked = promiseCommitmentIds(card.payload);
    if (!parked.includes(commitmentId)) continue;
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

// Delivery — and only delivery — keeps the promise.
async function fulfilPromise(trx, row, sms, call) {
  const updated = await trx('call_commitments').where({ id: row.commitment_id, status: 'open' }).whereNull('human_state')
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
// parked row stays parked for the office.
function settledOutboxPatch(current, sms, context, { delivered, visitId, generation }) {
  const parked = current.status === 'review';
  return {
    status: delivered ? 'delivered' : (parked ? 'review' : 'sent'),
    ...(delivered ? { last_error: null } : {}),
    related_scheduled_service_id: visitId, provider_message_id: sms.twilio_sid, sent_at: sms.created_at,
    payload: { ...current.payload, call_generation: generation, visit_snapshot: current.payload?.visit_snapshot || (context?.visit ? snapshot(context.visit) : null) },
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
  }).then((result) => result?.needsReview ? parkReview(conn, row, 'delivery_scope_changed') : result);
}

async function stagePromises(conn) {
  if (mode() === 'off') return 0;
  const rows = await conn('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
    .leftJoin('outbox_messages as o', 'o.commitment_id', 'cc.id').whereNull('o.id')
    .where({ 'cc.kind': KIND, 'cc.party': 'waves', 'cc.status': 'open' }).whereNull('cc.human_state')
    .select('cc.id', 'cc.call_log_id', 'cl.customer_id').limit(200);
  for (const row of rows) await conn('outbox_messages').insert({ channel: 'sms', status: mode() === 'shadow' ? 'shadow' : 'pending',
    payload: { kind: KIND }, commitment_id: row.id, related_call_log_id: row.call_log_id, related_customer_id: row.customer_id,
    available_at: new Date() }).onConflict('commitment_id').ignore();
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
  if (failed && unparked) await parkReview(conn, row, 'delivery_failed');
  else if (sms && ['delivered', 'read'].includes(sms.status)) await settleDelivery(conn, row, sms);
  else if (unparked && new Date(row.sent_at || row.last_attempt_at).getTime() + 24 * 3600000 < now.getTime()) await parkReview(conn, row, 'delivery_receipt_unavailable');
  else if (sms && !failed && unparked) await settleDelivery(conn, row, sms);
  else if (unparked) await conn('outbox_messages').where({ id: row.id }).update({ updated_at: now });
  else return false;
  return true;
}

// The promise is no longer sendable: a closed promise cancels the row, shadow
// mode records the reason without touching the customer, and live mode hands
// the promise to the office.
async function applyContextSkip(conn, row, reason, now) {
  // The office dismissed or hand-fulfilled the promise. Cancelling the outbox
  // row alone would leave this promise's own exception card open forever —
  // classifyTriageItem deliberately keeps it out of the generic sweep, so the
  // call would sit in review against a decision already made (codex #4293 r2
  // P2).
  if (reason === 'promise_closed') return conn.transaction(async (trx) => {
    await lockTriageCall(trx, row.related_call_log_id);
    await trx('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
      .update({ status: 'cancelled', updated_at: now });
    await clearPromiseException(trx, row.related_call_log_id, row.commitment_id, 'The promise was closed by the office.');
  });
  if (mode() === 'shadow') return conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow'])
    .update({ status: 'shadow', last_error: reason, updated_at: now });
  return parkReview(conn, row, reason);
}

// The one customer handoff: render, claim, hand to the central send pipeline
// with a final source recheck at both the dispatch and provider boundaries,
// then record what the provider said. Anything unknown parks.
async function dispatch(conn, row, context, { now, send, buildLink, render, planned, evidenceSince }) {
  const { commitment, call, customer, visit } = context;
  const link = await (buildLink || require('./reschedule-link').buildRescheduleLink)(visit.id, { customerId: customer.id });
  if (!link?.url) return parkReview(conn, row, 'link_unavailable');
  const body = await (render || require('../routes/admin-sms-templates').getTemplate)('reschedule_link_promise', {
    first: customer.first_name || 'there', link: link.url,
  }, { customerId: customer.id }, { noVariants: true, requiredVars: ['link'] });
  if (!body) return parkReview(conn, row, 'template_unavailable');
  // A committed claim survives process death. Unknown provider outcomes are
  // reconciled from delivery evidence or parked, never blindly resent.
  const claimed = await conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow'])
    .update({ status: 'sending', attempts: conn.raw('attempts + 1'), last_attempt_at: now, updated_at: now,
      related_scheduled_service_id: visit.id, payload: { ...row.payload, call_generation: call.processing_generation, visit_snapshot: planned, link: link.url } });
  if (!claimed) return;
  row.related_scheduled_service_id = visit.id;
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
    // #4293 r2 P2).
    if (result.blocked && result.code === 'LINK_LOCK_BUSY') return conn('outbox_messages').where({ id: row.id, status: 'sending' })
      .update({ status: 'pending', available_at: new Date(now.getTime() + LOCK_RETRY_MINUTES * 60000), last_error: result.code, updated_at: new Date() });
    if (result.blocked && ['LINK_QUIET_HOURS', 'QUIET_HOURS_HOLD', 'LINK_GATE_OFF'].includes(result.code)) return conn('outbox_messages').where({ id: row.id, status: 'sending' })
      .update({ status: 'pending', available_at: nextSendWindowOpenET(new Date()), last_error: result.code, updated_at: new Date() });
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

async function runOne(conn, row, { now = new Date(), send = null, buildLink = null, render = null } = {}) {
  if (mode() === 'off') return;
  // Another sweep may have completed this item since it was listed.
  row = await conn('outbox_messages').where({ id: row.id }).first();
  if (!row || ['delivered', 'cancelled'].includes(row.status)) return;
  // Reconcile accepted/ambiguous attempts before planning any new send.
  if (row.provider_message_id && await reconcileAttempt(conn, row, now)) return;
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
  await stagePromises(conn);
  const now = options.now || new Date();
  const rows = await conn('outbox_messages').whereNotNull('commitment_id').whereIn('status', ['pending', 'shadow', 'sending', 'sent', 'review'])
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
    openInterlocks -= 1;
    // A connection that lands after the race was lost still has to be closed,
    // or the timeout leaks the very slot it was protecting.
    if (opening) opening.then((late) => closeInterlockConnection(late, false), () => {});
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
// safe to retry from anywhere.
async function markLinkUsed(conn, row) {
  await require('./triage-auto-resolve').resolveRescheduleCards(conn, row.related_call_log_id, USED_LINK_NOTE, row.related_scheduled_service_id);
  // A row parked for a missing carrier receipt raised this promise's own
  // exception card, and classifyTriageItem keeps that card out of the
  // generic sweep. The customer following the same link answers it: there
  // is no office work left to chase. The card closes; the promise's own
  // status does NOT move, because a missing receipt is still not proof of
  // delivery (codex #4293 r2 P2).
  if (row.status === 'review') {
    await conn.transaction(async (trx) => {
      await lockTriageCall(trx, row.related_call_log_id);
      await clearPromiseException(trx, row.related_call_log_id, row.commitment_id, USED_LINK_NOTE);
    });
  }
  await conn('outbox_messages').where({ id: row.id })
    .update({ payload: conn.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ link_used_reconciled_at: new Date().toISOString() })]), updated_at: new Date() });
}

function unreconciledPromiseRows(conn) {
  return conn('outbox_messages').whereNotNull('commitment_id').whereIn('status', ATTEMPTED_STATUSES)
    .whereNotNull('related_scheduled_service_id').whereNotNull('related_call_log_id')
    .where(function attempted() { this.whereNot('status', 'review').orWhereNotNull('provider_message_id'); })
    .whereRaw("(payload->>'link_used_reconciled_at') IS NULL");
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

// Every visit that has EVER had a self-serve move recorded — fetched once,
// before the per-row LIMIT below. A promised-link row whose customer never
// touched /reschedule/:token can never be reconciled, and ordering the raw
// unreconciled set by updated_at let a backlog of exactly those untouched
// rows occupy the whole LIMIT 100 forever: their updated_at never advances
// (nothing about them changes), so once 100 accumulated, no row behind them
// was ever scanned again and its triage card stayed open even after the
// post-commit hook in reschedule-public failed (codex #4293 P1). Filtering on
// this set first means only rows that could actually resolve compete for a
// scan slot; selfServeMoveAfterSend below still enforces the exact
// after-sent_at boundary per row.
function selfServeVisitIds(conn) {
  return conn('reschedule_log').where({ initiated_by: SELF_SERVE_INITIATOR }).pluck('scheduled_service_id');
}

// The post-commit hook in reschedule-public is best-effort: a transient DB
// failure or a process death after the move commits would otherwise leave the
// linked triage cards open forever, because a delivered row has left the
// worker sweep and a client retry returns from the idempotent-replay branch
// (codex #4293 r1 P2). This is the last chance — same evidence, run from the
// sweep until it lands.
async function reconcileUsedLinks(conn, now = new Date()) {
  const visitIds = await selfServeVisitIds(conn);
  if (!visitIds.length) return 0;
  const rows = await unreconciledPromiseRows(conn).whereIn('related_scheduled_service_id', visitIds).orderBy(SCAN_FAIRNESS_ORDER)
    .limit(100).select('id', 'status', 'commitment_id', 'related_call_log_id', 'related_scheduled_service_id', 'sent_at');
  await stampScanned(conn, rows, now);
  return reconcileRows(conn, rows);
}

module.exports = { mode, selectDiscussedVisit, snapshot, stagePromises, runOne, sweep, withSendLock, resolveUsedLink, reconcileUsedLinks };
