// Referral Step 2 pure rules (services/referral-step2.js): the flat $25 member amount,
// the yearly cap boundary and the America/New_York year edge. The money paths are in referral-step2-postgres.test.js.
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  step2Settings, memberCredit, etYearBounds, capReached, ruleTerms, formatDollars, STEP2_DEFAULTS,
  friendInviteOfferLine, friendShareClause, memberInviteFriendClause, newsletterFriendLine, memberCreditEmailLine,
} = require('../services/referral-step2');

describe('step2Settings', () => {
  test('a settings row from before the migration, or a cleared field, takes the owner numbers', () => {
    expect(step2Settings({})).toEqual(STEP2_DEFAULTS);
    expect(step2Settings({ step2_annual_credit_cap: null, step2_referrer_reward_cents: '' })).toEqual(STEP2_DEFAULTS);
    expect(STEP2_DEFAULTS).toEqual({
      step2_referrer_reward_cents: 2500,
      step2_annual_credit_cap: 10,
    });
  });

  test('numeric strings from a decimal column are read as numbers; a negative falls back', () => {
    const s = step2Settings({ step2_referrer_reward_cents: '3000', step2_annual_credit_cap: -1 });
    expect(s.step2_referrer_reward_cents).toBe(3000);
    expect(s.step2_annual_credit_cap).toBe(10);
  });
});

describe('memberCredit', () => {
  test('always the flat standard amount, from the settings: no distance rule, near columns ignored', () => {
    expect(memberCredit({})).toEqual({ cents: 2500, reason: 'standard' });
    expect(memberCredit({ step2_referrer_reward_cents: 3000 })).toEqual({ cents: 3000, reason: 'standard' });
    expect(memberCredit({ step2_near_referrer_reward_cents: 9000, step2_near_radius_miles: 99 })).toEqual({ cents: 2500, reason: 'standard' });
  });
});

describe('dollars are shown to the cent', () => {
  test('whole dollars stay whole, cents are never rounded away', () => {
    expect(formatDollars(25)).toBe('$25');
    expect(formatDollars(25.5)).toBe('$25.50');
    expect(formatDollars(12.5)).toBe('$12.50');
    expect(ruleTerms({ referee_discount_cents: 1250, step2_referrer_reward_cents: 2550 }).text).toBe('Member: $25.50; friend: $12.50 credit');
  });
});

describe('the merge executor finds referee_customer_id by its name rule', () => {
  test('customer-dedupe repoints every column named customer_id or *_customer_id (customerFkColumns)', () => {
    const rule = /(^|_)customer_id$/;
    expect(['referee_customer_id', 'referrer_customer_id', 'customer_id'].every((c) => rule.test(c))).toBe(true);
  });
});

describe('ruleTerms (what staff read before confirming a referral)', () => {
  test('the owner numbers, and the live row when the office changes them', () => {
    expect(ruleTerms({ referee_discount_cents: 2500 }).text).toBe('Member: $25; friend: $25 credit');
    expect(ruleTerms({ referee_discount_cents: 2000, step2_referrer_reward_cents: 3000 }))
      .toMatchObject({ atCap: false, text: 'Member: $30; friend: $20 credit', short: 'member $30; friend $20' });
    expect(ruleTerms({ referee_discount_cents: 2550 }).text).toBe('Member: $25; friend: $25.50 credit');
  });
  test('a member at the yearly limit gets $0, stated, and the friend credit still shows', () => {
    expect(ruleTerms({ referee_discount_cents: 2500 }, true)).toEqual({
      atCap: true, text: 'Member is at the yearly limit: $0; friend: $25 credit', short: 'member at the yearly limit: $0; friend $25',
      conditional: 'Member: $25, unless at the yearly limit; friend: $25 credit',
    });
  });
});

describe('the friend and credit-email words (gate on)', () => {
  test('a whole-dollar amount reads $50, an amount with cents reads $32.50', () => {
    expect(friendInviteOfferLine(5000)).toBe('Start a Waves plan and get a $50 credit on your Waves account after your first service. Our way of saying welcome.');
    expect(friendInviteOfferLine(3250)).toBe('Start a Waves plan and get a $32.50 credit on your Waves account after your first service. Our way of saying welcome.');
    expect(friendShareClause(5000, 'ABC123')).toBe("they'll give you a $50 credit after your first plan service with my code ABC123");
    expect(friendShareClause(3250, 'ABC123')).toBe("they'll give you a $32.50 credit after your first plan service with my code ABC123");
    expect(memberInviteFriendClause(5000)).toBe('they get a $50 credit after their first plan service');
    expect(memberInviteFriendClause(3250)).toBe('they get a $32.50 credit after their first plan service');
    // The newsletter is one text for every reader, so it promises the member nothing (a member at the yearly limit gets $0).
    expect(newsletterFriendLine(5000)).toBe('They get a $50 credit after their first plan service.');
    expect(newsletterFriendLine(3250)).toBe('They get a $32.50 credit after their first plan service.');
  });
  test('the member credit email line says how to use the credit, for whole dollars and cents', () => {
    expect(memberCreditEmailLine(25)).toBe('Your $25 referral reward has been added to your Waves account as a credit. To use it on your next invoice, turn on "Apply my credit to invoices automatically" in the Waves app.');
    expect(memberCreditEmailLine(25.5)).toContain('Your $25.50 referral reward');
  });
});
