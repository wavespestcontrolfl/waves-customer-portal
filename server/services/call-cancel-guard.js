/**
 * Cancel guard (GATE_CALL_CANCEL_GUARD, dark by default).
 *
 * 2026-10-30: a new lead agreed a visit on a 12:52 AM call that did not book (a "time unclear" card asking the office to
 * book it). At 7:08 AM she called back and canceled. Nothing was booked yet, so nothing was removed; the cancel filed a
 * cancellation_request card under the same "time unclear" label, and the 12:52 card stayed open. At 11:22 the office
 * booked her from New Appointment, which showed nothing about the cancel.
 *
 * Two reads of one fact, "this customer canceled on a call":
 *   - runCallCancelGuardSweep (scheduler, every 10 minutes): for a cancel call whose customer has NO live visit, the same
 *     customer's OPEN booking-ask cards from calls in the 14 days before it are dismissed, each with a note naming the
 *     cancel call. The cancel card itself stays open for a person. Dismissed, not resolved: nobody did the asked work.
 *   - latestCancelCall (New Appointment notice, GET /admin/schedule/cancel-call-notice): the customer's latest real
 *     conversation in the last 14 days, when that call filed a cancel card. A warning only; the save always goes through.
 *
 * Never texts, emails or touches a visit. Fails closed: any visit that is not completed or cancelled (or has no status)
 * keeps every card open, a card a person claimed (in_progress) is never touched, and a cancel counts only from a card
 * that was not dismissed, on a call that is still a real conversation (a transcript rejected as a hallucination turns
 * its call into a voicemail and dismisses its cards, so its cancel no longer counts).
 */

const db = require('../models/db');
const logger = require('./logger');
const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
const { formatETDayDate, formatETTime } = require('../utils/datetime-et');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { parseExtraction, isRealConversation } = require('./call-held-visits');

const CANCEL_REASON = 'cancellation_request';
// The cards that ask the office to BOOK this call's visit. existing_appointment_* and booking_* cards answer to a visit
// that exists, so they are not here.
const BOOKING_ASK_REASONS = ['ambiguous_scheduling', 'not_confirmed', 'confirmed_without_start_time', 'off_hour_start'];
const DISMISS_RULE = 'customer_canceled_on_later_call';
const LOOKBACK_DAYS = 3;
const PRIOR_WINDOW_DAYS = 14;
const NOTICE_WINDOW_DAYS = 14;
const SCAN_LIMIT = 200;
const MAX_DISMISSALS_PER_RUN = 50;
const CLOSED_VISIT_STATUSES = ['completed', 'cancelled'];
// A dismissed cancel card was thrown out (a rejected transcript, or a person who judged it not a cancel).
const COUNTED_CANCEL_CARD_STATUSES = ['open', 'in_progress', 'resolved'];
const NOTICE_SCAN_LIMIT = 20;
const DAY_MS = 86400 * 1000;

const live = () => require('../config/feature-gates').callCancelGuardLive();

// Any visit that is not completed or cancelled (a NULL status counts as live) means the office has something booked for
// this customer, so the cards stay for a person.
async function hasLiveVisit(conn, customerId) {
  const row = await conn('scheduled_services')
    .where({ customer_id: customerId })
    .where((qb) => qb.whereNull('status').orWhereNotIn('status', CLOSED_VISIT_STATUSES))
    .first('id');
  return Boolean(row);
}

const realConversation = (call) => isRealConversation(call, parseExtraction(call.ai_extraction_enriched) || {});

// The cancel still stands: the call is still a real conversation and its cancel card was not dismissed.
async function cancelStands(conn, callId) {
  const call = await conn('call_log').where({ id: callId }).first('processing_status', 'answered_by', 'ai_extraction_enriched');
  if (!call || call.processing_status !== 'processed' || !realConversation(call)) return false;
  const card = await conn('triage_items')
    .where({ call_log_id: callId, reason_code: CANCEL_REASON })
    .whereIn('status', COUNTED_CANCEL_CARD_STATUSES)
    .first('id');
  return Boolean(card);
}

function cancelNote(cancel) {
  const at = new Date(cancel.created_at);
  return `The customer canceled on a later call (${formatETDayDate(at)}, ${formatETTime(at)}). Book only if they ask again.`;
}

/**
 * Dismisses stale booking-ask cards for customers who canceled on a call. Dark behind GATE_CALL_CANCEL_GUARD.
 * @returns {{skipped?:true, scanned:number, dismissed:number}}
 */
