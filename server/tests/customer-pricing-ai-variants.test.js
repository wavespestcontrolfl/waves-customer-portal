/**
 * variantsForService — the quote options the customer-pricing AI offers.
 * Locks the lawn ladder now that 'basic' (4 applications) is RETIRED for new
 * sales (owner directive 2026-07-09): it is never offered, and "basic"/"4x"
 * prompts fall through to the full sold ladder instead of silently pricing a
 * different tier under the old label.
 *
 * Heavy module deps are mocked so this stays a pure-function test.
 */

jest.mock('../services/pricing-engine', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-05-29' }));

const { variantsForService } = require('../services/customer-pricing-ai');

const SOLD_LADDER = ['lawn-standard', 'lawn-enhanced', 'lawn-premium'];

describe('variantsForService — lawn_care', () => {
  test('offers the three sold tiers, Standard first so it stays the default, Basic never', () => {
    // The portal panel auto-selects options[0]; Standard must lead so a generic
    // "add lawn care" quote defaults to the 6-application plan.
    const all = variantsForService('lawn_care', 'lawn care please');
    const ids = all.map((o) => o.id);
    expect(ids[0]).toBe('lawn-standard');
    expect(ids).toEqual(SOLD_LADDER);
    expect(all.some((o) => o.tier === 'basic' || o.lawnFreq === 4)).toBe(false);
  });

  test('generic request returns the enhanced default only', () => {
    const generic = variantsForService('lawn_care', '', true);
    expect(generic.map((o) => o.id)).toEqual(['lawn-enhanced']);
  });

  test('premium tier-name / 12-application intent returns premium only', () => {
    expect(variantsForService('lawn_care', 'I want the premium lawn plan').map((o) => o.id)).toEqual(['lawn-premium']);
    expect(variantsForService('lawn_care', 'lawn with 12 applications').map((o) => o.id)).toEqual(['lawn-premium']);
  });

  test('explicit basic tier-name / 4-application intent returns the full sold ladder (quarterly retired)', () => {
    // The retired plan must neither be advertised nor silently priced as a
    // different tier under its old label — the customer sees what IS sold.
    expect(variantsForService('lawn_care', 'just the basic lawn plan').map((o) => o.id)).toEqual(SOLD_LADDER);
    expect(variantsForService('lawn_care', 'lawn with 4 applications').map((o) => o.id)).toEqual(SOLD_LADDER);
    expect(variantsForService('lawn_care', 'lawn with 4x applications/yr').map((o) => o.id)).toEqual(SOLD_LADDER);
  });

  test('Nx-suffix counts copied from the labels narrow to the right tier', () => {
    // "Nx applications/yr" is the customer-facing option label, so a copied
    // request must resolve to the matching tier rather than the 6x default.
    expect(variantsForService('lawn_care', 'lawn with 12x applications/yr').map((o) => o.id)).toEqual(['lawn-premium']);
    // Enhanced (9) narrows for both the bare and "x"-suffixed forms.
    expect(variantsForService('lawn_care', 'lawn with 9x applications/yr').map((o) => o.id)).toEqual(['lawn-enhanced']);
    expect(variantsForService('lawn_care', 'lawn with 9 applications').map((o) => o.id)).toEqual(['lawn-enhanced']);
    expect(variantsForService('lawn_care', 'enhanced lawn plan').map((o) => o.id)).toEqual(['lawn-enhanced']);
    // 6x is Standard, the default — it stays the full ladder with Standard first.
    expect(variantsForService('lawn_care', 'lawn with 6x applications/yr').map((o) => o.id))
      .toEqual(SOLD_LADDER);
  });

  test('a stray digit (sq ft / address) does NOT collapse the quote to a single tier', () => {
    expect(variantsForService('lawn_care', 'price lawn for 4,000 sq ft').map((o) => o.id))
      .toEqual(SOLD_LADDER);
    expect(variantsForService('lawn_care', 'lawn at 123 4th Ave').map((o) => o.id))
      .toEqual(SOLD_LADDER);
  });

  test('a bare cadence word referring to an existing service does NOT narrow the lawn tiers', () => {
    // "quarterly"/"monthly" here describe the existing pest plan, not the lawn add-on.
    expect(variantsForService('lawn_care', 'I have quarterly pest and want to add lawn care').map((o) => o.id))
      .toEqual(SOLD_LADDER);
    expect(variantsForService('lawn_care', 'I have monthly pest, add lawn care').map((o) => o.id))
      .toEqual(SOLD_LADDER);
  });
});
