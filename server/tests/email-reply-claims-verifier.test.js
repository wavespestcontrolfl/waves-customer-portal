const { verifyEmailReplyClaims } = require('../services/email/email-reply-claims-verifier');

const verdict = (text) => verifyEmailReplyClaims({ text });
const rejected = (text) => expect(verdict(text).violations).toContain('customer_copy_compliance');

describe('email reply report and regulatory claims policy', () => {
  test('exposes only a claims policy; no customer or account context is required', () => {
    expect(verdict('')).toEqual({ ok: true, violations: [] });
    expect(verdict('The next visit is scheduled.')).toEqual({ ok: true, violations: [] });
    expect(verdict('Your $75 payment is scheduled.')).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'Your home is pest-free.', 'Your home is pest‑free.',
    'Your home is pest\\-free.',
    'Your home is pest&#45;free.', 'Your home is pest&#x2D;free.',
    'Your home is pest&hyphen;free.',
    'Your home is pest\nfree.', 'Your home is pest\tfree.',
    'Your home is pest-***free***.', 'No ___infestation___ remains.',
    'Your home is pest-**free**.', 'Your home is pest-*free*.',
    'No **infestation** remains.', 'No __infestation__ remains.',
    'The product is EPA-**approved**.',
    'Your home is now clear.', 'The problem is resolved.',
    'The treatment is pet-safe.', 'The product is EPA-approved.',
    'The product is EPA — approved.', 'The product is EPA &mdash; approved.',
    'The treatment is EPA\\-certified.',
    'The treatment is EPA-certified.', 'The treatment is EPA certified.',
    'The treatment is EPAcertified.',
    'The treatment is certified by the EPA.',
    'The treatment is certified by the U.S. EPA.',
    'The treatment has certification from US EPA.',
    'This treatment has certification from the EPA.', 'This carries certification by EPA.',
    'The EPA has certified this treatment.', 'This product carries EPA certification.',
    'The EPA recently certified this treatment.',
    'The EPA has formally certified this treatment.',
    'These products carry EPA certifications.',
    'The certifications are from EPA.',
    "This treatment has the EPA's certification.", 'This treatment has the EPA’s certification.',
    "This treatment has the EPA's official certification.",
    'This treatment has the EPA’s formal certification.',
    "This treatment has the EPA's full certification.",
    "This treatment was EPA's officially certified option.",
    'The treatment is EPA-`certified`.',
    'The treatment is EPA-``certified``.',
    'The treatment is **EPA-`certified`**.',
    'The EPA granted approval for this treatment.',
    'You can return to the treated area after 30 minutes.',
  ])('rejects a report or regulatory claim: %s', rejected);

  test.each([
    'The product is EPA-registered.',
    'The product is EPA-exempt.',
    'The product is EPA&#45;registered.',
    'The product is EPA &mdash; exempt.',
    'The product is EPA\\-registered.',
    'The product is EPA\\-exempt.',
    'The product is EPA-`registered`.',
    'The product is EPA-``registered``.',
    'The notes quote EPA-``certified` with unequal markers.',
    'The product is EPA-`exempt`.',
    'The technician will confirm when the application is dry.',
    'The EPA recently registered this product.',
    'The certification paperwork came from the vendor.',
    'The pest\ninspection is scheduled.',
    'AT&amp;T appears in the account note.',
    'There is no **new** infestation claim in this scheduling note.',
    'The notes contain an unmatched * character.',
    'The notes contain an unmatched ` character.',
    'The notes preserve a backslash before a nonpunctuation \\word.',
    'The notes quote EPA\\certified with a nonpunctuation escape.',
    'The notes quote EPA-`certified with an unmatched marker.',
  ])('accepts non-violating report and regulatory copy: %s', (copy) => {
    expect(verdict(copy)).toEqual({ ok: true, violations: [] });
  });

  test('does not absorb pricing or company-name sibling policies', () => {
    expect(verdict('Service is $98 per visit.')).toEqual({ ok: true, violations: [] });
    expect(verdict('You contacted Waves Lawn & Pest.')).toEqual({ ok: true, violations: [] });
  });

  test('conservatively retains the canonical subject-agnostic outcome ban', () => {
    rejected('The billing problem is resolved.');
  });
  test('screens nested emphasis while preserving allowed regulatory wording', () => {
    rejected('**The product is EPA-*certified*.**');
    rejected('Your home is pest-**_free_**.');
    rejected("__This treatment has the **EPA's certification**.__");
    expect(verdict('**The product is EPA-*registered*.**')).toEqual({ ok: true, violations: [] });
  });
});

test('screens rendered multiline code claims while preserving registered wording', () => {
  expect(verifyEmailReplyClaims({ text: 'The treatment has EPA `certification\n`.' }).ok).toBe(false);
  expect(verifyEmailReplyClaims({ text: 'The treatment is EPA `registered\r\n`.' }).ok).toBe(true);
});
