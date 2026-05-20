/**
 * Pest Pressure display helpers.
 *
 * customerVisiblePressureIndex applies the 0.3 display floor so customer
 * reports never show a literal "0.0" — relocated from the legacy
 * service-report/pressure-index.js module so callers can depend on it
 * without pulling in the deprecated scoring functions.
 */

const PRESSURE_INDEX_DISPLAY_FLOOR = 0.3;

function roundPressure(value) {
  return Math.round(Number(value) * 10) / 10;
}

function customerVisiblePressureIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return roundPressure(Math.max(n, PRESSURE_INDEX_DISPLAY_FLOOR));
}

module.exports = {
  PRESSURE_INDEX_DISPLAY_FLOOR,
  customerVisiblePressureIndex,
  roundPressure,
};
