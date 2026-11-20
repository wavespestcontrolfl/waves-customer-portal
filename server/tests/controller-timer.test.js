// The sprinkler timer on file as one record (services/controller-timer.js): the helpers the row movers use.
// The move is tested in lawn-sod-move.test.js, the merge in customer-dedupe.test.js, the undo in customer-dedupe-undo.test.js.
const {
  CONTROLLER_TIMER_FIELDS, clearedControllerTimer, controllerTimerOf, controllerTimerToCarry, hasControllerTimer,
} = require('../services/controller-timer');

const X2 = { irrigation_controller_brand: 'hunter', irrigation_controller_model: 'x2', irrigation_controller_app: 'yes' };
const NO_TIMER = { irrigation_controller_brand: null, irrigation_controller_model: null, irrigation_controller_app: null };
const LONE_ANSWER = { ...NO_TIMER, irrigation_controller_app: 'yes' };

test('the record is the three columns, read and cleared as a whole', () => {
  expect(CONTROLLER_TIMER_FIELDS).toEqual(Object.keys(X2));
  expect(clearedControllerTimer()).toEqual(NO_TIMER);
  expect(controllerTimerOf({ id: 'pp-1', irrigation_zones: 6, ...X2 })).toEqual(X2);
  expect(controllerTimerOf({ id: 'pp-1' })).toEqual(NO_TIMER);
  expect(controllerTimerOf(null)).toEqual(NO_TIMER);
});

test('any non-null column is a timer: the columns are independently nullable', () => {
  expect(hasControllerTimer(X2)).toBe(true);
  expect(hasControllerTimer(LONE_ANSWER)).toBe(true);
  for (const none of [NO_TIMER, {}, null, undefined]) expect(hasControllerTimer(none)).toBe(false);
});

test('a same-home merge carries the other row\'s whole timer, and only onto a row that has none at all', () => {
  expect(controllerTimerToCarry(NO_TIMER, X2, true)).toEqual(X2);
  expect(controllerTimerToCarry({}, { irrigation_controller_brand: 'rain_bird' }, true)).toEqual({ ...NO_TIMER, irrigation_controller_brand: 'rain_bird' });
  expect(controllerTimerToCarry({}, LONE_ANSWER, true)).toEqual(LONE_ANSWER);
  expect(controllerTimerToCarry({ irrigation_controller_brand: 'rain_bird' }, X2, true)).toEqual({});
  expect(controllerTimerToCarry(LONE_ANSWER, X2, true)).toEqual({}); // never overwrites one field of the winner's own
  expect(controllerTimerToCarry(X2, NO_TIMER, true)).toEqual({});
});

test('only an explicit same-home answer carries it: a different-homes or unknown merge, or a row with no timer columns, carries nothing', () => {
  for (const sameHome of [false, undefined, null, 'true', 1]) expect(controllerTimerToCarry(NO_TIMER, X2, sameHome)).toEqual({});
  expect(controllerTimerToCarry({ id: 'np-1', sms_opt_in: true }, { id: 'np-2', sms_opt_in: false }, true)).toEqual({});
});
