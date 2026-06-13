'use strict';

/**
 * Irrigation advice for the lawn service report.
 *
 * v1 (this module): a grass-type × season lookup grounded in UF/IFAS SWFL
 * warm-season turf guidance, plus a water-balance differential comparing the
 * recommended weekly water to what the lawn actually receives (the customer's
 * scheduled irrigation + recent rainfall). A surplus reads as over-watering
 * (cross-checks the fungus/mushroom vision signal); a deficit reads as drought
 * stress. When no irrigation schedule is on file we surface that so the report
 * can prompt the customer to add it.
 *
 * Phase 2 (not here): replace the season lookup with a true ET₀-based target
 * (FAWN reference evapotranspiration × turf crop-coefficient).
 */

// Peak-season (high-ET summer) weekly target inches by grass type, per UF/IFAS
// SWFL warm-season turf guidance. Unknown/other grass falls back to the default.
const PEAK_INCHES_BY_GRASS = {
  st_augustine: 1.25,
  zoysia: 1.0,
  bermuda: 1.25,
  bahia: 0.75, // drought tolerant
  centipede: 0.75,
  seashore_paspalum: 1.0,
};
const DEFAULT_PEAK_INCHES = 1.0;

// Season multiplier by ET demand. SWFL months are grouped into peak demand
// (Jun–Sep), shoulder (Apr–May, Oct–Nov), and cool/dormant (Dec–Mar).
function seasonMultiplier(month) {
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) return 1.0;
  if (m >= 6 && m <= 9) return 1.0;       // peak
  if (m === 4 || m === 5 || m === 10 || m === 11) return 0.75; // shoulder
  return 0.5;                              // Dec–Mar cool/dormant
}

function normalizeGrassKey(grassType) {
  return String(grassType || '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z_]/g, '');
}

function roundQuarter(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 4) / 4; // nearest 0.25"
}

/**
 * Recommended weekly irrigation+rain target (inches) for a grass type in a
 * given calendar month. Returns a number rounded to the nearest 0.25".
 */
function recommendedInchesPerWeek(grassType, month) {
  const peak = PEAK_INCHES_BY_GRASS[normalizeGrassKey(grassType)] ?? DEFAULT_PEAK_INCHES;
  return roundQuarter(peak * seasonMultiplier(month));
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the water-balance advice for the report.
 *
 * @param {object} args
 * @param {string} [args.grassType]
 * @param {number} [args.month] 1–12 (defaults to current month if omitted)
 * @param {number|null} [args.irrigationInchesPerWeek] scheduled irrigation on file
 * @param {number|null} [args.rainfallInches7d] recent rainfall (effective, last 7d)
 * @param {boolean|null} [args.irrigationEnabled] portal irrigation-system toggle;
 *   false forces missing-profile (stale inches don't count)
 * @returns {{
 *   recommendedInchesPerWeek: number,
 *   appliedInchesPerWeek: number|null,
 *   differentialInchesPerWeek: number|null,
 *   status: 'deficit'|'surplus'|'balanced'|'rain_unknown'|'unknown',
 *   profileMissing: boolean,
 *   rainKnown: boolean,
 * }}
 */
function buildIrrigationAdvice({
  grassType = null,
  month = null,
  irrigationInchesPerWeek = null,
  rainfallInches7d = null,
  irrigationEnabled = null,
} = {}) {
  const recommendedInchesPerWeek0 = recommendedInchesPerWeek(grassType, month);
  const irrigation = numberOrNull(irrigationInchesPerWeek);
  const rain = numberOrNull(rainfallInches7d);
  const rainKnown = rain != null;

  // No usable schedule: null/zero inches, OR the customer turned their irrigation
  // system off (a stale weekly-inches value must not count as a live schedule).
  const profileMissing = irrigation == null || irrigation <= 0 || irrigationEnabled === false;

  if (profileMissing) {
    return {
      recommendedInchesPerWeek: recommendedInchesPerWeek0,
      appliedInchesPerWeek: null,
      differentialInchesPerWeek: null,
      status: 'unknown',
      profileMissing: true,
      rainKnown,
    };
  }

  const appliedInchesPerWeek = roundQuarter(irrigation + (rainKnown ? rain : 0));
  const differentialInchesPerWeek = roundQuarter(appliedInchesPerWeek - recommendedInchesPerWeek0);

  // A quarter-inch band around the target is balanced; outside it the lawn is
  // meaningfully over/under-watered. Surplus is safe even when rainfall is
  // unknown (rain only adds water), but we must NOT claim a deficit/balanced
  // without rainfall — the missing rain could close the gap — so report
  // 'rain_unknown' and withhold the differential in that case.
  let status;
  let differentialOut = differentialInchesPerWeek;
  if (differentialInchesPerWeek >= 0.25) {
    status = 'surplus';
  } else if (!rainKnown) {
    status = 'rain_unknown';
    differentialOut = null;
  } else if (differentialInchesPerWeek <= -0.25) {
    status = 'deficit';
  } else {
    status = 'balanced';
  }

  return {
    recommendedInchesPerWeek: recommendedInchesPerWeek0,
    appliedInchesPerWeek,
    differentialInchesPerWeek: differentialOut,
    status,
    profileMissing: false,
    rainKnown,
  };
}

module.exports = {
  recommendedInchesPerWeek,
  buildIrrigationAdvice,
  _private: { seasonMultiplier, normalizeGrassKey, PEAK_INCHES_BY_GRASS },
};
