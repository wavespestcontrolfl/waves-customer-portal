// cron-lock.lockHeldByAnySession against real PostgreSQL: the pg_locks read
// must see a session advisory lock another connection holds on the job's
// hashtext key (including a NEGATIVE hash, whose int8 form sets the high
// 32 bits), and must not take the lock itself — a concurrent
// pg_try_advisory_lock still succeeds during the probe.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('cron-lock lockHeldByAnySession against PostgreSQL', () => {
  let db; let holder; let lockHeldByAnySession;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local database');
    db = require('../models/db');
    ({ lockHeldByAnySession } = require('../utils/cron-lock'));
    holder = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
  });
  afterAll(async () => { await holder?.destroy(); await db?.destroy(); });

  test.each(['settle-probe-a', 'settle-probe-b', 'settle-probe-negative-hash-42'])('%s: held while another session holds it, free after release', async (job) => {
    const key = `cron:${job}`;
    expect(await lockHeldByAnySession(job)).toBe(false);
    await holder.raw('SELECT pg_advisory_lock(hashtext(?))', [key]);
    try {
      expect(await lockHeldByAnySession(job)).toBe(true);
    } finally {
      await holder.raw('SELECT pg_advisory_unlock(hashtext(?))', [key]);
    }
    expect(await lockHeldByAnySession(job)).toBe(false);
  });

  test('the probe leaves nothing behind: no advisory lock on the key afterwards, and a real try-lock wins', async () => {
    const key = 'cron:settle-probe-leftover';
    expect(await lockHeldByAnySession('settle-probe-leftover')).toBe(false);
    const locks = await holder.raw(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND ((classid::bigint << 32) | objid::bigint) = hashtext(?)::bigint",
      [key],
    );
    expect(locks.rows[0].n).toBe(0);
    const tryLock = await holder.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', [key]);
    expect(tryLock.rows[0].locked).toBe(true);
    await holder.raw('SELECT pg_advisory_unlock(hashtext(?))', [key]);
  });
});
