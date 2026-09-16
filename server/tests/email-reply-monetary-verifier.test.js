const {
  verifyEmailReplyMonetaryPricing,
} = require('../services/email/email-reply-monetary-verifier');

const verdict = (text, options = {}) => verifyEmailReplyMonetaryPricing({ text, ...options });
const rejected = (text) => expect(verdict(text).violations).toContain('customer_copy_compliance');

describe('email reply monetary visit-pricing policy', () => {
  test.each(['$98 for the 1st visit', '$98 per the 2nd visit'])(
    'consumes bounded numeric ordinal visit units: %s', rejected,
  );

  test.each([
    '$98 per the application', '$98 per each application', '$98 / the application',
    '$98 for the 2nd application', 'We credited $98 for application-related damage',
  ])('preserves application units and unrelated application compounds: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'There is a one-hundred-dollar visit fee.',
    'There is a one-hundred-and-twenty-eight-dollar visit fee.',
    'There is a one-hundred-twenty-eight-dollar visit fee.',
  ])('consumes fully hyphenated monetary adjectives: %s', rejected);

  test.each([
    "Please pay $98 at today's visit", "Please pay $98 on tomorrow's visit",
    "Please pay $98 at Monday's visit", "$98 was paid at yesterday's visit",
  ])('preserves recognized temporal possessive payment timing: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    '$98 pay-per-visit', '$98 billed-per-visit',
    'There is a ninety-eight-dollar visit fee.',
    'There is a 98-dollar visit.',
  ])('consumes compound unit and currency evidence: %s', rejected);

  test.each([
    '$98 pay-per-application', '$98 billed-per-application',
    '$98 for this application', '$98 for my next application',
    '$98 for their next application', '$98 for his next application',
    '$98 for her next application',
  ])('preserves recognized application units: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Each visit costs up to $98.',
    'Each visit is at least USD 98.',
    'Each visit costs as low as $98.',
    "Your visit's fee of $98 includes materials.",
    "Every scheduled visit's cost of USD 98 includes materials.",
    'For each visit, our price of $98 includes materials.',
    'Each visit costs between $90 and $120.',
    'For each visit, customers pay from USD 90 to USD 120.',
  ])('preserves supported price qualifiers, connectors and currency ranges: %s', rejected);

  test.each([
    'Each visit costs between 90 and 120 minutes.',
    'Each visit costs from 90 to 120 minutes.',
  ])('preserves complete measurement ranges: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Each visit would be $98', 'Every visit should be USD 98',
    'The price per visit may be $98', 'Per visit, it costs $98',
    'For each visit, customers pay USD 98',
    'For every visit, customers are charged $98',
  ])('rejects the carried-forward modal and fronted-subject cases: %s', rejected);

  test.each([
    'Each visit costs 98 minutes of technician time',
    'Visits cost 2 hours each', 'Each visit is priced at 98 points',
  ])('preserves measured quantities after pricing-shaped predicates: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each(['can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would'])(
    'uses the same recognized %s auxiliary across price clause orders', (modal) => {
      rejected(`Each visit ${modal} be $98`);
      rejected(`The price per visit ${modal} be $98`);
      rejected(`For each visit, customers ${modal} be charged $98`);
      expect(verdict(`Each visit ${modal} be 98 minutes long`)).toEqual({ ok: true, violations: [] });
    },
  );

  test('does not connect a balance to a visit unit across a clause boundary', () => {
    expect(verdict('Your balance is $98; per visit, we send a reminder'))
      .toEqual({ ok: true, violations: [] });
  });

  test.each([
    'There is a ninety-eight dollar visit fee.',
    'There is a one hundred dollar service-visit charge.',
  ])('retains written monetary evidence inside visit-fee phrases: %s', rejected);

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
    'First visit costs $98', '$98 for first visit', 'Visit costs $98',
  ])('rejects articleless visit prices: %s', rejected);

  test.each([
    'Price per visit: $98', 'Rate for every visit: USD 98',
    'Price per visit — $98',
  ])('rejects punctuated visit-price labels: %s', rejected);

  test.each([
    '$98 at each visit', 'You pay $98 at every visit',
    'USD 98 at every scheduled visit',
  ])('rejects amounts charged at a visit: %s', rejected);

  test.each([
    '$98 on each visit', 'You pay USD 98 on every scheduled visit',
    '$98 on any visit', '$98 on scheduled visits', '$98 on your routine visits',
  ])('rejects amounts charged on recurring visits: %s', rejected);

  test.each([
    'We charge each visit $98', 'We bill every visit USD 98',
  ])('rejects billing-verb visit objects followed by an amount: %s', rejected);

  test.each([
    'Each visit has a price of $98', 'Every visit has a cost of USD 98',
    'Every visit has an amount of $98',
  ])('rejects visit price nouns followed by an amount: %s', rejected);

  test.each([
    '$98 plus tax per visit', '$98 + tax per visit',
    'We charge $98 before tax per visit', '$98 plus fees for every visit',
  ])('rejects narrowly qualified amounts per visit: %s', rejected);

  test.each([
    '$98 per on-site visit', 'USD 98 for each in-home visit',
    'After-hours visit costs $98', '$98 for your after-hours visit',
  ])('rejects hyphenated modifiers beginning with stop words: %s', rejected);

  test.each([
    '$98 per 30 minute visit', 'USD 98 for each 2 hour visit',
    '$98 per 1.5 hour visit',
  ])('rejects unhyphenated duration-qualified visit prices: %s', rejected);

  test.each([
    'There is a $98 visit fee', 'A $98 service-visit charge applies',
    'The USD 98 scheduled visit cost applies',
  ])('rejects amounts followed by bounded visit-fee phrases: %s', rejected);

  test.each([
    'Each visit: $98', 'First visit — USD 98', 'Visit: $98',
  ])('rejects visit labels followed by amounts: %s', rejected);

  test.each([
    'Ninety-eight dollars per visit', 'One hundred dollars for each visit',
    'Each visit costs a hundred bucks', 'Each visit costs two hundred and fifty dollars',
  ])('rejects bounded written-number prices: %s', rejected);

  test.each([
    'The service costs 98 per visit', 'Pest control runs 98 per visit',
    'Our service is priced at 98 per visit', 'Our services cost 98 per visit',
    'The service was priced at 98 per visit',
    'Your service will be priced at 98 per visit',
    'Pest control will cost 98 per visit',
  ])('rejects bare amounts after explicit service pricing predicates: %s', rejected);

  test.each([
    'Visit fee: $98', 'Visit price is $98', 'Visit cost — USD 98',
  ])('rejects visit price-noun labels followed by amounts: %s', rejected);

  test.each([
    'Each visit costs between $90 and $120',
    'Each visit costs from $90 to $120',
    'The price per visit ranges from $90 to $120',
  ])('rejects bounded prose visit-price ranges: %s', rejected);

  test.each([
    '$98 is charged per visit', '$98 will be billed for each visit',
    'USD 98 is invoiced for every visit',
  ])('rejects passive amount-first visit pricing: %s', rejected);

  test.each([
    'Each visit would cost $98', 'Every visit should cost $98',
    'A visit may run USD 98', 'Each visit can cost $98',
    'A visit could run USD 98', 'Every visit might cost $98',
    'Each visit must cost USD 98', 'A visit shall run $98',
    'Every visit will run $98',
  ])('rejects bounded modal visit pricing: %s', rejected);

  test.each([
    'Visits are $98', 'Scheduled visits were billed at USD 98',
    'Your visits are priced at $98', 'Your visits are priced at 98',
    'Scheduled visits were billed at 98',
  ])('rejects plural visit prices without each/apiece suffixes: %s', rejected);

  test.each([
    '$98+ per visit', 'USD 98+ for each visit', '$98 and up per visit',
    '$98 or more per visit',
  ])('rejects minimum-price suffixes: %s', rejected);

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
    'We received $98 for your account before the next visit.',
    'Your $98 payment cleared before your next scheduled visit.',
    'We received USD 98 for your gate access ahead of the scheduled visit.',
    'The $98 balance is due before the next visit.',
    'Your account received the $98 payment after the prior visit and before the next visit.',
    '$98 per alpha beta gamma delta epsilon zeta eta theta iota visit',
    'Visit is scheduled for Friday.', 'Visit is 98 minutes long.',
    '$98 for your plan includes routine visits.',
    'USD 98 for your plan covers scheduled visits.',
    'Please pay $98 at your next visit.',
    'Please pay $98 on your next visit.', 'We received $98 on your last visit.',
    'Your $98 payment is due on the next scheduled visit.',
    'We received $98 plus a tax refund before your next visit.',
    'There is a $98 account fee before the next visit.',
    'A $98 service charge applies before the visit.',
    'Each visit: 98 minutes.', 'First visit - 90 minutes.',
    'Ninety-eight minutes per visit.', 'One hundred photos for each visit.',
    'Each visit costs a hundred minutes.',
    'The service takes 98 minutes per visit.',
    'Pest control uses 98 ounces per visit.',
    'Pest control runs 98 minutes per visit.',
    'The $98 payment posted 30 minutes before the visit.',
    'Our services take 98 minutes per visit.',
    'Visit fee details are in the portal.', 'Visit cost review is pending.',
    'Each visit lasts between 90 and 120 minutes.',
    'The visit window ranges from 9 to 11.',
    '$98 was charged on your last visit.',
    'A visit may run 90 minutes.', 'Visits are 90 minutes long.',
    'A visit can run 90 minutes.', 'Visits could run 2 hours.',
    'Your visits are 98 minutes long.',
    '$98+ photos were uploaded for each visit.',
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
