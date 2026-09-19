jest.mock('../services/email/email-reply-pricing-context', () => {
  const actual = jest.requireActual('../services/email/email-reply-pricing-context');
  return { recognizeEmailReplyPricingContext: jest.fn(actual.recognizeEmailReplyPricingContext) };
});
const { recognizeEmailReplyPricingContext: context } = require('../services/email/email-reply-pricing-context');
const { recognizeEmailReplyPeriodRelations: recognize } = require('../services/email/email-reply-period-relations');
const { inspectEmailReplyPlanTotal } = require('../services/email/email-reply-plan-total-verifier');

afterEach(() => jest.clearAllMocks());

const relationsFor = (text) => recognize(text).clauses.flatMap((clause) => clause.periodRelations);
const kinds = (text) => relationsFor(text).map((record) => record.relation);
const reasons = (text) => relationsFor(text).map((record) => record.evidence.reason);

describe('inactive email reply period relations', () => {
  test('calls the upstream pricing-context recognizer exactly once and preserves its clause identities', () => {
    const result = recognize('The plan is $98 monthly');
    expect(context).toHaveBeenCalledTimes(1);
    const upstream = context.mock.results[0].value;
    expect(result.disposition).toBe('needs_review');
    result.clauses.forEach((clause, index) => {
      for (const field of ['tokens', 'phrases', 'contextPhrases', 'amountRelations', 'unitRelations',
        'priceEvidence', 'periodPhrases']) {
        expect(clause[field]).toBe(upstream.clauses[index][field]);
      }
    });
  });

  test('every record cites the exact upstream amount and period objects, never a copy', () => {
    const clause = recognize('$98/mo').clauses[0];
    expect(clause.periodRelations).toHaveLength(1);
    const [record] = clause.periodRelations;
    expect(clause.amountRelations.map((r) => r.amount)).toContain(record.amount);
    expect(clause.periodPhrases).toContain(record.period);
  });

  test.each([null, {}, 'x'.repeat(8193), 'x '.repeat(513)])
  ('forwards an upstream failure by identity: %#', (text) => {
    const result = recognize(text);
    expect(context).toHaveBeenCalledTimes(1);
    expect(result).toBe(context.mock.results[0].value);
    expect(result.ok).toBe(false);
  });

  test.each(['', 'The sky is blue', 'Each visit mysteriously frobs 98'])
  ('never approves empty or unrecognized text: %s', (text) => {
    expect(recognize(text)).toMatchObject({ ok: true, disposition: 'needs_review' });
    expect(relationsFor(text)).toEqual([]);
  });

  test('never returns a verdict or exemption field, only typed evidence', () => {
    for (const record of relationsFor('The monthly plan costs $98 after your payment posted.')) {
      expect(Object.keys(record).sort()).toEqual(
        ['amount', 'claim', 'connector', 'context', 'evidence', 'period', 'relation'].sort(),
      );
      expect(['plan_total', 'excluded']).toContain(record.relation);
      expect(Object.keys(record.evidence)).toEqual(['reason']);
      expect(record).not.toHaveProperty('ok');
      expect(record).not.toHaveProperty('violations');
    }
  });

  // Positive evidence first (owner ruling 2026-09-19): money + period in one
  // claim is a plan-total claim; only measurement, visit ties and cue-less bare
  // numbers are excluded. Account notices and cadence prose are findings.
  test.each([
    ['$98/mo', 'plan_total', 'money_period_claim'],
    ['$98 a month', 'plan_total', 'money_period_claim'],
    ['The plan is $98 monthly', 'plan_total', 'money_period_claim'],
    ['Monthly price is $98', 'plan_total', 'money_period_claim'],
    ['We pay $98 monthly', 'plan_total', 'money_period_claim'],
    ['Your $98 monthly payment posted.', 'plan_total', 'money_period_claim'],
    ['Monthly reminders mention the $98 price', 'plan_total', 'money_period_claim'],
    ['We received your monthly payment of $98', 'plan_total', 'money_period_claim'],
    ['Monthly price is 98', 'plan_total', 'bare_number_price_cue'],
    ['The monthly payment is 98', 'plan_total', 'bare_number_price_cue'],
    ['98 per month', 'excluded', 'no_price_cue'],
    ['Our annual renewal rate is 98 percent', 'excluded', 'bare_measurement'],
    ['Price per visit is $98 monthly', 'excluded', 'visit_tied'],
  ])('pairs %s as %s (%s)', (text, relation, reason) => {
    const [record] = relationsFor(text);
    expect(record.relation).toBe(relation);
    expect(record.evidence.reason).toBe(reason);
  });

  test.each([
    'The plan is $98 monthly but reminders are optional',
    'The plan is $98 monthly including service',
    '$98 monthly including service',
    'Monthly service plan costs $98',
    'Your payment of $98 is due monthly',
    'Your monthly payment of $98 is due',
  ])('cadence, obligation and activity prose beside a money+period pair stay findings: %s', (text) => {
    expect(kinds(text)).toContain('plan_total');
  });

  test.each([
    'The plan is $98 and is billed monthly',
    'The plan is $98, billed monthly',
    'The plan is $98, and is billed monthly',
    'The plan costs $98, and it is billed monthly',
    'The price is $1176, and will be charged yearly',
  ])('a bounded comma/and continuation keeps the amount and period in one claim: %s', (text) => {
    expect(kinds(text)).toContain('plan_total');
  });

  test.each([
    'The initial price is $98, service occurs monthly',
    'Your refund was $98; service is monthly.',
  ])('independent facts still break the claim or stay unpaired: %s', (text) => {
    expect(kinds(text)).not.toContain('plan_total');
  });

  test.each(['The monthly visit plan costs $98', 'Our annual service visit package is $1176'])(
    'a period embedded in a visit token that modifies a plan word is an anchor, not a visit price: %s', (text) => {
      expect(reasons(text)).toEqual(['money_period_claim']);
    },
  );
  test.each(['Monthly visits cost $98 per application', 'Each visit is $98 monthly'])(
    'visit pricing stays tied to its unit: %s', (text) => {
      expect(kinds(text)).not.toContain('plan_total');
    },
  );

  test.each(['We refunded $98 a month or 2 ago', 'We refunded $98 a year and 6 months ago',
    'We refunded $98 a year and six months ago', 'We refunded $98 a month ago'])(
    'numeric and worded ago continuations stay temporal: %s', (text) => {
      expect(relationsFor(text)).toEqual([]);
      expect(inspectEmailReplyPlanTotal({ text }).violations).toEqual([]);
    },
  );

  test('bounds context and claim to the pair\'s own claim segment, using clause-local token indexes', () => {
    const clause = recognize('The plan is $98 monthly but the yearly rate is $1176').clauses[0];
    expect(clause.periodRelations).toHaveLength(2);
    const [first, second] = clause.periodRelations;
    expect(first.relation).toBe('plan_total');
    expect(second.relation).toBe('plan_total');
    expect(first.claim.start).toBe(0);
    expect(first.claim.end).toBeLessThan(second.claim.start);
    expect(second.claim.end).toBe(clause.tokens.length);
  });

  test('a null connector means the amount and period are directly adjacent', () => {
    expect(relationsFor('$98/mo')[0].connector).toBeNull();
  });

  test('a populated connector reports the exact gap span and text', () => {
    const [record] = relationsFor('$98 is per month');
    expect(record.connector).toEqual({ start: record.amount.end, end: record.period.start, text: 'is' });
  });
});
