const {
  calculateAnnualPrepayAmount,
  canAutoSendDraftInvoice,
  countTierQualifyingRecurringServices,
  determineTier,
  hasWaveGuardSetupService,
  nonDiscountableRecurringAnnualFloor,
  resolveFirstApplicationAmount,
  resolveAnnualPrepayDraftAmount,
  shouldAttachScheduledServiceToStandardDraftInvoice,
  shouldIncludeWaveGuardSetupFeeForRecurring,
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

  test('WaveGuard setup services trigger setup invoices', () => {
    expect(hasWaveGuardSetupService([
      { service: 'palm_injection', name: 'Palm Injection', waveGuardDiscountEligible: false },
      { service: 'rodent_bait', name: 'Rodent Bait Stations', waveGuardDiscountEligible: false },
    ])).toBe(false);

    expect(hasWaveGuardSetupService([
      { service: 'pest_control', name: 'Pest Control' },
    ])).toBe(true);
    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
    ])).toBe(true);
    expect(hasWaveGuardSetupService([
      { service: 'termite_bait', name: 'Termite Bait Stations' },
    ])).toBe(true);
    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
      { service: 'tree_shrub', name: 'Tree & Shrub' },
    ])).toBe(false);
    expect(hasWaveGuardSetupService([
      { service: 'mosquito', name: 'Mosquito Control' },
    ])).toBe(false);
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: { oneTime: { items: [{ service: 'one_time_pest', name: 'Pest Control' }] } },
    })).toBe(false);
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: {
        result: {
          oneTime: {
            specItems: [{ service: 'tree_shrub', name: 'Tree & Shrub treatment' }],
          },
        },
      },
    })).toBe(false);
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
