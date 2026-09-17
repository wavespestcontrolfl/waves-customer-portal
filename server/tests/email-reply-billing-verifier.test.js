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
  ])('preserves the bounded pay-a-visit idiom without a recipient: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Our technician will pay per visit.',
    'Our technician will pay you per visit.',
    'Please pay a visit to our office; payments are per visit.',
    'We pay a visit tomorrow, and each visit is paid separately.',
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
