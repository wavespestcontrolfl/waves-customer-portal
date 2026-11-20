// standardPestPriceRowsAreComplete: did the rows of the standard pest price (the footprint ladder and the tier
// table) carry every input the sync loads from them?
//
// The REAL bridge on a fake pricing_config. A sync answers true when the table holds any row at all. For a row
// or a field that is missing it keeps what the engine had: the in-code default on a cold start, an earlier value
// on a warm process. A caller that prices with nobody watching asks this answer instead of trusting "the sync
// succeeded" (same idea as mistingRefillPriceIsFromRow).
//
// The answer must depend on the rows of the last successful sync alone, never on what an earlier sync of the
// worker loaded: every partial row below is tried on a cold worker and on a warm one, and both must refuse it.
const fs = require('fs');

// A worker that just started: pristine constants and a bridge that has not synced (its own module registry).
function freshWorker() {
  jest.resetModules();
  const constants = require('../services/pricing-engine/constants');
  const bridge = require('../services/pricing-engine/db-bridge');
  return { constants, bridge };
}

// Same fake as pricing-engine-db-bridge.test.js: pricing_config answers `rows`, every other table is empty.
function pricingConfigDb(rows) {
  const db = (table) => {
    const query = {
      select: jest.fn(async () => (table === 'pricing_config' ? rows : [])),
      orderBy: jest.fn(() => query),
      then: (resolve) => resolve([]),
    };
    return query;
  };
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
}

// The fields of the features row the sync reads. The seeded row carries all of them but attached_garage.
const FEATURE_FIELDS = [
  'pool_cage', 'pool_cage_small', 'pool_cage_medium', 'pool_cage_large', 'pool_cage_oversized', 'pool_no_cage',
  'shrubs_heavy', 'shrubs_moderate', 'shrubs_light', 'landscape_complex', 'landscape_moderate', 'landscape_simple',
  'near_water', 'indoor', 'attached_garage',
];
const REQUIRED_FEATURE_FIELDS = FEATURE_FIELDS.filter((field) => field !== 'attached_garage');
// The engine's adjustment (a key of PEST.additionalAdjustments) that each required field of the features row sets.
const FEATURE_ADJUSTMENT = {
  pool_cage: 'poolCage', pool_cage_small: 'poolCageSmall', pool_cage_medium: 'poolCageMedium', pool_cage_large: 'poolCageLarge',
  pool_cage_oversized: 'poolCageOversized', pool_no_cage: 'poolNoCage',
  shrubs_heavy: 'shrubs_heavy', shrubs_moderate: 'shrubs_moderate', shrubs_light: 'shrubs_light',
  landscape_complex: 'complexity_complex', landscape_moderate: 'complexity_moderate', landscape_simple: 'complexity_simple',
  near_water: 'nearWater', indoor: 'indoor',
};
const PROPERTY_TYPES = ['single_family', 'townhome_end', 'townhome_interior', 'duplex', 'condo_ground', 'condo_upper'];
const TIERS = ['bronze', 'silver', 'gold', 'platinum'];
const ROW_KEYS = ['pest_base', 'pest_footprint', 'pest_features', 'pest_property_type', 'waveguard_tiers'];

// The five rows as the migrated schema seeds them: every required field, no attached_garage. The values are the
// ones the engine already holds, but for the features (3 each), so a sync of them changes no other price input.
const fullRows = (constants) => ({
  pest_base: { base: constants.PEST.base, floor: constants.PEST.floor },
  pest_footprint: { breakpoints: constants.PEST.footprintBrackets.map((b) => ({ sqft: b.sqft, adj: b.adj })) },
  pest_features: Object.fromEntries(REQUIRED_FEATURE_FIELDS.map((field) => [field, 3])),
  pest_property_type: { ...constants.PROPERTY_TYPE_ADJ },
  waveguard_tiers: Object.fromEntries(Object.entries(constants.WAVEGUARD.tiers)
    .map(([tier, t]) => [tier, { discount: t.discount, min_services: t.minServices }])),
});
// A row of another service, so that a config with no pest row is still not empty.
const configDb = ({ constants }, config) => pricingConfigDb([
  { config_key: 'global_labor_rate', data: { value: constants.GLOBAL.LABOR_RATE } },
  ...Object.entries(config).map(([config_key, data]) => ({ config_key, data })),
]);
const sync = (worker, config) => worker.bridge.syncConstantsFromDB(configDb(worker, config));

