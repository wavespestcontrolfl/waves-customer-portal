// The one-signup-email full-vs-short decision runs one at a time per account
// under an advisory lock. The lock must live OUTSIDE the knex pool: the locked
// work reads and sends through the pool, so a pooled lock connection (held by
// the holder and by every waiter) starves a small pool and stalls the holder
// itself (pre-push audit P1). Real Postgres, real pool of 2 (the supported
// DB_POOL_MAX floor), three concurrent signups for the same account.

process.env.DB_POOL_MAX = '2';
process.env.DB_POOL_MIN = '0';

const SKIP = !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

d('signup email lock on a pool of 2 (real Postgres)', () => {
  let db;
  let serializedPerAccount;

  beforeAll(() => {
    db = require('../models/db');
    ({ serializedPerAccount } = require('../services/estimate-accepted-email')._private);
  });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  test('three concurrent same-account decisions all finish, one at a time, without starving the pool', async () => {
    expect(db.client.pool.max).toBe(2);
    let inside = 0;
    let maxInside = 0;
    const order = [];
    // Each locked body uses the pool twice, the way the real decision + send do.
    const body = (name) => async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      order.push(name);
      await db.raw('SELECT pg_sleep(0.1)');
      await db.raw('SELECT 1');
      inside -= 1;
      return name;
    };
    const started = Date.now();
    const results = await Promise.all(['a', 'b', 'c'].map((n) => serializedPerAccount(null, body(n))));
    expect(results.sort()).toEqual(['a', 'b', 'c']);
    expect(maxInside).toBe(1);
    expect(order).toHaveLength(3);
    // Serialized (~0.3 s), and nowhere near the pool's acquire timeout.
    expect(Date.now() - started).toBeLessThan(10000);
  });

  test('the lock is released after a throw, so the next decision proceeds', async () => {
    await expect(serializedPerAccount(null, async () => { throw new Error('send blew up'); })).rejects.toThrow('send blew up');
    await expect(serializedPerAccount(null, async () => 'next')).resolves.toBe('next');
  });

  test('no lock connection is left open', async () => {
    await serializedPerAccount(null, async () => db.raw('SELECT 1'));
    const { rows } = await db.raw("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
    expect(rows[0].n).toBe(0);
  });
});
