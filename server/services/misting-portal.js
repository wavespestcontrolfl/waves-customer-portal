/**
 * The customer app's misting system card: what the Home tab shows a customer
 * who has an automatic mosquito misting system. Dark behind GATE_MOSQUITO_MISTING
 * (the route checks the gate; this reader is gate-blind).
 *
 * One read, five fields, no ids and nothing about product, chemistry, price or
 * staff:
 *   - mistTimes / installedOn  from the property's CURRENT calibration (the
 *     newest unvoided misting_calibrations row for that exact property — the
 *     table is append-only; a NULL-property row is history, never current);
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
const { currentCalibration, currentCalibrationForCustomer, sameInstallPremise } = require('./misting-records');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS, UNREVIEWED_VOICE_MOVED_SQL } = require('./call-booking-source-actions');
const { MISTING_SERVICE_CATALOG_KEY } = require('../utils/mosquito-misting-system');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// The earliest RESOLVED mist instant strictly after `now`: later today (ET), else the earliest one tomorrow.
// Instants come from parseETDateTime (the one ET wall-clock resolver, DST-correct), never a hand-rolled
// offset. The earliest instant wins, not the first wall-clock string: on the spring-forward day a time in
// the missing hour (02:30) resolves to 03:30, after a 03:00 mist that sorts later as text.
function nextMistInstant(mistTimes, now) {
  const times = [...new Set((mistTimes || []).filter((t) => HHMM.test(t)))];
  if (!times.length) return null;
  const earliest = (date, after) => times
    .map((t) => parseETDateTime(`${date}T${t}`))
    .filter((at) => after === null || at.getTime() > after)
    .reduce((best, at) => (best === null || at.getTime() < best.getTime() ? at : best), null);
  return earliest(etDateString(now), now.getTime()) || earliest(etDateString(addETDays(now, 1)), null);
}

async function getPortalMistingSystem({ customerId, scope, now = new Date(), knex = db }) {
  // "Current" is picked exactly the way the staff service picks it (misting-records.currentCalibration and
  // currentCalibrationForCustomer): an exact property match, newest unvoided row first. A calibration with
  // a NULL property (its property row was deleted) or at a retired property is history and is never
  // current, under any scope. Visits keep their own rule below.
  let current;
  if (scope && scope.enabled && scope.scoped) {
    if (scope.closed || !scope.property) return null;
    current = await currentCalibration(knex, customerId, scope.property.id);
  } else {
    current = await currentCalibrationForCustomer(knex, customerId);
  }
  if (!current) return null;
  // DATE columns are read as text: the pg driver turns a DATE into a Date at the process's local
  // midnight, which is not the calendar day on every host.
  const calibration = await knex('misting_calibrations')
    .where({ id: current.id })
    .select('property_id', 'mist_times', knex.raw('installed_on::text as installed_on'))
    .first();

  // The next check belongs to THIS system's property, whatever the session scope: visits stamped with
  // that property, plus unstamped visits when it is the primary (the visit rule applyPropertyPredicate
  // applies for a selected house). With app property scope off, a multi-home customer's session is
  // unscoped, and a visit at another house must not stand in for this system's next check.
  const property = await knex('customer_properties')
    .where({ id: calibration.property_id, customer_id: customerId, active: true })
    .first('id', 'is_primary');
  if (!property) return null;
  // Otherwise the same visit rules as GET /api/schedule/next (routes/schedule.js).
  const checkQuery = knex('scheduled_services')
    .where({ 'scheduled_services.customer_id': customerId });
  applyPropertyPredicate(checkQuery, { enabled: true, scoped: true, closed: false, property });
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

  // The last refill of THIS system: a refill at this property whose calibration was installed at the same
  // premise. A move reuses the property row, so the old house's refills never show on the new system; a
  // recalibration at the same address keeps its refill history.
  const refills = await knex('misting_refills as r')
    .join('misting_calibrations as rc', 'rc.id', 'r.calibration_id')
    .where({ 'r.customer_id': customerId, 'r.property_id': current.property_id })
    .whereNull('r.voided_at')
    .select(
      knex.raw('r.refilled_on::text as refilled_on'),
      'rc.installed_address_line1', 'rc.installed_address_line2', 'rc.installed_city', 'rc.installed_zip',
    )
    .orderBy([{ column: 'r.refilled_on', order: 'desc' }, { column: 'r.created_at', order: 'desc' }]);
  const refill = refills.find((row) => sameInstallPremise(row, current));

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
