// Day references in labelled call transcripts. Fixtures are fictitious.
const { exactDatesNamed, parseDayMentions, monthsReferenced } = require('../services/call-time-mentions');

// Sat Sep 26, 2026, 11:51 AM ET.
const CALL_STARTED_AT = '2026-09-26T15:51:18Z';

describe('exactDatesNamed', () => {
  test('today, tomorrow and the day after name one date; a month and day names it this year and next', () => {
    const transcript = 'Agent: You are on October 2nd.\nCaller: Could it be tomorrow, or the day after tomorrow?\nAgent: Today is full.';
    expect([...exactDatesNamed({ transcript, callStartedAt: CALL_STARTED_AT })].sort())
      .toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-10-02', '2027-10-02']);
  });

  test('a date written as numbers is a month and day', () => {
    expect([...exactDatesNamed({ transcript: 'Caller: Can we do 12/24 or 1/5/27?\nAgent: Sure.', callStartedAt: CALL_STARTED_AT })].sort())
      .toEqual(['2026-01-05', '2026-12-24', '2027-01-05', '2027-12-24']);
  });

  test('a weekday names two dates, so it names none exactly', () => {
    expect(exactDatesNamed({ transcript: 'Caller: Why not next Saturday, or Friday?\nAgent: Sure.', callStartedAt: CALL_STARTED_AT }).size).toBe(0);
  });

  test('an unlabeled transcript or an unreadable call time names nothing', () => {
    expect(exactDatesNamed({ transcript: 'You are on October 2nd.', callStartedAt: CALL_STARTED_AT }).size).toBe(0);
    expect(exactDatesNamed({ transcript: 'Agent: October 2nd.', callStartedAt: 'nope' }).size).toBe(0);
  });
});

describe('parseDayMentions', () => {
  test('mentions come back in spoken order', () => {
    const kinds = parseDayMentions('not friday we will see you tomorrow', new Date(CALL_STARTED_AT)).map((m) => m.kind);
    expect(kinds).toEqual(['weekday', 'tomorrow']);
  });
});

describe('monthsReferenced', () => {
  test('only a month named without a day counts, for this year and next', () => {
    const months = monthsReferenced({ transcript: 'Caller: October 2nd is fine but my December visit is not.\nAgent: Okay.', callStartedAt: CALL_STARTED_AT });
    expect([...months].sort()).toEqual(['2026-12', '2027-12']);
  });
});
