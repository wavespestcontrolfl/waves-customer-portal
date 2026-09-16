const { verifyEmailReplyPlanTotal: verify } = require('../services/email/email-reply-plan-total-verifier');

const verdict = (text, options = {}) => verify({ text, ...options });
const rejected = (text, options) => expect(verdict(text, options)).toEqual({
  ok: false, violations: ['customer_copy_compliance'],
});
const allowed = (text, options) => expect(verdict(text, options)).toEqual({
  ok: true, violations: [],
});

describe('inactive email reply plan-total policy', () => {
  test('exports only the requested verifier and accepts empty copy', () => {
    expect(require('../services/email/email-reply-plan-total-verifier'))
      .toEqual({ verifyEmailReplyPlanTotal: verify });
    expect(verify()).toEqual({ ok: true, violations: [] });
  });

  test.each([
    '$98/mo', '$1176/yr', '$98 per month', '$1176 per year',
    'The plan is $98 monthly', 'Our plan costs $1176 annually',
    'The annual plan is $1176',
    'Monthly price is $98', 'Yearly fee: USD 1176',
    'Annual price: $1176', 'Monthly price: $98', 'Yearly price: $1176',
    'The monthly plan costs $98', 'Annually, we charge $1176',
    '$98 is the monthly price', 'The $98 fee is yearly',
    'The price is $98 per year', 'Our account balance is $98/mo',
    'We pay $98 per month',
  ])('rejects an explicit monthly or annual plan amount: %s', (text) => {
    rejected(text);
  });

  test.each([
    'Monthly price is 98', 'Yearly fee: 1176',
    'Our service costs 98 per month', 'The service runs 1176 yearly',
    '98 per month is the price', 'The price of our service is 98 monthly',
    'Our total is 1176/yr',
  ])('rejects a bare number only with a pricing cue: %s', (text) => {
    rejected(text);
  });

  test.each([
    'Your payment of $98 is due next month.',
    'Your account balance is $98 this month.',
    'Your $98 monthly payment posted.',
    'Your $98 monthly payment posted and prices remain unchanged.',
    'Your $98 monthly payment posted and fees are unchanged.',
    'Your $98 monthly payment posted, prices remain unchanged.',
    'The monthly payment of $98 posted.',
    'We send monthly reminders about your $98 balance.',
    'The price is $98, monthly reminders are sent.',
    'Monthly updates mention the $98 price.',
    'We received $98 for your account, and monthly updates follow.',
    'Monthly visits cost $98 per application.',
    'Annual visits cost $98 per application.',
    'Yearly visits cost $98 per application.',
    'Monthly price is $98 per application.',
    'Price per visit is $98 monthly.',
    'The monthly plan costs $98 per visit.',
    '$98 for each application; the schedule is monthly.',
    'The price is $98 @ monthly.',
    'Price $98; monthly service continues.',
    'The annual payment of $1176 posted.',
    'The price is $98, annual reminders are sent.',
    'Annual updates mention the $98 price.',
    '98 per month',
    'Monthly plan is 98',
    'Each visit is 98 minutes, and the schedule is monthly.',
  ])('preserves unrelated payment, scheduling, or sibling pricing: %s', (text) => {
    allowed(text);
  });

  test('rejects one total without letting a sibling amount shield it', () => {
    rejected('Price $98 per application and $1176 yearly');
    rejected('$98 per application, $1176/yr');
    rejected('Price $98 per application, $1176 yearly');
    allowed('$98 per application. We schedule visits monthly.');
    allowed('Price per visit: $98 monthly.');
  });

  test('uses only trusted literal true exemption flags', () => {
    allowed('$98/mo', { commercialProposal: true });
    allowed('$98/mo', { legacyMonthlyPlan: true });
    allowed('$98/mo', { commercialProposal: true, legacyMonthlyPlan: false });
    rejected('$98/mo', { commercialProposal: 'true' });
    rejected('$98/mo', { legacyMonthlyPlan: 'true' });
    rejected('$98/mo', { commercialProposal: new Boolean(true) });
    rejected('Commercial proposal: $98/mo');
    rejected('This is a legacy monthly plan: $98/mo');
  });

  test('normalizes copy before checking claims or exemptions', () => {
    rejected('**&#36;98/mo**');
    expect(verdict(null, { commercialProposal: true })).toEqual({
      ok: false, violations: ['copy_type'],
    });
    expect(verdict('a'.repeat(8193), { legacyMonthlyPlan: true })).toEqual({
      ok: false, violations: ['copy_size'],
    });
    expect(verdict('a '.repeat(513))).toEqual({
      ok: false, violations: ['copy_tokens'],
    });
  });
});
