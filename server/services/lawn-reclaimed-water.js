/**
 * Reclaimed water, the property fact (GATE_LAWN_RECLAIMED_HALF_N, owner 2026-10-23).
 *
 * customer_properties.reclaimed_water says whether the property's irrigation runs on reclaimed (purple pipe) water, and
 * reclaimed_water_source says who said so:
 *   'office' or 'customer'  a person said so. Always wins; the county job never overwrites it.
 *   'county_meter'          services/reclaimed-water-meters.js matched the property to a Manatee County reclaimed meter.
 *   NULL / NULL             nobody knows (the plan treats it as not reclaimed).
 * A visit pointing at a property a customer merge deactivated is judged by the winning customer's active property at the same address.
 * The plan engine reads this through isReclaimedService (waveguard-plan-engine.js nitrogenDecision) and halves the N.
 */
const logger = require('./logger');
const { savepointRead } = require('../utils/savepoint-read');

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
      const row = await k('customer_properties').where({ id: propertyId }).first('reclaimed_water', 'active', 'address_key');
      if (row?.active !== false) return row?.reclaimed_water === true;
      // The visit still points at a property a customer merge deactivated (repointCustomerProperties keeps the loser's row as history and the
      // visits keep its id). The county job and the office only ever settle ACTIVE rows, so the verdict lives on the winning customer's active
      // property at the same address. None (or no address key to match): fail closed, the normal target stands.
      if (!row.address_key || !svc.customer_id) return false;
      const live = await k('customer_properties').where({ customer_id: svc.customer_id, active: true, address_key: row.address_key }).first('reclaimed_water');
      return live?.reclaimed_water === true;
    });
  } catch (err) {
    logger.warn(`[lawn-reclaimed-water] property unreadable for ${svc?.id}: ${err?.code || err?.name || 'Error'}`);
    if (strict) throw err;
    return false;
  }
}

module.exports = { propertyIdOf, isReclaimedService };
