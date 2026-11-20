// standardPestPriceRowsAreComplete against real PostgreSQL (one rolled-back transaction per test): the REAL
// bridge on the REAL pricing_config rows of the migrated schema. The unit suite
// (pricing-engine-pest-price-rows.test.js) builds its rows by hand. This one proves what only the database can:
// the rows the migrations seed carry every required input of the standard pest price, and a row that loses one
// is refused by a worker that just started and by a warm one. No network, no spend, no customer.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const PRICE_ROWS = ['pest_base', 'pest_footprint', 'pest_features', 'pest_property_type', 'waveguard_tiers'];

postgres('recurring pest price rows (live Postgres)', () => {
  // The first test loads the pricing engine.
  jest.setTimeout(90000);
  let database;
  let trx;
  let logSpy;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  beforeEach(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    trx = await database.transaction();
    mockConnection = trx;
  });

  afterEach(async () => {
    await trx.rollback();
    logSpy.mockRestore();
  });

  // A worker that just started: its own module registry, so pristine constants and a bridge that has not synced.
  const freshWorker = () => {
    jest.resetModules();
    return {
      constants: require('../services/pricing-engine/constants'),
      bridge: require('../services/pricing-engine/db-bridge'),
    };
  };
  // A refresh of the rows this transaction can see, whatever the bridge loaded before.
  const refresh = async ({ bridge }) => {
    bridge.invalidatePricingConfigCache();
    return bridge.syncConstantsFromDB(trx);
  };
  const dropField = (row, path) => trx.raw('UPDATE pricing_config SET data = data #- ?::text[] WHERE config_key = ?', [`{${path.join(',')}}`, row]);

  test('the migrated schema carries the five rows, and a worker that just started proves them', async () => {
    expect((await trx('pricing_config').whereIn('config_key', PRICE_ROWS).pluck('config_key')).sort()).toEqual([...PRICE_ROWS].sort());
    const worker = freshWorker();
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    await expect(refresh(worker)).resolves.toBe(true);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  test.each(PRICE_ROWS)('without the %s row the refresh still succeeds, and the answer is no', async (key) => {
    const worker = freshWorker();
    await refresh(worker);
    expect(await trx('pricing_config').where({ config_key: key }).del()).toBe(1);
    await expect(refresh(worker)).resolves.toBe(true);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  // One field of each row. A warm worker (it loaded the full rows first) and a worker that starts after the
  // change read the same rows and must give the same answer.
  test.each([
    ['pest_base', ['floor']],
    ['pest_features', ['near_water']],
    ['pest_property_type', ['duplex']],
    ['waveguard_tiers', ['gold', 'discount']],
    ['waveguard_tiers', ['silver', 'min_services']],
    ['waveguard_tiers', ['platinum']],
  ])('%s without %j: refused by a warm worker and by one that just started', async (row, path) => {
    const warm = freshWorker();
    await refresh(warm);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(true);
    expect((await dropField(row, path)).rowCount).toBe(1);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(false);

    const cold = freshWorker();
    await expect(refresh(cold)).resolves.toBe(true);
    expect(cold.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  test('a field saved as text is refused by both workers, though the refresh takes it', async () => {
    const warm = freshWorker();
    await refresh(warm);
    await trx.raw("UPDATE pricing_config SET data = jsonb_set(data, '{indoor}', to_jsonb((data->>'indoor')::text)) WHERE config_key = 'pest_features'");
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    const cold = freshWorker();
    await expect(refresh(cold)).resolves.toBe(true);
    expect(cold.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  // The optional field of the features row: left out by the schema. A row that carries it must carry a number.
  test('pest_features.attached_garage: a number counts, a boolean that the refresh takes does not (a warm worker and one that just started)', async () => {
    const setGarage = (json) => trx.raw("UPDATE pricing_config SET data = jsonb_set(data, '{attached_garage}', ?::jsonb) WHERE config_key = 'pest_features'", [json]);
    const warm = freshWorker();
    await refresh(warm);
    expect((await setGarage('7')).rowCount).toBe(1);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(true);

    await setGarage('true');
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.constants.PEST.additionalAdjustments.attachedGarage).toBe(Math.round(warm.constants.PROCESSING_ADJUSTMENT));
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    const cold = freshWorker();
    await expect(refresh(cold)).resolves.toBe(true);
    expect(cold.bridge.standardPestPriceRowsAreComplete()).toBe(false);
  });

  // min_services must be the count the engine's tier picker uses. The Pricing Logic route saves any whole number
  // of 1 or more, and the estimate converter reads the loaded one.
  test('waveguard_tiers.silver.min_services of 1: the refresh takes it, and a warm worker and one that just started refuse it', async () => {
    const setSilver = (count) => trx.raw("UPDATE pricing_config SET data = jsonb_set(data, '{silver,min_services}', ?::jsonb) WHERE config_key = 'waveguard_tiers'", [String(count)]);
    const warm = freshWorker();
    await refresh(warm);
    expect(warm.constants.WAVEGUARD.tiers.silver.minServices).toBe(2);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(true);
    expect((await setSilver(1)).rowCount).toBe(1);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.constants.WAVEGUARD.tiers.silver.minServices).toBe(1);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    const cold = freshWorker();
    await expect(refresh(cold)).resolves.toBe(true);
    expect(cold.bridge.standardPestPriceRowsAreComplete()).toBe(false);

    await setSilver(2);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  // The optional floor switch of the base row. The seeded row carries it as a boolean (the migration that
  // disarmed the floor wrote false).
  test('pest_base.enforce_floor_post_discount: a boolean counts, "true" saved as text is loaded as false and refused (a warm worker and one that just started)', async () => {
    const setSwitch = (json) => trx.raw("UPDATE pricing_config SET data = jsonb_set(data, '{enforce_floor_post_discount}', ?::jsonb) WHERE config_key = 'pest_base'", [json]);
    const warm = freshWorker();
    await refresh(warm);
    expect((await setSwitch('true')).rowCount).toBe(1);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.constants.PEST.enforceFloorPostDiscount).toBe(true);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(true);

    await setSwitch('"true"');
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.constants.PEST.enforceFloorPostDiscount).toBe(false);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(false);
    const cold = freshWorker();
    await expect(refresh(cold)).resolves.toBe(true);
    expect(cold.bridge.standardPestPriceRowsAreComplete()).toBe(false);

    await dropField('pest_base', ['enforce_floor_post_discount']);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.constants.PEST.enforceFloorPostDiscount).toBe(false);
    expect(warm.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });
});
