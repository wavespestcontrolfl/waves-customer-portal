// The sprinkler timer on file as one record (services/controller-timer.js): the helpers the two preference writers and
// the row movers use. The writers' routes are tested in property-prefs-partial-validation.test.js (the customer's) and
// admin-customers-property-preferences-route.test.js (staff), the move in lawn-sod-move.test.js, the merge in
// customer-dedupe.test.js, the undo in customer-dedupe-undo.test.js.
const { CONTROLLER_BRANDS, CONTROLLER_MODELS, controllerAsksAboutApp } = require('@waves/irrigation-runtime');
const {
  CONTROLLER_TIMER_FIELDS, clearedControllerTimer, controllerTimerKey, controllerTimerOf, controllerTimerSeen,
  hasControllerTimer, settleControllerTimer, settleKeptControllerTimer,
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

// A preference write (settleControllerTimer): the timer saves whole or not at all, and only from a form rendered
// against the home on the row now. `left` is what the write still holds after the settle.
// By default the form showed no timer and the row holds none (`seen` '||', no `stored` row).
const settle = (updates, options) => ({ rejected: settleControllerTimer(updates, { seen: '||', ...options }), left: updates });
const timerColumns = ([brand, model, app]) => ({
  irrigation_controller_brand: brand, irrigation_controller_model: model, irrigation_controller_app: app,
});

test('the phone-app question exists for a Rain Bird and for the Hunter models that can go on Hydrawise', () => {
  const asked = [];
  for (const brand of [null, ...Object.keys(CONTROLLER_BRANDS)]) {
    for (const model of [null, ...Object.keys(CONTROLLER_MODELS)]) if (controllerAsksAboutApp(brand, model)) asked.push(`${brand}/${model}`);
  }
  expect(asked).toEqual(['hunter/x2', 'hunter/pro_c', 'hunter/hydrawise', ...[null, ...Object.keys(CONTROLLER_MODELS)].map((m) => `rain_bird/${m}`)]);
});

test('a whole timer that can exist passes untouched beside other fields; a write without one is never refused', () => {
  for (const timer of [
    ['hunter', 'x2', 'yes'], ['hunter', 'hydrawise', null], ['hunter', 'x_core', null], ['hunter', null, null],
    ['rain_bird', null, 'unknown'], ['other', null, null], [null, null, null],
  ]) {
    const updates = { irrigation_zones: 6, ...timerColumns(timer) };
    expect(settle({ ...updates })).toEqual({ rejected: [], left: updates });
  }
  expect(settle({ irrigation_zones: 6 }, { fresh: false })).toEqual({ rejected: [], left: { irrigation_zones: 6 } });
});

test('a timer field sent without the other two is rejected: an answer never lands on a timer the writer did not see', () => {
  const { rejected, left } = settle({ irrigation_controller_app: 'no', irrigation_zones: 6 });
  expect(left).toEqual({ irrigation_zones: 6 });
  expect(rejected).toEqual([{ field: 'irrigationControllerApp', message: expect.stringMatching(/saves as one record/) }]);
  expect(settle({ irrigation_controller_brand: 'rain_bird', irrigation_controller_model: null }).left).toEqual({});
});

test('a timer that cannot exist is rejected whole, with one reason on each field', () => {
  for (const [timer, reason] of [
    [['rain_bird', 'x2', null], /Only a Hunter/],
    [['other', null, 'yes'], /no phone-app question/],
    [['hunter', 'x_core', 'no'], /no phone-app question/],
    [['hunter', null, 'yes'], /no phone-app question/],
    [[null, 'x2', null], /no brand/],
    [[null, null, 'yes'], /no brand/],
  ]) {
    const { rejected, left } = settle(timerColumns(timer));
    expect(left).toEqual({});
    expect(rejected.map((r) => r.field)).toEqual(['irrigationControllerBrand', 'irrigationControllerModel', 'irrigationControllerApp']);
    for (const r of rejected) expect(r.message).toMatch(reason);
  }
});

test('a timer change lands only over the timer the form showed: a page left open never puts back a replaced timer', () => {
  const RAIN_BIRD = timerColumns(['rain_bird', null, null]);
  // The form showed the X2 and the row still holds it: the new answer saves.
  expect(settle({ ...X2, irrigation_controller_app: 'no' }, { stored: X2, seen: 'hunter|x2|yes' }).rejected).toEqual([]);
  // Someone set a Rain Bird meanwhile: a change from the X2 page is refused whole (an answer, a pick, a clear).
  for (const change of [{ ...X2, irrigation_controller_app: 'no' }, timerColumns(['hunter', 'pro_c', null]), clearedControllerTimer()]) {
    const { rejected, left } = settle({ ...change, irrigation_zones: 6 }, { stored: RAIN_BIRD, seen: 'hunter|x2|yes' });
    expect(left).toEqual({ irrigation_zones: 6 });
    expect(rejected).toHaveLength(3);
    for (const r of rejected) expect(r.message).toBe('The sprinkler timer on this account changed while this page was open. Reload, then set it again.');
  }
  // A timer write that names no timer it saw is refused; a write with no timer field needs none.
  expect(settle({ ...X2 }, { seen: null }).rejected).toHaveLength(3);
  expect(settle({ irrigation_zones: 6 }, { seen: null })).toEqual({ rejected: [], left: { irrigation_zones: 6 } });
  // A move outranks it: the reason names the home.
  expect(settle({ ...X2 }, { stored: RAIN_BIRD, seen: 'hunter|x2|yes', fresh: false }).rejected[0].message).toMatch(/home on this account changed/);
  // A page names every timer the row may hold: after a save that may have landed, the old one and the one it sent.
  const PRO_C = timerColumns(['hunter', 'pro_c', null]);
  const answer = { ...PRO_C, irrigation_controller_app: 'yes' };
  for (const stored of [X2, PRO_C]) expect(settle({ ...answer }, { stored, seen: ['hunter|x2|yes', 'hunter|pro_c|'] }).rejected).toEqual([]);
  expect(settle({ ...answer }, { stored: RAIN_BIRD, seen: ['hunter|x2|yes', 'hunter|pro_c|'] }).rejected).toHaveLength(3);
  // A timer equal to the one stored changes nothing: the retry of a save that landed but whose answer was lost.
  expect(settle({ ...X2, irrigation_zones: 6 }, { stored: X2, seen: '||' })).toEqual({ rejected: [], left: { ...X2, irrigation_zones: 6 } });
  expect(settle({ ...X2 }, { stored: X2, seen: null }).rejected).toEqual([]);
});

test('the timer a form saw comes from either writer\'s field, as brand|model|app', () => {
  expect(controllerTimerKey(X2)).toBe('hunter|x2|yes');
  expect(controllerTimerKey(null)).toBe('||');
  expect(controllerTimerSeen({ controller_timer_seen: ['hunter|x2|yes', 'hunter|pro_c|'] })).toEqual(['hunter|x2|yes', 'hunter|pro_c|']);
  expect(controllerTimerSeen({ controllerTimerSeen: '||' })).toEqual(['||']);
  for (const body of [
    {}, null, { controller_timer_seen: 7 }, { controllerTimerSeen: null }, { controller_timer_seen: [] },
    { controller_timer_seen: ['||', 7] }, { controller_timer_seen: Array.from({ length: 33 }, (_, i) => `hunter|${i}|`) },
    { controller_timer_seen: 'x'.repeat(65) },
  ]) expect(controllerTimerSeen(body)).toBeNull();
  // Each key counts once, so a repeated key never makes a list too long.
  expect(controllerTimerSeen({ controller_timer_seen: [...Array(40).fill('||'), 'hunter|x2|'] })).toEqual(['||', 'hunter|x2|']);
  // Every timer that can exist fits in one list, so no history a form builds is cut off.
  const everyTimer = [];
  for (const brand of [null, ...Object.keys(CONTROLLER_BRANDS)]) {
    for (const model of [null, ...Object.keys(CONTROLLER_MODELS)]) {
      for (const app of [null, 'yes', 'no', 'unknown']) {
        const timer = timerColumns([brand, model, app]);
        if (!settle({ ...timer }).rejected.length) everyTimer.push(controllerTimerKey(timer));
      }
    }
  }
  expect(everyTimer).toHaveLength(20);
  expect(controllerTimerSeen({ controller_timer_seen: everyTimer })).toEqual(everyTimer);
});

test('a write rendered against a home the customer has left is rejected, a clear included', () => {
  for (const timer of [X2, clearedControllerTimer()]) {
    const { rejected, left } = settle({ ...timer }, { fresh: false });
    expect(left).toEqual({});
    expect(rejected).toHaveLength(3);
    for (const r of rejected) expect(r.message).toBe('The home on this account changed. Reload, then set the sprinkler timer again.');
  }
});
