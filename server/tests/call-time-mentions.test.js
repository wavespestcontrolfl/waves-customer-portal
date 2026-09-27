// Day references in labelled call transcripts. Fixtures are fictitious.
const { parseDayMentions, extractHourMentions } = require('../services/call-time-mentions');

// Sat Sep 26, 2026, 11:51 AM ET.
const STARTED = new Date('2026-09-26T15:51:18Z');
const datesIn = (text) => parseDayMentions(text, STARTED).map((m) => [...m.candidates].sort());

describe('parseDayMentions', () => {
  test('today, tomorrow and the day after name one date; a month and day names it this year and next', () => {
    expect(datesIn('You are on October 2nd. Could it be tomorrow, or the day after tomorrow? Today is full.'))
      .toEqual([['2026-10-02', '2027-10-02'], ['2026-09-27'], ['2026-09-28'], ['2026-09-26']]);
  });

  test('a date written as numbers is a month and day, of its stated year only; a fraction of a unit is not a date', () => {
    expect(datesIn('Can we do 12/24 or 1/5/27?')).toEqual([['2026-12-24', '2027-12-24'], ['2027-01-05']]);
    expect(datesIn('December 24th, 2027 works.')).toEqual([['2027-12-24']]);
    expect(datesIn('It takes 1/2 hour.')).toEqual([]);
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

  test('a weekday or "next <weekday>" names this week\'s and next week\'s date; the call\'s own weekday can be today, "next" never', () => {
    expect(datesIn('Why not next Saturday, or Friday, or Saturday?')).toEqual([['2026-10-03', '2026-10-10'], ['2026-10-02', '2026-10-09'], ['2026-09-26', '2026-10-03']]);
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

  test('"this week" or "next week" beside a weekday picks that calendar week\'s date', () => {
    expect(datesIn('Thursday next week, next week Friday, Thursday of this week.')).toEqual([['2026-10-01'], ['2026-10-02'], []]);
  });

  test('mentions come back in spoken order with their token spans', () => {
    expect(parseDayMentions('not friday we will see you tomorrow', STARTED).map((m) => [m.kind, m.pos, m.end]))
      .toEqual([['weekday', 1, 2], ['tomorrow', 6, 7]]);
  });
});

describe('extractHourMentions', () => {
  const hours = (text) => extractHourMentions(text).map((m) => [m.hour24, m.offHour]);

  test('a number is a clock time only when something marks it as one', () => {
    expect(hours('Can we do Thursday at two? Two people will be home.')).toEqual([[14, false]]);
    expect(hours('Around 9 works. So does 3 pm. Four o clock. Noon.')).toEqual([[9, false], [15, false], [16, false], [12, false]]);
  });

  test('a bare hour reads as business hours whatever am/pm the call said elsewhere', () => {
    expect(hours('My 9 AM visit is too early, can we do Thursday at two?')).toEqual([[9, false], [14, false]]);
    expect(hours('At 7. At 12. At 6.')).toEqual([[7, false], [12, false], [18, false]]);
  });

  test('a part of the day in the sentence sets an hour\'s am/pm', () => {
    expect(hours('We will see you Thursday evening at eight. Tomorrow morning at 6. Morning or afternoon, at two?')).toEqual([[20, false], [6, false], [14, false]]);
  });

  test('a range counts its start, reading the end\'s am/pm across noon', () => {
    expect(hours('Two to four. Between eight and ten pm. 11 to 1 pm. 2 pm to 4 pm.')).toEqual([[14, false], [20, false], [11, false], [14, false]]);
  });

  test('minutes or a half/quarter lead-in put a time off the hour', () => {
    expect(hours('At two ten, 2:30, two oh five, half past two.').map(([, off]) => off)).toEqual([true, true, true, true]);
  });

  test('a bound, or an alternative after it, puts a time off the hour', () => {
    expect(hours('Before noon. By two. At two or later. Two or four. Three or so. Noon at the latest.'))
      .toEqual([[12, true], [14, true], [14, true], [14, true], [15, true], [12, true]]);
  });

  test('an hour mention spans its am/pm and o\'clock', () => {
    expect(extractHourMentions('We will see you at 2 pm sharp, or at two o clock.').map((m) => [m.pos, m.end])).toEqual([[5, 7], [10, 13]]);
  });

  test('a length of time is not a clock time', () => {
    expect(hours('It takes about two hours, about two and a half hours, three to four hours. The service should last for two.')).toEqual([]);
  });
});
