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
  test('offers all four tiers but keeps Standard first so it stays the default', () => {
    // The portal panel auto-selects options[0]; Standard must lead so a generic
    // "add lawn care" quote does not silently default to the 4-application Basic.
    const all = variantsForService('lawn_care', 'lawn care please');
    const ids = all.map((o) => o.id);
    expect(ids[0]).toBe('lawn-standard');
    expect(ids).toEqual(['lawn-standard', 'lawn-enhanced', 'lawn-premium', 'lawn-basic']);
    const basic = all.find((o) => o.id === 'lawn-basic');
    expect(basic.tier).toBe('basic');
    expect(basic.lawnFreq).toBe(4);
    expect(basic.label).toBe('Lawn care — 4x applications/yr');
  });

  test('generic request returns the enhanced default only', () => {
    const generic = variantsForService('lawn_care', '', true);
    expect(generic.map((o) => o.id)).toEqual(['lawn-enhanced']);
  });

  test('premium tier-name / 12-application intent returns premium only', () => {
    expect(variantsForService('lawn_care', 'I want the premium lawn plan').map((o) => o.id)).toEqual(['lawn-premium']);
    expect(variantsForService('lawn_care', 'lawn with 12 applications').map((o) => o.id)).toEqual(['lawn-premium']);
  });

  test('explicit basic tier-name / 4-application intent returns basic only', () => {
    expect(variantsForService('lawn_care', 'just the basic lawn plan').map((o) => o.id)).toEqual(['lawn-basic']);
    expect(variantsForService('lawn_care', 'lawn with 4 applications').map((o) => o.id)).toEqual(['lawn-basic']);
  });

  test('a stray digit (sq ft / address) does NOT collapse the quote to a single tier', () => {
    expect(variantsForService('lawn_care', 'price lawn for 4,000 sq ft').map((o) => o.id))
      .toEqual(['lawn-standard', 'lawn-enhanced', 'lawn-premium', 'lawn-basic']);
    expect(variantsForService('lawn_care', 'lawn at 123 4th Ave').map((o) => o.id))
      .toEqual(['lawn-standard', 'lawn-enhanced', 'lawn-premium', 'lawn-basic']);
  });

  test('a bare cadence word referring to an existing service does NOT narrow the lawn tiers', () => {
    // "quarterly"/"monthly" here describe the existing pest plan, not the lawn add-on.
    expect(variantsForService('lawn_care', 'I have quarterly pest and want to add lawn care').map((o) => o.id))
      .toEqual(['lawn-standard', 'lawn-enhanced', 'lawn-premium', 'lawn-basic']);
    expect(variantsForService('lawn_care', 'I have monthly pest, add lawn care').map((o) => o.id))
      .toEqual(['lawn-standard', 'lawn-enhanced', 'lawn-premium', 'lawn-basic']);
  });
});
