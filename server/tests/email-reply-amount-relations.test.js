jest.mock('../services/email/email-reply-pricing-phrases', () => {
  const actual = jest.requireActual('../services/email/email-reply-pricing-phrases');
  return { recognizeEmailReplyPricingPhrases: jest.fn(actual.recognizeEmailReplyPricingPhrases) };
});
const { recognizeEmailReplyPricingPhrases: phrases } = require('../services/email/email-reply-pricing-phrases');
const { recognizeEmailReplyAmountRelations: recognize } = require('../services/email/email-reply-amount-relations');
const records = (text) => recognize(text).clauses.flatMap((clause) => clause.amountRelations);
const span = (start, end, text) => ({ start, end, text });
const qualifier = (start, end, text) => ({ type: 'qualifier', ...span(start, end, text) });
const noun = (start, text, roles = ['noun']) => ({
  type: 'billing_head', ...span(start, start + 1, text), head: text, roles,
});
const predicate = (start, text) => ({
  type: 'predicate', ...span(start, start + 1, text), head: text,
  headStart: start, headEnd: start + 1, negated: false, priceCue: true, prefix: [],
});
const candidate = (relation, start, end, anchor, connector = null, q = null) => ({
  relation, start, end, anchor, connector, qualifier: q,
});
const amount = (start, text = '$98', kind = 'money') => ({ start, end: start + 1, kind, text });

