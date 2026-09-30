/**
 * B10, real PostgreSQL: which collections_flags rows stop money, how the hold
 * is written and released, and that the hold writer never waits on a charge.
 *
 *   - ONLY dispute holds stop charges (reason starts with "dispute"):
 *     placeDisputeHold's strings, and rows written before this change, stop
 *     them; the wrong-number / wrong-party collection_hold fallbacks do not.
 *   - A dispute raised while such a fallback row is active (the partial
 *     unique index allows ONE active row per customer+flag) upgrades that row
 *     instead of being swallowed as "already active".
 *   - releaseFlag stamps released_at and charging resumes.
 *   - The hold write is a plain insert: it never waits on, or fails because of,
 *     a charge in flight (built with the REAL customers foreign key).
 *   - The default-on guard in the real StripeService.charge (monthly dues /
 *     retries) refuses before any customer or Stripe work.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL (a local throwaway db), e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://localhost:5432/invoice_repair_test \
 *     npx jest --runInBand tests/collection-hold-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

jest.setTimeout(60000);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const settledWithin = (promise, ms) => Promise.race([promise.then(() => 'settled', () => 'settled'), sleep(ms).then(() => 'pending')]);

describeOrSkip('collection_hold as a money stop — real Postgres', () => {
  let db;
  let schema;
  let customerId;
  let hold;
  let flags;
  let StripeService;
  let stripeClient;

  beforeAll(async () => {
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
      throw new Error('This test requires a local invoice_repair_test or waves_test database');
    }
    schema = `hold_${randomUUID().replace(/-/g, '')}`;
    db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 8 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.raw('CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
    await db.raw('CREATE TABLE invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid REFERENCES customers(id))');
    await db.raw(`CREATE TABLE collections_flags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      flag varchar(40) NOT NULL,
      reason text,
      created_by varchar(80),
      created_at timestamptz NOT NULL DEFAULT now(),
      released_at timestamptz
    )`);
    await db.raw('CREATE UNIQUE INDEX collections_flags_active_uniq ON collections_flags (customer_id, flag) WHERE released_at IS NULL');
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
    stripeClient = { paymentIntents: { create: jest.fn(async () => { throw new Error('REACHED_STRIPE'); }) } };
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    hold = require('../services/collections/collection-hold');
    flags = require('../services/collections/outbound-voice/flags');
    StripeService = require('../services/stripe');
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await db.destroy();
  });

  const newCustomer = async () => (await db('customers').insert({}).returning('id'))[0].id;
  beforeEach(async () => {
    customerId = await newCustomer();
    stripeClient.paymentIntents.create.mockClear();
  });

  const clear = () => expect(hold.assertNoCollectionHold(customerId, db)).resolves.toBeUndefined();
  const stopped = () => expect(hold.assertNoCollectionHold(customerId, db)).rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });

  // The two fallback ARTIFACTS exactly as collections-conversation.js writes them.
  const wrongNumberFallback = () => flags.writeFlag({
    customerId, flag: 'collection_hold', reason: 'wrong-number report on billing follow-up call; wrong_number flag write failed',
  });
  const wrongPartyFallback = () => flags.writeFlag({
    customerId, flag: 'collection_hold', reason: 'wrong-party answer on billing follow-up call; review card failed to file',
  });

  test('a dispute hold stops money; releasing it resumes every lane', async () => {
    await clear();
    expect(await flags.placeDisputeHold(customerId, { summary: 'says the July bill is wrong' })).toMatchObject({ ok: true });
    await stopped();
    expect(await flags.releaseFlag({ customerId, flag: 'collection_hold' })).toEqual({ ok: true, released: 1 });
    await clear();
  });

  test('a dispute without a summary is a money hold too ("dispute raised on call")', async () => {
    await flags.placeDisputeHold(customerId, {});
    expect((await db('collections_flags').where({ customer_id: customerId }).first()).reason).toBe('dispute raised on call');
    await stopped();
  });

  test.each([['wrong-number fallback', 'wrongNumberFallback'], ['wrong-party fallback', 'wrongPartyFallback']])(
    'the %s collection_hold does NOT stop a charge (it is a pause-outreach artifact)', async (_label, which) => {
      await ({ wrongNumberFallback, wrongPartyFallback }[which])();
      expect(await db('collections_flags').where({ customer_id: customerId, flag: 'collection_hold' })).toHaveLength(1);
      await clear();
      // ...and the real charge primitive gets past its guard (it then fails on the
      // scratch schema's missing tables — never with a hold code)
      await expect(StripeService.charge(customerId, 89, 'Silver WaveGuard Monthly', {}, 'k-fallback'))
        .rejects.not.toMatchObject({ code: expect.stringMatching(/^COLLECTION_HOLD/) });
    },
  );

  test('rows written before this change behave by their reason text: legacy dispute rows stop money, legacy fallback / reason-less rows do not', async () => {
    const legacyDispute = await newCustomer();
    const legacyFallback = await newCustomer();
    const legacyNoReason = await newCustomer();
    await db('collections_flags').insert([
      { customer_id: legacyDispute, flag: 'collection_hold', reason: 'dispute on call: says the bill is a duplicate', created_by: 'system:collections_voice' },
      { customer_id: legacyFallback, flag: 'collection_hold', reason: 'wrong-party answer on billing follow-up call; review card failed to file', created_by: 'system:collections_voice' },
      { customer_id: legacyNoReason, flag: 'collection_hold', reason: null, created_by: 'admin:ops' },
    ]);
    await expect(hold.assertNoCollectionHold(legacyDispute, db)).rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
    await expect(hold.assertNoCollectionHold(legacyFallback, db)).resolves.toBeUndefined();
    await expect(hold.assertNoCollectionHold(legacyNoReason, db)).resolves.toBeUndefined();
  });

  test('a dispute raised while a FALLBACK hold is active upgrades that row (unique index) — the dispute is never swallowed; release resumes charging', async () => {
    await wrongPartyFallback();
    await clear();
    expect(await flags.placeDisputeHold(customerId, { summary: 'bill is wrong' })).toMatchObject({ ok: true });
    const rows = await db('collections_flags').where({ customer_id: customerId, flag: 'collection_hold' });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/^dispute on call: bill is wrong; earlier hold: wrong-party answer/);
    await stopped();
    await flags.releaseFlag({ customerId, flag: 'collection_hold' });
    await clear();
  });

  test('collectionHoldInvoiceIds (sweep + pay-combined preflight) follows the same dispute-only rule', async () => {
    const [held, fallback, clean] = [await newCustomer(), await newCustomer(), await newCustomer()];
    const ids = {};
    for (const [name, cid] of Object.entries({ held, fallback, clean })) {
      ids[name] = (await db('invoices').insert({ customer_id: cid }).returning('id'))[0].id;
    }
    await flags.writeFlag({ customerId: held, flag: 'collection_hold', reason: 'dispute on call: x' });
    await flags.writeFlag({ customerId: fallback, flag: 'collection_hold', reason: 'wrong-number report on billing follow-up call; wrong_number flag write failed' });
    const stoppedIds = await hold.collectionHoldInvoiceIds([ids.held, ids.fallback, ids.clean], { database: db });
    expect([...stoppedIds]).toEqual([String(ids.held)]);
  });

  test('E: the hold write NEVER waits on a charge in flight — even one that already passed its hold check and holds row locks', async () => {
    const chargeOpen = {};
    const stripeCall = new Promise((resolve) => { chargeOpen.resolve = resolve; });
    let checkedClear;
    const charge = db.transaction(async (trx) => {
      await trx('customers').where({ id: customerId }).forNoKeyUpdate().first('id'); // the charge's customer-row lock
      checkedClear = !(await hold.customerHasActiveCollectionHoldChecked(customerId, trx)); // it saw no hold
      await stripeCall; // "the Stripe call" is in flight
    });
    await sleep(200);
    expect(checkedClear).toBe(true);

    const started = Date.now();
    const write = flags.placeDisputeHold(customerId, { summary: 'raised mid-charge' });
    expect(await settledWithin(write, 1500)).toBe('settled');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await write).toMatchObject({ ok: true });
    await stopped(); // every LATER charge sees it
    chargeOpen.resolve();
    await charge; // the in-flight charge was neither blocked nor failed by the write
  });

  test('a hold write is never delayed by a charge holding the invoice row lock', async () => {
    const [{ id: invoiceId }] = await db('invoices').insert({ customer_id: customerId }).returning('id');
    const open = {};
    const gate = new Promise((resolve) => { open.resolve = resolve; });
    const charge = db.transaction(async (trx) => {
      await trx('invoices').where({ id: invoiceId }).forUpdate().first();
      await gate;
    });
    await sleep(200);
    const write = flags.placeDisputeHold(customerId, { summary: 'x' });
    expect(await settledWithin(write, 1500)).toBe('settled');
    open.resolve();
    await charge;
  });

  test('the real StripeService.charge (monthly dues + every retry) refuses a dispute hold before any customer or Stripe work; an operator override skips the guard', async () => {
    await flags.placeDisputeHold(customerId, { summary: 'dues disputed' });
    await expect(StripeService.charge(customerId, 89, 'Silver WaveGuard Monthly — X Y', { type: 'monthly_autopay' }, 'k-held'))
      .rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
    await expect(StripeService.chargeOneTime(customerId, 40, 'retry', 'k-held-2', { initiated_by: 'machine' }))
      .rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
    await expect(StripeService.chargeSavedPaymentMethodOffSession({ customerId, paymentMethodId: 'pm_x', amountDollars: 49, description: 'fee' }))
      .rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    // operator (admin Charge now) goes past the guard
    await expect(StripeService.charge(customerId, 89, 'x', {}, 'k-op', { operatorOverride: true }))
      .rejects.not.toMatchObject({ code: expect.stringMatching(/^COLLECTION_HOLD/) });
    // release resumes the lane
    await flags.releaseFlag({ customerId, flag: 'collection_hold' });
    await expect(StripeService.charge(customerId, 89, 'x', {}, 'k-released'))
      .rejects.not.toMatchObject({ code: expect.stringMatching(/^COLLECTION_HOLD/) });
  });

  test('a lookup failure is COLLECTION_HOLD_CHECK_FAILED, never "no hold" (fail closed)', async () => {
    await db.raw('ALTER TABLE collections_flags RENAME TO collections_flags_off');
    try {
      await expect(hold.assertNoCollectionHold(customerId, db)).rejects.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED' });
      await expect(StripeService.charge(customerId, 89, 'x', {}, 'k-fail-closed')).rejects.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED' });
    } finally {
      await db.raw('ALTER TABLE collections_flags_off RENAME TO collections_flags');
    }
  });
});
