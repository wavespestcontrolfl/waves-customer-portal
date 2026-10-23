/**
 * Reclaimed water, the property fact (GATE_LAWN_RECLAIMED_HALF_N, owner 2026-10-23).
 *
 * customer_properties.reclaimed_water says whether the property's irrigation runs on reclaimed (purple pipe) water, and
 * reclaimed_water_source says who said so:
 *   'office' or 'customer'  a person said so. Always wins; the county job never overwrites it.
 *   'county_meter'          services/reclaimed-water-meters.js matched the property to a Manatee County reclaimed meter.
 *   NULL / NULL             nobody knows (the plan treats it as not reclaimed).
 * A visit pointing at a property a customer merge deactivated is judged by the winning customer's active property at the same address, and a
 * person's answer left on a merged-away copy of that address counts when the active copy has no person answer.
 * The plan engine reads this through isReclaimedService (waveguard-plan-engine.js nitrogenDecision) and halves the N.
 */
const logger = require('./logger');
const { savepointRead } = require('../utils/savepoint-read');

const PERSON_SOURCES = ['office', 'customer'];

// The visit still points at a property a customer merge deactivated (repointCustomerProperties keeps the loser's row as history and the visits
// keep its id). The county job and the office settle ACTIVE rows, so the verdict lives on the winning customer's active property at the same
// address. None (or no address key or customer to match): undefined, and the normal target stands unless a person answered (below).
async function liveCopy(k, row, customerId) {
  if (!row.address_key || !customerId) return undefined;
  return k('customer_properties').where({ customer_id: customerId, active: true, address_key: row.address_key })
    .first('reclaimed_water', 'reclaimed_water_source');
}

// A person's answer (office or customer) on a deactivated copy of the same address of the same customer: a merge deactivates the loser's copy
// without moving its columns, and a person's answer must not be lost to that. Used only when the active copy has no person answer; the newest
// answer wins. A county verdict on a deactivated copy is never used (the county job re-matches the active copy).
async function mergedPersonAnswer(k, addressKey, customerId) {
  if (!addressKey || !customerId) return undefined;
  return k('customer_properties').where({ customer_id: customerId, active: false, address_key: addressKey })
    .whereIn('reclaimed_water_source', PERSON_SOURCES)
    .orderBy('reclaimed_water_checked_at', 'desc', 'last')
    .first('reclaimed_water');
}

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
      const row = await k('customer_properties').where({ id: propertyId })
        .first('reclaimed_water', 'reclaimed_water_source', 'active', 'address_key', 'customer_id');
      if (!row) return false;
      const customerId = row.active === false ? svc.customer_id : row.customer_id;
      const live = row.active === false ? await liveCopy(k, row, customerId) : row;
      if (PERSON_SOURCES.includes(live?.reclaimed_water_source)) return live.reclaimed_water === true;
      const merged = await mergedPersonAnswer(k, row.address_key, customerId);
      if (merged) return merged.reclaimed_water === true;
      return live?.reclaimed_water === true;
    });
  } catch (err) {
    logger.warn(`[lawn-reclaimed-water] property unreadable for ${svc?.id}: ${err?.code || err?.name || 'Error'}`);
    if (strict) throw err;
    return false;
  }
}

module.exports = { propertyIdOf, isReclaimedService };
