const constants = require('../services/pricing-engine/constants');
const { syncConstantsFromDB, validatePestPricingConfig } = require('../services/pricing-engine/db-bridge');
const { priceFlea } = require('../services/pricing-engine');

function pricingConfigDb(rows) {
  const db = (table) => {
    const query = {
      select: jest.fn(async () => (table === 'pricing_config' ? rows : [])),
      orderBy: jest.fn(() => query),
      then: (resolve) => resolve([]),
    };
    return query;
  };
  db.schema = {
    hasTable: jest.fn(async () => true),
  };
  return db;
}

describe('pricing engine DB bridge', () => {
  const originalInitialRoach = constants.PEST.pestInitialRoach;
  const originalOneTime = JSON.parse(JSON.stringify(constants.ONE_TIME));
  const originalRecurringCustomerPerk = constants.WAVEGUARD.recurringCustomerOneTimePerk;
  const originalMosquitoBasePrices = JSON.parse(JSON.stringify(constants.MOSQUITO.basePrices));
  const originalMosquitoTierVisits = { ...constants.MOSQUITO.tierVisits };
  const originalPalmTreatments = JSON.parse(JSON.stringify(constants.PALM.treatments));
  const originalBedBug = JSON.parse(JSON.stringify(constants.BED_BUG));
  const originalFlea = JSON.parse(JSON.stringify(constants.SPECIALTY.flea));
  const originalTermite = JSON.parse(JSON.stringify(constants.TERMITE));
  const originalTrenching = JSON.parse(JSON.stringify(constants.SPECIALTY.trenching));
  const originalBoraCare = JSON.parse(JSON.stringify(constants.SPECIALTY.boraCare));
  const originalPreSlabTermidor = JSON.parse(JSON.stringify(constants.SPECIALTY.preSlabTermidor));
  const originalPreSlabTermiticide = JSON.parse(JSON.stringify(constants.SPECIALTY.preSlabTermiticide));
  const originalUrgency = JSON.parse(JSON.stringify(constants.URGENCY));
  const originalPalm = {
    minPerVisit: constants.PALM.minPerVisit,
    flatCreditPerPalm: constants.PALM.flatCreditPerPalm,
    flatCreditMinTier: constants.PALM.flatCreditMinTier,
    tierQualifier: constants.PALM.tierQualifier,
    excludeFromPctDiscount: constants.PALM.excludeFromPctDiscount,
  };

  afterEach(() => {
    constants.PEST.pestInitialRoach = originalInitialRoach;
    constants.ONE_TIME.pest = { ...originalOneTime.pest };
    constants.ONE_TIME.lawn = {
      ...originalOneTime.lawn,
      treatmentMultipliers: { ...originalOneTime.lawn.treatmentMultipliers },
    };
    constants.ONE_TIME.mosquito = { ...originalOneTime.mosquito };
    constants.WAVEGUARD.recurringCustomerOneTimePerk = originalRecurringCustomerPerk;
    constants.MOSQUITO.basePrices = JSON.parse(JSON.stringify(originalMosquitoBasePrices));
    constants.MOSQUITO.tierVisits = { ...originalMosquitoTierVisits };
    constants.PALM.treatments = JSON.parse(JSON.stringify(originalPalmTreatments));
    constants.PALM.treatmentTypes = constants.PALM.treatments;
    for (const key of Object.keys(constants.BED_BUG)) delete constants.BED_BUG[key];
    Object.assign(constants.BED_BUG, JSON.parse(JSON.stringify(originalBedBug)));
    for (const key of Object.keys(constants.SPECIALTY.flea)) delete constants.SPECIALTY.flea[key];
    Object.assign(constants.SPECIALTY.flea, JSON.parse(JSON.stringify(originalFlea)));
    for (const key of Object.keys(constants.TERMITE)) delete constants.TERMITE[key];
    Object.assign(constants.TERMITE, JSON.parse(JSON.stringify(originalTermite)));
    for (const key of Object.keys(constants.SPECIALTY.trenching)) delete constants.SPECIALTY.trenching[key];
    Object.assign(constants.SPECIALTY.trenching, JSON.parse(JSON.stringify(originalTrenching)));
    for (const key of Object.keys(constants.SPECIALTY.boraCare)) delete constants.SPECIALTY.boraCare[key];
    Object.assign(constants.SPECIALTY.boraCare, JSON.parse(JSON.stringify(originalBoraCare)));
    for (const key of Object.keys(constants.SPECIALTY.preSlabTermidor)) delete constants.SPECIALTY.preSlabTermidor[key];
    Object.assign(constants.SPECIALTY.preSlabTermidor, JSON.parse(JSON.stringify(originalPreSlabTermidor)));
    for (const key of Object.keys(constants.SPECIALTY.preSlabTermiticide)) delete constants.SPECIALTY.preSlabTermiticide[key];
    Object.assign(constants.SPECIALTY.preSlabTermiticide, JSON.parse(JSON.stringify(originalPreSlabTermiticide)));
    for (const key of Object.keys(constants.URGENCY)) delete constants.URGENCY[key];
    Object.assign(constants.URGENCY, JSON.parse(JSON.stringify(originalUrgency)));
    Object.assign(constants.PALM, originalPalm);
  });

  test('preserves cents on DB-synced initial roach pricing brackets', async () => {
    const db = pricingConfigDb([{
      config_key: 'pest_base',
      data: {
        base: 117,
        floor: 89,
        initial_roach: {
          regular_standalone: [
            { sqft: 1500, price: 202.50 },
            { sqft: 2501, price: 239 },
            { sqft: null, price: 289 },
          ],
        },
      },
    }]);

    await expect(syncConstantsFromDB(db)).resolves.toBe(true);

    expect(constants.PEST.pestInitialRoach.regular_standalone).toEqual([
      { sqft: 1500, price: 202.50 },
      { sqft: 2501, price: 239 },
      { sqft: Infinity, price: 289 },
    ]);
  });

  test('syncs canonical one-time treatment pricing and mosquito programs from pricing_config', async () => {
    const db = pricingConfigDb([
      { config_key: 'onetime_pest', data: { floor: 199, multiplier: 2.2 } },
      {
        config_key: 'onetime_lawn',
        data: {
          floor: 115,
          fungicide_floor: 115,
          recurringPerAppMultiplier: 1.50,
          treatment_multipliers: { fert: 1.00, weed: 1.12, pest: 1.30, fungicide: 1.38 },
        },
      },
      { config_key: 'onetime_recurring_discount', data: { discount: 0.15 } },
      {
        config_key: 'onetime_mosquito',
        data: {
          SMALL: 225,
          STANDARD: 275,
          LARGE: 325,
          XL: 385,
          ESTATE: 425,
          ACRE_CLASS: 475,
          OVER_ACRE: 475,
          overAcreIncrementSqFt: 10000,
          overAcreIncrementPrice: 75,
          stationAddOn: 75,
          dunkAddOn: 15,
        },
      },
      {
        config_key: 'mosquito_base_prices',
        data: { SMALL: { seasonal9: 105, monthly12: 90 } },
      },
      { config_key: 'mosquito_visits', data: { seasonal9: 9, monthly12: 12 } },
    ]);

    await expect(syncConstantsFromDB(db)).resolves.toBe(true);

    expect(constants.ONE_TIME.pest).toEqual({ floor: 199, multiplier: 2.2 });
    expect(constants.ONE_TIME.lawn.floor).toBe(115);
    expect(constants.ONE_TIME.lawn.oneTimeMultiplier).toBe(1.5);
    expect(constants.ONE_TIME.lawn.treatmentMultipliers.fungicide).toBe(1.38);
    expect(constants.WAVEGUARD.recurringCustomerOneTimePerk).toBe(0.15);
    expect(constants.ONE_TIME.mosquito).toEqual(expect.objectContaining({
      SMALL: 225,
      STANDARD: 275,
      LARGE: 325,
      XL: 385,
      ESTATE: 425,
      ACRE_CLASS: 475,
      OVER_ACRE: 475,
      stationAddOn: 75,
      dunkAddOn: 15,
    }));
    expect(constants.MOSQUITO.basePrices.SMALL).toEqual([105, 90]);
    expect(constants.MOSQUITO.tierVisits).toEqual({ seasonal9: 9, monthly12: 12 });
  });

  test('validates active mosquito recurring and one-time config defaults', () => {
    expect(validatePestPricingConfig(constants)).toEqual(expect.objectContaining({ valid: true }));
    expect(constants.MOSQUITO.basePrices).toEqual(expect.objectContaining({
      SMALL: [66, 60],
      QUARTER: [69, 63],
      THIRD: [72, 66],
      HALF: [78, 70],
      ACRE: [88, 78],
    }));
    expect(constants.MOSQUITO.tierVisits).toEqual({ seasonal9: 9, monthly12: 12 });
    expect(constants.ONE_TIME.mosquito).toEqual(expect.objectContaining({
      SMALL: 99,
      STANDARD: 129,
      LARGE: 159,
      XL: 199,
      ESTATE: 239,
      ACRE_CLASS: 269,
      OVER_ACRE: 269,
      overAcreIncrementSqFt: 10000,
      overAcreIncrementPrice: 40,
      stationAddOn: 75,
      dunkAddOn: 15,
    }));
  });

  test('rejects drifted mosquito config values during validation', () => {
    const snapshot = JSON.parse(JSON.stringify(constants));
    snapshot.MOSQUITO.basePrices.SMALL = [0, 90];
    snapshot.MOSQUITO.tierVisits.monthly12 = 0;
    snapshot.MOSQUITO.pressureFactors.nearWater = 'bad';
    snapshot.MOSQUITO.pressureCap = 0;
    snapshot.ONE_TIME.mosquito.OVER_ACRE = 0;
    snapshot.ONE_TIME.mosquito.overAcreIncrementSqFt = 0;
    snapshot.ONE_TIME.mosquito.overAcreIncrementPrice = 0;

    const result = validatePestPricingConfig(snapshot);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'MOSQUITO.basePrices.SMALL.seasonal9 must be positive',
      'MOSQUITO.tierVisits.monthly12 must be positive',
      'MOSQUITO.pressureFactors.nearWater must be finite',
      'MOSQUITO.pressureCap must be positive',
      'ONE_TIME.mosquito.OVER_ACRE must be positive',
      'ONE_TIME.mosquito.overAcreIncrementSqFt must be positive',
      'ONE_TIME.mosquito.overAcreIncrementPrice must be positive',
    ]));
  });

  test('rejects out-of-range pest frequency discounts and invalid one-time keys', () => {
    const snapshot = JSON.parse(JSON.stringify(constants));
    snapshot.PEST.frequencyDiscounts.v1.bimonthly = 1.5; // >1, invalid
    snapshot.PEST.frequencyDiscounts.v2.monthly = 0;     // 0, invalid
    snapshot.PEST.frequencyDiscounts.v2.quarterly = -0.2; // negative, invalid
    snapshot.ONE_TIME.pest.multiplier = 0;               // must be positive

    const result = validatePestPricingConfig(snapshot);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'PEST.frequencyDiscounts.v1.bimonthly must be in (0, 1]',
      'PEST.frequencyDiscounts.v2.monthly must be in (0, 1]',
      'PEST.frequencyDiscounts.v2.quarterly must be in (0, 1]',
      'ONE_TIME.pest.multiplier must be positive',
    ]));
  });

  const INCENTIVE_ERROR = 'ONE_TIME.pest floor/multiplier too low: one-time (after dollar rounding) must stay strictly above recurring visit-1 (PEST.floor + PEST.initialFee) for every property';

  test('rejects a one-time pest multiplier too low to clear recurring visit-1 (default floor)', () => {
    for (const badMultiplier of [1.99, 1.2, 1, 0.8]) {
      const snapshot = JSON.parse(JSON.stringify(constants));
      snapshot.ONE_TIME.pest.multiplier = badMultiplier; // floor stays $199
      const result = validatePestPricingConfig(snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(INCENTIVE_ERROR);
    }
  });

  test('validates floor and multiplier TOGETHER — a lowered floor can break the incentive', () => {
    // Codex case: {floor:150, multiplier:2} prices the smallest job at
    // max(150, 89*2)=178 < recurring visit-1 ($89 + $99 = $188) → must reject.
    const bad = JSON.parse(JSON.stringify(constants));
    bad.ONE_TIME.pest = { floor: 150, multiplier: 2 };
    const badResult = validatePestPricingConfig(bad);
    expect(badResult.valid).toBe(false);
    expect(badResult.errors).toContain(INCENTIVE_ERROR);

    // But a high floor legitimately supports a sub-2 multiple — must accept,
    // proving the guard isn't just a blanket multiplier >= 2 rule.
    const ok = JSON.parse(JSON.stringify(constants));
    ok.ONE_TIME.pest = { floor: 300, multiplier: 1.8 };
    expect(validatePestPricingConfig(ok)).toEqual(expect.objectContaining({ valid: true }));
  });

  test('rejects a config that only ties after dollar rounding (Codex rounding edge)', () => {
    // {floor:199, multiplier:1.9901}: a $100 quarterly base rounds to
    // round(100*1.9901)=$199, exactly recurring visit-1 ($100+$99) — not
    // strictly above. The unrounded math passes; the rounding-aware scan rejects.
    const snapshot = JSON.parse(JSON.stringify(constants));
    snapshot.ONE_TIME.pest = { floor: 199, multiplier: 1.9901 };
    const result = validatePestPricingConfig(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(INCENTIVE_ERROR);
  });

  test('allows pest floor above base (raise-the-minimum config is valid)', () => {
    const snapshot = JSON.parse(JSON.stringify(constants));
    snapshot.PEST.base = 117;
    snapshot.PEST.floor = 130; // floor > base: large/adjusted homes still exceed it
    expect(validatePestPricingConfig(snapshot)).toEqual(expect.objectContaining({ valid: true }));
  });

  test('restores all constants when pest config validation fails', async () => {
    const originalLaborRate = constants.GLOBAL.LABOR_RATE;
    const originalMosquitoSmall = [...constants.MOSQUITO.basePrices.SMALL];
    const originalPestBase = constants.PEST.base;
    const db = pricingConfigDb([
      { config_key: 'global_labor_rate', data: { value: originalLaborRate + 25 } },
      {
        config_key: 'mosquito_base_prices',
        data: { SMALL: { seasonal9: 999, monthly12: 888 } },
      },
      { config_key: 'pest_base', data: { base: -1, floor: constants.PEST.floor } },
    ]);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(syncConstantsFromDB(db)).resolves.toBe(false);

      expect(constants.GLOBAL.LABOR_RATE).toBe(originalLaborRate);
      expect(constants.MOSQUITO.basePrices.SMALL).toEqual(originalMosquitoSmall);
      expect(constants.PEST.base).toBe(originalPestBase);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('syncs Pre-Slab Termiticide product cost table from pricing_config', async () => {
    const db = pricingConfigDb([{
      config_key: 'onetime_preslab',
      data: {
        default_product_key: 'taurus_sc',
        ps_equip: 18,
        warranty_extended: 225,
        volume_discounts: { none: 1, '5plus': 0.88, '10plus': 0.82 },
        products: {
          termidor_sc: { container_cost: 180, container_oz: 78, product_oz_per_10_sqft: 0.8 },
          taurus_sc: { container_cost: 99, container_oz: 78, product_oz_per_10_sqft: 0.8 },
          bifen_it: { container_cost: 45, container_oz: 128, product_oz_per_10_sqft: 1.0 },
          talstar_p: { container_cost: 40, container_oz: 128, product_oz_per_10_sqft: 1.0 },
        },
      },
    }]);

    await expect(syncConstantsFromDB(db)).resolves.toBe(true);

    expect(constants.SPECIALTY.preSlabTermiticide.defaultProductKey).toBe('taurus_sc');
    expect(constants.SPECIALTY.preSlabTermiticide.equipCost).toBe(18);
    expect(constants.SPECIALTY.preSlabTermiticide.warrantyExtended).toBe(225);
    expect(constants.SPECIALTY.preSlabTermiticide.volumeDiscounts['10plus']).toBe(0.82);
    expect(constants.SPECIALTY.preSlabTermiticide.products.termidor_sc.containerCost).toBe(180);
    expect(constants.SPECIALTY.preSlabTermiticide.products.taurus_sc.containerCost).toBe(99);
    expect(constants.SPECIALTY.preSlabTermiticide.products.bifen_it.containerCost).toBe(45);
    expect(constants.SPECIALTY.preSlabTermiticide.products.talstar_p.containerCost).toBe(40);
  });

  test('syncs trenching product/rate metadata from pricing_config', async () => {
    const db = pricingConfigDb([{
      config_key: 'onetime_trenching',
      data: {
        per_lf_dirt: 11,
        per_lf_concrete: 15,
        default_product_key: 'termidor_sc',
        default_included_product_key: 'taurus_sc',
        default_application_rate: 'standard',
        default_trench_depth_ft: 1.5,
        finished_gallons_per_10_lf_per_ft_depth: 4.5,
        default_concrete_volume_pad_pct: 0.25,
        product_premium_multiplier: 1.5,
        products: {
          termidor_sc: { container_cost: 390, container_oz: 78, product_oz_per_finished_gallon_at_standard_rate: 0.9, product_oz_per_finished_gallon_at_high_rate: 1.8 },
          taurus_sc: { container_cost: 90, container_oz: 78, product_oz_per_finished_gallon_at_standard_rate: 0.9, product_oz_per_finished_gallon_at_high_rate: 1.8 },
        },
      },
    }]);

    await expect(syncConstantsFromDB(db)).resolves.toBe(true);

    expect(constants.SPECIALTY.trenching.dirtPerLF).toBe(11);
    expect(constants.SPECIALTY.trenching.concretePerLF).toBe(15);
    expect(constants.SPECIALTY.trenching.defaultProductKey).toBe('termidor_sc');
    expect(constants.SPECIALTY.trenching.defaultTrenchDepthFt).toBe(1.5);
    expect(constants.SPECIALTY.trenching.finishedGallonsPer10LFPerFtDepth).toBe(4.5);
    expect(constants.SPECIALTY.trenching.defaultConcreteVolumePadPct).toBe(0.25);
    expect(constants.SPECIALTY.trenching.productPremiumMultiplier).toBe(1.5);
    expect(constants.SPECIALTY.trenching.products.termidor_sc.containerCost).toBe(390);
    expect(constants.SPECIALTY.trenching.products.taurus_sc.productOzPerFinishedGallonAtHighRate).toBe(1.8);
  });

  test('syncs flea package, exterior tiers, and one-time modifiers from pricing_config', async () => {
    const db = pricingConfigDb([
      {
        config_key: 'onetime_flea',
        data: {
          initial: { base: 240, floor: 200 },
          followUp: { base: 130, floor: 100 },
          exterior: {
            enabled: true,
            maxSqFt: 12000,
            tiers: [
              { min: 1, max: 5000, initial: 80, followUp: 50 },
              { min: 5001, max: 12000, initial: 130, followUp: 90 },
            ],
          },
          offers: [
            {
              offerKey: 'flea_knockdown_single',
              displayName: 'Flea Knockdown Visit',
              visitCount: 1,
              warrantyType: 'none',
              baseInitial: 225,
              floorInitial: 185,
              packageFloor: 185,
              exteriorAddOnMode: 'initial_only',
            },
            {
              offerKey: 'flea_elimination_two_visit',
              displayName: 'Flea Elimination Package',
              visitCount: 2,
              warrantyType: 'conditional_retreat',
              baseInitial: 225,
              baseFollowUp: 125,
              floorInitial: 185,
              floorFollowUp: 95,
              packageFloor: 280,
              exteriorAddOnMode: 'two_visit',
            },
          ],
          complexityAdjustments: {
            moderate: { initial: 50, followUp: 20 },
            heavy: { initial: 90, followUp: 45 },
          },
        },
      },
      { config_key: 'onetime_urgency', data: { soon: 1.30 } },
      { config_key: 'onetime_recurring_discount', data: { discount: 0.20 } },
    ]);

    await expect(syncConstantsFromDB(db)).resolves.toBe(true);

    expect(constants.SPECIALTY.flea.initial).toEqual({ base: 240, floor: 200 });
    expect(constants.SPECIALTY.flea.followUp).toEqual({ base: 130, floor: 100 });
    expect(constants.SPECIALTY.flea.exterior.maxSqFt).toBe(12000);
    expect(constants.SPECIALTY.flea.exterior.tiers).toEqual([
      { min: 1, max: 5000, initial: 80, followUp: 50 },
      { min: 5001, max: 12000, initial: 130, followUp: 90 },
    ]);
    expect(constants.SPECIALTY.flea.offers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        offerKey: 'flea_knockdown_single',
        baseInitial: 240,
        floorInitial: 200,
        packageFloor: 200,
      }),
      expect.objectContaining({
        offerKey: 'flea_elimination_two_visit',
        baseInitial: 240,
        baseFollowUp: 130,
        floorInitial: 200,
        floorFollowUp: 100,
        packageFloor: 300,
      }),
    ]));
    expect(constants.SPECIALTY.flea.complexityAdjustments.moderate).toEqual({ initial: 50, followUp: 20 });

    const result = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
      urgency: 'SOON',
      isRecurringCustomer: true,
    });

    expect(result.raw.total).toBe(500);
    expect(result.modifiers).toEqual({
      urgencyMultiplier: 1.30,
      recurringCustomerMultiplier: 0.80,
      rushPremium: 150,
    });
    expect(result.total).toBe(550);
    expect(result.recurringCustomerDiscountRate).toBe(0.20);

    const knockdown = priceFlea({
      services: { flea: { offerKey: 'flea_knockdown_single' } },
      footprintSqFt: 2000,
      lotSqFt: 7500,
    });
    expect(knockdown.total).toBe(240);

    const moderate = priceFlea({
      services: { flea: { fleaComplexity: 'moderate' } },
      footprintSqFt: 2000,
      lotSqFt: 7500,
    });
    expect(moderate.raw.total).toBe(440);
  });

  test('ignores legacy scalar palm pricing keys and syncs explicit protocol keys', async () => {
    const db = pricingConfigDb([{
      config_key: 'palm_pricing',
      data: {
        preventive_insecticide: 41,
        combo: 42,
        fungal: 43,
        nutrition_default_apps_per_year: 2,
        nutrition_allowed_apps_per_year: [1, 2],
        combo_medium: 76,
        fungal_floor: 52,
        min_per_visit: 90,
        flat_credit_per_palm: 12,
        flat_credit_min_tier: 'silver',
        tier_qualifier: false,
        exclude_from_pct_discount: true,
      },
    }]);

    await expect(syncConstantsFromDB(db)).resolves.toBe(true);

    const insecticideMedium = constants.PALM.treatments.insecticide.tiers.find(t => t.size === 'medium');
    const comboMedium = constants.PALM.treatments.combo.tiers.find(t => t.size === 'medium');

    expect(insecticideMedium.pricePerPalm).toBe(55);
    expect(comboMedium.pricePerPalm).toBe(76);
    expect(constants.PALM.treatments.fungal.floorPerPalm).toBe(52);
    expect(constants.PALM.treatments.nutrition.defaultAppsPerYear).toBe(2);
    expect(constants.PALM.treatments.nutrition.allowedAppsPerYear).toEqual([1, 2]);
    expect(constants.PALM.minPerVisit).toBe(90);
    expect(constants.PALM.flatCreditPerPalm).toBe(12);
    expect(constants.PALM.flatCreditMinTier).toBe('silver');
  });

  test('validates PALM treatment protocol config invariants', () => {
    expect(validatePestPricingConfig(constants)).toEqual(expect.objectContaining({ valid: true }));

    constants.PALM.tierQualifier = true;
    constants.PALM.excludeFromPctDiscount = false;
    constants.PALM.treatments.nutrition.allowedAppsPerYear = [2];
    constants.PALM.treatments.insecticide.tiers = constants.PALM.treatments.insecticide.tiers
      .filter(t => t.size !== 'large');

    const result = validatePestPricingConfig(constants);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'PALM.tierQualifier must remain false',
      'PALM.excludeFromPctDiscount must remain true',
      'PALM.treatments.nutrition.allowedAppsPerYear must include 1 and 2',
      'PALM.treatments.insecticide.tiers must include large',
    ]));
  });

  test('syncs complete bed bug specialty pricing protocol from pricing_config', async () => {
    const db = pricingConfigDb([{
      config_key: 'onetime_bed_bug',
      data: {
        urgencyMultipliers: { emergencyAfterHours: 2.25 },
        chemical: {
          followUpDays: 21,
          minimumBase: 425,
          minimumAdditionalRoom: 275,
          protocol: {
            requiresFollowUpMonitoring: true,
            requiresCustomerAcknowledgement: true,
          },
        },
        heat: {
          roomRates: { oneRoom: 1100, twoRooms: 900, threePlusRooms: 800 },
          protocol: {
            targetAmbientTempF: 140,
            minSensors: 7,
            requiresPrepChecklist: true,
            requiresHeatSensitiveItemPlan: true,
          },
        },
        hybrid: {
          residualAddOn: { base: 200, perRoom: 85 },
          protocol: {
            residualApplicationType: 'targeted',
            requiresCustomerAcknowledgement: true,
          },
        },
      },
    }]);

    await expect(syncConstantsFromDB(db)).resolves.toBe(true);

    expect(constants.BED_BUG.urgencyMultipliers.emergencyAfterHours).toBe(2.25);
    expect(constants.BED_BUG.chemical.followUpDays).toBe(21);
    expect(constants.BED_BUG.chemical.minimumBase).toBe(425);
    expect(constants.BED_BUG.chemical.protocol.requiresCustomerAcknowledgement).toBe(true);
    expect(constants.BED_BUG.heat.roomRates).toEqual({ oneRoom: 1100, twoRooms: 900, threePlusRooms: 800 });
    expect(constants.BED_BUG.heat.protocol).toEqual(expect.objectContaining({
      targetAmbientTempF: 140,
      minSensors: 7,
      requiresPrepChecklist: true,
      requiresHeatSensitiveItemPlan: true,
    }));
    expect(constants.BED_BUG.hybrid.residualAddOn).toEqual({ base: 200, perRoom: 85 });
    expect(constants.BED_BUG.hybrid.protocol.residualApplicationType).toBe('targeted');
  });

  test('validates termite and termite specialty pricing config shape', () => {
    const snapshot = {
      ...constants,
      TERMITE: JSON.parse(JSON.stringify(originalTermite)),
      SPECIALTY: {
        ...constants.SPECIALTY,
        trenching: JSON.parse(JSON.stringify(originalTrenching)),
        boraCare: JSON.parse(JSON.stringify(originalBoraCare)),
        preSlabTermidor: JSON.parse(JSON.stringify(originalPreSlabTermidor)),
        preSlabTermiticide: JSON.parse(JSON.stringify(originalPreSlabTermiticide)),
      },
    };

    snapshot.TERMITE.stationSpacing = 0;
    snapshot.TERMITE.systems.advance.stationCost = -1;
    snapshot.TERMITE.monitoring.basic.monthly = 0;
    snapshot.SPECIALTY.trenching.concretePctCap = 1.2;
    snapshot.SPECIALTY.trenching.products.termidor_sc.containerCost = 0;
    snapshot.SPECIALTY.trenching.products.taurus_sc.productOzPerFinishedGallonAtHighRate = 0.4;
    snapshot.SPECIALTY.trenching.productPremiumMultiplier = 0.9;
    snapshot.SPECIALTY.boraCare.coverage = 0;
    snapshot.SPECIALTY.preSlabTermidor.marginDivisor = 1;
    delete snapshot.SPECIALTY.preSlabTermidor.volumeDiscounts['10plus'];
    snapshot.SPECIALTY.preSlabTermidor.warrantyExtended = -1;
    snapshot.SPECIALTY.preSlabTermiticide.products.taurus_sc.containerCost = 0;
    snapshot.SPECIALTY.preSlabTermiticide.products.bifen_it.productOzPer10SqFt = -1;
    snapshot.SPECIALTY.preSlabTermiticide.products.talstar_p.marginDivisor = 1;
    snapshot.SPECIALTY.preSlabTermiticide.minimums.standalone = [
      { maxSqFt: 500, floor: 225 },
      { maxSqFt: 250, floor: 150 },
      { maxSqFt: 'Infinity', floor: 600 },
    ];
    snapshot.SPECIALTY.preSlabTermiticide.minimums.builderBatch = [
      { maxSqFt: 250, floor: 150 },
    ];

    const result = validatePestPricingConfig(snapshot);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'TERMITE.stationSpacing must be positive',
      'TERMITE.systems.advance.stationCost must be non-negative',
      'TERMITE.monitoring.basic.monthly must be positive',
      'SPECIALTY.trenching.concretePctCap must be between 0 and 1',
      'SPECIALTY.trenching.productPremiumMultiplier must be at least 1',
      'SPECIALTY.trenching.products.termidor_sc.containerCost must be positive',
      'SPECIALTY.trenching.products.taurus_sc.productOzPerFinishedGallonAtHighRate must be at least standard rate',
      'SPECIALTY.boraCare.coverage must be positive',
      'SPECIALTY.preSlabTermidor.marginDivisor must be positive and less than 1',
      'SPECIALTY.preSlabTermidor.volumeDiscounts.10plus is required',
      'SPECIALTY.preSlabTermidor.warrantyExtended must be non-negative',
      'SPECIALTY.preSlabTermiticide.products.taurus_sc.containerCost must be positive',
      'SPECIALTY.preSlabTermiticide.products.bifen_it.productOzPer10SqFt must be positive',
      'SPECIALTY.preSlabTermiticide.products.talstar_p.marginDivisor must be positive and less than 1',
      'SPECIALTY.preSlabTermiticide.minimums.standalone must be sorted by ascending maxSqFt',
      'SPECIALTY.preSlabTermiticide.minimums.builderBatch must end with terminal Infinity maxSqFt',
    ]));
  });

  test('rejects invalid termite DB overlay and restores previous constants', async () => {
    const db = pricingConfigDb([{
      config_key: 'termite_install',
      data: { station_spacing_ft: 0, multiplier: 1.45 },
    }]);

    await expect(syncConstantsFromDB(db)).resolves.toBe(false);
    expect(constants.TERMITE.stationSpacing).toBe(originalTermite.stationSpacing);
    expect(constants.TERMITE.installMultiplier).toBe(originalTermite.installMultiplier);
  });
});
