/**
 * The customer app's misting system card: what the Home tab shows a customer
 * who has an automatic mosquito misting system. Dark behind GATE_MOSQUITO_MISTING
 * (the route checks the gate; this reader is gate-blind).
 *
 * One read, five fields, no ids and nothing about product, chemistry, price or
 * staff:
 *   - mistTimes / installedOn  from the property's CURRENT calibration (the
 *     newest unvoided misting_calibrations row — the table is append-only);
 *   - lastRefillOn             the newest unvoided misting_refills row for that
 *     same property;
 *   - nextCheckOn              the customer's next misting service-plan visit
 *     (catalog identity mosquito_misting_service, never the service_type
 *     label), under the SAME visit rules GET /api/schedule/next uses;
 *   - nextMistAt               the next mist time after `now`, as an instant.
 *
 * Returns null when there is no current calibration OR no upcoming plan visit:
 * a cancelled plan has no upcoming plan visit, so the card disappears by itself.
 */
const db = require('../models/db');
const { applyPropertyPredicate } = require('./account-properties');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS, UNREVIEWED_VOICE_MOVED_SQL } = require('./call-booking-source-actions');
const { MISTING_SERVICE_CATALOG_KEY } = require('../utils/mosquito-misting-system');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// The first stored mist time strictly after `now`: later today (ET), else the
// first one tomorrow. Instants come from parseETDateTime (the one ET wall-clock
// resolver, DST-correct), never a hand-rolled offset.
function nextMistInstant(mistTimes, now) {
  const times = [...new Set((mistTimes || []).filter((t) => HHMM.test(t)))].sort();
  if (!times.length) return null;
  const today = etDateString(now);
  const later = times.map((t) => parseETDateTime(`${today}T${t}`)).find((at) => at.getTime() > now.getTime());
  if (later) return later;
  const tomorrow = etDateString(addETDays(now, 1));
  return parseETDateTime(`${tomorrow}T${times[0]}`);
}

async function getPortalMistingSystem({ customerId, scope, now = new Date(), knex = db }) {
  // DATE columns are read as text: the pg driver turns a DATE into a Date at
  // the process's local midnight, which is not the calendar day on every host.
  const calibrationQuery = knex('misting_calibrations')
    .where({ 'misting_calibrations.customer_id': customerId })
    .whereNull('misting_calibrations.voided_at');
  applyPropertyPredicate(calibrationQuery, scope, 'misting_calibrations');
  const calibration = await calibrationQuery
    .select('misting_calibrations.property_id', 'misting_calibrations.mist_times', knex.raw('misting_calibrations.installed_on::text as installed_on'))
    .orderBy([{ column: 'misting_calibrations.created_at', order: 'desc' }, { column: 'misting_calibrations.id', order: 'desc' }])
    .first();
  if (!calibration) return null;

  // Same visit rules as GET /api/schedule/next (routes/schedule.js).
  const checkQuery = knex('scheduled_services')
    .where({ 'scheduled_services.customer_id': customerId });
  applyPropertyPredicate(checkQuery, scope);
  const nextCheck = await checkQuery
    .whereIn('scheduled_services.status', ['pending', 'confirmed'])
    // A still-pending, never-confirmed call-created follow-up is dispatch's,
    // not the customer's next visit (NULL-safe De Morgan legs).
    .where((qb) => qb
      .whereNull('scheduled_services.source_action')
      .orWhereNotIn('scheduled_services.source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
      .orWhere((q2) => q2.whereNot('scheduled_services.status', 'pending').whereRaw(`NOT ${UNREVIEWED_VOICE_MOVED_SQL}`))
      .orWhere('scheduled_services.customer_confirmed', true))
    .where('scheduled_services.scheduled_date', '>=', etDateString(now))
    .join('services as catalog_svc', 'scheduled_services.service_id', 'catalog_svc.id')
    .where('catalog_svc.service_key', MISTING_SERVICE_CATALOG_KEY)
    .select(knex.raw('scheduled_services.scheduled_date::text as scheduled_date'))
    .orderBy('scheduled_services.scheduled_date', 'asc')
    .orderBy('scheduled_services.window_start', 'asc')
    .first();
  if (!nextCheck) return null;

  const refill = await knex('misting_refills')
    .where({ customer_id: customerId })
    .whereNull('voided_at')
    .whereRaw('property_id IS NOT DISTINCT FROM ?', [calibration.property_id ?? null])
    .select(knex.raw('refilled_on::text as refilled_on'))
    .orderBy([{ column: 'refilled_on', order: 'desc' }, { column: 'created_at', order: 'desc' }])
    .first();

  const mistTimes = Array.isArray(calibration.mist_times) ? calibration.mist_times : [];
  const nextMist = nextMistInstant(mistTimes, now);
  return {
    installedOn: dateOnlyString(calibration.installed_on),
    lastRefillOn: refill ? dateOnlyString(refill.refilled_on) : null,
    nextCheckOn: dateOnlyString(nextCheck.scheduled_date),
    nextMistAt: nextMist ? nextMist.toISOString() : null,
    mistTimes,
  };
}

module.exports = { getPortalMistingSystem, nextMistInstant };
