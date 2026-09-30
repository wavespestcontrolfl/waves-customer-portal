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

module.exports = { heldVisitSubquery, isStreetLevelHoldVisit };
