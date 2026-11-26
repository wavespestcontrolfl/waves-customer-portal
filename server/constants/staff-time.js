// Database-enforced deployment generation for active Staff time writes.
//
// Phase A (schema preparation) uses 1. The Staff auth migration advances the
// database constraint to 2 in the same transaction that revokes sessions, and
// the Staff application commit advances this constant to 2. Older application
// generations then fail closed if they attempt to start/reopen a timer during
// Railway's pre-deploy/cutover overlap.
const ACTIVE_WRITE_GENERATION = 2;
const WEEKLY_OT_THRESHOLD_MINUTES = 40 * 60;
// A recorded break of at least UNPAID_MEAL_MIN_BREAK_MINUTES counts as a meal
// (federal rule: 30 minutes or more) when payroll-holiday-work.js splits a
// stored meal deduction across a holiday. Waves takes no unpaid lunch (owner
// 2026-11-22): every clocked minute is paid and the stored deduction is 0.
const UNPAID_MEAL_MIN_BREAK_MINUTES = 30;

module.exports = {
  ACTIVE_WRITE_GENERATION,
  WEEKLY_OT_THRESHOLD_MINUTES,
  UNPAID_MEAL_MIN_BREAK_MINUTES,
};
