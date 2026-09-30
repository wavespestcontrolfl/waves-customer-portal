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

// True while the visit is an unconfirmed street-level hold. Fails CLOSED (true)
// on a lookup error: a reminder must never go out on a blip.
async function isStreetLevelHoldVisit(scheduledServiceId, conn = db) {
  if (!scheduledServiceId) return false;
  try {
    const row = await conn('scheduled_services as ss')
      .where('ss.id', scheduledServiceId)
      .whereExists(function () { heldVisitSubquery(this, 'ss'); })
      .first('ss.id');
    return !!row;
  } catch (err) {
    logger.warn(`[street-level-hold] hold lookup failed for ${scheduledServiceId}: ${err.message}`);
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

module.exports = { heldVisitSubquery, isStreetLevelHoldVisit, findStreetLevelHoldCard, closeHoldCardForEndedVisit };
