// Day and hour references in labelled call transcripts. Fixtures are fictitious.
const { exactDatesNamed, parseDayMentions, monthsReferenced, extractHourMentionsWholeCall, wholeCallPeriodFlags } = require('../services/call-time-mentions');

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

describe('monthsReferenced', () => {
  test('only a month named without a day counts, for this year and next', () => {
    const months = monthsReferenced({ transcript: 'Caller: October 2nd is fine but my December visit is not.\nAgent: Okay.', callStartedAt: CALL_STARTED_AT });
    expect([...months].sort()).toEqual(['2026-12', '2027-12']);
  });
});

describe('extractHourMentionsWholeCall', () => {
  test('"9 a.m." survives the sentence splitter, and minutes mark a time off the hour', () => {
    const lines = ['You are on at 9 a.m.', 'Could it be 2:30 p.m. instead?', 'We will do noon.'];
    const flags = wholeCallPeriodFlags(lines);
    const hours = lines.flatMap((line) => extractHourMentionsWholeCall(line, flags));
    expect(hours.map((h) => [h.hour24, h.offHour === true])).toEqual([[9, false], [14, true], [12, false]]);
  });
});
