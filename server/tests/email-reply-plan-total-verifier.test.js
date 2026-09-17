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

  test.each([
    'The monthly price is $98, applications are scheduled separately.',
    'The yearly fee is $1176, visits are scheduled separately.',
    'The monthly price is 98, applications are scheduled separately.',
    'Monthly, we charge $98.',
    'Yearly, we charge $1176.',
    'Annually, we charge $1176.',
  ])('keeps a plan price distinct from later units and fronted period punctuation: %s', (text) => {
    rejected(text);
  });

  test.each([
    'Your payment was $98, monthly prices remain unchanged.',
    'Your refund was $1176, annual fees remain unchanged.',
    'Your payment was 98, monthly prices remain unchanged.',
    'Monthly updates were sent, the price is $98.',
    'Annually, reminders are sent, the price is $1176.',
    'The monthly price is $98 per application.',
    'The monthly price is $98: per application.',
    'The yearly fee is $1176 per visit.',
  ])('respects independent comma claims and attached application or visit units: %s', (text) => {
    allowed(text);
  });

  test.each([
    'The plan costs $98 a month', '$98 each month', '$1,176 every year',
    'USD 98 every month', '$1176 a year', '98 dollars each month',
    'The price is 98 a month', 'The yearly price is 1176 every year',
  ])('recognizes determined month/year words without changing the scanner: %s', (text) => rejected(text));

  test.each([
    'The monthly plan costs $98: applications are scheduled separately',
    'The monthly plan costs $98 - applications are scheduled separately',
    'The monthly plan costs $98 (applications are scheduled separately)',
    'The annual price is $1176: visits are scheduled separately',
    'The monthly price is $98 applications are scheduled separately',
  ])('does not treat later noun prose as an amount unit: %s', (text) => rejected(text));

  test.each([
    'The monthly plan costs $98: per application',
    'The monthly plan costs $98 - for each application',
    'The monthly plan costs $98 (per application)',
    'The annual price is $1176: per visit',
    'Monthly application price is $98',
  ])('preserves real sibling pricing units: %s', (text) => allowed(text));

  test.each([
    'The monthly price of the standard plan for your home is $98',
    'The total annual cost for your pest-control service is $1176',
    '$98 is the price of the standard plan for your home monthly',
    'The yearly price of our standard program for your account is 1176',
  ])('follows a price relationship to its claim boundary: %s', (text) => rejected(text));

  test('handles a long bounded claim and repeated nearest anchors', () => {
    rejected(`The monthly price for your ${'standard '.repeat(400)}plan is $98`);
    allowed(Array(80).fill('98 monthly payment posted,').join(' '));
    rejected(`${Array(70).fill('$98 monthly payment posted,').join(' ')}$1176/yr`);
  });

  test.each([
    '$98/mo', '$98 a month', '$98 each month', '$98 every month',
    'The monthly payment is $98', 'The monthly price is 98',
    '$98/month', '$98/months', '$98/mos', '$98 per months', '$98 per mos',
  ])('permits only the legacy plan\'s own monthly unit: %s', (text) => {
    allowed(text, { legacyMonthlyPlan: true });
  });

  test.each([
    '$1176/yr', '$1176 a year', '$1176 each year', '$1176 every year',
    'The annual price is $1176', 'The yearly price is 1176',
    '$98/mo, $1176/yr', '$98 a month; the annual total is $1176',
    '$1176/year', '$1176/years', '$1176/yrs', '$1176 per years', '$1176 per yrs',
  ])('rejects yearly aggregates even for a trusted monthly legacy plan: %s', (text) => {
    rejected(text, { legacyMonthlyPlan: true });
  });

  test.each([
    '98 a month', '98 each month', '1176 every year',
    'Our monthly plan is 98', 'Our plan is 98 every month',
    'Your monthly payment of 98 posted, prices remain unchanged',
  ])('still requires a pricing predicate for bare determined-period numbers: %s', (text) => allowed(text));

  test.each([
    'The monthly payment is $98', 'Your monthly payment amount is $98',
    'The monthly account fee is $98', 'The annual account fee is $1176',
    'The monthly payment is 98', 'Monthly reminder fee is $98',
    'Monthly service reminders cost $98',
  ])('keeps account and activity nouns inside explicit pricing predicates: %s', (text) => rejected(text));

  test.each([
    'The monthly payment of $98 posted', 'Your monthly payment was $98 and it cleared',
    'We received your monthly payment of $98',
    'Your account balance of $98 remains unchanged, monthly prices are unchanged',
    'Monthly reminder mentions the $98 initial-service price',
    'Monthly service reminders mention the $98 initial-service price',
    'Yearly service update mentions the $1176 initial-service cost',
    'Annual scheduled appointment details mention the $98 initial-service price',
    'Monthly reminder mentions the price of the standard application for your home: $98',
  ])('preserves account events and singular or modified activity cadence: %s', (text) => allowed(text));

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
