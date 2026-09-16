const { verifyEmailReplyPricing } = require('../services/email/email-reply-pricing-verifier');

const verdict = (text) => verifyEmailReplyPricing({ text });
const rejected = (text) => expect(verdict(text).violations).toContain('customer_copy_compliance');

describe('email reply visit-pricing policy', () => {
  test.each([
    '$98 per visit', '$98 per-visit', '$98 per  visit', '$98 per‑visit', '$98 per–visit',
    '$98 for each visit', '$98 for every visit', '$98 for each scheduled visit',
    '$98 for each completed visit', '$98 for each scheduled pest-control visit',
    '$98\nfor each visit', '$98/visit', '98 dollars for each visit',
    '$98 a visit', '$98 each visit', '$98 per routine visit',
    '$98 per scheduled quarterly pest control visit',
    'the price for every visit is $98', 'each visit costs $98',
    'each visit costs 98 dollars', 'each scheduled visit is priced at $98',
    'each scheduled visit is priced at 98 dollars', 'each visit will cost $98',
    'each scheduled routine quarterly residential exterior preventive ongoing planned visit costs $98',
    '$98 per scheduled routine quarterly residential exterior preventive ongoing planned visit',
    'every scheduled visit is billed at $98', 'the rate per routine visit is $98',
    'Visits cost $98 each', 'Your scheduled visits are $98 each',
    'Visits will be billed at 98 dollars each', 'Visits cost $98 apiece',
    'Visits are billed $98 each', 'Visits are charged $98 apiece',
    'Visits are priced $98 each', 'Each visit is billed $98',
    'Each scheduled visit is priced $98',
    'Visits are **billed** $98 each',
    'The rate is per visit', 'Billing is per visit', 'You will be billed per visit',
    'Payments are per visit', 'You pay per visit', 'The fee will be per routine visit',
    'The $98 fee is per visit', 'Each visit has a $98 charge', 'We charge $98 on each visit',
  ])('rejects a visit-based pricing construction: %s', rejected);


  test.each([
    'USD 98 per visit', 'usd 98 per-visit', 'USD 98 for each scheduled visit',
    'Each visit costs USD 98', 'Visits are billed USD 98 each',
    '98 USD per visit', '98 bucks each visit', 'Each scheduled visit costs 98 bucks',
    '**USD 98** per visit', 'ＵＳＤ ９８ per‑visit',
  ])('rejects established monetary forms: %s', rejected);

  test.each([
    '', 'The next visit is scheduled.', 'Your $75 payment is scheduled.',
    'Waves Pest Control charges $98 per application.',
    'We review access for each visit.',
    'Your $98 payment is pending, and we will arrange a visit once it clears.',
    'Your price is $98 per application, and we review access for each visit.',
    'The price is $98 for each application and includes a visit.',
    'As per our last visit, the technician will check the side yard.',
    'We send one reminder per visit.', 'Your scheduled visits are pending.',
    'Visits include one reminder each.', 'USD 98 per application',
    '98 bucks per application', 'The USD 98 payment is pending; your visit is Friday.',
    'The notes contain an unmatched * character.',
  ])('preserves ordinary pricing and scheduling prose: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test('requires an explicit trusted boolean for commercial pricing', () => {
    for (const text of ['Service is $250 per visit.', 'Service is USD 250 per visit.']) {
      rejected(text);
      expect(verifyEmailReplyPricing({ text, commercialProposal: true }))
        .toEqual({ ok: true, violations: [] });
      for (const commercialProposal of ['true', 1, {}, null]) {
        expect(verifyEmailReplyPricing({ text, commercialProposal }).ok).toBe(false);
      }
    }
    rejected('This commercial proposal is $250 per visit.');
  });

  test('does not perform presentation, company-name, regulatory, or account-fact checks', () => {
    expect(verifyEmailReplyPricing()).toEqual({ ok: true, violations: [] });
    expect(verdict('Waves Lawn Care says the treatment is EPA-certified.')).toEqual({ ok: true, violations: [] });
    expect(verdict('Your balance is $999.')).toEqual({ ok: true, violations: [] });
  });
  test('screens nested emphasis while preserving valid price units', () => {
    rejected('**USD *98* per visit**');
    rejected('__Each visit costs **98 dollars**__');
    expect(verdict('**USD *98* per application**')).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Our per-visit price is $98', 'For each visit, the price is $98',
    'For every scheduled visit, we charge $98', 'Our per-visit fee is USD 98',
    '$98 (per visit)', '$98: per visit', '$98 — per visit',
    'USD 98 (for each visit)', '$1,298.50 per visit', '98.50 dollars per visit',
    'The rate per visit is $98', 'Our rate is per visit',
  ])('recognizes unit-first and punctuated pricing: %s', rejected);

  test.each([
    'Your balance is $98. For each visit, we send one reminder',
    'Your balance is $98.50. For each visit, we send one reminder',
    'Your balance is USD 1,098.50. Every visit gets a reminder',
    'Please rate each visit', 'You can rate a scheduled visit in the portal',
    'For each visit, we check your yard. The price is $98 per application.',
  ])('keeps separate sentences and feedback verbs outside pricing: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'We invoice per visit', 'You will be invoiced per visit', 'Your invoice is per visit',
    'Invoicing is per visit', 'Each visit is invoiced at $98',
    'Each visit costs only $98', 'Each visit is just $98', 'Each visit costs about $98',
    'Each visit will cost approximately USD 98', 'Visits are only $98 each',
    'Our fee is $98, per visit', 'The cost is $98, for each visit',
    '$98-120 per visit', '$98–120 per visit', 'USD 98-120 per visit', '$98 to 120 per visit',
    'Each visit costs $98-120', '98-120 dollars per visit',
    '$98 per 30-minute visit', '$98 for each 2-hour visit', 'Each 90-minute visit costs $98',
    'USD 98 per 1.5-hour visit', 'Rate per visit',
  ])('rejects invoice, qualified, range, and duration pricing: %s', rejected);

  test.each([
    'Your invoice is pending. Each visit gets a reminder.',
    'Each 90-minute visit includes an inspection.',
    'The cost is about $98 per application.', 'USD 98-120 per application',
    'Your balance is $98. Each 30-minute visit gets a reminder.',
    'Your invoice covers three applications. We send one reminder per visit.',
  ])('preserves unrelated invoice, range, and duration prose: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each(["USD `98` per visit","$98 per\\-visit","USD ``98`` per visit","**USD `98` per visit**"])('screens rendered code spans and escapes: %s', rejected);

  test.each(["USD `98` per application","USD ``98` per visit","The note contains an unmatched ` character.","The note contains a backslash before \\q."])('preserves valid units and unmatched formatting: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

});

