const {
  generateEstimate,
  priceRodentTrapping,
  priceRodentTrappingFollowups,
  applyRodentBundle,
  calculateRodentGuaranteeCombo,
} = require('../services/pricing-engine');

function baseInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    zone: 'A',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    ...overrides,
  };
}

describe('revised rodent pricing rules', () => {
  test('trap checks are included during the active trapping window', () => {
    const trapping = priceRodentTrapping(baseInput(), {});
    const followups = priceRodentTrappingFollowups(5);

    expect(trapping.includedFollowUps).toBe('unlimited');
    expect(trapping.activeWindowDays).toBe(14);
    expect(trapping.unlimitedCallbacks).toBe(true);
    expect(followups).toMatchObject({
      service: 'rodent_trapping_followup',
      count: 5,
      perVisit: 0,
      price: 0,
      included: true,
      activeWindowDays: 14,
    });
  });

  test('out-of-window trap checks in estimates require custom review', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        rodentTrapping: {},
        rodentTrappingFollowups: { count: 1, withinActiveWindow: false },
      },
    }));
    const followup = estimate.lineItems.find(i => i.service === 'rodent_trapping_followup');

    expect(followup).toMatchObject({
      price: 0,
      requiresCustomQuote: true,
      quoteRequired: true,
    });
    expect(followup.customQuoteReason).toContain('outside the active trapping window');
    expect(followup.reason).toContain('outside the active trapping window');
  });

  test('trapping quotes that hit the ceiling require custom review', () => {
    const result = priceRodentTrapping(baseInput({
      homeSqFt: 7000,
      footprint: 7000,
      lotSqFt: 60000,
      features: { trees: 'heavy', nearWater: true },
    }), {
      pressure: 'severe',
      emergency: true,
    });

    expect(result.price).toBe(795);
    expect(result.customRecommended).toBe(true);
    expect(result.requiresCustomQuote).toBe(true);
    expect(result.quoteRequired).toBe(true);
    expect(result.customQuoteReason).toContain('pricing ceiling');
    expect(result.reason).toContain('pricing ceiling');
  });

  test('rodent bait receives no WaveGuard tier benefit, setup credit, or manual coupon', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        rodentBait: {},
      },
      manualDiscount: { type: 'PERCENT', value: 50, label: 'Half off' },
    }));
    const bait = estimate.lineItems.find(i => i.service === 'rodent_bait');

    expect(estimate.waveGuard.qualifyingCount).toBe(0);
    expect(estimate.waveGuard.activeServices).toEqual([]);
    expect(bait.discount.effectiveDiscount).toBe(0);
    expect(bait.discount.setupCredit).toBeUndefined();
    expect(bait.discount.flatCredit).toBeUndefined();
    expect(bait.discount.appliedDiscounts).not.toContainEqual(
      expect.objectContaining({ type: 'setup_credit' })
    );
    expect(estimate.summary.manualDiscount.amount).toBe(0);
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(bait.annual);
  });

  test('manual recurring discounts exclude rodent bait from the coupon base', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
        rodentBait: {},
      },
      manualDiscount: { type: 'PERCENT', value: 10, label: 'Manual 10%' },
    }));
    const bait = estimate.lineItems.find(i => i.service === 'rodent_bait');
    const manualBase = estimate.lineItems
      .filter(i => i.annual && i.service !== 'rodent_bait')
      .reduce((sum, i) => sum + (i.annualAfterDiscount || i.annual), 0);

    expect(estimate.summary.manualDiscount.amount).toBe(Math.round(manualBase * 0.10 * 100) / 100);
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(
      Math.round((manualBase + bait.annual - estimate.summary.manualDiscount.amount) * 100) / 100
    );
  });

  test('rodent bait does not waive exclusion inspection or trigger remediation bundle discount', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        rodentBait: {},
        exclusion: { simple: 2 },
      },
    }));
    const exclusion = estimate.lineItems.find(i => i.service === 'exclusion');

    expect(exclusion.inspectionFee).toBe(125);
    expect(exclusion.inspectionWaived).toBe(false);
    expect(estimate.lineItems.find(i => i.service === 'rodent_bundle_discount')).toBeUndefined();
  });

  test('rodent guarantee combo does not discount bait-station components', () => {
    const combo = calculateRodentGuaranteeCombo({
      sqft: 2400,
      stories: 1,
      guaranteeTerm: 12,
    });

    expect(combo.breakdown.bundleDiscount).toBe(0);
    expect(combo.breakdown.baitExcludedFromBundleDiscount).toBe(true);
  });

  test('rodent bundle floors never increase the customer price', () => {
    const result = applyRodentBundle(800, { kind: 'trapExclusion', discount: 0.07, floor: 895 });

    expect(result.discounted).toBe(800);
    expect(result.savings).toBe(0);
  });
});
