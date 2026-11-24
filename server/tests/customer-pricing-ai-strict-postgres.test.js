// strictPriceSettings of the customer pricer against real PostgreSQL (one rolled-back transaction per test). The
// unit suite (customer-pricing-ai.test.js) puts a spy in place of the bridge and of the shared answer. This one
// runs the REAL pricer, the REAL bridge on the pricing_config rows of the migrated schema, and the REAL
// planStartBlocker on real account rows. It proves what only the database can: a one-time customer is priced
// from the seeded rows, a row that another server process changed is read again, a row that loses a value
// refuses the price while the default still answers, callers that overlap are all priced, and an account that
// is not live, is a business or holds a plan is refused by the shared answer.
// No network, no spend. All names and addresses are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// The app's own connection. A strict price loads the price settings there, in the bridge's own refresh (committed
// rows in production, never the caller's transaction). In this suite that connection answers from the test's
// transaction, and only for the tables a refresh reads, so a test can change a row and roll it back. Every
// other read of a strict price must run on the handle the caller gives: any other use of the connection throws.
let mockSettingsHandle = null;
const mockSettingsTables = ['pricing_config', 'lawn_pricing_brackets', 'services', 'products_catalog', 'vendor_pricing'];
jest.mock('../models/db', () => {
  const refuse = (what) => { throw new Error(`a read of ${what} used the app connection, not the handle the caller gave`); };
  const read = (table, ...rest) => (mockSettingsTables.includes(String(table).trim().split(/\s+/)[0])
    ? mockSettingsHandle(table, ...rest)
    : refuse(table));
  return new Proxy(read, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then' || key === '__esModule') return undefined;
      if (key === 'schema') return mockSettingsHandle.schema;
      return () => refuse(String(key));
    },
  });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const SAVED_LOOKUP = { enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} };
const UNAVAILABLE = { code: 'PRICING_CONFIG_UNAVAILABLE' };
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

