/**
 * variantsForService — the quote options the customer-pricing AI offers.
 * Locks the rule that the deprecated lawn 'basic' tier is never surfaced
 * (it is hidden everywhere customer-facing; emitting it produced a
 * "Basic lawn care" option whose price fell back to Enhanced).
 *
 * Heavy module deps are mocked so this stays a pure-function test.
 */

jest.mock('../services/pricing-engine', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-05-29' }));

const { variantsForService } = require('../services/customer-pricing-ai');

describe('variantsForService — lawn_care', () => {
  test('never offers the deprecated basic tier', () => {
    const all = variantsForService('lawn_care', 'lawn care please');
    const ids = all.map((o) => o.id);
    const tiers = all.map((o) => o.tier);
    expect(ids).not.toContain('lawn-basic');
    expect(tiers).not.toContain('basic');
    expect(ids).toEqual(['lawn-standard', 'lawn-enhanced', 'lawn-premium']);
  });

  test('generic request returns the enhanced default only', () => {
    const generic = variantsForService('lawn_care', '', true);
    expect(generic.map((o) => o.id)).toEqual(['lawn-enhanced']);
  });

  test('premium/monthly/12 intent returns premium only — still no basic', () => {
    const prem = variantsForService('lawn_care', 'I want premium monthly 12 visits');
    expect(prem.map((o) => o.id)).toEqual(['lawn-premium']);
  });
});
