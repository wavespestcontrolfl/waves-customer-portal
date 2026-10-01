/**
 * Outcome evidence for typed-decision reviews (dark behind GATE_TYPED_DECISIONS).
 *
 * WHAT THE DATABASE RECORDED AFTERWARDS, kept apart from what the conversation
 * MEANT. Each helper returns `{ source, window, value, observed_at }`:
 *   value true   the follow-up record exists inside the window
 *   value false  the window has fully elapsed and the record does not exist
 *   value null   UNKNOWN: the linkage needed to look is missing, or the window
 *                has not elapsed yet. Null is never a negative.
 * A positive (or, for is_courtesy_only, a later contact) is final the moment it
 * is seen, so it is returned before the window closes; only an absence has to
 * wait for the window to elapse.
 *
 * EVIDENCE IS FOR THE REVIEWER, NEVER A LABEL. An estimate going out proves
 * fulfillment, not that a quote was promised on this call; a booking can follow
 * a call that never agreed one; a lead row may have been created by the same
 * pipeline whose reading is being checked; a quiet thread may have ended on a
 * phone call. Nothing here writes a label or changes label_status. A stored
 * label and its evidence can disagree, and that is the point.
 *
 * Read-only against call_log, sms_log, leads, customers, scheduled_services,
 * job_status_history, reschedule_log and estimates, except
 * refreshOutcomeEvidence(), which rewrites decision_reviews.outcome_evidence
 * only (never a label column).
 */
const { excludeUnresolvedSendReservations } = require('../messaging/review-ask-reservation');
const db = require('../../models/db');
const logger = require('../logger');
const { typedDecisionsLive } = require('../../config/feature-gates');
const { callStartedAt } = require('../../utils/call-timeline');
const { etDateString } = require('../../utils/datetime-et');

const HOUR_MS = 60 * 60 * 1000;
const WINDOWS = { '24h': 24 * HOUR_MS, '48h': 48 * HOUR_MS, '7d': 7 * 24 * HOUR_MS };
const PHONE_TAIL_SQL = "RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?";
// Questions that have an evidence reader, per subject table.
const CALL_QUESTIONS = ['appointment_agreed', 'quote_promised', 'is_lead'];
const SMS_QUESTIONS = ['wants_visit_change', 'is_courtesy_only'];
const MOVE_STATUSES = ['rescheduled', 'cancelled', 'skipped'];
// Evidence older than this is no longer refreshed (a row whose linkage never
// appeared stays null rather than being re-read every day forever).
const REFRESH_FLOOR_DAYS = 30;

const tail10 = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
};
const isOutbound = (row) => String(row?.direction || '').startsWith('outbound');
const lazyBooking = () => require('../call-booking-link-text');
const { OUTCOME_SOURCES } = require('./packages');
const { LOGGED_MOVE_SQL } = require('../../utils/reschedule-log-sql');

// Every source is registered in OUTCOME_SOURCES with its one window: the fixture
// exporter keeps only registered pairs, so an unregistered one is a code bug.
function evidence(source, window, value, now) {
  if (OUTCOME_SOURCES[source] !== window) throw new Error(`unregistered outcome source: ${source}/${window}`);
  return { source, window, value, observed_at: now.toISOString() };
}

// found: the follow-up record was seen. `foundMeans` is the value a sighting
// carries (true for "it happened"; false for is_courtesy_only, where a later
// contact means the conversation did NOT simply end).
function settle({ source, window, found, end, now, foundMeans = true }) {
  if (found) return evidence(source, window, foundMeans, now);
  const elapsed = end && now.getTime() >= end.getTime() + WINDOWS[window];
  return evidence(source, window, elapsed ? !foundMeans : null, now);
}
const unknown = (source, window, now) => evidence(source, window, null, now);
const seen = async (query, column = 'id') => Boolean(await query.first(column));

// ── Calls ────────────────────────────────────────────────────────────────────

async function callContext(conn, call) {
  const key = tail10(isOutbound(call) ? call.to_phone : call.from_phone);
  const { leadId } = await lazyBooking().resolveLeadLinkage(conn, call);
  const lead = leadId
    ? await conn('leads').where({ id: leadId }).whereNull('deleted_at').first('id', 'customer_id', 'estimate_id')
    : null;
  let customerId = call.customer_id || lead?.customer_id || null;
  if (!customerId && key) {
    // Only an unambiguous match: two customers on one number is no linkage.
    const rows = await conn('customers').whereNull('deleted_at').whereRaw(PHONE_TAIL_SQL, [key]).limit(2).select('id');
    if (rows.length === 1) customerId = rows[0].id;
  }
  return { key, lead, customerId };
}

