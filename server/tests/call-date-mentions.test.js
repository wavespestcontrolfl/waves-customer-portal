// Day references in labelled call transcripts. Fixtures are fictitious.
const { exactDatesNamed, parseDayMentions } = require('../services/call-date-mentions');

// Sat Sep 26, 2026, 11:51 AM ET.
const CALL_STARTED_AT = '2026-09-26T15:51:18Z';

describe('exactDatesNamed', () => {
  test('a month and day, today, tomorrow and the day after name one date each', () => {
    const transcript = 'Agent: You are on October 2nd.\nCaller: Could it be tomorrow, or the day after tomorrow?\nAgent: Today is full.';
    expect([...exactDatesNamed({ transcript, callStartedAt: CALL_STARTED_AT })].sort())
      .toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-10-02']);
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
    const kinds = parseDayMentions('not friday we will see you tomorrow', '2026-09-26', 6).map((m) => m.kind);
    expect(kinds).toEqual(['weekday', 'tomorrow']);
  });
});
