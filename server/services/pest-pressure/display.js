/**
 * Pest Pressure display helpers.
 *
 * customerVisiblePressureIndex normalizes a stored pressure index for
 * customer reports — relocated from the legacy service-report/
 * pressure-index.js module so callers can depend on it without pulling in
 * the deprecated scoring functions. The old 0.3 display floor is gone
 * (owner ruling 2026-09-24): a technician's 0 means no pests and reads
 * 0.0 everywhere, matching the Pest Pressure gauge.
 */

const PRESSURE_INDEX_DISPLAY_FLOOR = 0;

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