// A visit MOVED to a new date in [from, until], from reschedule_log. A missed
// appointment is logged there too (workflows/missed-appointment.js, reason
// customer_noshow) but carries no new_date: it is neither a booking nor a
// change the customer asked for, so only rows that really moved the slot count.
// `existedAt`: count only moves of a visit that already existed and had not
// yet happened at that moment (the text evidence: a later booking that is then
// moved says nothing about what the customer's text asked).
function movedTo(conn, customerId, from, until, { existedAt = null } = {}) {
  // A real change of date or window (the fulfillment checker's predicate): a
  // bulk reschedule onto the visit's own slot still writes a row.
  const q = conn('reschedule_log as r').where('r.customer_id', customerId).whereRaw(LOGGED_MOVE_SQL('r'))
    .where('r.created_at', '>=', from).where('r.created_at', '<=', until);
  if (!existedAt) return q;
  return q.join('scheduled_services as s', 's.id', 'r.scheduled_service_id')
    .where('s.customer_id', customerId)
    .where('s.created_at', '<=', existedAt).where('s.scheduled_date', '>=', etDateString(existedAt));
}

async function appointmentEvidence(conn, call, ctx, end, now) {
  const source = 'scheduled_services';
  const window = OUTCOME_SOURCES[source];
  if (!ctx.customerId || !end) return unknown(source, window, now);
  const until = new Date(end.getTime() + WINDOWS[window]);
  // From the call's START: staff often book while the customer is still on
  // the line, and that is the strongest evidence there is.
  const from = callStartedAt(call) || end;
  const base = () => conn('scheduled_services as s').where('s.customer_id', ctx.customerId);
  const created = await seen(base().where('s.created_at', '>=', from).where('s.created_at', '<=', until));
  const rescheduled = created ? true : await seen(base()
    .join('job_status_history as h', 'h.job_id', 's.id')
    .where('h.to_status', 'rescheduled').where('h.transitioned_at', '>=', from).where('h.transitioned_at', '<=', until), 's.id');
  // reschedule_log is the canonical record of a move (the same table the text
  // evidence reads); a move logged there without a status row still counts.
  const filed = created || rescheduled ? true : await seen(movedTo(conn, ctx.customerId, from, until), 'r.id');
  return settle({ source, window, found: created || rescheduled || filed, end, now });
}

async function quoteEvidence(conn, call, ctx, end, now) {
  const source = 'estimates';
  const window = OUTCOME_SOURCES[source];
  if ((!ctx.customerId && !ctx.lead) || !end) return unknown(source, window, now);
  const until = new Date(end.getTime() + WINDOWS[window]);
  // From the call's start, like appointment evidence: a quote sent while the
  // customer is still on the line counts.
  const from = callStartedAt(call) || end;
  const q = conn('estimates').whereNotNull('sent_at').where('sent_at', '>=', from).where('sent_at', '<=', until)
    .where(function linked() {
      if (ctx.customerId) this.orWhere('customer_id', ctx.customerId);
      if (ctx.lead?.estimate_id) this.orWhere('id', ctx.lead.estimate_id);
      if (ctx.lead?.id) this.orWhereRaw("estimate_data->>'lead_id' = ?", [String(ctx.lead.id)]);
    });
  return settle({ source, window, found: await seen(q), end, now });
}

async function leadEvidence(conn, call, ctx, end, now) {
  const source = 'leads_customers';
  const window = OUTCOME_SOURCES[source];
  const start = callStartedAt(call);
  if ((!ctx.key && !call.twilio_call_sid) || !end || !start) return unknown(source, window, now);
  const until = new Date(end.getTime() + WINDOWS[window]);
  const inWindow = (table) => conn(table).whereNull('deleted_at').where('created_at', '>=', start).where('created_at', '<=', until);
  const lead = inWindow('leads').where(function fromCall() {
    if (call.twilio_call_sid) this.orWhere('twilio_call_sid', call.twilio_call_sid);
    if (ctx.key) this.orWhereRaw(PHONE_TAIL_SQL, [ctx.key]);
  });
  let found = await seen(lead);
  if (!found && ctx.key) found = await seen(inWindow('customers').whereRaw(PHONE_TAIL_SQL, [ctx.key]));
  return settle({ source, window, found, end, now });
}

