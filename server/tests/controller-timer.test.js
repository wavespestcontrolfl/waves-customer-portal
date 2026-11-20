// The sprinkler timer on file as one record (services/controller-timer.js): the helpers the row movers use.
// The move is tested in lawn-sod-move.test.js, the merge in customer-dedupe.test.js, the undo in customer-dedupe-undo.test.js.
const {
  CONTROLLER_TIMER_FIELDS, clearedControllerTimer, controllerTimerOf, hasControllerTimer, settleKeptControllerTimer,
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

// The premise a merge settles the kept customer's own row with (customer-dedupe timerPremiseOf).
const RAIN_BIRD = { ...NO_TIMER, irrigation_controller_brand: 'rain_bird' };

test('the kept customer\'s own timer stays while the merge leaves their home unchanged, even one field of it', () => {
  for (const timer of [X2, RAIN_BIRD, LONE_ANSWER, NO_TIMER]) expect(settleKeptControllerTimer(timer, { winnerStays: true })).toEqual({});
});

test('their home changes (a backfilled unit, a first address): their own timer is cleared whole, as an address edit clears it', () => {
  expect(settleKeptControllerTimer(X2, { winnerStays: false })).toEqual(NO_TIMER);
  expect(settleKeptControllerTimer(LONE_ANSWER, { winnerStays: false })).toEqual(NO_TIMER);
  expect(settleKeptControllerTimer(NO_TIMER, { winnerStays: false })).toEqual({});
});

test('only an exact false clears it; an unknown premise, or a row with no timer columns, changes nothing', () => {
  for (const winnerStays of [true, undefined, null, 'false', 0]) expect(settleKeptControllerTimer(X2, { winnerStays })).toEqual({});
  for (const premise of [undefined, null, {}]) expect(settleKeptControllerTimer(X2, premise)).toEqual({});
  expect(settleKeptControllerTimer({ id: 'np-1', sms_opt_in: true }, { winnerStays: false })).toEqual({});
});