describe('inactive bounded amount relation candidates', () => {
  beforeEach(() => phrases.mockClear());

  test.each(['costs$98', 'costs $98'])('keeps immediate noun and predicate alternatives: %s', (text) => {
    expect(records(text)).toEqual([{ amount: amount(1), candidates: [
      candidate('head_amount', 0, 2, noun(0, 'cost', ['noun', 'action'])),
      candidate('predicate_amount', 0, 2, predicate(0, 'cost')),
    ] }]);
  });

  test('recognizes a bare number without interpreting it as currency', () => {
    expect(records('costs 98')).toEqual([{ amount: amount(1, '98', 'number'), candidates: [
      candidate('head_amount', 0, 2, noun(0, 'cost', ['noun', 'action'])),
      candidate('predicate_amount', 0, 2, predicate(0, 'cost')),
    ] }]);
    expect(records('98 customers')).toEqual([{ amount: amount(0, '98', 'number'), candidates: [] }]);
  });

  test('retains the entire qualifier and connector evidence', () => {
    const q = qualifier(1, 3, 'up to');
    expect(records('costs up to $98')).toEqual([{ amount: amount(3), candidates: [
      candidate('head_amount', 0, 4, noun(0, 'cost', ['noun', 'action']), span(1, 3, 'up to'), q),
      candidate('predicate_amount', 0, 4, predicate(0, 'cost'), span(1, 3, 'up to'), q),
    ] }]);
  });

  test('bridges one participant and optionally one qualifier after a predicate', () => {
    expect(records('pay you $98')).toEqual([{ amount: amount(2), candidates: [
      candidate('predicate_amount', 0, 3, predicate(0, 'pay'), span(1, 2, 'you')),
    ] }]);
    expect(records('pay the customer about $98')).toEqual([{ amount: amount(4), candidates: [
      candidate('predicate_amount', 0, 5, predicate(0, 'pay'), span(1, 4, 'the customer about'),
        qualifier(3, 4, 'about')),
    ] }]);
  });

  test('links only the adjacent head in a compound-looking invoice label', () => {
    expect(records('invoice total is $98')).toEqual([{ amount: amount(3), candidates: [
      candidate('head_amount', 1, 4, noun(1, 'total', ['noun', 'action']), span(2, 3, 'is')),
    ] }]);
  });

  test.each([
    ['$98 is the price', 3, 4, span(1, 3, 'is the'), 'price', ['noun', 'action']],
    ['$98 fee', 1, 2, null, 'fee', ['noun']],
    ['an $98 fee', 2, 3, null, 'fee', ['noun']],
    ['$98 a fee', 2, 3, span(1, 2, 'a'), 'fee', ['noun']],
    ['$98 is an invoice', 3, 4, span(1, 3, 'is an'), 'invoice', ['noun', 'action']],
  ])('links amount to a noun head with exact local spans: %s', (text, headStart, end, connector, head, roles) => {
    const amountStart = text.startsWith('an ') ? 1 : 0;
    expect(records(text)).toEqual([{ amount: amount(amountStart), candidates: [
      candidate('amount_head', amountStart, end, noun(headStart, head, roles), connector),
    ] }]);
  });

  test('keeps a scanner range token intact without splitting or arithmetic', () => {
    const result = recognize('costs 90 to 120');
    const token = result.clauses[0].tokens[1];
    expect(token).toEqual({ kind: 'number', text: '90 to 120' });
    expect(result.clauses[0].amountRelations).toEqual([{ amount: amount(1, token.text, token.kind), candidates: [
      candidate('head_amount', 0, 2, noun(0, 'cost', ['noun', 'action'])),
      candidate('predicate_amount', 0, 2, predicate(0, 'cost')),
    ] }]);
    expect(records('costs from 90 to 120')).toEqual([{ amount: amount(2, '90 to 120', 'number'), candidates: [
      candidate('head_amount', 0, 3, noun(0, 'cost', ['noun', 'action']), span(1, 2, 'from')),
      candidate('predicate_amount', 0, 3, predicate(0, 'cost'), span(1, 2, 'from')),
    ] }]);
  });

  test('keeps distinct noun spans and the amount-to predicate independently', () => {
    const result = recognize('$98 amount to $120');
    const clause = result.clauses[0];
    expect(clause.amountRelations[0]).toEqual({ amount: amount(0), candidates: [
      candidate('amount_head', 0, 2, noun(1, 'amount')),
    ] });
    expect(clause.amountRelations[1].amount).toEqual(amount(3, '$120'));
    expect(clause.amountRelations[1].candidates).toEqual([
      candidate('predicate_amount', 1, 4, {
        type: 'predicate', start: 1, end: 3, text: 'amount to', head: 'amount to',
        headStart: 1, headEnd: 3, negated: false, priceCue: true, prefix: [],
      }),
    ]);
    expect(clause.phrases.filter((p) => p.type === 'billing_head' && p.start === 1)).toHaveLength(2);
  });

  test.each(['not', 'never'])('retains copula negation as evidence: %s', (negation) => {
    expect(records(`fee is ${negation} about $98`)).toEqual([{ amount: amount(4), candidates: [
      candidate('head_amount', 0, 5, noun(0, 'fee'), span(1, 4, `is ${negation} about`),
        qualifier(3, 4, 'about')),
    ] }]);
    expect(records(`$98 is ${negation} the fee`)).toEqual([{ amount: amount(0), candidates: [
      candidate('amount_head', 0, 5, noun(4, 'fee'), span(1, 4, `is ${negation} the`)),
    ] }]);
  });

  test.each(['only', 'just', 'about', 'up to', 'at least', 'at most', 'as low as',
    'as high as', 'no more than', 'no less than', 'not more than', 'not less than',
    'less than', 'more than', 'approximately', 'around', 'roughly', 'exactly',
    'nearly', 'almost', 'under', 'over'])('preserves the original longest qualifier: %s', (text) => {
    const end = 2 + text.split(' ').length;
    expect(records(`fee is ${text} $98`)).toEqual([{ amount: amount(end), candidates: [
      candidate('head_amount', 0, end + 1, noun(0, 'fee'), span(1, end, `is ${text}`),
        qualifier(2, end, text)),
    ] }]);
  });

  test('retains negated predicate prefixes on the original anchor', () => {
    const result = recognize('we will not charge $98');
    const anchor = result.clauses[0].phrases.find((p) => p.type === 'predicate');
    expect(anchor).toMatchObject({ start: 1, end: 4, text: 'will not charge', negated: true });
    expect(result.clauses[0].amountRelations[0].candidates).toContainEqual(
      candidate('predicate_amount', 1, 5, anchor));
  });

  test.each(['per visit: $98', 'received $98', 'refunded $98', 'pay you a visit $98',
    'pay per visit $98', 'pay at the next visit $98', 'pay 98 minutes $98',
    'fee mystery $98', 'fee not $98', 'fee is not never $98', 'fee is been $98',
    'fee about only $98', 'pay you them $98', 'pay about you $98',
    '$98 is the new fee', '$98 is the the fee', '$98 is about fee',
    '$98 not fee', '$98 is not never fee', '$98 pay'])
  ('leaves unsupported relations unresolved: %s', (text) => {
    const result = records(text);
    expect(result).toHaveLength(1);
    expect(result[0].candidates).toEqual([]);
  });

  test.each([':', '-'])('permits a single nominal connector %s only before the amount', (connector) => {
    expect(records(`fee ${connector} $98`)[0].candidates).toEqual([
      candidate('head_amount', 0, 3, noun(0, 'fee'), span(1, 2, connector)),
    ]);
    expect(records(`$98 ${connector} fee`)[0].candidates).toEqual([]);
  });

  test.each([',', '(', ')', '@', '/', 'per visit', 'per application',
    '98 minutes', 'at the next visit', 'mystery'])('does not cross %s', (boundary) => {
    expect(records(`fee ${boundary} $98`).at(-1).candidates).toEqual([]);
    expect(records(`$98 ${boundary} fee`)[0].candidates).toEqual([]);
  });

  test.each(['.', ';', '!', '?'])('resets amount and candidate spans across %s', (boundary) => {
    const result = recognize(`fee ${boundary} $98 ${boundary} costs $120`);
    expect(result.clauses[0].amountRelations).toEqual([]);
    expect(result.clauses[1].amountRelations).toEqual([{ amount: amount(0), candidates: [] }]);
    expect(result.clauses[2].amountRelations[0].amount).toEqual(amount(1, '$120'));
    expect(result.clauses[2].amountRelations[0].candidates.map((c) => [c.start, c.end])).toEqual([[0, 2], [0, 2]]);
  });

  test('creates exactly one record per amount, excludes measurements and does not cross amounts', () => {
    expect(records('fee $98 $120; 98 minutes; 90 to 120; $98 per visit')).toEqual([
      { amount: amount(1), candidates: [candidate('head_amount', 0, 2, noun(0, 'fee'))] },
      { amount: amount(2, '$120'), candidates: [] },
      { amount: amount(0, '90 to 120', 'number'), candidates: [] },
      { amount: amount(0), candidates: [] },
    ]);
  });

  test.each(['costs98', 'costsupto$98', 'payyou$98', '$98is theprice', 'an$98fee'])
  ('does not reinterpret unsupported compact scanner syntax: %s', (text) => {
    expect(records(text).every((record) => record.candidates.length === 0)).toBe(true);
  });

  test('calls phrases once and preserves tokens, phrases and anchor/qualifier identity without mutation', () => {
    const original = jest.requireActual('../services/email/email-reply-pricing-phrases')
      .recognizeEmailReplyPricingPhrases('pay you about $98; $120 fee');
    const snapshot = JSON.parse(JSON.stringify(original));
    const freeze = (value) => {
      Object.values(value).forEach((child) => { if (child && typeof child === 'object') freeze(child); });
      return Object.freeze(value);
    };
    phrases.mockReturnValueOnce(freeze(original));
    const result = recognize('fixture');
    expect(phrases).toHaveBeenCalledTimes(1);
    expect(phrases).toHaveBeenCalledWith('fixture');
    expect(result).toMatchObject({ ok: true, disposition: 'needs_review' });
    result.clauses.forEach((clause, i) => {
      expect(clause.tokens).toBe(original.clauses[i].tokens);
      expect(clause.phrases).toBe(original.clauses[i].phrases);
      clause.amountRelations.flatMap((record) => record.candidates).forEach((c) => {
        expect(clause.phrases).toContain(c.anchor);
        expect(clause.phrases.some((p) => p === c.anchor)).toBe(true);
        if (c.qualifier) expect(clause.phrases.some((p) => p === c.qualifier)).toBe(true);
      });
    });
    expect(original).toEqual(snapshot);
    result.clauses[0].amountRelations[0].candidates.push('caller mutation');
    expect(result.clauses[1].amountRelations[0].candidates).toHaveLength(1);
    expect(records('pay you about $98')[0].candidates).toHaveLength(1);
  });

  test.each([null, {}, 'a'.repeat(8193), 'a '.repeat(513),
    '*_'.repeat(40) + '$98 per visit' + '_*'.repeat(40)])
  ('propagates each bounded upstream failure unchanged: %#', (text) => {
    const result = recognize(text);
    expect(phrases).toHaveBeenCalledTimes(1);
    expect(result).toBe(phrases.mock.results[0].value);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('disposition');
  });

  test('propagates upstream exceptions and unknown failure reasons', () => {
    const failure = { ok: false, reason: 'future_failure' };
    phrases.mockReturnValueOnce(failure);
    expect(recognize('fixture')).toBe(failure);
    phrases.mockImplementationOnce(() => { throw new Error('upstream'); });
    expect(() => recognize('fixture')).toThrow('upstream');
  });

  test('keeps successful empty and unknown input for review', () => {
    expect(recognize()).toEqual({ ok: true, disposition: 'needs_review', clauses: [] });
    expect(recognize('the sky is blue')).toMatchObject({ ok: true, disposition: 'needs_review',
      clauses: [{ amountRelations: [] }] });
  });
});
