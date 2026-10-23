/**
 * Reclaimed water, the property fact (GATE_LAWN_RECLAIMED_HALF_N, owner 2026-10-23).
 *
 * customer_properties.reclaimed_water says whether the property's irrigation runs on reclaimed (purple pipe) water, and
 * reclaimed_water_source says who said so:
 *   'office' or 'customer'  a person said so. Always wins; the county job never overwrites it.
 *   'county_meter'          services/reclaimed-water-meters.js matched the property to a Manatee County reclaimed meter.
 *   NULL / NULL             nobody knows (the plan treats it as not reclaimed).
 * The plan engine reads this through isReclaimedService (waveguard-plan-engine.js nitrogenDecision) and halves the N.
 */
const defaultDb = require('../models/db');
const logger = require('./logger');
const { savepointRead } = require('../utils/savepoint-read');

const PERSON_SOURCES = ['office', 'customer'];

// The property a visit is for: the visit's own link, else the resolver the whole lawn program uses (null = unresolvable).
async function propertyIdOf(knex, svc) {
  if (!svc) return null;
  if (svc.property_id) return svc.property_id;
  if (!svc.customer_id) return null;
  return require('./property-service-areas').resolveVisitPropertyId(svc, knex);
}

/**
 * Is the visit's property marked reclaimed? One read inside a savepoint (a failing query cannot abort a caller's
 * transaction). A failed read is "no, the normal target stands", logged by code only, UNLESS `strict` (a reader that stores
 * its answer): then it throws, so nothing stores the normal target as if it were the answer.
 */
async function isReclaimedService(knex, svc, { strict = false } = {}) {
  try {
    return await savepointRead(knex, async (k) => {
      const propertyId = await propertyIdOf(k, svc);
      if (!propertyId) return false;
      const row = await k('customer_properties').where({ id: propertyId }).first('reclaimed_water');
      return row?.reclaimed_water === true;
    });
  } catch (err) {
    logger.warn(`[lawn-reclaimed-water] property unreadable for ${svc?.id}: ${err?.code || err?.name || 'Error'}`);
    if (strict) throw err;
    return false;
  }
}

/**
 * Set a person's answer on one property: true or false is saved with its source and the time; null hands the property back
 * to the county match (both columns cleared, so the next daily tick settles it). Returns false when the customer has no such
 * active property.
 */
async function setPropertyReclaimed(customerId, propertyId, value, { source = 'office', knex = defaultDb, now = new Date() } = {}) {
  if (value !== null && typeof value !== 'boolean') throw Object.assign(new Error('reclaimed must be true, false or null'), { status: 400 });
  if (value !== null && !PERSON_SOURCES.includes(source)) throw Object.assign(new Error('source must be office or customer'), { status: 400 });
  const patch = value === null
    ? { reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null }
    : { reclaimed_water: value, reclaimed_water_source: source, reclaimed_water_checked_at: now };
  const updated = await knex('customer_properties').where({ id: propertyId, customer_id: customerId, active: true }).update(patch);
  return updated === 1;
}

module.exports = { PERSON_SOURCES, propertyIdOf, isReclaimedService, setPropertyReclaimed };
