// Database-enforced deployment generation for active Staff time writes.
//
// Phase A (schema preparation) uses 1. The Staff auth migration advances the
// database constraint to 2 in the same transaction that revokes sessions, and
// the Staff application commit advances this constant to 2. Older application
// generations then fail closed if they attempt to start/reopen a timer during
// Railway's pre-deploy/cutover overlap.
const ACTIVE_WRITE_GENERATION = 2;
const WEEKLY_OT_THRESHOLD_MINUTES = 40 * 60;
// Unpaid meal (GATE_AUTO_LUNCH, owner 2026-10-25). A recorded break of at
// least UNPAID_MEAL_MIN_BREAK_MINUTES is an unpaid meal (federal rule: 30
// minutes or more). A work day longer than AUTO_LUNCH_SHIFT_THRESHOLD_MINUTES
// takes AUTO_LUNCH_MINUTES off unless the tech taps "No lunch today".
const UNPAID_MEAL_MIN_BREAK_MINUTES = 30;
const AUTO_LUNCH_SHIFT_THRESHOLD_MINUTES = 6 * 60;
const AUTO_LUNCH_MINUTES = 30;

module.exports = {
  ACTIVE_WRITE_GENERATION,
  WEEKLY_OT_THRESHOLD_MINUTES,
  UNPAID_MEAL_MIN_BREAK_MINUTES,
  AUTO_LUNCH_SHIFT_THRESHOLD_MINUTES,
  AUTO_LUNCH_MINUTES,
};