// What a cold worker and a warm worker (one that loaded the full rows first) answer for the same rows.
// `change(config, constants)` edits the full rows in place.
async function answers(change) {
  const cold = freshWorker();
  const coldConfig = fullRows(cold.constants);
  change(coldConfig, cold.constants);
  const coldSynced = await sync(cold, coldConfig);
  const coldAnswer = cold.bridge.standardPestPriceRowsAreComplete();

  const warm = freshWorker();
  await sync(warm, fullRows(warm.constants));
  const warmBefore = warm.bridge.standardPestPriceRowsAreComplete();
  const warmConfig = fullRows(warm.constants);
  change(warmConfig, warm.constants);
  const warmSynced = await sync(warm, warmConfig);
  return { coldSynced, coldAnswer, warmBefore, warmSynced, warmAnswer: warm.bridge.standardPestPriceRowsAreComplete(), cold, warm };
}
const REFUSED_BY_BOTH = { coldSynced: true, coldAnswer: false, warmBefore: true, warmSynced: true, warmAnswer: false };
// Rows the bridge's own validation refuses, so the whole sync fails: every required field is there as a number,
// and the optional field is not a number.
const refusedRows = (constants) => {
  const rows = fullRows(constants);
  rows.pest_features.attached_garage = 'not a number';
  return rows;
};

