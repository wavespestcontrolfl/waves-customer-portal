/**
 * The plan mint's cap on a real connection pool (cancellation-resolution/restart.js mintTransaction; #8132
 * pre-push r26, r40). A mint holds its transaction's connection and reads on a second one from the pool.
 * Eight of them on a pool of four: without the cap, four hold a connection each and wait for a fifth that no
 * one can give, so they fail when the pool's wait ends. With the cap they all finish.
 * A pool under four connections has no quarter for the mints (#8256 pre-push r2): the last test runs the
 * app's own pool at its floor of two, where a mint and a cron lock holder share one slot.
 * No table is read or written: the statements are `select 1`, `pg_sleep` and the job's advisory lock.
 */
// The app's own pool (models/db.js, which the cron locks count) at the knexfile floor. Read when it is first
// required, below.
process.env.DB_POOL_MAX = '2';
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

postgres('plan mint cap (live Postgres pool)', () => {
  jest.setTimeout(60000);
  let pool;

  beforeAll(() => {
    pool = require('knex')({
      client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 }, acquireConnectionTimeout: 1500,
    });
  });
  afterAll(async () => { await pool?.destroy(); });

  // The mint's shape: hold the transaction's connection, then read on a second one from the pool.
  const mintShaped = async (trx) => {
    await trx.raw('select 1');
    await pool.raw('select pg_sleep(0.05)');
    return 'minted';
  };
  const eight = (run) => Promise.allSettled(Array.from({ length: 8 }, run));

  test('eight mints on a pool of four all finish under the cap', async () => {
    const { mintTransaction } = require('../services/cancellation-resolution/restart');
    const capped = await eight(() => mintTransaction(pool, mintShaped));
    expect(capped.map((outcome) => outcome.status)).toEqual(Array(8).fill('fulfilled'));
    expect(capped.map((outcome) => outcome.value)).toEqual(Array(8).fill('minted'));
  });

  test('the same eight without the cap wait on each other until the pool gives up', async () => {
    const uncapped = await eight(() => pool.transaction(mintShaped));
    const failures = uncapped.filter((outcome) => outcome.status === 'rejected');
    expect(failures.length).toBeGreaterThanOrEqual(4);
    expect(String(failures[0].reason?.message)).toMatch(/Timeout acquiring a connection/);
    // The pool is whole again: a mint under the cap still finishes.
    const { mintTransaction } = require('../services/cancellation-resolution/restart');
    await expect(mintTransaction(pool, mintShaped)).resolves.toBe('minted');
  });

  // A cron job pins its lock's connection and reads on a second one, as a mint does. With a slot each, one
  // job and one mint pin both connections of this pool and each waits for a third.
  test('on the app\'s pool of two, mints and cron jobs take turns: no two of them pin both connections', async () => {
    const db = require('../models/db');
    const { runExclusive } = require('../utils/cron-lock');
    const { mintTransaction } = require('../services/cancellation-resolution/restart');
    expect(db.client.pool.max).toBe(2);
    const read = () => db.raw('select pg_sleep(0.05)');
    const job = (i) => runExclusive(`plan-mint-pool-test-${i}`, async () => { await read(); return 'swept'; }, { recordHealth: false, waitForSlot: true });
    const mint = () => mintTransaction(db, async (trx) => { await trx.raw('select 1'); await read(); return 'minted'; });
    let timer;
    const stuck = new Promise((resolve) => { timer = setTimeout(resolve, 8000, 'stuck'); });
    try {
      const outcomes = await Promise.race([Promise.allSettled([job(1), mint(), job(2), mint(), job(3), mint()]), stuck]);
      expect(outcomes).not.toBe('stuck');
      expect(outcomes.map((outcome) => outcome.value)).toEqual(['swept', 'minted', 'swept', 'minted', 'swept', 'minted']);
    } finally {
      clearTimeout(timer);
    }
  });
});
