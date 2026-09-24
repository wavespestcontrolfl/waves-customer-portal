'use strict';

const { CHECK_NAMES } = require('../services/content/editorial-review-contracts');
const { validatePlanJson, validateReviewJson } = require('../services/content/editorial-review-validation');

describe('editorial review coverage validation', () => {
  test.each([undefined, 'unknown'])('rejects a coverage status of %s', (status) => {
    const sections = [{ sectionIndex: 0, answer: 'Give a direct answer.' }];
    const response = { pass: true, findings: [], sectionCoverage: [{ sectionIndex: 0, status }] };
    expect(validatePlanJson(response, sections)).toBe('plan_coverage');
  });

  test('allows numeric instructions to be classified as non-external', () => {
    const passage = 'Check 2 containers near your door.';
    const analysis = { claims: [{ id: 'C1', passage }], sections: [], passages: [] };
    const response = {
      claimInventoryComplete: true,
      checks: CHECK_NAMES.map((name) => ({ name, status: 'pass', findings: [] })),
      claims: [{ claimId: 'C1', passage, verdict: 'non_external', claimKind: 'non_external', sourceSuitability: 'not_applicable', sourceIndex: -1, sourceQuote: '', action: '' }],
      sectionCoverage: [],
      passageCoverage: [],
    };
    expect(validateReviewJson(response, analysis, passage, '', [])).toBeNull();
  });
});
