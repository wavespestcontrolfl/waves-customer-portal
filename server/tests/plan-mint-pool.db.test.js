/**
 * The plan mint's cap on a real connection pool (cancellation-resolution/restart.js mintTransaction; #8132
 * pre-push r26, r40). A mint holds its transaction's connection and reads on a second one from the pool.
 * Eight of them on a pool of four: without the cap, four hold a connection each and wait for a fifth that no
 * one can give, so they fail when the pool's wait ends. With the cap they all finish.
 * No table is read or written: the statements are `select 1` and `pg_sleep`.
 */
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
});
