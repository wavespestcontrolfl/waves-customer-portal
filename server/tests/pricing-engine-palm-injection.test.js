const {
  pricePalmInjection,
  resolvePalmCount,
  generateEstimate,
  determineWaveGuardTier,
  getEffectiveDiscount,
  applyDiscount,
} = require('../services/pricing-engine');

const property = {};

describe('pricing engine palm injection revisions', () => {
  describe('validation', () => {
    test('missing options throws', () => {
      expect(() => pricePalmInjection(property)).toThrow(/options are required/);
    });

    test('missing treatmentType throws', () => {
      expect(() => pricePalmInjection(property, { palmCount: 1 })).toThrow(/treatmentType is required/);
    });

    test('unknown treatmentType throws', () => {
      expect(() => pricePalmInjection(property, { treatmentType: 'unknown', palmCount: 1 })).toThrow(/Unknown palm treatment/);
    });

    test('missing palmCount throws', () => {
      expect(() => pricePalmInjection(property, { treatmentType: 'nutrition' })).toThrow(/palmCount/);
    });

    test.each([0, -1, 1.5, '2'])('invalid palmCount %p throws', (palmCount) => {
      expect(() => pricePalmInjection(property, { treatmentType: 'nutrition', palmCount })).toThrow(/positive integer/);
    });

    test('non-numeric customPricePerPalm throws', () => {
      expect(() => pricePalmInjection(property, {
        treatmentType: 'nutrition',
        palmCount: 1,
        customPricePerPalm: 'abc',
      })).toThrow(/customPricePerPalm/);
    });

    test('negative customPricePerPalm throws', () => {
      expect(() => pricePalmInjection(property, {
        treatmentType: 'nutrition',
        palmCount: 1,
        customPricePerPalm: -1,
      })).toThrow(/non-negative/);
    });
  });

  describe('minimum billing', () => {
    test('nutrition, 6 palms, 1x/year keeps protocol economics unchanged', () => {
      const result = pricePalmInjection(property, { treatmentType: 'nutrition', palmCount: 6 });

      expect(result.pricePerPalm).toBe(35);
      expect(result.rawPerVisit).toBe(210);
      expect(result.perVisit).toBe(210);
      expect(result.annual).toBe(210);
      expect(result.monthly).toBe(17.5);
      expect(result.minimumApplied).toBe(false);
    });

    test('one nutrition palm defaults to one annual application and applies visit minimum to annual', () => {
      const result = pricePalmInjection(property, { treatmentType: 'nutrition', palmCount: 1 });

      expect(result.pricePerPalm).toBe(35);
      expect(result.appsPerYear).toBe(1);
      expect(result.rawPerVisit).toBe(35);
      expect(result.perVisit).toBe(75);
      expect(result.minimumShortfallPerVisit).toBe(40);
      expect(result.annual).toBe(75);
      expect(result.minimumApplied).toBe(true);
    });

    test('one nutrition palm at two applications applies visit minimum twice', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'nutrition',
        palmCount: 1,
        appsPerYear: 2,
      });

      expect(result.rawPerVisit).toBe(35);
      expect(result.perVisit).toBe(75);
      expect(result.annual).toBe(150);
      expect(result.appsPerYear).toBe(2);
      expect(result.minimumApplied).toBe(true);
    });

    test('internal material cost basis is not exposed by default or public include requests', () => {
      const publicResult = pricePalmInjection(property, { treatmentType: 'nutrition', palmCount: 1 });
      const publicIncludeResult = pricePalmInjection(property, {
        treatmentType: 'nutrition',
        palmCount: 1,
        includeInternalCostBasis: true,
      });
      const internalResult = pricePalmInjection(property, {
        treatmentType: 'nutrition',
        palmCount: 1,
        includeInternalCostBasis: true,
        isInternal: true,
      });

      expect(publicResult.internalCostBasis).toBeUndefined();
      expect(publicIncludeResult.internalCostBasis).toBeUndefined();
      expect(internalResult.internalCostBasis).toEqual(expect.objectContaining({ palmJetMg1L: expect.any(Object) }));
    });
  });

  describe('tiered insecticide', () => {
    test('insecticide small uses small tier', () => {
      const result = pricePalmInjection(property, { treatmentType: 'insecticide', palmCount: 2, palmSize: 'small' });
      expect(result.palmSize).toBe('small');
      expect(result.pricePerPalm).toBe(45);
      expect(result.appsPerYear).toBe(2);
    });

    test('insecticide medium uses medium tier', () => {
      const result = pricePalmInjection(property, { treatmentType: 'insecticide', palmCount: 3, palmSize: 'medium' });
      expect(result.pricePerPalm).toBe(55);
      expect(result.appsPerYear).toBe(2);
      expect(result.rawPerVisit).toBe(165);
      expect(result.perVisit).toBe(165);
      expect(result.annual).toBe(330);
      expect(result.monthly).toBe(27.5);
    });

    test('insecticide large uses large tier', () => {
      const result = pricePalmInjection(property, { treatmentType: 'insecticide', palmCount: 2, palmSize: 'large' });
      expect(result.pricePerPalm).toBe(75);
    });

    test('insecticide missing palmSize throws', () => {
      expect(() => pricePalmInjection(property, { treatmentType: 'insecticide', palmCount: 1 })).toThrow(/palmSize/);
    });

    test('insecticide highDose without customPricePerPalm throws', () => {
      expect(() => pricePalmInjection(property, {
        treatmentType: 'insecticide',
        palmCount: 1,
        palmSize: 'medium',
        highDose: true,
      })).toThrow(/customPricePerPalm/);
    });

    test('insecticide highDose custom below tier uses selected tier floor', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'insecticide',
        palmCount: 2,
        palmSize: 'large',
        highDose: true,
        customPricePerPalm: 60,
      });

      expect(result.pricePerPalm).toBe(75);
      expect(result.quoteBased).toBe(true);
      expect(result.quoteFloorApplied).toBe(true);
      expect(result.customPriceProvided).toBe(true);
    });

    test('insecticide highDose custom quote above tier uses custom price', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'insecticide',
        palmCount: 2,
        palmSize: 'large',
        highDose: true,
        customPricePerPalm: 90,
      });

      expect(result.quoteBased).toBe(true);
      expect(result.pricePerPalm).toBe(90);
      expect(result.rawPerVisit).toBe(180);
      expect(result.perVisit).toBe(180);
      expect(result.annual).toBe(360);
      expect(result.quoteFloorApplied).toBe(false);
      expect(result.customPriceProvided).toBe(true);
    });
  });

  describe('combo tiers', () => {
    test('combo small is 65', () => {
      expect(pricePalmInjection(property, { treatmentType: 'combo', palmCount: 2, palmSize: 'small' }).pricePerPalm).toBe(65);
    });

    test('combo medium is 75', () => {
      expect(pricePalmInjection(property, { treatmentType: 'combo', palmCount: 2, palmSize: 'medium' }).pricePerPalm).toBe(75);
    });

    test('combo large is 95', () => {
      expect(pricePalmInjection(property, { treatmentType: 'combo', palmCount: 2, palmSize: 'large' }).pricePerPalm).toBe(95);
    });

    test('combo missing palmSize throws', () => {
      expect(() => pricePalmInjection(property, { treatmentType: 'combo', palmCount: 2 })).toThrow(/palmSize/);
    });

    test('combo highDose without quote throws', () => {
      expect(() => pricePalmInjection(property, {
        treatmentType: 'combo',
        palmCount: 2,
        palmSize: 'large',
        highDose: true,
      })).toThrow(/customPricePerPalm/);
    });
  });

  describe('fungal quote pricing', () => {
    test('fungal without diagnosisConfirmed throws', () => {
      expect(() => pricePalmInjection(property, {
        treatmentType: 'fungal',
        palmCount: 1,
        selectedProduct: 'PHOSPHO-Jet',
        appsPerYear: 2,
      })).toThrow(/diagnosisConfirmed/);
    });

    test('fungal without selectedProduct throws', () => {
      expect(() => pricePalmInjection(property, {
        treatmentType: 'fungal',
        palmCount: 1,
        diagnosisConfirmed: true,
        appsPerYear: 2,
      })).toThrow(/selectedProduct/);
    });

    test('fungal without appsPerYear or intervalMonths throws', () => {
      expect(() => pricePalmInjection(property, {
        treatmentType: 'fungal',
        palmCount: 1,
        diagnosisConfirmed: true,
        selectedProduct: 'PHOSPHO-Jet',
      })).toThrow(/appsPerYear or intervalMonths/);
    });

    test('fungal with customPricePerPalm below 50 floors to 50', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'fungal',
        palmCount: 1,
        diagnosisConfirmed: true,
        selectedProduct: 'Propizol',
        appsPerYear: 1,
        customPricePerPalm: 40,
      });

      expect(result.pricePerPalm).toBe(50);
      expect(result.quoteFloorApplied).toBe(true);
    });

    test('fungal with valid quote and appsPerYear prices correctly', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'fungal',
        palmCount: 2,
        diagnosisConfirmed: true,
        selectedProduct: 'PHOSPHO-Jet',
        appsPerYear: 2,
        customPricePerPalm: 60,
      });

      expect(result.pricePerPalm).toBe(60);
      expect(result.rawPerVisit).toBe(120);
      expect(result.perVisit).toBe(120);
      expect(result.annual).toBe(240);
    });

    test('fungal with PHOSPHO-Jet every 4 months uses floor and display frequency', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'fungal',
        palmCount: 4,
        diagnosisConfirmed: true,
        selectedProduct: 'PHOSPHO-Jet',
        intervalMonths: 4,
      });

      expect(result.pricePerPalm).toBe(50);
      expect(result.appsPerYear).toBe(3);
      expect(result.rawPerVisit).toBe(200);
      expect(result.perVisit).toBe(200);
      expect(result.annual).toBe(600);
      expect(result.monthly).toBe(50);
      expect(result.displayFrequency).toBe('every 4 months');
    });
  });

  describe('lethal bronzing program', () => {
    test('healthy preventive lethal bronzing uses floor, quarterly interval, and four apps per year', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'lethalBronzing',
        palmCount: 2,
        palmStatus: 'healthy_preventive',
      });

      expect(result.pricePerPalm).toBe(125);
      expect(result.intervalMonths).toBe(3);
      expect(result.appsPerYear).toBe(4);
      expect(result.minimumProgramMonths).toBe(24);
      expect(result.rawPerVisit).toBe(250);
      expect(result.perVisit).toBe(250);
      expect(result.annual).toBe(1000);
      expect(result.monthly).toBe(83.33);
      expect(result.annualBeforeCredits).toBe(1000);
    });

    test('lethal bronzing customPricePerPalm 100 floors to 125', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'lethalBronzing',
        palmCount: 1,
        palmStatus: 'healthy_preventive',
        customPricePerPalm: 100,
      });
      expect(result.pricePerPalm).toBe(125);
    });

    test('lethal bronzing customPricePerPalm 140 uses 140', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'lethalBronzing',
        palmCount: 1,
        palmStatus: 'healthy_preventive',
        customPricePerPalm: 140,
      });
      expect(result.pricePerPalm).toBe(140);
    });

    test.each(['symptomatic', 'tested_positive', 'infected'])('lethal bronzing %s throws', (palmStatus) => {
      expect(() => pricePalmInjection(property, {
        treatmentType: 'lethalBronzing',
        palmCount: 1,
        palmStatus,
      })).toThrow(/not eligible/);
    });
  });

  describe('Tree-Age annualized pricing', () => {
    test('Tree-Age dbhInches 10 uses 24-month annualized price and one-palm visit minimum', () => {
      const result = pricePalmInjection(property, { treatmentType: 'treeAge', palmCount: 1, dbhInches: 10 });

      expect(result.pricePerPalm).toBe(65);
      expect(result.intervalMonths).toBe(24);
      expect(result.appsPerYear).toBe(0.5);
      expect(result.perVisit).toBe(75);
      expect(result.annual).toBe(37.5);
      expect(result.annualized).toBe(true);
    });

    test('Tree-Age dbhInches 15 uses 85 tier', () => {
      expect(pricePalmInjection(property, { treatmentType: 'treeAge', palmCount: 1, dbhInches: 15 }).pricePerPalm).toBe(85);
    });

    test('Tree-Age dbhInches 12 annualizes the 24-month event price', () => {
      const result = pricePalmInjection(property, { treatmentType: 'treeAge', palmCount: 1, dbhInches: 12 });

      expect(result.pricePerPalm).toBe(85);
      expect(result.appsPerYear).toBe(0.5);
      expect(result.intervalMonths).toBe(24);
      expect(result.perVisit).toBe(85);
      expect(result.annual).toBe(42.5);
      expect(result.monthly).toBe(3.54);
      expect(result.annualized).toBe(true);
    });

    test('Tree-Age dbhInches 20 uses 110 tier', () => {
      expect(pricePalmInjection(property, { treatmentType: 'treeAge', palmCount: 1, dbhInches: 20 }).pricePerPalm).toBe(110);
    });

    test('Tree-Age dbhInches above 20 without customPricePerPalm throws', () => {
      expect(() => pricePalmInjection(property, { treatmentType: 'treeAge', palmCount: 1, dbhInches: 21 })).toThrow(/customPricePerPalm/);
    });

    test('Tree-Age dbhInches above 20 with customPricePerPalm below 110 floors to 110', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'treeAge',
        palmCount: 1,
        dbhInches: 21,
        customPricePerPalm: 100,
      });

      expect(result.pricePerPalm).toBe(110);
      expect(result.quoteFloorApplied).toBe(true);
    });

    test('Tree-Age dbhInches above 20 with customPricePerPalm prices as quote-based', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'treeAge',
        palmCount: 1,
        dbhInches: 24,
        customPricePerPalm: 175,
      });

      expect(result.pricePerPalm).toBe(175);
      expect(result.quoteBased).toBe(true);
      expect(result.perVisit).toBe(175);
      expect(result.annual).toBe(87.5);
    });
  });

  describe('palm count resolver and estimate routing', () => {
    test('service palmCount wins over property count and records source metadata', () => {
      const estimate = generateEstimate({
        homeSqFt: 2200,
        lotSqFt: 9000,
        palmCount: 8,
        services: {
          palmInjection: {
            treatmentType: 'nutrition',
            palmCount: 5,
          },
        },
      });
      const palm = estimate.lineItems.find(line => line.service === 'palm_injection');

      expect(palm.palmCount).toBe(5);
      expect(palm.measurements.palmCount).toEqual({ value: 5, source: 'service_manual_override' });
      expect(palm.palmCountSource).toBe('service_manual_override');
      expect(palm.palmCountWasManualOverride).toBe(true);
      expect(palm.servicePalmCountDiffersFromPropertyPalmCount).toBe(true);
      expect(palm.measurementWarnings).toContain('service_palm_count_differs_from_property_palm_count');
    });

    test('measurements.palmCount and property inventory are supported fallbacks', () => {
      expect(resolvePalmCount({}, { measurements: { palmCount: '6' } })).toEqual(expect.objectContaining({
        palmCount: 6,
        source: 'service_manual_override',
        wasManualOverride: true,
      }));
      expect(resolvePalmCount({ palmInventory: { palmCount: '4' } }, {})).toEqual(expect.objectContaining({
        palmCount: 4,
        source: 'property_palm_inventory',
        wasDefaulted: true,
      }));
    });

    test('missing and invalid palmCount fail before pricing can return NaN', () => {
      expect(() => generateEstimate({
        homeSqFt: 2200,
        lotSqFt: 9000,
        services: { palm: { treatmentType: 'nutrition' } },
      })).toThrow(/Palm count is required/);

      expect(() => generateEstimate({
        homeSqFt: 2200,
        lotSqFt: 9000,
        palmCount: 8,
        services: { palm: { treatmentType: 'nutrition', palmCount: 0 } },
      })).toThrow(/Palm count is required/);
    });
  });

  describe('WaveGuard palm handling', () => {
    test('palm service does not qualify for tier', () => {
      const tier = determineWaveGuardTier(['palm_injection']);
      expect(tier.tier).toBe('bronze');
      expect(tier.qualifyingCount).toBe(0);
    });

    test('palm service is excluded from percentage discount base', () => {
      const gold = determineWaveGuardTier(['pest_control', 'lawn_care', 'mosquito']);
      const discount = getEffectiveDiscount('palm_injection', gold, { palmCount: 1, annualBeforeCredits: 75 });

      expect(discount.effectiveDiscount).toBe(0);
      expect(discount.appliedDiscounts).toContainEqual(expect.objectContaining({ type: 'exclusion' }));
      expect(discount.appliedDiscounts).not.toContainEqual(expect.objectContaining({ type: 'waveguard' }));
    });

    test('Bronze and Silver get no flat palm credit', () => {
      const bronze = determineWaveGuardTier(['pest_control']);
      const silver = determineWaveGuardTier(['pest_control', 'lawn_care']);

      expect(getEffectiveDiscount('palm_injection', bronze, { palmCount: 2 }).flatCreditAnnual).toBeUndefined();
      expect(getEffectiveDiscount('palm_injection', silver, { palmCount: 2 }).flatCreditAnnual).toBeUndefined();
    });

    test('Gold gets $10 per palm per year credit', () => {
      const gold = determineWaveGuardTier(['pest_control', 'lawn_care', 'mosquito']);
      const discount = getEffectiveDiscount('palm_injection', gold, { palmCount: 3, annualBeforeCredits: 1000 });

      expect(discount.flatCreditPerPalm).toBe(10);
      expect(discount.flatCreditAnnual).toBe(30);
    });

    test('Gold flat credit does not default missing palm count to one', () => {
      const gold = determineWaveGuardTier(['pest_control', 'lawn_care', 'mosquito']);
      const discount = getEffectiveDiscount('palm_injection', gold, { annualBeforeCredits: 1000 });

      expect(discount.flatCreditAnnual).toBeUndefined();
      expect(discount.requiresMeasurement).toBe(true);
      expect(discount.warnings).toContain('missing_palm_count');
    });

    test('Platinum gets $10 per palm per year credit', () => {
      const platinum = determineWaveGuardTier(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub']);
      const discount = getEffectiveDiscount('palm_injection', platinum, { palmCount: 4, annualBeforeCredits: 1000 });

      expect(discount.flatCreditPerPalm).toBe(10);
      expect(discount.flatCreditAnnual).toBe(40);
    });

    test('credit is capped so net annual cannot go below zero', () => {
      const gold = determineWaveGuardTier(['pest_control', 'lawn_care', 'mosquito']);
      const discount = getEffectiveDiscount('palm_injection', gold, { palmCount: 10, annualBeforeCredits: 50 });

      expect(discount.flatCreditAnnual).toBe(50);
      expect(discount.annualAfterCredits).toBe(0);
      expect(applyDiscount(50, discount)).toBe(0);
    });

    test('credit is applied after the fixed per-visit minimum is incorporated into annual', () => {
      const palm = pricePalmInjection(property, { treatmentType: 'nutrition', palmCount: 1 });
      const gold = determineWaveGuardTier(['pest_control', 'lawn_care', 'mosquito']);
      const discount = getEffectiveDiscount('palm_injection', gold, {
        palmCount: palm.palmCount,
        annualBeforeCredits: palm.annualBeforeCredits,
      });

      expect(palm.rawAnnual).toBe(35);
      expect(palm.annualBeforeCredits).toBe(75);
      expect(applyDiscount(palm.annualBeforeCredits, discount)).toBe(65);
    });
  });

  describe('regressions', () => {
    test('one $35 nutrition palm at two apps no longer returns annual 70', () => {
      const result = pricePalmInjection(property, {
        treatmentType: 'nutrition',
        palmCount: 1,
        appsPerYear: 2,
      });

      expect(result.rawAnnual).toBe(70);
      expect(result.annual).toBe(150);
    });

    test('eight combo palms require palmSize and valid tiered examples price correctly', () => {
      expect(() => pricePalmInjection(property, { treatmentType: 'combo', palmCount: 8 })).toThrow(/palmSize/);

      expect(pricePalmInjection(property, { treatmentType: 'combo', palmCount: 8, palmSize: 'small' }).pricePerPalm).toBe(65);
      const medium = pricePalmInjection(property, { treatmentType: 'combo', palmCount: 8, palmSize: 'medium' });
      expect(medium.pricePerPalm).toBe(75);
      expect(medium.annual).toBe(1200);
      expect(pricePalmInjection(property, { treatmentType: 'combo', palmCount: 8, palmSize: 'large' }).pricePerPalm).toBe(95);
    });
  });
});
