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
  adoptionServiceModesForContract,
} = require('../routes/estimate-public');
const {
  tierQualifyingRecurringServiceKeys,
  combinedTierQualifyingCount,
  determineTier,
  isMembershipTierUpgrade,
  priorQualifyingKeysFromSnapshot,
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

describe('frozen-snapshot prior keys (codex r6)', () => {
  test('the saved snapshot wins over any live state', () => {
    expect(priorQualifyingKeysFromSnapshot({
      membershipSnapshot: { existingServiceKeys: ['pest_control'] },
    })).toEqual(['pest_control']);
  });

  test('an EMPTY snapshot is honored — no fallback to a live lookup', () => {
    expect(priorQualifyingKeysFromSnapshot({
      membershipSnapshot: { existingServiceKeys: [] },
    })).toEqual([]);
  });

  test('legacy estimates without a snapshot return null (caller uses the live lookup)', () => {
    expect(priorQualifyingKeysFromSnapshot({})).toBe(null);
    expect(priorQualifyingKeysFromSnapshot(null)).toBe(null);
    expect(priorQualifyingKeysFromSnapshot({ membershipSnapshot: {} })).toBe(null);
  });

  test('non-qualifying keys in a snapshot never raise the tier', () => {
    expect(priorQualifyingKeysFromSnapshot({
      membershipSnapshot: { existingServiceKeys: ['pest_control', 'palm_injection', 'rodent_bait'] },
    })).toEqual(['pest_control']);
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
    const familyKeys = estimateFamilyKeysForAdoption({}, treeShrubEstimateData);
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

  test('palm visits never stand in for a tree & shrub estimate (codex r3)', () => {
    const familyKeys = estimateFamilyKeysForAdoption({}, treeShrubEstimateData);
    // "Palm Tree Injections" contains the tree token, but palm precedence
    // keeps it a palm-family row — a T&S accept must go to the slot picker.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Palm Tree Injections' },
      familyKeys,
    )).toBe(false);
    // Palm-to-palm adoption still works: both sides key palm_injection.
    const palmData = {
      result: {
        recurring: {
          services: [{
            name: 'Palm Tree Injections',
            service: 'palm_injection',
            selected: true,
            isSelected: true,
          }],
        },
      },
    };
    const palmKeys = estimateFamilyKeysForAdoption({}, palmData);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Palm Tree Injections' },
      palmKeys,
    )).toBe(true);
    // "Palmetto" never trips the palm rule — palmetto-bug pest rows stay pest.
    const pestKeys = new Set(['pest_control']);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Palmetto Bug Pest Control' },
      pestKeys,
    )).toBe(true);
  });

  test('rows without a resolvable service family never stand in for a first visit', () => {
    const familyKeys = estimateFamilyKeysForAdoption({}, treeShrubEstimateData);
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
    const familyKeys = estimateFamilyKeysForAdoption({}, pestData);
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
    const familyKeys = estimateFamilyKeysForAdoption({}, pestData);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Quarterly Pest Control Service' },
      familyKeys,
    )).toBe(true);
  });

  test('mixed estimates scope adoption to the accepted service mode (codex r4)', () => {
    // Recurring pest + one-time Bora-Care: accepting the RECURRING plan must
    // not adopt a termite-family appointment (the accept would stamp the
    // recurring first-application price onto it), and vice versa.
    const mixedData = {
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
        oneTime: {
          items: [{
            name: 'Bora-Care Termite Treatment',
            service: 'termite_treatment',
            price: 1200,
          }],
        },
      },
    };
    const recurringKeys = estimateFamilyKeysForAdoption({}, mixedData, { serviceMode: 'recurring' });
    expect([...recurringKeys]).toEqual(['pest_control']);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Bora-Care Termite Treatment' },
      recurringKeys,
    )).toBe(false);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Quarterly Pest Control Service' },
      recurringKeys,
    )).toBe(true);

    const oneTimeKeys = estimateFamilyKeysForAdoption({}, mixedData, { serviceMode: 'one_time' });
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Quarterly Pest Control Service' },
      oneTimeKeys,
    )).toBe(false);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Bora-Care Termite Treatment' },
      oneTimeKeys,
    )).toBe(true);
  });

  test('combined catalog keys stay pest-primary (codex r7)', () => {
    const pestKeys = new Set(['pest_control']);
    // The combined-service cutover row: catalog key has no "+" and its
    // underscores defeat word-boundary rules unless normalized first.
    expect(appointmentMatchesEstimateFamily({
      service_type: 'Pest Control + Termite Bait Stations',
      catalog_service_key: 'pest_termite_bait_quarterly',
      catalog_service_name: 'Quarterly Pest + Termite Bait Stations',
    }, pestKeys)).toBe(true);
    // Even the bare key classifies pest-primary once separators normalize.
    expect(appointmentMatchesEstimateFamily({
      service_type: '',
      catalog_service_key: 'pest_termite_bait_quarterly',
    }, pestKeys)).toBe(true);
    // A plain termite bait program stays termite-family.
    expect(appointmentMatchesEstimateFamily({
      service_type: 'Termite Bait Station Program',
    }, pestKeys)).toBe(false);
  });

  test('stale service_type labels classify by catalog identity (codex r5)', () => {
    const familyKeys = estimateFamilyKeysForAdoption({}, treeShrubEstimateData);
    // Row labeled "Tree & Shrub Care" but actually a palm program per its
    // catalog link — must NOT be adopted by a T&S estimate.
    expect(appointmentMatchesEstimateFamily({
      service_type: 'Tree & Shrub Care',
      catalog_service_key: 'palm_injection',
      catalog_service_name: 'Palm Tree Injections',
    }, familyKeys)).toBe(false);
    // Catalog identity also rescues rows the label alone would misfile.
    expect(appointmentMatchesEstimateFamily({
      service_type: 'Recurring Care Program',
      catalog_service_key: 'tree_shrub_program',
      catalog_service_name: 'Bi-Monthly Tree & Shrub Care Service',
    }, familyKeys)).toBe(true);
  });

  test('commercial families never cross-match residential (codex r5)', () => {
    // Residential lawn estimate vs a commercial lawn visit: distinct keys.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Commercial Lawn Treatment Program' },
      new Set(['lawn_care']),
    )).toBe(false);
    // Commercial-to-commercial still matches (both sides key commercial_*).
    const commercialData = {
      result: {
        recurring: {
          services: [{
            name: 'Commercial Lawn Treatment Program',
            selected: true,
            isSelected: true,
          }],
        },
      },
    };
    const commercialKeys = estimateFamilyKeysForAdoption({}, commercialData);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Commercial Lawn Treatment Program' },
      commercialKeys,
    )).toBe(true);
  });

  test('contract-time adoption intersects every selectable mode (codex r5 P1)', () => {
    const mixedData = {
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
        oneTime: {
          items: [{
            name: 'Bora-Care Termite Treatment',
            service: 'termite_treatment',
            price: 1200,
          }],
        },
      },
    };
    // Cross-family modes: nothing is adoptable under BOTH → contract falls
    // to the slot picker, which works for either mode.
    expect(estimateFamilyKeysForAdoption({}, mixedData, {
      serviceModes: ['recurring', 'one_time'],
    }).size).toBe(0);
    // Same-family modes (pest plan with a pest one-time choice) still adopt.
    const pestBothModes = {
      result: {
        recurring: {
          services: [{
            name: 'Quarterly Pest Control Service',
            service: 'pest_control',
            selected: true,
            isSelected: true,
          }],
        },
        oneTime: {
          items: [{ name: 'One-Time Pest Control', service: 'pest_control', price: 150 }],
        },
      },
    };
    expect([...estimateFamilyKeysForAdoption({}, pestBothModes, {
      serviceModes: ['recurring', 'one_time'],
    })]).toEqual(['pest_control']);
  });

  test('a derived one-time pest choice supplies the one-time family (codex r9)', () => {
    // show_one_time_option derives a pest offer from recurring pricing while
    // the STORED one-time rows carry only the WaveGuard setup fee — the
    // effective-choice mechanism (one_time_pest) must supply the family, or
    // the contract-time intersection empties and rejects a valid pest visit.
    const estimate = { show_one_time_option: true };
    const derivedChoiceData = {
      result: {
        recurring: {
          services: [{
            name: 'Quarterly Pest Control Service',
            service: 'pest_control',
            frequency: 'quarterly',
            monthly: 39,
            perVisit: 117,
            visitsPerYear: 4,
            selected: true,
            isSelected: true,
          }],
        },
        oneTime: {
          items: [{ name: 'WaveGuard Membership Setup', service: 'waveguard_setup', price: 99 }],
        },
      },
    };
    const bothModes = estimateFamilyKeysForAdoption(estimate, derivedChoiceData, {
      serviceModes: ['recurring', 'one_time'],
    });
    expect([...bothModes]).toEqual(['pest_control']);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Quarterly Pest Control Service' },
      bothModes,
    )).toBe(true);
  });

  test('an estimate with no resolvable services offers no adoption at all', () => {
    expect(estimateFamilyKeysForAdoption({}, null).size).toBe(0);
    expect(estimateFamilyKeysForAdoption({}, {}).size).toBe(0);
  });

  test('specialty termite work never adopts a termite-bait visit (codex r11)', () => {
    const boraCareData = {
      result: {
        oneTime: {
          items: [{ name: 'Bora-Care Termite Treatment', service: 'termite_treatment', price: 1200 }],
        },
      },
    };
    const oneTimeKeys = estimateFamilyKeysForAdoption({}, boraCareData, { serviceMode: 'one_time' });
    // The bait-program visit is a different service — never restamped by a
    // specialty treatment accept.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Termite Bait Station Program' },
      oneTimeKeys,
    )).toBe(false);
    // Specialty-to-specialty still matches.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Bora-Care Termite Treatment' },
      oneTimeKeys,
    )).toBe(true);
    // Bait-to-bait adoption keeps working.
    const baitKeys = new Set(['termite_bait']);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Termite Bait Station Program' },
      baitKeys,
    )).toBe(true);
  });

  test('multi-service recurring accepts adopt only under the PRIMARY service (codex r14)', () => {
    const pestPlusTree = {
      result: {
        recurring: {
          services: [
            {
              name: 'Quarterly Pest Control Service',
              service: 'pest_control',
              frequency: 'quarterly',
              selected: true,
              isSelected: true,
            },
            {
              name: 'Bi-Monthly Tree & Shrub Care Service',
              service: 'tree_shrub',
              frequency: 'bi_monthly',
              selected: true,
              isSelected: true,
            },
          ],
        },
      },
    };
    const keys = estimateFamilyKeysForAdoption({}, pestPlusTree, { serviceMode: 'recurring' });
    expect([...keys]).toEqual(['pest_control']);
    // The add-on family's visit must not be restamped — the reserved-row
    // path never schedules the remaining services, so the primary pest work
    // would be lost.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Bi-Monthly Tree & Shrub Care Service' },
      keys,
    )).toBe(false);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Quarterly Pest Control Service' },
      keys,
    )).toBe(true);
    // Pest is primary regardless of list order — the reservation writer
    // prefers pest_control anywhere in the profile (codex r15).
    const treeFirst = {
      result: {
        recurring: {
          services: [
            {
              name: 'Bi-Monthly Tree & Shrub Care Service',
              service: 'tree_shrub',
              selected: true,
              isSelected: true,
            },
            {
              name: 'Quarterly Pest Control Service',
              service: 'pest_control',
              selected: true,
              isSelected: true,
            },
          ],
        },
      },
    };
    expect([...estimateFamilyKeysForAdoption({}, treeFirst, { serviceMode: 'recurring' })])
      .toEqual(['pest_control']);
  });

  test('Bora-Care never adopts a trenching visit (codex r13)', () => {
    const boraData = {
      result: {
        oneTime: {
          items: [{ name: 'Bora-Care Termite Treatment', service: 'termite_treatment', price: 1200 }],
        },
      },
    };
    const boraKeys = estimateFamilyKeysForAdoption({}, boraData, { serviceMode: 'one_time' });
    expect([...boraKeys]).toEqual(['bora_care']);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Liquid Termite Trenching Treatment' },
      boraKeys,
    )).toBe(false);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Bora-Care Termite Treatment' },
      boraKeys,
    )).toBe(true);
  });

  test('one-time slug families stay stable across key and label (codex r13)', () => {
    const fleaData = {
      result: {
        oneTime: {
          items: [{ service: 'flea_package', name: 'Flea Treatment Package', price: 249 }],
        },
      },
    };
    const fleaKeys = estimateFamilyKeysForAdoption({}, fleaData, { serviceMode: 'one_time' });
    // The row's label-derived identity must be reachable — concatenating
    // key + name minted a synthetic family no row could reproduce.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Flea Treatment Package' },
      fleaKeys,
    )).toBe(true);
    // But the BROAD pest category must not leak in (codex r16): an ordinary
    // quarterly-pest visit is a different service — restamping it would
    // leave the flea work undispatched.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Quarterly Pest Control Service' },
      fleaKeys,
    )).toBe(false);
  });

  test('multi-service one-time accepts adopt only under the PRIMARY service (codex r13)', () => {
    const pestPlusBora = {
      result: {
        oneTime: {
          items: [
            { name: 'One-Time Pest Control', service: 'one_time_pest', price: 150 },
            { name: 'Bora-Care Termite Treatment', service: 'termite_treatment', price: 1200 },
          ],
        },
      },
    };
    const keys = estimateFamilyKeysForAdoption({}, pestPlusBora, { serviceMode: 'one_time' });
    expect([...keys]).toEqual(['pest_control']);
    // The standalone add-on visit must NOT be restamped — the primary pest
    // work would never reach dispatch.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Bora-Care Termite Treatment' },
      keys,
    )).toBe(false);
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'One-Time Pest Control' },
      keys,
    )).toBe(true);
  });

  test('foam spot treatments never adopt a trenching visit (codex r12)', () => {
    const foamData = {
      result: {
        oneTime: {
          items: [{ name: 'Termidor Foam Spot Treatment', service: 'termite_foam', price: 350 }],
        },
      },
    };
    const foamKeys = estimateFamilyKeysForAdoption({}, foamData, { serviceMode: 'one_time' });
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Liquid Termite Trenching Treatment' },
      foamKeys,
    )).toBe(false);
    // Foam-to-foam adoption still works.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Drill-and-Foam Termite Treatment' },
      foamKeys,
    )).toBe(true);
    // The RECURRING foam program keeps its own seeder family.
    expect(appointmentMatchesEstimateFamily(
      { service_type: 'Recurring Foam Treatment' },
      foamKeys,
    )).toBe(false);
  });

  test('an unselectable one-time toggle never joins the contract intersection (codex r10)', () => {
    const pestRecurringData = {
      result: {
        recurring: {
          services: [{
            name: 'Quarterly Pest Control Service',
            service: 'pest_control',
            frequency: 'quarterly',
            monthly: 39,
            perVisit: 117,
            visitsPerYear: 4,
            selected: true,
            isSelected: true,
          }],
        },
      },
    };
    // Toggle flag set but the resolved alternative price is zero (no
    // estimate_data to derive one from): the SSR page hides the toggle and
    // accept rejects the mode — the contract intersection must not include
    // it, or a valid recurring adoption gets pushed to the picker.
    expect(adoptionServiceModesForContract(
      { show_one_time_option: true },
      pestRecurringData,
    )).toEqual(['recurring']);
    // A billable one-time alternative keeps both modes in the intersection.
    expect(adoptionServiceModesForContract(
      { show_one_time_option: true, estimate_data: JSON.stringify(pestRecurringData) },
      pestRecurringData,
    )).toEqual(['recurring', 'one_time']);
    // No toggle at all → single default mode.
    expect(adoptionServiceModesForContract({}, pestRecurringData)).toEqual(['recurring']);
  });
});