/**
 * Evidence for the call_judge questions that have an observable follow-up:
 * appointment_agreed (a visit created or rescheduled within 24h of the call's
 * end), quote_promised (an estimate SENT within 48h), is_lead (a leads or
 * customers row from that phone within 7d). `callRow` needs id, direction,
 * from_phone / to_phone, customer_id, twilio_call_sid, created_at,
 * duration_seconds, recording_duration_seconds, bridged_at and metadata.
 */
async function callEvidence(callRow, { now = new Date(), conn = db } = {}) {
  const end = callRow ? lazyBooking().callEndFor(callRow) : null;
  if (!callRow || !end) {
    return {
      appointment_agreed: unknown('scheduled_services', '24h', now),
      quote_promised: unknown('estimates', '48h', now),
      is_lead: unknown('leads_customers', '7d', now),
    };
  }
  const ctx = await callContext(conn, callRow);
  return {
    appointment_agreed: await appointmentEvidence(conn, callRow, ctx, end, now),
    quote_promised: await quoteEvidence(conn, callRow, ctx, end, now),
    is_lead: await leadEvidence(conn, callRow, ctx, end, now),
  };
}

// ── Texts ────────────────────────────────────────────────────────────────────

async function visitChangeEvidence(conn, sms, at, now) {
  const source = 'job_status_history';
  const window = OUTCOME_SOURCES[source];
  if (!sms.customer_id || !at) return unknown(source, window, now);
  const until = new Date(at.getTime() + WINDOWS[window]);
  // A visit that existed when the text arrived and had not already happened
  // (a moved visit keeps a later date, a cancelled one keeps its own).
  const services = () => conn('scheduled_services as s').where('s.customer_id', sms.customer_id)
    .where('s.created_at', '<=', at).where('s.scheduled_date', '>=', etDateString(at));
  const logged = await seen(services()
    .join('job_status_history as h', 'h.job_id', 's.id')
    .whereIn('h.to_status', MOVE_STATUSES).where('h.transitioned_at', '>', at).where('h.transitioned_at', '<=', until), 's.id');
  const filed = logged ? true : await seen(movedTo(conn, sms.customer_id, at, until, { existedAt: at }), 'r.id');
  return settle({ source, window, found: logged || filed, end: at, now });
}

async function courtesyEvidence(conn, sms, at, now) {
  const source = 'sms_log';
  const window = OUTCOME_SOURCES[source];
  if (!sms.customer_id || !at) return unknown(source, window, now);
  const until = new Date(at.getTime() + WINDOWS[window]);
  // The source text itself is never "a later contact": `at` may come back to
  // JS at millisecond precision while the row keeps microseconds, so the time
  // bound alone can let it through.
  // Scoped to the text's own thread (its phone pair), the same scope Jev and
  // the reviewer were given: traffic on another Waves line is a different
  // conversation. A row without phones falls back to the customer.
  const pair = sms.from_phone && sms.to_phone;
  const thread = (direction) => {
    if (!pair) return {};
    return direction === 'outbound'
      ? { to_phone: sms.from_phone, from_phone: sms.to_phone }
      : { from_phone: sms.from_phone, to_phone: sms.to_phone };
  };
  const texts = (direction) => {
    const q = conn('sms_log').where({ customer_id: sms.customer_id, direction, ...thread(direction) })
      .where('created_at', '>', at).where('created_at', '<=', until)
      .whereRaw("COALESCE(message_type, '') <> 'internal_alert'")
      .modify(excludeUnresolvedSendReservations);
    // An outbound row counts only once it actually went out ('scheduled' and
    // other pre-send rows are not contact); an inbound row is a received text.
    if (direction === 'outbound') q.whereIn('status', ['queued', 'sent', 'delivered']);
    else q.whereNotIn('status', ['failed', 'undelivered', 'blocked']);
    return sms.id ? q.whereNot('id', sms.id) : q;
  };
  let found = await seen(texts('outbound')) || await seen(texts('inbound'));
  if (!found) {
    // Only a call that reached the customer. Outbound calls are staff bridge
    // calls (call-bridge.js); bridged_at is stamped when staff press 1, BEFORE
    // the customer is dialed, so it proves nothing. The customer leg's own
    // result is metadata.customer_leg (/outbound-dial-complete): completed
    // with talk time = contact. A bridged call with no customer_leg record
    // (that capture covers callback calls only) could have gone either way:
    // the reading stays unknown rather than settling.
    const outboundCalls = () => conn('call_log').where('customer_id', sms.customer_id)
      .whereRaw("COALESCE(direction, '') LIKE 'outbound%'").whereNotNull('bridged_at')
      .where('created_at', '>', at).where('created_at', '<=', until);
    // The customer calling in shows the conversation went on, answered or not
    // (they reached out again; the text was not the end of it).
    found = await seen(conn('call_log').where('customer_id', sms.customer_id)
      .where('direction', 'inbound').where('created_at', '>', at).where('created_at', '<=', until));
    if (!found) found = await seen(outboundCalls()
      .whereRaw("metadata->'customer_leg'->>'status' = 'completed'")
      .whereRaw("COALESCE((metadata->'customer_leg'->>'duration_seconds')::numeric, 0) > 0"));
    if (!found && await seen(outboundCalls().whereRaw("metadata->'customer_leg' IS NULL"))) return unknown(source, window, now);
  }
  // A later contact means the conversation went on: false is final at once.
  return settle({ source, window, found, end: at, now, foundMeans: false });
}

