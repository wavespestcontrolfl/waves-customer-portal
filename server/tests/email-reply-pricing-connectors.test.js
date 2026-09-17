const { recognizeEmailReplyPricingPhrases: phrases } = require('../services/email/email-reply-pricing-phrases');
const { recognizeEmailReplyAmountRelations: amounts } = require('../services/email/email-reply-amount-relations');
const { recognizeEmailReplyUnitRelations: recognize } = require('../services/email/email-reply-unit-relations');

const records = (text) => recognize(text).clauses.flatMap((clause) => clause.unitRelations);
const edges = (text) => records(text).flatMap((record) => record.candidates);
const eligible = (text) => records(text).some((record) =>
  ['unit', 'eachVisit', 'visits', 'visit', 'forVisit'].includes(record.unit.kind)
    && record.candidates.some((edge) => edge.amount.kind === 'money' || edge.anchor !== null));

// Exact previously missing forms. These assert lexical evidence, never policy verdicts.
const missingForms = [
  'the price for every visit is $98',
  'each scheduled visit is priced at $98',
  'each scheduled visit is priced at 98 dollars',
  'every scheduled visit is billed at $98',
  'the rate per routine visit is $98',
  'Your scheduled visits are $98 each',
  'Visits will be billed at 98 dollars each',
  'Each visit has a $98 charge',
  'Each visit is invoiced at $98',
  'Each visit is just $98',
  'Visits are only $98 each',
  'Each visit is billed at 98',
  "Each visit's price is$98",
  "Every scheduled visit's cost was USD 98",
  "Your visit's fee is$98",
  "Our visits' fees are$98",
  'Your visit’s fee is$98',
  'Their scheduled visits’ prices will be $98',
  'Each visit has a price of $98',
  'Every visit has a cost of USD 98',
  'Every visit has an amount of $98',
  'Visits are $98',
  'Scheduled visits were billed at USD 98',
  'Your visits are priced at $98',
  'Your visits are priced at 98',
  'Scheduled visits were billed at 98',
  'The $98 fee is per visit',
  'For each visit, the price is $98',
  '$98 (per visit)',
  'USD 98 (for each visit)',
  'The rate per visit is $98',
  'Our fee is $98, per visit',
  'The cost is $98, for each visit',
  '$98 plus tax per visit',
  '$98 + tax per visit',
  'We charge $98 before tax per visit',
  '$98 plus fees for every visit',
  'Our service is priced at 98 per visit',
  'The service was priced at 98 per visit',
  'Your service will be priced at 98 per visit',
  'Visit fee: $98',
  'Visit cost — USD 98',
  'Each visit costs between $90 and $120',
  'Each visit costs from $90 to $120',
  'The price per visit ranges from $90 to $120',
];

