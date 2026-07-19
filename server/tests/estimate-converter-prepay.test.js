const {
  annualPrepayDiscountComponents,
  annualPrepayDiscountPctLabel,
  annualPrepayRecurringUnitCount,
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
  resolveCommercialPrepayTaxRate,
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

  test('WaveGuard setup fee applies to solo pest / solo mosquito plans only', () => {
    // $99 setup applies only to single-service recurring plans — recurring
    // pest only or recurring mosquito only (owner directive 2026-07-10
    // evening; supersedes the same-day pest-mixes rule).
    expect(hasWaveGuardSetupService([
      { service: 'pest_control', name: 'Pest Control' },
    ])).toBe(true);
    expect(hasWaveGuardSetupService([
      { service: 'mosquito', name: 'Mosquito Control' },
    ])).toBe(true);
    // Duplicate rows of the same solo service still count as solo.
    expect(hasWaveGuardSetupService([
      { service: 'pest_control', name: 'Pest Control' },
      { service: 'pest_control', name: 'Pest Control (dup)' },
    ])).toBe(true);
    // Every other solo service carries no setup fee (annual-prepay % instead).
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
    // Multi-service recurring bundles carry NO setup fee — the bundle is the
    // incentive — even when pest or mosquito is in the mix.
    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
      { service: 'pest_control', name: 'Pest Control' },
    ])).toBe(false);
    expect(hasWaveGuardSetupService([
      { service: 'pest_control', name: 'Pest Control' },
      { service: 'mosquito', name: 'Mosquito Control' },
    ])).toBe(false);
    expect(hasWaveGuardSetupService([
      { service: 'lawn_care', name: 'Lawn Care' },
      { service: 'mosquito', name: 'Mosquito Control' },
    ])).toBe(false);
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
    // No-fee mix (lawn): the full 5% applies — the $50/mo lawn program
    // minimum that used to protect a floor slice is DISARMED (owner ruling
    // 2026-07-17; programMinimumMonthly = 0). $660 → 5% on all of it → $627.
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 660,
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: { result: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care', annual: 660 }] } },
    })).toEqual({ amount: 627, discount: 33, rate: 0.05 });

    // A $600 plan (the old floor value) gets the full 5% too — no protected
    // slice remains.
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 600,
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: { result: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care', annual: 600 }] } },
    })).toEqual({ amount: 570, discount: 30, rate: 0.05 });

    // Per-estimate snapshot (pre-push codex P0, round 9 on #2827): a quote
    // whose result carries the re-armed $50 minimum stamp keeps its $600
    // protected slice even though the GLOBAL minimum is disarmed — the
    // prepay 5% only spends the above-floor room ($660 - $600 = $60 → $3),
    // billing exactly what the saved quote promised.
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 660,
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: {
        result: {
          pricingMetadata: { lawnProgramMinimumMonthly: 50 },
          lineItems: [{ service: 'lawn_care', name: 'Lawn Care', annual: 660 }],
        },
      },
    })).toEqual({ amount: 657, discount: 3, rate: 0.0045 });

    // Legacy pre-stamp quote saved while the minimum was armed: the row's
    // own evidence (programMinimumApplied) carries the $50 floor, so the
    // prepay protection holds even though the global is now disarmed and no
    // metadata stamp exists (pre-push codex P0, round 9 on #2827).
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 660,
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: {
        result: {
          lineItems: [{
            service: 'lawn_care', name: 'Lawn Care', annual: 660, tiers: [{ tier: 'standard', monthly: 50, annual: 600, programMinimumApplied: true }],
          }],
        },
      },
    })).toEqual({ amount: 657, discount: 3, rate: 0.0045 });

    // A stale pre-floor engine line item must never shrink the protection
    // Mixed stored sources (stale $408 line item + accepted $600 recurring
    // row): with the lawn program minimum DISARMED (owner ruling
    // 2026-07-17) neither source creates a protected slice — the full 5%
    // applies regardless of which stored shape the payload carries.
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 600,
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: {
        result: {
          lineItems: [{ service: 'lawn_care', name: 'Lawn Care', annual: 408 }],
          recurring: {
            services: [{
              service: 'lawn_care', name: 'Lawn Care',
              ann: 600, annual: 600, annualAfterDiscount: 600,
            }],
          },
        },
      },
    })).toEqual({ amount: 570, discount: 30, rate: 0.05 });

    // Outstanding pre-ruling link with stale $408 rows in both sources:
    // no floor protection is derived from them either.
    const staleBothSources = {
      result: {
        lineItems: [{ service: 'lawn_care', name: 'Lawn Care', annual: 408 }],
        recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', ann: 408 }] },
      },
    };
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 600,
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: staleBothSources,
    })).toEqual({ amount: 570, discount: 30, rate: 0.05 });
    expect(resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 660,
      recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
      estimateData: staleBothSources,
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

  test('annualPrepayDiscountComponents feed the SSR refresh with the SAME math as the invoice calc', () => {
    // The SSR page re-derives the prepay total client-side when a preference
    // toggle changes the annual (refreshBillingAmounts). It must use these
    // components — floor + configured rate — because the effective rate is a
    // function of the annual and goes stale the moment the annual moves.
    const lawnMix = [{ service: 'lawn_care', name: 'Lawn Care' }];
    const estimateData = { result: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care', annual: 660 }] } };
    const { discountRate, protectedFloor } = annualPrepayDiscountComponents({
      recurringServices: lawnMix, estimateData,
    });
    expect(discountRate).toBe(0.05);
    // Lawn program minimum disarmed (owner ruling 2026-07-17): no protected
    // floor slice. The component shape survives so the SSR refresh formula
    // (floor + discountable × (1 − rate)) still reassembles correctly for
    // lines that ARE protected (discountable: false services).
    expect(protectedFloor).toBe(0);
    // Reassembling with the components reproduces resolveAnnualPrepayInvoiceTotal
    // for ANY base annual — this is exactly the client-side refresh formula.
    for (const base of [600, 660, 1068]) {
      const floor = Math.min(base, protectedFloor);
      const discountable = Math.max(0, Math.round((base - floor) * 100) / 100);
      const reassembled = Math.round((floor + discountable * (1 - discountRate)) * 100) / 100;
      expect(reassembled).toBe(resolveAnnualPrepayInvoiceTotal({
        baseAnnual: base, recurringServices: lawnMix, estimateData,
      }).amount);
    }
    // Pest mixes: no % (setup waiver is the incentive) — the refresh must
    // leave the annual untouched.
    expect(annualPrepayDiscountComponents({
      recurringServices: [{ service: 'pest_control', name: 'Pest Control' }],
      estimateData: { result: { lineItems: [] } },
    }).discountRate).toBe(0);
  });

  test('invoice prepay % label reflects the EFFECTIVE rate, never the configured 5%', () => {
    // Uncapped plans keep the configured label; floor-capped lawn plans show
    // the effective rate the public page displayed at approval; a nonzero
    // discount that rounds away renders '<0.1%' rather than a false '0%'.
    expect(annualPrepayDiscountPctLabel(0.05)).toBe('5%');
    // $660 lawn plan: no floor slice since the 2026-07-17 ruling — the
    // effective rate IS the configured 5%.
    expect(annualPrepayDiscountPctLabel(
      resolveAnnualPrepayInvoiceTotal({
        baseAnnual: 660,
        recurringServices: [{ service: 'lawn_care', name: 'Lawn Care' }],
        estimateData: { result: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care', annual: 660 }] } },
      }).rate,
    )).toBe('5%');
    // $603 plan: $0.15 discount on $603 → rate 0.0002 → sub-0.1% sliver.
    expect(annualPrepayDiscountPctLabel(0.0002)).toBe('<0.1%');
    expect(annualPrepayDiscountPctLabel(0)).toBe('0%');
    expect(annualPrepayDiscountPctLabel(undefined)).toBe('0%');
  });

  test('engine-backed foam (no discountable flag) is still protected from the prepay discount', () => {
    // public-quote.js / lead-estimate-automation.js persist the foam line under
    // engineResult.lineItems as a subset WITHOUT discountable:false. The floor must
    // protect it by service key so annual prepay never bleeds the 5% onto foam.
    const estimateData = {
      engineResult: {
        lineItems: [
          { service: 'foam_recurring', name: 'Recurring Foam Treatment (Quarterly)', annual: 1108, monthly: 92.33 },
        ],
      },
    };
    expect(nonDiscountableRecurringAnnualFloor(estimateData)).toBe(1108);

    // foam-only annual prepay: 0% off (cadence multiplier is its only discount).
    const foamOnly = resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 1108,
      recurringServices: [{ service: 'foam_recurring', name: 'Recurring Foam Treatment (Quarterly)' }],
      estimateData,
    });
    expect(foamOnly.amount).toBe(1108);
    expect(foamOnly.discount).toBe(0);

    // foam + a discountable lawn line: only the lawn $600 takes the 5%.
    const mixed = resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 1708,
      recurringServices: [
        { service: 'foam_recurring', name: 'Recurring Foam Treatment (Quarterly)' },
        { service: 'lawn_care', name: 'Lawn Care' },
      ],
      estimateData,
    });
    expect(mixed.amount).toBe(1678); // 1108 foam protected + 95% of $600 lawn
    expect(mixed.discount).toBe(30);
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

describe('annualPrepayRecurringUnitCount (deposit-intent mirror of the converter multi-service block)', () => {
  test('solo recurring service counts 1; bundles count each line', () => {
    expect(annualPrepayRecurringUnitCount({
      recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] },
    })).toBe(1);
    expect(annualPrepayRecurringUnitCount({
      recurring: {
        services: [
          { service: 'pest_control', name: 'Pest Control' },
          { service: 'lawn_care', name: 'Lawn Care' },
        ],
      },
    })).toBe(2);
    expect(annualPrepayRecurringUnitCount({})).toBe(0);
  });

  test('a supplemental combo companion (e.g. rodent bait beside pest) counts as a second unit', () => {
    const count = annualPrepayRecurringUnitCount({
      recurring: {
        services: [{ service: 'pest_control', name: 'Pest Control' }],
        rodentBaitMo: 20,
      },
    });
    // Mirrors convertEstimate's recurringUnitCount: 1 primary + 1 absorbed
    // companion = 2 → prepay unsupported.
    expect(count).toBe(2);
  });
});

