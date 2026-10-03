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
 *      row, so a sod date applies only to a visit at that home. A visit whose
 *      stamped service address diverges from the primary address (the shared
 *      stampedDivergesSql rule the job card and the PDF loader use) is another
 *      property: normal report. A visit that cannot be found, or whose address
 *      cannot be judged (no linked appointment), is UNKNOWN, and unknown is
 *      never active.
 *
 * The result never throws. `reason` says why the mode is not active:
 *   'active' | 'no_date' | 'outside_window' | 'divergent_address' |
 *   'unknown_visit' | 'read_failed'
 * 'read_failed' is a query that threw: report callers render the normal report
 * and treat the render as uncacheable; the watering text fails closed (sends
 * nothing).
 */

const { newSodMode, ymdOrNull } = require('./lawn-new-sod');
const { stampedDivergesSql } = require('../stamped-address');

const inactive = (reason, extra = {}) => ({ active: false, laidOn: null, dayNumber: null, visitDay: null, reason, ...extra });

// The ONE visit-day rule: service record day first, then the appointment's day.
function newSodVisitDay({ serviceDate = null, scheduledDate = null } = {}) {
  return ymdOrNull(serviceDate) || ymdOrNull(scheduledDate) || null;
}

async function loadVisitIdentity(knex, { serviceRecordId, scheduledServiceId }) {
  if (serviceRecordId) {
    const row = await knex('service_records as sr')
      .leftJoin('customers as c', 'sr.customer_id', 'c.id')
      .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
      .where('sr.id', serviceRecordId)
      .first(
        'sr.service_date',
        'ss.scheduled_date',
        'ss.id as ss_id',
        knex.raw(`${stampedDivergesSql('ss', 'c')} as address_diverges`),
      );
    return row ? { serviceDate: row.service_date, scheduledDate: row.scheduled_date, linked: row.ss_id != null, diverges: row.address_diverges } : null;
  }
  const row = await knex('scheduled_services as ss')
    .join('customers as c', 'ss.customer_id', 'c.id')
    .where('ss.id', scheduledServiceId)
    .first('ss.scheduled_date', knex.raw(`${stampedDivergesSql('ss', 'c')} as address_diverges`));
  return row ? { serviceDate: null, scheduledDate: row.scheduled_date, linked: true, diverges: row.address_diverges } : null;
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
    // No date: nothing else matters, and no identity query is spent.
    if (!ymdOrNull(row && row.sod_laid_on)) return inactive('no_date');
    if (!serviceRecordId && !scheduledServiceId) return inactive('unknown_visit');

    const identity = await loadVisitIdentity(knex, { serviceRecordId, scheduledServiceId });
    if (!identity || !identity.linked) return inactive('unknown_visit');
    // Only a strict `false` proves the visit is at the primary home.
    if (identity.diverges === true) return inactive('divergent_address');
    if (identity.diverges !== false) return inactive('unknown_visit');

    const visitDay = newSodVisitDay(identity);
    if (!visitDay) return inactive('unknown_visit');
    const mode = newSodMode(row, visitDay);
    return mode.active
      ? { ...mode, visitDay, reason: 'active' }
      : inactive('outside_window', { visitDay });
  } catch {
    return inactive('read_failed');
  }
}

module.exports = { resolveNewSodVerdict, newSodVisitDay };