describe('bounded shared pricing connectors', () => {
  test.each(missingForms)('retains eligible lexical evidence for %s', (text) => {
    expect(eligible(text)).toBe(true);
    expect(recognize(text).disposition).toBe('needs_review');
  });

  test.each(['Each visit would be $98', 'For each visit, there is a $98 fee',
    'Each visit costs no more than $98', 'Each visit costs no less than $98',
    'Each visit costs more than $98', 'Each visit costs less than $98',
    'For each visit, we charge you $98', 'For each visit, we will not invoice the customer about $98'])
  ('retains known modal, comparative and payer evidence: %s', (text) => {
    expect(eligible(text)).toBe(true);
  });

  test('adds range to the shared action vocabulary with its original scanner stem', () => {
    const clause = phrases('price per visit ranges from $90 to $120').clauses[0];
    expect(clause.tokens[2]).toEqual({ kind: 'word', text: 'range' });
    expect(clause.phrases.find((phrase) => phrase.type === 'predicate' && phrase.head === 'range')).toMatchObject({
      start: 2, end: 3, head: 'range', headStart: 2, headEnd: 3, text: 'range',
    });
  });

  test.each(['pay you at an about from USD 98', 'price of a roughly between $90 and $120',
    'fee: an exactly $98', 'cost - a nearly $98'])
  ('keeps full finite amount connector and qualifier identity: %s', (text) => {
    const clause = amounts(text).clauses[0];
    const edge = clause.amountRelations[0].candidates[0];
    expect(edge).toBeDefined();
    expect(edge.connector.text).toBe(clause.tokens.slice(edge.anchor.end, edge.end - 1)
      .map((token) => token.text).join(' '));
    expect(clause.phrases.some((phrase) => phrase === edge.anchor)).toBe(true);
    expect(clause.phrases.some((phrase) => phrase === edge.qualifier)).toBe(true);
  });

  test.each(['is not about a', 'would be never exactly an', 'is not more than', 'is no less than'])
  ('retains one unit copula with bounded negation, qualifier and article: %s', (gap) => {
    const edge = edges(`each visit ${gap} $98`)[0];
    expect(edge.anchor).toBeNull();
    expect(edge.connector.text).toBe(gap);
  });

  test.each(['the', 'our', 'your', 'a', 'an'])
  ('permits one fronted nominal determiner %s', (determiner) => {
    const edge = edges(`for each visit, ${determiner} fee is $98`)[0];
    expect(edge.connector.text).toBe(`, ${determiner}`);
    expect(edge.anchor.anchor).toMatchObject({ type: 'billing_head', head: 'fee', roles: ['noun'] });
  });

  test.each(['there is', 'there would be a', ', there are an'])
  ('permits fronted there plus one be and optional article: %s', (gap) => {
    expect(edges(`per visit ${gap} $98 fee`)[0].connector.text).toBe(gap);
  });

  test('preserves possessive and has connectors on existing nominal anchors', () => {
    const possessive = edges("each visit's fee is $98")[0];
    expect(possessive.connector).toEqual({ start: 1, end: 2, text: "'s" });
    expect(possessive.anchor.anchor.head).toBe('fee');
    const has = edges('each visit has a price of $98').find((edge) => edge.anchor.anchor.head === 'price');
    expect(has.connector).toEqual({ start: 1, end: 3, text: 'has a' });
  });

  test.each(['$98 (per visit)', '(per visit) $98', '($98) per visit', 'per visit ($98)',
    '(fee is $98) per visit', 'per visit (fee is $98)', '$98 is (per visit)', '($98) is per visit'])
  ('crosses one locally matched delimiter: %s', (text) => {
    expect(edges(text).length).toBeGreaterThan(0);
    expect(edges(text).every((edge) => /[()]/.test(edge.connector.text))).toBe(true);
  });

  test.each(['($98 per visit)', '$98 per visit (please call us)', '$98 per visit (',
    '(aside) $98 (per visit)', '$98 (per visit) (aside)', '$98 (per visit))'])
  ('preserves supported edges with parentheses outside the connector: %s', (text) => {
    expect(eligible(text)).toBe(true);
  });

  test.each(['plus tax', '+ tax', 'before taxes', 'plus fees', 'before fee'])
  ('retains bounded tax connector without changing the amount: %s', (gap) => {
    const clause = recognize(`$98 ${gap} per visit`).clauses[0];
    const edge = clause.unitRelations[0].candidates[0];
    expect(edge.amount).toBe(clause.amountRelations[0].amount);
    expect(edge.amount.text).toBe('$98');
    expect(edge.connector.text).toBe(gap.replace('+', 'plus').replace('fees', 'fee'));
    expect(edge.anchor).toBeNull();
  });

  test('retains individual currency endpoints and links only the first endpoint before the range', () => {
    const clause = recognize('each visit costs between $90 and $120').clauses[0];
    expect(clause.amountRelations.map((record) => record.amount.text)).toEqual(['$90', '$120']);
    expect(clause.unitRelations[0].candidates.map((edge) => edge.amount))
      .toEqual(clause.amountRelations[0].candidates.map(() => clause.amountRelations[0].amount));
    expect(clause.unitRelations[0].candidates.every((edge) => edge.anchor.connector.text === 'between')).toBe(true);
    const trailing = recognize('price costs between $90 and $120 per visit').clauses[0];
    expect(trailing.unitRelations[0].candidates).toHaveLength(1);
    expect(trailing.unitRelations[0].candidates.every((edge) => edge.amount === trailing.amountRelations[1].amount))
      .toBe(true);
    const intact = recognize('each visit costs from $90 to $120').clauses[0];
    expect(intact.amountRelations.map((record) => record.amount.text)).toEqual(['$90 to $120']);
    expect(intact.unitRelations[0].candidates.every((edge) => edge.amount === intact.amountRelations[0].amount))
      .toBe(true);
  });

  test.each(['each visit is mystery $98', 'each visit is about only $98',
    'each visit is not never $98', 'each visit is is $98', 'each visit is a an $98',
    'each visit is not mystery $98', 'each visit has mystery a price of $98',
    'each visit has a pay $98', "each visit's pay $98",
    "each visit's mystery fee is $98", 'for each visit, the new fee is $98',
    'for each visit, his fee is $98', 'per visit there mystery is $98',
    'per visit there is is $98', 'per visit,, there is $98', 'per visit there is the $98',
    '$98 is not per visit', '$98 is about per visit', '$98,, per visit',
    '$98 plus tax plus tax per visit', '$98 before mystery tax per visit', '$98 after tax per visit',
    '$98 plus tax and fees per visit', '$98 (per visit', '$98 ) per visit',
    '$98 ((per visit))', '(($98)) per visit', '$98 (mystery per visit)',
    '$98 )per visit(', '$98 (per visit;)',
    'each visit received $98', 'for each visit, we refunded $98',
    'each visit has account balance $98', 'each visit is 98 minutes', '98 minutes per visit',
    'each visit is; $98'])
  ('leaves unsupported crossings without visit evidence: %s', (text) => {
    expect(eligible(text)).toBe(false);
  });

  test.each(['pay you at at $98', 'pay at a an $98', 'pay at about only $98',
    'costs from between $98', 'price of of $98', 'price is of $98', 'price:: $98',
    'price - : $98', 'price a roughly exactly $98', 'costs mystery from $98'])
  ('leaves repeated or unknown amount connectors unresolved: %s', (text) => {
    expect(amounts(text).clauses[0].amountRelations[0].candidates).toEqual([]);
  });

  test.each(['per application', 'at the next visit', 'for a visit', 'monthly'])
  ('preserves the existing unit kind through new connectors: %s', (unit) => {
    const expected = records(`${unit} $98`)[0].unit.kind;
    const result = records(`${unit} is about $98`)[0];
    expect(result.unit.kind).toBe(expected);
    expect(result.candidates).toHaveLength(1);
    expect(recognize(`${unit} is about $98`).disposition).toBe('needs_review');
  });

  test('bare numbers require an existing billing anchor for monetary eligibility', () => {
    expect(edges('98 per visit')).toHaveLength(1);
    expect(eligible('98 per visit')).toBe(false);
    expect(eligible('our service is priced at 98 per visit')).toBe(true);
  });

  test.each(['price', 'cost', 'charge'])('preserves article-free has before %s', (noun) => {
    for (const prefix of ['has', 'may have', 'does not have']) {
      const result = recognize(`each visit ${prefix} ${noun} of $98`);
      const clause = result.clauses[0];
      const nominal = clause.amountRelations[0].candidates.find((c) => c.relation === 'head_amount');
      expect(clause.unitRelations[0].candidates).toContainEqual(expect.objectContaining({ anchor: nominal }));
      expect(result.disposition).toBe('needs_review');
    }
  });

  test.each(['each visit may price of $98', 'each visit has mystery price of $98',
    'each visit is price of 98 minutes'])
  ('does not infer a has bridge from unrelated prefixes: %s', (text) => {
    expect(edges(text)).toEqual([]);
  });

  test.each(['at most', 'at least'])('does not consume the start of %s as a connector', (qualifier) => {
    const clause = recognize(`for each visit, customers pay ${qualifier} $98`).clauses[0];
    const original = clause.phrases.find((p) => p.type === 'qualifier');
    expect(clause.amountRelations[0].candidates[0].qualifier).toBe(original);
    expect(clause.unitRelations[0].candidates.length).toBeGreaterThan(0);
  });
});