test('screens rendered multiline code pricing without rejecting application prices', () => {
  expect(verifyEmailReplyPricing({ text: 'USD `98\n` per visit' }).ok).toBe(false);
  expect(verifyEmailReplyPricing({ text: 'USD `98\r\n` per application' }).ok).toBe(true);
});

test.each([
 'Each visit is billed separately', 'Every visit is invoiced on its own',
 'Each visit will be charged individually', 'The rate is 98 per visit',
 'We charge 98 per visit', 'Each visit costs 98', 'Each visit is billed at 98',
 'Our prices are per visit', 'Our fees are per visit', 'Rates are per visit',
 'Our amounts are per visit', 'Our costs are per visit',
])('rejects explicit amountless or numeric pricing: %s', (text) => {
 expect(verifyEmailReplyPricing({ text }).ok).toBe(false);
});
test.each([
 'Each visit is 98 minutes long', 'We take 98 photos per visit',
 'Our prices are per application', 'Each visit is billed per application',
 'The rate is 98 per application. We confirm each visit.',
])('preserves non-pricing numbers and application wording: %s', (text) => {
 expect(verifyEmailReplyPricing({ text }).ok).toBe(true);
});

test.each([
 'One visit costs $98', 'The first visit costs $98', '$98 for your next visit',
 'USD 98\\\nper visit', '$98\\\r\nfor each visit', 'Billing is\\\nper visit',
 'USD 98 per&#32;visit', 'USD **98\nper visit**',
])('screens rendered or definite visit prices: %s', (text) => {
 expect(verifyEmailReplyPricing({ text }).ok).toBe(false);
});
test.each(['Each visit runs 90 minutes', 'Each visit runs 30-45 minutes', 'Each visit runs 1.5 hours'])('allows visit duration: %s', (text) => {
 expect(verifyEmailReplyPricing({ text }).ok).toBe(true);
});
test('bounds malformed monetary-token matching', () => {
 expect(verifyEmailReplyPricing({ text: '$' + '1,'.repeat(50000) + 'x' }).ok).toBe(true);
});
