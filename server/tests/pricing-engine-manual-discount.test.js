const { generateEstimate } = require('../services/pricing-engine');

function baseInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    services: { pest: { frequency: 'quarterly' } },
    ...overrides,
  };
}

describe('pricing engine manual recurring discount', () => {
  test('custom percentage applies after WaveGuard and snapshots identity', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
      },
      manualDiscount: {
        source: 'custom',
        presetId: 'discount-custom-percent',
        presetKey: 'custom_percent',
        catalogName: 'Custom Percentage Discount',
        catalogCategory: 'custom_template',
        type: 'PERCENT',
        value: 10,
        label: 'Custom Percentage Discount',
      },
    }));

    expect(estimate.waveGuard.tier).toBe('silver');
    expect(estimate.summary.manualDiscount).toEqual(expect.objectContaining({
      source: 'custom',
      presetId: 'discount-custom-percent',
      presetKey: 'custom_percent',
      catalogName: 'Custom Percentage Discount',
      catalogCategory: 'custom_template',
      type: 'PERCENT',
      value: 10,
      scope: 'recurring_annual_after_waveguard',
      stackingOrder: 'after_waveguard',
    }));
    expect(estimate.summary.manualDiscount.amount).toBeCloseTo(
      estimate.summary.manualDiscount.discountableBase * 0.10,
      2,
    );
  });

  test('custom dollar discount caps to discountable recurring base', () => {
    const estimate = generateEstimate(baseInput({
      manualDiscount: {
        source: 'custom',
        type: 'FIXED',
        value: 5000,
        label: 'Custom Dollar Discount',
      },
    }));

    expect(estimate.summary.manualDiscount).toEqual(expect.objectContaining({
      type: 'FIXED',
      value: 5000,
      capped: true,
      capReason: 'discountable_base',
    }));
    expect(estimate.summary.manualDiscount.amount).toBe(estimate.summary.manualDiscount.discountableBase);
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(0);
  });

  test('custom percentage discounts a one-time-only estimate (no recurring base)', () => {
    const estimate = generateEstimate(baseInput({
      services: { exclusion: true },
      manualDiscount: {
        source: 'custom',
        presetKey: 'custom_percent',
        catalogCategory: 'custom_template',
        type: 'PERCENT',
        value: 15,
        label: 'WaveGuard Member Discount',
      },
    }));

    const md = estimate.summary.manualDiscount;
    expect(md.recurringAmount).toBe(0);
    expect(md.oneTimeAmount).toBeGreaterThan(0);
    expect(md.amount).toBeCloseTo(md.oneTimeAmount, 2);
    expect(md.scope).toBe('recurring_and_one_time_after_waveguard');
    // The one-time total is reduced by exactly the one-time slice.
    expect(md.oneTimeAmount).toBeCloseTo(md.oneTimeDiscountableBase * 0.15, 2);
    expect(estimate.summary.oneTimeTotal).toBeCloseTo(
      md.oneTimeDiscountableBase - md.oneTimeAmount,
      2,
    );
  });

  test('custom percentage splits across recurring and one-time work', () => {
    const noDiscount = generateEstimate(baseInput({
      services: { pest: { frequency: 'quarterly' }, exclusion: true },
    }));
    const estimate = generateEstimate(baseInput({
      services: { pest: { frequency: 'quarterly' }, exclusion: true },
      manualDiscount: { source: 'custom', type: 'PERCENT', value: 15, label: 'Member' },
    }));

    const md = estimate.summary.manualDiscount;
    expect(md.recurringAmount).toBeGreaterThan(0);
    expect(md.oneTimeAmount).toBeGreaterThan(0);
    expect(md.amount).toBeCloseTo(md.recurringAmount + md.oneTimeAmount, 2);
    // Year-1 drops by the full (recurring + one-time) discount, exactly once.
    expect(estimate.summary.year1Total).toBeCloseTo(
      noDiscount.summary.year1Total - md.amount,
      0,
    );
  });

  test('fixed dollar discount allocates proportionally across recurring and one-time', () => {
    const estimate = generateEstimate(baseInput({
      services: { pest: { frequency: 'quarterly' }, exclusion: true },
      manualDiscount: { source: 'custom', type: 'FIXED', value: 100, label: 'Member' },
    }));

    const md = estimate.summary.manualDiscount;
    expect(md.recurringAmount + md.oneTimeAmount).toBeCloseTo(100, 2);
    expect(md.recurringAmount).toBeGreaterThan(0);
    expect(md.oneTimeAmount).toBeGreaterThan(0);
    expect(md.capped).toBe(false);
  });

  test('manual discount skips one-time lines flagged discountEligible:false (trap-only retainer)', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        trapOnlyRetainer: { plan: 'standard', billing: 'annual' },
        exclusion: true,
      },
      manualDiscount: { source: 'custom', type: 'PERCENT', value: 15, label: 'Member' },
    }));

    const md = estimate.summary.manualDiscount;
    // Only the eligible one-time line (exclusion) is discounted; the excluded
    // trap-only retainer keeps its full price.
    expect(md.eligibleServices).toEqual(['exclusion']);
    expect(md.oneTimeDiscountableBase).toBeCloseTo(720, 2);
  });

  test('member discounts (requiresWaveGuardTier) require eligibility confirmation', () => {
    expect(() => generateEstimate(baseInput({
      manualDiscount: {
        source: 'catalog_preset',
        catalogName: 'WaveGuard Member Discount',
        type: 'PERCENT',
        value: 15,
        eligibility: { requiresWaveGuardTier: 'Bronze' },
      },
    }))).toThrow('Manual discount eligibility must be confirmed');

    const estimate = generateEstimate(baseInput({
      manualDiscount: {
        source: 'catalog_preset',
        catalogName: 'WaveGuard Member Discount',
        type: 'PERCENT',
        value: 15,
        eligibility: { requiresWaveGuardTier: 'Bronze' },
        eligibilityConfirmed: true,
        eligibilityOverrideReason: 'Active WaveGuard member',
      },
    }));
    expect(estimate.summary.manualDiscount.amount).toBeGreaterThan(0);
    expect(estimate.summary.manualDiscount.warnings).toContain('manual_discount_requires_waveguard_tier');
  });

  test('manual percentage above 100 is rejected server-side', () => {
    expect(() => generateEstimate(baseInput({
      manualDiscount: { type: 'PERCENT', value: 101 },
    }))).toThrow('Manual percentage discount cannot exceed 100');
  });

  test('manual percentage excludes palm and rodent recurring add-ons', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        pest: { frequency: 'quarterly' },
        palm: { palmCount: 2, treatmentType: 'combo', palmSize: 'medium' },
        rodentBait: { stationCount: 2 },
      },
      manualDiscount: { type: 'PERCENT', value: 10, label: 'Manual' },
    }));

    expect(estimate.summary.manualDiscount.eligibleServices).toEqual(['pest_control']);
    expect(estimate.summary.manualDiscount.excludedServices).toEqual(expect.arrayContaining([
      'palm_injection',
      'rodent_bait',
    ]));
    expect(estimate.summary.manualDiscount.amount).toBeCloseTo(
      estimate.summary.manualDiscount.discountableBase * 0.10,
      2,
    );
  });

  test('free termite inspection is a service-specific credit, not a recurring manual discount', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        pest: { frequency: 'quarterly' },
        wdo: true,
      },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset',
        presetId: 'free-termite',
        presetKey: 'free_termite_inspection',
        catalogName: 'Free Termite Inspection',
        catalogCategory: 'service_specific_credit',
        discountType: 'free_service',
        service: 'wdo_inspection',
        label: 'Free Termite Inspection',
      }],
    }));

    expect(estimate.summary.manualDiscount).toBeNull();
    expect(estimate.summary.serviceSpecificDiscounts).toHaveLength(1);
    expect(estimate.summary.serviceSpecificDiscounts[0]).toEqual(expect.objectContaining({
      service: 'wdo_inspection',
      amount: expect.any(Number),
      capReason: 'service_line_price',
    }));
    expect(estimate.summary.oneTimeTotal).toBe(0);
    expect(estimate.summary.recurringAnnualAfterDiscount).toBeGreaterThan(0);
  });

  test('free termite inspection mechanisms do not stack on the same service line', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        pest: { frequency: 'quarterly' },
        wdo: true,
      },
      serviceSpecificDiscounts: [
        {
          source: 'catalog_preset',
          presetKey: 'free_termite_inspection',
          catalogName: 'Free Termite Inspection',
          catalogCategory: 'service_specific_credit',
          discountType: 'free_service',
          service: 'wdo_inspection',
          label: 'Free Termite Inspection',
        },
        {
          source: 'catalog_preset',
          presetKey: 'waveguard_member_termite_inspection',
          catalogName: 'WaveGuard Member Discount (Termite Inspection)',
          catalogCategory: 'service_specific_credit',
          discountType: 'percentage',
          service: 'wdo_inspection',
          label: 'WaveGuard Member Discount (Termite Inspection)',
        },
      ],
    }));

    const applied = estimate.summary.serviceSpecificDiscounts.filter((credit) => credit.amount > 0);
    const skipped = estimate.summary.serviceSpecificDiscounts.find((credit) => credit.warnings.includes('service_specific_discount_duplicate_skipped'));

    expect(applied).toHaveLength(1);
    expect(skipped).toEqual(expect.objectContaining({
      amount: 0,
      capReason: 'duplicate_service_line_credit',
    }));
    expect(estimate.summary.oneTimeTotal).toBe(0);
  });

  test('service-specific credits no longer skip Lawn V2 as non-discountable', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset',
        presetKey: 'lawn_credit',
        catalogName: 'Lawn Credit',
        catalogCategory: 'service_specific_credit',
        discountType: 'fixed_amount',
        service: 'lawn_care',
        requestedAmount: 50,
        label: 'Lawn Credit',
      }],
    }));
    const lawn = estimate.lineItems.find((line) => line.service === 'lawn_care');
    const credit = estimate.summary.serviceSpecificDiscounts.find((row) => row.service === 'lawn_care');

    expect(lawn.annualAfterDiscount).toBe(558.9);
    expect(credit).toEqual(expect.objectContaining({
      amount: 0,
      capReason: 'service_line_price',
    }));
    expect(credit.warnings).not.toContain('service_specific_discount_service_not_discountable');
  });

  test('manual eligibility-gated discounts require confirmation', () => {
    expect(() => generateEstimate(baseInput({
      manualDiscount: {
        source: 'catalog_preset',
        catalogName: 'Military Discount',
        type: 'PERCENT',
        value: 5,
        eligibility: { requiresMilitary: true },
      },
    }))).toThrow('Manual discount eligibility must be confirmed');

    const estimate = generateEstimate(baseInput({
      manualDiscount: {
        source: 'catalog_preset',
        catalogName: 'Military Discount',
        type: 'PERCENT',
        value: 5,
        eligibility: { requiresMilitary: true },
        eligibilityConfirmed: true,
        eligibilityOverrideReason: 'Verified military ID',
      },
    }));
    expect(estimate.summary.manualDiscount.amount).toBeGreaterThan(0);
    expect(estimate.summary.manualDiscount.eligibilityConfirmed).toBe(true);
  });
});
