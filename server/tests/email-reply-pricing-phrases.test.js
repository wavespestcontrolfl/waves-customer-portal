jest.mock('../services/email/email-reply-pricing-clauses', () => {
  const actual = jest.requireActual('../services/email/email-reply-pricing-clauses');
  return { recognizeEmailReplyPricingClauses: jest.fn(actual.recognizeEmailReplyPricingClauses) };
});
const { recognizeEmailReplyPricingClauses: scan } = require('../services/email/email-reply-pricing-clauses');
const { recognizeEmailReplyPricingPhrases: recognize } = require('../services/email/email-reply-pricing-phrases');
const phrases = (text, type) => recognize(text).clauses.flatMap((clause) => clause.phrases)
  .filter((phrase) => phrase.type === type);

describe('inactive bounded pricing phrase candidates', () => {
  beforeEach(() => scan.mockClear());

  test('scans once and preserves all original tokens without authorizing policy', () => {
    const text = 'We charge $98 per application, not @ $98 per visit; 98 minutes at the next visit';
    const result = recognize(text);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(text);
    expect(result).toMatchObject({ ok: true, disposition: 'needs_review' });
    expect(result.clauses.map((clause) => clause.tokens)).toEqual(scan.mock.results[0].value.clauses);
    expect(result.clauses[0].tokens.map((token) => token.kind)).toEqual([
      'word', 'word', 'money', 'application', 'sep', 'word', 'barrier', 'money', 'unit',
    ]);
    expect(result.clauses[1].tokens.map((token) => token.kind)).toEqual(['measurement', 'timing']);
  });

  test.each(['only', 'just', 'about', 'up to', 'at least', 'at most', 'as low as',
    'as high as', 'no more than', 'no less than', 'not more than', 'not less than',
    'less than', 'more than', 'approximately', 'around', 'roughly', 'exactly', 'under', 'over'])
  ('uses the longest qualifier token span: %s', (text) => {
    expect(phrases(`We ${text} charge $98`, 'qualifier')).toEqual([
      { type: 'qualifier', start: 1, end: 1 + text.split(' ').length, text },
    ]);
  });

  test.each([
    ['You pay', 'you', 1], ['The customers pay', 'the customers', 2],
    ['Our client pays', 'our client', 2], ['Your account has a fee', 'your account', 2],
    ['Clients pay', 'clients', 1], ['Her customer pays', 'her customer', 2],
  ])('recognizes a complete participant candidate: %s', (text, participant, end) => {
    expect(phrases(text, 'participant')).toEqual([
      { type: 'participant', start: 0, end, text: participant },
    ]);
  });

  test.each([
    ['Bills', 'bill', ['noun', 'action']], ['charges', 'charge', ['noun', 'action']],
    ['invoices', 'invoice', ['noun', 'action']], ['prices', 'price', ['noun', 'action']],
    ['costs', 'cost', ['noun', 'action']], ['fees', 'fee', ['noun']],
    ['payment', 'payment', ['noun']], ['dues', 'dues', ['noun']],
    ['subscription', 'subscription', ['noun']], ['spread', 'spread', ['noun']],
    ['surcharge', 'surcharge', ['noun']], ['pay', 'pay', ['action']],
  ])('preserves head role ambiguity: %s', (text, head, roles) => {
    expect(phrases(text, 'billing_head')).toEqual([
      { type: 'billing_head', start: 0, end: 1, text: head, head, roles },
    ]);
  });

  test('retains the noun amount independently of the longer action candidate', () => {
    expect(phrases('The amount to pay is $98', 'billing_head')).toEqual([
      { type: 'billing_head', start: 1, end: 3, text: 'amount to', head: 'amount to', roles: ['action'] },
      { type: 'billing_head', start: 1, end: 2, text: 'amount', head: 'amount', roles: ['noun'] },
      { type: 'billing_head', start: 3, end: 4, text: 'pay', head: 'pay', roles: ['action'] },
    ]);
    expect(phrases('It will amount to $98', 'billing_head')).toEqual([
      { type: 'billing_head', start: 2, end: 4, text: 'amount to', head: 'amount to', roles: ['action'] },
      { type: 'billing_head', start: 2, end: 3, text: 'amount', head: 'amount', roles: ['noun'] },
    ]);
  });

  test.each([
    ['Customers are not only billed', 1, 4, 5, 'bill', true, ['are', 'not', 'only']],
    ['We will just charge', 1, 3, 4, 'charge', false, ['will', 'just']],
    ['Visits would be separately billed', 1, 3, 4, 'bill', false, ['would be', 'separately']],
    ['Each visit has been invoiced', 1, 2, 3, 'invoice', false, ['has been']],
    ['Each visit has not been billed', 1, 4, 5, 'bill', true, ['has', 'not', 'been']],
    ['Visits do not individually incur', 1, 4, 5, 'incur', true, ['do', 'not', 'individually']],
    ['Each visit does never generate', 1, 3, 4, 'generate', true, ['does', 'never']],
    ['We did not pay', 1, 3, 4, 'pay', true, ['did', 'not']],
    ['We have only paid', 1, 3, 4, 'pay', false, ['has', 'only']],
    ['Each visit may incur', 1, 2, 3, 'incur', false, ['may']],
    ['Visits are due', 1, 2, 3, 'due', false, ['are']],
    ['Payment is required', 1, 2, 3, 'required', false, ['is']],
    ['Payment is payable', 1, 2, 3, 'payable', false, ['is']],
    ['It comes to $98', 1, 1, 3, 'come to', false, []],
    ['It will amount to $98', 1, 2, 4, 'amount to', false, ['will']],
    ['It totals $98', 1, 1, 2, 'totals', false, []],
    ['It equals $98', 1, 1, 2, 'equals', false, []],
  ])('retains exact predicate and polarity evidence: %s', (text, start, headStart, end, head, negated, prefix) => {
    expect(phrases(text, 'predicate')).toEqual([expect.objectContaining({
      start, end, head, headStart, headEnd: end, negated,
      prefix: prefix.map((word, offset) => ({ start: start + offset, end: start + offset + 1, text: word })),
    })]);
  });

  test.each(['no more than', 'no less than', 'not more than', 'not less than'])
  ('comparative control is not predicate negation: %s', (qualifier) => {
    expect(phrases(`We will ${qualifier} charge`, 'predicate')).toEqual([
      expect.objectContaining({ start: 1, head: 'charge', negated: false }),
    ]);
    expect(phrases(`We will not ${qualifier} charge`, 'predicate')[0].negated).toBe(true);
  });

  test('has may be a head or a perfect auxiliary without consuming the object', () => {
    expect(phrases('Your account has a fee', 'predicate')).toEqual([
      expect.objectContaining({ start: 2, end: 3, head: 'has', prefix: [] }),
    ]);
    expect(phrases('We have been billed', 'predicate')).toEqual([
      expect.objectContaining({ start: 1, end: 3, head: 'bill', prefix: [
        { start: 1, end: 2, text: 'have been' },
      ] }),
    ]);
  });

  test('allows overlapping head, qualifier and predicate candidates', () => {
    expect(recognize('We will only charge').clauses[0].phrases).toEqual([
      { type: 'participant', start: 0, end: 1, text: 'we' },
      { type: 'predicate', start: 1, end: 4, text: 'will only charge', head: 'charge',
        headStart: 3, headEnd: 4, negated: false, prefix: [
          { start: 1, end: 2, text: 'will' }, { start: 2, end: 3, text: 'only' },
        ] },
      { type: 'qualifier', start: 2, end: 3, text: 'only' },
      { type: 'billing_head', start: 3, end: 4, text: 'charge', head: 'charge', roles: ['noun', 'action'] },
    ]);
  });

  test.each([',', '@', 'per visit', '$98', '98', '98 minutes', 'at the next visit', 'per application', 'mystery'])
  ('does not chain a predicate through %s', (boundary) => {
    expect(phrases(`We will not ${boundary} charge`, 'predicate')).toEqual([
      expect.objectContaining({ head: 'charge', negated: false, prefix: [] }),
    ]);
  });

  test('resets spans and polarity at clause boundaries', () => {
    const result = recognize('We will not; charge. You pay');
    expect(result.clauses[0].phrases.some((phrase) => phrase.type === 'predicate')).toBe(false);
    expect(result.clauses[1].phrases).toContainEqual(expect.objectContaining({
      type: 'predicate', start: 0, end: 1, negated: false,
    }));
    expect(result.clauses[2].phrases).toContainEqual({ type: 'participant', start: 0, end: 1, text: 'you' });
  });

  test.each(['Please rate each visit', 'We will arrange the next visit',
    'We send one reminder per visit', 'Each visit lasts 98 minutes',
    'Your $98 payment is pending', 'We received $98 at today’s visit',
    'Every visit is free', 'The sky is blue', 'constructor @ mystery'])
  ('leaves feedback, operations, history and unrecognized claims for review: %s', (text) => {
    const result = recognize(text);
    expect(result.disposition).toBe('needs_review');
    expect(result.clauses.map((clause) => clause.tokens)).toEqual(scan.mock.results.at(-1).value.clauses);
  });

  test('bounds prefixes at twelve scanner tokens, retaining the supported suffix', () => {
    const predicate = phrases(`${'not '.repeat(13)}charge`, 'predicate');
    expect(predicate).toEqual([expect.objectContaining({ start: 1, end: 14, headStart: 13, negated: true })]);
    expect(predicate[0].prefix).toHaveLength(12);
    expect(phrases(`${'will be '.repeat(12)}charge`, 'predicate')[0].start).toBe(0);
  });

  test.each([null, {}, 'a'.repeat(8193), 'a '.repeat(513),
    '*_'.repeat(40) + '$98 per visit' + '_*'.repeat(40)])
  ('forwards the bounded scanner failure without a disposition: %#', (text) => {
    const result = recognize(text);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(result).toEqual(scan.mock.results[0].value);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('disposition');
  });

  test('accepts empty input while keeping the review disposition', () => {
    expect(recognize()).toEqual({ ok: true, disposition: 'needs_review', clauses: [] });
  });
});
