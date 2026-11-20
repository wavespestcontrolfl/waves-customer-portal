/**
 * The sprinkler timer on file: property_preferences.irrigation_controller_brand / _model / _app
 * (migration 20261119140000). The three columns are ONE record about one box on the wall of one home, so
 * nothing that writes or moves a preferences row treats them one by one:
 *   - a write saves it whole or not at all, only from a form rendered against the home on the row now, and only over
 *     the timer that form showed (settleControllerTimer: the customer's and the staff preference writer, under their
 *     preference lock);
 *   - a move clears it (customer-address-fanout markSprinklerSettingsMoved);
 *   - a customer merge never fills it column by column, and never gives one customer's timer to the other. The
 *     kept customer's own timer stays while the merge leaves their home unchanged, else it is cleared
 *     (settleKeptControllerTimer). The other customer's timer is cleared on a row that moves whole, or goes with a
 *     row that folds; both are journaled (customer-dedupe settleMovedPrefTimer, snapshotFoldedPrefTimers).
 * The staff count (Intelligence Bar get_sprinkler_timer_counts) totals the record by timer and by the phone-app
 * answer (controllerTimerCounts).
 * It is not a watering input. Nothing here connects to, pauses or starts a timer.
 */
const { CONTROLLER_BRANDS, CONTROLLER_MODELS, controllerAsksAboutApp } = require('@waves/irrigation-runtime');

const CONTROLLER_TIMER_FIELDS = Object.freeze(['irrigation_controller_brand', 'irrigation_controller_model', 'irrigation_controller_app']);
const [BRAND, MODEL, APP] = CONTROLLER_TIMER_FIELDS;
// The request names the writers' rejections use (the camelCase fields both forms send).
const REQUEST_NAMES = Object.freeze({
  [BRAND]: 'irrigationControllerBrand', [MODEL]: 'irrigationControllerModel', [APP]: 'irrigationControllerApp',
});

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

// The timer as one comparable value: brand|model|app, '' for a blank (the customer's page builds the same).
function controllerTimerKey(row) {
  return CONTROLLER_TIMER_FIELDS.map((field) => row?.[field] ?? '').join('|');
}

// The timers a form says the row may hold, as controllerTimerKey values: the one it showed when its timer change was
// made, and any its own failed saves sent (they may have landed). `controller_timer_seen` from the customer's page,
// `controllerTimerSeen` from the staff form; one key or a list, each key counted once. There are 20 timers that can
// exist, so a list of more than 32 keys is not one a form built. null when the request carries none.
function controllerTimerSeen(body) {
  const raw = body || {};
  const seen = raw.controller_timer_seen ?? raw.controllerTimerSeen;
  const keys = typeof seen === 'string' ? [seen] : Array.isArray(seen) ? [...new Set(seen)] : null;
  const valid = Array.isArray(keys) && keys.length > 0 && keys.length <= 32
    && keys.every((key) => typeof key === 'string' && key.length <= 64);
  return valid ? keys : null;
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
const TIMER_CHANGED = 'The sprinkler timer on this account changed while this page was open. Reload, then set it again.';

// Settles the timer fields of one preference write, in place. Call it inside the writer's preference lock, with
// `fresh` = the request was rendered against the home on the row now (a move clears the timer under the same lock,
// and the lock orders the writes but says nothing about when the form was rendered), `stored` = the row read under
// the lock, and `seen` = the timers the form says the row may hold (controllerTimerSeen: a key or a list). A change
// lands only over one of them: a page left open never puts back a timer someone else replaced, and an app answer
// never lands on another box. A write that names none (null) is refused. A timer equal to the one stored changes
// nothing and needs no check: the retry of a save that landed but whose answer was lost.
// Returns the rejections ([{ field, message }], one for each timer field the write named). When it returns any,
// no timer field is left in `updates`, so the stored timer is never a mix of two writes.
function settleControllerTimer(updates, { fresh = true, stored = null, seen = null } = {}) {
  const named = CONTROLLER_TIMER_FIELDS.filter((field) => field in updates);
  if (!named.length) return [];
  let message = controllerTimerProblem({ brand: updates[BRAND], model: updates[MODEL], app: updates[APP] });
  if (named.length < CONTROLLER_TIMER_FIELDS.length) message = NOT_WHOLE;
  const storedKey = controllerTimerKey(stored);
  if (!message && ![].concat(seen ?? []).includes(storedKey) && controllerTimerKey(updates) !== storedKey) message = TIMER_CHANGED;
  if (!fresh) message = STALE_HOME;
  if (!message) return [];
  for (const field of named) delete updates[field];
  return named.map((field) => ({ field: REQUEST_NAMES[field], message }));
}

// The kept customer's own timer when a customer merge settles their preferences row (a fold, or their row alone),
// as the columns to set ({} = leave the row as it is). `premise` is the merge's (customer-dedupe timerPremiseOf):
// winnerStays says the merge leaves their home unchanged. Their timer (even one field of it) then stays; only an
// exact false clears it, whole, as an address edit would; an unknown premise keeps it. The other customer's timer
// never comes over. A row without the timer columns (another preferences table) has none to clear.
function settleKeptControllerTimer(winnerRow, premise) {
  return hasControllerTimer(winnerRow) && premise?.winnerStays === false ? clearedControllerTimer() : {};
}

// Where one recorded timer stands on the phone-app question. The answer counts only where the question exists
// (controllerAsksAboutApp). A Hunter with no model on file was never asked: the model decides the question.
const APP_STANDING = Object.freeze({ yes: 'on_phone_app', no: 'not_on_phone_app', unknown: 'not_sure' });
function controllerAppStanding({ brand, model, app }) {
  if (controllerAsksAboutApp(brand, model)) return APP_STANDING[app] || 'not_answered';
  return brand === 'hunter' && model == null ? 'not_answered' : 'no_app_question';
}

// The staff count. rows: one per recorded (brand, model, app), with its number of customers. Totals only: the
// answers are what the customer or staff recorded, and nothing checks or connects a timer.
function controllerTimerCounts(rows) {
  const summary = { on_phone_app: 0, not_on_phone_app: 0, not_sure: 0, not_answered: 0, no_app_question: 0 };
  const byTimer = rows.map((row) => {
    const customers = Number(row.customers) || 0;
    const phoneApp = controllerAppStanding(row);
    summary[phoneApp] += customers;
    const model = row.brand === 'hunter' ? (CONTROLLER_MODELS[row.model] || '(model not recorded)') : '';
    return { timer: `${CONTROLLER_BRANDS[row.brand] || row.brand} ${model}`.trim(), phone_app: phoneApp, customers };
  }).sort((a, b) => b.customers - a.customers || a.timer.localeCompare(b.timer) || a.phone_app.localeCompare(b.phone_app));
  const total = byTimer.reduce((sum, row) => sum + row.customers, 0);
  return { customers_with_a_timer: total, summary, by_timer: byTimer };
}

module.exports = {
  CONTROLLER_TIMER_FIELDS, clearedControllerTimer, controllerTimerCounts, controllerTimerKey, controllerTimerOf,
  controllerTimerProblem, controllerTimerSeen, hasControllerTimer, settleControllerTimer, settleKeptControllerTimer,
};
