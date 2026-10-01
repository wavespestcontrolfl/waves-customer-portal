/**
 * reschedule_log rows that really moved a visit: a changed date, or a changed
 * window start on the same date. A bulk reschedule onto the visit's own slot
 * still writes a row, and a missed-appointment row has no new_date, so neither
 * counts. Shared by the SMS fulfillment checker and typed-decision outcome
 * evidence. `t` is the reschedule_log alias.
 */
const LOGGED_MOVE_SQL = (t) => `${t}.original_date IS NOT NULL AND ${t}.new_date IS NOT NULL
  AND (${t}.new_date <> ${t}.original_date
    OR (${t}.original_window IS NOT NULL AND ${t}.new_window IS NOT NULL AND LEFT(split_part(${t}.new_window, '-', 1), 5) IS DISTINCT FROM LEFT(split_part(COALESCE(${t}.original_window, ''), '-', 1), 5)))`;

module.exports = { LOGGED_MOVE_SQL };
