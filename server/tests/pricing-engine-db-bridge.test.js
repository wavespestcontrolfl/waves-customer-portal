const constants = require('../services/pricing-engine/constants');
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
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
      { config_key: 'onetime_pest', data: { floor: 199, multiplier: 1.75 } },
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

    expect(constants.ONE_TIME.pest).toEqual({ floor: 199, multiplier: 1.75 });
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
    });
    expect(result.total).toBe(520);
    expect(result.recurringCustomerDiscountRate).toBe(0.20);
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
});
