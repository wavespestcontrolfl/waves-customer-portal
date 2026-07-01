// Commercial RISK multipliers (owner-locked risk-type lane, decision 5).
//
// Rep-set dropdowns — NOT satellite-derived. Satellite is weak on ornamental
// density, palm pressure, lakefront/preserve exposure, shade, and complaint
// history, so a technician/estimator picks the level. Each level scales the
// commercial Tree & Shrub or Mosquito cost buildup (so the target margin is
// preserved), and the TOP tier escapes to a MANUAL quote — the site is too
// variable to auto-bill.
//
// Empty / unset / unrecognized → Normal (1.0). The PUBLIC default is Normal for
// both — do NOT default higher (e.g. 1.25 mosquito), which would silently inflate
// every public quote. Only the explicit top tier forces a manual quote.

// T&S plant density. very_high (resort entrances / palm-heavy / whitefly ficus /
// disease-prone) → manual.
const TREE_SHRUB_DENSITY = {
  low: { multiplier: 0.75 }, // sparse
  normal: { multiplier: 1.0 },
  high: { multiplier: 1.5 }, // dense
  very_high: { manual: true },
};

// Mosquito pressure. severe (chronic complaint / preserve / mangrove / drainage)
// → manual.
const MOSQUITO_PRESSURE = {
  low: { multiplier: 0.85 },
  normal: { multiplier: 1.0 },
  high: { multiplier: 1.35 },
  severe: { manual: true },
};

const TREE_SHRUB_DENSITY_OPTIONS = [
  { value: '', label: 'Normal (default)' },
  { value: 'low', label: 'Low / sparse (0.75×)' },
  { value: 'normal', label: 'Normal (1.0×)' },
  { value: 'high', label: 'High / dense (1.5×)' },
  { value: 'very_high', label: 'Very high — manual quote' },
];
const MOSQUITO_PRESSURE_OPTIONS = [
  { value: '', label: 'Normal (default)' },
  { value: 'low', label: 'Low (0.85×)' },
  { value: 'normal', label: 'Normal (1.0×)' },
  { value: 'high', label: 'High (1.35×)' },
  { value: 'severe', label: 'Severe — manual quote' },
];

// Returns { multiplier, forceManual }. Empty/unrecognized → { 1, false }.
function resolveMultiplier(map, value) {
  const key = String(value || '').trim().toLowerCase();
  const entry = map[key];
  if (!entry) return { multiplier: 1, forceManual: false };
  if (entry.manual === true) return { multiplier: 1, forceManual: true };
  return { multiplier: entry.multiplier, forceManual: false };
}

function resolveTreeShrubDensityMultiplier(density) {
  return resolveMultiplier(TREE_SHRUB_DENSITY, density);
}
function resolveMosquitoPressureMultiplier(pressure) {
  return resolveMultiplier(MOSQUITO_PRESSURE, pressure);
}

module.exports = {
  TREE_SHRUB_DENSITY,
  MOSQUITO_PRESSURE,
  TREE_SHRUB_DENSITY_OPTIONS,
  MOSQUITO_PRESSURE_OPTIONS,
  resolveTreeShrubDensityMultiplier,
  resolveMosquitoPressureMultiplier,
};
