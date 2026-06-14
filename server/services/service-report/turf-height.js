/**
 * Turf height-of-cut config + logic for the post-service lawn report.
 *
 * Captures one representative mowing height per lawn visit, validated against a
 * grass-type target band and surfaced on the report + customer card.
 *
 * Config lives in CODE, co-located with the lawn agronomy constants
 * (irrigation-advice.js) — the grass vocabulary itself is already a code
 * constant (admin-customer-turf-profile GRASS_TYPES / lawn-grass-context
 * normalizeGrassType), so the bands belong here too, not in a DB table.
 *
 * SEMANTICS (locked): the reading is the maintained HEIGHT-OF-CUT (the height
 * the lawn is kept at), and the band is the ideal maintained height — "height
 * left after mowing", per UF/IFAS. This is NOT the mow-trigger height; the
 * 1/3-rule trigger (≈ band.max × 1.5) is a separate, derived "when to mow"
 * number and is never the range-status comparison basis.
 *
 * Agronomy sign-off: Adam 2026-06.
 */

// Turfchek II rough height-of-cut gauge resolution: 1/4" steps 0.5–2.5",
// 1/2" steps 2.5–5.5". The manual picker is constrained to EXACTLY this set.
const ALLOWED_HEIGHTS_IN = [
  0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5,
];

// Ideal maintained height-of-cut band (inches) by CANONICAL grass_type key
// (the only six values customer_turf_profiles.grass_type can hold). UF/IFAS,
// operator-confirmed. Cultivar-level precision (St. Aug dwarf 2.0–2.5, Palmetto
// 3.0–4.0, zoysia fine, etc.) is a v2 layer keyed on the existing
// customer_turf_profiles.cultivar column — not a grass_type change.
const HEIGHT_BAND_BY_GRASS = {
  st_augustine: { min: 3.5, max: 4.0 },
  bahia: { min: 3.0, max: 4.0 },
  bermuda: { min: 1.0, max: 2.0 },
  zoysia: { min: 1.5, max: 2.0 },
};
// mixed / unknown / missing grass_type → St. Augustine band (SWFL-dominant turf,
// matches the watering default) with a `defaulted` flag so the surface can note
// the assumption.
const DEFAULT_HEIGHT_BAND = HEIGHT_BAND_BY_GRASS.st_augustine;

function normalizeGrassKey(grassType) {
  return String(grassType || '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z_]/g, '');
}

// App + service layer increment guard (the DB CHECK is only a 0.5–8.0 floor/ceiling).
function isAllowedHeight(value) {
  const n = Number(value);
  return Number.isFinite(n) && ALLOWED_HEIGHTS_IN.includes(n);
}

// Resolve the target band for a grass type. `defaulted: true` means the grass
// type was mixed/unknown/unrecognized and the St. Augustine band was used.
function resolveHeightBand(grassType) {
  const band = HEIGHT_BAND_BY_GRASS[normalizeGrassKey(grassType)];
  return band
    ? { min: band.min, max: band.max, defaulted: false }
    : { min: DEFAULT_HEIGHT_BAND.min, max: DEFAULT_HEIGHT_BAND.max, defaulted: true };
}

// 1/3-rule mow trigger (when to mow), derived from the band — education only,
// never the status comparison. Target height is 2/3 of the trigger height, so
// trigger = max × 1.5, rounded to the gauge's 1/4".
function mowTriggerInches(band) {
  const max = Number(band?.max);
  if (!Number.isFinite(max)) return null;
  return Math.round(max * 1.5 * 4) / 4;
}

// Status of a maintained height-of-cut vs its ideal band. `below` is the only
// red/action state (scalping/stress risk). Band edges count as in-range.
function computeRangeStatus(manualHeightIn, band) {
  if (manualHeightIn == null || manualHeightIn === '' || !band) return null;
  const h = Number(manualHeightIn);
  if (!Number.isFinite(h)) return null;
  if (h < band.min) return 'below';
  if (h > band.max) return 'above';
  return 'in_range';
}

module.exports = {
  ALLOWED_HEIGHTS_IN,
  HEIGHT_BAND_BY_GRASS,
  DEFAULT_HEIGHT_BAND,
  normalizeGrassKey,
  isAllowedHeight,
  resolveHeightBand,
  mowTriggerInches,
  computeRangeStatus,
};