async function runCallCancelGuardSweep({ now = new Date() } = {}) {
  if (!live()) return { skipped: true, scanned: 0, dismissed: 0 };
  const cancels = await db('triage_items as t')
    .join('call_log as c', 'c.id', 't.call_log_id')
    .where('t.reason_code', CANCEL_REASON)
    .whereIn('t.status', COUNTED_CANCEL_CARD_STATUSES)
    .where('c.processing_status', 'processed')
    .where('c.created_at', '>=', new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS))
    .whereNotNull('c.customer_id')
    .modify((qb) => whereNotSandboxCall(qb, 'c.source'))
    .orderBy('c.created_at', 'desc')
    .limit(SCAN_LIMIT)
    .distinct('c.id as call_id', 'c.customer_id', 'c.created_at');
  let dismissed = 0;
  for (const cancel of cancels) {
    if (dismissed >= MAX_DISMISSALS_PER_RUN) break;
    if (!(await cancelStands(db, cancel.call_id))) continue;
    if (await hasLiveVisit(db, cancel.customer_id)) continue;
    const cancelAt = new Date(cancel.created_at);
    const cards = await db('triage_items as t')
      .join('call_log as c', 'c.id', 't.call_log_id')
      .where('c.customer_id', cancel.customer_id)
      .where('t.status', 'open')
      .where('t.category', 'time_ambiguous')
      .whereIn('t.reason_code', BOOKING_ASK_REASONS)
      .whereNot('t.call_log_id', cancel.call_id)
      .where('c.created_at', '<', cancelAt)
      .where('c.created_at', '>=', new Date(cancelAt.getTime() - PRIOR_WINDOW_DAYS * DAY_MS))
      .select('t.id', 't.call_log_id');
    for (const card of cards) {
      if (dismissed >= MAX_DISMISSALS_PER_RUN) break;
      await db.transaction(async (trx) => {
        // Both calls, in one fixed order: the card's call (the write) and the cancel call (its evidence, which a
        // transcript rejection changes under the same lock).
        for (const id of [card.call_log_id, cancel.call_id].map(String).sort()) await lockTriageCall(trx, id);
        // The cancel was thrown out, or a visit was booked, since the reads above: leave the card.
        if (!(await cancelStands(trx, cancel.call_id))) return;
        if (await hasLiveVisit(trx, cancel.customer_id)) return;
        const stamp = new Date();
        const n = await trx('triage_items').where({ id: card.id, status: 'open' }).update({
          status: 'dismissed', resolution_source: 'auto', resolution_rule: DISMISS_RULE,
          resolution_note: cancelNote(cancel), resolved_at: stamp, updated_at: stamp,
        });
        if (n) {
          await syncCallReviewStatus(trx, card.call_log_id, 'dismissed');
          dismissed += 1;
        }
      });
    }
  }
  return { scanned: cancels.length, dismissed };
}

/**
 * The customer's latest real conversation in the last 14 days, when that call filed a cancel card that still stands;
 * else null. Voicemails and spam are skipped, even ones marked processed. A later real conversation (inbound or
 * outbound) hides it: the cancel is no longer the customer's latest word.
 * @returns {Promise<null|{callId:string, at:string, summary:string|null}>}
 */
async function latestCancelCall(customerId, { now = new Date() } = {}) {
  const recent = await db('call_log')
    .where({ customer_id: customerId, processing_status: 'processed' })
    .where('created_at', '>=', new Date(now.getTime() - NOTICE_WINDOW_DAYS * DAY_MS))
    .modify((qb) => whereNotSandboxCall(qb))
    .orderBy('created_at', 'desc')
    .limit(NOTICE_SCAN_LIMIT)
    .select('id', 'created_at', 'processing_status', 'answered_by', 'ai_extraction_enriched');
  const latest = recent.find(realConversation);
  if (!latest) return null;
  const card = await db('triage_items')
    .where({ call_log_id: latest.id, reason_code: CANCEL_REASON })
    .whereIn('status', COUNTED_CANCEL_CARD_STATUSES)
    .orderBy('created_at', 'desc')
    .first('summary');
  if (!card) return null;
  return { callId: latest.id, at: new Date(latest.created_at).toISOString(), summary: card.summary || null };
}

module.exports = {
  runCallCancelGuardSweep,
  latestCancelCall,
  _test: { BOOKING_ASK_REASONS, DISMISS_RULE, cancelNote, hasLiveVisit, cancelStands },
};
