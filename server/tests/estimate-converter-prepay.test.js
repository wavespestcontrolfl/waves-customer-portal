const {
  calculateAnnualPrepayAmount,
  canAutoSendDraftInvoice,
  countTierQualifyingRecurringServices,
  determineTier,
  hasWaveGuardSetupService,
  nonDiscountableRecurringAnnualFloor,
  resolveFirstApplicationAmount,
  resolveAnnualPrepayDraftAmount,
  resolveAnnualPrepayInvoiceTotal,
  recurringServicesFromEstimateData,
  shouldAttachScheduledServiceToStandardDraftInvoice,
  shouldIncludeWaveGuardSetupFeeForRecurring,
  shouldCreateDraftInvoiceForRecurring,
  shouldSuppressRecurringConversion,
} = require('../services/estimate-converter');

describe('estimate converter annual prepay amount', () => {
  test('uses quoted monthly total times 12, preserving zone/frequency/bundle math', () => {
    expect(calculateAnnualPrepayAmount(84.32)).toBe(1011.84);
    expect(calculateAnnualPrepayAmount('84.315')).toBe(1011.78);
  });

  test('does not collapse to a quarterly base-price shortcut', () => {
    const zoneAndRoachAdjustedMonthly = 195.62 * 4 / 12;

    expect(calculateAnnualPrepayAmount(zoneAndRoachAdjustedMonthly)).toBe(782.48);
    expect(calculateAnnualPrepayAmount(zoneAndRoachAdjustedMonthly)).not.toBe(648);
  });

  test('annual prepay draft amount prefers accepted annual total over monthly fallback', () => {
    expect(resolveAnnualPrepayDraftAmount({
      prepayInvoiceAmount: 777.77,
      annualTotal: 660,
      monthlyRate: 55,
    })).toBe(777.77);
    expect(resolveAnnualPrepayDraftAmount({
      annualTotal: 660,
      monthlyRate: 0,
    })).toBe(660);
    expect(resolveAnnualPrepayDraftAmount({
      monthlyRate: 55,
    })).toBe(660);
  });

  test('counts only tier-qualifying recurring services for WaveGuard activation', () => {
    const qualifyingCount = countTierQualifyingRecurringServices([
      { service: 'pest_control', name: 'Pest Control' },
      { service: 'palm_injection', name: 'Palm Injection', waveGuardDiscountEligible: false },
      { service: 'rodent_bait', name: 'Rodent Bait Stations', waveGuardDiscountEligible: false },
      { service: 'lawn_care', name: 'Lawn Care', discountable: false, discountEligible: false },
      { service: 'lawn_care', name: 'Duplicate Lawn Care' },
    ]);

    expect(qualifyingCount).toBe(2);
    expect(determineTier(qualifyingCount, true)).toEqual(expect.objectContaining({ tier: 'Silver' }));
    expect(determineTier(0, true)).toEqual(expect.objectContaining({ tier: 'Bronze' }));
    expect(determineTier(0, false)).toEqual(expect.objectContaining({ tier: 'none' }));
  });

  test('WaveGuard setup fee applies to recurring pest/mosquito mixes only', () => {
    // $99 setup applies only to recurring Pest or Mosquito mixes.
    expect(hasWaveGuardSetupService([
      { service: 'pest_control', name: 'Pest Control' },
    ])).toBe(true);
    expect(hasWaveGuardSetupService([
      { service: 'mosquito', name: 'Mosquito Control' },
    ])).toBe(true);
    // Everything else carries no setup fee (5% annual-prepay discount instead).
    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
    ])).toBe(false);
    expect(hasWaveGuardSetupService([
      { service: 'termite_bait', name: 'Termite Bait Stations' },
    ])).toBe(false);
    expect(hasWaveGuardSetupService([
      { service: 'palm_injection', name: 'Palm Injection', waveGuardDiscountEligible: false },
      { service: 'rodent_bait', name: 'Rodent Bait Stations', waveGuardDiscountEligible: false },
    ])).toBe(false);
    expect(hasWaveGuardSetupService([
      { service: 'tree_shrub', name: 'Tree & Shrub' },
    ])).toBe(false);
    // Mixes containing pest or mosquito always charge the setup (no 5% stacking).
    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
      { service: 'pest_control', name: 'Pest Control' },
    ])).toBe(true);
    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
      { service: 'mosquito', name: 'Mosquito Control' },
    ])).toBe(true);
    // Lawn + tree (no pest/mosquito) → no setup.
    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
      { service: 'tree_shrub', name: 'Tree & Shrub' },
    ])).toBe(false);
    // Existing pest members never pay the setup again, even with pest present.
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: [{ service: 'pest_control', name: 'Pest Control' }],
      estimateData: { membershipSnapshot: { isExistingCustomer: true } },
    })).toBe(false);
  });

  test('resolveAnnualPrepayInvoiceTotal: 5% for no-fee mixes, none for pest/mosquito, floor-clamped', () => {
    // No-fee mix (lawn): 5% off; lawn lines are excluded from the floor.
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 660,
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: { result: { lineItems: [] } },
    })).toEqual({ amount: 627, discount: 33, rate: 0.05 });

    // Pest/mosquito: setup-waiver path, no extra discount.
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 660,
      recurringServices: [{ service: 'pest_control', name: 'Pest Control' }],
      estimateData: { result: { lineItems: [] } },
    })).toEqual({ amount: 660, discount: 0, rate: 0 });

    // No-fee mix with a non-discountable (non-lawn) line: the 5% applies ONLY to
    // the discountable remainder. The protected line is split out first and added
    // back at full price, so the prepay % never bleeds onto it (e.g. foam, whose
    // cadence multiplier is its only discount).
    const floored = resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 660,
      recurringServices: [{ service: 'tree_shrub', name: 'Tree & Shrub' }],
      estimateData: { result: { lineItems: [{ service: 'tree_shrub', annual: 650, discountable: false }] } },
    });
    expect(floored.amount).toBe(659.5); // 650 protected + 5% off only the $10 discountable remainder
    expect(floored.discount).toBe(0.5);
    expect(floored.rate).toBeCloseTo(0.0008, 4);
  });

  test('all recurring pay-per-application accepts create invoices', () => {
    const lawnOnly = [{ service: 'lawn_care', name: 'Lawn Care' }];
    const mosquitoOnly = [{ service: 'mosquito', name: 'Mosquito Control' }];
    const treeOnly = [{ service: 'tree_shrub', name: 'Tree & Shrub' }];

    expect(shouldCreateDraftInvoiceForRecurring({
      billingTerm: 'standard',
      recurringServices: lawnOnly,
    })).toBe(true);
    expect(shouldCreateDraftInvoiceForRecurring({
      billingTerm: 'standard',
      recurringServices: mosquitoOnly,
    })).toBe(true);
    expect(shouldCreateDraftInvoiceForRecurring({
      billingTerm: 'standard',
      recurringServices: treeOnly,
    })).toBe(true);
    expect(shouldCreateDraftInvoiceForRecurring({
      billingTerm: 'prepay_annual',
      recurringServices: lawnOnly,
    })).toBe(true);
  });

  test('suppresses recurring conversion only for zero-dollar standard accepts', () => {
    expect(shouldSuppressRecurringConversion({
      billingTerm: 'standard',
      monthlyRate: 0,
      oneTimeTotal: 249,
      recurringServices: [{ service: 'pest_control', name: 'Pest Control', mo: 0 }],
    })).toBe(true);
    expect(shouldSuppressRecurringConversion({
      billingTerm: 'standard',
      monthlyRate: 0,
      recurringServices: [{ service: 'pest_control', name: 'Pest Control', mo: 0 }],
    })).toBe(false);
    expect(shouldSuppressRecurringConversion({
      billingTerm: 'standard',
      monthlyRate: 89,
    })).toBe(false);
    expect(shouldSuppressRecurringConversion({
      billingTerm: 'standard',
      monthlyRate: 0,
      oneTimeTotal: 249,
      recurringServices: [{ service: 'pest_control', name: 'Pest Control', mo: 89 }],
    })).toBe(false);
    expect(shouldSuppressRecurringConversion({
      billingTerm: 'standard',
      monthlyRate: 0,
      oneTimeTotal: 249,
      recurringServices: [{ service: 'pest_control', name: 'Pest Control', mo: 0, quoteRequired: true }],
    })).toBe(false);
    expect(shouldSuppressRecurringConversion({
      billingTerm: 'standard',
      monthlyRate: 0,
      oneTimeTotal: 249,
      estimateData: { result: { recurring: { monthlyTotal: 89 } } },
    })).toBe(false);
    expect(shouldSuppressRecurringConversion({
      billingTerm: 'standard',
      monthlyRate: 0,
      oneTimeTotal: 249,
      estimateData: {
        result: {
          results: {
            recurring: {
              services: [{ service: 'pest_control', name: 'Pest Control', mo: 89 }],
            },
          },
        },
      },
    })).toBe(false);
    expect(shouldSuppressRecurringConversion({
      billingTerm: 'standard',
      monthlyRate: 0,
      estimateData: { result: { oneTime: { total: 249 } } },
    })).toBe(true);
    expect(shouldSuppressRecurringConversion({
      billingTerm: 'prepay_annual',
      monthlyRate: 0,
      oneTimeTotal: 249,
    })).toBe(false);
  });

  test('merges duplicate recurring service rows and keeps the richest row', () => {
    const rows = recurringServicesFromEstimateData({
      recurring: {
        services: [{ service: 'pest_control', name: 'Pest Control' }],
      },
      result: {
        recurring: {
          services: [{
            service: 'pest_control',
            name: 'Pest Control',
            mo: 0,
            frequency: 'quarterly',
            visitsPerYear: 4,
            estimatedDurationMinutes: 60,
          }],
        },
        results: {
          recurring: {
            services: [{ service: 'pest_control', name: 'Pest Control', mo: 89 }],
          },
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      mo: 89,
      frequency: 'quarterly',
      visitsPerYear: 4,
      estimatedDurationMinutes: 60,
    }));
  });

  test('pay-per-application invoice prefers accepted first application amount', () => {
    expect(resolveFirstApplicationAmount({
      firstApplicationAmount: 128.456,
      billingCadence: { amount: 99 },
      monthlyRate: 55,
    })).toBe(128.46);
    expect(resolveFirstApplicationAmount({
      billingCadence: { amount: 99 },
      monthlyRate: 55,
    })).toBe(99);
  });

  test('pay-per-application invoice can suppress undisclosed first-application fallback', () => {
    expect(resolveFirstApplicationAmount({
      billingCadence: { amount: 99 },
      monthlyRate: 55,
      allowFallback: false,
    })).toBe(0);

    expect(resolveFirstApplicationAmount({
      firstApplicationAmount: 128.456,
      billingCadence: { amount: 99 },
      monthlyRate: 55,
      allowFallback: false,
    })).toBe(128.46);
  });

  test('annual prepay floor excludes discountable Lawn V2 lines', () => {
    const estimateData = {
      lineItems: [
        {
          service: 'lawn_care',
          annual: 828,
          annualAfterDiscount: 828,
          discount: {
            discountable: false,
            policy: 'LAWN_V2_NET_55_FLOOR_PRICE',
          },
        },
        {
          service: 'pest_control',
          annual: 468,
          annualAfterDiscount: 421.2,
          discount: { discountable: true },
        },
      ],
    };

    expect(nonDiscountableRecurringAnnualFloor(estimateData)).toBe(0);
  });

  test('annual prepay floor reads public quote engineResult line items and annual aliases', () => {
    const estimateData = {
      engineResult: {
        lineItems: [
          {
            service: 'lawn_care',
            ann: 828,
            discount: {
              discountable: false,
              policy: 'LAWN_V2_NET_55_FLOOR_PRICE',
            },
          },
          {
            service: 'pest_control',
            annual: 468,
            discount: { discountable: true },
          },
        ],
      },
    };

    expect(nonDiscountableRecurringAnnualFloor(estimateData)).toBe(0);
  });

  test('annual prepay draft invoices require a synced term before auto-send', () => {
    expect(canAutoSendDraftInvoice({
      billingTerm: 'standard',
      annualPrepayTermId: null,
    })).toBe(true);
    expect(canAutoSendDraftInvoice({
      billingTerm: 'prepay_annual',
      annualPrepayTermId: null,
    })).toBe(false);
    expect(canAutoSendDraftInvoice({
      billingTerm: 'prepay_annual',
      annualPrepayTermId: 'term-1',
    })).toBe(true);
  });

  test('standard draft invoices attach to the scheduled service only when they include first application', () => {
    expect(shouldAttachScheduledServiceToStandardDraftInvoice({
      firstScheduledServiceId: 'svc-1',
      firstApplicationAmount: 128.45,
    })).toBe(true);

    expect(shouldAttachScheduledServiceToStandardDraftInvoice({
      firstScheduledServiceId: 'svc-1',
      firstApplicationAmount: 0,
    })).toBe(false);

    expect(shouldAttachScheduledServiceToStandardDraftInvoice({
      firstScheduledServiceId: null,
      firstApplicationAmount: 128.45,
    })).toBe(false);
  });
});
