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

  afterEach(() => {
    constants.PEST.pestInitialRoach = originalInitialRoach;
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
});
