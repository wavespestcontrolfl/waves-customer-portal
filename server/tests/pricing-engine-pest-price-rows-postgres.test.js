// recurringPestPriceIsFromRows and strictPriceSettings against real PostgreSQL (one rolled-back transaction per
// test): the REAL bridge on the REAL pricing_config rows of the migrated schema. The unit suite
// (pricing-engine-pest-price-rows.test.js) builds its rows by hand. This one proves what only the database can:
// the rows the migrations seed carry every required input of the recurring pest price, and a row that loses one
// is refused by a worker that just started and by a warm one. Only the property lookup is a stub (no network,
// no spend). The customer is synthetic.
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

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const PRICE_ROWS = ['pest_base', 'pest_footprint', 'pest_features', 'pest_property_type', 'waveguard_tiers'];
const SAVED_LOOKUP = { enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} };
const UNAVAILABLE = { code: 'PRICING_CONFIG_UNAVAILABLE' };
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

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
  // The pricer loads on first use, from the same registry.
  const freshWorker = () => {
    jest.resetModules();
    return {
      constants: require('../services/pricing-engine/constants'),
      bridge: require('../services/pricing-engine/db-bridge'),
      get pricer() { return require('../services/customer-pricing-ai'); },
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
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
    await expect(refresh(worker)).resolves.toBe(true);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
  });

  test.each(PRICE_ROWS)('without the %s row the refresh still succeeds, and the answer is no', async (key) => {
    const worker = freshWorker();
    await refresh(worker);
    expect(await trx('pricing_config').where({ config_key: key }).del()).toBe(1);
    await expect(refresh(worker)).resolves.toBe(true);
    expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(false);
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
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(true);
    expect((await dropField(row, path)).rowCount).toBe(1);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(false);

    const cold = freshWorker();
    await expect(refresh(cold)).resolves.toBe(true);
    expect(cold.bridge.recurringPestPriceIsFromRows()).toBe(false);
  });

  test('a field saved as text is refused by both workers, though the refresh takes it', async () => {
    const warm = freshWorker();
    await refresh(warm);
    await trx.raw("UPDATE pricing_config SET data = jsonb_set(data, '{indoor}', to_jsonb((data->>'indoor')::text)) WHERE config_key = 'pest_features'");
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(false);
    const cold = freshWorker();
    await expect(refresh(cold)).resolves.toBe(true);
    expect(cold.bridge.recurringPestPriceIsFromRows()).toBe(false);
  });

  // The optional field of the features row: left out by the schema. A row that carries it must carry a number.
  test('pest_features.attached_garage: a number counts, a boolean that the refresh takes does not (a warm worker and one that just started)', async () => {
    const setGarage = (json) => trx.raw("UPDATE pricing_config SET data = jsonb_set(data, '{attached_garage}', ?::jsonb) WHERE config_key = 'pest_features'", [json]);
    const warm = freshWorker();
    await refresh(warm);
    expect((await setGarage('7')).rowCount).toBe(1);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(true);

    await setGarage('true');
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.constants.PEST.additionalAdjustments.attachedGarage).toBe(Math.round(warm.constants.PROCESSING_ADJUSTMENT));
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(false);
    const cold = freshWorker();
    await expect(refresh(cold)).resolves.toBe(true);
    expect(cold.bridge.recurringPestPriceIsFromRows()).toBe(false);
  });

  // min_services must be the count the engine's tier picker uses. The Pricing Logic route saves any whole number
  // of 1 or more, and the estimate converter reads the loaded one.
  test('waveguard_tiers.silver.min_services of 1: the refresh takes it, and a warm worker and one that just started refuse it', async () => {
    const setSilver = (count) => trx.raw("UPDATE pricing_config SET data = jsonb_set(data, '{silver,min_services}', ?::jsonb) WHERE config_key = 'waveguard_tiers'", [String(count)]);
    const warm = freshWorker();
    await refresh(warm);
    expect(warm.constants.WAVEGUARD.tiers.silver.minServices).toBe(2);
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(true);
    expect((await setSilver(1)).rowCount).toBe(1);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.constants.WAVEGUARD.tiers.silver.minServices).toBe(1);
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(false);
    const cold = freshWorker();
    await expect(refresh(cold)).resolves.toBe(true);
    expect(cold.bridge.recurringPestPriceIsFromRows()).toBe(false);

    await setSilver(2);
    await expect(refresh(warm)).resolves.toBe(true);
    expect(warm.bridge.recurringPestPriceIsFromRows()).toBe(true);
  });

  // The pricer's strict option on the real rows. The default pricer is the one a person reads from: it still
  // prices from what the engine holds.
  describe('strictPriceSettings on the real rows', () => {
    const customer = () => ({
      id: crypto.randomUUID(), first_name: 'Jordan', last_name: 'Example', active: true,
      address_line1: `${(parseInt(hex(2), 16) % 9000) + 100} Example Test Ln`, city: 'Parrish', state: 'FL', zip: '34219',
      waveguard_tier: null, monthly_rate: null,
    });
    const ask = (worker, extra = {}) => worker.pricer.buildCustomerPricingResponse({
      customer: customer(), prompt: 'I am interested in adding pest control', db: trx, propertyLookup: async () => SAVED_LOOKUP, ...extra,
    });

    test('a worker that just started prices pest control from the seeded rows', async () => {
      const worker = freshWorker();
      const result = await ask(worker, { strictPriceSettings: true });
      expect(result.options.length).toBeGreaterThan(0);
      expect(result.options[0].serviceKey).toBe('pest_control');
      expect(worker.bridge.recurringPestPriceIsFromRows()).toBe(true);
    });

    test('after the base row is removed the engine still holds the earlier base price: the default prices from it, strict throws, and the row put back prices again', async () => {
      const worker = freshWorker();
      expect((await ask(worker, { strictPriceSettings: true })).options.length).toBeGreaterThan(0);
      const base = worker.constants.PEST.base;
      const [row] = await trx('pricing_config').where({ config_key: 'pest_base' }).select('*');

      await trx('pricing_config').where({ config_key: 'pest_base' }).del();
      worker.bridge.invalidatePricingConfigCache();
      expect((await ask(worker)).options.length).toBeGreaterThan(0);
      expect(worker.constants.PEST.base).toBe(base);
      // The refresh ran and succeeded: the settings read fresh. The missing row alone refuses the price.
      expect(worker.bridge.needsSync()).toBe(false);
      await expect(ask(worker, { strictPriceSettings: true })).rejects.toMatchObject(UNAVAILABLE);

      await trx('pricing_config').insert({ ...row, data: JSON.stringify(row.data) });
      worker.bridge.invalidatePricingConfigCache();
      expect((await ask(worker, { strictPriceSettings: true })).options.length).toBeGreaterThan(0);
    });

    // The loaded threshold says one service earns silver; the engine's picker counts by its own thresholds.
    test('a silver threshold of 1 in the row: the default quotes one pest service at bronze, strict throws', async () => {
      await trx.raw("UPDATE pricing_config SET data = jsonb_set(data, '{silver,min_services}', '1'::jsonb) WHERE config_key = 'waveguard_tiers'");
      const worker = freshWorker();
      const byDefault = await ask(worker);
      expect(worker.constants.WAVEGUARD.tiers.silver.minServices).toBe(1);
      expect(byDefault.options.length).toBeGreaterThan(0);
      expect(byDefault.options.map((option) => String(option.waveguardTier).toLowerCase())).toEqual(byDefault.options.map(() => 'bronze'));
      await expect(ask(worker, { strictPriceSettings: true })).rejects.toMatchObject(UNAVAILABLE);
      expect(worker.bridge.needsSync()).toBe(false);
    });

    // Strict is the price of pest control for a customer who has no other service. The real readers find the
    // visit: a qualifying service (the engine prices it too), an owned service that qualifies for no tier (the
    // engine would price the customer as one who has nothing), and a live recurring obligation that maps to no
    // service family. They also find the membership of an account with no visit on the calendar.
    test.each([
      ['a plan member with a live recurring lawn visit', { waveguard_tier: 'Bronze' }, 'Bi-Monthly Lawn Care Service', ['Lawn Care']],
      ['an account with no membership and a live recurring lawn visit', {}, 'Bi-Monthly Lawn Care Service', []],
      ['a plan member with a recurring palm injection', { waveguard_tier: 'Bronze' }, 'Palm Injection', []],
    ])('%s who asks for pest control alone: the default prices it, strict refuses the customer', async (_label, account, serviceType, currentServices) => {
      const worker = freshWorker();
      const tag = hex(4);
      const [seeded] = await trx('customers').insert({
        first_name: 'Jordan', last_name: 'Example', email: `jordan.${tag}@example.test`,
        phone: `+1941${String(parseInt(tag, 16) % 10000000).padStart(7, '0')}`,
        address_line1: `${(parseInt(tag, 16) % 9000) + 100} Example Test Ln`, city: 'Parrish', state: 'FL', zip: '34219',
        active: true, pipeline_stage: 'won', ...account,
      }).returning('*');
      await trx('scheduled_services').insert({
        customer_id: seeded.id, scheduled_date: etDateString(addETDays(new Date(), 10)), service_type: serviceType,
        status: 'confirmed', is_recurring: true,
      });
      const askFor = (extra = {}) => worker.pricer.buildCustomerPricingResponse({
        customer: seeded, prompt: 'I am interested in adding pest control', db: trx, propertyLookup: async () => SAVED_LOOKUP, ...extra,
      });

      const result = await askFor();
      expect(result.currentServices).toEqual(currentServices);
      expect(result.options.length).toBeGreaterThan(0);
      await expect(askFor({ strictPriceSettings: true })).rejects.toMatchObject({ code: 'STRICT_PRICE_OTHER_SERVICE' });

      // Without the visit: a plan member is still refused (the account has a plan service, none on the
      // calendar), and an account with no membership is priced.
      await trx('scheduled_services').where({ customer_id: seeded.id }).del();
      if (account.waveguard_tier) {
        expect((await askFor()).options.length).toBeGreaterThan(0);
        await expect(askFor({ strictPriceSettings: true })).rejects.toMatchObject({ code: 'STRICT_PRICE_OTHER_SERVICE' });
        await trx('customers').where({ id: seeded.id }).update({ waveguard_tier: null });
      }
      expect((await askFor({ strictPriceSettings: true })).options.length).toBeGreaterThan(0);
    });

    test('a worker that starts after a property type lost its value throws too', async () => {
      await dropField('pest_property_type', ['duplex']);
      const worker = freshWorker();
      await expect(ask(worker, { strictPriceSettings: true })).rejects.toMatchObject(UNAVAILABLE);
      expect(worker.bridge.needsSync()).toBe(false);
      expect((await ask(worker)).options.length).toBeGreaterThan(0);
    });
  });
});
