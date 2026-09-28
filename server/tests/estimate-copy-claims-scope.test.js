// The estimate guarantee scope (shared/estimate-copy-claims.cjs): one decision
// every copy surface reads, from the server's noGuaranteeClaims (termite or
// unclassifiable work) and noEstimateWideGuarantee (a rodent or commercial
// service) flags. docs/public-route-contracts.md, the guarantee rule.
const {
  copyAllowedInScope,
  guaranteeScope,
  withoutClaimsOutsideScope,
} = require('../../shared/estimate-copy-claims.cjs');
const { resolveOneTimeServiceCopy } = require('../services/estimate-one-time-copy');

describe('estimate guarantee scope', () => {
  test('the scope follows the two server decisions', () => {
    expect(guaranteeScope({ noGuaranteeClaims: true, noEstimateWideGuarantee: true })).toBe('none');
    expect(guaranteeScope({ noEstimateWideGuarantee: true })).toBe('satisfaction');
    expect(guaranteeScope({})).toBe('all');
  });

  test.each([
    ['Licensed & insured · Satisfaction guaranteed', true],
    ['Satisfaction guaranteed for the initial treatment only.', true],
    ['No long-term contract · Licensed & insured · Satisfaction guaranteed', false],
    ['Unlimited free callbacks', false],
    ['Written 30-day guarantee on the treated areas', false],
    ['Interceptor traps under bed legs for post-treatment monitoring', true],
  ])('in the satisfaction scope, "%s" is allowed: %s', (text, allowed) => {
    expect(copyAllowedInScope(text, 'satisfaction')).toBe(allowed);
  });

  test('a detail keeps its scope and, in the satisfaction scope, its satisfaction clause', () => {
    const detail = 'Exterior service. No long-term contract. Satisfaction guaranteed.';
    expect(withoutClaimsOutsideScope(detail, 'satisfaction')).toBe('Exterior service. Satisfaction guaranteed.');
    expect(withoutClaimsOutsideScope(detail, 'none')).toBe('Exterior service.');
    expect(withoutClaimsOutsideScope(detail, 'all')).toBe(detail);
  });

  test('a commercial one-time job states its scope but no guarantee or no-contract term', () => {
    const item = { service: 'bed_bug', label: 'Bed Bug Heat Treatment', amount: 650, warrantyEligible: true };
    const all = resolveOneTimeServiceCopy(item, { guaranteeScope: 'all' });
    const neutral = resolveOneTimeServiceCopy(item, { guaranteeScope: 'satisfaction' });
    expect(all.assurance).toMatch(/guarantee/i);
    expect(neutral.assurance).toBeNull();
    expect(neutral.includes.join(' ')).not.toMatch(/guarantee/i);
    expect(neutral.terms).not.toMatch(/contract/i);
    expect(neutral.includes).toContain('Interceptor traps under bed legs for post-treatment monitoring');
  });
});
