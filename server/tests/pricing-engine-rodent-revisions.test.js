const {
  generateEstimate,
  priceRodentTrapping,
  priceRodentTrappingFollowups,
  priceTrapOnlyRetainer,
  priceRodentWireMesh,
  priceRodentBirdBoxes,
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
  test('trapping plans and emergency pricing match fixed floors', () => {
    expect(priceRodentTrapping(baseInput(), { plan: 'standard' }).price).toBe(350);
    expect(priceRodentTrapping(baseInput(), { plan: 'unlimited' }).price).toBe(450);
    expect(priceRodentTrapping(baseInput(), { plan: 'standard', emergency: true }).price).toBe(425);
    expect(priceRodentTrapping(baseInput(), { plan: 'unlimited', emergency: true }).price).toBe(540);
    expect(priceRodentTrapping(baseInput(), { upgradeToUnlimited: true }).price).toBe(125);
  });

  test('standard trapping extra callbacks bill only after two included callbacks are used', () => {
    expect(priceRodentTrapping(baseInput(), { plan: 'standard', extraCallbackCount: 0 }).price).toBe(350);
    expect(priceRodentTrapping(baseInput(), { plan: 'standard', callbacksUsed: 1, extraCallbackCount: 1 })).toMatchObject({
      price: 350,
      extraCallbackAllowed: false,
      extraCallbackPrice: 0,
    });
    expect(priceRodentTrapping(baseInput(), { plan: 'standard', callbacksUsed: 2, extraCallbackCount: 1 })).toMatchObject({
      price: 475,
      extraCallbackAllowed: true,
      extraCallbackPrice: 125,
    });
    expect(priceRodentTrapping(baseInput(), { plan: 'standard', callbacksUsed: 2, extraCallbackCount: 2 }).price).toBe(600);
    expect(priceRodentTrappingFollowups(1, { callbacksUsed: 2 }).price).toBe(125);
  });

  test('invoice descriptions use revised trapping copy', () => {
    const standard = priceRodentTrapping(baseInput(), { plan: 'standard' });
    const unlimited = priceRodentTrapping(baseInput(), { plan: 'unlimited' });

    expect(standard.invoiceDescription).toContain('initial setup plus 2 callbacks/checks');
    expect(standard.invoiceDescription).toContain('$125 each');
    expect(unlimited.invoiceDescription).not.toMatch(/14[- ]day/i);
    expect(unlimited.invoiceDescription).toContain('same active trapping job only');
  });

  test('trap-only retainer plans, setup waiver, warranty, and callbacks', () => {
    expect(priceTrapOnlyRetainer({ plan: 'standard', billing: 'annual' })).toMatchObject({
      price: 495,
      trapOnlyRetainerAnnualPrice: 495,
      trapOnlySetupFee: 0,
      warrantyEligible: false,
      excludedFromCoupons: true,
      excludedFromWaveGuardDiscounts: true,
      excludedFromBundleDiscounts: true,
    });
    expect(priceTrapOnlyRetainer({ plan: 'standard', billing: 'monthly' })).toMatchObject({
      price: 248,
      trapOnlyRetainerMonthlyPrice: 49,
      trapOnlySetupFee: 199,
    });
    expect(priceTrapOnlyRetainer({ plan: 'plus', billing: 'annual' }).price).toBe(695);
    expect(priceTrapOnlyRetainer({ plan: 'monthly', billing: 'annual' }).price).toBe(995);
    expect(priceTrapOnlyRetainer({ plan: 'standard', billing: 'monthly', attachedToCompletedTrappingJob: true }).trapOnlySetupFee).toBe(0);
    expect(priceTrapOnlyRetainer({
      plan: 'standard',
      billing: 'annual',
      responseCallbacksUsed: 2,
      extraCallbackCount: 1,
    }).price).toBe(620);
  });

  test('wire mesh linear-foot pricing uses substrate minimums', () => {
    expect(priceRodentWireMesh({ meshLinearFeet: 10, meshSubstrate: 'wood_soft' }).price).toBe(195);
    expect(priceRodentWireMesh({ meshLinearFeet: 20, meshSubstrate: 'wood_soft' }).price).toBe(280);
    expect(priceRodentWireMesh({ meshLinearFeet: 10, meshSubstrate: 'concrete_masonry' }).price).toBe(250);
    expect(priceRodentWireMesh({ meshLinearFeet: 20, meshSubstrate: 'concrete_masonry' }).price).toBe(400);
    expect(priceRodentWireMesh({ meshLinearFeet: 10, meshSubstrate: 'roofline_soffit_eave' }).price).toBe(275);
    expect(priceRodentWireMesh({ meshLinearFeet: 20, meshSubstrate: 'roofline_soffit_eave' }).price).toBe(480);
    expect(priceRodentWireMesh({ meshLinearFeet: 10, meshSubstrate: 'tile_steep_fragile_roofline' })).toMatchObject({
      price: 395,
      customQuoteRecommended: true,
    });
  });

  test('bird box unit pricing handles same-visit standard discounts', () => {
    expect(priceRodentBirdBoxes({ birdBoxType: 'standard_bird_box', birdBoxQuantity: 1 }).price).toBe(225);
    expect(priceRodentBirdBoxes({ birdBoxType: 'standard_bird_box', birdBoxQuantity: 3 }).price).toBe(575);
    expect(priceRodentBirdBoxes({ birdBoxType: 'small_bird_box', birdBoxQuantity: 1 }).price).toBe(195);
    expect(priceRodentBirdBoxes({ birdBoxType: 'large_bird_box', birdBoxQuantity: 1 }).price).toBe(295);
    expect(priceRodentBirdBoxes({ birdBoxType: 'oversized_complex_custom', birdBoxQuantity: 1 }).price).toBe(395);
  });

  test('bundle floors do not reduce fixed trapping floors or trap-only retainers', () => {
    expect(applyRodentBundle(350, { kind: 'trapExclusion', discount: 0.07, floor: 350 })).toMatchObject({
      discounted: 350,
      savings: 0,
    });
    expect(applyRodentBundle(450, { kind: 'trapExclusion', discount: 0.07, floor: 450 })).toMatchObject({
      discounted: 450,
      savings: 0,
    });

    const estimate = generateEstimate(baseInput({
      services: {
        rodentTrapping: { plan: 'standard' },
        trapOnlyRetainer: { plan: 'standard', billing: 'annual' },
      },
    }));
    expect(estimate.lineItems.find(i => i.service === 'rodent_bundle_discount')).toBeUndefined();
    expect(estimate.lineItems.find(i => i.service === 'trap_only_retainer').price).toBe(495);
  });

  test('rodent bait remains excluded from WaveGuard tier benefit, setup credit, and manual coupon', () => {
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
    expect(estimate.summary.manualDiscount.amount).toBe(0);
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
});
