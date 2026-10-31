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
 *     cancel call, when the cancel covers every service the card asked for, came from a verified caller, and the customer
 *     has at most one active property. The cancel
 *     card itself stays open for a person. Dismissed, not resolved: nobody did the asked work.
 *   - latestCancelCall (New Appointment notice, GET /admin/schedule/cancel-call-notice): the customer's latest real
 *     conversation in the last 14 days, when that call filed a cancel card. A warning only; the save always goes through.
 *
 * Why its own 10-minute job and not a rule in triage-auto-resolve.js: that sweep runs once a night (3:20 AM ET) to drain
 * the backlog. On 10-30 the office booked the canceled caller 4 hours after her cancel, so the stale card has to close
 * within minutes, not the next night. The writes follow the same contract as every card writer: the per-call advisory
 * lock and review_status sync from utils/triage-locks.js (the call-prepay-choice sweep is the same shape).
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

const extractionOf = (call) => parseExtraction(call.ai_extraction_enriched) || {};
const realConversation = (call) => isRealConversation(call, extractionOf(call));
const CALL_COLUMNS = ['id', 'customer_id', 'direction', 'processing_status', 'answered_by', 'metadata', 'ai_extraction_enriched'];
// Categories that do not name ONE service: 'other' is the catch-all and a WaveGuard bundle spans several, so a scope
// holding one of them is never proven covered.
const NON_SPECIFIC_CATEGORIES = new Set(['other', 'bundled_waveguard']);

// Every service a call asked about: its primary and secondary categories.
function callScope(call) {
  const request = extractionOf(call).service_request || {};
  const secondary = Array.isArray(request.secondary_categories) ? request.secondary_categories : [];
  return [request.primary_service_category, ...secondary].filter(Boolean).map(String);
}

// What the booking card asked for: the routing snapshot of every requested category (call-routing-gates.js
// scheduling_window), else its call's own categories.
function cardScope(card, cardCall) {
  const payload = parseExtraction(card.payload) || {};
  const snap = payload.scheduling_window?.requested_service_categories;
  return Array.isArray(snap) && snap.length ? snap.filter(Boolean).map(String) : callScope(cardCall);
}

// The cancel covers the whole ask: every service the card asked for is one the cancel call named, and none of them is
// non-specific. An empty scope on either side covers nothing.
function cancelCoversCard(cancelCall, card, cardCall) {
  const asked = cardScope(card, cardCall);
  const canceled = new Set(callScope(cancelCall));
  if (!asked.length || !canceled.size) return false;
  if ([...asked, ...canceled].some((c) => NON_SPECIFIC_CATEGORIES.has(c))) return false;
  return asked.every((c) => canceled.has(c));
}

// Who said "cancel" is proven: the office dialed the number (outbound), or the carrier vouched that the caller owns it
// (STIR/SHAKEN attestation A, the voice relay's own rule). A spoofed caller ID never closes a customer's card.
function callerVerified(call) {
  if (String(call.direction || '').toLowerCase().startsWith('outbound')) return true;
  const meta = parseExtraction(call.metadata) || {};
  return require('./voice-agent/relay-context').isFullAttestation(meta.stir_verstat);
}

// The cancel still stands: the call is still a processed real conversation, and the NEWEST cancel card on it (a
// reprocess can file a second one) was not dismissed.
async function cancelStands(conn, cancelCall) {
  if (!cancelCall || cancelCall.processing_status !== 'processed' || !realConversation(cancelCall)) return false;
  const newest = await conn('triage_items')
    .where({ call_log_id: cancelCall.id, reason_code: CANCEL_REASON })
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first('status');
  return Boolean(newest) && COUNTED_CANCEL_CARD_STATUSES.includes(newest.status);
}

// Every condition for dismissing one booking card, read fresh from `conn` (re-run under the locks before the write):
// the card is still open, both calls still belong to this customer, the cancel still stands and came from a verified
// caller, it covers every service the card asked for, the customer has at most one active property (which property
// was canceled is otherwise unknown), and nothing is booked for them.
async function cardIsMoot(conn, { customerId, cancelCallId, cardId }) {
  const card = await conn('triage_items').where({ id: cardId }).first('id', 'call_log_id', 'status', 'payload');
  if (!card || card.status !== 'open') return false;
  const calls = await conn('call_log').whereIn('id', [cancelCallId, card.call_log_id]).select(CALL_COLUMNS);
  const cancelCall = calls.find((c) => String(c.id) === String(cancelCallId));
  const cardCall = calls.find((c) => String(c.id) === String(card.call_log_id));
  if (!cancelCall || !cardCall) return false;
  if (String(cancelCall.customer_id) !== String(customerId) || String(cardCall.customer_id) !== String(customerId)) return false;
  if (!callerVerified(cancelCall) || !(await cancelStands(conn, cancelCall))) return false;
  if (!cancelCoversCard(cancelCall, card, cardCall)) return false;
  const properties = await conn('customer_properties').where({ customer_id: customerId, active: true }).count('* as n').first();
  if (Number(properties?.n || 0) > 1) return false;
  return !(await hasLiveVisit(conn, customerId));
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
      const match = { customerId: cancel.customer_id, cancelCallId: cancel.call_id, cardId: card.id };
      if (!(await cardIsMoot(db, match))) continue;
      await db.transaction(async (trx) => {
        // Both calls, in one fixed order: the card's call (the write) and the cancel call (its evidence, which a
        // transcript rejection or a relink changes under the same lock). Then every condition again: the cancel was
        // thrown out, a call was relinked or a visit was booked since the read above, and the card stays.
        for (const id of [card.call_log_id, cancel.call_id].map(String).sort()) await lockTriageCall(trx, id);
        if (!(await cardIsMoot(trx, match))) return;
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
  // The newest cancel card decides (a reprocess can file a second one; a dismissal of the newer one wins).
  const card = await db('triage_items')
    .where({ call_log_id: latest.id, reason_code: CANCEL_REASON })
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first('summary', 'status');
  if (!card || !COUNTED_CANCEL_CARD_STATUSES.includes(card.status)) return null;
  return { callId: latest.id, at: new Date(latest.created_at).toISOString(), summary: card.summary || null };
}

module.exports = {
  runCallCancelGuardSweep,
  latestCancelCall,
  _test: { BOOKING_ASK_REASONS, DISMISS_RULE, cancelNote, hasLiveVisit, cardIsMoot, cancelCoversCard, callerVerified },
};
