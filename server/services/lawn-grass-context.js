/**
 * Canonical lawn grass-context loader.
 *
 * A customer's grass type and protocol track live on
 * `customer_turf_profiles` (grass_type enum + track_key + sun_exposure +
 * irrigation_type + lawn_sqft). Several services historically read
 * `customers.grass_type` / `customers.grass_track` — columns that do not
 * exist — so they silently defaulted every lawn to St. Augustine / Track
 * "A". This helper reads the real source so all consumers agree.
 *
 * `track_key` is the WaveGuard v4 protocol track id (e.g. 'st_augustine').
 * Sun exposure is treated as a treatment modifier, not a separate track,
 * so we do NOT synthesize legacy A/B/C1/C2/D codes here.
 */
const db = require('./../models/db');

const GRASS_TYPE_LABELS = {
  st_augustine: 'St. Augustine',
  bermuda: 'Bermuda',
  zoysia: 'Zoysia',
  bahia: 'Bahia',
  mixed: 'Mixed',
  unknown: 'Unknown',
};

function grassTypeLabel(grassType) {
  if (!grassType) return null;
  return GRASS_TYPE_LABELS[grassType] || grassType;
}

// Legacy `customers.lawn_type` is free text (e.g. "St. Augustine Full Sun",
// "Floratam") rather than a canonical key. Normalize it to a GRASS_TYPE_LABELS
// key so it matches protocol/knowledge lookups and segments consistently;
// return null when no grass family is recognizable.
function normalizeGrassType(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(GRASS_TYPE_LABELS, key)) return key;
  if (/augustine|floratam|palmetto|seville|bitter\s*blue|citra\s*blue|provista|captiva/.test(key)) return 'st_augustine';
  if (/bermuda|celebration|tifway|tifgrand|latitude\s*36/.test(key)) return 'bermuda';
  if (/zoysia|empire|zeon|geo|jamur|palisades/.test(key)) return 'zoysia';
  if (/bahia|argentine|pensacola/.test(key)) return 'bahia';
  if (/\bmix(ed)?\b/.test(key)) return 'mixed';
  return null;
}

// The turf-profile irrigation_type is a 4-value enum; some sinks (e.g.
// treatment_outcomes.irrigation_system) are a boolean "has an automatic
// irrigation system". Map the unambiguous cases; null for ambiguous/missing.
const IRRIGATION_HAS_SYSTEM = {
  in_ground: true,
  mixed: true,
  manual: false,
  none: false,
};

function irrigationTypeHasSystem(irrigationType) {
  return IRRIGATION_HAS_SYSTEM[irrigationType] ?? null;
}

function emptyContext() {
  return {
    grassType: null,
    grassTypeLabel: null,
    trackKey: null,
    sunExposure: null,
    irrigationSystem: null,
    propertySqft: null,
  };
}

/**
 * Load a customer's grass context from the canonical source.
 * Falls back to `customers.lawn_type` / `customers.property_sqft` when no
 * active turf profile exists. Never throws — returns an all-null context
 * on any DB error so callers can degrade gracefully.
 */
async function loadCustomerGrassContext(customerId, knex = db) {
  if (!customerId) return emptyContext();

  const [profile, customer] = await Promise.all([
    knex('customer_turf_profiles')
      .where({ customer_id: customerId, active: true })
      .first()
      .catch(() => null),
    knex('customers').where({ id: customerId }).first().catch(() => null),
  ]);

  const grassType = profile?.grass_type || normalizeGrassType(customer?.lawn_type) || null;

  return {
    grassType,
    grassTypeLabel: grassTypeLabel(grassType),
    trackKey: profile?.track_key || null,
    sunExposure: profile?.sun_exposure || null,
    irrigationSystem: profile?.irrigation_type || null,
    propertySqft: profile?.lawn_sqft || customer?.property_sqft || null,
  };
}

module.exports = {
  GRASS_TYPE_LABELS,
  grassTypeLabel,
  normalizeGrassType,
  irrigationTypeHasSystem,
  loadCustomerGrassContext,
};
