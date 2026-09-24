'use strict';

const { CHECK_NAMES } = require('../services/content/editorial-review-contracts');
const { validatePlanJson, validateReviewJson } = require('../services/content/editorial-review-validation');

function validateClaim(passage, claim, sources = []) {
  const analysis = { claims: [{ id: 'C1', passage }], sections: [], passages: [] };
  const response = {
    claimInventoryComplete: true,
    checks: CHECK_NAMES.map((name) => ({ name, status: 'pass', findings: [] })),
    claims: [{ claimId: 'C1', passage, action: '', ...claim }],
    sectionCoverage: [],
    passageCoverage: [],
  };
  return validateReviewJson(response, analysis, passage, '', sources);
}

describe('editorial review coverage validation', () => {
  test.each([undefined, 'unknown'])('rejects a coverage status of %s', (status) => {
    const sections = [{ sectionIndex: 0, answer: 'Give a direct answer.' }];
    const response = { pass: true, findings: [], sectionCoverage: [{ sectionIndex: 0, status }] };
    expect(validatePlanJson(response, sections)).toBe('plan_coverage');
  });

  test('allows numeric instructions to be classified as non-external', () => {
    const passage = 'Check 2 containers near your door.';
    expect(validateClaim(passage, { verdict: 'non_external', claimKind: 'non_external', sourceSuitability: 'not_applicable', sourceIndex: -1, sourceQuote: '' })).toBeNull();
  });

  test.each([
    'Dr. Example said, “Termites spread disease.”',
    'Termites cause $5 billion in property damage every year.',
  ])('rejects a deterministically external claim labeled non-external: %s', (passage) => {
    expect(validateClaim(passage, { verdict: 'non_external', claimKind: 'non_external', sourceSuitability: 'not_applicable', sourceIndex: -1, sourceQuote: '' }))
      .toBe('claim_kind_mismatch:C1');
  });

  test('rejects a trivial substring as a supporting source quote', () => {
    const passage = 'Termites cause $5 billion in property damage every year.';
    const sources = [{ excerpt: 'An unrelated sentence. Another unrelated sentence.' }];
    expect(validateClaim(passage, { verdict: 'supported', claimKind: 'quantitative', sourceSuitability: 'primary_authoritative', sourceIndex: 0, sourceQuote: '.' }, sources))
      .toBe('claim_quote:C1');
  });
});
