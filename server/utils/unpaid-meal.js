const {
  UNPAID_MEAL_MIN_BREAK_MINUTES,
  AUTO_LUNCH_SHIFT_THRESHOLD_MINUTES,
  AUTO_LUNCH_MINUTES,
} = require('../constants/staff-time');
const { PAYROLL_SCALE } = require('./payroll-units');

/**
 * Unpaid meal minutes for one ET work day, in payroll units (hundredths of a
 * minute, BigInt). Pure: no database, no gate read.
 *
 *   recordedMeal = sum of the day's completed breaks that each last 30 minutes
 *                  or more (federal rule: shorter rest breaks stay paid)
 *   auto         = 30 minutes when the day's shift total is over 6 hours and
 *                  the tech did not tap "No lunch today", else 0
 *   unpaid       = min(shift total, max(recordedMeal, auto))
 *
 * `enabled` is GATE_AUTO_LUNCH. Off means 0, so every number equals the
 * pre-gate arithmetic.
 */
function unpaidMealUnits({
  totalShiftUnits,
  breakDurationUnits = [],
  noLunch = false,
  enabled = false,
} = {}) {
  if (!enabled) return 0n;
  const shift = BigInt(totalShiftUnits || 0);
  if (shift <= 0n) return 0n;

  const mealFloor = BigInt(UNPAID_MEAL_MIN_BREAK_MINUTES) * PAYROLL_SCALE;
  const recordedMeal = breakDurationUnits.reduce(
    (sum, units) => (BigInt(units) >= mealFloor ? sum + BigInt(units) : sum),
    0n,
  );
  const autoThreshold = BigInt(AUTO_LUNCH_SHIFT_THRESHOLD_MINUTES) * PAYROLL_SCALE;
  const auto = !noLunch && shift > autoThreshold
    ? BigInt(AUTO_LUNCH_MINUTES) * PAYROLL_SCALE
    : 0n;

  const unpaid = recordedMeal > auto ? recordedMeal : auto;
  return unpaid < shift ? unpaid : shift;
}

module.exports = { unpaidMealUnits };