let warnSpy;
let errorSpy;
let logSpy;
beforeEach(() => {
  // The fake answers the catalog reads of a sync with nothing (the bridge warns and keeps its defaults), a sync
  // the validation refuses logs an error, and a good sync logs a line.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { warnSpy.mockRestore(); errorSpy.mockRestore(); logSpy.mockRestore(); });

describe('the answer after one sync', () => {
  test('no before any sync', () => {
    expect(freshWorker().bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  test('no after a first sync that fails, though its rows carried every required field', async () => {
    const worker = freshWorker();
    await expect(sync(worker, refusedRows(worker.constants))).resolves.toBe(false);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  test('yes after a sync of the five rows as the schema seeds them', async () => {
    const worker = freshWorker();
    expect(Object.keys(fullRows(worker.constants)).sort()).toEqual([...ROW_KEYS].sort());
    await expect(sync(worker, fullRows(worker.constants))).resolves.toBe(true);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  test('pricing_config with rows, none of them a pest row: the sync succeeds, the engine prices from its in-code base price, and the answer is no', async () => {
    const worker = freshWorker();
    const base = worker.constants.PEST.base;
    await expect(sync(worker, {})).resolves.toBe(true);
    expect(worker.constants.PEST.base).toBe(base);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  // The answer counts a field only when the sync also puts its value into the engine.
  test('every required field of the rows reaches the engine', async () => {
    const worker = freshWorker();
    const { constants } = worker;
    const config = fullRows(constants);
    config.pest_base = { base: constants.PEST.base + 2, floor: constants.PEST.floor + 1 };
    const expected = { base: config.pest_base.base, floor: config.pest_base.floor };
    config.pest_footprint = { breakpoints: [{ sqft: 1000, adj: -7 }, { sqft: 2000, adj: 4 }, { sqft: 3000, adj: 11 }] };
    REQUIRED_FEATURE_FIELDS.forEach((field, index) => { config.pest_features[field] = 20 + index; });
    PROPERTY_TYPES.forEach((type, index) => { config.pest_property_type[type] = -(30 + index); });
    const discounts = [0.01, 0.02, 0.03, 0.04];
    // The service counts are the ones the engine's tier picker uses: the answer takes no other ('the tier
    // thresholds' below).
    const counts = TIERS.map((tier) => constants.WAVEGUARD.tiers[tier].minServices);
    expect(counts).toEqual([1, 2, 3, 4]);
    TIERS.forEach((tier, index) => { config.waveguard_tiers[tier] = { discount: discounts[index], min_services: counts[index] }; });

    await expect(sync(worker, config)).resolves.toBe(true);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
    expect(constants.PEST.base).toBe(expected.base);
    expect(constants.PEST.floor).toBe(expected.floor);
    expect(constants.PEST.footprintBrackets).toEqual([{ sqft: 1000, adj: -7 }, { sqft: 2000, adj: 4 }, { sqft: 3000, adj: 11 }]);
    // Each field at the adjustment the engine reads for it: two swapped fields would misprice both homes.
    expect(Object.keys(FEATURE_ADJUSTMENT)).toEqual(REQUIRED_FEATURE_FIELDS);
    expect(Object.fromEntries(REQUIRED_FEATURE_FIELDS.map((field) => [field, constants.PEST.additionalAdjustments[FEATURE_ADJUSTMENT[field]]])))
      .toEqual(Object.fromEntries(REQUIRED_FEATURE_FIELDS.map((field, index) => [field, 20 + index])));
    PROPERTY_TYPES.forEach((type, index) => expect(constants.PROPERTY_TYPE_ADJ[type]).toBe(-(30 + index)));
    TIERS.forEach((tier, index) => expect(constants.WAVEGUARD.tiers[tier]).toMatchObject({ discount: discounts[index], minServices: counts[index] }));
  });
});

// The same rows must get the same answer from a worker that just started and from one that loaded the full
// rows before. A warm worker keeps the earlier value of the missing field; a cold one holds the in-code value.
describe('rows that lack a required input are refused by a cold worker and by a warm worker', () => {
  test.each(ROW_KEYS)('the %s row is missing', async (row) => {
    expect(await answers((config) => { delete config[row]; })).toMatchObject(REFUSED_BY_BOTH);
  });

  test.each([
    ['pest_base', 'base'],
    ['pest_base', 'floor'],
    ['pest_footprint', 'breakpoints'],
    ...REQUIRED_FEATURE_FIELDS.map((field) => ['pest_features', field]),
    ...PROPERTY_TYPES.map((type) => ['pest_property_type', type]),
  ])('%s has no %s', async (row, field) => {
    expect(await answers((config) => { delete config[row][field]; })).toMatchObject(REFUSED_BY_BOTH);
  });

  test.each(TIERS.flatMap((tier) => [[tier, 'discount'], [tier, 'min_services']]))('waveguard_tiers.%s has no %s', async (tier, field) => {
    expect(await answers((config) => { delete config.waveguard_tiers[tier][field]; })).toMatchObject(REFUSED_BY_BOTH);
  });

  test.each(TIERS)('waveguard_tiers has no %s tier', async (tier) => {
    expect(await answers((config) => { delete config.waveguard_tiers[tier]; })).toMatchObject(REFUSED_BY_BOTH);
  });

  // The sync applies none of these, so the engine keeps what it had.
  test.each([
    ['a base price of 0', (config) => { config.pest_base.base = 0; }],
    ['a floor of 0', (config) => { config.pest_base.floor = 0; }],
    ['a features field saved as null', (config) => { config.pest_features.indoor = null; }],
    ['a features row with no field the sync reads', (config) => { config.pest_features = { tree_density: 5 }; }],
    ['a property type row with no type the engine knows', (config) => { config.pest_property_type = { castle: 12 }; }],
  ])('%s', async (_label, change) => {
    expect(await answers(change)).toMatchObject(REFUSED_BY_BOTH);
  });

  // The sync takes these (its own number test also takes null and text), and the engine would price with them.
  // The answer counts a field only when the row carries it as a number.
  test.each([
    ['a base price saved as text', (config) => { config.pest_base.base = String(config.pest_base.base); }],
    ['a floor saved as text', (config) => { config.pest_base.floor = String(config.pest_base.floor); }],
    ['a features field saved as text', (config) => { config.pest_features.indoor = '12'; }],
    ['near_water saved as text (the sync stores it as it is)', (config) => { config.pest_features.near_water = '3'; }],
    ['a property type saved as null (the sync reads it as 0)', (config) => { config.pest_property_type.duplex = null; }],
    ['a property type saved as text', (config) => { config.pest_property_type.duplex = '-10'; }],
    ['a breakpoint size saved as text', (config) => { config.pest_footprint.breakpoints[0].sqft = String(config.pest_footprint.breakpoints[0].sqft); }],
    ['a breakpoint adjustment saved as text', (config) => { config.pest_footprint.breakpoints[0].adj = String(config.pest_footprint.breakpoints[0].adj); }],
    ['a tier discount saved as null', (config) => { config.waveguard_tiers.silver.discount = null; }],
    ['a tier discount saved as text', (config) => { config.waveguard_tiers.silver.discount = '0.10'; }],
    ['a tier discount below 0', (config) => { config.waveguard_tiers.silver.discount = -0.1; }],
    ['a tier discount of 1', (config) => { config.waveguard_tiers.silver.discount = 1; }],
    ['a tier discount above 1', (config) => { config.waveguard_tiers.silver.discount = 10; }],
    ['a tier service count saved as null', (config) => { config.waveguard_tiers.gold.min_services = null; }],
    ['a tier service count of 0', (config) => { config.waveguard_tiers.gold.min_services = 0; }],
    ['a tier service count that is not whole', (config) => { config.waveguard_tiers.gold.min_services = 2.5; }],
    ['a tier service count saved as text', (config) => { config.waveguard_tiers.gold.min_services = '3'; }],
    // Whole numbers of 1 or more, which the Pricing Logic route saves, but not the counts the engine's tier
    // picker uses.
    ['a bronze service count of 2', (config) => { config.waveguard_tiers.bronze.min_services = 2; }],
    ['a silver service count of 1', (config) => { config.waveguard_tiers.silver.min_services = 1; }],
    ['a gold service count of 2', (config) => { config.waveguard_tiers.gold.min_services = 2; }],
    ['a platinum service count of 5', (config) => { config.waveguard_tiers.platinum.min_services = 5; }],
  ])('%s', async (_label, change) => {
    expect(await answers(change)).toMatchObject(REFUSED_BY_BOTH);
  });

  test('a row that loses a field: the workers that loaded it keep its value, a worker that starts later holds the in-code value, and all refuse', async () => {
    let inCode;
    const result = await answers((config, constants) => {
      inCode = constants.PROPERTY_TYPE_ADJ.duplex;
      config.pest_property_type.duplex = inCode + 41;
    });
    expect(result).toMatchObject({ coldAnswer: true, warmAnswer: true });
    // Now the row loses the field.
    for (const worker of [result.cold, result.warm]) {
      const config = fullRows(worker.constants);
      delete config.pest_property_type.duplex;
      await expect(sync(worker, config)).resolves.toBe(true);
      expect(worker.constants.PROPERTY_TYPE_ADJ.duplex).toBe(inCode + 41);
      expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    }
    const restarted = freshWorker();
    const config = fullRows(restarted.constants);
    delete config.pest_property_type.duplex;
    await expect(sync(restarted, config)).resolves.toBe(true);
    expect(restarted.constants.PROPERTY_TYPE_ADJ.duplex).toBe(inCode);
    expect(restarted.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  test('a tier discount of 0 from the row counts (Bronze)', async () => {
    const worker = freshWorker();
    const config = fullRows(worker.constants);
    config.waveguard_tiers.bronze = { discount: 0, min_services: 1 };
    await expect(sync(worker, config)).resolves.toBe(true);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  // An empty breakpoints list is not a partial config: the bridge's own validation refuses it.
  test('pest_footprint with an empty breakpoints list fails the whole sync', async () => {
    const worker = freshWorker();
    await expect(sync(worker, { ...fullRows(worker.constants), pest_footprint: { breakpoints: [] } })).resolves.toBe(false);
    expect(worker.constants.PEST.footprintBrackets.length).toBeGreaterThan(0);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });
});

// attached_garage is the one field of these rows that the rows may lack: no row has carried it. The sync gives
// it its in-code value when the row has none, so a worker that took one from an earlier row does not keep it.
describe('the optional field (pest_features.attached_garage) has an explicit default', () => {
  test('a row with the field as a number: the engine takes it, and the answer is yes', async () => {
    const worker = freshWorker();
    const config = fullRows(worker.constants);
    config.pest_features.attached_garage = 9;
    await sync(worker, config);
    expect(worker.constants.PEST.additionalAdjustments.attachedGarage).toBe(9);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  // The sync applies what its arithmetic can read, so each of these reaches the engine as a finite number and
  // passes the bridge's validation. None is a price input the row states, so the answer is no in every worker.
  test.each([
    ['true', true],
    ['false', false],
    ['a number saved as text', '7'],
    ['a list of one number', [7]],
  ])('a row with the field as %s: the sync applies it, and a cold worker and a warm worker refuse', async (_label, value) => {
    const result = await answers((config) => { config.pest_features.attached_garage = value; });
    expect(result).toMatchObject(REFUSED_BY_BOTH);
    for (const { constants } of [result.cold, result.warm]) {
      const applied = constants.PEST.additionalAdjustments.attachedGarage;
      expect(applied).toBe(Math.round(value * constants.PROCESSING_ADJUSTMENT));
      expect(Number.isFinite(applied)).toBe(true);
    }
  });

  // Null is "left out": the sync does not apply it.
  test('a row with the field as null: both workers hold the in-code value, and both answer yes', async () => {
    const result = await answers((config) => { config.pest_features.attached_garage = null; });
    expect(result).toMatchObject({ coldSynced: true, coldAnswer: true, warmSynced: true, warmAnswer: true });
    const inCode = freshWorker().constants.PEST.additionalAdjustments.attachedGarage;
    expect(result.cold.constants.PEST.additionalAdjustments.attachedGarage).toBe(inCode);
    expect(result.warm.constants.PEST.additionalAdjustments.attachedGarage).toBe(inCode);
  });

  test('a warm worker that held a number refuses when the row then carries true, and answers yes again when the number is back', async () => {
    const worker = freshWorker();
    const config = fullRows(worker.constants);
    config.pest_features.attached_garage = 9;
    await sync(worker, config);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
    config.pest_features.attached_garage = true;
    await sync(worker, config);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    config.pest_features.attached_garage = 9;
    await sync(worker, config);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  test('a row without the field: a cold worker and a warm worker hold the same in-code value, and both answer yes', async () => {
    const cold = freshWorker();
    const inCode = cold.constants.PEST.additionalAdjustments.attachedGarage;
    expect(Number.isFinite(inCode)).toBe(true);
    await sync(cold, fullRows(cold.constants));
    expect(cold.constants.PEST.additionalAdjustments.attachedGarage).toBe(inCode);
    expect(cold.bridge.standardPestPriceRowsAreComplete()).toBe(true);

    const warm = freshWorker();
    const first = fullRows(warm.constants);
    first.pest_features.attached_garage = inCode + 4;
    await sync(warm, first);
    expect(warm.constants.PEST.additionalAdjustments.attachedGarage).toBe(inCode + 4);
    await sync(warm, fullRows(warm.constants));
    expect(warm.constants.PEST.additionalAdjustments.attachedGarage).toBe(inCode);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  test('a config with no features row at all also resets the field (the answer is no for the missing row)', async () => {
    const warm = freshWorker();
    const inCode = warm.constants.PEST.additionalAdjustments.attachedGarage;
    const first = fullRows(warm.constants);
    first.pest_features.attached_garage = inCode + 4;
    await sync(warm, first);
    const config = fullRows(warm.constants);
    delete config.pest_features;
    await sync(warm, config);
    expect(warm.constants.PEST.additionalAdjustments.attachedGarage).toBe(inCode);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });
});

// enforce_floor_post_discount is the other optional field: the switch of the program floor, false when the row
// leaves it out. The sync takes it only as a boolean and reads anything else as false, in every worker. A row
// that carries it as text or as 1 asks for the floor, and the engine would price without it.
describe('the optional floor switch (pest_base.enforce_floor_post_discount) is a boolean when the row carries it', () => {
  test.each([[true], [false]])('a row with the switch as %p: the engine takes it, and both workers answer yes', async (value) => {
    const result = await answers((config) => { config.pest_base.enforce_floor_post_discount = value; });
    expect(result).toMatchObject({ coldSynced: true, coldAnswer: true, warmBefore: true, warmSynced: true, warmAnswer: true });
    expect(result.cold.constants.PEST.enforceFloorPostDiscount).toBe(value);
    expect(result.warm.constants.PEST.enforceFloorPostDiscount).toBe(value);
  });

  test.each([
    ['"true" as text', 'true'],
    ['"false" as text', 'false'],
    ['the number 1', 1],
    ['the number 0', 0],
    ['a list', [true]],
  ])('a row with the switch as %s: the sync loads false, and a cold worker and a warm worker refuse', async (_label, value) => {
    const result = await answers((config) => { config.pest_base.enforce_floor_post_discount = value; });
    expect(result).toMatchObject(REFUSED_BY_BOTH);
    expect(result.cold.constants.PEST.enforceFloorPostDiscount).toBe(false);
    expect(result.warm.constants.PEST.enforceFloorPostDiscount).toBe(false);
  });

  // Null is "left out", as for the other optional field.
  test('a row with the switch as null, or without it: the engine holds false, and both workers answer yes', async () => {
    for (const change of [(config) => { config.pest_base.enforce_floor_post_discount = null; }, () => {}]) {
      const result = await answers(change);
      expect(result).toMatchObject({ coldSynced: true, coldAnswer: true, warmSynced: true, warmAnswer: true });
      expect(result.cold.constants.PEST.enforceFloorPostDiscount).toBe(false);
      expect(result.warm.constants.PEST.enforceFloorPostDiscount).toBe(false);
    }
  });

  test('a warm worker that held true refuses when the row then carries "true" as text, and answers yes again when the boolean is back', async () => {
    const worker = freshWorker();
    const config = fullRows(worker.constants);
    config.pest_base.enforce_floor_post_discount = true;
    await sync(worker, config);
    expect(worker.constants.PEST.enforceFloorPostDiscount).toBe(true);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
    config.pest_base.enforce_floor_post_discount = 'true';
    await sync(worker, config);
    expect(worker.constants.PEST.enforceFloorPostDiscount).toBe(false);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    config.pest_base.enforce_floor_post_discount = true;
    await sync(worker, config);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });
});

// min_services is the one field of these rows that the engine's own tier picker does not read. The picker
// (determineWaveGuardTier) counts by fixed thresholds, and the estimate converter picks the tier of an accepted
// estimate from the loaded ones. With another threshold in the row the two disagree, so the answer takes only
// the picker's own counts.
describe('the tier thresholds are the ones the engine\'s tier picker uses', () => {
  const ONE_PEST_SERVICE = {
    homeSqFt: 2200, lotSqFt: 8000, stories: 1, propertyType: 'single_family', features: {},
    services: { pest: { frequency: 'quarterly' } },
  };
  // The tier the in-code thresholds give for a count of qualifying services: the highest tier it reaches.
  const tierByThresholds = (constants, count) => TIERS.reduce(
    (found, tier) => (count >= constants.WAVEGUARD.tiers[tier].minServices ? tier : found), 'bronze',
  );

  test('the picker gives the tier of the in-code thresholds for every count of qualifying services', () => {
    const { constants } = freshWorker();
    const { determineWaveGuardTier } = require('../services/pricing-engine/discount-engine');
    const qualifying = constants.WAVEGUARD.qualifyingServices;
    expect(qualifying.length).toBeGreaterThanOrEqual(5);
    expect(TIERS.map((tier) => constants.WAVEGUARD.tiers[tier].minServices)).toEqual([1, 2, 3, 4]);
    for (let count = 0; count <= qualifying.length; count += 1) {
      expect([count, determineWaveGuardTier(qualifying.slice(0, count)).tier]).toEqual([count, tierByThresholds(constants, count)]);
    }
  });

  test('a silver threshold of 1 in the row: the sync loads it, the picker and the engine still give one pest service bronze, and the answer is no', async () => {
    const worker = freshWorker();
    const { constants } = worker;
    const config = fullRows(constants);
    config.waveguard_tiers.silver = { discount: 0.1, min_services: 1 };
    await expect(sync(worker, config)).resolves.toBe(true);
    // The loaded threshold says one service earns silver ...
    expect(constants.WAVEGUARD.tiers.silver).toMatchObject({ discount: 0.1, minServices: 1 });
    expect(tierByThresholds(constants, 1)).toBe('silver');
    // ... and the engine quotes one pest service at bronze, with no tier discount.
    expect(require('../services/pricing-engine/discount-engine').determineWaveGuardTier(['pest_control']).tier).toBe('bronze');
    const estimate = require('../services/pricing-engine').generateEstimate(ONE_PEST_SERVICE);
    const line = estimate.lineItems.find((item) => item.service === 'pest_control');
    expect(estimate.waveGuard.tier).toBe('bronze');
    expect(line.annual).toBeGreaterThan(0);
    expect(line.annualAfterDiscount).toBe(line.annual);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  test('the same row with the picker\'s threshold: the same bronze quote, and the answer is yes', async () => {
    const worker = freshWorker();
    const config = fullRows(worker.constants);
    config.waveguard_tiers.silver = { discount: 0.1, min_services: 2 };
    await expect(sync(worker, config)).resolves.toBe(true);
    const estimate = require('../services/pricing-engine').generateEstimate(ONE_PEST_SERVICE);
    expect(estimate.waveGuard.tier).toBe('bronze');
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  test('a warm worker that held the picker\'s thresholds refuses a row with another one, and answers yes again when it is back', async () => {
    const warm = freshWorker();
    await sync(warm, fullRows(warm.constants));
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(true);
    const config = fullRows(warm.constants);
    config.waveguard_tiers.gold.min_services = 2;
    await expect(sync(warm, config)).resolves.toBe(true);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    config.waveguard_tiers.gold.min_services = 3;
    await expect(sync(warm, config)).resolves.toBe(true);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });
});

// The lists in the bridge must be the fields its sync reads. A new field needs a decision: required, or
// optional with an explicit default.
describe('the bridge reads no field of these rows that the answer does not know', () => {
  const source = fs.readFileSync(require.resolve('../services/pricing-engine/db-bridge'), 'utf8');
  const fieldsRead = (text, pattern) => [...new Set([...text.matchAll(pattern)].map((match) => match[1]))].sort();
  const block = (from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  test('pest_features: the fourteen required fields and attached_garage', () => {
    const features = block('if (config.pest_features) {', 'if (config.pest_footprint?.breakpoints) {');
    expect(fieldsRead(features, /\bf\.([a-z_]+) != null/g)).toEqual([...FEATURE_FIELDS].sort());
  });

  test('pest_base: base and floor (required), enforce_floor_post_discount (optional, a boolean), initial_roach (the visit-1 knockdown, not this price)', () => {
    expect(fieldsRead(source, /config\.pest_base\??\.([a-z_]+)/g)).toEqual(['base', 'enforce_floor_post_discount', 'floor', 'initial_roach']);
  });

  test('pest_footprint: breakpoints, each with sqft and adj', () => {
    expect(fieldsRead(source, /config\.pest_footprint\??\.([a-z_]+)/g)).toEqual(['breakpoints']);
    const footprint = block('if (config.pest_footprint?.breakpoints) {', 'if (config.pest_property_type) {');
    expect(fieldsRead(footprint, /\bbp\.([a-z_]+)/g)).toEqual(['adj', 'sqft']);
  });

  test('waveguard_tiers: discount and min_services of each tier', () => {
    const tiers = block('if (config.waveguard_tiers) {', '// ── Mosquito');
    expect(fieldsRead(tiers, /\bval\.([a-z_]+)/g)).toEqual(['discount', 'min_services']);
  });

  test.each(FEATURE_FIELDS)('pest_features.%s alone is read into one adjustment', async (field) => {
    const worker = freshWorker();
    const before = { ...worker.constants.PEST.additionalAdjustments };
    await expect(sync(worker, { ...fullRows(worker.constants), pest_features: { [field]: 77 } })).resolves.toBe(true);
    const after = worker.constants.PEST.additionalAdjustments;
    const changed = Object.keys(after).filter((key) => after[key] !== before[key]);
    expect(changed).toHaveLength(1);
    expect(after[changed[0]]).toBe(77);
  });

  test('the engine knows the six property types and the four tiers the rows carry', () => {
    const { constants } = freshWorker();
    expect(Object.keys(constants.PROPERTY_TYPE_ADJ).sort()).toEqual([...PROPERTY_TYPES].sort());
    expect(Object.keys(constants.WAVEGUARD.tiers).sort()).toEqual([...TIERS].sort());
  });
});

// A failed sync restores the constants of the last good sync, so its answer stays too (like the time of the
// last good sync). The strict caller never prices after a failed sync anyway: it throws on the failure.
describe('a sync that fails leaves the answer of the last good sync', () => {
  test('yes stays yes, also when the failed sync carried fewer rows', async () => {
    const worker = freshWorker();
    await sync(worker, fullRows(worker.constants));
    const duplex = worker.constants.PROPERTY_TYPE_ADJ.duplex;
    const config = refusedRows(worker.constants);
    config.pest_property_type = { duplex: duplex + 41 };
    await expect(sync(worker, config)).resolves.toBe(false);
    expect(worker.constants.PROPERTY_TYPE_ADJ.duplex).toBe(duplex);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  test('no stays no, also when the failed sync carried every required field', async () => {
    const worker = freshWorker();
    const partial = fullRows(worker.constants);
    delete partial.pest_property_type;
    await sync(worker, partial);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    await expect(sync(worker, refusedRows(worker.constants))).resolves.toBe(false);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  test('the next good sync decides again', async () => {
    const worker = freshWorker();
    const partial = fullRows(worker.constants);
    delete partial.waveguard_tiers;
    await sync(worker, partial);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    await sync(worker, fullRows(worker.constants));
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });
});

// A sync puts the rows into the engine and then awaits its other reads (the product catalog among them). Only at
// its end does it succeed (the answer moves) or fail (the constants go back). In between, the engine can hold
// rows that the answer has not judged, or values that will not stay. So the answer is no until the sync is over.
describe('while a sync is in flight the answer is no', () => {
  // A sync that stops at its first catalog read, after it has put the rows into the engine, until finish().
  const pausedSync = async (worker, config) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const atCatalogRead = new Promise((resolve) => { reached = resolve; });
    const db = configDb(worker, config);
    db.schema.hasTable = jest.fn(async (table) => {
      if (table === 'products_catalog') { reached(); await gate; }
      return true;
    });
    const done = worker.bridge.syncConstantsFromDB(db);
    await atCatalogRead;
    return { finish: () => { release(); return done; } };
  };
  // A worker whose last sync loaded the full rows: its answer is yes.
  const warmWorker = async () => {
    const worker = freshWorker();
    await sync(worker, fullRows(worker.constants));
    expect(worker.bridge.isSyncInFlight()).toBe(false);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
    return worker;
  };

  test('a refresh of rows that lack a field: the engine already holds its new base price, and the yes of the sync before it does not stand', async () => {
    const worker = await warmWorker();
    const base = worker.constants.PEST.base;
    const partial = fullRows(worker.constants);
    partial.pest_base.base = base + 5;
    delete partial.pest_features.indoor;

    const refresh = await pausedSync(worker, partial);
    expect(worker.bridge.isSyncInFlight()).toBe(true);
    expect(worker.constants.PEST.base).toBe(base + 5);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);

    await expect(refresh.finish()).resolves.toBe(true);
    expect(worker.bridge.isSyncInFlight()).toBe(false);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  test('a refresh of complete rows: no until it is over, then yes', async () => {
    const worker = await warmWorker();
    const base = worker.constants.PEST.base;
    const complete = fullRows(worker.constants);
    complete.pest_base.base = base + 5;

    const refresh = await pausedSync(worker, complete);
    expect(worker.constants.PEST.base).toBe(base + 5);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);

    await expect(refresh.finish()).resolves.toBe(true);
    expect(worker.constants.PEST.base).toBe(base + 5);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  test('a refresh the validation refuses: no while the engine holds its rows, and yes again when the constants are back', async () => {
    const worker = await warmWorker();
    const base = worker.constants.PEST.base;
    const refused = refusedRows(worker.constants);
    refused.pest_base.base = base + 5;

    const refresh = await pausedSync(worker, refused);
    expect(worker.constants.PEST.base).toBe(base + 5);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);

    await expect(refresh.finish()).resolves.toBe(false);
    expect(worker.constants.PEST.base).toBe(base);
    expect(worker.bridge.isSyncInFlight()).toBe(false);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  test('the first sync of a worker: no while it runs, yes when its complete rows are in', async () => {
    const worker = freshWorker();
    const refresh = await pausedSync(worker, fullRows(worker.constants));
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    await expect(refresh.finish()).resolves.toBe(true);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });
});

// The answer is about ROWS and the constants they feed (the standard pest price, the tier table). It is not about a
// quote. The first test is the rows' side: on the standard ladder, pest alone reads nothing but the five rows.
// Each test after it is a quote that gets its pest price in a way those rows do not decide, with the answer at
// yes. That is why the name speaks of rows, and why a caller that vouches for a quote checks the quote's path.
describe('the answer is about the rows of the standard pest price, not about a quote', () => {
  const PEST_ALONE = {
    homeSqFt: 2200, lotSqFt: 8000, stories: 1, propertyType: 'single_family', features: {},
    services: { pest: { frequency: 'quarterly' } },
  };
  const WITH_RODENT_BAIT = { ...PEST_ALONE, services: { ...PEST_ALONE.services, rodentBait: {} } };
  // The full rows plus the rows of one case, loaded by a worker that just started: the real engine's quote.
  const quoted = async (moreRows, input) => {
    const worker = freshWorker();
    await expect(sync(worker, { ...fullRows(worker.constants), ...moreRows })).resolves.toBe(true);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
    const estimate = require('../services/pricing-engine').generateEstimate(typeof input === 'function' ? input(worker) : input);
    const line = estimate.lineItems.find((item) => item.service === 'pest_control');
    return { tier: estimate.waveGuard.tier, perApp: line.perApp, annual: line.annual, annualAfterDiscount: line.annualAfterDiscount, line };
  };
  const RODENT_ROWS = [
    ['no rodent row', {}],
    ['rodent bait counts toward the tier', { rodent_waveguard: { tier_qualifier: true } }],
    ['rodent bait does not count', { rodent_waveguard: { tier_qualifier: false } }],
    ['the older row says it does not count', { rodent_rules: { tier_qualifier: false } }],
    ['the qualifier is saved as text', { rodent_waveguard: { tier_qualifier: 'false' } }],
  ];

  test('pest alone on the standard ladder is one qualifying service, at the same price, whatever the rodent rows say', async () => {
    const quotes = [];
    for (const [label, rodentRows] of RODENT_ROWS) {
      const { line: _line, ...quote } = await quoted(rodentRows, PEST_ALONE);
      quotes.push([label, quote]);
    }
    const [, first] = quotes[0];
    expect(first.tier).toBe('bronze');
    expect(first.annual).toBeGreaterThan(0);
    for (const [label, quote] of quotes) expect([label, quote]).toEqual([label, first]);
  });

  test('a bundle: with rodent bait in the quote, the tier follows the rodent row', async () => {
    const counts = await quoted({ rodent_waveguard: { tier_qualifier: true } }, WITH_RODENT_BAIT);
    const doesNotCount = await quoted({ rodent_waveguard: { tier_qualifier: false } }, WITH_RODENT_BAIT);
    expect([counts.tier, doesNotCount.tier]).toEqual(['silver', 'bronze']);
  });

  test('a trusted bedroom band: the price is the band\'s, and the ladder never runs for that line', async () => {
    const saved = process.env.PRICING_SNAPSHOT_SECRET;
    process.env.PRICING_SNAPSHOT_SECRET = 'pest-price-rows-test';
    try {
      const ADDRESS = '1400 Example Test Dr Apt 7109, Sarasota, FL 34240';
      const band = {
        serviceCode: 'pest', frequency: 'quarterly', intentFrequency: 'quarterly', band: 'one_bedroom',
        initialPrice: 85, recurringPrice: 85, includedScope: 'interior_unit_general_pest',
        oversizeSqftThreshold: 2200, effectiveDate: '2026-08-13', scopeExclusions: [], scopeNote: null,
      };
      const banded = await quoted({}, () => {
        const { signUnitBandSnapshot } = require('../services/pricing-engine/unit-band-pricing');
        return {
          services: { pest: { frequency: 'quarterly' } }, propertyType: 'unknown', stories: 1, isCommercial: false,
          address: ADDRESS, unitBandPricing: { pest: { ...band, ...signUnitBandSnapshot(band, ADDRESS) } },
        };
      });
      expect(banded.line.quoteRequired).toBeFalsy();
      expect(banded.perApp).toBe(85);
      // The same home with no band is priced on the ladder, at another price.
      const onLadder = await quoted({}, { services: { pest: { frequency: 'quarterly' } }, propertyType: 'unknown', stories: 1, isCommercial: false, address: ADDRESS });
      expect(onLadder.perApp).toBeGreaterThan(0);
      expect(onLadder.perApp).not.toBe(85);
    } finally {
      if (saved === undefined) delete process.env.PRICING_SNAPSHOT_SECRET;
      else process.env.PRICING_SNAPSHOT_SECRET = saved;
    }
  });

  test('a saved quote with its own floor: the price follows that floor, not the row\'s', async () => {
    const standard = await quoted({}, PEST_ALONE);
    const pinned = await quoted({}, (worker) => ({ ...PEST_ALONE, pestProgramFloorPerVisit: worker.constants.PEST.floor + 400 }));
    expect(pinned.perApp).toBeGreaterThan(standard.perApp);
  });

  test('an explicit legacy pricing version: the cadence curve is the quote\'s, not the live one', async () => {
    const monthly = { ...PEST_ALONE, services: { pest: { frequency: 'monthly' } } };
    const live = await quoted({}, monthly);
    const legacy = await quoted({}, { ...monthly, services: { pest: { frequency: 'monthly', version: 'v1' } } });
    expect(legacy.annual).not.toBe(live.annual);
  });
});
