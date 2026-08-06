process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Add-on plan acceptance for existing plan customers (owner case
// 2026-08-05): an existing quarterly-pest customer accepted a bi-monthly tree &
// shrub estimate and three things went wrong —
//   1. the customer-wide existing-appointment fallback adopted the PEST visit
//      as the add-on's first visit (slot picker suppressed, pest per-visit
//      price overwritten with the T&S price, and the duplicate-series guard
//      then saw the pest family so no T&S series was seeded), and
//   2. tier activation counted only the estimate's own lines, activating
//      Bronze/0% instead of the quoted combined Silver/10%.
// These tests pin the family-scoped adoption guard and the combined-tier
// count that fix them.

const {
  estimateFamilyKeysForAdoption,
  appointmentMatchesEstimateFamily,
} = require('../routes/estimate-public');
const {
  tierQualifyingRecurringServiceKeys,
  combinedTierQualifyingCount,
  determineTier,
  isMembershipTierUpgrade,
} = require('../services/estimate-converter');

const treeShrubEstimateData = {
  result: {
    recurring: {
      services: [{
        name: 'Bi-Monthly Tree & Shrub Care Service',
        service: 'tree_shrub',
        serviceKey: 'tree_shrub_program',
        frequency: 'bi_monthly',
        monthly: 32.87,
        visitsPerYear: 6,
        selected: true,
        isSelected: true,
      }],
    },
  },
};

describe('combined membership tier on add-on accepts', () => {
  test('an existing pest customer accepting tree & shrub activates the combined Silver tier', () => {
    const estimateKeys = tierQualifyingRecurringServiceKeys(
      treeShrubEstimateData.result.recurring.services,
    );
    expect(estimateKeys).toEqual(['tree_shrub']);

    const combined = combinedTierQualifyingCount(estimateKeys, ['pest_control']);
    expect(combined).toBe(2);
    expect(determineTier(combined, true)).toEqual({ tier: 'Silver', discount: 0.10 });
  });

  test('a same-family re-quote never double-counts the family it re-prices', () => {
    expect(combinedTierQualifyingCount(['pest_control'], ['pest_control'])).toBe(1);
    expect(determineTier(1, true).tier).toBe('Bronze');
  });

  test('three distinct families across prior and added reach Gold', () => {
    expect(determineTier(
      combinedTierQualifyingCount(['mosquito'], ['pest_control', 'lawn_care']),
      true,
    ).tier).toBe('Gold');
  });

  test('palm injection and rodent bait stations never contribute a qualifying key', () => {
    expect(tierQualifyingRecurringServiceKeys([
      { name: 'Palm Tree Injections', service: 'palm_injection', selected: true },
      { name: 'Rodent Bait Stations', service: 'rodent_bait', selected: true },
    ])).toEqual([]);
  });
});

describe('tier-upgrade review gating (persisted-tier comparison, codex r2)', () => {
  test('an accept that moves the STORED tier up is an upgrade', () => {
    expect(isMembershipTierUpgrade('Bronze', 'Silver')).toBe(true);
    // Bronze-stamped legacy customer whose rows already supported Silver:
    // the accept that actually raises the stored tier still alerts.
    expect(isMembershipTierUpgrade('bronze', 'Silver')).toBe(true);
    expect(isMembershipTierUpgrade(null, 'Bronze')).toBe(true);
    expect(isMembershipTierUpgrade('One-Time', 'Silver')).toBe(true);
    expect(isMembershipTierUpgrade('Commercial', 'Silver')).toBe(true);
  });

  test('same tier or a downgrade is never an "upgrade"', () => {
    expect(isMembershipTierUpgrade('Silver', 'Silver')).toBe(false);
    // Stale-stamped Gold whose rows only support Silver: downgrade, no alert.
    expect(isMembershipTierUpgrade('Gold', 'Silver')).toBe(false);
    expect(isMembershipTierUpgrade('Platinum', 'Gold')).toBe(false);
    expect(isMembershipTierUpgrade('Silver', 'none')).toBe(false);
  });
});

describe('family-scoped existing-appointment adoption', () => {
  test("a tree & shrub estimate's family keys never match an upcoming pest visit", () => {
    const familyKeys = estimateFamilyKeysForAdoption(treeShrubEstimateData);
    expect([...familyKeys]).toEqual(['tree_shrub']);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Quarterly Pest Control Service' },
      familyKeys,
    )).toBe(false);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Bi-Monthly Tree & Shrub Care Service' },
      familyKeys,
    )).toBe(true);
  });

  test('rows without a resolvable service family never stand in for a first visit', () => {
    const familyKeys = estimateFamilyKeysForAdoption(treeShrubEstimateData);
    expect(appointmentMatchesEstimateFamily({ service_type: '' }, familyKeys)).toBe(false);
    expect(appointmentMatchesEstimateFamily({}, familyKeys)).toBe(false);
  });

  test('combined labels classify canonically: "Pest & Rodent Control" is pest-primary (codex r1)', () => {
    const pestData = {
      result: {
        recurring: {
          services: [{
            name: 'Quarterly Pest Control Service',
            service: 'pest_control',
            frequency: 'quarterly',
            selected: true,
            isSelected: true,
          }],
        },
      },
    };
    const familyKeys = estimateFamilyKeysForAdoption(pestData);
    // The seeder's serviceKeyFor treats a pest-led combined label as
    // pest_control; the route-side name parser used to call it rodent and
    // reject a genuinely adoptable visit.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Pest & Rodent Control' },
      familyKeys,
    )).toBe(true);
    // Rodent-led names stay rodent-family and never match a pest estimate.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Rodent Bait Station Monitoring' },
      familyKeys,
    )).toBe(false);
  });

  test('a pest estimate still adopts an upcoming pest visit (same-family fallback preserved)', () => {
    const pestData = {
      result: {
        recurring: {
          services: [{
            name: 'Quarterly Pest Control Service',
            service: 'pest_control',
            frequency: 'quarterly',
            selected: true,
            isSelected: true,
          }],
        },
      },
    };
    const familyKeys = estimateFamilyKeysForAdoption(pestData);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Quarterly Pest Control Service' },
      familyKeys,
    )).toBe(true);
  });

  test('an estimate with no resolvable services offers no adoption at all', () => {
    expect(estimateFamilyKeysForAdoption(null).size).toBe(0);
    expect(estimateFamilyKeysForAdoption({}).size).toBe(0);
  });
});
