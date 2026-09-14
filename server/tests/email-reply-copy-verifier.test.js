const { verifyEmailReplyCustomerCopy } = require('../services/email/email-reply-copy-verifier');

const verdict = (text) => verifyEmailReplyCustomerCopy({ text });
const rejected = (text) => expect(verdict(text).violations).toContain('customer_copy_compliance');

describe('email reply customer-copy policy', () => {
  test('exposes only a copy policy; no customer or account context is required', () => {
    expect(verdict('')).toEqual({ ok: true, violations: [] });
    expect(verdict('The next visit is scheduled.')).toEqual({ ok: true, violations: [] });
    expect(verdict('Your $75 payment is scheduled.')).toEqual({ ok: true, violations: [] });
  });

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
  ])('rejects a visit-based pricing construction: %s', rejected);

  test.each([
    'Waves Lawn & Pest', 'Waves Lawn and Pest', 'Waves  Lawn & Pest',
    'Waves Lawn-Pest', 'Waves Lawn + Pest', 'Waves Lawn/Pest',
    'Waves Pest & Lawn', 'Waves Pest Control and Lawn', 'Waves Pest / Lawn',
    'Waves Pest Control & Lawn Care',
  ])('rejects a retired brand name: %s', (brand) => rejected(`You contacted ${brand}.`));

  test.each([
    'Your home is pest-free.', 'Your home is pest‑free.',
    'Your home is now clear.', 'The problem is resolved.',
    'The treatment is pet-safe.', 'The product is EPA-approved.',
    'The treatment is EPA-certified.', 'The treatment is EPA certified.',
    'The treatment is EPAcertified.',
    'The treatment is certified by the EPA.',
    'The EPA granted approval for this treatment.',
    'You can return to the treated area after 30 minutes.',
  ])('rejects canonical and EPA customer-copy claims: %s', rejected);

  test.each([
    'Waves Pest Control charges $98 per application.',
    'The product is EPA-registered.',
    'The product is EPA-exempt.',
    'The technician will confirm when the application is dry.',
    'We review access for each visit.',
    'Your $98 payment is pending, and we will arrange a visit once it clears.',
    'Your price is $98 per application, and we review access for each visit.',
    'The price is $98 for each application and includes a visit.',
    'As per our last visit, the technician will check the side yard.',
    'We send one reminder per visit.',
    'The Waves Pest Control lawn team will follow up.',
  ])('accepts a non-violating copy construction: %s', (copy) => {
    expect(verdict(copy)).toEqual({ ok: true, violations: [] });
  });
});
