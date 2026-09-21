const { recognizeEmailReplyUnitRelations: recognize } = require('../services/email/email-reply-unit-relations');

const clause = (text) => recognize(text).clauses[0];
const candidates = (text) => clause(text).unitRelations.flatMap((record) => record.candidates);

// Preserved positive examples from the frozen monetary suite, without making policy decisions.
const examples = [
  '$98 pay-per-visit',
  'A $98 fee applies per visit.', 'The $98 rate applies on each visit.',
  'A $98 charge may apply for every visit.',
  'Each visit is billed for $98.', 'Each visit is invoiced for an approximately $98 charge.',
  '$98 applies per visit', 'USD 98 may apply for each visit',
  'A $98 fee occurs per visit', 'The $98 charge may occur on each visit',
  'Each visit has only a $98 fee', 'Every visit may have just a USD 98 charge',
  'Each visit has only price of $98', 'Every visit may have just cost of USD 98',
  'For each visit, there may be only a $98 fee',
  '$98 is due per visit', 'A $98 fee is due for each visit',
  'Each visit will only be $98', 'Each visit may just be USD 98',
  'For each visit, customers pay at most $98',
  'For every visit, ninety-eight dollars', 'Per visit: only $98',
  'For each visit: between $90 and $120',
  '$98 is our charge for each visit', '$98 may be your cost per scheduled visit',
];

describe('inactive bounded pricing complements', () => {
  test.each(examples)('retains candidate evidence: %s', (text) => {
    const result = recognize(text);
    expect(result.disposition).toBe('needs_review');
    const c = result.clauses[0];
    const edges = c.unitRelations.flatMap((record) => record.candidates);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      const original = c.amountRelations.find((record) => record.amount === edge.amount);
      expect(original).toBeDefined();
      if (edge.anchor) expect(original.candidates).toContain(edge.anchor);
      if (edge.connector) {
        const { start, end, text: connector } = edge.connector;
        expect(c.tokens.slice(start, end).map((token) => token.text).join(' ')).toBe(connector);
      }
    }
  });

  test('preserves at-most as one qualifier after a payer predicate', () => {
    const c = clause('For each visit, customers pay at most $98');
    const relation = c.amountRelations[0].candidates.find((r) => r.relation === 'predicate_amount');
    expect(relation.qualifier).toBe(c.phrases.find((p) => p.type === 'qualifier'));
    expect(relation.qualifier.text).toBe('at most');
    expect(relation.connector).toEqual({ start: 4, end: 6, text: 'at most' });
  });

  test('retains exact amount-first determiner spans', () => {
    const c = clause('$98 is our charge for each visit');
    expect(c.amountRelations[0].candidates).toEqual([expect.objectContaining({
      relation: 'amount_head', start: 0, end: 4,
      connector: { start: 1, end: 3, text: 'is our' },
    })]);
    expect(c.unitRelations[0].candidates[0].anchor).toBe(c.amountRelations[0].candidates[0]);
  });

  test.each(['apply', 'occur', 'due', 'required', 'payable'])('retains trailing %s evidence', (head) => {
    const text = `$98 may not be ${head} per visit`;
    const c = clause(text);
    expect(candidates(text)).toEqual([expect.objectContaining({
      connector: { start: 1, end: 5, text: `may not be ${head}` },
    })]);
    expect(c.phrases.find((p) => p.type === 'predicate').negated).toBe(true);
  });

  test.each([
    'Each visit is billed for for $98', 'Each visit is billed toward $98',
    'Each visit has only only a $98 fee', 'Each visit has only a a $98 fee',
    'Each visit will unexpectedly be $98', 'Each visit will will be $98',
    'Per visit: only only $98', 'Per visit: from between $90',
    'Per visit, there mysteriously is $98', 'Per visit, there is is $98',
    '$98 applies mysteriously per visit', '$98 occurs and applies per visit',
    '$98 pay per visit', '$98 is their their charge per visit',
    '$98 is our unexpected charge per visit', 'Each visit, strange $98',
  ])('does not skip unsupported words: %s', (text) => {
    expect(candidates(text)).toEqual([]);
  });

  test.each([
    'Each visit is billed for 98 minutes', 'Each visit will only be 98 minutes',
    'Per visit: only 98 minutes', 'Each visit has only a 98 minute delay',
  ])('keeps measurement evidence separate: %s', (text) => {
    expect(candidates(text)).toEqual([]);
  });

  test.each(['application', 'timing', 'period'])('keeps %s unit kind rather than promoting it to visit', (kind) => {
    const units = { application: 'per application', timing: 'on your next visit', period: 'per month' };
    const c = clause(`$98 applies ${units[kind]}`);
    expect(c.unitRelations[0].unit.kind).toBe(kind);
    expect(c.unitRelations[0].candidates.length).toBeGreaterThan(0);
  });

  test('keeps range endpoints and unrelated refund words visible for later policy', () => {
    const c = clause('For each visit: between $90 and $120');
    expect(c.amountRelations.map((r) => r.amount.text)).toEqual(['$90', '$120']);
    expect(c.unitRelations[0].candidates.map((r) => r.amount.text)).toEqual(['$90']);
    const refund = recognize('We refunded the $98 charge — each visit remains included at no additional cost');
    expect(refund.disposition).toBe('needs_review');
    expect(refund.clauses[0].tokens).toContainEqual({ kind: 'word', text: 'refunded' });
  });
});
