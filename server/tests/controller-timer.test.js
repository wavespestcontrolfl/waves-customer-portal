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

// The premise a fold gets from the merge (customer-dedupe timerPremiseOf).
const SAME_HOME = { loserFollows: true, winnerStays: true };
const RAIN_BIRD = { ...NO_TIMER, irrigation_controller_brand: 'rain_bird' };

test('a fold keeps the kept customer\'s own timer while their home is unchanged, and carries the other row\'s whole timer only onto a row with none', () => {
  expect(controllerTimerToCarry(NO_TIMER, X2, SAME_HOME)).toEqual(X2);
  expect(controllerTimerToCarry({}, { irrigation_controller_brand: 'rain_bird' }, SAME_HOME)).toEqual(RAIN_BIRD);
  expect(controllerTimerToCarry({}, LONE_ANSWER, SAME_HOME)).toEqual(LONE_ANSWER);
  expect(controllerTimerToCarry(RAIN_BIRD, X2, SAME_HOME)).toEqual({});
  expect(controllerTimerToCarry(LONE_ANSWER, X2, SAME_HOME)).toEqual({}); // never overwrites one field of the winner's own
  expect(controllerTimerToCarry(X2, NO_TIMER, SAME_HOME)).toEqual({});
});

test('the kept customer\'s home changes (a backfilled unit, a first address): their own timer goes, replaced whole by the other row\'s when that one follows', () => {
  expect(controllerTimerToCarry(RAIN_BIRD, X2, { loserFollows: true, winnerStays: false })).toEqual(X2);
  expect(controllerTimerToCarry(LONE_ANSWER, NO_TIMER, { loserFollows: true, winnerStays: false })).toEqual(NO_TIMER);
  expect(controllerTimerToCarry(RAIN_BIRD, X2, { loserFollows: false, winnerStays: false })).toEqual(NO_TIMER);
  expect(controllerTimerToCarry(NO_TIMER, NO_TIMER, { loserFollows: true, winnerStays: false })).toEqual({});
});

test('only an exact premise moves a timer: the other row\'s on exactly true, the kept one on exactly false; a row with no timer columns has none', () => {
  for (const loserFollows of [false, undefined, null, 'true', 1]) {
    expect(controllerTimerToCarry(NO_TIMER, X2, { loserFollows, winnerStays: true })).toEqual({});
  }
  for (const winnerStays of [true, undefined, null, 'false', 0]) {
    expect(controllerTimerToCarry(X2, NO_TIMER, { loserFollows: true, winnerStays })).toEqual({});
  }
  for (const premise of [undefined, null, {}]) {
    expect(controllerTimerToCarry(X2, RAIN_BIRD, premise)).toEqual({});
    expect(controllerTimerToCarry(NO_TIMER, X2, premise)).toEqual({});
  }
  expect(controllerTimerToCarry({ id: 'np-1', sms_opt_in: true }, { id: 'np-2', sms_opt_in: false }, { loserFollows: true, winnerStays: false })).toEqual({});
});
