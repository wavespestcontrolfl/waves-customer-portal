const {
  calculatePropertyProfile,
  generateEstimate,
  priceLawnCare,
  priceOneTimeLawn,
  priceOneTimeMosquito,
  priceOneTimePest,
  pricePestControl,
  priceFoamDrill,
  constants,
} = require('../services/pricing-engine');

// One-time pest = max(floor, quarterlyPerApp × multiplier). Pure multiple off
// the quarterly rate; keeps a one-off visit above recurring visit-1.
function expectedOneTimePest(quarterlyPerApp) {
  const { multiplier, floor } = constants.ONE_TIME.pest;
  return Math.max(floor, Math.round(quarterlyPerApp * multiplier));
}

function property(overrides = {}) {
  return calculatePropertyProfile({
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    zone: 'A',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    ...overrides,
  });
}

function estimateInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    zone: 'A',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    paymentMethod: 'card',
    ...overrides,
  };
}

describe('pricing engine one-time treatment rules', () => {
  test('one-time pest = (quarterly baseline + setup) × premium, floor, and no zone multiplier', () => {
    const p = property();
    const recurringBase = pricePestControl(p, { frequency: 'quarterly', roachType: 'none' }).basePrice;
    const result = priceOneTimePest(p, { urgency: 'NONE', afterHours: false, isRecurringCustomer: false });

    expect(recurringBase).toBe(117);
    expect(result.quarterlyPerApp).toBe(117);
    expect(result.multiplier).toBe(constants.ONE_TIME.pest.multiplier);
    expect(result.price).toBe(expectedOneTimePest(recurringBase));
    // One-time must cost strictly more than recurring visit 1 ($99 setup + quarterly rate).
    expect(result.price).toBeGreaterThan(recurringBase + constants.PEST.initialFee);
    expect(result.discount?.appliedDiscounts || []).not.toContainEqual(expect.objectContaining({ type: 'waveguard' }));

    const zoneA = generateEstimate(estimateInput({ zone: 'A', services: { oneTimePest: { urgency: 'NONE' } } }));
    const zoneD = generateEstimate(estimateInput({ zone: 'D', services: { oneTimePest: { urgency: 'NONE' } } }));
    expect(zoneA.lineItems.find(i => i.service === 'one_time_pest').price).toBe(
      zoneD.lineItems.find(i => i.service === 'one_time_pest').price
    );
  });

  test('one-time pest applies urgency but not WaveGuard tier discount', () => {
    const p = property();
    const base = expectedOneTimePest(pricePestControl(p, { frequency: 'quarterly' }).basePrice);
    const result = priceOneTimePest(p, { urgency: 'URGENT', afterHours: true, isRecurringCustomer: false });

    expect(result.urgencyMultiplier).toBe(2);
    expect(result.price).toBe(Math.max(constants.ONE_TIME.pest.floor, Math.round(base * 2)));
  });

  test('one-time pest recurring-customer perk is 15% and is not applied twice', () => {
    const p = property({
      homeSqFt: 10000,
      lotSqFt: 30000,
      features: { shrubs: 'heavy', trees: 'heavy', complexity: 'complex', nearWater: true, largeDriveway: true },
    });
    const recurringBase = pricePestControl(p, { frequency: 'quarterly' }).basePrice;
    const preDiscount = expectedOneTimePest(recurringBase);
    const expected = Math.max(constants.ONE_TIME.pest.floor, Math.round(preDiscount * 0.85));
    const direct = priceOneTimePest(p, { urgency: 'NONE', isRecurringCustomer: true });

    expect(direct.recurringCustomerDiscountRate).toBe(0.15);
    expect(direct.price).toBe(expected);

    const estimate = generateEstimate({
      homeSqFt: 10000,
      stories: 1,
      lotSqFt: 30000,
      propertyType: 'single_family',
      zone: 'A',
      features: { shrubs: 'heavy', trees: 'heavy', complexity: 'complex', nearWater: true, largeDriveway: true },
      isRecurringCustomer: true,
      services: { oneTimePest: { urgency: 'NONE' } },
    });
    const item = estimate.lineItems.find(i => i.service === 'one_time_pest');
    expect(item.priceAfterDiscount).toBe(expected);
    expect(estimate.summary.oneTimeTotal).toBe(expected);
    expect(item.discount.appliedDiscounts).toEqual([
      expect.objectContaining({ type: 'recurring_customer_one_time_perk', amount: 0.15 }),
    ]);
    expect(item.discount.appliedDiscounts).not.toContainEqual(expect.objectContaining({ type: 'waveguard' }));
  });

  test('one-time lawn preserves recurring baseline, treatment multiplier, urgency, perk, and floor', () => {
    const p = property({ measuredTurfSf: 6000 });
    const lawn = priceLawnCare(p, { track: 'st_augustine', tier: 'enhanced', lawnFreq: 6, useLawnCostFloor: false });
    const base = Math.max(115, Math.round(lawn.perApp * 1.50));
    const treated = Math.max(115, Math.round(base * 1.38));
    const expected = Math.max(115, Math.round(treated * 1.50 * 0.85));
    const result = priceOneTimeLawn(p, {
      treatmentType: 'fungicide',
      urgency: 'URGENT',
      afterHours: false,
      isRecurringCustomer: true,
      track: 'st_augustine',
      tier: 'enhanced',
      lawnFreq: 6,
    });

    expect(result.baselinePerApp).toBe(lawn.perApp);
    expect(result.treatmentMultiplier).toBe(1.38);
    expect(result.urgencyMultiplier).toBe(1.5);
    expect(result.recurringCustomerDiscountRate).toBe(0.15);
    expect(result.price).toBe(expected);
  });

  test('one-time mosquito uses mosquito treatable area for SMALL bucket', () => {
    const result = priceOneTimeMosquito({
      lotSqFt: 12000,
      footprint: 4500,
      hardscape: 0,
      mosquitoTreatableSqFt: 7500,
    });

    expect(result.mosquitoTreatableSqFt).toBe(7500);
    expect(result.areaBucket).toBe('SMALL');
    expect(result.basePrice).toBe(99);
    expect(result.price).toBe(99);
    expect(result.recurringCustomerDiscountRate).toBe(0);
  });

  test('one-time mosquito add-ons use $75 stations and $15 dunks', () => {
    const result = priceOneTimeMosquito({ mosquitoTreatableSqFt: 8000 }, {
      stationCount: 2,
      dunkCount: 3,
    });

    expect(result.areaBucket).toBe('STANDARD');
    expect(result.basePrice).toBe(129);
    expect(result.stationAddOnTotal).toBe(150);
    expect(result.dunkAddOnTotal).toBe(45);
    expect(result.price).toBe(324);
  });

  test('one-time mosquito recurring-customer perk is 15%, with no urgency or WaveGuard discount', () => {
    const result = priceOneTimeMosquito({ mosquitoTreatableSqFt: 8000 }, {
      stationCount: 2,
      dunkCount: 0,
      isRecurringCustomer: true,
      urgency: 'URGENT',
      afterHours: true,
    });

    expect(result.subtotalBeforeRecurringCustomerDiscount).toBe(279);
    expect(result.recurringCustomerDiscountRate).toBe(0.15);
    expect(result.price).toBe(Math.round(279 * 0.85));
  });

  test('one-time mosquito does not qualify for WaveGuard but can receive recurring-customer perk', () => {
    const estimate = generateEstimate(estimateInput({
      services: {
        lawn: { track: 'st_augustine', tier: 'enhanced' },
        pest: { frequency: 'quarterly' },
        oneTimeMosquito: { stationCount: 2, dunkCount: 0 },
      },
    }));

    const mosquito = estimate.lineItems.find(i => i.service === 'one_time_mosquito');
    expect(estimate.waveGuard.qualifyingCount).toBe(2);
    expect(estimate.waveGuard.activeServices).toEqual(['pest_control', 'lawn_care']);
    expect(mosquito.discount.appliedDiscounts).toEqual([
      expect.objectContaining({ type: 'recurring_customer_one_time_perk', amount: 0.15 }),
    ]);
    expect(mosquito.discount.appliedDiscounts).not.toContainEqual(expect.objectContaining({ type: 'waveguard' }));
  });

  test('palm injection and rodent bait do not trigger the one-time recurring-customer perk', () => {
    const estimate = generateEstimate(estimateInput({
      services: {
        palm: { palmCount: 3, treatmentType: 'combo', palmSize: 'medium' },
        rodentBait: {},
        oneTimeMosquito: { stationCount: 0, dunkCount: 0 },
      },
    }));

    const mosquito = estimate.lineItems.find(i => i.service === 'one_time_mosquito');
    expect(estimate.waveGuard.qualifyingCount).toBe(0);
    expect(estimate.waveGuard.activeServices).toEqual([]);
    expect(mosquito.recurringCustomerDiscountRate).toBe(0);
    expect(mosquito.price).toBe(mosquito.subtotalBeforeRecurringCustomerDiscount);
  });

  test('seasonal9 and monthly12 recurring mosquito programs qualify for WaveGuard', () => {
    for (const program of ['seasonal9', 'monthly12']) {
      const estimate = generateEstimate(estimateInput({
        services: {
          lawn: { track: 'st_augustine', tier: 'enhanced' },
          pest: { frequency: 'quarterly' },
          mosquito: { tier: program },
        },
      }));
      const mosquito = estimate.lineItems.find(i => i.service === 'mosquito');
      expect(mosquito.tier).toBe(program);
      expect(mosquito.visits).toBe(program === 'seasonal9' ? 9 : 12);
      expect(estimate.waveGuard.qualifyingCount).toBe(3);
      expect(mosquito.discount.appliedDiscounts).toContainEqual(
        expect.objectContaining({ type: 'waveguard', amount: 0.15, tier: 'gold' })
      );
    }
  });

  test('one-time services are zone-agnostic across pest, lawn, and mosquito', () => {
    const services = {
      oneTimePest: { urgency: 'SOON' },
      oneTimeLawn: { treatmentType: 'weed', urgency: 'SOON' },
      oneTimeMosquito: { stationCount: 1, dunkCount: 2 },
    };
    const zoneA = generateEstimate(estimateInput({ zone: 'A', services }));
    const zoneD = generateEstimate(estimateInput({ zone: 'D', services }));

    for (const service of ['one_time_pest', 'one_time_lawn', 'one_time_mosquito']) {
      expect(zoneA.lineItems.find(i => i.service === service).price).toBe(
        zoneD.lineItems.find(i => i.service === service).price
      );
    }
  });

  test('recurring services are zone-agnostic across A through D', () => {
    const services = {
      pest: { frequency: 'quarterly' },
      treeShrub: { tier: 'enhanced', treeCount: 5 },
      palm: { palmCount: 3, treatmentType: 'combo', palmSize: 'medium' },
      mosquito: { tier: 'monthly12', stationCount: 2, dunkCount: 4 },
      termite: { system: 'advance', monitoringTier: 'basic' },
      rodentBait: {},
    };
    const zoneA = generateEstimate(estimateInput({ zone: 'A', services }));
    const zoneD = generateEstimate(estimateInput({ zone: 'D', services }));

    expect(zoneA.summary.recurringAnnualBeforeDiscount).toBe(zoneD.summary.recurringAnnualBeforeDiscount);
    expect(zoneA.summary.recurringAnnualAfterDiscount).toBe(zoneD.summary.recurringAnnualAfterDiscount);

    for (const service of ['pest_control', 'tree_shrub', 'palm_injection', 'mosquito', 'termite_bait', 'rodent_bait']) {
      const a = zoneA.lineItems.find(i => i.service === service);
      const d = zoneD.lineItems.find(i => i.service === service);
      expect(d.annual).toBe(a.annual);
      expect(d.monthly).toBe(a.monthly);
    }
  });

  test('foam drill selects tiers by point range and never falls back to Spot for higher counts', () => {
    const spot = priceFoamDrill(5);
    const moderate = priceFoamDrill(6);

    expect(spot.tier).toContain('Spot');
    expect(moderate.tier).toContain('Moderate');
    expect(moderate.cans).toBe(2);
    expect(moderate.price).toBeGreaterThanOrEqual(spot.price);
  });

  test('foam drill rejects invalid point counts instead of defaulting to Spot', () => {
    expect(() => priceFoamDrill(0)).toThrow(/positive whole number/);
    expect(() => priceFoamDrill(21)).toThrow(/exceeds the configured 20-point maximum/);
    expect(() => priceFoamDrill('abc')).toThrow(/positive whole number/);
    expect(() => generateEstimate(estimateInput({
      services: { foam: { points: 0 } },
    }))).toThrow(/positive whole number/);
  });
});
