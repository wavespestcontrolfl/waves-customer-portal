/**
 * The sprinkler timer on file: property_preferences.irrigation_controller_brand / _model / _app
 * (migration 20261119140000). The three columns are ONE record about one box on the wall of one home, so
 * nothing that moves a preferences row treats them one by one:
 *   - a move clears it (customer-address-fanout markSprinklerSettingsMoved);
 *   - a customer merge never fills it column by column, and never gives one customer's timer to the other. The
 *     kept customer's own timer stays while the merge leaves their home unchanged, else it is cleared
 *     (settleKeptControllerTimer). The other customer's timer is cleared on a row that moves whole, or goes with a
 *     row that folds; both are journaled (customer-dedupe settleMovedPrefTimer, snapshotFoldedPrefTimers).
 * It is not a watering input. Nothing here connects to, pauses or starts a timer.
 */
const CONTROLLER_TIMER_FIELDS = Object.freeze(['irrigation_controller_brand', 'irrigation_controller_model', 'irrigation_controller_app']);

function clearedControllerTimer() {
  return controllerTimerOf(null);
}

// The timer on a property_preferences row as plain values, keyed by column (a column the row lacks reads as null).
function controllerTimerOf(row) {
  return Object.fromEntries(CONTROLLER_TIMER_FIELDS.map((field) => [field, row?.[field] ?? null]));
}

// Does the row carry a timer? The columns are independently nullable, so ANY non-null one is a record.
function hasControllerTimer(row) {
  return CONTROLLER_TIMER_FIELDS.some((field) => row?.[field] != null);
}

// The kept customer's own timer when a customer merge settles their preferences row (a fold, or their row alone),
// as the columns to set ({} = leave the row as it is). `premise` is the merge's (customer-dedupe timerPremiseOf):
// winnerStays says the merge leaves their home unchanged. Their timer (even one field of it) then stays; only an
// exact false clears it, whole, as an address edit would; an unknown premise keeps it. The other customer's timer
// never comes over. A row without the timer columns (another preferences table) has none to clear.
function settleKeptControllerTimer(winnerRow, premise) {
  return hasControllerTimer(winnerRow) && premise?.winnerStays === false ? clearedControllerTimer() : {};
}

module.exports = { CONTROLLER_TIMER_FIELDS, clearedControllerTimer, controllerTimerOf, hasControllerTimer, settleKeptControllerTimer };
