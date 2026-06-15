/**
 * variantsForService — the quote options the customer-pricing AI offers.
 * Locks the lawn ladder now that 'basic' (4 applications) is a sold tier that
 * prices distinctly — it is surfaced alongside Standard/Enhanced/Premium so a
 * customer asking for lawn care can reach the 4-application plan.
 *
 * Heavy module deps are mocked so this stays a pure-function test.
 */

jest.mock('../services/pricing-engine', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-05-29' }));

const { variantsForService } = require('../services/customer-pricing-ai');

describe('variantsForService — lawn_care', () => {
  test('offers all four tiers including basic (4 applications)', () => {
    const all = variantsForService('lawn_care', 'lawn care please');
    const ids = all.map((o) => o.id);
    const tiers = all.map((o) => o.tier);
    expect(ids).toEqual(['lawn-basic', 'lawn-standard', 'lawn-enhanced', 'lawn-premium']);
    expect(tiers).toEqual(['basic', 'standard', 'enhanced', 'premium']);
    const basic = all.find((o) => o.id === 'lawn-basic');
    expect(basic.lawnFreq).toBe(4);
    expect(basic.label).toBe('Basic lawn care');
  });

  test('generic request returns the enhanced default only', () => {
    const generic = variantsForService('lawn_care', '', true);
    expect(generic.map((o) => o.id)).toEqual(['lawn-enhanced']);
  });

  test('premium/monthly/12 intent returns premium only', () => {
    const prem = variantsForService('lawn_care', 'I want premium monthly 12 visits');
    expect(prem.map((o) => o.id)).toEqual(['lawn-premium']);
  });
});
