jest.mock('../services/email/email-reply-period-phrases', () => ({
  recognizeEmailReplyPeriodPhrases: jest.fn(jest.requireActual('../services/email/email-reply-period-phrases').recognizeEmailReplyPeriodPhrases),
}));
const { recognizeEmailReplyPeriodPhrases: upstream } = require('../services/email/email-reply-period-phrases');
const { recognizeEmailReplyPricingContext: recognize } = require('../services/email/email-reply-pricing-context');

beforeEach(() => upstream.mockClear());

describe('inactive typed pricing context', () => {
  test.each([
    ['plan', ['plan']], ['program', ['plan']], ['package', ['plan']],
    ['balance', ['account']], ['payment', ['account']], ['receipt', ['account']],
    ['received', ['account', 'account_event']], ['pay', ['account', 'account_event']],
    ['posted', ['account_event']], ['refunded', ['account_event']], ['credited', ['account_event']],
    ['reminder', ['activity']], ['service', ['activity']], ['treatments', ['activity']],
    ['reduced', ['adjustment']], ['saves', ['adjustment']], ['discount', ['adjustment']],
    ['percent', ['measurement']], ['miles', ['measurement']], ['%', ['measurement']],
  ])('retains %s as context rather than a conclusion', (text, roles) => {
    const result = recognize(text);
    expect(result.disposition).toBe('needs_review');
    expect(result.clauses[0].contextPhrases).toEqual([
      { start: 0, end: 1, text, token: result.clauses[0].tokens[0], roles },
    ]);
    expect(result).not.toHaveProperty('violations');
  });

  test.each([
    ['The plan visit is $98.', 'plan', ['plan']],
    ['Our monthly service visit is $98.', 'service', ['activity']],
  ])('preserves context roles inside composite unit tokens: %s', (text, word, roles) => {
    const clause = recognize(text).clauses[0];
    const embedded = clause.contextPhrases.find((phrase) => phrase.embedded);
    expect(embedded).toMatchObject({ text: word, roles, embedded: true });
    expect(embedded.token).toBe(clause.tokens[embedded.start]);
    expect(embedded.token.kind).not.toBe('word');
    expect(embedded.token.text.slice(embedded.offsets.start, embedded.offsets.end).toLowerCase()).toBe(word);
  });

  test('retains scanner stemming and ambiguous payment roles', () => {
    const result = recognize('We paid $98 monthly.');
    const context = result.clauses[0].contextPhrases[0];
    expect(context).toMatchObject({ text: 'pay', roles: ['account', 'account_event'] });
    expect(result.clauses[0].phrases.some((phrase) => phrase.type === 'predicate' && phrase.head === 'pay')).toBe(true);
    // The context marker does not suppress the independent typed pay predicate.
    expect(result.clauses[0].periodPhrases[0].period).toBe('month');
  });

  test('keeps adjustment words and nearby amounts unpaired', () => {
    const clause = recognize('The monthly price was reduced by $10.').clauses[0];
    expect(clause.contextPhrases.map((phrase) => phrase.text)).toEqual(['reduced']);
    expect(clause.amountRelations[0].amount.text).toBe('$10');
    expect(clause.contextPhrases[0]).not.toHaveProperty('amount');
  });

  test('preserves all prior evidence and token identities', () => {
    const result = recognize('Your monthly payment posted after the discount.');
    expect(upstream).toHaveBeenCalledTimes(1);
    const prior = upstream.mock.results[0].value;
    for (const [key, value] of Object.entries(prior.clauses[0])) expect(result.clauses[0][key]).toBe(value);
    for (const phrase of result.clauses[0].contextPhrases) expect(phrase.token).toBe(result.clauses[0].tokens[phrase.start]);
    const again = recognize('payment');
    result.clauses[0].contextPhrases[0].roles.push('caller mutation');
    expect(again.clauses[0].contextPhrases[0].roles).toEqual(['account']);
  });

  test('resets spans at scanner clause boundaries and keeps unknown words', () => {
    const result = recognize('plan; refund; unknown');
    expect(result.clauses.map((clause) => clause.contextPhrases.map((phrase) => phrase.start))).toEqual([[0], [0], []]);
    expect(result.clauses[2].tokens[0].text).toBe('unknown');
  });
  test.each([{}, 'x'.repeat(8193), 'x '.repeat(513)])('forwards failures by identity', (text) => {
    expect(recognize(text)).toBe(upstream.mock.results[0].value);
  });
});
