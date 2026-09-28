// The estimate guarantee scope (shared/estimate-copy-claims.cjs): one decision
// every copy surface reads, from the server's noGuaranteeClaims (termite or
// unclassifiable work) and noEstimateWideGuarantee (a rodent or commercial
// service) flags. docs/public-route-contracts.md, the guarantee rule.
const {
  copyAllowedInScope,
  guaranteeScope,
  withoutClaimsOutsideScope,
} = require('../../shared/estimate-copy-claims.cjs');
const { serviceGuaranteeScope } = require('../../shared/estimate-copy-claims.cjs');
const { resolveOneTimeServiceCopy } = require('../services/estimate-one-time-copy');
const { serviceRowTermsScope } = require('../routes/estimate-public');

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

  // Owner ruling 2026-09-27: each service carries its own terms; a line
  // covering the whole estimate needs every service to carry it.
  test('a service states its own terms within the estimate scope', () => {
    expect(serviceGuaranteeScope('satisfaction', 'all')).toBe('all');
    expect(serviceGuaranteeScope('all', 'satisfaction')).toBe('satisfaction');
    expect(serviceGuaranteeScope('none', 'all')).toBe('none');
    expect(serviceGuaranteeScope('satisfaction', undefined)).toBe('satisfaction');
    expect(serviceGuaranteeScope('all', 'interior_only')).toBe('all');
  });

  test.each([
    ['a pest section beside a rodent one', { key: 'pest_control', memberKeys: ['pest_control'] }, 'all'],
    ['a rodent section', { key: 'rodent_bait', memberKeys: ['rodent_bait'] }, 'satisfaction'],
    ['a commercial pest section', { key: 'commercial_pest', memberKeys: ['commercial_pest'] }, 'satisfaction'],
    ['a pest + lawn bundle section', { key: 'bundle', memberKeys: ['pest_control', 'lawn_care'] }, 'all'],
    ['a pest + rodent bundle section', { key: 'bundle', memberKeys: ['pest_control', 'rodent_bait'] }, 'satisfaction'],
    ['a palm section', { key: 'palm_injection', memberKeys: ['palm_injection'] }, 'all'],
  ])('%s carries its own terms on a satisfaction-scope estimate', (_label, section, expected) => {
    expect(serviceRowTermsScope('satisfaction', section, { recurring: true })).toBe(expected);
  });

  test.each([
    ['a residential bed bug job', { service: 'bed_bug', label: 'Bed Bug Heat Treatment', amount: 650 }, 'all'],
    ['a rodent exclusion job', { service: 'rodent_exclusion', label: 'Full Rodent Exclusion', amount: 900 }, 'satisfaction'],
    ['an engine-marked commercial job', { service: 'bed_bug', label: 'Bed Bug Heat Treatment', amount: 650, isCommercial: true }, 'satisfaction'],
  ])('%s carries its own terms', (_label, row, expected) => {
    expect(serviceRowTermsScope('satisfaction', row)).toBe(expected);
  });

  test('commercial scope, termite work and non-service rows', () => {
    const pest = { key: 'pest_control', memberKeys: ['pest_control'] };
    expect(serviceRowTermsScope('satisfaction', pest, { recurring: true, commercial: true })).toBe('satisfaction');
    expect(serviceRowTermsScope('none', pest, { recurring: true })).toBe('none');
    expect(serviceRowTermsScope('all', { service: 'waveguard_setup', label: 'WaveGuard Setup', amount: 99 })).toBeNull();
    expect(serviceRowTermsScope('satisfaction', { key: 'bundle', memberKeys: [] }, { recurring: true })).toBeNull();
  });
});
