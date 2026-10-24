/**
 * The yard the tip picker matches against (tips with facts,
 * GATE_TECH_TIP_SOURCES, owner 2026-10-24): the grass and whether it can be
 * trusted, whether there is an irrigation system, and the county and city of
 * the visit's address.
 *
 * Every read is soft. A failed or missing read leaves that fact null, and
 * tip-library's yardMatches hides only the tips that need it: a grass tip
 * needs a trusted grass, a county or city tip needs a known county or city,
 * and an irrigation tip hides only where the yard is known to have no system.
 */

const { loadCustomerGrassContext, irrigationTypeHasSystem } = require('../lawn-grass-context');
const { resolveAddressCounty } = require('../../config/address-county');

// Grass a tip may name: one of the four grasses with a lawn track, set by
// staff or the estimate (or before the source column existed). A photo read
// can be wrong, and a customer record or a mixed/unknown lawn says too little.
const TRUSTED_GRASS = new Set(['st_augustine', 'bermuda', 'zoysia', 'bahia']);
const UNTRUSTED_GRASS_SOURCES = new Set(['photo_ai', 'customer_record']);

async function loadTechTipYard(knex, { customerId = null, zip = null, city = null } = {}) {
  const grass = await loadCustomerGrassContext(customerId, knex).catch(() => null);
  const grassType = grass?.grassType || null;
  const cityKey = String(city || '').trim().toLowerCase() || null;
  return {
    grass: grassType,
    grassTrusted: Boolean(grassType && TRUSTED_GRASS.has(grassType) && !UNTRUSTED_GRASS_SOURCES.has(grass?.grassTypeSource)),
    grassLabel: grass?.grassTypeLabel || null,
    irrigationSystem: irrigationTypeHasSystem(grass?.irrigationSystem),
    county: resolveAddressCounty({ zip, city }) || null,
    city: cityKey,
  };
}

module.exports = { loadTechTipYard };
