const constants = require('../services/pricing-engine/constants');
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');

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
});
