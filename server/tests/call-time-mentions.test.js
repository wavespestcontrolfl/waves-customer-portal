// Day references in labelled call transcripts. Fixtures are fictitious.
const { parseDayMentions } = require('../services/call-time-mentions');

// Sat Sep 26, 2026, 11:51 AM ET.
const STARTED = new Date('2026-09-26T15:51:18Z');
const datesIn = (text) => parseDayMentions(text, STARTED).map((m) => [...m.candidates].sort());

describe('parseDayMentions', () => {
  test('today, tomorrow and the day after name one date; a month and day names it this year and next', () => {
    expect(datesIn('You are on October 2nd. Could it be tomorrow, or the day after tomorrow? Today is full.'))
      .toEqual([['2026-10-02', '2027-10-02'], ['2026-09-27'], ['2026-09-28'], ['2026-09-26']]);
  });

  test('a date written as numbers is a month and day', () => {
    expect(datesIn('Can we do 12/24 or 1/5/27?')).toEqual([['2026-12-24', '2027-12-24'], ['2026-01-05', '2027-01-05']]);
  });

  test('an abbreviated month with a day is a month and day; a word that only starts like one is not', () => {
    expect(datesIn('Move my Dec. 24 visit, or Sept 3.')).toEqual([['2026-12-24', '2027-12-24'], ['2026-09-03', '2027-09-03']]);
    expect(datesIn('Let me decide 24 hours from now.')).toEqual([]);
  });

  // An ordinary word that happens to be an Object.prototype key must not
  // read as a relative day (it used to throw an invalid-date RangeError).
  test('a word like "constructor" is not a day', () => {
    expect(datesIn('The constructor is here today.')).toEqual([['2026-09-26']]);
  });

  test('a weekday or "next <weekday>" names this week\'s and next week\'s date', () => {
    expect(datesIn('Why not next Saturday, or Friday?')).toEqual([['2026-10-03', '2026-10-10'], ['2026-10-02', '2026-10-09']]);
  });

  test('"the 8th" names this month\'s or next month\'s; with its month it is a month and day', () => {
    expect(datesIn('How about the 30th, or the 8th?')).toEqual([['2026-09-30', '2026-10-30'], ['2026-10-08', '2026-11-08']]);
    expect(datesIn('The 8th of October, or October the 9th, or 10th of October.'))
      .toEqual([['2026-10-08', '2027-10-08'], ['2026-10-09', '2027-10-09'], ['2026-10-10', '2027-10-10']]);
    expect(datesIn('That was the 8 of them.')).toEqual([]);
  });

  test('a weekday mention carries its weekday', () => {
    expect(parseDayMentions('next Thursday or Monday', STARTED).map((m) => m.weekday)).toEqual([4, 1]);
  });

  test('mentions come back in spoken order with their token spans', () => {
    expect(parseDayMentions('not friday we will see you tomorrow', STARTED).map((m) => [m.kind, m.pos, m.end]))
      .toEqual([['weekday', 1, 2], ['tomorrow', 6, 7]]);
  });
});
