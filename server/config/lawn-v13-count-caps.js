/**
 * Product-level yearly COUNT caps that are stricter under the v13 lawn program (GATE_LAWN_V13) than
 * the stored product_limits row, keyed by the normalized catalog name.
 *
 * Celsius WG: the persisted row is the legacy 3 (compliance seed 20260401000020), so every gate-off
 * reader (pre-visit brief, compliance pages) behaves as it did before v13. Under v13 the owner's
 * limit is 2 applications per lawn per year (2026-10-06): the override lowers the stored value
 * wherever the gate is on and never raises it. Arena, Certainty and Blindside have no legacy value:
 * their stored rows (2) are the cap and need no override.
 */
const V13_COUNT_CAP_OVERRIDES = Object.freeze({ 'celsius wg': 2 });

const normalize = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The cap in force for a product: the stored value, lowered by the v13 override while the gate is on.
function effectiveCountCap(productName, storedValue, v13Live = require('./feature-gates').lawnV13Live?.() === true) {
  const stored = storedValue == null ? null : Number(storedValue);
  const override = V13_COUNT_CAP_OVERRIDES[normalize(productName)];
  if (!v13Live || override == null || stored == null || !Number.isFinite(stored)) return storedValue;
  return Math.min(stored, override);
}

// The product's limit rows with the v13 override applied to its product-level annual_max_apps rows.
function withV13CountCaps(productName, limits, v13Live) {
  return (limits || []).map((limit) => (limit.limit_type === 'annual_max_apps' && (limit.match_type || 'product') === 'product'
    ? { ...limit, limit_value: effectiveCountCap(productName, limit.limit_value, v13Live) }
    : limit));
}

module.exports = { V13_COUNT_CAP_OVERRIDES, effectiveCountCap, withV13CountCaps };
