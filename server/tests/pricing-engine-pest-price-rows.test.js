// recurringPestPriceIsFromRows: did the recurring pest price inputs come from their pricing_config rows?
//
// The REAL bridge on a fake pricing_config. A sync answers true when the table holds any row at all. For a row
// or a field that is missing it keeps what the engine had: the in-code default on a cold start, an earlier value
// on a warm process. A caller that prices with nobody watching (the plan start offer, through
// strictPriceSettings in customer-pricing-ai.js) asks this answer instead of trusting "the sync succeeded".
//
// Every test starts with a cold bridge and pristine constants (jest.resetModules).
const fs = require('fs');

let constants;
let bridge;
let warnSpy;
let errorSpy;
beforeEach(() => {
  jest.resetModules();
  constants = require('../services/pricing-engine/constants');
  bridge = require('../services/pricing-engine/db-bridge');
  // The fake answers the catalog reads of a sync with nothing (the bridge warns and keeps its defaults), and a
  // sync the validation refuses logs an error.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { warnSpy.mockRestore(); errorSpy.mockRestore(); });

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

// The five rows, with the values the engine already holds (a sync of them changes no price).
const fullRows = () => ({
  pest_base: { base: constants.PEST.base, floor: constants.PEST.floor },
  pest_footprint: { breakpoints: constants.PEST.footprintBrackets.map((b) => ({ sqft: b.sqft, adj: b.adj })) },
  pest_features: { indoor: constants.PEST.additionalAdjustments.indoor, near_water: constants.PEST.additionalAdjustments.nearWater },
  pest_property_type: { ...constants.PROPERTY_TYPE_ADJ },
  waveguard_tiers: Object.fromEntries(Object.entries(constants.WAVEGUARD.tiers)
    .map(([tier, t]) => [tier, { discount: t.discount, min_services: t.minServices }])),
});
const ROW_KEYS = ['pest_base', 'pest_footprint', 'pest_features', 'pest_property_type', 'waveguard_tiers'];
// A row of another service, so that a config with no pest row is still not empty.
const sync = (config) => bridge.syncConstantsFromDB(pricingConfigDb([
  { config_key: 'global_labor_rate', data: { value: constants.GLOBAL.LABOR_RATE } },
  ...Object.entries(config).map(([config_key, data]) => ({ config_key, data })),
]));
const fromRows = () => bridge.recurringPestPriceIsFromRows();
// A base price the bridge's own validation refuses: the whole sync fails.
const refused = () => ({ ...fullRows(), pest_base: { base: -1, floor: constants.PEST.floor } });
const without = (key) => { const config = fullRows(); delete config[key]; return config; };

describe('a cold process', () => {
  test('answers no before any sync', () => {
    expect(fromRows()).toBe(false);
  });

  test('answers no after a first sync that fails', async () => {
    await expect(sync(refused())).resolves.toBe(false);
    expect(fromRows()).toBe(false);
  });

  test('answers yes after a sync that applies the five rows', async () => {
    expect(Object.keys(fullRows()).sort()).toEqual([...ROW_KEYS].sort());
    await expect(sync(fullRows())).resolves.toBe(true);
    expect(fromRows()).toBe(true);
  });

  test('pricing_config with rows, none of them a pest row: the sync succeeds, and the answer is no', async () => {
    const base = constants.PEST.base;
    await expect(sync({})).resolves.toBe(true);
    // The engine prices from the in-code base price.
    expect(constants.PEST.base).toBe(base);
    expect(fromRows()).toBe(false);
  });

  test.each(ROW_KEYS)('without the %s row the sync still succeeds, and the answer is no', async (missing) => {
    await expect(sync(without(missing))).resolves.toBe(true);
    expect(fromRows()).toBe(false);
  });

  // A row counts only when the sync took a price input from it.
  test.each([
    ['pest_base with no base price', () => ({ pest_base: { floor: constants.PEST.floor } })],
    ['pest_base with no floor', () => ({ pest_base: { base: constants.PEST.base } })],
    ['pest_base with a floor of 0 (the sync does not apply a 0)', () => ({ pest_base: { base: constants.PEST.base, floor: 0 } })],
    ['pest_footprint with no breakpoints field', () => ({ pest_footprint: { other: 1 } })],
    ['pest_features with no field the sync reads', () => ({ pest_features: { tree_density: 5 } })],
    ['pest_property_type with no type the engine knows', () => ({ pest_property_type: { castle: 12 } })],
    ['waveguard_tiers with a tier missing', () => {
      const { bronze: _bronze, ...rest } = fullRows().waveguard_tiers;
      return { waveguard_tiers: rest };
    }],
    ['waveguard_tiers with a tier that has no discount', () => ({
      waveguard_tiers: { ...fullRows().waveguard_tiers, silver: { min_services: constants.WAVEGUARD.tiers.silver.minServices } },
    })],
  ])('%s does not count', async (_label, override) => {
    await expect(sync({ ...fullRows(), ...override() })).resolves.toBe(true);
    expect(fromRows()).toBe(false);
  });

  // An empty breakpoints list is not a partial config: the bridge's own validation refuses it.
  test('pest_footprint with an empty breakpoints list fails the whole sync', async () => {
    await expect(sync({ ...fullRows(), pest_footprint: { breakpoints: [] } })).resolves.toBe(false);
    expect(constants.PEST.footprintBrackets.length).toBeGreaterThan(0);
    expect(fromRows()).toBe(false);
  });

  test('a tier discount of 0 from the row counts (Bronze)', async () => {
    const config = fullRows();
    config.waveguard_tiers.bronze = { discount: 0, min_services: 1 };
    await expect(sync(config)).resolves.toBe(true);
    expect(fromRows()).toBe(true);
  });

  // A field no row carries is the in-code value in every process: the seeded features row has no
  // attached_garage, and the tier row may carry no min_services.
  test('a field the rows do not carry is not needed: the in-code value is the same in every process', async () => {
    const config = fullRows();
    for (const tier of Object.keys(config.waveguard_tiers)) delete config.waveguard_tiers[tier].min_services;
    expect(config.pest_features.attached_garage).toBeUndefined();
    await expect(sync(config)).resolves.toBe(true);
    expect(fromRows()).toBe(true);
  });
});

// The fields of the features row. The list in the bridge must be the fields its sync reads.
describe('the features row', () => {
  const FIELDS = [
    'pool_cage', 'pool_cage_small', 'pool_cage_medium', 'pool_cage_large', 'pool_cage_oversized', 'pool_no_cage',
    'shrubs_heavy', 'shrubs_moderate', 'shrubs_light', 'landscape_complex', 'landscape_moderate', 'landscape_simple',
    'near_water', 'indoor', 'attached_garage',
  ];

  test.each(FIELDS)('%s alone is enough for the row, and the sync reads it', async (field) => {
    const before = { ...constants.PEST.additionalAdjustments };
    await expect(sync({ ...fullRows(), pest_features: { [field]: 77 } })).resolves.toBe(true);
    const changed = Object.keys(constants.PEST.additionalAdjustments).filter((key) => constants.PEST.additionalAdjustments[key] !== before[key]);
    expect(changed).toHaveLength(1);
    expect(constants.PEST.additionalAdjustments[changed[0]]).toBe(77);
    expect(fromRows()).toBe(true);
  });

  test('the sync reads no field outside that list', () => {
    const source = fs.readFileSync(require.resolve('../services/pricing-engine/db-bridge'), 'utf8');
    const block = source.slice(source.indexOf('if (config.pest_features) {'), source.indexOf('if (config.pest_footprint?.breakpoints) {'));
    const read = [...new Set([...block.matchAll(/\bf\.([a-z_]+) != null/g)].map((match) => match[1]))];
    expect(read.sort()).toEqual([...FIELDS].sort());
  });
});

// The hazard on a warm process: a row or a field is gone, the sync succeeds, and the engine still prices from the
// value an earlier sync took. A second process that starts now would hold the in-code value instead.
describe('a warm process: nothing may be left over from an earlier sync', () => {
  test.each(ROW_KEYS)('after the %s row is removed the answer is no, and yes again when the row is back', async (missing) => {
    await sync(fullRows());
    expect(fromRows()).toBe(true);
    await expect(sync(without(missing))).resolves.toBe(true);
    expect(fromRows()).toBe(false);
    await sync(fullRows());
    expect(fromRows()).toBe(true);
  });

  test('the base row is removed: the engine keeps the earlier base price', async () => {
    const earlier = constants.PEST.base + 7;
    await sync({ ...fullRows(), pest_base: { base: earlier, floor: constants.PEST.floor } });
    expect(constants.PEST.base).toBe(earlier);
    await expect(sync(without('pest_base'))).resolves.toBe(true);
    expect(constants.PEST.base).toBe(earlier);
    expect(fromRows()).toBe(false);
  });

  // The row is still there and still counts by itself. One field of it is gone.
  test.each([
    ['a features field', (config) => { delete config.pest_features.near_water; }, () => constants.PEST.additionalAdjustments.nearWater, (config) => { config.pest_features.near_water = 41; }],
    ['a property type', (config) => { delete config.pest_property_type.duplex; }, () => constants.PROPERTY_TYPE_ADJ.duplex, (config) => { config.pest_property_type.duplex = 41; }],
    ['the floor (saved as 0)', (config) => { config.pest_base.floor = 0; }, () => constants.PEST.floor, (config) => { config.pest_base.floor = 41; }],
    ['the service count of a tier', (config) => { delete config.waveguard_tiers.gold.min_services; }, () => constants.WAVEGUARD.tiers.gold.minServices, (config) => { config.waveguard_tiers.gold.min_services = 41; }],
  ])('%s is removed from its row: the engine keeps the earlier value, and the answer is no until it is back', async (_label, remove, held, setEarlier) => {
    const first = fullRows();
    setEarlier(first);
    await sync(first);
    expect(held()).toBe(41);
    expect(fromRows()).toBe(true);

    const second = fullRows();
    setEarlier(second);
    remove(second);
    await expect(sync(second)).resolves.toBe(true);
    expect(held()).toBe(41);
    expect(fromRows()).toBe(false);

    await sync(first);
    expect(fromRows()).toBe(true);
  });

  // A failed sync restores the constants of the last good sync, so its answer stays too (like the time of the
  // last good sync). The strict caller never prices after a failed sync anyway: it throws on the failure.
  test('a sync that fails leaves the answer of the last good sync: yes stays yes', async () => {
    await sync(fullRows());
    const base = constants.PEST.base;
    // No features row, and a base price the validation refuses.
    const config = refused();
    delete config.pest_features;
    await expect(sync(config)).resolves.toBe(false);
    expect(constants.PEST.base).toBe(base);
    expect(fromRows()).toBe(true);
  });

  test('a sync that fails leaves the answer of the last good sync: no stays no', async () => {
    await sync(fullRows());
    await sync(without('pest_features'));
    expect(fromRows()).toBe(false);
    await expect(sync(refused())).resolves.toBe(false);
    expect(fromRows()).toBe(false);
  });

  test('a field a failed sync would have taken is not remembered', async () => {
    await sync(fullRows());
    const config = refused();
    config.pest_features.attached_garage = 5;
    await expect(sync(config)).resolves.toBe(false);
    // The next good sync carries no attached_garage: nothing is left over, because the failed sync was rolled back.
    await sync(fullRows());
    expect(fromRows()).toBe(true);
  });
});
