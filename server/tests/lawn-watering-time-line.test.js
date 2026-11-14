/**
 * The lawn watering-time line (owner 2026-11-14, decision 1A): one of two
 * fixed sentences chosen from the live restriction policy, or no line. The
 * exact words are owner-approved, so they are pinned here.
 */
const { wateringTimeLine, MIDNIGHT_LINE, MORNING_LINE, MORNING_LINE_ONE_DAY } = require('../services/lawn-watering-time-line');

const ORDER_HOURS = [{ start: '00:01', end: '04:00' }, { start: '20:00', end: '23:59' }];
const policy = (over = {}) => ({ maxDaysPerWeek: 1, allowedHours: ORDER_HOURS, noHourRestriction: false, ...over });

describe('wateringTimeLine: the approved words', () => {
  test('the sentences are exactly the owner-approved text', () => {
    expect(MIDNIGHT_LINE).toBe('On your watering day, use the midnight to 4 AM window, not the evening one. A lawn that stays wet all night gets more fungus.');
    expect(MORNING_LINE).toBe('On your watering days, water between 6 and 8 AM.');
    expect(MORNING_LINE_ONE_DAY).toBe('On your watering day, water between 6 and 8 AM.');
  });
});

describe('wateringTimeLine: the order\'s hours', () => {
  test('one day a week with the order\'s two windows gives the midnight sentence', () => {
    expect(wateringTimeLine(policy())).toBe(MIDNIGHT_LINE);
  });

  test('the overnight window may start at 00:00, and the evening window at 18:00 or later', () => {
    expect(wateringTimeLine(policy({ allowedHours: [{ start: '00:00', end: '04:00' }, { start: '18:00', end: '23:59' }] }))).toBe(MIDNIGHT_LINE);
    expect(wateringTimeLine(policy({ allowedHours: [{ start: '20:00', end: '23:59' }, { start: '00:01', end: '04:00' }] }))).toBe(MIDNIGHT_LINE);
  });

  test('more than one day a week never gets the midnight sentence', () => {
    expect(wateringTimeLine(policy({ maxDaysPerWeek: 2 }))).toBe('');
    expect(wateringTimeLine(policy({ maxDaysPerWeek: '2' }))).toBe('');
  });

  test('hours that are not the order\'s shape give no line', () => {
    const none = (allowedHours) => expect(wateringTimeLine(policy({ allowedHours }))).toBe('');
    none([{ start: '00:01', end: '04:00' }]); // no evening window
    none([{ start: '20:00', end: '23:59' }]); // no overnight window
    none([{ start: '00:01', end: '03:00' }, { start: '20:00', end: '23:59' }]); // overnight ends early
    none([{ start: '01:00', end: '04:00' }, { start: '20:00', end: '23:59' }]); // overnight starts late
    none([{ start: '00:01', end: '04:00' }, { start: '17:59', end: '23:59' }]); // evening starts before 18:00
    none([{ start: '00:01', end: '04:00' }, { start: '10:00', end: '11:00' }]); // a midday window, not the evening one
    none([{ start: '00:01', end: '04:00' }, { start: '20:00', end: '21:00' }, { start: '22:00', end: '23:59' }]); // three windows
    none([{ start: '00:01', end: '04:00' }, { start: '00:01', end: '04:00' }]); // two overnight windows
    none([]); // empty list
  });
});

describe('wateringTimeLine: a rule that permits 6 to 8 AM', () => {
  const MORNING_HOURS = [{ start: '05:00', end: '09:00' }, { start: '20:00', end: '23:59' }];

  test('a window covering 06:00 to 08:00 completely gives the 6 to 8 AM sentence', () => {
    expect(wateringTimeLine(policy({ maxDaysPerWeek: 2, allowedHours: MORNING_HOURS }))).toBe(MORNING_LINE);
    expect(wateringTimeLine(policy({ maxDaysPerWeek: 3, allowedHours: [{ start: '06:00', end: '08:00' }] }))).toBe(MORNING_LINE);
  });

  test('exactly one watering day uses the singular wording (grammar only)', () => {
    expect(wateringTimeLine(policy({ allowedHours: MORNING_HOURS }))).toBe(MORNING_LINE_ONE_DAY);
  });

  test('a window that covers only part of 06:00 to 08:00 does not count', () => {
    expect(wateringTimeLine(policy({ maxDaysPerWeek: 2, allowedHours: [{ start: '06:01', end: '10:00' }] }))).toBe('');
    expect(wateringTimeLine(policy({ maxDaysPerWeek: 2, allowedHours: [{ start: '04:00', end: '07:59' }] }))).toBe('');
    // Two windows that touch are not one covering window: the line stays quiet.
    expect(wateringTimeLine(policy({ maxDaysPerWeek: 2, allowedHours: [{ start: '05:00', end: '07:00' }, { start: '07:00', end: '09:00' }] }))).toBe('');
  });

  test('noHourRestriction true with no windows gives the 6 to 8 AM sentence', () => {
    expect(wateringTimeLine({ maxDaysPerWeek: 2, allowedHours: null, noHourRestriction: true })).toBe(MORNING_LINE);
    expect(wateringTimeLine({ maxDaysPerWeek: 1, noHourRestriction: true })).toBe(MORNING_LINE_ONE_DAY);
  });

  test('windows decide when both are present: noHourRestriction does not override the order\'s hours', () => {
    expect(wateringTimeLine(policy({ noHourRestriction: true }))).toBe(MIDNIGHT_LINE);
    expect(wateringTimeLine(policy({ noHourRestriction: true, maxDaysPerWeek: 2 }))).toBe('');
  });
});

describe('wateringTimeLine: no line', () => {
  test('no policy', () => {
    for (const none of [null, undefined, {}, 'x']) expect(wateringTimeLine(none)).toBe('');
  });

  test('no watering day allowed (zero, negative or not a number)', () => {
    expect(wateringTimeLine(policy({ maxDaysPerWeek: 0 }))).toBe('');
    expect(wateringTimeLine(policy({ maxDaysPerWeek: 0, allowedHours: null, noHourRestriction: true }))).toBe('');
    expect(wateringTimeLine(policy({ maxDaysPerWeek: -1 }))).toBe('');
    expect(wateringTimeLine(policy({ maxDaysPerWeek: 'x' }))).toBe('');
    expect(wateringTimeLine(policy({ maxDaysPerWeek: undefined }))).toBe('');
  });

  test('a policy that states hours in words only (no windows, no noHourRestriction) gives no line', () => {
    expect(wateringTimeLine({ maxDaysPerWeek: 1, allowedHours: null, noHourRestriction: false, hoursNote: 'on your assigned day' })).toBe('');
    expect(wateringTimeLine({ maxDaysPerWeek: 1 })).toBe('');
  });
});
