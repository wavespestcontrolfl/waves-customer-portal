/**
 * Street-level address hold (GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL, owner
 * ruling 2026-09-30): a call-booked visit at a web-form address Google matched
 * only to the street. It lives on the office-review pending path; the durable
 * signal is its outbound_booking_review triage card (payload.street_level_address
 * + payload.scheduled_service_id). The hold lasts while the visit is
 * unconfirmed (customer_confirmed = false) and not cancelled / skipped /
 * rescheduled.
 *
 * Customer-facing reminders wait for the office confirm: the confirm hook arms
 * them (runOutboundReviewConfirmHook), so neither the registration self-heal
 * nor the reminder send pass may act on a held visit.
 */

const db = require('../models/db');
const logger = require('./logger');

// Builds the hold subquery on `q` (a knex builder, e.g. inside whereExists /
// whereNotExists): a card for the outer visit `visitAlias` while that visit is
// unconfirmed and not cancelled / skipped / rescheduled.
function heldVisitSubquery(q, visitAlias = 'ss') {
  return q.select(1)
    .from('triage_items as hold_ti')
    .where('hold_ti.reason_code', 'outbound_booking_review')
    .whereRaw("COALESCE(hold_ti.payload->>'street_level_address', '') = 'true'")
    .whereRaw(`hold_ti.payload->>'scheduled_service_id' = ${visitAlias}.id::text`)
    .whereRaw(`${visitAlias}.customer_confirmed = false`)
    .whereRaw(`${visitAlias}.status NOT IN ('cancelled', 'skipped', 'rescheduled')`);
}

// THE live predicate: true while the visit is an unconfirmed street-level hold
// (card present, customer_confirmed false, not cancelled / skipped / rescheduled),
// read fresh from the database. (findStreetLevelHoldCard below is the different
// question — "was this ever a hold", status-agnostic.) A lookup error answers
// true ("still held"): the reminder path must hold on a blip, and the bell path
// rings on a blip.
async function isStreetLevelHoldVisit(scheduledServiceId, conn = db) {
  if (!scheduledServiceId) return false;
  try {
    const row = await conn('scheduled_services as ss')
      .where('ss.id', scheduledServiceId)
      .whereExists(function () { heldVisitSubquery(this, 'ss'); })
      .first('ss.id');
    return !!row;
  } catch (err) {
    logger.warn(`[street-level-hold] hold lookup failed for ${scheduledServiceId}: ${err.code || err.name || 'error'}`);
    return true;
  }
}

function parsePayload(v) {
  if (v && typeof v === 'object') return v;
  try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

// The LATEST street-level review card for this visit, whatever its status: a
// recording replacement / adoption supersedes (resolves) the card while the
// visit stays pending, so every reader of the hold (the reuse checks, the
// confirm hook's follow-up and disposition legs) keys off the visit's card, not
// its open state. Returns { id, status, payload, summary } or null.
async function findStreetLevelHoldCard(conn, { callLogId, visitId }) {
  if (!callLogId || !visitId) return null;
  const card = await conn('triage_items')
    .where({ call_log_id: callLogId, reason_code: 'outbound_booking_review' })
    .whereRaw("COALESCE(payload->>'street_level_address', '') = 'true'")
    .whereRaw("payload->>'scheduled_service_id' = ?", [String(visitId)])
    .orderBy('created_at', 'desc')
    .first('id', 'status', 'payload', 'summary');
  if (!card) return null;
  return { ...card, payload: parsePayload(card.payload) || {} };
}

// A cancelled / skipped street-level hold visit no longer needs the office's
// address confirmation: resolve its open review card and recompute the call's
// review_status, under the shared per-call lock. Gated on the card signal (only
// a voice_agent-source visit with a street-level card is touched), idempotent,
// best-effort — never throws.
async function closeHoldCardForEndedVisit(visitId, toStatus, conn = db) {
  try {
    const visit = await conn('scheduled_services').where({ id: visitId, source_action: 'voice_agent' }).first('id', 'source_call_log_id');
    if (!visit?.source_call_log_id) return false;
    const card = await findStreetLevelHoldCard(conn, { callLogId: visit.source_call_log_id, visitId });
    if (!card || !['open', 'in_progress'].includes(card.status)) return false;
    const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
    return await conn.transaction(async (trx) => {
      await lockTriageCall(trx, visit.source_call_log_id);
      // Recheck the visit under the lock: a cancellation can be COMPENSATED (the tech
      // went live, so cancellation-processor restores the prior status), and the card
      // must close only while the visit is still in the terminal status that released it.
      const live = await trx('scheduled_services').where({ id: visitId }).forUpdate().first('status', 'customer_confirmed');
      if (!live || String(live.status) !== String(toStatus)) return false;
      const resolved = await trx('triage_items')
        .where({ id: card.id })
        .whereIn('status', ['open', 'in_progress'])
        .update({ status: 'resolved', resolved_at: new Date(), updated_at: new Date(), resolution_note: `Visit ${toStatus} — the address hold no longer applies.` });
      await syncCallReviewStatus(trx, visit.source_call_log_id);
      return resolved > 0;
    });
  } catch (err) {
    logger.warn(`[street-level-hold] closing the hold card for ${visitId} failed: ${err.message}`);
    return false;
  }
}

// A reprocess / recording replacement that reuses a held visit may discover a
// follow-up or correct its date: the confirm hook reads the plan from the visit's
// card, so refresh it there (jsonb merge, same transaction as the caller's). A
// null plan never erases an earlier one. Returns true when a card was updated.
async function refreshHoldFollowUpPlan(conn, { callLogId, visitId, plan }) {
  if (!plan) return false;
  const card = await findStreetLevelHoldCard(conn, { callLogId, visitId });
  if (!card) return false;
  const next = { scheduled_date: plan.scheduledDate || null, window_start: plan.windowStart || null };
  const cur = card.payload?.follow_up_plan;
  if (cur && cur.scheduled_date === next.scheduled_date && cur.window_start === next.window_start) return false;
  await conn('triage_items')
    .where({ id: card.id })
    .update({
      payload: conn.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ follow_up_plan: next })]),
      updated_at: new Date(),
    });
  return true;
}

