jest.mock('../services/email/email-reply-pricing-context', () => {
  const actual = jest.requireActual('../services/email/email-reply-pricing-context');
  return { recognizeEmailReplyPricingContext: jest.fn(actual.recognizeEmailReplyPricingContext) };
});
const { recognizeEmailReplyPricingContext: context } = require('../services/email/email-reply-pricing-context');
const { recognizeEmailReplyPeriodRelations: recognize } = require('../services/email/email-reply-period-relations');

afterEach(() => jest.clearAllMocks());

const relationsFor = (text) => recognize(text).clauses.flatMap((clause) => clause.periodRelations);

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
      expect(record).not.toHaveProperty('commercialProposal');
      expect(record).not.toHaveProperty('legacyMonthlyPlan');
    }
  });

  test.each([
    ['$98/mo', 'plan_total', 'direct_currency_period'],
    ['$98 a month', 'plan_total', 'direct_currency_period'],
    ['The plan is $98 monthly', 'plan_total', 'plan_cue'],
    ['Monthly price is $98', 'plan_total', 'price_cue'],
    ['98 per month', 'excluded', 'no_price_cue'],
    ['We pay $98 monthly', 'plan_total', 'payment_assertion'],
    ['Our annual renewal rate is 98 percent', 'excluded', 'bare_measurement'],
    ['Price per visit is $98 monthly', 'excluded', 'visit_tied'],
    ['Monthly reminder mentions the $98 initial-service price', 'excluded', 'activity_cadence'],
    ['We received your monthly payment of $98', 'excluded', 'account_event'],
    ['$98 monthly', 'plan_total', 'direct_gap'],
    ['The monthly price is $98, applications are scheduled separately.', 'plan_total', 'price_cue'],
  ])('pairs %s as %s (%s)', (text, relation, reason) => {
    const [record] = relationsFor(text);
    expect(record.relation).toBe(relation);
    expect(record.evidence.reason).toBe(reason);
  });

  test('bounds context and claim to the pair\'s own claim segment, using clause-local token indexes', () => {
    const clause = recognize('The plan is $98 monthly but the yearly rate is $1176').clauses[0];
    expect(clause.periodRelations).toHaveLength(2);
    const [first, second] = clause.periodRelations;
    expect(first.relation).toBe('plan_total');
    expect(second.relation).toBe('plan_total');
    // Each pair's claim is a disjoint, clause-local token range: the second
    // claim starts strictly after the first claim ends (past the "but" break).
    expect(first.claim.start).toBe(0);
    expect(first.claim.end).toBeLessThan(second.claim.start);
    expect(second.claim.end).toBe(clause.tokens.length);
    // Context roles stay inside the pair's own claim and never leak the sibling's.
    for (const role of first.context.roles) expect(role).not.toBe('rate');
  });

  test('an amount can pair with the anchor before it and the anchor after it independently', () => {
    const clause = recognize('Monthly price is $98 monthly').clauses[0];
    expect(clause.periodRelations.length).toBeGreaterThanOrEqual(1);
    for (const record of clause.periodRelations) expect(record.relation).toBe('plan_total');
  });

  test('a null connector means the amount and period are directly adjacent', () => {
    const [record] = relationsFor('$98/mo');
    expect(record.connector).toBeNull();
  });

  test('a populated connector reports the exact gap span and text', () => {
    const [record] = relationsFor('$98 is per month');
    expect(record.connector).toEqual({ start: record.amount.end, end: record.period.start, text: 'is' });
  });
});

// Pre-push audit P1: activity cadence must not read past the claim boundary.
describe('activity cadence stays inside its claim', () => {
  const { recognizeEmailReplyPeriodRelations } = require('../services/email/email-reply-period-relations');
  const relations = (text) => recognizeEmailReplyPeriodRelations(text).clauses.flatMap((clause) => clause.periodRelations);
  test.each([
    'The plan is $98 monthly but reminders are optional',
    'The plan is $98 monthly, and service reminders are optional',
    'Our price is $98 monthly or reminders stop',
  ])('a conjunction-separated activity statement does not exclude the total: %s', (text) => {
    expect(relations(text).map((relation) => relation.relation)).toContain('plan_total');
    expect(relations(text).map((relation) => relation.evidence.reason)).not.toContain('activity_cadence');
  });
  test.each([
    'The plan is $98 monthly including service',
    'Our price is $98 monthly with service reminders',
    'Your payment is $98 monthly including treatments',
  ])('a trailing period on an asserted price is not activity cadence: %s', (text) => {
    expect(relations(text).map((relation) => relation.relation)).toContain('plan_total');
  });
  test.each([
    '$98 monthly including service', '$1176 yearly with service reminders', '$98 annually for treatments',
  ])('a bare money total with a trailing period is not activity cadence: %s', (text) => {
    expect(relations(text).map((relation) => relation.relation)).toContain('plan_total');
  });
  test('activity cadence inside the same claim still excludes', () => {
    expect(relations('Monthly reminders mention the $98 price').map((relation) => relation.evidence.reason))
      .toEqual(['activity_cadence']);
  });
});

// Codex #4614 r1: comma-plus-conjunction continuations and current payment obligations.
describe('continuations and obligations', () => {
  const { recognizeEmailReplyPeriodRelations } = require('../services/email/email-reply-period-relations');
  const { inspectEmailReplyPlanTotal } = require('../services/email/email-reply-plan-total-verifier');
  const relations = (text) => recognizeEmailReplyPeriodRelations(text).clauses.flatMap((clause) => clause.periodRelations);
  test.each([
    'The plan is $98, and is billed monthly', 'The price is $1176, and will be charged yearly',
    'Your $98 monthly payment is due', 'Your monthly payment of $98 is due', 'The monthly payment of $98 is payable',
  ])('produces the plan-total finding: %s', (text) => {
    expect(relations(text).map((relation) => relation.relation)).toContain('plan_total');
    expect(inspectEmailReplyPlanTotal({ text }).violations).toEqual(['customer_copy_compliance']);
  });
  test.each(['Your $98 monthly payment posted.', 'Your $98 monthly payment was due.', 'Your payment of $98 is due next month.'])(
    'posted events, past obligations and non-period timing stay unpaired: %s', (text) => {
      expect(inspectEmailReplyPlanTotal({ text }).violations).toEqual([]);
    },
  );
});
