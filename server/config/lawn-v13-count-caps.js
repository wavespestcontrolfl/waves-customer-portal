/**
 * The yearly COUNT caps of the v13 lawn program (GATE_LAWN_V13; owner 2026-10-06), kept entirely
 * behind the gate: no product_limits row carries them, so with the gate off every reader behaves as
 * it did before v13.
 *
 *   Celsius WG                2   stored row is the legacy 3 (compliance seed 20260401000020); the
 *                                 override LOWERS it while the gate is on.
 *   Arena 50 WDG              2   new cap, no legacy value: the override ADDS a synthetic hard_block
 *                                 annual_max_apps limit while the gate is on (label 0.4 lb
 *                                 clothianidin per acre per year = one pass; "never treat the same
 *                                 area twice" is the tech's rule, not enforced by the app).
 *   Certainty Turf Herbicide  2   new cap: synthetic limit.
 *   Blindside Herbicide       2   new cap: synthetic limit.
 *
 * A stored product-level annual_max_apps row (an admin's, or the legacy Celsius 3) is only ever
 * lowered to the override, never raised, and never replaced by a synthetic row.
 */
const LABEL = 'owner 2026-10-06';

const V13_COUNT_CAPS = Object.freeze([
  { name: 'Celsius WG', cap: 2, description: `Celsius WG: max 2 applications per lawn per year under the v13 lawn program (${LABEL}).` },
  { name: 'Arena 50 WDG', cap: 2, description: `Arena 50 WDG: max 2 applications per lawn per year under the v13 lawn program (${LABEL}; label 0.4 lb clothianidin per acre per year). Never treat the same area twice (tech rule, not enforced by the app).` },
  { name: 'Certainty Turf Herbicide', cap: 2, description: `Certainty Turf Herbicide: max 2 applications per lawn per year under the v13 lawn program (${LABEL}).` },
  { name: 'Blindside Herbicide', cap: 2, description: `Blindside Herbicide: max 2 applications per lawn per year under the v13 lawn program (${LABEL}).` },
]);

const normalize = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const BY_NAME = new Map(V13_COUNT_CAPS.map((entry) => [normalize(entry.name), entry]));
// Back-compat shape: normalized name -> cap.
const V13_COUNT_CAP_OVERRIDES = Object.freeze(Object.fromEntries(V13_COUNT_CAPS.map((entry) => [normalize(entry.name), entry.cap])));

const gateLive = () => require('./feature-gates').lawnV13Live?.() === true;
const v13CountCapFor = (productName) => BY_NAME.get(normalize(productName)) || null;

// The cap in force for a product with a STORED value: lowered by the override while the gate is on.
function effectiveCountCap(productName, storedValue, v13Live = gateLive()) {
  const stored = storedValue == null ? null : Number(storedValue);
  const entry = v13CountCapFor(productName);
  if (!v13Live || !entry || stored == null || !Number.isFinite(stored)) return storedValue;
  return Math.min(stored, entry.cap);
}

const isProductCount = (limit) => limit.limit_type === 'annual_max_apps' && (limit.match_type || 'product') === 'product';

// The product's limit rows with the v13 caps applied while the gate is on: a stored product-level
// annual_max_apps row is lowered; with none stored, a synthetic hard_block row is ADDED.
function withV13CountCaps(productName, limits, v13Live = gateLive(), productId = null) {
  const rows = limits || [];
  const entry = v13CountCapFor(productName);
  if (!v13Live || !entry) return rows;
  const hasStored = rows.some(isProductCount);
  const lowered = rows.map((limit) => (isProductCount(limit) ? { ...limit, limit_value: effectiveCountCap(productName, limit.limit_value, true) } : limit));
  if (hasStored) return lowered;
  return [...lowered, syntheticCountLimit(entry, productId)];
}

function syntheticCountLimit(entry, productId = null) {
  return {
    id: null,
    product_id: productId,
    match_type: 'product',
    match_value: null,
    limit_type: 'annual_max_apps',
    limit_value: entry.cap,
    limit_unit: 'applications',
    severity: 'hard_block',
    description: entry.description,
    synthetic: true,
  };
}

module.exports = {
  V13_COUNT_CAPS, V13_COUNT_CAP_OVERRIDES, v13CountCapFor, effectiveCountCap, withV13CountCaps, syntheticCountLimit,
};
