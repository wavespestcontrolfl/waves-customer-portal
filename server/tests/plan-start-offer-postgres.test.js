// buildStartOffer against real PostgreSQL (one rolled-back transaction per test): the price of the quarterly
// pest plan for a customer with NO plan (the one-time job to plan offer, owner 2026-11-19 "build"). The unit
// suite (portal-offer.test.js) pins the decisions on a fake that applies no filter. This one proves what only a
// database can: the SQL of the legacy plan-visit read on the real table, and the real engine price on real
// tables. Only the property lookup is a stub (no network, no spend). All names and addresses are synthetic.
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
  async function seedCustomer() {
    const tag = hex(4);
    const [row] = await trx('customers').insert({
      first_name: 'Jordan', last_name: 'Example', email: `jordan.${tag}@example.test`,
      phone: `+1941${String(parseInt(tag, 16) % 10000000).padStart(7, '0')}`,
      address_line1: `${(parseInt(tag, 16) % 9000) + 100} Example Test Ln`, city: 'Parrish', state: 'FL', zip: '34219',
      active: true, pipeline_stage: 'won',
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
});
