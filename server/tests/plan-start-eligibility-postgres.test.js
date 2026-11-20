// planStartBlocker against real PostgreSQL (one rolled-back transaction per test). The unit suite
// (plan-start-eligibility.test.js) pins the decisions on a fake that applies no filter. This one proves what only
// a database can: the SQL of each read on the real tables (the saved properties, the calendar read, the legacy
// plan visit, the ongoing series root, the billed plan rate, the plan hold, the two annual prepay reads), and
// that the account and property values the rules name are values the schema accepts. No network, no spend. All
// names and addresses are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// Every read must run on the handle the caller gives (here: the test's transaction). A caller inside a
// transaction sees its own writes, and no read leaves on another connection. So the app's own connection
// refuses every use in this suite.
jest.mock('../models/db', () => {
  const refuse = () => { throw new Error('a read used the app connection, not the handle the caller gave'); };
  return new Proxy(refuse, { get: (_target, key) => (typeof key === 'symbol' || key === 'then' || key === '__esModule' ? undefined : refuse) });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const NOW = new Date();
const PLAN_SERVICE = 'Quarterly Pest Control Service';
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
// The ET calendar day n days from today: the proof's own "today".
const day = (n) => etDateString(addETDays(NOW, n));

postgres('planStartBlocker (live Postgres)', () => {
  jest.setTimeout(90000);
  let database;
  let trx;
  let planStartBlocker;

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
    ({ planStartBlocker } = require('../services/plan-start-eligibility'));
  });

  afterAll(async () => {
    await database?.destroy();
  });

  beforeEach(async () => {
    trx = await database.transaction();
  });

  afterEach(async () => {
    await trx.rollback();
  });

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

  // A saved property of the account: by default the primary one, a home the owner lives in. The customers row
  // carries only a mirror of the primary property's type, and seedCustomer leaves that mirror empty.
  async function seedProperty(customer, change = {}) {
    const tag = hex(4);
    const [row] = await trx('customer_properties').insert({
      customer_id: customer.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true, property_type: 'single_family',
      address_line1: `${(parseInt(tag, 16) % 9000) + 100} Example Test Ct`, city: 'Parrish', state: 'FL', zip: '34219',
      address_key: `synthetic-${tag}`, source: 'manual', active: true, ...change,
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

  // An annual prepay term, with its invoice when `invoiceStatus` is given.
  async function seedPrepayTerm(customer, { invoiceStatus = null, ...change } = {}) {
    let invoiceId = null;
    if (invoiceStatus) {
      invoiceId = crypto.randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customer.id, status: invoiceStatus, subtotal: 480, total: 480,
        line_items: '[]', invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: crypto.randomUUID(),
      });
    }
    await trx('annual_prepay_terms').insert({
      id: crypto.randomUUID(), customer_id: customer.id, status: 'active', term_start: day(-30), term_end: day(335),
      prepay_amount: 480, plan_label: 'Synthetic Annual', prepay_invoice_id: invoiceId, ...change,
    });
  }

  const blockerFor = async (seed) => {
    const customer = await seedCustomer();
    await seed(customer);
    return planStartBlocker(trx, customer.id);
  };

  test('a live residential customer with no plan record: nothing stands against a new plan', async () => {
    expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
  });

  describe('the account', () => {
    test.each([
      ['an inactive account', { active: false }],
      ['a deleted account', { deleted_at: new Date() }],
      ['an inactive member', { active: false, waveguard_tier: 'Gold' }],
    ])('%s: not_live', async (_label, change) => {
      expect(await planStartBlocker(trx, (await seedCustomer(change)).id)).toBe('not_live');
    });

    test('an id that names no customer: not_live', async () => {
      expect(await planStartBlocker(trx, crypto.randomUUID())).toBe('not_live');
    });

    // The tier column accepts 'Commercial' (its check constraint), and the membership predicate reads that tier
    // as "no plan": without the rule this account would read as a home with no plan.
    test.each([
      ['the Commercial tier and no property type', { waveguard_tier: 'Commercial' }],
      ['the Commercial tier and a residential property type', { waveguard_tier: 'Commercial', property_type: 'single_family' }],
      ['a business property type', { property_type: 'business' }],
      ['a commercial property type', { property_type: 'commercial' }],
      ['an office', { property_type: 'office' }],
      // The two values the building-use check constraint takes. Only a won commercial proposal writes one.
      ['the building use of a business building', { building_use: 'nonresidential' }],
      ['the building use of a residential community', { building_use: 'residential', property_type: 'single_family' }],
    ])('%s: commercial', async (_label, change) => {
      expect(await planStartBlocker(trx, (await seedCustomer(change)).id)).toBe('commercial');
    });

    test.each([
      ['a tier', { waveguard_tier: 'Gold' }],
      ['a legacy monthly rate and no tier', { monthly_rate: 45 }],
      // The membership predicate reads the One-Time tier as "no plan" and then ignores the rate.
      ['a monthly rate beside the One-Time tier', { waveguard_tier: 'One-Time', monthly_rate: 45 }],
      // A billing lane only a plan has. The column's check constraint takes these values.
      ['the per-application lane, with no tier and no rate,', { billing_mode: 'per_application' }],
      ['the annual prepay lane, with no tier and no rate,', { billing_mode: 'annual_prepay' }],
      ['the monthly dues lane, with no tier and no rate,', { billing_mode: 'monthly_membership' }],
    ])('%s on the account: has_plan', async (_label, change) => {
      expect(await planStartBlocker(trx, (await seedCustomer(change)).id)).toBe('has_plan');
    });

    test.each([
      ['the One-Time tier', { waveguard_tier: 'One-Time' }],
      ['a monthly rate of zero', { monthly_rate: 0 }],
      ['the per-visit lane', { billing_mode: 'per_visit' }],
      ['the one-time lane', { billing_mode: 'one_time' }],
    ])('%s is not a plan record', async (_label, change) => {
      expect(await planStartBlocker(trx, (await seedCustomer(change)).id)).toBeNull();
    });
  });

  // The customers row mirrors only the TYPE of the primary property, and the mirror can be behind. A property's
  // occupancy is saved on the property alone. Every active property of the account counts.
  describe('a saved property of the account', () => {
    const SECOND = { is_primary: false };

    test.each([
      ['the primary property has the commercial occupancy', [{ occupancy_type: 'commercial' }]],
      ['the commercial occupancy, with no property type', [{ occupancy_type: 'commercial', property_type: null }]],
      ['the primary property has a commercial type', [{ property_type: 'commercial' }]],
      ['the primary property has a business type', [{ property_type: 'business' }]],
      ['a second property has the commercial occupancy, beside a home', [{}, { ...SECOND, occupancy_type: 'commercial' }]],
      ['a second property has a commercial type, beside a home', [{}, { ...SECOND, property_type: 'commercial' }]],
    ])('%s, on an account whose own row says nothing: commercial', async (_label, properties) => {
      const customer = await seedCustomer();
      for (const property of properties) await seedProperty(customer, property);
      expect(customer.property_type).toBeNull();
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    // Every occupancy the column's check constraint takes beside commercial.
    test.each([['owner_occupied'], ['family_occupied'], ['rental_investment'], ['seasonal'], ['vacant'], ['unknown']])(
      'a home with the occupancy %s is not commercial', async (occupancy_type) => {
        expect(await blockerFor((customer) => seedProperty(customer, { occupancy_type }))).toBeNull();
      });

    test('two homes on one account are not commercial', async () => {
      expect(await blockerFor(async (customer) => {
        await seedProperty(customer);
        await seedProperty(customer, { ...SECOND, occupancy_type: 'rental_investment', property_type: 'townhome' });
      })).toBeNull();
    });

    test('a commercial property that was removed from the account (not active) says nothing', async () => {
      expect(await blockerFor(async (customer) => {
        await seedProperty(customer);
        await seedProperty(customer, { ...SECOND, active: false, occupancy_type: 'commercial', property_type: 'commercial' });
      })).toBeNull();
    });

    test("another customer's commercial property says nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedProperty(customer);
      await seedProperty(other, { occupancy_type: 'commercial' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });

    test('a commercial property is the answer also for an account that holds a plan', async () => {
      const customer = await seedCustomer({ waveguard_tier: 'Gold' });
      await seedProperty(customer, { occupancy_type: 'commercial' });
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    test('an inactive account with a commercial property is not live', async () => {
      const customer = await seedCustomer({ active: false });
      await seedProperty(customer, { occupancy_type: 'commercial' });
      expect(await planStartBlocker(trx, customer.id)).toBe('not_live');
    });
  });

  describe('a visit that carries the recurring flag', () => {
    test.each([
      ['dated after today', {}],
      ['dated today', { scheduled_date: day(0) }],
      ['in progress now, with a date before today', { status: 'on_site', scheduled_date: day(-1) }],
    ])('%s: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => seedFlaggedVisit(customer, change))).toBe('has_plan');
    });

    test.each([
      // The $0 second visit of a one-time job rides the job, never a plan. No writer saves it with the flag.
      ['an included follow-up', { followup_included: true }],
      ['a free re-service callback', { is_callback: true }],
      ['booked from a one-time source', { source: 'estimate-accept' }],
      ['dated before today and not started', { scheduled_date: day(-1) }],
      ['cancelled', { status: 'cancelled' }],
      ['completed', { status: 'completed', scheduled_date: day(-1) }],
    ])('%s is not a live plan visit', async (_label, change) => {
      expect(await blockerFor((customer) => seedFlaggedVisit(customer, change))).toBeNull();
    });
  });

  describe('a legacy plan visit (no recurring flag, a recurring parent)', () => {
    test('the fixture alone is not a plan: a completed root with a cancelled child', async () => {
      expect(await blockerFor((customer) => seedLegacyVisit(customer, { status: 'cancelled' }))).toBeNull();
    });

    test.each([
      ['dated after today', {}],
      ['dated today', { scheduled_date: day(0) }],
      ['still pending', { status: 'pending' }],
      ['in progress now, with a date before today', { status: 'on_site', scheduled_date: day(-1) }],
      ['on the way now, with a date before today', { status: 'en_route', scheduled_date: day(-1) }],
    ])('%s: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => seedLegacyVisit(customer, change))).toBe('has_plan');
    });

    test.each([
      ['a free re-service callback', { is_callback: true }],
      ['an included follow-up', { followup_included: true }],
      ['dated before today and not started', { scheduled_date: day(-1) }],
      ['completed', { status: 'completed' }],
      ['skipped', { status: 'skipped' }],
      ['a no-show', { status: 'no_show' }],
      ['rescheduled away', { status: 'rescheduled' }],
      // An explicit booster rides a recurring root and is not a plan visit (isPlanSeriesRow).
      ['flagged not recurring (a booster)', { is_recurring: false }],
      ['booked from a one-time source', { source: 'estimate-accept' }],
      ['a one-time booking in progress now', { source: 'quote-wizard-onetime', status: 'on_site', scheduled_date: day(-1) }],
      ['a callback on the way now', { is_callback: true, status: 'en_route', scheduled_date: day(-1) }],
    ])('a child visit that is %s is not a live plan visit', async (_label, change) => {
      expect(await blockerFor((customer) => seedLegacyVisit(customer, change))).toBeNull();
    });

    test('a visit with no recurring flag and no recurring parent is not a plan visit', async () => {
      expect(await blockerFor((customer) => trx('scheduled_services').insert({
        customer_id: customer.id, scheduled_date: day(10), service_type: 'One-Time Pest Control', status: 'confirmed', is_recurring: null,
      }))).toBeNull();
    });

    test("another customer's legacy plan visit does not count", async () => {
      await seedLegacyVisit(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });
  });

  // An ongoing series BETWEEN visits: no live visit for the two calendar reads to find, and no tier, rate or
  // prepay on the account. The root alone says the plan goes on.
  describe('an ongoing recurring series with no visit on the calendar', () => {
    test.each([
      ['whose last visit is completed', {}],
      // Fail closed: a root that still says "ongoing" is a plan record whatever its own visit's status. Four
      // such roots of fully cancelled series were live on 2026-11-20 (the flag was never cleared).
      ['whose own visit was cancelled', { status: 'cancelled' }],
    ])('a series %s: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => seedSeriesRoot(customer, change))).toBe('has_plan');
    });

    test.each([
      ['a completed finite series (never ongoing)', { recurring_ongoing: false }],
      ['a series that a cancel ended (the flag is cleared)', { recurring_ongoing: false, status: 'cancelled' }],
      ['a series saved with no ongoing flag (NULL)', { recurring_ongoing: null }],
    ])('%s is not a plan record', async (_label, change) => {
      expect(await blockerFor((customer) => seedSeriesRoot(customer, change))).toBeNull();
    });

    test("another customer's ongoing series does not count", async () => {
      await seedSeriesRoot(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });

    test('the rows are the ones the nightly top-up would extend (its own selector)', async () => {
      const customer = await seedCustomer();
      const root = await seedSeriesRoot(customer);
      await seedSeriesRoot(customer, { recurring_ongoing: false });
      const { eligibleSeriesParentIds } = require('../services/recurring-series-topup');
      expect(await eligibleSeriesParentIds(trx, { customerId: customer.id })).toEqual([root.id]);
    });
  });

  describe('a billed plan rate (the plan-rate ledger)', () => {
    const rate = (customer, change = {}) => trx('customer_plan_rates').insert({
      customer_id: customer.id, family_key: 'lawn_care', monthly_rate: 55, source: 'estimate_accept', ...change,
    });

    test.each([
      ['of a named family', {}],
      ['the ledger could not name', { family_key: 'unattributed' }],
    ])('a rate %s, with no visit on the calendar: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => rate(customer, change))).toBe('has_plan');
    });

    test('a rate of zero is not a plan record', async () => {
      expect(await blockerFor((customer) => rate(customer, { monthly_rate: 0 }))).toBeNull();
    });

    test("another customer's rate does not count", async () => {
      await rate(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });
  });

  // A hold pauses a lawn, mosquito or tree and shrub plan (cancellation-resolution/holds.js). It sets the family's
  // ledger component and the account's monthly rate to 0 until the return date and skips the visits inside the
  // pause. So on some days the hold is the only record that says the plan goes on.
  describe('a plan hold', () => {
    const hold = (customer, change = {}) => trx('plan_holds').insert({
      customer_id: customer.id, family_key: 'lawn_care', starts_on: day(-5), resume_on: day(40), held_monthly_rate: 55, status: 'active', ...change,
    });

    test('an active hold, as the hold flow leaves the account (the ledger component at 0, no rate on the account): has_plan', async () => {
      expect(await blockerFor(async (customer) => {
        await trx('customer_plan_rates').insert({ customer_id: customer.id, family_key: 'lawn_care', monthly_rate: 0, source: 'plan_hold' });
        await hold(customer);
      })).toBe('has_plan');
    });

    test('an active hold whose return date has passed (not resumed yet): has_plan', async () => {
      expect(await blockerFor((customer) => hold(customer, { starts_on: day(-60), resume_on: day(-1) }))).toBe('has_plan');
    });

    // The three statuses the table's check constraint takes: active, resumed, cancelled.
    test.each([['resumed'], ['cancelled']])('a %s hold is over, and is not a plan record', async (status) => {
      expect(await blockerFor((customer) => hold(customer, { status }))).toBeNull();
    });

    test("another customer's hold does not count", async () => {
      await hold(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });
  });

  // The two annual prepay reads are the lifecycle guard's own (findActivePrepayTerm, findPendingPrepayInvoice).
  // Their rules have their own suites. Here: the proof calls each on the caller's connection, for this customer.
  describe('an annual prepay', () => {
    test.each([
      ['an active term that covers today', {}],
      ['a term waiting for payment whose invoice is still payable', { status: 'payment_pending', invoiceStatus: 'sent' }],
    ])('%s: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => seedPrepayTerm(customer, change))).toBe('has_plan');
    });

    test.each([
      ['an active term that ended', { term_start: day(-400), term_end: day(-35) }],
      ['a term waiting for payment whose invoice was voided', { status: 'payment_pending', invoiceStatus: 'void' }],
    ])('%s is not a plan record', async (_label, change) => {
      expect(await blockerFor((customer) => seedPrepayTerm(customer, change))).toBeNull();
    });

    test("another customer's term does not count", async () => {
      await seedPrepayTerm(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });
  });
});
