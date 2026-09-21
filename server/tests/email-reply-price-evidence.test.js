jest.mock('../services/email/email-reply-unit-relations', () => {
  const actual = jest.requireActual('../services/email/email-reply-unit-relations');
  return { recognizeEmailReplyUnitRelations: jest.fn(actual.recognizeEmailReplyUnitRelations) };
});
const { recognizeEmailReplyUnitRelations: units } = require('../services/email/email-reply-unit-relations');
const { recognizeEmailReplyPriceEvidence: recognize } = require('../services/email/email-reply-price-evidence');
const evidence = (text) => recognize(text).clauses.flatMap((clause) => clause.priceEvidence);

afterEach(() => jest.clearAllMocks());

describe('inactive price evidence', () => {
  test.each([
    ['$98 per visit', 'visit'], ['Each visit costs 98', 'visit'],
    ['$98 for a visit', 'visit'], ['$98 per application', 'application'],
    ['$98 on your next visit', 'timing'], ['$98 per month', 'period'],
    ['The cost per visit ranges from 90 to 120', 'visit'],
    ['Each visit generates a 98 fee', 'visit'], ['98 fee is due per visit', 'visit'],
    ['Each visit costs no more than $98', 'visit'], ['Each visit costs not less than $98', 'visit'],
    ['Each visit has been billed $98', 'visit'], ['Each visit has not been billed $98', 'visit'],
    ['For each visit, we charge you $98', 'visit'], ['For each visit, a $98 fee applies', 'visit'],
    ['Each visit may have just cost of USD 98', 'visit'],
    ['Each visit will only be $98', 'visit'], ['$98 is our charge for each visit', 'visit'],
  ])('retains evidence and upstream identities: %s', (text, family) => {
    const result = recognize(text);
    expect(units).toHaveBeenCalledTimes(1);
    const upstream = units.mock.results[0].value;
    expect(result.disposition).toBe('needs_review');
    expect(result.clauses.flatMap((c) => c.priceEvidence).length).toBeGreaterThan(0);
    result.clauses.forEach((clause, index) => {
      for (const field of ['tokens', 'phrases', 'amountRelations', 'unitRelations']) {
        expect(clause[field]).toBe(upstream.clauses[index][field]);
      }
      for (const record of clause.priceEvidence) {
        expect(record.family).toBe(family);
        const original = clause.unitRelations.find((unit) => unit.unit === record.unit);
        expect(original).toBeDefined();
        expect(original.candidates).toContain(record.edge);
      }
    });
  });

  test.each(['has', 'generate', 'apply', 'occur', 'due', 'required', 'payable', 'range'])
  ('generic action %s alone is not a bare-number price cue', (head) => {
    const result = recognize(`each visit ${head} 98`);
    expect(result.clauses[0].phrases.find((p) => p.type === 'predicate').priceCue).toBe(false);
    expect(result.clauses[0].priceEvidence).toEqual([]);
    expect(result.disposition).toBe('needs_review');
  });

  test.each(['cost', 'charge', 'bill', 'invoice', 'pay', 'price', 'run', 'incur', 'amount to', 'come to'])
  ('shared pricing action %s supplies a cue, not a send verdict', (head) => {
    const result = recognize(`each visit ${head} 98`);
    expect(result.clauses[0].phrases.find((p) => p.type === 'predicate').priceCue).toBe(true);
    expect(result.clauses[0].priceEvidence.length).toBeGreaterThan(0);
    expect(result.disposition).toBe('needs_review');
  });

  test.each([
    '98 per visit', 'Each visit is 98', 'Each visit costs 98 minutes',
    'Each visit generates 98 photos', 'Each visit has a 98 minute delay',
    'A price was mentioned; each visit ranges 90 to 120',
    'The price may change, and each visit ranges 90 to 120',
    'We refunded the $98 charge — each visit remains included at no additional cost',
    'Your $98 payment is pending, and each visit remains included',
    '$98 fee, each visit', '$98 fee - visits',
  ])('leaves unsupported or ambiguous relationships for review: %s', (text) => {
    const result = recognize(text);
    expect(result.clauses.flatMap((c) => c.priceEvidence)).toEqual([]);
    expect(result.disposition).toBe('needs_review');
  });

  test('retains excluded lexical edges for later interpretation', () => {
    const result = recognize('$98 charge — each visit remains included');
    expect(result.clauses[0].unitRelations[0].candidates.length).toBeGreaterThan(0);
    expect(result.clauses[0].priceEvidence).toEqual([]);
    expect(evidence('$98 charge — per visit').length).toBeGreaterThan(0);
    expect(evidence('$98 charge each visit').length).toBeGreaterThan(0);
  });

  test('preserves negative predicates rather than granting an exemption', () => {
    const c = recognize('Each visit is not charged $98').clauses[0];
    expect(c.priceEvidence.some((r) => r.edge.anchor?.anchor.negated)).toBe(true);
  });

  test.each([null, {}, 'x'.repeat(8193), 'x '.repeat(513)])('forwards upstream failure: %#', (text) => {
    const result = recognize(text);
    expect(units).toHaveBeenCalledTimes(1);
    expect(result).toBe(units.mock.results[0].value);
    expect(result.ok).toBe(false);
  });

  test.each(['', 'The sky is blue', 'Each visit mysteriously frobs 98'])
  ('never approves empty or unrecognized text: %s', (text) => {
    expect(recognize(text)).toMatchObject({ ok: true, disposition: 'needs_review' });
    expect(evidence(text)).toEqual([]);
  });
});
