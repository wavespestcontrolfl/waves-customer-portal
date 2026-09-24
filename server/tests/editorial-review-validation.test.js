'use strict';

const { validatePlanJson } = require('../services/content/editorial-review-validation');

describe('editorial review coverage validation', () => {
  test.each([undefined, 'unknown'])('rejects a coverage status of %s', (status) => {
    const sections = [{ sectionIndex: 0, answer: 'Give a direct answer.' }];
    const response = { pass: true, findings: [], sectionCoverage: [{ sectionIndex: 0, status }] };
    expect(validatePlanJson(response, sections)).toBe('plan_coverage');
  });
});