postgres('strictPriceSettings of the customer pricer (live Postgres)', () => {
  // The first test loads the pricing engine.
  jest.setTimeout(90000);
  let database;
  let trx;
  // What a caller passes as `db`. Strict refuses a transaction (a test below), so the suite passes a handle
  // that is none and reads through the test's transaction: every read still rolls back with the test.
  let handle;
  let logSpy;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's: the managed runner sets both marks and names
    // the database after the worktree id (scripts/dev/context.js, scripts/qa/server.js). Or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter of a connection string into its settings, so ?host=, ?port= or
    // ?connectionString= would name another server than the one checked above. A URL with a query is refused,
    // and the pool gets the parts this guard read, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  beforeEach(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    trx = await database.transaction();
    mockSettingsHandle = trx;
    handle = new Proxy(trx, { get: (target, key, receiver) => (key === 'isTransaction' ? false : Reflect.get(target, key, receiver)) });
  });

  afterEach(async () => {
    mockSettingsHandle = null;
    await trx.rollback();
    logSpy.mockRestore();
  });

  // A worker that just started: its own module registry, so pristine constants and a bridge that has not synced.
  const freshWorker = () => {
    jest.resetModules();
    return {
      constants: require('../services/pricing-engine/constants'),
      bridge: require('../services/pricing-engine/db-bridge'),
      pricer: require('../services/customer-pricing-ai'),
    };
  };

  // A one-time customer: live, residential, no tier, no plan rate.
  async function seedCustomer(change = {}) {
    const tag = hex(4);
    const [row] = await trx('customers').insert({
      first_name: 'Jordan', last_name: 'Example', email: `jordan.${tag}@example.test`,
      phone: `+1941${String(parseInt(tag, 16) % 10000000).padStart(7, '0')}`,
      address_line1: `${(parseInt(tag, 16) % 9000) + 100} Example Test Ln`, city: 'Parrish', state: 'FL', zip: '34219',
      active: true, pipeline_stage: 'won', ...change,
    }).returning('*');
    return row;
  }
  const seedRecurringVisit = (customer, serviceType) => trx('scheduled_services').insert({
    customer_id: customer.id, scheduled_date: etDateString(addETDays(new Date(), 10)), service_type: serviceType,
    status: 'confirmed', is_recurring: true,
  });
  const ask = (worker, customer, extra = {}) => worker.pricer.buildCustomerPricingResponse({
    customer, prompt: 'I am interested in adding pest control', db: handle, propertyLookup: async () => SAVED_LOOKUP, ...extra,
  });
  const strict = (worker, customer) => ask(worker, customer, { strictPriceSettings: true });
  const expectPriced = (result) => {
    expect(result.options.length).toBeGreaterThan(0);
    expect(result.options.every((option) => option.serviceKey === 'pest_control')).toBe(true);
  };

  test('a worker that just started prices pest control for a one-time customer, from the seeded rows', async () => {
    const worker = freshWorker();
    const result = await strict(worker, await seedCustomer());
    expectPriced(result);
    expect(result.currentServices).toEqual([]);
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
    expect(worker.bridge.needsSync()).toBe(false);
  });

  // A strict caller waits in the bridge's queue for a read on the app's connection. With a transaction open it
  // would keep a connection of that pool while it waits.
  test('a real transaction as the handle is refused before any read; the default prices on it as before', async () => {
    const worker = freshWorker();
    const customer = await seedCustomer();
    expect(trx.isTransaction).toBe(true);
    await expect(ask(worker, customer, { db: trx, strictPriceSettings: true })).rejects.toThrow('strictPriceSettings needs a database handle that is not a transaction');
    expect(worker.bridge.needsSync()).toBe(true);
    expectPriced(await ask(worker, customer, { db: trx }));
  });

  // The bridge keeps the shared settings for a minute, and an edit marks them stale only in the process that
  // made it. Here the row changes with no word to this worker's bridge, as an edit that another server process
  // made. Strict loads the settings for its own call.
  test('a base price that another server process changed: the default answers the earlier price while the settings read fresh, strict loads the row again', async () => {
    const worker = freshWorker();
    const customer = await seedCustomer();
    const before = await strict(worker, customer);
    expectPriced(before);
    const base = worker.constants.PEST.base;

    await trx.raw("UPDATE pricing_config SET data = jsonb_set(data, '{base}', to_jsonb((data->>'base')::numeric + 50)) WHERE config_key = ?", ['pest_base']);
    expect(worker.bridge.needsSync()).toBe(false);
    const early = await ask(worker, customer);
    expect(worker.constants.PEST.base).toBe(base);
    expect(early.options.map((option) => option.monthly)).toEqual(before.options.map((option) => option.monthly));

    const after = await strict(worker, customer);
    expect(worker.constants.PEST.base).toBeCloseTo(base + 50, 2);
    expect(after.options.map((option) => option.id)).toEqual(before.options.map((option) => option.id));
    after.options.forEach((option, index) => expect(option.monthly).toBeGreaterThan(before.options[index].monthly));
  });

  // Each strict call is one operation in the bridge's queue: its own refresh, then its engine calls. So calls that
  // overlap wait for one another, and none of them makes another fail.
  test('strict prices asked at the same moment, on settings that do not change, are all priced and all the same', async () => {
    const worker = freshWorker();
    const customer = await seedCustomer();
    const results = await Promise.all([strict(worker, customer), strict(worker, customer), strict(worker, customer), strict(worker, customer)]);
    results.forEach(expectPriced);
    const monthly = (result) => result.options.map((option) => option.monthly);
    results.forEach((result) => expect(monthly(result)).toEqual(monthly(results[0])));
    // And a default price asked beside strict ones is priced as before.
    const mixed = await Promise.all([strict(worker, customer), ask(worker, customer), strict(worker, customer)]);
    mixed.forEach(expectPriced);
  });

  test('after the base row is removed the engine still holds the earlier base price: the default prices from it, strict throws, and the row put back prices again', async () => {
    const worker = freshWorker();
    const customer = await seedCustomer();
    expectPriced(await strict(worker, customer));
    const base = worker.constants.PEST.base;
    const [row] = await trx('pricing_config').where({ config_key: 'pest_base' }).select('*');

    await trx('pricing_config').where({ config_key: 'pest_base' }).del();
    worker.bridge.invalidatePricingConfigCache();
    expectPriced(await ask(worker, customer));
    expect(worker.constants.PEST.base).toBe(base);
    // The refresh ran and succeeded: the settings read fresh. The missing row alone refuses the price.
    expect(worker.bridge.needsSync()).toBe(false);
    await expect(strict(worker, customer)).rejects.toMatchObject(UNAVAILABLE);

    await trx('pricing_config').insert({ ...row, data: JSON.stringify(row.data) });
    worker.bridge.invalidatePricingConfigCache();
    expectPriced(await strict(worker, customer));
  });

  test('a worker that starts after a property type lost its value throws, and the default prices', async () => {
    await trx.raw('UPDATE pricing_config SET data = data #- ?::text[] WHERE config_key = ?', ['{duplex}', 'pest_property_type']);
    const worker = freshWorker();
    const customer = await seedCustomer();
    await expect(strict(worker, customer)).rejects.toMatchObject(UNAVAILABLE);
    expect(worker.bridge.needsSync()).toBe(false);
    expectPriced(await ask(worker, customer));
  });

  // The shared answer on real rows. The default pricer asks no such question (the unit suite proves it).
  describe('an account that may not start a plan', () => {
    test.each([
      ['an inactive account', { active: false }, null, 'not_live'],
      ['a business by the property type of the account', { property_type: 'commercial' }, null, 'commercial'],
      ['a plan member with no visit on the calendar', { waveguard_tier: 'Bronze' }, null, 'has_plan'],
      ['an account with no membership and a live recurring lawn visit', {}, 'Bi-Monthly Lawn Care Service', 'has_plan'],
      ['an account with no membership and a recurring palm injection', {}, 'Palm Injection', 'has_plan'],
    ])('%s: strict refuses the account, with the reason', async (_label, account, serviceType, reason) => {
      const worker = freshWorker();
      const customer = await seedCustomer(account);
      if (serviceType) await seedRecurringVisit(customer, serviceType);
      const propertyLookup = jest.fn(async () => SAVED_LOOKUP);
      await expect(ask(worker, customer, { strictPriceSettings: true, propertyLookup })).rejects.toMatchObject({ code: 'PLAN_START_BLOCKED', blocker: reason });
      expect(propertyLookup).not.toHaveBeenCalled();
    });

    // The shared answer reads the account's records and clears this one. The lookup then names a business: the
    // engine would price it by its commercial rules, so strict refuses it before the refresh.
    test('an account with no property type that the lookup resolves as a business: strict refuses it as a business', async () => {
      const worker = freshWorker();
      const customer = await seedCustomer();
      const propertyLookup = jest.fn(async () => ({ enriched: { ...SAVED_LOOKUP.enriched, propertyType: 'commercial', aiConfidence: 85 }, propertyRecord: {} }));
      await expect(ask(worker, customer, { strictPriceSettings: true, propertyLookup })).rejects.toMatchObject({ code: 'PLAN_START_BLOCKED', blocker: 'commercial' });
      expect(propertyLookup).toHaveBeenCalledTimes(1);
      // No refresh ran on this worker.
      expect(worker.bridge.needsSync()).toBe(true);
    });

    // The engine's rule reads a condo as a home. The shared answer reads the condo of a property manager as a
    // business: the same type saved on the account row refuses it (the first test). Here no saved record
    // carries the type; only the lookup names it.
    describe('a condo that only the lookup names', () => {
      const condoLookup = () => jest.fn(async () => ({ enriched: { ...SAVED_LOOKUP.enriched, propertyType: 'condo_ground', aiConfidence: 85 }, propertyRecord: {} }));
      const refusedAsBusiness = async (worker, customer) => {
        const propertyLookup = condoLookup();
        await expect(ask(worker, customer, { strictPriceSettings: true, propertyLookup })).rejects.toMatchObject({ code: 'PLAN_START_BLOCKED', blocker: 'commercial' });
        expect(propertyLookup).toHaveBeenCalledTimes(1);
        // No refresh ran on this worker.
        expect(worker.bridge.needsSync()).toBe(true);
      };

      test('the same condo saved on the account of a property manager is refused before the lookup', async () => {
        const worker = freshWorker();
        const customer = await seedCustomer({ contact_role: 'property_manager', property_type: 'condo_ground' });
        const propertyLookup = condoLookup();
        await expect(ask(worker, customer, { strictPriceSettings: true, propertyLookup })).rejects.toMatchObject({ code: 'PLAN_START_BLOCKED', blocker: 'commercial' });
        expect(propertyLookup).not.toHaveBeenCalled();
      });

      test('on the account of a property manager: strict refuses it as a business, and the default prices it as a home', async () => {
        const worker = freshWorker();
        const customer = await seedCustomer({ contact_role: 'property_manager' });
        await refusedAsBusiness(worker, customer);
        expectPriced(await ask(worker, customer, { propertyLookup: condoLookup() }));
      });

      test('on an account with a saved property it manages for a client: strict refuses it as a business', async () => {
        const worker = freshWorker();
        const customer = await seedCustomer();
        await trx('customer_properties').insert({ customer_id: customer.id, relationship: 'managed_for_client' });
        await refusedAsBusiness(worker, customer);
      });

      test('on the account of its owner, with a home of their own saved: strict prices it', async () => {
        const worker = freshWorker();
        const customer = await seedCustomer({ contact_role: 'owner' });
        await trx('customer_properties').insert({ customer_id: customer.id, relationship: 'own_home' });
        expectPriced(await ask(worker, customer, { strictPriceSettings: true, propertyLookup: condoLookup() }));
      });
    });

    test('the account is priced once the visit that blocked it is gone', async () => {
      const worker = freshWorker();
      const customer = await seedCustomer();
      await seedRecurringVisit(customer, 'Bi-Monthly Lawn Care Service');
      await expect(strict(worker, customer)).rejects.toMatchObject({ code: 'PLAN_START_BLOCKED', blocker: 'has_plan' });
      await trx('scheduled_services').where({ customer_id: customer.id }).del();
      expectPriced(await strict(worker, customer));
    });
  });
});
