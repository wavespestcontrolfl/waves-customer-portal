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

});