// True when the confirm hook filed the owed-follow-up card for this visit's
// street-level hold (any status). Only the hook's own card counts (its reason
// marker), so other owed-follow-up cards on the call are untouched.
async function hasOwedFollowUpForStreetLevelVisit(conn, visit) {
  if (!visit?.id || !visit.source_call_log_id) return false;
  const hold = await findStreetLevelHoldCard(conn, { callLogId: visit.source_call_log_id, visitId: visit.id });
  if (!hold) return false;
  const owed = await conn('triage_items')
    .where({ call_log_id: visit.source_call_log_id, reason_code: 'attached_booking_followup_unbooked' })
    .whereRaw("payload->>'skipped_reason' = 'street_level_address_confirmed_follow_up_unbooked'")
    .first('id');
  return !!owed;
}

// The other ordering: a cancellation COMPENSATED after the close (the tech went live,
// so cancellation-processor restores the prior status through the shared transition)
// must bring the hold's review card back. On a terminal -> live transition, reopen the
// latest street-level card for the visit and recompute the call's review_status, under
// the per-call lock, only while the visit is an unconfirmed hold again. Idempotent and
// order-independent with closeHoldCardForEndedVisit (which rechecks the live status).
async function reopenHoldCardForRestoredVisit(visitId, conn = db) {
  try {
    const visit = await conn('scheduled_services').where({ id: visitId, source_action: 'voice_agent' }).first('id', 'source_call_log_id');
    if (!visit?.source_call_log_id) return false;
    const card = await findStreetLevelHoldCard(conn, { callLogId: visit.source_call_log_id, visitId });
    if (!card || ['open', 'in_progress'].includes(card.status)) return false;
    const { lockTriageCall, syncCallReviewStatus } = require('../utils/triage-locks');
    return await conn.transaction(async (trx) => {
      await lockTriageCall(trx, visit.source_call_log_id);
      const live = await trx('scheduled_services').where({ id: visitId }).forUpdate().first('status', 'customer_confirmed');
      if (!live || live.customer_confirmed || ['cancelled', 'skipped', 'rescheduled'].includes(String(live.status))) return false;
      // The partial unique index allows one open card per call and reason.
      const standing = await trx('triage_items')
        .where({ call_log_id: visit.source_call_log_id, reason_code: 'outbound_booking_review' })
        .whereIn('status', ['open', 'in_progress'])
        .first('id');
      if (standing) return false;
      const reopened = await trx('triage_items')
        .where({ id: card.id })
        .whereIn('status', ['resolved', 'dismissed'])
        .update({
          status: 'open', resolved_at: null, resolution_source: null, updated_at: new Date(),
          resolution_note: 'Reopened: the visit was restored, so the address hold applies again.',
        });
      await syncCallReviewStatus(trx, visit.source_call_log_id);
      return reopened > 0;
    });
  } catch (err) {
    logger.warn(`[street-level-hold] reopening the hold card for ${visitId} failed: ${err.code || err.name || 'error'}`);
    return false;
  }
}

module.exports = { reopenHoldCardForRestoredVisit, hasOwedFollowUpForStreetLevelVisit, heldVisitSubquery, isStreetLevelHoldVisit, findStreetLevelHoldCard, closeHoldCardForEndedVisit, refreshHoldFollowUpPlan };
