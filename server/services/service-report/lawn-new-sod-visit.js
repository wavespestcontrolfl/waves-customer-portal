'use strict';

/**
 * ONE new-sod verdict for a visit (lawn report rebuild P35, GATE_LAWN_NEW_SOD_MODE).
 *
 * Every surface that acts on new-sod mode (the lawn report, the Lawn Fast Complete
 * context and watering preview, the job card, the separate watering text) asks
 * this function, so they cannot disagree. Two rules live here and nowhere else:
 *
 *   1. VISIT DAY. The visit's own calendar day in America/New_York: the service
 *      record's service_date once the visit has a record, otherwise the
 *      appointment's scheduled_date. Never the assessment's capture date (an
 *      assessment redo, or GATE_LAWN_PROPERTY_HISTORY being off, must not move
 *      the verdict across day 21), never the clock, never the completion time.
 *
 *   2. PROPERTY IDENTITY. property_preferences is the customer's PRIMARY home's
 *      row, so a sod date applies only to a visit PROVEN to be at that home:
 *      the unit-aware chain in visit-property-scope.js (the visit's stamp, else its
 *      property_id, else its source estimate) must POSITIVELY match the customer's
 *      primary address; a visit with no such evidence counts only on an account
 *      proven to have a single premises. "Not demonstrably elsewhere" is never
 *      proof: anything unproven is the normal report.
 *
 * The result never throws. `reason` says why the mode is not active:
 *   'active' | 'no_date' | 'outside_window' | 'other_property' |
 *   'unproven_property' | 'unknown_visit' | 'read_failed'
 * 'read_failed' is a query that threw: report callers render the normal report
 * and treat the render as uncacheable; the watering text fails closed (sends
 * nothing).
 */

const { newSodMode, ymdOrNull } = require('./lawn-new-sod');
const linkage = require('../estimate-property-linkage');
const { resolveVisitPropertyScope, sameResolvedProperty, customerHasOnlyPrimaryPremises } = require('./visit-property-scope');

const inactive = (reason, extra = {}) => ({ active: false, laidOn: null, dayNumber: null, visitDay: null, reason, ...extra });

// The ONE visit-day rule: service record day first, then the appointment's day.
function newSodVisitDay({ serviceDate = null, scheduledDate = null } = {}) {
  return ymdOrNull(serviceDate) || ymdOrNull(scheduledDate) || null;
}

const APPOINTMENT_COLUMNS = [
  'ss.id', 'ss.customer_id', 'ss.scheduled_date', 'ss.property_id', 'ss.source_estimate_id',
  'ss.service_address_line1', 'ss.service_address_line2', 'ss.service_address_city', 'ss.service_address_zip',
];

// The visit's records and the customer's primary address. null = the visit does not exist
// (or belongs to another customer).
async function loadVisit(knex, { customerId, serviceRecordId, scheduledServiceId }) {
  let record = null;
  if (serviceRecordId) {
    record = await knex('service_records as sr')
      .where('sr.id', serviceRecordId)
      .first('sr.service_date', 'sr.scheduled_service_id', 'sr.customer_id');
    if (!record) return null;
    if (record.customer_id != null && String(record.customer_id) !== String(customerId)) return null;
  }
  const appointmentId = (record && record.scheduled_service_id) || scheduledServiceId || null;
  const appointment = appointmentId
    ? await knex('scheduled_services as ss').where('ss.id', appointmentId).first(...APPOINTMENT_COLUMNS)
    : null;
  if (appointment && appointment.customer_id != null && String(appointment.customer_id) !== String(customerId)) return null;
  if (!record && !appointment) return null;
  const customer = await knex('customers as c')
    .where('c.id', customerId)
    .first('c.address_line1', 'c.address_line2', 'c.city', 'c.zip', 'c.has_multi_home');
  if (!customer) return null;
  return { record, appointment, customer };
}

/**
 * Is this visit POSITIVELY at the customer's primary home? The preference row (and so the
 * sod date) belongs to the primary home. "Not demonstrably elsewhere" is not proof: an
 * unstamped appointment can still be linked to a secondary property by property_id or by
 * the estimate that created it, and a bare street compare misses an apartment/unit
 * difference. So this is the same unit-aware chain the other property-scoped readers use
 * (visit-property-scope.js): the visit's own stamp, else its property_id's address, else
 * its source estimate's address, compared with the primary address by sameResolvedProperty.
 * A visit with NO evidence of any of those is the primary only when the account is
 * PROVEN single-premises (customerHasOnlyPrimaryPremises). Anything else is unproven.
 *
 * @returns {Promise<'primary'|'other'|'unproven'|'read_failed'>}
 */
async function proveVisitAtPrimaryHome(knex, { customerId, appointment, customer }) {
  let lookupFailed = false;
  const scope = await resolveVisitPropertyScope(appointment || {}, knex, { onLookupFailure: () => { lookupFailed = true; } });
  if (lookupFailed) return 'read_failed';
  const primaryKey = linkage.normalizedStampedStreet(customer.address_line1, customer.address_line2, customer.city, customer.zip);
  // A primary address with no street or no locality cannot be compared with anything.
  if (!primaryKey || linkage.scopeKeyLacksLocality(primaryKey)) return 'unproven';
  if (scope.hasEvidence) {
    if (!scope.key) return 'unproven';
    return sameResolvedProperty(scope.key, primaryKey) ? 'primary' : 'other';
  }
  const only = await customerHasOnlyPrimaryPremises(knex, customerId, customer, primaryKey, { unresolvedFails: true });
  return only ? 'primary' : 'unproven';
}

/**
 * @param {Function} knex
 * @param {object} args
 * @param {string} args.customerId
 * @param {object|null} [args.prefs]  the customer's property_preferences row, when the caller already
 *   has it (undefined = read it here; null = known to have no row)
 * @param {string} [args.serviceRecordId]  the visit's service record (preferred)
 * @param {string} [args.scheduledServiceId]  the appointment, for a visit with no record yet
 * @returns {Promise<{ active: boolean, laidOn: string|null, dayNumber: number|null, visitDay: string|null, reason: string }>}
 */
async function resolveNewSodVerdict(knex, { customerId, prefs, serviceRecordId = null, scheduledServiceId = null } = {}) {
  try {
    let row = prefs;
    if (row === undefined) {
      if (!customerId) return inactive('unknown_visit');
      row = await knex('property_preferences').where({ customer_id: customerId }).first('sod_laid_on');
    }
    // No date: nothing else matters, and no visit query is spent.
    if (!ymdOrNull(row && row.sod_laid_on)) return inactive('no_date');
    if (!customerId || (!serviceRecordId && !scheduledServiceId)) return inactive('unknown_visit');

    const visit = await loadVisit(knex, { customerId, serviceRecordId, scheduledServiceId });
    if (!visit) return inactive('unknown_visit');
    const visitDay = newSodVisitDay({
      serviceDate: visit.record && visit.record.service_date,
      scheduledDate: visit.appointment && visit.appointment.scheduled_date,
    });
    if (!visitDay) return inactive('unknown_visit');

    const where = await proveVisitAtPrimaryHome(knex, { customerId, ...visit });
    if (where === 'read_failed') return inactive('read_failed');
    if (where === 'other') return inactive('other_property', { visitDay });
    if (where !== 'primary') return inactive('unproven_property', { visitDay });

    const mode = newSodMode(row, visitDay);
    return mode.active
      ? { ...mode, visitDay, reason: 'active' }
      : inactive('outside_window', { visitDay });
  } catch {
    return inactive('read_failed');
  }
}

module.exports = { resolveNewSodVerdict, newSodVisitDay };
