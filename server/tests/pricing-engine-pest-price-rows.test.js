// recurringPestPriceIsFromRows: did the recurring pest price inputs come from their pricing_config rows?
//
// The REAL bridge on a fake pricing_config. A sync answers true when the table holds any row at all. For a row
// or a field that is missing it keeps what the engine had: the in-code default on a cold start, an earlier value
// on a warm process. A caller that prices with nobody watching (strictPriceSettings in customer-pricing-ai.js)
// asks this answer instead of trusting "the sync succeeded".
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
const sync = ({ constants, bridge }, config) => bridge.syncConstantsFromDB(pricingConfigDb([
  { config_key: 'global_labor_rate', data: { value: constants.GLOBAL.LABOR_RATE } },
  ...Object.entries(config).map(([config_key, data]) => ({ config_key, data })),
]));

// What a cold worker and a warm worker (one that loaded the full rows first) answer for the same rows.
// `change(config, constants)` edits the full rows in place.
async function answers(change) {
  const cold = freshWorker();
  const coldConfig = fullRows(cold.constants);
  change(coldConfig, cold.constants);
  const coldSynced = await sync(cold, coldConfig);
  const coldAnswer = cold.bridge.recurringPestPriceIsFromRows();

  const warm = freshWorker();
  await sync(warm, fullRows(warm.constants));
  const warmBefore = warm.bridge.recurringPestPriceIsFromRows();
  const warmConfig = fullRows(warm.constants);
  change(warmConfig, warm.constants);
  const warmSynced = await sync(warm, warmConfig);
  return { coldSynced, coldAnswer, warmBefore, warmSynced, warmAnswer: warm.bridge.recurringPestPriceIsFromRows(), cold, warm };
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
    expect(freshWorker().bridge.recurringPestPriceIsFromRows()).toBe(false);
  });

  test('no after a first sync that fails, though its rows carried every required field', async () => {
    const worker = freshWorker();
    await expect(sync(worker, refusedRows(worker.constants))).resolves.toBe(false);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
  });

  test('yes after a sync of the five rows as the schema seeds them', async () => {
    const worker = freshWorker();
    expect(Object.keys(fullRows(worker.constants)).sort()).toEqual([...ROW_KEYS].sort());
    await expect(sync(worker, fullRows(worker.constants))).resolves.toBe(true);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
  });

  test('pricing_config with rows, none of them a pest row: the sync succeeds, the engine prices from its in-code base price, and the answer is no', async () => {
    const worker = freshWorker();
    const base = worker.constants.PEST.base;
    await expect(sync(worker, {})).resolves.toBe(true);
    expect(worker.constants.PEST.base).toBe(base);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
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
    const counts = [1, 3, 5, 7];
    TIERS.forEach((tier, index) => { config.waveguard_tiers[tier] = { discount: discounts[index], min_services: counts[index] }; });

    await expect(sync(worker, config)).resolves.toBe(true);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
    expect(constants.PEST.base).toBe(expected.base);
    expect(constants.PEST.floor).toBe(expected.floor);
    expect(constants.PEST.footprintBrackets).toEqual([{ sqft: 1000, adj: -7 }, { sqft: 2000, adj: 4 }, { sqft: 3000, adj: 11 }]);
    const markers = Object.values(constants.PEST.additionalAdjustments).filter((value) => value >= 20 && value < 20 + REQUIRED_FEATURE_FIELDS.length);
    expect(markers.sort((a, b) => a - b)).toEqual(REQUIRED_FEATURE_FIELDS.map((_field, index) => 20 + index));
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
      expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
    }
    const restarted = freshWorker();
    const config = fullRows(restarted.constants);
    delete config.pest_property_type.duplex;
    await expect(sync(restarted, config)).resolves.toBe(true);
    expect(restarted.constants.PROPERTY_TYPE_ADJ.duplex).toBe(inCode);
    expect(restarted.bridge.recurringPestPriceIsFromRows()).toBe(false);
  });

  test('a tier discount of 0 from the row counts (Bronze)', async () => {
    const worker = freshWorker();
    const config = fullRows(worker.constants);
    config.waveguard_tiers.bronze = { discount: 0, min_services: 1 };
    await expect(sync(worker, config)).resolves.toBe(true);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
  });

  // An empty breakpoints list is not a partial config: the bridge's own validation refuses it.
  test('pest_footprint with an empty breakpoints list fails the whole sync', async () => {
    const worker = freshWorker();
    await expect(sync(worker, { ...fullRows(worker.constants), pest_footprint: { breakpoints: [] } })).resolves.toBe(false);
    expect(worker.constants.PEST.footprintBrackets.length).toBeGreaterThan(0);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
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
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
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
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
    config.pest_features.attached_garage = true;
    await sync(worker, config);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
    config.pest_features.attached_garage = 9;
    await sync(worker, config);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
  });

  test('a row without the field: a cold worker and a warm worker hold the same in-code value, and both answer yes', async () => {
    const cold = freshWorker();
    const inCode = cold.constants.PEST.additionalAdjustments.attachedGarage;
    expect(Number.isFinite(inCode)).toBe(true);
    await sync(cold, fullRows(cold.constants));
    expect(cold.constants.PEST.additionalAdjustments.attachedGarage).toBe(inCode);
    expect(cold.bridge.recurringPestPriceIsFromRows()).toBe(true);

    const warm = freshWorker();
    const first = fullRows(warm.constants);
    first.pest_features.attached_garage = inCode + 4;
    await sync(warm, first);
    expect(warm.constants.PEST.additionalAdjustments.attachedGarage).toBe(inCode + 4);
    await sync(warm, fullRows(warm.constants));
    expect(warm.constants.PEST.additionalAdjustments.attachedGarage).toBe(inCode);
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(true);
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
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(false);
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

  test('pest_base: base and floor (required), enforce_floor_post_discount (reset at every sync), initial_roach (the visit-1 knockdown, not this price)', () => {
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
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
  });

  test('no stays no, also when the failed sync carried every required field', async () => {
    const worker = freshWorker();
    const partial = fullRows(worker.constants);
    delete partial.pest_property_type;
    await sync(worker, partial);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
    await expect(sync(worker, refusedRows(worker.constants))).resolves.toBe(false);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
  });

  test('the next good sync decides again', async () => {
    const worker = freshWorker();
    const partial = fullRows(worker.constants);
    delete partial.waveguard_tiers;
    await sync(worker, partial);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
    await sync(worker, fullRows(worker.constants));
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
  });
});