describe('commercial prepay blended tax rate (taxable pest share only)', () => {
  test('pest-only commercial prepay is fully taxable (7%)', () => {
    expect(resolveCommercialPrepayTaxRate([
      { service: 'commercial_pest', annual: 2280, taxable: true },
    ])).toBeCloseTo(0.07, 4);
  });

  test('lawn/tree-only commercial prepay is NOT taxed (lawn_spraying_or_treatment exempt)', () => {
    expect(resolveCommercialPrepayTaxRate([
      { service: 'commercial_lawn', annual: 4689, taxable: false },
      { service: 'commercial_tree_shrub', annual: 2412, taxable: false },
    ])).toBe(0);
  });

  test('mixed plan blends the rate to the taxable (pest) share only', () => {
    // pest 2000 of 10000 total → 20% taxable → 0.20 * 0.07 = 0.014.
    const rate = resolveCommercialPrepayTaxRate([
      { service: 'commercial_pest', annual: 2000, taxable: true },
      { service: 'commercial_lawn', annual: 8000, taxable: false },
    ]);
    expect(rate).toBeCloseTo(0.014, 4);
    // Applied to the $10k prepay this yields $140 tax = exactly 7% of the $2k pest.
    expect(Math.round(10000 * rate * 100) / 100).toBe(140);
  });

  test('all-discountable mix: the prepay discount cancels out (same rate pre/post-discount)', () => {
    // pest + lawn both discountable → both ×0.95, so the taxable share is
    // unchanged by the discount. 2000/10000 → 0.014.
    const rate = resolveCommercialPrepayTaxRate(
      [
        { service: 'commercial_pest', annual: 2000, taxable: true },
        { service: 'commercial_lawn', annual: 8000, taxable: false },
      ],
      { prepayDiscountApplied: true },
    );
    expect(rate).toBeCloseTo(0.014, 4);
  });

  test('taxable pest + NON-discountable foam: rate uses post-discount allocation', () => {
    // pest 2000 (discountable, taxable) + foam 2000 (non-discountable, non-taxable).
    // Post-discount invoice = 2000*0.95 + 2000 = 1900 + 2000 = 3900.
    // taxable post-discount = 1900. rate = 1900*0.07/3900 = 0.0341.
    const rate = resolveCommercialPrepayTaxRate(
      [
        { service: 'commercial_pest', annual: 2000, taxable: true },
        { service: 'foam_recurring', annual: 2000, taxable: false },
      ],
      { prepayDiscountApplied: true },
    );
    expect(rate).toBeCloseTo((1900 * 0.07) / 3900, 4);
    // The tax on the $3,900 invoice is exactly 7% of the discounted $1,900 pest.
    expect(Math.round(3900 * rate * 100) / 100).toBeCloseTo(133.0, 1);
  });

  test('keys off the service even when the taxable flag was dropped on a save path', () => {
    // 50/50 pest+lawn, pest flag missing → still 0.5 * 0.07 = 0.035.
    expect(resolveCommercialPrepayTaxRate([
      { service: 'commercial_pest', annual: 1000 },
      { service: 'commercial_lawn', annual: 1000 },
    ])).toBeCloseTo(0.035, 4);
  });

  test('commercial mosquito / termite / rodent are taxable by service key even without the flag', () => {
    // Engine-backed (quote-wizard) accepts source recurring rows from lineItems,
    // and a save path can drop item.taxable. The pest-FAMILY keys must still be
    // recognized as taxable so the annual-prepay total isn't taxed as $0. Lawn
    // (non-taxable) stays the non-taxable share. (Regression for the bot's P1.)
    for (const svc of ['commercial_mosquito', 'commercial_termite_bait', 'commercial_rodent_bait']) {
      // Flag dropped: 50/50 taxable-pest-family + lawn → 0.5 * 0.07 = 0.035.
      expect(resolveCommercialPrepayTaxRate([
        { service: svc, annual: 1000 },
        { service: 'commercial_lawn', annual: 1000 },
      ])).toBeCloseTo(0.035, 4);
      // Pest-family only → fully taxable at the base rate.
      expect(resolveCommercialPrepayTaxRate([
        { service: svc, annual: 1500 },
      ])).toBeCloseTo(0.07, 4);
    }
  });

  test('empty / zero-total recurring set yields a 0 rate (no divide-by-zero)', () => {
    expect(resolveCommercialPrepayTaxRate([])).toBe(0);
    expect(resolveCommercialPrepayTaxRate([{ service: 'commercial_pest', annual: 0 }])).toBe(0);
  });

  test('baseRate honors exemptions and non-7% counties (not hardcoded)', () => {
    const rows = [
      { service: 'commercial_pest', annual: 2000, taxable: true },
      { service: 'commercial_lawn', annual: 8000, taxable: false },
    ];
    // Tax-exempt customer → effective baseRate 0 → no tax at all.
    expect(resolveCommercialPrepayTaxRate(rows, { baseRate: 0 })).toBe(0);
    // A 6.5% county (e.g. Lee) → blended on the 20% pest share = 0.013, not 0.014.
    expect(resolveCommercialPrepayTaxRate(rows, { baseRate: 0.065 })).toBeCloseTo(0.2 * 0.065, 4);
    // Default (no baseRate) still falls back to the FL 7%.
    expect(resolveCommercialPrepayTaxRate(rows)).toBeCloseTo(0.2 * 0.07, 4);
  });

  test('full-precision rate: a tiny taxable share still produces the right tax dollars', () => {
    // pest $50 of $50,050 → share ~0.000999 → rate ~0.0000699. Rounding the rate
    // to 4 dp would drop the tax; full precision keeps it. (Regression for the
    // PR bot's rate-rounding P1.)
    const rate = resolveCommercialPrepayTaxRate([
      { service: 'commercial_pest', annual: 50, taxable: true },
      { service: 'commercial_lawn', annual: 50000, taxable: false },
    ]);
    // InvoiceService computes tax = round(invoiceTotal * rate) → exactly 7% of $50.
    expect(Math.round(50050 * rate * 100) / 100).toBe(3.5);
  });
});
