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

  test('legacy plan/upgrade/callback-count inputs still price the flat Standard plan', () => {
    const fromUnlimited = priceRodentTrapping(baseInput(), { plan: 'unlimited' });
    expect(fromUnlimited.price).toBe(350);
    expect(fromUnlimited.name).toBe('Rodent Trapping - Standard');
    expect(fromUnlimited.rodentTrappingPlan).toBe('standard');
    expect(fromUnlimited.unlimitedCallbacks).toBe(true);

    expect(priceRodentTrapping(baseInput(), { upgradeToUnlimited: true }).price).toBe(350);
  });

  test('callbacks are unlimited — callback counts never bill', () => {
    expect(priceRodentTrapping(baseInput(), { extraCallbackCount: 0 }).price).toBe(350);
    expect(priceRodentTrapping(baseInput(), { callbacksUsed: 2, extraCallbackCount: 2 })).toMatchObject({
      price: 350,
      extraCallbackAllowed: false,
      extraCallbackPrice: 0,
      unlimitedCallbacks: true,
      includedCallbacks: 'unlimited',
    });
    const withRequestedExtras = priceRodentTrapping(baseInput(), { callbacksUsed: 2, extraCallbackCount: 1 });
    expect(withRequestedExtras.warnings.join(' ')).toMatch(/no longer apply/i);
    expect(priceRodentTrappingFollowups(1, { callbacksUsed: 2 })).toMatchObject({
      price: 0,
      included: true,
      unlimitedCallbacks: true,
    });
  });

  test('invoice descriptions use revised trapping copy', () => {
    const standard = priceRodentTrapping(baseInput(), { plan: 'standard' });

    expect(standard.invoiceDescription).toMatch(/unlimited callbacks\/checks/i);
    expect(standard.invoiceDescription).toContain('same active trapping job');
    expect(standard.invoiceDescription).not.toContain('$125');
    // Owner 2026-08-27: the line reads as the plan's promise, not a recap of
    // "Standard: initial setup plus …".
    expect(standard.invoiceDescription).not.toMatch(/initial setup plus/i);
    expect(standard.invoiceDescription).not.toMatch(/Standard:/);
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

    expect(result.price).toBe(655); // 150 wire + 150 boxes + 280 mesh + 75 inspect
    const components = result.lineItems.map(li => li.component);
    expect(components).toEqual(['wire_mesh_points', 'bird_boxes', 'linear_mesh', 'inspect_fee']);
    expect(result.lineItems.map(li => li.price)).toEqual([150, 150, 280, 75]);
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

describe('service credits span every itemized exclusion section (codex #3521 r1 P1)', () => {
  test('a free rodent_exclusion credit zeroes ALL section rows, not just the first', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        exclusion: {
          pricingVersion: 'v2',
          standardWireMeshPoints: 2,
          standardBirdBoxes: 1,
          meshSoftLF: 20,
          waiveInspection: true,
        },
      },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset',
        presetKey: 'free_rodent_exclusion',
        catalogName: 'Free Rodent Exclusion',
        catalogCategory: 'service_specific_credit',
        discountType: 'free_service',
        service: 'rodent_exclusion',
        label: 'Free Rodent Exclusion',
      }],
    }));
    const [credit] = estimate.summary.serviceSpecificDiscounts;
    // 150 wire + 150 boxes + 280 mesh — the whole service, across three rows.
    expect(credit.amount).toBe(580);
    expect(estimate.summary.oneTimeTotal).toBe(0);
  });

  test('a fixed credit larger than the first section carries into the next rows', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        exclusion: {
          pricingVersion: 'v2',
          standardWireMeshPoints: 2,
          standardBirdBoxes: 1,
          meshSoftLF: 20,
          waiveInspection: true,
        },
      },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset',
        presetKey: 'rodent_exclusion_credit',
        catalogName: 'Rodent Exclusion Credit',
        catalogCategory: 'service_specific_credit',
        discountType: 'fixed',
        requestedAmount: 200,
        service: 'rodent_exclusion',
        label: 'Rodent Exclusion Credit',
      }],
    }));
    const [credit] = estimate.summary.serviceSpecificDiscounts;
    expect(credit.amount).toBe(200);
    expect(estimate.summary.oneTimeTotal).toBe(380);
    // Only the row the credit actually zeroed reads as "Included"; a
    // partially credited row keeps its NET price and an untouched row its
    // full price (uncapped audit r2 P0 — the flag renders as Included).
    const rows = estimate.lineItems.filter((li) => li.service === 'rodent_exclusion');
    expect(rows.map((li) => [li.component, li.priceAfterDiscount ?? li.price, li.serviceSpecificDiscountApplied === true])).toEqual([
      ['wire_mesh_points', 0, true],
      ['bird_boxes', 100, false],
      ['linear_mesh', 280, false],
    ]);
  });
});

describe('exclusion V2 rows reconcile to the price for fractional measurements (codex #3521 r2 P2)', () => {
  test('20.1 LF of soft mesh: rows sum to result.price to the cent', () => {
    const result = priceRodentExclusionV2({ meshSoftLF: 20.1, waiveInspection: true });
    const rowsTotal = Math.round(result.lineItems.reduce((s, li) => s + li.price, 0) * 100) / 100;
    expect(rowsTotal).toBe(result.price);
    expect(Number.isInteger(result.price)).toBe(true);
    const minimum = result.lineItems.find((li) => li.component === 'job_minimum');
    // 20.1 × $14 = $281.40 of mesh; the job minimum row carries exactly the
    // remainder up to the (whole-dollar) install price.
    expect(result.lineItems.find((li) => li.component === 'linear_mesh').price).toBe(281.4);
    expect(minimum.price).toBe(Math.round((result.price - 281.4) * 100) / 100);
  });

  test('whole quantities are unchanged', () => {
    const result = priceRodentExclusionV2({ standardWireMeshPoints: 2, standardBirdBoxes: 1, meshSoftLF: 20 });
    expect(result.price).toBe(655);
    expect(result.lineItems.map((li) => li.price)).toEqual([150, 150, 280, 75]);
  });
});

