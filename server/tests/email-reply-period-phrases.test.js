jest.mock('../services/email/email-reply-price-evidence', () => ({
  recognizeEmailReplyPriceEvidence: jest.fn(jest.requireActual('../services/email/email-reply-price-evidence').recognizeEmailReplyPriceEvidence),
}));
const { recognizeEmailReplyPriceEvidence: upstream } = require('../services/email/email-reply-price-evidence');
const { recognizeEmailReplyPeriodPhrases: recognize } = require('../services/email/email-reply-period-phrases');
const { matchEmailReplyPeriodAt: match, matchEmailReplyUnitAt: unit } = require('../services/email/email-reply-unit-lexer');
const periods = (text) => recognize(text).clauses.flatMap((clause) => clause.periodPhrases);

beforeEach(() => upstream.mockClear());

describe('inactive supplemental period phrases', () => {
  test.each([
    ['monthly', 'month'], ['yearly', 'year'], ['annual', 'year'], ['annually', 'year'],
    ['annualized', 'year'], ['per month', 'month'], ['per years', 'year'], ['/mos', 'month'],
    ['a month', 'month'], ['each month', 'month'], ['every year', 'year'],
    ['a mo', 'month'], ['each yr', 'year'], ['for the month', 'month'], ['for the year', 'year'],
  ])('retains the canonical cycle and original tokens for %s', (text, period) => {
    const result = recognize(text);
    const phrase = result.clauses[0].periodPhrases[0];
    expect(phrase).toMatchObject({ start: 0, text, period, embedded: false, offsets: null });
    expect(phrase.end).toBe(result.clauses[0].tokens.length);
    phrase.tokens.forEach((token, at) => expect(token).toBe(result.clauses[0].tokens[at]));
    expect(result.disposition).toBe('needs_review');
  });

  test.each(['The monthly visit plan costs $98.', 'Our monthly home service visit package is $98.',
    'The annual visit plan costs $1176.', 'Monthly visits cost $98 per application.'])(
    'retains a period embedded in a longer visit token: %s', (text) => {
      const clause = recognize(text).clauses[0];
      const phrase = clause.periodPhrases[0];
      expect(phrase.embedded).toBe(true);
      expect(phrase.tokens).toHaveLength(1);
      expect(phrase.tokens[0]).toBe(clause.tokens[phrase.start]);
      expect(phrase.tokens[0].text.slice(phrase.offsets.start, phrase.offsets.end)).toBe(phrase.text);
      expect(['visit', 'visits']).toContain(phrase.tokens[0].kind);
      // This metadata does not turn the visit into an amount unit or a plan verdict.
      expect(clause.tokens[phrase.start].kind).not.toBe('period');
    },
  );

  test.each(['a month ago', 'a year ago', 'a mo ago', 'a yr ago',
    'a month or two ago', 'a year and a half ago', 'each month or so ago',
    'every yearbook', 'monthly-related', 'annualized-policy', 'the month',
    'a, month', 'each @ month', 'for the; year', 'each monthlies'])(
    'leaves temporal or unsupported syntax unresolved: %s', (text) => {
      expect(periods(text)).toEqual([]);
    },
  );

  test.each(['$98/monthly visit', 'The $98/annual visit plan'])(
    'scans punctuation-prefixed embedded periods: %s', (text) => {
      const clause = recognize(text).clauses[0];
      const phrase = clause.periodPhrases.find((candidate) => candidate.embedded);
      expect(phrase).toBeDefined();
      expect(phrase.tokens[0].text.slice(phrase.offsets.start, phrase.offsets.end)).toBe(phrase.text);
      expect(['month', 'year']).toContain(phrase.period);
    },
  );

  test('does not rewrite the original scanner for determined periods', () => {
    expect(unit('a month')).toBeNull();
    expect(unit('annualized')).toBeNull();
    const result = recognize('a month; annualized');
    expect(result.clauses.map((clause) => clause.tokens.map((token) => token.kind))).toEqual([
      ['word', 'word'], ['word'],
    ]);
    expect(result.clauses.map((clause) => clause.periodPhrases[0].period)).toEqual(['month', 'year']);
  });

  test('keeps adjacent periods separate and all indices clause-local', () => {
    const result = recognize('each month every year; for the year monthly');
    expect(result.clauses.map((clause) => clause.periodPhrases.map((phrase) => [phrase.start, phrase.end, phrase.period])))
      .toEqual([[[0, 2, 'month'], [2, 4, 'year']], [[0, 3, 'year'], [3, 4, 'month']]]);
  });

  test('preserves every upstream field by identity with one call', () => {
    const result = recognize('The monthly visit plan costs $98.');
    expect(upstream).toHaveBeenCalledTimes(1);
    const before = upstream.mock.results[0].value;
    for (const [key, value] of Object.entries(before.clauses[0])) expect(result.clauses[0][key]).toBe(value);
    expect(result).not.toHaveProperty('violations');
  });
  test.each([{}, 'x'.repeat(8193), 'x '.repeat(513)])('forwards normalization failures by identity', (text) => {
    expect(recognize(text)).toBe(upstream.mock.results[0].value);
  });

  test.each(['a month', 'annualized', 'per year'])('anchors the canonical period matcher: %s', (text) => {
    expect(match(`xx ${text}`, 3)).toMatchObject({ kind: 'period', text, start: 3, end: text.length + 3 });
    expect(match(`xx${text}`, 2)).toBeNull();
    expect(match(`${text}é`)).toBeNull();
  });
  test.each([[null, 0], ['monthly', -1], ['monthly', 0.5], ['monthly', 99], ['x'.repeat(8193), 0]])(
    'retains matcher input bounds: %#', (source, at) => expect(match(source, at)).toBeNull(),
  );
});
