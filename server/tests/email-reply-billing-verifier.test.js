const { verifyEmailReplyBilling } = require('../services/email/email-reply-billing-verifier');

const verdict = (text) => verifyEmailReplyBilling({ text });
const rejected = (text) => expect(verdict(text).violations).toContain('customer_copy_compliance');

describe('email reply amountless billing policy', () => {
  test.each([
    'The rate is per visit', 'Billing is per visit', 'You will be billed per visit',
    'Payments are per visit', 'You pay per visit', 'The fee will be per routine visit',
    'Our rate is per visit', 'Rate per visit',
    'Billing is per 30-minute scheduled visit',
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
  ])('rejects unit-first separate billing: %s', rejected);

  test.each([
    'Billing is' + String.fromCharCode(92, 10) + 'per visit',
    'Billing is per&#32;visit', '`Billing` is per visit',
    '**Our *fees* are per visit**', 'Billing: per visit',
    'Billing — per visit', 'Our fees, per routine visit',
    'Rate: per visit', 'Rates — per visit',
    'Billing is: per visit', 'Rate is — per routine visit',
  ])('screens rendered amountless billing: %s', rejected);

  test.each([
    '', 'The next visit is scheduled.', 'Your $75 payment is scheduled.',
    'We review access for each visit.', 'We send one reminder per visit.',
    'Your scheduled visits are pending.', 'Visits include one reminder each.',
    'Please rate each visit.', 'You can rate a scheduled visit in the portal.',
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
    'The notes contain an unmatched * or ` and a backslash before \\q.',
  ])('preserves ordinary and per-application prose: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'You pay on each visit.', 'You pay on every scheduled visit.',
    'You pay on your visits.', 'Payments are on routine visits.',
    'Invoices are for your visits.', 'Billing is for every routine visit.',
  ])('keeps recurring on-visit billing in policy: %s', rejected);

  test.each([
    '$98 per visit', 'USD 98 for each scheduled visit', 'The rate is 98 per visit',
    'We charge 98 per visit', 'Each visit costs 98', 'Each visit is billed at 98',
    'Each visit is billed $98', 'Every visit is charged USD 98',
  ])('leaves monetary clauses to the monetary sibling: %s', (text) => {
    expect(verdict(text)).toEqual({ ok: true, violations: [] });
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
