/**
 * The sprinkler timer on file: property_preferences.irrigation_controller_brand / _model / _app
 * (migration 20261119140000). The three columns are ONE record about one box on the wall of one home:
 *   - it saves whole or not at all (settleControllerTimer, both preference writers, under their lock);
 *   - a move clears it (customer-address-fanout markSprinklerSettingsMoved);
 *   - a customer merge copies it whole or leaves it (customer-dedupe mergeSingletonPrefRow).
 * It is not a watering input. Nothing here connects to, pauses or starts a timer.
 */
const { controllerAsksAboutApp } = require('@waves/irrigation-runtime');

const CONTROLLER_TIMER_FIELDS = Object.freeze(['irrigation_controller_brand', 'irrigation_controller_model', 'irrigation_controller_app']);
const [BRAND, MODEL, APP] = CONTROLLER_TIMER_FIELDS;
const REQUEST_NAMES = Object.freeze({
  [BRAND]: 'irrigationControllerBrand', [MODEL]: 'irrigationControllerModel', [APP]: 'irrigationControllerApp',
});

function clearedControllerTimer() {
  return { [BRAND]: null, [MODEL]: null, [APP]: null };
}

// Why the three values cannot be one timer, or null when they can.
function controllerTimerProblem({ brand, model, app }) {
  if (brand == null) return model == null && app == null ? null : 'A sprinkler timer with no brand has no model and no phone-app answer.';
  if (brand !== 'hunter' && model != null) return 'Only a Hunter sprinkler timer has a model on the list.';
  if (app != null && !controllerAsksAboutApp(brand, model)) return 'This sprinkler timer has no phone-app question.';
  return null;
}

const STALE_HOME = 'The home on this account changed. Reload, then set the sprinkler timer again.';
const NOT_WHOLE = 'The sprinkler timer saves as one record: send the brand, the model and the phone-app answer together.';

// Settles the timer fields of one preference write, in place. Call it inside the writer's preference lock, with
// `fresh` = the request was rendered against the home on the row now: a move clears the timer under the same lock,
// and the lock orders the writes but says nothing about when the form was rendered.
// Returns the rejections ([{ field, message }], one for each timer field the write named). When it returns any,
// no timer field is left in `updates`, so the stored timer is never a mix of two writes.
function settleControllerTimer(updates, { fresh = true } = {}) {
  const named = CONTROLLER_TIMER_FIELDS.filter((field) => field in updates);
  if (!named.length) return [];
  let message = controllerTimerProblem({ brand: updates[BRAND], model: updates[MODEL], app: updates[APP] });
  if (named.length < CONTROLLER_TIMER_FIELDS.length) message = NOT_WHOLE;
  if (!fresh) message = STALE_HOME;
  if (!message) return [];
  for (const field of named) delete updates[field];
  return named.map((field) => ({ field: REQUEST_NAMES[field], message }));
}

module.exports = { CONTROLLER_TIMER_FIELDS, clearedControllerTimer, controllerTimerProblem, settleControllerTimer };
