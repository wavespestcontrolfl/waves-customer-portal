const {
  calculateAnnualPrepayAmount,
  countTierQualifyingRecurringServices,
  determineTier,
  hasWaveGuardSetupService,
  nonDiscountableRecurringAnnualFloor,
  resolveAnnualPrepayDraftAmount,
  shouldCreateDraftInvoiceForRecurring,
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

  test('only recurring pest services trigger WaveGuard setup invoices', () => {
    expect(hasWaveGuardSetupService([
      { service: 'palm_injection', name: 'Palm Injection', waveGuardDiscountEligible: false },
      { service: 'rodent_bait', name: 'Rodent Bait Stations', waveGuardDiscountEligible: false },
    ])).toBe(false);

    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
      { service: 'pest_control', name: 'Pest Control' },
    ])).toBe(true);
  });

  test('annual prepay creates a draft invoice for non-pest recurring plans', () => {
    const lawnOnly = [{ service: 'lawn_care', name: 'Lawn Care' }];

    expect(shouldCreateDraftInvoiceForRecurring({
      billingTerm: 'standard',
      recurringServices: lawnOnly,
    })).toBe(false);
    expect(shouldCreateDraftInvoiceForRecurring({
      billingTerm: 'prepay_annual',
      recurringServices: lawnOnly,
    })).toBe(true);
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
});
