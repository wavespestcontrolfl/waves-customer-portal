// Misting card next mist (GATE_MOSQUITO_MISTING): the earliest resolved instant wins, so the
// spring-forward day's missing hour never hides an earlier mist, today or tomorrow.
const { nextMistInstant } = require('../services/misting-portal');

describe('misting card next mist', () => {
  test('spring forward (Sun Mar 14, 2027 ET): 03:00 EDT comes before 02:30, which resolves to 03:30', () => {
    const now = new Date('2027-03-14T06:45:00Z'); // 01:45 EST
    expect(nextMistInstant(['02:30', '03:00'], now).toISOString()).toBe('2027-03-14T07:00:00.000Z');
  });

  test('the same rule picks tomorrow\'s first mist', () => {
    const now = new Date('2027-03-13T23:00:00Z'); // Sat 6:00 PM EST, both of today's times passed
    expect(nextMistInstant(['02:30', '03:00'], now).toISOString()).toBe('2027-03-14T07:00:00.000Z');
  });

  test('an ordinary day: the next later time today, else tomorrow\'s first', () => {
    const now = new Date('2026-10-30T20:00:00Z'); // 4:00 PM EDT
    expect(nextMistInstant(['06:30', '19:30', '22:30'], now).toISOString()).toBe('2026-10-30T23:30:00.000Z');
    expect(nextMistInstant(['06:30'], now).toISOString()).toBe('2026-10-31T10:30:00.000Z');
    expect(nextMistInstant([], now)).toBeNull();
  });
});
