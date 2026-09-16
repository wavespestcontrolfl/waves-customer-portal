const {
  verifyEmailReplyMonetaryPricing,
} = require('../services/email/email-reply-monetary-verifier');

const verdict = (text, options = {}) => verifyEmailReplyMonetaryPricing({ text, ...options });
const rejected = (text) => expect(verdict(text).violations).toContain('customer_copy_compliance');

describe('email reply monetary visit-pricing policy', () => {
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
    'Each scheduled visit is priced $98', 'Visits are **billed** $98 each',
    'The $98 fee is per visit', 'Each visit has a $98 charge',
    'We charge $98 on each visit',
  ])('rejects an explicit monetary visit price: %s', rejected);

  test.each([
    'USD 98 per visit', 'usd 98 per-visit', 'USD 98 for each scheduled visit',
    'Each visit costs USD 98', 'Visits are billed USD 98 each',
    '98 USD per visit', '98 bucks each visit', 'Each scheduled visit costs 98 bucks',
    '**USD 98** per visit', 'ＵＳＤ ９８ per‑visit',
  ])('rejects established monetary forms: %s', rejected);

  test.each([
    'Our per-visit price is $98', 'For each visit, the price is $98',
    'For every scheduled visit, we charge $98', 'Our per-visit fee is USD 98',
    '$98 (per visit)', '$98: per visit', '$98 — per visit',
    'USD 98 (for each visit)', '$1,298.50 per visit', '98.50 dollars per visit',
    'The rate per visit is $98', 'Our fee is $98, per visit',
    'The cost is $98, for each visit', '$98-120 per visit', '$98–120 per visit',
    'USD 98-120 per visit', '$98 to 120 per visit', 'Each visit costs $98-120',
    '98-120 dollars per visit', '$98 per 30-minute visit',
    '$98 for each 2-hour visit', 'Each 90-minute visit costs $98',
    'USD 98 per 1.5-hour visit', 'Each visit is invoiced at $98',
    'Each visit costs only $98', 'Each visit is just $98',
    'Each visit costs about $98', 'Each visit will cost approximately USD 98',
    'Visits are only $98 each', 'One visit costs $98',
    'The first visit costs $98', '$98 for your next visit',
  ])('rejects unit-first, punctuated, ranged, and duration-qualified prices: %s', rejected);

  test.each([
    'The rate is 98 per visit', 'We charge 98 per visit', 'Each visit costs 98',
    'Each visit is billed at 98', 'Visits cost 98 each', 'Visits are billed 98 each',
  ])('rejects bare numbers only with explicit pricing context: %s', rejected);

  test.each([
    "Each visit's price is$98", "Every scheduled visit's cost was USD 98",
    "Your visit's fee is$98", "Our visits' fees are$98",
    'Your visit’s fee is$98', 'Their scheduled visits’ prices will be $98',
  ])('rejects possessive singular and plural visit prices: %s', rejected);

  test.each([
    'USD `98` per visit', '$98 per\\-visit', 'USD ``98`` per visit',
    '**USD `98` per visit**', 'USD `98\n` per visit', 'USD 98\\\nper visit',
    '$98\\\r\nfor each visit', 'USD 98 per&#32;visit', 'USD **98\nper visit**',
    '**USD *98* per visit**', '__Each visit costs **98 dollars**__',
  ])('screens rendered pricing: %s', rejected);

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
    'Your balance is $98. For each visit, we send one reminder',
    'Your balance is USD 1,098.50. Every visit gets a reminder',
    'Please rate each visit', 'You can rate a scheduled visit in the portal',
    'For each visit, we check your yard. The price is $98 per application.',
    'Each visit is 98 minutes long', 'We take 98 photos per visit',
    'The rate is 98 per application. We confirm each visit.',
    'Each visit runs 90 minutes', 'Each visit runs 30-45 minutes',
    'Each visit runs 1.5 hours', 'USD `98` per application',
    'USD ``98` per visit', 'The note contains an unmatched ` character.',
    'The notes contain an unmatched * character.', 'The note contains a backslash before \\q.',
  ])('preserves application prices and unrelated visit prose: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'The rate is per visit', 'Billing is per visit', 'You will be billed per visit',
    'Payments are per visit', 'You pay per visit', 'The fee will be per routine visit',
    'We invoice per visit', 'You will be invoiced per visit', 'Your invoice is per visit',
    'Invoicing is per visit', 'Rate per visit', 'Each visit is billed separately',
    'Every visit is invoiced on its own', 'Each visit will be charged individually',
    'Our prices are per visit', 'Our fees are per visit', 'Rates are per visit',
  ])('leaves amountless pricing to its sibling policy: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test('requires an explicit trusted boolean for the commercial exemption', () => {
    const text = 'Service is USD 250 per visit.';
    rejected(text);
    expect(verdict(text, { commercialProposal: true })).toEqual({ ok: true, violations: [] });
    for (const commercialProposal of ['true', 1, {}, null]) {
      expect(verdict(text, { commercialProposal }).ok).toBe(false);
    }
    rejected('This commercial proposal is $250 per visit.');
  });

  test.each([
    [null, 'copy_type'],
    ['a'.repeat(8193), 'copy_size'],
    ['a '.repeat(513), 'copy_tokens'],
  ])('fails closed when normalization rejects %#', (text, reason) => {
    expect(verdict(text)).toEqual({ ok: false, violations: [reason] });
    expect(verdict(text, { commercialProposal: true })).toEqual({ ok: false, violations: [reason] });
  });

  test('fails closed when formatting exceeds eight normalization passes', () => {
    const wrap = Array.from({ length: 80 }, (_, index) => (index % 2 ? '_' : '*'));
    const text = wrap.join('') + 'USD 98 per visit' + [...wrap].reverse().join('');
    expect(verdict(text)).toEqual({ ok: false, violations: ['copy_format_depth'] });
    expect(verdict(text, { commercialProposal: true }))
      .toEqual({ ok: false, violations: ['copy_format_depth'] });
  });

  test('bounds malformed monetary matching within the raw byte limit', () => {
    const text = '$' + '1,'.repeat(4095) + 'x';
    expect(Buffer.byteLength(text, 'utf8')).toBe(8192);
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test('does not perform presentation, company-name, regulatory, or account-fact checks', () => {
    expect(verifyEmailReplyMonetaryPricing()).toEqual({ ok: true, violations: [] });
    expect(verdict('Waves Lawn Care says the treatment is EPA-certified.')).toEqual({ ok: true, violations: [] });
    expect(verdict('Your balance is $999.')).toEqual({ ok: true, violations: [] });
  });
});
