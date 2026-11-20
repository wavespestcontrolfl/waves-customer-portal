// buildStartOffer against real PostgreSQL (one rolled-back transaction per test): the price of the quarterly
// pest plan for a customer with NO plan (the one-time job to plan offer, owner 2026-11-19 "build"). The unit
// suite (portal-offer.test.js) pins the decisions on a fake that applies no filter. This one proves what only a
// database can: the SQL of the plan reads on the real table (the legacy plan visit, the ongoing series root),
// the real engine price on real tables, and the real bridge on real price settings rows. Only the property
// lookup is a stub (no network, no spend). All names and addresses are synthetic.
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
jest.mock('../routes/property-lookup-v2', () => ({ ...jest.requireActual('../routes/property-lookup-v2'), performPropertyLookup: jest.fn() }));

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const NOW = new Date();
const SAVED_LOOKUP = { enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} };
const PLAN_SERVICE = 'Quarterly Pest Control Service';
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
// The ET calendar day n days from today: the pricer's own "today".
const day = (n) => etDateString(addETDays(NOW, n));

postgres('plan start offer price (live Postgres)', () => {
  // The first test loads the pricing engine.
  jest.setTimeout(90000);
  let database;
  let trx;
  let CrossSell;
  let Lookup;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    CrossSell = require('../services/service-report/cross-sell');
    Lookup = require('../routes/property-lookup-v2');
  });

  afterAll(async () => {
    await database?.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    Lookup.performPropertyLookup.mockResolvedValue(SAVED_LOOKUP);
    trx = await database.transaction();
    mockConnection = trx;
  });

  afterEach(async () => {
    await trx.rollback();
  });

  // ---- Fixtures: the least each table needs. ----

  // A one-time customer: live, no tier, no plan rate.
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

  // A legacy plan visit: a child of a recurring root, saved with NO recurring flag. The root's own visit is over
  // (completed), so the calendar read (is_recurring = true, not over) finds nothing for this customer.
  async function seedLegacyVisit(customer, change = {}) {
    const [root] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-80), service_type: PLAN_SERVICE, status: 'completed', is_recurring: true,
    }).returning('id');
    const [visit] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(10), service_type: PLAN_SERVICE, status: 'confirmed',
      is_recurring: null, recurring_parent_id: root.id, ...change,
    }).returning('*');
    return visit;
  }

  // A visit that carries the recurring flag: the shape the calendar read asks for.
  async function seedFlaggedVisit(customer, change = {}) {
    const [visit] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(10), service_type: PLAN_SERVICE, status: 'confirmed', is_recurring: true, ...change,
    }).returning('*');
    return visit;
  }

  // The root of a recurring series with NO other visit: its own visit is over, and no later visit is on the
  // calendar. recurring_ongoing says whether the plan goes on (the nightly top-up extends such a series).
  async function seedSeriesRoot(customer, change = {}) {
    const [root] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-80), service_type: PLAN_SERVICE, status: 'completed',
      is_recurring: true, recurring_ongoing: true, ...change,
    }).returning('*');
    return root;
  }

  // The visit the offer follows: the customer's completed one-time job. It carries no address stamp and no link,
  // so the single-premises proof of the account decides (its strict form).
  async function seedJob(customer) {
    const [job] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-5), service_type: 'One-Time Pest Control', status: 'completed', is_recurring: false,
    }).returning('id');
    return job;
  }

  const price = async (customer) => CrossSell.buildStartOffer(customer.id, trx, 'pest_control', { visitId: (await seedJob(customer)).id });
  const PRICED = { reason: null, option: { id: 'pest-quarterly' } };
  const HAS_PLAN = { option: null, reason: 'has_plan' };

  test('a customer with no plan is priced by the real engine, from the live price settings, through a cache-only lookup with strict reads', async () => {
    const engine = require('../services/pricing-engine');
    const customer = await seedCustomer();
    // This process has loaded no price settings yet: the start offer must load them from the database, or refuse.
    expect(engine.needsSync()).toBe(true);
    const { option, reason } = await price(customer);
    expect(engine.needsSync()).toBe(false);
    expect(reason).toBeNull();
    expect(option.id).toBe('pest-quarterly');
    expect(option.perVisit).toBeGreaterThan(0);
    // The fee the offer removes: a customer with no plan is priced as new.
    expect(option.setupFee).toBeGreaterThan(0);
    // No paid lookup can run from here, and a failed cache or correction read is thrown, not read as a miss.
    expect(Lookup.performPropertyLookup).toHaveBeenCalled();
    for (const [, options] of Lookup.performPropertyLookup.mock.calls) {
      expect(options).toEqual({ cacheOnly: true, persist: false, strictCacheReads: true });
    }
  });

  test('the fixture alone is not a plan: the completed recurring root leaves the customer priced', async () => {
    const customer = await seedCustomer();
    await seedLegacyVisit(customer, { status: 'cancelled' });
    expect(await price(customer)).toMatchObject(PRICED);
  });

  test.each([
    ['dated after today', {}],
    ['dated today', { scheduled_date: day(0) }],
    ['still pending', { status: 'pending' }],
    ['in progress now, with a date before today', { status: 'on_site', scheduled_date: day(-1) }],
    ['on the way now, with a date before today', { status: 'en_route', scheduled_date: day(-1) }],
  ])('a legacy plan visit %s means the customer has a plan', async (_label, change) => {
    const customer = await seedCustomer();
    await seedLegacyVisit(customer, change);
    expect(await price(customer)).toEqual(HAS_PLAN);
  });

  test.each([
    ['a free re-service callback', { is_callback: true }],
    ['an included follow-up', { followup_included: true }],
    ['dated before today and not started', { scheduled_date: day(-1) }],
    ['cancelled', { status: 'cancelled' }],
    ['completed', { status: 'completed' }],
    ['skipped', { status: 'skipped' }],
    ['a no-show', { status: 'no_show' }],
    ['rescheduled away', { status: 'rescheduled' }],
    // An explicit booster rides a recurring root and is not a plan visit (isPlanSeriesRow).
    ['flagged not recurring (a booster)', { is_recurring: false }],
    // The calendar read's own exclusions (isLiveObligationRow), also for a visit in progress.
    ['booked from a one-time source', { source: 'estimate-accept' }],
    ['a one-time booking in progress now', { source: 'quote-wizard-onetime', status: 'on_site', scheduled_date: day(-1) }],
    ['a callback on the way now', { is_callback: true, status: 'en_route', scheduled_date: day(-1) }],
  ])('a child visit that is %s is not a live plan visit: the home is priced', async (_label, change) => {
    const customer = await seedCustomer();
    await seedLegacyVisit(customer, change);
    expect(await price(customer)).toMatchObject(PRICED);
  });

  // The calendar read's own shape. One row rule (isLiveObligationRow) judges it in the plan check and in the
  // pricer's ownership read, so each case below must hold in both.
  test('a visit that carries the recurring flag means the customer has a plan', async () => {
    const customer = await seedCustomer();
    await seedFlaggedVisit(customer);
    expect(await price(customer)).toEqual(HAS_PLAN);
  });

  test.each([
    // The $0 second visit of a one-time job rides the job, never a plan. No writer saves it with the flag.
    ['an included follow-up', { followup_included: true }],
    ['an included follow-up in progress now', { followup_included: true, status: 'on_site', scheduled_date: day(-1) }],
    ['a free re-service callback', { is_callback: true }],
    ['booked from a one-time source', { source: 'estimate-accept' }],
    ['dated before today and not started', { scheduled_date: day(-1) }],
  ])('a visit that carries the recurring flag and is %s is not a live plan visit: the home is priced', async (_label, change) => {
    const customer = await seedCustomer();
    await seedFlaggedVisit(customer, change);
    expect(await price(customer)).toMatchObject(PRICED);
  });

  test('a visit with no recurring flag and no recurring parent is not a plan visit', async () => {
    const customer = await seedCustomer();
    await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(10), service_type: 'One-Time Pest Control', status: 'confirmed', is_recurring: null,
    });
    expect(await price(customer)).toMatchObject(PRICED);
  });

  test("another customer's legacy plan visit does not count", async () => {
    const customer = await seedCustomer();
    await seedLegacyVisit(await seedCustomer());
    expect(await price(customer)).toMatchObject(PRICED);
  });

  test("a visit that is another customer's is refused: the offer follows this customer's own job", async () => {
    const customer = await seedCustomer();
    const other = await seedJob(await seedCustomer());
    expect(await CrossSell.buildStartOffer(customer.id, trx, 'pest_control', { visitId: other.id })).toEqual({ option: null, reason: 'premises' });
  });

  test('a billed plan rate with no visit on the calendar means the customer has a plan', async () => {
    const customer = await seedCustomer();
    await trx('customer_plan_rates').insert({ customer_id: customer.id, family_key: 'lawn_care', monthly_rate: 55, source: 'estimate_accept' });
    expect(await price(customer)).toEqual(HAS_PLAN);
  });

  // An ongoing series BETWEEN visits: no live visit for the two calendar reads to find, and no tier, rate or
  // prepay on the account. The root alone says the plan goes on.
  describe('an ongoing recurring series with no visit on the calendar', () => {
    test.each([
      ['whose last visit is completed', {}],
      ['whose own visit was cancelled while the series goes on', { status: 'cancelled' }],
    ])('a series %s means the customer has a plan', async (_label, change) => {
      const customer = await seedCustomer();
      await seedSeriesRoot(customer, change);
      expect(await price(customer)).toEqual(HAS_PLAN);
    });

    test.each([
      ['a completed finite series (never ongoing)', { recurring_ongoing: false }],
      ['a series that a cancel ended (the flag is cleared)', { recurring_ongoing: false, status: 'cancelled' }],
      ['a series saved with no ongoing flag (NULL)', { recurring_ongoing: null }],
    ])('%s is not a plan: the home is priced', async (_label, change) => {
      const customer = await seedCustomer();
      await seedSeriesRoot(customer, change);
      expect(await price(customer)).toMatchObject(PRICED);
    });

    test("another customer's ongoing series does not count", async () => {
      const customer = await seedCustomer();
      await seedSeriesRoot(await seedCustomer());
      expect(await price(customer)).toMatchObject(PRICED);
    });

    test('the rows are the ones the nightly top-up would extend (its own selector)', async () => {
      const customer = await seedCustomer();
      const root = await seedSeriesRoot(customer);
      await seedSeriesRoot(customer, { recurring_ongoing: false });
      const { eligibleSeriesParentIds } = require('../services/recurring-series-topup');
      expect(await eligibleSeriesParentIds(trx, { customerId: customer.id })).toEqual([root.id]);
    });
  });

  // The account-level commercial rule. The tier column accepts 'Commercial' (its check constraint), and the
  // plan check reads that tier as "no plan": without the rule this account would get the residential price.
  test.each([
    ['the Commercial tier and no property type', { waveguard_tier: 'Commercial' }],
    ['the Commercial tier and a residential property type', { waveguard_tier: 'Commercial', property_type: 'single_family' }],
    ['a business property type', { property_type: 'business' }],
  ])('a commercial account (%s) gets no residential offer', async (_label, change) => {
    const customer = await seedCustomer(change);
    expect(await price(customer)).toEqual({ option: null, reason: 'premises' });
  });

  // The REAL bridge on the REAL pricing_config. A refresh succeeds when the table holds any row at all, and for
  // a row that is missing the engine keeps what it had. The start offer prices only when every row of the
  // recurring pest price was applied by the last good refresh.
  describe('the price settings rows of the recurring pest price', () => {
    const PRICE_ROWS = ['pest_base', 'pest_footprint', 'pest_features', 'pest_property_type', 'waveguard_tiers'];
    const UNAVAILABLE = { code: 'PRICING_CONFIG_UNAVAILABLE' };
    const engine = () => require('../services/pricing-engine');
    const bridge = () => require('../services/pricing-engine/db-bridge');
    // Each test changes pricing_config inside its own transaction. The settings this process holds are marked
    // stale before and after, so every price here (and the first one of the next test) loads the rows it can see.
    beforeEach(() => engine().invalidatePricingConfigCache());
    afterEach(() => engine().invalidatePricingConfigCache());

    test('the migrated schema carries the five rows, and the start offer prices from them', async () => {
      expect((await trx('pricing_config').whereIn('config_key', PRICE_ROWS).pluck('config_key')).sort()).toEqual([...PRICE_ROWS].sort());
      const customer = await seedCustomer();
      expect(await price(customer)).toMatchObject(PRICED);
      expect(bridge().recurringPestPriceIsFromRows()).toBe(true);
    });

    test.each(PRICE_ROWS)('without the %s row the refresh still succeeds, and there is no start offer price', async (key) => {
      const customer = await seedCustomer();
      expect(await trx('pricing_config').where({ config_key: key }).del()).toBe(1);
      await expect(price(customer)).rejects.toMatchObject(UNAVAILABLE);
      // The refresh ran and succeeded: the settings read fresh. The missing row alone refused the price.
      expect(engine().needsSync()).toBe(false);
      expect(bridge().recurringPestPriceIsFromRows()).toBe(false);
      // Fresh settings are refused the same way (no second refresh needed to say no).
      await expect(price(customer)).rejects.toMatchObject(UNAVAILABLE);
    });

    test('a base row with no floor is not enough', async () => {
      const customer = await seedCustomer();
      await trx.raw("UPDATE pricing_config SET data = data - 'floor' WHERE config_key = 'pest_base'");
      await expect(price(customer)).rejects.toMatchObject(UNAVAILABLE);
    });

    // The hazard on a warm process, and the default that stays as it was for a price a person reads.
    test('after the base row is removed the engine still holds the earlier base price: the default pricer prices from it, the start offer refuses', async () => {
      const constants = require('../services/pricing-engine/constants');
      const pricer = require('../services/customer-pricing-ai');
      const customer = await seedCustomer();
      expect(await price(customer)).toMatchObject(PRICED);
      const base = constants.PEST.base;
      const [row] = await trx('pricing_config').where({ config_key: 'pest_base' }).select('*');

      await trx('pricing_config').where({ config_key: 'pest_base' }).del();
      engine().invalidatePricingConfigCache();
      const ask = (extra) => pricer.buildCustomerPricingResponse({
        customer, prompt: 'I am interested in adding pest control', db: trx, propertyLookup: async () => SAVED_LOOKUP, ...extra,
      });
      expect((await ask()).options.length).toBeGreaterThan(0);
      expect(constants.PEST.base).toBe(base);
      await expect(ask({ strictPriceSettings: true })).rejects.toMatchObject(UNAVAILABLE);
      await expect(price(customer)).rejects.toMatchObject(UNAVAILABLE);

      // The row is back: the next refresh proves it, and the price returns.
      await trx('pricing_config').insert({ ...row, data: JSON.stringify(row.data) });
      engine().invalidatePricingConfigCache();
      expect(await price(customer)).toMatchObject(PRICED);
      expect(bridge().recurringPestPriceIsFromRows()).toBe(true);
    });
  });
});
