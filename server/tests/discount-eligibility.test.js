// Canonical per-service discount eligibility (discount-engine single
// source, 2026-08-10 consolidation). These pins hold the POLICY — which
// services count toward the WaveGuard tier, which are excluded from
// percentage discounts, which take manual recurring discounts — and the
// two contracts the consolidation exists for: predicates read the live
// WAVEGUARD object at call time (db-bridge mutates it in place), and the
// line-level override flags have exactly one interpretation.

const { WAVEGUARD } = require('../services/pricing-engine/constants');
const {
  serviceCountsTowardWaveGuardTier,
  serviceExcludedFromPercentDiscount,
  isTierDiscountEligible,
  serviceManualRecurringDiscountEligible,
  lineFlagsBlockPercentDiscount,
} = require('../services/pricing-engine/discount-engine');

describe('canonical discount eligibility', () => {
  test('WaveGuard tier membership: the five qualifying families, with lawn variants sharing lawn_care policy', () => {
    for (const key of ['lawn_care', 'pest_control', 'tree_shrub', 'mosquito', 'termite_bait']) {
      expect(serviceCountsTowardWaveGuardTier(key)).toBe(true);
    }
    expect(serviceCountsTowardWaveGuardTier('lawn_care_enhanced')).toBe(true);
    expect(serviceCountsTowardWaveGuardTier('lawn_care_premium')).toBe(true);
    for (const key of ['palm_injection', 'rodent_bait', 'termite_bond', 'bed_bug', 'trap_only_retainer', 'rodent_guarantee']) {
      expect(serviceCountsTowardWaveGuardTier(key)).toBe(false);
    }
  });

  test('percentage-discount exclusions mirror the WAVEGUARD map', () => {
    for (const key of Object.keys(WAVEGUARD.excludedFromPercentDiscount)) {
      expect(serviceExcludedFromPercentDiscount(key)).toBe(WAVEGUARD.excludedFromPercentDiscount[key] === true);
    }
    expect(serviceExcludedFromPercentDiscount('pest_control')).toBe(false);
    expect(serviceExcludedFromPercentDiscount('lawn_care')).toBe(false);
  });

  test('tier % eligibility covers qualifiers + lawn variants, never the excluded services', () => {
    for (const key of ['lawn_care', 'pest_control', 'tree_shrub', 'mosquito', 'termite_bait', 'lawn_care_enhanced', 'lawn_care_premium']) {
      expect(isTierDiscountEligible(key)).toBe(true);
    }
    for (const key of ['palm_injection', 'rodent_bait', 'bora_care', 'foam_recurring']) {
      expect(isTierDiscountEligible(key)).toBe(false);
    }
  });

  test('manual recurring discounts: four core programs only — termite_bait takes the tier % but is NOT manually discountable', () => {
    for (const key of ['pest_control', 'lawn_care', 'tree_shrub', 'mosquito', 'lawn_care_enhanced', 'lawn_care_premium']) {
      expect(serviceManualRecurringDiscountEligible(key)).toBe(true);
    }
    // The policy split this registry preserves: automatic tier discount
    // yes, manual discount no.
    expect(serviceManualRecurringDiscountEligible('termite_bait')).toBe(false);
    expect(isTierDiscountEligible('termite_bait')).toBe(true);
    expect(serviceManualRecurringDiscountEligible('rodent_bait')).toBe(false);
  });

  test('line-level override flags: each blocks independently; a clean line passes', () => {
    expect(lineFlagsBlockPercentDiscount({})).toBe(false);
    expect(lineFlagsBlockPercentDiscount({ discountable: false })).toBe(true);
    expect(lineFlagsBlockPercentDiscount({ discount: { discountable: false } })).toBe(true);
    expect(lineFlagsBlockPercentDiscount({ waveGuardDiscountEligible: false })).toBe(true);
    expect(lineFlagsBlockPercentDiscount({ discountEligible: false })).toBe(true);
    expect(lineFlagsBlockPercentDiscount({ excludeFromPctDiscount: true })).toBe(true);
    // Truthy-but-not-the-sentinel values do NOT block (=== semantics).
    expect(lineFlagsBlockPercentDiscount({ discountEligible: true, excludeFromPctDiscount: false })).toBe(false);
  });

  test('predicates read the LIVE WAVEGUARD object (db-bridge mutates it in place)', () => {
    const fakeKey = '__test_dynamic_service__';
    expect(serviceCountsTowardWaveGuardTier(fakeKey)).toBe(false);
    expect(serviceExcludedFromPercentDiscount(fakeKey)).toBe(false);
    WAVEGUARD.qualifyingServices.push(fakeKey);
    WAVEGUARD.excludedFromPercentDiscount[fakeKey] = true;
    try {
      expect(serviceCountsTowardWaveGuardTier(fakeKey)).toBe(true);
      expect(isTierDiscountEligible(fakeKey)).toBe(true);
      expect(serviceExcludedFromPercentDiscount(fakeKey)).toBe(true);
    } finally {
      WAVEGUARD.qualifyingServices.pop();
      delete WAVEGUARD.excludedFromPercentDiscount[fakeKey];
    }
    expect(serviceCountsTowardWaveGuardTier(fakeKey)).toBe(false);
  });
});
