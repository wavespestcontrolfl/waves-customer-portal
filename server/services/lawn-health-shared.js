'use strict';

/**
 * Shared lawn-health scoring math + program-eligibility predicate, extracted
 * VERBATIM from server/routes/lawn-health.js so the Property Score service
 * can consult the same rules the customer Lawn Health surface uses. The
 * route imports these back from here; there is exactly one copy.
 */

const db = require('../models/db');

// Consolidated Stress/Damage for customer surfaces. New rows store it directly;
// older rows fall back to the worst of the two legacy signals (fungus + thatch).
function lawnStressDamage(row = {}) {
  if (row.stress_damage != null) return row.stress_damage;
  return Math.min(row.fungus_control ?? 100, row.thatch_level ?? 100);
}

// Overall uses the stored score when present, else the four-category weighting
// (Density 0.30 / Weed 0.25 / Color 0.25 / Stress 0.20) so legacy rows without
// a stored overall_score match the four displayed bars and the service report.
function lawnOverall(row = {}) {
  // Trust a stored overall only when it was computed under the four-category
  // model (rows with stress_damage). Legacy rows keep an old five-signal
  // overall, so recompute them to match the four displayed bars.
  if (row.overall_score != null && row.stress_damage != null) return row.overall_score;
  return Math.round(
    (row.turf_density || 0) * 0.30 +
    (row.weed_suppression || 0) * 0.25 +
    (row.color_health || 0) * 0.25 +
    lawnStressDamage(row) * 0.20
  );
}

function applyLawnServiceFilter(query, alias = 'ss') {
  return query.where(function () {
    this.whereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%lawn%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%waveguard%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%fertiliz%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%fungicide%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%turf%']);
  });
}

async function hasCustomerLawnCare(customerId, knex = db) {
  const profile = await knex('customer_turf_profiles')
    .where({ customer_id: customerId, active: true })
    .first('id')
    .catch(() => null);
  if (profile) return true;

  const customer = await knex('customers')
    .where({ id: customerId })
    .first('id', 'waveguard_tier', 'lawn_type')
    .catch(() => null);
  if (customer?.waveguard_tier || customer?.lawn_type) return true;

  const scheduled = await applyLawnServiceFilter(
    knex('scheduled_services as ss').where('ss.customer_id', customerId),
    'ss'
  ).first('ss.id').catch(() => null);
  return Boolean(scheduled);
}

module.exports = {
  lawnStressDamage,
  lawnOverall,
  applyLawnServiceFilter,
  hasCustomerLawnCare,
};
