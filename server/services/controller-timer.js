/**
 * The sprinkler timer on file: property_preferences.irrigation_controller_brand / _model / _app
 * (migration 20261119140000). The three columns are ONE record about one box on the wall of one home, so
 * nothing that moves a preferences row treats them one by one:
 *   - a move clears it (customer-address-fanout markSprinklerSettingsMoved);
 *   - a customer merge never fills it column by column. Two rows that fold keep the kept customer's timer while
 *     their home is unchanged, else take the other row's whole timer when it describes the home the merge leaves,
 *     else clear it (customer-dedupe mergeSingletonPrefRow). A row that moves whole is journaled
 *     (settleMovedPrefTimer) so an undo never hands it to another home.
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

// Two preferences rows fold in a customer merge: the timer the kept row ends with, as the columns to set ({} = leave
// the row as it is). Whole or nothing, never one field. `premise` is the merge's (customer-dedupe timerPremiseOf):
//   - winnerStays: the kept customer's own home is unchanged. Their own timer (even one field of it) then stays.
//     Only an exact false moves it, as an address edit would; an unknown premise keeps it.
//   - loserFollows: the other customer's home is the one the merge leaves. Only an exact true carries their timer.
// A kept timer that does not stay is replaced by the other row's whole timer when that one follows, else cleared.
// A row without the timer columns (another preferences table) has none to carry or clear.
function controllerTimerToCarry(winnerRow, loserRow, premise) {
  const ownTimer = hasControllerTimer(winnerRow);
  if (ownTimer && premise?.winnerStays !== false) return {};
  if (premise?.loserFollows === true && hasControllerTimer(loserRow)) return controllerTimerOf(loserRow);
  return ownTimer ? clearedControllerTimer() : {};
}

module.exports = { CONTROLLER_TIMER_FIELDS, clearedControllerTimer, controllerTimerOf, controllerTimerToCarry, hasControllerTimer };
