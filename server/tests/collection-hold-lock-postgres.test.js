/**
 * B10 P0 regression, real PostgreSQL: the collection_hold write and the
 * off-session charge path are serialized by a per-customer advisory lock.
 *
 * A plain SELECT before the charge cannot order the charge against a hold
 * that commits a moment later (the flag is an INSERT — no row to FOR
 * UPDATE). The charge / credit paths therefore take a SHARED transaction
 * lock BEFORE the hold read and keep it through their transaction (the
 * Stripe call included); flags.writeFlag takes the EXCLUSIVE lock around
 * the collection_hold insert. Real concurrent transactions on two pool
 * connections show both orderings.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL (local throwaway db), e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://localhost:5432/invoice_repair_test \
 *     npx jest --runInBand tests/collection-hold-lock-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

jest.setTimeout(60000);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}
// Resolves 'pending' if the promise has not settled within ms.
const settledWithin = (promise, ms) => Promise.race([promise.then(() => 'settled', () => 'settled'), sleep(ms).then(() => 'pending')]);

describeOrSkip('collection_hold advisory lock — real Postgres', () => {
  let db;
  let schema;
  let customerId;
  let hold;
  let flags;

  beforeAll(async () => {
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
      throw new Error('This test requires a local invoice_repair_test or waves_test database');
    }
    schema = `hold_lock_${randomUUID().replace(/-/g, '')}`;
    db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 8 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.raw(`CREATE TABLE collections_flags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL,
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
    hold = require('../services/collections/collection-hold');
    flags = require('../services/collections/outbound-voice/flags');
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await db.destroy();
  });

  beforeEach(() => { customerId = randomUUID(); });

  const holdRows = () => db('collections_flags').where({ customer_id: customerId, flag: 'collection_hold' }).whereNull('released_at');

  test('a hold write racing an in-flight charge WAITS for it — the charge is never overtaken between check and Stripe', async () => {
    const stripeCall = gate();
    let checked;
    const charge = db.transaction(async (trx) => {
      checked = await hold.customerHasActiveCollectionHoldLocked(trx, customerId); // false; shared lock now held
      await stripeCall.promise; // "the Stripe call"
    });
    await sleep(200);
    expect(checked).toBe(false);

    const write = flags.writeFlag({ customerId, flag: 'collection_hold', reason: 'dispute on call' });
    try {
      expect(await settledWithin(write, 600)).toBe('pending');
      expect(await holdRows()).toHaveLength(0); // not committed while the charge is in flight
    } finally {
      stripeCall.open(); // never leave the lock held if an assertion fails
    }
    await charge;
    expect(await write).toEqual({ ok: true, created: true });
    expect(await holdRows()).toHaveLength(1);

    // Every LATER charge sees it.
    const next = await db.transaction((trx) => hold.customerHasActiveCollectionHoldLocked(trx, customerId));
    expect(next).toBe(true);
  });

  test('a charge starting while a hold write is mid-commit WAITS and then sees the hold', async () => {
    const commit = gate();
    const writer = db.transaction(async (trx) => {
      await hold.lockCustomerHoldExclusive(trx, customerId);
      await trx('collections_flags').insert({ customer_id: customerId, flag: 'collection_hold' });
      await commit.promise; // insert done, not yet committed
    });
    await sleep(200);

    const check = db.transaction((trx) => hold.customerHasActiveCollectionHoldLocked(trx, customerId));
    try {
      expect(await settledWithin(check, 600)).toBe('pending'); // an unlocked read here would answer false
    } finally {
      commit.open();
    }
    await writer;
    expect(await check).toBe(true);
  });

  test('a hold committed BEFORE the charge locks is seen by the check that follows the lock', async () => {
    expect(await flags.writeFlag({ customerId, flag: 'collection_hold' })).toEqual({ ok: true, created: true });
    expect(await db.transaction((trx) => hold.customerHasActiveCollectionHoldLocked(trx, customerId))).toBe(true);
  });

  test('releasing the hold re-enables charging', async () => {
    await flags.writeFlag({ customerId, flag: 'collection_hold' });
    expect(await flags.releaseFlag({ customerId, flag: 'collection_hold' })).toEqual({ ok: true, released: 1 });
    expect(await db.transaction((trx) => hold.customerHasActiveCollectionHoldLocked(trx, customerId))).toBe(false);
  });

  test('concurrent charges share the lock — they do not queue behind each other', async () => {
    const stripeCall = gate();
    const first = db.transaction(async (trx) => {
      await hold.customerHasActiveCollectionHoldLocked(trx, customerId);
      await stripeCall.promise;
    });
    await sleep(150);
    const second = db.transaction((trx) => hold.customerHasActiveCollectionHoldLocked(trx, customerId));
    expect(await settledWithin(second, 600)).toBe('settled');
    stripeCall.open();
    await first;
  });

  test('a duplicate active hold is still success-by-intent (unique violation inside the lock transaction)', async () => {
    expect(await flags.writeFlag({ customerId, flag: 'collection_hold' })).toEqual({ ok: true, created: true });
    expect(await flags.writeFlag({ customerId, flag: 'collection_hold' })).toEqual({ ok: true, created: false });
  });

  test('other flags do not take the lock — a do_not_text write is not held up by an in-flight charge', async () => {
    const stripeCall = gate();
    const charge = db.transaction(async (trx) => {
      await hold.customerHasActiveCollectionHoldLocked(trx, customerId);
      await stripeCall.promise;
    });
    await sleep(150);
    const write = flags.writeFlag({ customerId, flag: 'do_not_text' });
    expect(await settledWithin(write, 600)).toBe('settled');
    stripeCall.open();
    await charge;
  });

  test('locks are per customer — another customer\'s hold write is not blocked', async () => {
    const stripeCall = gate();
    const charge = db.transaction(async (trx) => {
      await hold.customerHasActiveCollectionHoldLocked(trx, customerId);
      await stripeCall.promise;
    });
    await sleep(150);
    const write = flags.writeFlag({ customerId: randomUUID(), flag: 'collection_hold' });
    expect(await settledWithin(write, 600)).toBe('settled');
    stripeCall.open();
    await charge;
  });
});
