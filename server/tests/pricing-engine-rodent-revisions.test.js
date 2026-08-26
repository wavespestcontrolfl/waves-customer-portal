const {
  generateEstimate,
  priceRodentTrapping,
  priceRodentTrappingFollowups,
  priceTrapOnlyRetainer,
  priceRodentWireMesh,
  priceRodentBirdBoxes,
  priceRodentExclusionV2,
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
  test('trapping is Standard-only: flat $350, emergency surcharge on top', () => {
    expect(priceRodentTrapping(baseInput(), { plan: 'standard' }).price).toBe(350);
    expect(priceRodentTrapping(baseInput(), { plan: 'standard', emergency: true }).price).toBe(425);
    // Large home / large lot: still flat — no footprint or lot adjustments.
    expect(priceRodentTrapping(
      baseInput({ homeSqFt: 5200, lotSqFt: 30000 }),
      { plan: 'standard' }
    ).price).toBe(350);
  });

  test('legacy unlimited/upgrade inputs coerce to Standard with a warning', () => {
    const fromUnlimited = priceRodentTrapping(baseInput(), { plan: 'unlimited' });
    expect(fromUnlimited.price).toBe(350);
    expect(fromUnlimited.name).toBe('Rodent Trapping - Standard');
    expect(fromUnlimited.rodentTrappingPlan).toBe('standard');
    expect(fromUnlimited.unlimitedCallbacks).toBe(false);
    expect(fromUnlimited.warnings.join(' ')).toMatch(/retired/i);

    const fromUpgrade = priceRodentTrapping(baseInput(), { upgradeToUnlimited: true });
    expect(fromUpgrade.price).toBe(350);
    expect(fromUpgrade.warnings.join(' ')).toMatch(/retired/i);
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

    expect(standard.invoiceDescription).toContain('initial setup plus 2 callbacks/checks');
    expect(standard.invoiceDescription).toContain('$125 each');
  });

  test('trap-only retainer plans, setup waiver, warranty, and callbacks', () => {
    const annualRetainer = priceTrapOnlyRetainer({ plan: 'standard', billing: 'annual' });
    expect(annualRetainer).toMatchObject({
      price: 495,
      trapOnlyRetainerAnnualPrice: 495,
      trapOnlySetupFee: 0,
      warrantyEligible: false,
      // The discount-exclusion contract: coupon/bundle exclusion flags are
      // read by isManualOneTimeDiscountEligible; WaveGuard exclusion rides
      // discountEligible:false (the estimate-public line predicates) — the
      // old excludedFromWaveGuardDiscounts field was write-only and was
      // removed in the 2026-08-10 eligibility consolidation.
      discountEligible: false,
      excludedFromCoupons: true,
      excludedFromBundleDiscounts: true,
    });
    expect(annualRetainer).not.toHaveProperty('excludedFromWaveGuardDiscounts');
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

  test('exclusion V2 quotes each section as its own line item, summing to the total', () => {
    const result = priceRodentExclusionV2({
      standardWireMeshPoints: 2,
      standardBirdBoxes: 1,
      meshSoftLF: 20,
    });

    expect(result.price).toBe(705); // 150 wire + 150 boxes + 280 mesh + 125 inspect
    const components = result.lineItems.map(li => li.component);
    expect(components).toEqual(['wire_mesh_points', 'bird_boxes', 'linear_mesh', 'inspect_fee']);
    expect(result.lineItems.map(li => li.price)).toEqual([150, 150, 280, 125]);
    expect(result.lineItems.reduce((s, li) => s + li.price, 0)).toBe(result.price);
    // Every row keeps the exclusion identity for catalog/adoption/completion.
    expect(result.lineItems.every(li => li.service === 'rodent_exclusion')).toBe(true);
    // Names must never contain "inspection" — estimate-public's
    // isInspectionReviewOneTimeItem would classify such a row non-billable.
    expect(result.lineItems.every(li => !/inspection/i.test(li.label))).toBe(true);
  });

  test('exclusion V2 job minimum and inspect waiver surface as explicit rows', () => {
    const floored = priceRodentExclusionV2({
      advancedWireMeshPoints: 1,
      waiveInspection: true,
    });
    expect(floored.price).toBe(195); // $195 point-only job minimum
    expect(floored.lineItems.map(li => [li.component, li.price])).toEqual([
      ['wire_mesh_points', 150],
      ['job_minimum', 45],
    ]);
    expect(floored.lineItems[0].detail).toContain('(inspect waived)');
  });

  test('generateEstimate carries V2 exclusion as per-section rows and still tiers the guarantee', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        exclusion: {
          pricingVersion: 'v2',
          advancedWireMeshPoints: 10, // 20 equivalent points → estate guarantee tier
          waiveInspection: true,
        },
        rodentGuarantee: {
          eligibility: {
            trappingCompleted: true,
            exclusionCompleted: true,
            sanitationCompletedOrPhotoBaseline: true,
            noActivityAfterFinalTrapCheck: true,
          },
        },
      },
    }));

    const exclusionRows = estimate.lineItems.filter(li => li.service === 'rodent_exclusion');
    expect(exclusionRows.map(li => li.component)).toEqual(['wire_mesh_points']);
    expect(exclusionRows[0].price).toBe(1500);
    // No combined summary row rides alongside the section rows.
    expect(exclusionRows.filter(li => li.name === 'Rodent Exclusion')).toHaveLength(0);

    const guarantee = estimate.lineItems.find(li => li.service === 'rodent_guarantee');
    expect(guarantee).toMatchObject({ eligible: true, tier: 'estate', effectivePoints: 20 });
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
