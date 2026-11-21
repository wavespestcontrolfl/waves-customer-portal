// buildStartOffer against real PostgreSQL (one rolled-back transaction per test): the price of the standard pest
// plan for a one-time customer (the one-time job to plan offer, owner 2026-11-19 "build"). The unit suite
// (portal-offer.test.js) puts spies in place of the shared proof and of the bridge. This one runs the whole chain
// for real: the premises proofs on real rows, the REAL pricer on its strict option, the REAL planStartBlocker,
// the REAL bridge on the pricing_config rows of the migrated schema, and the REAL read of the staff corrections.
// Only the property lookup is a stub (no network, no spend). All names and addresses are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// The app's own connection. A strict price loads the price settings there, in the bridge's own refresh, and the
// staff-correction probe reads the lookup cache there. In this suite that connection answers from the test's
// transaction, and only for those tables, so a test can change a row and roll it back. Every other read of a
// start offer must run on the handle the caller gives: any other use of the connection throws.
let mockAppHandle = null;
const mockAppTables = ['pricing_config', 'lawn_pricing_brackets', 'services', 'products_catalog', 'vendor_pricing', 'property_lookups'];
jest.mock('../models/db', () => {
  const refuse = (what) => { throw new Error(`a read of ${what} used the app connection, not the handle the caller gave`); };
  const read = (table, ...rest) => (mockAppTables.includes(String(table).trim().split(/\s+/)[0])
    ? mockAppHandle(table, ...rest)
    : refuse(table));
  return new Proxy(read, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then' || key === '__esModule') return undefined;
      if (key === 'schema') return mockAppHandle.schema;
      return () => refuse(String(key));
    },
  });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const SAVED_LOOKUP = { enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} };
const PRICED = { reason: null, option: { id: 'pest-quarterly' } };
const refused = (reason) => ({ option: null, reason });
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
// The ET calendar day n days from today: the app's own "today".
const day = (n) => etDateString(addETDays(new Date(), n));

