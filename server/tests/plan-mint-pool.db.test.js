/**
 * The plan mint's cap on a real connection pool (cancellation-resolution/restart.js mintTransaction; #8132
 * pre-push r26, r40). A mint holds its transaction's connection and reads on a second one from the pool.
 * Eight of them on a pool of four: without the cap, four hold a connection each and wait for a fifth that no
 * one can give, so they fail when the pool's wait ends. With the cap, one mints and the pool stays free; the
 * other seven are refused at once and hold nothing.
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

  test('eight taps at once on a pool of four: one mints, seven are refused at once, none waits on the pool', async () => {
    const { mintTransaction } = require('../services/cancellation-resolution/restart');
    const taps = await eight(() => mintTransaction(pool, mintShaped));
    expect(taps.filter((outcome) => outcome.status === 'fulfilled').map((outcome) => outcome.value)).toEqual(['minted']);
    expect(taps.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason?.code)).toEqual(Array(7).fill('busy'));
    // The slot came back: taps that come one after the other all mint.
    await expect(mintTransaction(pool, mintShaped)).resolves.toBe('minted');
    await expect(mintTransaction(pool, mintShaped)).resolves.toBe('minted');
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
  test('on the app\'s pool of two, a mint and a cron job never pin both connections', async () => {
    const db = require('../models/db');
    const { runExclusive } = require('../utils/cron-lock');
    const { mintTransaction } = require('../services/cancellation-resolution/restart');
    expect(db.client.pool.max).toBe(2);
    const read = () => db.raw('select pg_sleep(0.05)');
    const gate = () => {
      let open;
      const opened = new Promise((resolve) => { open = resolve; });
      return { open, opened };
    };

    // A cron job runs: it pins its lock's connection and reads on the other one.
    const jobIn = gate();
    const jobEnd = gate();
    const job = runExclusive('plan-mint-pool-test-job', async () => {
      await read();
      jobIn.open();
      await jobEnd.opened;
      await read();
      return 'swept';
    }, { recordHealth: false, waitForSlot: true });
    await jobIn.opened;
    // A mint now would pin the second connection. It is refused at once and opens no transaction.
    const work = jest.fn(async () => 'never');
    await expect(mintTransaction(db, work)).rejects.toMatchObject({ restartUnavailable: true, code: 'busy' });
    expect(work).not.toHaveBeenCalled();
    jobEnd.open();
    await expect(job).resolves.toBe('swept');

    // A mint runs: it pins its transaction's connection and reads on the other one. A cron tick waits its turn.
    const mintIn = gate();
    const mintEnd = gate();
    const minting = mintTransaction(db, async (trx) => {
      await trx.raw('select 1');
      await read();
      mintIn.open();
      await mintEnd.opened;
      await read();
      return 'minted';
    });
    await mintIn.opened;
    let tickRan = false;
    const tick = runExclusive('plan-mint-pool-test-tick', async () => {
      tickRan = true;
      await read();
      return 'swept';
    }, { recordHealth: false, waitForSlot: true });
    // The pool still has its second connection free, and the tick has not started.
    await read();
    expect(tickRan).toBe(false);
    mintEnd.open();
    await expect(minting).resolves.toBe('minted');
    await expect(tick).resolves.toBe('swept');
  });

});
