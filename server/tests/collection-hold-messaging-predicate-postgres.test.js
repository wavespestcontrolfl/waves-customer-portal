/**
 * Codex #5424 round 13: ONE messaging-hold predicate. A pay link / dunning touch waits on ANY active
 * collection_hold row - a dispute OR a wrong-number / wrong-party fallback (an all-channel outreach block
 * a released dispute restores) - while CHARGING stops only on a dispute. The two trusted exemptions (an
 * operator send, a link the customer asked for) pass `ignoreDisputeHold`, which skips a plain dispute row
 * only: never a fallback row, never a dispute row that still carries its embedded fallback trailer.
 *
 * Real Postgres (COLLECTION_HOLD_TEST_DATABASE_URL, else CI's REPAIR_TEST_DATABASE_URL; skipped without
 * either). Synthetic names only.
 */
const connection = process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL;
jest.mock('../models/db', () => require('knex')({
  client: 'pg', connection: process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL, pool: { min: 0, max: 4 },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const run = connection ? describe : describe.skip;
const DISPUTE = 'dispute on call: synthetic billing question';
const FALLBACK = 'wrong-number report on billing follow-up call; wrong_number flag write failed';
const WRONG_PARTY = 'wrong-party answer on billing follow-up call';

run('messaging vs charging hold predicates (postgres)', () => {
  let db;
  let Hold;
  const customers = [];
  async function customerWith(reason, { released = false } = {}) {
    const [row] = await db('customers').insert({ first_name: 'Synthetic', last_name: 'Predicate', phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}` }).returning('id');
    customers.push(row.id);
    if (reason !== undefined) {
      await db('collections_flags').insert({ customer_id: row.id, flag: 'collection_hold', reason, created_by: 'test', ...(released ? { released_at: db.fn.now() } : {}) });
    }
    return row.id;
  }
  beforeAll(() => { db = require('../models/db'); Hold = require('../services/collections/collection-hold'); });
  afterAll(async () => {
    if (customers.length) {
      await db('collections_flags').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
    }
    await db.destroy();
  });

  const held = async (id, opts) => (await Hold.messagingHeldByCollectionHold(id, undefined, opts)).held;

  test('messaging waits on ANY active collection_hold; charging stops on a dispute only', async () => {
    const dispute = await customerWith(DISPUTE);
    const wrongNumber = await customerWith(FALLBACK);
    const wrongParty = await customerWith(WRONG_PARTY);
    const reasonless = await customerWith(null);
    const none = await customerWith(undefined);
    const released = await customerWith(DISPUTE, { released: true });
    for (const id of [dispute, wrongNumber, wrongParty, reasonless]) expect(await held(id)).toBe(true);
    for (const id of [none, released]) expect(await held(id)).toBe(false);
    // charging keeps the dispute-only rule (the charge primitives are untouched)
    expect(await Hold.customerHasActiveCollectionHold(dispute)).toBe(true);
    for (const id of [wrongNumber, wrongParty, reasonless]) expect(await Hold.customerHasActiveCollectionHold(id)).toBe(false);
  });

  test('ignoreDisputeHold (the trusted exemption) skips a plain dispute ONLY', async () => {
    const plain = await customerWith(DISPUTE);
    const layered = await customerWith(Hold.embedPriorHoldReason(DISPUTE, FALLBACK));
    const layeredReasonless = await customerWith(Hold.embedPriorHoldReason(DISPUTE, ''));
    const wrongNumber = await customerWith(FALLBACK);
    const wrongParty = await customerWith(WRONG_PARTY);
    const reasonless = await customerWith(null);
    const opts = { ignoreDisputeHold: true };
    expect(await held(plain, opts)).toBe(false);
    for (const id of [layered, layeredReasonless, wrongNumber, wrongParty, reasonless]) expect(await held(id, opts)).toBe(true);
    // the in-memory twin agrees row for row
    for (const reason of [DISPUTE, Hold.embedPriorHoldReason(DISPUTE, FALLBACK), Hold.embedPriorHoldReason(DISPUTE, ''), FALLBACK, WRONG_PARTY, null]) {
      expect(Hold.rowBlocksMessaging(reason, opts)).toBe(reason !== DISPUTE);
      expect(Hold.rowBlocksMessaging(reason)).toBe(true);
    }
  });

  test('collectionHoldExistsSql is the due-queue twin: any active hold excludes; the exemption option mirrors the predicate', async () => {
    const dispute = await customerWith(DISPUTE);
    const fallback = await customerWith(FALLBACK);
    const none = await customerWith(undefined);
    const ids = [dispute, fallback, none];
    const heldOf = async (opts) => (await db('customers').whereIn('id', ids).whereExists(function anyHold() {
      Hold.collectionHoldExistsSql(this, 'customers.id', opts);
    }).select('id')).map((r) => r.id).sort();
    expect(await heldOf()).toEqual([dispute, fallback].sort());
    expect(await heldOf({ ignoreDisputeHold: true })).toEqual([fallback]);
  });

  test('a lookup failure holds (fail closed) and a trusted exemption never turns it into "clear"', async () => {
    const failing = jest.fn(() => { throw new Error('db down'); });
    expect(await Hold.messagingHeldByCollectionHold('cust-1', failing)).toMatchObject({ held: true, reason: 'lookup_failed' });
    expect(await Hold.messagingHeldByCollectionHold('cust-1', failing, { ignoreDisputeHold: true })).toMatchObject({ held: true, reason: 'lookup_failed' });
    await expect(Hold.customerHasActiveMessagingHoldChecked('cust-1', failing)).rejects.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED' });
  });

  test('on a caller transaction the read runs in a savepoint and REUSES that connection (no root-pool read)', async () => {
    const id = await customerWith(FALLBACK);
    const poolBefore = db.client.pool.numUsed();
    await db.transaction(async (trx) => {
      const used = db.client.pool.numUsed();
      expect(await Hold.messagingHeldByCollectionHold(id, trx)).toEqual({ held: true, reason: 'hold' });
      expect(await Hold.messagingHeldByCollectionHold(id, trx, { ignoreDisputeHold: true })).toEqual({ held: true, reason: 'hold' });
      expect(db.client.pool.numUsed()).toBe(used); // no extra connection acquired
      // a failed lookup inside the lock-holding transaction must not abort it (25P02): the read is a savepoint
      await expect(trx.transaction(async (sp) => { await sp.raw('select * from no_such_table_b10'); })).rejects.toThrow();
      await trx.raw('select 1'); // the outer transaction is still usable
    });
    expect(db.client.pool.numUsed()).toBe(poolBefore);
  });
});