postgres('plan start offer price (live Postgres)', () => {
  // The first test loads the pricing engine.
  jest.setTimeout(90000);
  let database;
  let trx;
  // What a caller passes as `database`. The pricer's strict option refuses a transaction (a test below), so the
  // suite passes a handle that is none and reads through the test's transaction: every read rolls back.
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
    mockAppHandle = trx;
    handle = new Proxy(trx, { get: (target, key, receiver) => (key === 'isTransaction' ? false : Reflect.get(target, key, receiver)) });
  });

  afterEach(async () => {
    mockAppHandle = null;
    await trx.rollback();
    logSpy.mockRestore();
  });

  // A worker that just started: its own module registry, so a bridge that has not loaded the price settings.
  const freshWorker = () => {
    jest.resetModules();
    return {
      offer: require('../services/service-report/cross-sell'),
      bridge: require('../services/pricing-engine/db-bridge'),
      pricer: require('../services/customer-pricing-ai'),
      cache: require('../services/property-lookup/lookup-cache'),
    };
  };

  // ---- Fixtures: the least each table needs. ----

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
  // The visit the offer follows: the customer's completed one-time job. Bare, it carries no address stamp and no
  // link, so the single-premises proof of the account decides (its strict form).
  async function seedJob(customer, change = {}) {
    const [job] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-5), service_type: 'One-Time Pest Control', status: 'completed',
      is_recurring: false, ...change,
    }).returning('id');
    return job;
  }
  const seedRecurringVisit = (customer, serviceType) => trx('scheduled_services').insert({
    customer_id: customer.id, scheduled_date: day(10), service_type: serviceType, status: 'confirmed', is_recurring: true,
  });
  // An accepted estimate at the customer's home, with the measurements it was priced on (the estimate seed).
  const seedAcceptedEstimate = (customer) => trx('estimates').insert({
    customer_id: customer.id, token: `test-${hex(16)}`, status: 'accepted',
    address: `${customer.address_line1}, ${customer.city}, ${customer.state} ${customer.zip}`,
    estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
  });
  const savedLookup = async () => SAVED_LOOKUP;
  const missLookup = async () => null;
  const price = (worker, customer, job, options = {}) => worker.offer.buildStartOffer(customer.id, handle, 'pest_control', {
    visitId: job.id, propertyLookup: savedLookup, ...options,
  });
  const priceJobOf = async (worker, customer, options) => price(worker, customer, await seedJob(customer), options);

  test('a one-time customer is priced from the seeded rows: the standard pest plan, with the fee of a new plan', async () => {
    const worker = freshWorker();
    const answer = await priceJobOf(worker, await seedCustomer());
    expect(answer).toMatchObject(PRICED);
    expect(answer.option.perVisit).toBeGreaterThan(0);
    expect(answer.option.setupFee).toBeGreaterThan(0);
    // The bridge loaded the price settings for this call, and the rows of the pest price are complete.
    expect(worker.bridge.standardPestPriceRowsAreComplete()).toBe(true);
  });

  // The pricer asks the shared proof on real rows, and this function answers the job's reason.
  describe('an account that may not start a plan', () => {
    test.each([
      ['a plan member with no visit on the calendar', { waveguard_tier: 'Bronze' }, null, 'has_plan'],
      ['an account with no membership and a live recurring lawn visit', {}, 'Bi-Monthly Lawn Care Service', 'has_plan'],
      ['an account with no membership and a recurring palm injection', {}, 'Palm Injection', 'has_plan'],
      ['a business by the building use of the account', { building_use: 'nonresidential' }, null, 'premises'],
    ])('%s: no price, with the reason', async (_label, account, serviceType, reason) => {
      const worker = freshWorker();
      const customer = await seedCustomer(account);
      if (serviceType) await seedRecurringVisit(customer, serviceType);
      const propertyLookup = jest.fn(savedLookup);
      expect(await priceJobOf(worker, customer, { propertyLookup })).toEqual(refused(reason));
      // The proof refused the account before the lookup and before any refresh of the price settings.
      expect(propertyLookup).not.toHaveBeenCalled();
      expect(worker.bridge.needsSync()).toBe(true);
    });

    test('an account that the lookup resolves as a business: no price, reason premises', async () => {
      const worker = freshWorker();
      const propertyLookup = async () => ({ enriched: { ...SAVED_LOOKUP.enriched, propertyType: 'commercial', aiConfidence: 85 }, propertyRecord: {} });
      expect(await priceJobOf(worker, await seedCustomer(), { propertyLookup })).toEqual(refused('premises'));
    });

    test('the account is priced once the visit that blocked it is gone', async () => {
      const worker = freshWorker();
      const customer = await seedCustomer();
      const job = await seedJob(customer);
      const [visit] = await seedRecurringVisit(customer, 'Bi-Monthly Lawn Care Service').returning('id');
      expect(await price(worker, customer, job)).toEqual(refused('has_plan'));
      await trx('scheduled_services').where({ id: visit.id }).del();
      expect(await price(worker, customer, job)).toMatchObject(PRICED);
    });
  });

  describe('the visit the offer follows', () => {
    test("another customer's job is refused: the offer follows this customer's own job", async () => {
      const worker = freshWorker();
      const customer = await seedCustomer();
      const other = await seedCustomer();
      expect(await price(worker, customer, await seedJob(other))).toEqual(refused('premises'));
    });

    test('a job stamped at the home is priced, and a job stamped at another address is refused', async () => {
      const worker = freshWorker();
      const customer = await seedCustomer();
      const atHome = await seedJob(customer, {
        service_address_line1: customer.address_line1, service_address_city: customer.city, service_address_zip: customer.zip,
      });
      expect(await price(worker, customer, atHome)).toMatchObject(PRICED);
      const elsewhere = await seedJob(customer, {
        service_address_line1: '9 Other Example Ct', service_address_city: 'Venice', service_address_zip: '34285',
      });
      expect(await price(worker, customer, elsewhere)).toEqual(refused('premises'));
      // The second address also makes the account a two-premises one: the first job is no longer priced.
      expect(await price(worker, customer, atHome)).toEqual(refused('premises'));
    });
  });

  // A strict price waits in the bridge's queue for a read on the app's connection. With a transaction open the
  // caller would keep a connection of that pool while it waits.
  test('a real transaction as the database is refused, never priced', async () => {
    const worker = freshWorker();
    const customer = await seedCustomer();
    const job = await seedJob(customer);
    expect(trx.isTransaction).toBe(true);
    await expect(worker.offer.buildStartOffer(customer.id, trx, 'pest_control', { visitId: job.id, propertyLookup: savedLookup }))
      .rejects.toThrow('strictPriceSettings needs a database handle that is not a transaction');
  });

  test('without the base row of the pest price the start offer throws, and the row put back prices again', async () => {
    const worker = freshWorker();
    const customer = await seedCustomer();
    const job = await seedJob(customer);
    expect(await price(worker, customer, job)).toMatchObject(PRICED);
    const [row] = await trx('pricing_config').where({ config_key: 'pest_base' }).select('*');

    await trx('pricing_config').where({ config_key: 'pest_base' }).del();
    await expect(price(worker, customer, job)).rejects.toMatchObject({ code: 'PRICING_CONFIG_UNAVAILABLE' });

    await trx('pricing_config').insert({ ...row, data: JSON.stringify(row.data) });
    expect(await price(worker, customer, job)).toMatchObject(PRICED);
  });

  // The lookup missed, so the measurements come from the accepted estimate. A staff correction of a measurement
  // may be on file for the address, and the lookup that would apply it did not run. The pricer's strict option
  // does not ask; the pricing stage this function calls does, on the real cache table.
  describe('a home priced from its accepted estimate (the lookup missed)', () => {
    const seedCacheRow = (worker, customer, overrides) => {
      const { hash, normalizedAddress } = worker.cache.addressKey(worker.pricer.addressForCustomer(customer));
      return trx('property_lookups').insert({ address_hash: hash, normalized_address: normalizedAddress, verified_overrides: JSON.stringify(overrides) });
    };
    const seeded = async () => {
      const customer = await seedCustomer();
      await seedAcceptedEstimate(customer);
      return customer;
    };

    test('with no estimate there is no price', async () => {
      const worker = freshWorker();
      expect(await priceJobOf(worker, await seedCustomer(), { propertyLookup: missLookup })).toEqual(refused('not_priced'));
    });

    test.each([
      ['no cache row for the address', null],
      ['a cache row with no correction', {}],
    ])('%s: priced', async (_label, overrides) => {
      const worker = freshWorker();
      const customer = await seeded();
      if (overrides) await seedCacheRow(worker, customer, overrides);
      expect(await priceJobOf(worker, customer, { propertyLookup: missLookup })).toMatchObject(PRICED);
    });

    test('a staff correction on file for the address: no price', async () => {
      const worker = freshWorker();
      const customer = await seeded();
      await seedCacheRow(worker, customer, { stories: { value: 2, verifiedBy: 'tech', verifiedAt: new Date().toISOString() } });
      expect(await priceJobOf(worker, customer, { propertyLookup: missLookup })).toEqual(refused('not_priced'));
    });
  });
});
