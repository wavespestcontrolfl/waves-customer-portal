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
const { lawnProtocols, isBahiaGrass, bahiaHasNoProgram, lawnV13NoBahiaProgram } = require('./lawn-program');

const GRASS_TYPE_LABELS = {
  st_augustine: 'St. Augustine',
  bermuda: 'Bermuda',
  zoysia: 'Zoysia',
  bahia: 'Bahia',
  mixed: 'Mixed',
  unknown: 'Unknown',
};

// Who set customer_turf_profiles.grass_type (grass_type_source, migration
// 20261007100000). NULL = set before the column existed. Only a STAFF value
// (the turf-profile editor) is never replaced by a later photo AI read.
const GRASS_SOURCE = Object.freeze({ STAFF: 'staff', ESTIMATE: 'estimate', PHOTO_AI: 'photo_ai' });
// The four grasses with a lawn track, and the vague values a photo AI read
// that names one of them may replace.
const KNOWN_TRACK_GRASS = new Set(['st_augustine', 'bermuda', 'zoysia', 'bahia']);
const AI_REPLACEABLE_GRASS = new Set(['mixed', 'unknown']);

// Whether a photo AI read writes its grass to the turf profile. A blank grass
// fills either way. A Mixed or Unknown grass is replaced by a read that names
// one known grass (owner 2026-10-06), only from photos of the current home
// (`fresh`) and never over a grass staff set in the turf-profile editor.
function photoAiWritesGrass({ prior, read, fresh }) {
  if (!read) return false;
  if (!prior?.grass_type) return true;
  return !!fresh
    && AI_REPLACEABLE_GRASS.has(prior.grass_type)
    && KNOWN_TRACK_GRASS.has(read)
    && prior.grass_type_source !== GRASS_SOURCE.STAFF;
}

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
  if (isBahiaGrass(key)) return 'bahia';
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

// Resolve the protocol track id, mirroring waveguard-plan-engine.js: an
// explicit track_key wins when it names a real protocols.lawn track;
// otherwise the canonical grass type doubles as the track id
// (st_augustine / bermuda / zoysia / bahia). 'mixed'/'unknown' — and any
// value not present in protocols.lawn — have no track.
function resolveTrackKey(trackKey, grassType) {
  // GATE_LAWN_V13 has no bahia program: any recorded field naming bahia (the grass type, or the track
  // key, whichever other track the other field names) leaves the lawn with no track, the same rule
  // the plan engine applies (recordedGrassFacts), so no consumer serves another grass's program.
  if (bahiaHasNoProgram(grassType) || bahiaHasNoProgram(trackKey)) return null;
  const lawn = lawnProtocols();
  if (trackKey && lawn && lawn[trackKey]) return trackKey;
  if (grassType && lawn && lawn[grassType]) return grassType;
  return null;
}

// Whether a lawn record names bahia: the profile's grass type, its track key, or (only when no profile
// grass or track is recorded) the legacy lawn text. The ONE rule the plan engine, the pre-visit brief
// and every other planning reader share, so a conflicting record reads the same everywhere.
function recordedGrassNamesBahia(profile, legacyGrass) {
  const profileRecorded = [profile?.track_key, profile?.grass_type].some((value) => String(value || '').trim());
  return [profile?.grass_type, profile?.track_key, profileRecorded ? null : legacyGrass].some(isBahiaGrass);
}

function emptyContext() {
  return {
    noProgram: false,
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
 * active turf profile exists. By default never throws — returns an
 * all-null context on any DB error so callers can degrade gracefully.
 * strict: propagate DB errors instead — callers that persist state keyed
 * on this context (pre-visit brief grounding hash) must not read a
 * transient outage as "unknown track".
 */
async function loadCustomerGrassContext(customerId, knex = db, { strict = false } = {}) {
  if (!customerId) return emptyContext();

  const soft = (promise) => (strict ? promise : promise.catch(() => null));
  const [profile, customer] = await Promise.all([
    soft(knex('customer_turf_profiles')
      .where({ customer_id: customerId, active: true })
      .first()),
    soft(knex('customers').where({ id: customerId }).first()),
  ]);

  const grassType = profile?.grass_type || normalizeGrassType(customer?.lawn_type) || null;

  return {
    // GATE_LAWN_V13 has no bahia program: planning readers show no window guidance for this lawn,
    // even when the visit is assigned a protocol (historical readers do not read this).
    noProgram: lawnV13NoBahiaProgram() && recordedGrassNamesBahia(profile, customer?.lawn_type),
    grassType,
    grassTypeLabel: grassTypeLabel(grassType),
    trackKey: resolveTrackKey(profile?.track_key, grassType),
    sunExposure: profile?.sun_exposure || null,
    irrigationSystem: profile?.irrigation_type || null,
    propertySqft: profile?.lawn_sqft || customer?.property_sqft || null,
  };
}

module.exports = {
  GRASS_TYPE_LABELS,
  GRASS_SOURCE,
  KNOWN_TRACK_GRASS,
  AI_REPLACEABLE_GRASS,
  photoAiWritesGrass,
  grassTypeLabel,
  normalizeGrassType,
  irrigationTypeHasSystem,
  resolveTrackKey,
  recordedGrassNamesBahia,
  loadCustomerGrassContext,
};