/**
 * Evidence for the text questions: wants_visit_change (the customer's visit
 * was moved, cancelled or skipped within 7d) and is_courtesy_only (no Waves
 * outbound and no further inbound within 24h: the conversation simply ended).
 * `smsRow` needs id, customer_id and created_at; from_phone / to_phone scope
 * the courtesy reading to that thread.
 */
async function smsEvidence(smsRow, { now = new Date(), conn = db } = {}) {
  const at = smsRow?.created_at ? new Date(smsRow.created_at) : null;
  const sms = smsRow || {};
  return {
    wants_visit_change: await visitChangeEvidence(conn, sms, at, now),
    is_courtesy_only: await courtesyEvidence(conn, sms, at, now),
  };
}

// ── Refresh ──────────────────────────────────────────────────────────────────

const CALL_COLUMNS = ['id', 'customer_id', 'direction', 'from_phone', 'to_phone', 'twilio_call_sid', 'created_at',
  'duration_seconds', 'recording_duration_seconds', 'bridged_at', 'metadata'];
const SMS_COLUMNS = ['id', 'customer_id', 'created_at', 'from_phone', 'to_phone'];

/**
 * Re-reads evidence for review rows whose evidence value is still null (or was
 * never read): rows at least `olderThanHours` old and no older than 30 days.
 * Writes outcome_evidence only, and only when the new reading is not null.
 * Gate off = no read, no write.
 */
async function refreshOutcomeEvidence({ olderThanHours = 24, limit = 200, now = new Date(), conn = db } = {}) {
  const result = { checked: 0, updated: 0 };
  if (!typedDecisionsLive()) return { ...result, skipped: 'gate_off' };
  const cutoff = new Date(now.getTime() - olderThanHours * HOUR_MS);
  const floor = new Date(now.getTime() - REFRESH_FLOOR_DAYS * 24 * HOUR_MS);
  const rows = await conn('decision_reviews')
    .whereIn('question_id', [...CALL_QUESTIONS, ...SMS_QUESTIONS])
    .where(function unread() { this.whereNull('outcome_evidence').orWhereRaw("outcome_evidence->>'value' IS NULL"); })
    .where('created_at', '<=', cutoff).where('created_at', '>=', floor)
    // A random pick, not newest-first: rows whose evidence can stay unknown
    // for the whole window must not starve older rows behind a fixed limit.
    .orderByRaw('random()').limit(limit)
    .select('id', 'subject_type', 'subject_id', 'question_id');
  const cache = new Map();
  for (const row of rows) {
    result.checked += 1;
    try {
      const key = `${row.subject_type}:${row.subject_id}`;
      if (!cache.has(key)) {
        const isCall = row.subject_type === 'call_log';
        const subject = await conn(row.subject_type).where({ id: row.subject_id }).first(...(isCall ? CALL_COLUMNS : SMS_COLUMNS));
        cache.set(key, subject ? (isCall ? await callEvidence(subject, { now, conn }) : await smsEvidence(subject, { now, conn })) : {});
      }
      const next = cache.get(key)[row.question_id];
      if (!next || next.value === null) continue;
      await conn('decision_reviews').where({ id: row.id }).update({ outcome_evidence: JSON.stringify(next) });
      result.updated += 1;
    } catch (err) {
      logger.warn(`[typed-decisions] evidence refresh failed for review ${row.id}: ${err.message}`);
    }
  }
  return result;
}

module.exports = { callEvidence, smsEvidence, refreshOutcomeEvidence, WINDOWS, CALL_QUESTIONS, SMS_QUESTIONS };
