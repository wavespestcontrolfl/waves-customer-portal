/**
 * server/services/pricing-engine/retired-sale-catalog.js — the shared
 * chokepoint introduced in PR #4786 codex round 2 ("one more surface still
 * sells Light — fix it at the chokepoint"). Direct unit coverage for the
 * two predicates every new-sale boundary reads, including a regression
 * for a bug caught while wiring property-lookup-v2.js and public-quote.js
 * onto this module: `String(nonStringValue)` coercion (e.g. a single-
 * element array) must never accidentally satisfy a tier check.
 */
const {
  RETIRED_SALE_SERVICE_KEYS,
  isRetiredTreeShrubTier,
  isSellableTreeShrubTier,
} = require('../services/pricing-engine/retired-sale-catalog');

describe('RETIRED_SALE_SERVICE_KEYS', () => {
  test('contains exactly tree_shrub_quarterly today', () => {
    expect([...RETIRED_SALE_SERVICE_KEYS]).toEqual(['tree_shrub_quarterly']);
  });

  test('does not contain FORMERLY_PUBLIC_KEYS members that are still fully sold (codex P1 round 2)', () => {
    for (const key of ['foam_drill', 'termite_pretreatment', 'rodent_trapping_exclusion', 'lawn_care_recurring']) {
      expect(RETIRED_SALE_SERVICE_KEYS.has(key)).toBe(false);
    }
  });
});

describe('isRetiredTreeShrubTier', () => {
  test('light (hidden) and premium (removed alias) are retired', () => {
    expect(isRetiredTreeShrubTier('light')).toBe(true);
    expect(isRetiredTreeShrubTier('LIGHT')).toBe(true);
    expect(isRetiredTreeShrubTier(' light ')).toBe(true);
    expect(isRetiredTreeShrubTier('premium')).toBe(true);
  });

  test('the sold tiers are not retired', () => {
    expect(isRetiredTreeShrubTier('standard')).toBe(false);
    expect(isRetiredTreeShrubTier('enhanced')).toBe(false);
  });

  test('an unknown value is not "retired" (it was never a tier at all)', () => {
    expect(isRetiredTreeShrubTier('gold')).toBe(false);
    expect(isRetiredTreeShrubTier('')).toBe(false);
    expect(isRetiredTreeShrubTier(undefined)).toBe(false);
    expect(isRetiredTreeShrubTier(null)).toBe(false);
  });

  test('a non-string value is never retired via accidental String() coercion', () => {
    expect(isRetiredTreeShrubTier(['light'])).toBe(false);
    expect(isRetiredTreeShrubTier(['premium'])).toBe(false);
    expect(isRetiredTreeShrubTier(0)).toBe(false);
    expect(isRetiredTreeShrubTier(false)).toBe(false);
    expect(isRetiredTreeShrubTier({ toString: () => 'light' })).toBe(false);
  });
});

describe('isSellableTreeShrubTier', () => {
  test('only the sold tiers are sellable', () => {
    expect(isSellableTreeShrubTier('standard')).toBe(true);
    expect(isSellableTreeShrubTier('enhanced')).toBe(true);
    expect(isSellableTreeShrubTier(' Standard ')).toBe(true);
    expect(isSellableTreeShrubTier('light')).toBe(false);
    expect(isSellableTreeShrubTier('premium')).toBe(false);
    expect(isSellableTreeShrubTier('gold')).toBe(false);
    expect(isSellableTreeShrubTier('')).toBe(false);
    expect(isSellableTreeShrubTier(undefined)).toBe(false);
  });

  // The exact regression caught in property-lookup-tree-shrub-inputs.test.js
  // when this boundary was switched onto the shared chokepoint: the OLD
  // per-file check was a real Set.has() (type-strict — an array is never
  // === the string 'standard'), and a naive String(tier) here would
  // coerce a single-element array to its bare element and wrongly pass.
  test('a non-string value (array, object, number, boolean) is never sellable via accidental String() coercion', () => {
    expect(isSellableTreeShrubTier(['standard'])).toBe(false);
    expect(isSellableTreeShrubTier(['enhanced'])).toBe(false);
    expect(isSellableTreeShrubTier(0)).toBe(false);
    expect(isSellableTreeShrubTier(false)).toBe(false);
    expect(isSellableTreeShrubTier({ toString: () => 'standard' })).toBe(false);
  });
});

describe('inherited object keys are never tiers (codex P0 r8)', () => {
  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('%s is neither sellable nor retired', (tier) => {
    expect(isSellableTreeShrubTier(tier)).toBe(false);
    expect(isRetiredTreeShrubTier(tier)).toBe(false);
  });
});

describe('retiredSaleKeyForLabel — free-text labels', () => {
  const { retiredSaleKeyForLabel, labelMayNameRetiredSale } = require('../services/pricing-engine/retired-sale-catalog');

  test('the family reads in the singular and the plural (codex r28)', () => {
    for (const label of ['Quarterly Tree & Shrub', 'Quarterly Trees & Shrubs', 'Trees and Shrubs 4x', 'trees/shrubs every 3 months', 'T&S quarterly', 'Ornamentals (Light)']) {
      expect(retiredSaleKeyForLabel(label)).toBe('tree_shrub_quarterly');
      expect(labelMayNameRetiredSale(label)).toBe(true);
    }
  });

  test('a current-cadence label or another family is not the retired row', () => {
    for (const label of ['Bi-Monthly Trees & Shrubs', 'Every 6 Weeks Tree & Shrub Care', 'Quarterly Pest Control', 'Trees & Shrubs']) {
      expect(retiredSaleKeyForLabel(label)).toBeNull();
    }
  });
});