describe('exclusion V2 rows never exceed the price above the job minimum (pre-push P0 on #3521)', () => {
  test('fractional work above the minimum: rows sum to the whole-dollar price', () => {
    // 4 standard points ($300) + 20.1 LF soft ($281.40) = $581.40 raw → $581 price.
    const result = priceRodentExclusionV2({ standardWireMeshPoints: 4, meshSoftLF: 20.1, waiveInspection: true });
    expect(result.price).toBe(581);
    const rowsTotal = Math.round(result.lineItems.reduce((s, li) => s + li.price, 0) * 100) / 100;
    expect(rowsTotal).toBe(581);
    expect(result.lineItems.some((li) => li.component === 'job_minimum')).toBe(false);
    // The $0.40 remainder folds into the last component row.
    expect(result.lineItems.find((li) => li.component === 'linear_mesh').price).toBe(281);
  });

  test('fractional work that rounds UP: rows still sum to the price', () => {
    // 4 points ($300) + 20.05 LF ($280.70) = $580.70 → $581; last row absorbs +$0.30.
    const result = priceRodentExclusionV2({ standardWireMeshPoints: 4, meshSoftLF: 20.05, waiveInspection: true });
    expect(result.price).toBe(581);
    const rowsTotal = Math.round(result.lineItems.reduce((s, li) => s + li.price, 0) * 100) / 100;
    expect(rowsTotal).toBe(581);
  });
});

describe('service credits never zero distinct products that share a key (uncapped audit P0 on #3521)', () => {
  test('a free one_time_lawn credit leaves the second lawn product paid', () => {
    const estimate = generateEstimate(baseInput({
      services: { oneTimeLawn: {}, lawnPestControl: {} },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset',
        presetKey: 'free_one_time_lawn',
        catalogName: 'Free One-Time Lawn',
        catalogCategory: 'service_specific_credit',
        discountType: 'free_service',
        service: 'one_time_lawn',
        label: 'Free One-Time Lawn',
      }],
    }));
    const lawnRows = estimate.lineItems.filter((li) => li.service === 'one_time_lawn');
    expect(lawnRows.length).toBeGreaterThanOrEqual(2);
    const zeroed = lawnRows.filter((li) => li.serviceSpecificDiscountApplied === true);
    expect(zeroed).toHaveLength(1);
    const stillPaid = lawnRows.filter((li) => li.serviceSpecificDiscountApplied !== true);
    expect(stillPaid.every((li) => (li.priceAfterDiscount ?? li.price) > 0)).toBe(true);
    expect(estimate.summary.oneTimeTotal).toBeGreaterThan(0);
  });
});

describe('included-section markers survive the legacy mapper (codex #3521 r15 P1)', () => {
  const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

  test('a fully credited V2 exclusion keeps its sections as marked $0 rows in the mapped estimate', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(baseInput({
      services: {
        exclusion: { pricingVersion: 'v2', standardWireMeshPoints: 2, standardBirdBoxes: 1, meshSoftLF: 20, waiveInspection: true },
      },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset', presetKey: 'free_rodent_exclusion', catalogName: 'Free Rodent Exclusion',
        catalogCategory: 'service_specific_credit', discountType: 'free_service', service: 'rodent_exclusion', label: 'Free Rodent Exclusion',
      }],
    })));
    const rows = [...(mapped.oneTime.items || []), ...(mapped.oneTime.specItems || [])]
      .filter((r) => r.service === 'rodent_exclusion');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.serviceSpecificDiscountApplied === true)).toBe(true);
    expect(rows.every((r) => Number(r.priceAfterDiscount ?? r.price) === 0)).toBe(true);
    // And the page's normalizer keeps them as Included rows rather than dropping $0 rows.
    const { normalizeOneTimeBreakdown } = require('../routes/estimate-public');
    const normalized = normalizeOneTimeBreakdown({ result: mapped }).items.filter((r) => r.service === 'rodent_exclusion');
    expect(normalized.length).toBe(rows.length);
    expect(normalized.every((r) => r.kind === 'included')).toBe(true);
  });
});

describe('gross inspection fields reach the FINAL mapper projection (codex #3521 r16 P1)', () => {
  const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

  test('a member inspection persists its face and perk rate on oneTime.specItems', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(baseInput({
      recurringCustomer: true,
      services: { rodentInspection: {} },
    })));
    const row = [...(mapped.oneTime.items || []), ...(mapped.oneTime.specItems || [])]
      .find((r) => r.service === 'rodent_inspection');
    expect(row).toBeTruthy();
    // $75 face, 15% member perk → $63.75 stored net; the face and the rate
    // both ride the persisted row so closeout never needs reconstruction.
    expect(row.price).toBe(63.75);
    expect(row.priceBeforeDiscount).toBe(75);
    expect(row.recurringCustomerDiscountRate).toBe(0.15);
  });
});
