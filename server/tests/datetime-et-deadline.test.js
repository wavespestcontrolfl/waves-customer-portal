const { parseQuotedETDeadline, parseQuotedETDay, expandWeekdayAbbreviations } = require('../utils/datetime-et');

describe('quoted Eastern deadlines', () => {
  const reference = new Date('2026-09-06T02:00:00Z'); // September 5 in ET
  test.each([
    ['September 10 at 3 PM', '2026-09-10T19:00:00.000Z'],
    ['by Sep 10, 2026 at 3:15 p.m.', '2026-09-10T19:15:00.000Z'],
    ['2026-09-10 at 15:00', '2026-09-10T19:00:00.000Z'],
    ['9/10 at 03:00', '2026-09-10T07:00:00.000Z'],
    ['9/10/2026 at 12am', '2026-09-10T04:00:00.000Z'],
    ['tomorrow at noon', '2026-09-06T16:00:00.000Z'],
    ['tomorrow at midnight', '2026-09-06T04:00:00.000Z'],
    ['September 10 at noon ET', '2026-09-10T16:00:00.000Z'],
    ['tomorrow at 9am', '2026-09-06T13:00:00.000Z'],
    ['Sunday at 10am ET', '2026-09-06T14:00:00.000Z'],
    ['today at 11pm', '2026-09-06T03:00:00.000Z'],
  ])('%s resolves against the message’s ET calendar', (text, expected) => {
    expect(parseQuotedETDeadline(text, reference)?.toISOString()).toBe(expected);
  });

  test.each([
    'tomorrow morning', 'noon', 'midnight', '3pm', 'September 10 at 3', 'September 10 at 13pm',
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

describe('quoted Eastern days with no clock (SMS staff-promise plan, owner ruling 2026-09-28)', () => {
  const saturday = new Date('2040-03-10T15:00:00Z'); // Saturday 10 AM EST; DST starts Sunday 2040-03-11
  const sunday = new Date('2040-03-11T15:00:00Z'); // Sunday 11 AM EDT

  test.each([
    ['today', '2040-03-10'], ['tonight', '2040-03-10'], ['this afternoon', '2040-03-10'], ['later today', '2040-03-10'],
    ['end of day', '2040-03-10'], ['EOD', '2040-03-10'],
    ['tomorrow', '2040-03-11'], ['tmrw', '2040-03-11'], ['tomorrow morning', '2040-03-11'], ['by tomorrow', '2040-03-11'],
    ['Wednesday', '2040-03-14'], ['this Wednesday', '2040-03-14'], ['on Wednesday', '2040-03-14'], ['to Wednesday', '2040-03-14'],
    ['Wednesday afternoon', '2040-03-14'], ['Saturday', '2040-03-10'],
    ['this weekend', '2040-03-11'], ['the weekend', '2040-03-11'], ['over the weekend', '2040-03-11'],
    ['next week', '2040-03-16'],
    ['March 24', '2040-03-24'], ['3/24', '2040-03-24'], ['2040-03-24', '2040-03-24'], ['Mar 24th.', '2040-03-24'],
    // Codex #5248 r2: weekday abbreviations, and "before" is exclusive.
    ['Wed', '2040-03-14'], ['wed.', '2040-03-14'], ['this Wed', '2040-03-14'], ['Wed afternoon', '2040-03-14'], ['Thurs', '2040-03-15'],
    ['tues', '2040-03-13'], ['Sun', '2040-03-11'], ['before Wednesday', '2040-03-13'], ['before tomorrow', '2040-03-10'], ['before Wed', '2040-03-13'],
  ])('%s resolves to %s', (text, expected) => {
    expect(parseQuotedETDay(text, saturday)).toBe(expected);
  });

  test('Codex #5248 r3: weekday abbreviations are spelled out for the clocked reader, which stays full-name only itself', () => {
    expect(expandWeekdayAbbreviations('Wed at 3pm')).toBe('wednesday at 3pm');
    expect(expandWeekdayAbbreviations('by Thurs. 5pm')).toBe('by thursday 5pm');
    expect(expandWeekdayAbbreviations('Sunday at noon')).toBe('Sunday at noon');
    expect(parseQuotedETDeadline('Wed at 3pm', saturday)).toBeNull();
    expect(parseQuotedETDeadline(expandWeekdayAbbreviations('Wed at 3pm'), saturday)?.toISOString()).toBe('2040-03-14T19:00:00.000Z');
  });

  test('Codex #5248 r3: a yearless date is its next occurrence; a past date with its year is not', () => {
    const december28 = new Date('2040-12-28T15:00:00Z');
    expect(parseQuotedETDay('Jan 2', december28)).toBe('2041-01-02');
    expect(parseQuotedETDay('1/2', december28)).toBe('2041-01-02');
    expect(parseQuotedETDay('3/9', saturday)).toBe('2041-03-09');
    expect(parseQuotedETDay('3/9/2040', saturday)).toBeNull();
  });

  test('on a Sunday the weekend is today and next week ends Friday five days out', () => {
    expect(parseQuotedETDay('this weekend', sunday)).toBe('2040-03-11');
    expect(parseQuotedETDay('next week', sunday)).toBe('2040-03-16');
  });

  test('Codex #5248 r4: "before" a span is the day before the span starts', () => {
    const thursday = new Date('2040-03-08T15:00:00Z');
    expect(parseQuotedETDay('before this weekend', thursday)).toBe('2040-03-09');
    expect(parseQuotedETDay('before the weekend', thursday)).toBe('2040-03-09');
    expect(parseQuotedETDay('before next week', thursday)).toBe('2040-03-11');
    expect(parseQuotedETDay('before next week', saturday)).toBe('2040-03-11');
    // Once the weekend has begun, the day before it has passed.
    expect(parseQuotedETDay('before the weekend', saturday)).toBeNull();
    expect(parseQuotedETDay('before this weekend', sunday)).toBeNull();
  });

  test.each(['next Wednesday', 'in two weeks', 'tomorrow at 3pm', 'soon', 'this week', '3/9/2040', 'February 30', 'Marchish 24', 'before today', '', null])(
    'cannot place %p on one day', (text) => {
      expect(parseQuotedETDay(text, saturday)).toBeNull();
    });
});
