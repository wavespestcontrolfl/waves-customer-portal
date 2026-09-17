const { verifyEmailReplyBilling } = require('../services/email/email-reply-billing-verifier');

const verdict = (text) => verifyEmailReplyBilling({ text });
const rejected = (text) => expect(verdict(text).violations).toContain('customer_copy_compliance');

describe('email reply amountless billing policy', () => {
  test.each(['We use pay-per-visit', 'You are billed-per-visit'])(
    'consumes embedded compound billing units: %s', rejected,
  );

  test.each(['We use pay-per-application', 'You are billed-per-application'])(
    'preserves compound application billing: %s', (text) => {
      expect(verdict(text)).toEqual({ ok: true, violations: [] });
    },
  );

  test.each([
    'The rate is per visit', 'Billing is per visit', 'You will be billed per visit',
    'Payments are per visit', 'You pay per visit', 'The fee will be per routine visit',
    'Our rate is per visit', 'Rate per visit',
    'Billing is per 30-minute scheduled visit',
    'Billing is per 30 minute visit', 'The fee is for each 2 hour visit',
    'Our rates are per 1.5 hours scheduled visit',
    'Billing occurs per visit', 'Charges apply per visit',
    'The billing frequency is per visit', 'Pricing applied per routine visit',
    'We bill you per visit', 'We invoice your account for every visit',
    'We pay you per visit', 'We pay you for each visit',
    'Billing is by the visit', 'We bill by visit',
    'pricing is on a visit-by-visit basis',
    'A per-visit fee applies', 'Your per-visit charge is due',
    'We use per-visit billing',
    'Billing is per on-site visit', 'Billing is per in-home visit',
    'Billing is per after-hours visit', 'Every in-home visit is billed separately',
    'Our fees are per scheduled routine quarterly residential exterior preventive ongoing planned visit',
    'We invoice per visit', 'You will be invoiced per visit', 'Your invoice is per visit',
    'Invoicing is per visit', 'Our prices are per visit', 'Our fees are per visit',
    'Rates are per visit', 'Our amounts are per visit', 'Our costs are per visit',
  ])('rejects an explicit amountless billing unit: %s', rejected);

  test.each([
    'Each visit is billed separately', 'Every visit is invoiced on its own',
    'Each visit will be charged individually', 'Our visits are billed separately',
    'Our visits were charged individually', 'Their visits are invoiced on their own',
    'Visits are billed separately', 'Routine visits are charged individually',
    'We bill separately for each visit', 'We charge individually on every visit',
    'We billed separately for each visit', 'We separately bill for each visit',
    'Each visit is separately billed', 'Routine visits were individually charged',
    'Each visit gets billed separately', 'Visits get charged individually',
    'Routine visits got invoiced separately', 'Each visit gets separately billed',
    'Each visit has been billed separately', 'Visits have been charged individually',
    'Routine visits had been individually invoiced',
    'You pay separately for each visit', 'Each visit is paid separately',
    'We separately bill you for each visit',
    'Every visit was individually paid',
    'Each visit has a separate charge', 'Every visit incurs a fee',
    'Each visit generates its own invoice', 'Visits incurred an individual charge',
    'Every visit generated a separate invoice',
    'Each visit can be billed separately', 'Visits may be charged individually',
    'Every visit should be invoiced on its own',
  ])('rejects unit-first separate billing: %s', rejected);

  test.each([
    'Each visit will incur a fee.',
    'Each visit may generate its own invoice.',
    'Each visit can have a separate charge.',
    'Our visits should incur an individual fee.',
    'Our visits might generate their own invoice.',
    'Every visit must have an individual invoice.',
  ])('rejects nominal billing predicates after a modal: %s', rejected);

  test.each([
    'Each visit will have a separate reminder.',
    'Each visit may generate its own report.',
    'Every visit should incur a review step.',
    'Each visit can be scheduled separately.',
  ])('preserves ordinary modal scheduling predicates: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Billing may apply per visit.', 'Charges should occur per visit.',
    'Payments will apply per routine visit.', 'Billing might occur for each visit.',
    'Each visit has its own charge.', 'Our visits have their own invoice.',
    'Each visit may have its own fee.', 'Visits had their own charge.',
    'We bill the customer per visit.', 'We invoice the client for every visit.',
    'We bill our customers per visit.', 'We charge a client per routine visit.',
    'We separately bill those clients for each visit.', 'We invoice this customer per visit.',
    'For each visit, rate: per visit.', 'Per visit, rate is per visit.',
    'A per-visit rate applies.',
    'Each visit is charged a separate fee.', 'Every visit is billed an individual charge.',
    'Our visits may be invoiced a separate fee.', 'Each visit has been billed an individual invoice.',
  ])('rejects bounded reviewed billing relationships: %s', rejected);

  test.each([
    'Billing may apply per application.', 'Charges should occur after your visit.',
    'Payments will apply to your account before each visit.',
    'Each visit has its own reminder.', 'Our visits may have their own report.',
    'Each visit has its reminder.',
    'We bill the customer after the visit.', 'We invoice our clients per application.',
    'We bill a customer the account balance before each visit.',
    'For each visit, rate how we did.', 'Per visit, rate how we did.',
    'For each visit, please rate how we did.', 'For each visit, you can rate how we did.',
    'Each visit is charged a separate reminder.', 'Every visit is billed an individual report.',
    'Each visit can be scheduled a separate reminder.',
  ])('preserves reviewed reminders, feedback, and application billing: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'We send per-visit payment reminders.',
    'Per visit, payment status is checked.',
    'We send a per-visit billing reminder.',
    'For each visit, invoice status is checked.',
  ])('preserves inverse billing modifiers on reminders and status: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Per visit, payment is due.',
    'A per-visit payment is required.',
    'For each visit, a reminder is sent and payment is per visit.',
    'We send per-visit payment reminders, and each visit has its own charge.',
  ])('keeps actual billing assertions blocked around reminder and status wording: %s', rejected);

  test.each([
    ['possessive incur fees', [
      'Each visit incurs its own fee.', 'Every visit incurred its own charge.',
      'Our visits may incur their own invoice.',
    ], ['Each visit incurs its own review step.', 'Every visit may incur its own reminder.']],
    ['quantified recipients', [
      'We invoice each customer per visit.', 'We bill every client for each visit.',
      'We charge any customer by visit.',
    ], ['We invoice each customer per application.', 'We bill every client after the visit.']],
    ['direct-object feedback', [
      'Per visit, rate is due.', 'For each visit, our rate applies.',
      'Rate per visit.',
    ], ['For each visit, rate your technician.', 'Per visit, rate the service.']],
    ['determined inverse nouns', [
      'Per visit, the fee is due.', 'For each visit, a payment is required.',
      'By visit, our price applies.',
    ], ['Per visit, the payment status is checked.', 'For each visit, a payment reminder is sent.']],
    ['emphatic and perfect connectors', [
      'Charges do apply per visit.', 'Billing does occur per visit.',
      'Fees have applied per visit.', 'Charges did apply per visit.',
    ], ['Charges do apply per application.', 'Fees have applied after the visit.']],
    ['separate adverbs before copulas', [
      'Each visit can separately be billed.', 'Every visit may individually be charged.',
      'Visits separately are invoiced.',
    ], ['Each visit can separately be scheduled.', 'Visits may individually be confirmed.']],
    ['negated connectors', [
      'Billing may not apply per visit.', 'Fees should not be per visit.',
      'Charges can never occur per visit.', 'Fees may not have applied per visit.',
    ], ['Billing may not apply per application.', 'Charges can never occur before your next visit.']],
    ['consecutive separators', [
      'Billing is: (per visit)', 'Fees: — per visit', 'Price — (per visit)',
    ], ['Billing is: (per application)', 'Billing is: pending; per visit, we send a reminder.']],
  ])('covers bounded %s with nonbilling controls', (_name, claims, controls) => {
    claims.forEach(rejected);
    controls.forEach((text) => expect(verdict(text)).toEqual({ ok: true, violations: [] }));
  });

  test.each([
    'Billing is' + String.fromCharCode(92, 10) + 'per visit',
    'Billing is per&#32;visit', '`Billing` is per visit',
    '**Our *fees* are per visit**', 'Billing: per visit',
    'Billing — per visit', 'Our fees, per routine visit',
    'Rate: per visit', 'Rates — per visit',
    'Billing is: per visit', 'Rate is — per routine visit',
    'Our fees are not per visit', 'Billing is never per visit',
    'Billing: not per visit', 'Rates are not per routine visit',
  ])('screens rendered amountless billing: %s', rejected);

  test.each([
    '', 'The next visit is scheduled.', 'Your $75 payment is scheduled.',
    'We review access for each visit.', 'We send one reminder per visit.',
    'Your scheduled visits are pending.', 'Visits include one reminder each.',
    'Please rate each visit.', 'You can rate a scheduled visit in the portal.',
    'Rate each visit in the portal.',
    'Please rate, for each visit, how we did.',
    'Our prices are per application.', 'Each visit is billed per application.',
    'The rate is 98 per application. We confirm each visit.',
    'Please pay the outstanding balance before our next visit.',
    'Please pay your outstanding balance before the next visit.',
    'Please pay the invoice before your next visit.',
    'Payment is the account balance due before the scheduled visit.',
    'Please pay the balance after we confirm access for your visit.',
    'Please pay the balance on your next visit.',
    'Please pay the balance in our office before your visit.',
    'You can pay on your next visit.', 'You may pay on the next scheduled visit.',
    'You can pay on our next visit.',
    'Our fees for your plan include routine visits.',
    'Our fees for your plan cover scheduled visits.',
    'This invoice is for your recent visit.',
    'Your invoice is for this visit.',
    'This payment is for your last visit.',
    'The charge is for the scheduled visit.',
    'Our fees are not per application.',
    'Billing is not for your recent visit.',
    'Each visit runs 30 minutes.', 'Each visit runs 1.5 hours.',
    'Billing occurs after the service is complete.',
    'Charges apply to your account after service.',
    'The billing frequency is monthly.',
    'Charges apply per application.',
    'The billing frequency is per application.',
    'Each visit has been scheduled separately.',
    'You pay separately for the account balance before your next visit.',
    'Each visit is paid in full.',
    'Each visit has a separate reminder.',
    'Every visit incurs a review step.',
    'Each visit generates its own report.',
    'We invoice your account after the visit.',
    'We pay you a visit tomorrow.', 'Please pay us a visit.',
    'Each visit can be scheduled separately.',
    'The notes contain an unmatched * or ` and a backslash before \\q.',
  ])('preserves ordinary and per-application prose: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Our technician will pay a visit tomorrow.',
    'Please pay a visit to our office.',
    'Our technician will pay you a courtesy visit tomorrow.',
    'Please pay us a quick visit.',
    'Our technician will pay a courtesy visit tomorrow.',
    'Please pay a quick visit to our office.',
    'Our technician will pay you a 30-minute courtesy visit tomorrow.',
    'Please pay a 30 minute visit to our office.',
  ])('preserves bounded pay-a-visit idioms with optional recipients and modifiers: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Our technician will pay per visit.',
    'Our technician will pay you per visit.',
    'Please pay a visit to our office; payments are per visit.',
    'We pay a visit tomorrow, and each visit is paid separately.',
    'Please pay us per courtesy visit.',
    'Please pay for each 30-minute visit.',
    'We bill you a courtesy visit.',
    'We charge a 30 minute visit.',
    'We pay you a courtesy visit tomorrow, and each visit is paid separately.',
  ])('keeps billing predicates blocked around pay-a-visit wording: %s', rejected);

  test.each([
    'You pay on each visit.', 'You pay on every scheduled visit.',
    'You pay on your visits.', 'Payments are on routine visits.',
    'Invoices are for your visits.', 'Billing is for every routine visit.',
  ])('keeps recurring on-visit billing in policy: %s', rejected);

  test.each([
    '$98 per visit', 'USD 98 for each scheduled visit', 'The rate is 98 per visit',
    'We charge 98 per visit', 'Each visit costs 98', 'Each visit is billed at 98',
    'Each visit is billed $98', 'Every visit is charged USD 98',
  ])('leaves amount-anchored clauses without amountless billing wording to the monetary sibling: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test('documents overlap when a monetary clause also contains amountless billing wording', () => {
    rejected('The $98 fee is per visit.');
  });

  test.each([
    'We refunded the $98 charge — each visit remains included at no additional cost.',
    'We refunded the charge, every visit remains included.',
    'Your payment posted: routine visits remain included.',
    'The fee was credited — (each visit is scheduled separately).',
  ])('does not attach a later visit subject across billing punctuation: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'The charge — for each visit.', 'Fees: — per visit.',
    'Billing is: (on every visit).', 'Payments, not per visit.',
    'We charge each visit.', 'We refunded the fee — each visit incurs its own charge.',
  ])('preserves explicit unit and independent billing relationships: %s', rejected);

  test('requires an explicit trusted boolean for the commercial exemption', () => {
    const text = 'Billing is per visit.';
    rejected(text);
    expect(verifyEmailReplyBilling({ text, commercialProposal: true }))
      .toEqual({ ok: true, violations: [] });
    for (const commercialProposal of ['true', 1, {}, null]) {
      expect(verifyEmailReplyBilling({ text, commercialProposal }).ok).toBe(false);
    }
  });

  test.each([
    [['Fees are applied per visit.', 'Billing will be applied per visit.', 'Charges were applied for each visit.', 'Fees are not applied per visit.'], ['Fees are applied per application.', 'Billing is applied after the visit.']],
    [['Each visit is charged a fee.', 'Every visit is billed an invoice.'], ['Each visit is charged a reminder.', 'Every visit is billed an individual report.']],
    [['Each visit will not be charged individually.', 'Each visit is not billed separately.', 'Visits may never be separately invoiced.'], ['Each visit will not be scheduled individually.', 'Visits are not billed in full.']],
    [['Each visit does incur a fee.', 'Every visit did have a separate charge.', 'Each visit has incurred a fee.', 'Visits have generated their own invoice.', 'Each visit has not incurred a fee.'], ['Each visit does incur a review step.', 'Visits have generated their own report.']],
    [['For each visit, rate is per visit.'], ['For each visit, rate your experience.', 'Per visit, rate the appointment.', 'For each visit, rate it.']],
    [['A per-visit payment reminder fee applies.', 'Per visit, payment reminder charges apply.', 'For each visit, the invoice status fee is due.'], ['A per-visit payment reminder applies.', 'For each visit, the invoice status is updated.']],
    [['Please pay us per quick visit.', 'We pay you for each visit.'], ['Our technician will pay you another visit tomorrow.', 'Please pay us one quick visit.', 'We pay them another courtesy visit.']],
    [['For each visit, we charge a fee.', 'Per visit, you will be billed.', 'For each visit, there is a separate fee.', 'Per visit, they do not charge a fee.', 'Per visit, you pay $98.'], ['For each visit, we send a reminder.', 'For each visit, there is a separate report.', 'Per visit, you will be reminded.']],
  ])('covers reviewed finite grammar with safe controls: %j', (blocked, permitted) => {
    blocked.forEach(rejected);
    permitted.forEach((text) => expect(verdict(text)).toEqual({ ok: true, violations: [] }));
  });

  test.each(['Billing is [per visit](https://example.com)', 'Our **fee is [per visit](https://example.com)**', 'Billing is <strong>per visit</strong>', 'Billing is &lt;strong&gt;per visit&lt;/strong&gt;', 'Billing is [per application](https://example.com)', 'Billing is [per visit](https://example.com/(help))'])('fails closed on rendered markup before exemption: %s', (text) => {
    for (const commercialProposal of [false, true]) expect(verifyEmailReplyBilling({ text, commercialProposal })).toEqual({ ok: false, violations: ['copy_markup'] });
  });
  test.each(['Billing is [ unmatched.', 'Your balance < the threshold.', 'Billing is <strong without a closing bracket.'])('preserves malformed delimiter barriers: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test('requires actual fronted billing while preserving access and application copy', () => {
    ['For each visit, we pay attention to your access instructions.', 'For each visit, we bill per application.', 'Per visit, you will be billed per application.', 'For each visit, we charge $98 per application.', 'For each visit, we charge a fee per application.', 'For each visit, we invoice your account $98 per application.'].forEach((text) => expect(verdict(text)).toEqual({ ok: true, violations: [] }));
    ['For each visit, we charge a fee.', 'Per visit, you will be billed.', 'For each visit, we bill your account.', 'Per visit, you pay $98.', 'For each visit, we bill per application; each visit incurs its own fee.'].forEach(rejected);
  });

  test.each(['the fee', 'our price', 'an invoice', 'payment reminder fee', 'invoice status fee'])('preserves application complements of fronted billing nouns: %s', (noun) => {
    for (const join of ['is', 'will be', 'does apply', 'is applied', ':', 'is $98']) {
      expect(verdict(`For each visit, ${noun} ${join} per application.`)).toEqual({ ok: true, violations: [] });
      rejected(`For each visit, ${noun} ${join} per visit.`);
    }
  });
  test('preserves application complements of active and passive fronted verbs', () => {
    ['we bill per application', 'we charge a fee per application', 'we invoice your account per application', 'you will be billed per application', 'we charge $98 per application'].forEach((predicate) => expect(verdict(`For each visit, ${predicate}.`)).toEqual({ ok: true, violations: [] }));
    rejected('For each visit, the fee is per application; each visit incurs its own fee.');
  });

  test.each(['you', 'them', 'the customer', 'each client'])('inspects application objects before recipient shortcuts: %s', (recipient) => {
    for (const object of ['a fee', 'a $98 fee', '$98 charge', 'an invoice $98', '$98', 'a fee of $98', 'a fee at $98', 'a separate $98 fee', '$98 individual charge']) {
      expect(verdict(`For each visit, we charge ${recipient} ${object} per application.`)).toEqual({ ok: true, violations: [] });
      rejected(`For each visit, we charge ${recipient} ${object} per visit.`);
    }
  });
  test('inspects application objects before passive and amount shortcuts', () => {
    ['you will be charged a fee per application', 'you are billed a $98 fee per application', 'you are charged $98 fee per application', 'we charge $98 fee per application'].forEach((predicate) => expect(verdict(`For each visit, ${predicate}.`)).toEqual({ ok: true, violations: [] }));
    rejected('For each visit, we charge you a fee per application; each visit incurs its own fee.');
    rejected('For each visit, you will be charged a fee.');
  });

  test.each([
    ['Each visit is charged a fee', 'Every visit is billed an invoice', 'Each visit will not be charged a fee', 'Each visit is separately billed a fee', 'Each visit can separately be billed a fee', 'Each visit is billed separately a fee', 'Each visit is billed on its own a fee'],
    ['Each visit incurs a fee', 'Every visit has a separate charge', 'Each visit generates its own invoice', 'Each visit does incur a fee', 'Each visit has not incurred a fee', 'Our visits may generate their own invoice'],
    ['We charge each visit a fee', 'We bill every visit a $98 fee'],
  ])('checks application objects across every visit-subject predicate family: %j', (...predicates) => {
    for (const predicate of predicates) {
      expect(verdict(`${predicate} per application.`)).toEqual({ ok: true, violations: [] });
      rejected(`${predicate}.`);
      rejected(`${predicate} per visit.`);
    }
  });
  test('does not let application fee objects shield independent visit billing', () => {
    rejected('Each visit incurs a fee per application; every visit is billed separately.');
  });

  test.each(['Each visit is billed separately', 'Each visit incurs a fee', 'We bill each visit', 'For each visit, the fee is', 'For each visit, we charge a fee', 'Per visit, you will be billed'])('requires affirmative application complements across billing paths: %s', (predicate) => {
    for (const negation of ['not', 'never']) rejected(`${predicate}, ${negation} per application.`);
    expect(verdict(`${predicate} per application.`)).toEqual({ ok: true, violations: [] });
  });
  test('keeps negated visit assertions blocked', () => {
    ['Each visit is not billed separately.', 'Each visit will not incur a fee.', 'For each visit, the fee is not per application.'].forEach(rejected);
  });

  test('preserves complement polarity in each bounded connector position', () => {
    ['not per application', 'may never apply per application', 'does not apply per application', 'is not per application', ': not per application'].forEach((complement) => rejected(`For each visit, the fee ${complement}.`));
  });
  test.each(['For each visit, the fee is $98', 'For each visit, we charge you $98', 'Each visit is separately billed a fee of $98', 'Each visit incurs a fee of $98', 'We bill each visit a fee of $98'])('supports punctuation after amounts without losing polarity: %s', (head) => {
    for (const [open, close] of [[' ', ''], [' (', ')'], [': ', ''], [' — ', '']]) {
      expect(verdict(`${head}${open}per application${close}.`)).toEqual({ ok: true, violations: [] });
      rejected(`${head}${open}per visit${close}.`);
      rejected(`${head}${open}not per application${close}.`);
    }
  });

  test.each([
    ['type', { text: {}, commercialProposal: true }, 'copy_type'],
    ['size', { text: 'x'.repeat(8193), commercialProposal: true }, 'copy_size'],
    ['tokens', { text: 'x '.repeat(513), commercialProposal: true }, 'copy_tokens'],
    ['format depth', {
      text: `${Array.from({ length: 80 }, (_, i) => (i % 2 ? '_' : '*')).join('')}Billing is per visit${Array.from({ length: 80 }, (_, i) => (i % 2 ? '_' : '*')).reverse().join('')}`,
      commercialProposal: true,
    }, 'copy_format_depth'],
  ])('fails closed on %s normalization failure', (_label, input, reason) => {
    expect(verifyEmailReplyBilling(input)).toEqual({ ok: false, violations: [reason] });
  });

  test('does not perform monetary, presentation, company, regulatory, or fact checks', () => {
    expect(verifyEmailReplyBilling()).toEqual({ ok: true, violations: [] });
    expect(verdict('Waves Lawn Care says the treatment is EPA-certified.')).toEqual({ ok: true, violations: [] });
    expect(verdict('Your balance is $999.')).toEqual({ ok: true, violations: [] });
  });
});
