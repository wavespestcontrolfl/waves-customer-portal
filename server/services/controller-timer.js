/**
 * The sprinkler timer on file: property_preferences.irrigation_controller_brand / _model / _app
 * (migration 20261119140000). The three columns are ONE record about one box on the wall of one home, so
 * nothing that moves a preferences row treats them one by one:
 *   - a move clears it (customer-address-fanout markSprinklerSettingsMoved);
 *   - a customer merge copies it whole or leaves it (customer-dedupe mergeSingletonPrefRow), and journals it
 *     on a row that moves whole (settleMovedPrefTimer) so an undo never hands it to another home.
 * It is not a watering input. Nothing here connects to, pauses or starts a timer.
 */
const CONTROLLER_TIMER_FIELDS = Object.freeze(['irrigation_controller_brand', 'irrigation_controller_model', 'irrigation_controller_app']);
const [BRAND, MODEL, APP] = CONTROLLER_TIMER_FIELDS;

function clearedControllerTimer() {
  return { [BRAND]: null, [MODEL]: null, [APP]: null };
}

// The timer on a property_preferences row as plain values, keyed by column (a column the row lacks reads as null).
function controllerTimerOf(row) {
  return Object.fromEntries(CONTROLLER_TIMER_FIELDS.map((field) => [field, row?.[field] ?? null]));
}

// A same-home customer merge: the surviving row takes the other row's whole timer only when it has none.
// Whole or nothing. Returns the columns to set ({} = leave the row alone).
function controllerTimerToCarry(winnerRow, loserRow) {
  if (winnerRow?.[BRAND] || !loserRow?.[BRAND]) return {};
  return controllerTimerOf(loserRow);
}

module.exports = { CONTROLLER_TIMER_FIELDS, clearedControllerTimer, controllerTimerOf, controllerTimerToCarry };
