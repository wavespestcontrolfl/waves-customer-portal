const { parseQuotedETDeadline } = require('../utils/datetime-et');

describe('quoted Eastern deadlines', () => {
  const reference = new Date('2026-09-06T02:00:00Z'); // September 5 in ET
  test.each([
    ['September 10 at 3 PM', '2026-09-10T19:00:00.000Z'],
    ['by Sep 10, 2026 at 3:15 p.m.', '2026-09-10T19:15:00.000Z'],
    ['2026-09-10 at 15:00', '2026-09-10T19:00:00.000Z'],
    ['9/10 at 03:00', '2026-09-10T07:00:00.000Z'],
    ['9/10/2026 at 12am', '2026-09-10T04:00:00.000Z'],
    ['tomorrow at 9am', '2026-09-06T13:00:00.000Z'],
    ['Sunday at 10am ET', '2026-09-06T14:00:00.000Z'],
    ['today at 11pm', '2026-09-06T03:00:00.000Z'],
  ])('%s resolves against the message’s ET calendar', (text, expected) => {
    expect(parseQuotedETDeadline(text, reference)?.toISOString()).toBe(expected);
  });

  test.each([
    'tomorrow morning', '3pm', 'September 10 at 3', 'September 10 at 13pm',
    'September 10 at 15:70', 'September 31 at 3pm', 'February 29 at 3pm',
    'August 10 at 3pm', 'next Sunday at 10am', 'September 10 at 3pm Pacific',
    'September 10 or September 11 at 3pm', 'tomorrow at 9am or 10am',
  ])('%s remains unverified instead of guessing', (text) => {
    expect(parseQuotedETDeadline(text, reference)).toBeNull();
  });

  test('resolves tomorrow across the ET year boundary', () => {
    expect(parseQuotedETDeadline('tomorrow at 9am', new Date('2027-01-01T02:00:00Z'))?.toISOString())
      .toBe('2027-01-01T14:00:00.000Z');
  });
  test('uses the target date’s offset across a DST change', () => {
    expect(parseQuotedETDeadline('tomorrow at 9am', new Date('2026-03-07T15:00:00Z'))?.toISOString())
      .toBe('2026-03-08T13:00:00.000Z');
  });
  test.each([
    ['2026-03-08 at 2:30am', '2026-03-07T15:00:00Z'],
    ['2026-11-01 at 1:30am', '2026-10-31T15:00:00Z'],
  ])('rejects a nonexistent or repeated ET clock: %s', (text, at) => {
    expect(parseQuotedETDeadline(text, new Date(at))).toBeNull();
  });
});
