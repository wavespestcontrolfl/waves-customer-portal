/**
 * Heat index for tech safety (owner 2026-10-31, "heat index for tech safety on summer afternoons").
 * A warning line only: it never feeds a spray verdict, a hold, a readiness chip or a dose (owner 2026-10-29).
 */

// NWS heat index equation, https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml: the simple formula first;
// when the average of that result and the air temperature is 80°F or more, the Rothfusz regression with the
// NWS's two adjustments (very dry air, and very humid air at 80-87°F). T in °F, RH in percent.
function heatIndexF(tempF, rh) {
  const T = Number(tempF);
  const RH = Number(rh);
  if (tempF == null || rh == null || !Number.isFinite(T) || !Number.isFinite(RH)) return null;
  const simple = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + RH * 0.094);
  if ((simple + T) / 2 < 80) return simple;
  let hi = -42.379 + 2.04901523 * T + 10.14333127 * RH - 0.22475541 * T * RH - 0.00683783 * T * T
    - 0.05481717 * RH * RH + 0.00122874 * T * T * RH + 0.00085282 * T * RH * RH - 0.00000199 * T * T * RH * RH;
  if (RH < 13 && T >= 80 && T <= 112) hi -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  if (RH > 85 && T >= 80 && T <= 87) hi += ((RH - 85) / 10) * ((87 - T) / 5);
  return hi;
}

// OSHA, "Using the Heat Index: A Guide for Employers" (https://www.osha.gov/heat-exposure/hazards): High is 103-115°F,
// Very high to extreme is above 115°F. The lower bands (Caution, Moderate) show nothing here.
const HEAT_HIGH_FROM_F = 103;
const HEAT_EXTREME_ABOVE_F = 115;
function heatLevel(hi) {
  if (!Number.isFinite(hi) || hi < HEAT_HIGH_FROM_F) return null;
  return hi > HEAT_EXTREME_ABOVE_F ? 'extreme' : 'high';
}

const HEAT_TEXT = {
  high: (hi, at) => `Heat index ${hi}°F at ${at}. Drink water every 15 minutes. Rest in the shade.`,
  extreme: (hi, at) => `Heat index ${hi}°F at ${at} — extreme heat. Drink water every 15 minutes. Rest in the shade often. Watch each other for heat illness.`,
};

/**
 * The worst heat index among the rows (hours with both a temperature and a humidity), as the tech line
 * { heatIndexF, at, level, text }, or null when no row reaches the High band or none has both readings.
 * `labelOf` names a row's hour ("2 pm").
 */
function heatSafetyFromRows(rows, labelOf) {
  let worst = null;
  for (const row of rows) {
    const hi = heatIndexF(row.temperatureF, row.relativeHumidity);
    if (hi != null && (!worst || hi > worst.hi)) worst = { hi, row };
  }
  // The band follows the whole number the tech reads, so "115°F" is never called extreme (OSHA: above 115).
  const heatIndex = worst && Math.round(worst.hi);
  const level = worst && heatLevel(heatIndex);
  if (!level) return null;
  const at = labelOf(worst.row);
  return { heatIndexF: heatIndex, at, level, text: HEAT_TEXT[level](heatIndex, at) };
}

module.exports = { heatIndexF, heatLevel, heatSafetyFromRows };
