/**
 * The per-invoice receipt send lock on real PostgreSQL, built on the repo's bounded
 * raw-connection mechanism (raw-connection-slots.js, the reschedule-link send
 * interlock's): a session advisory lock on its own unpooled connection. Mirrors how
 * the interlock is tested — a pool of 2 with two different keys held at once, and a
 * session killed mid-work.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const ORIGINAL_ENV = { DB_POOL_MAX: process.env.DB_POOL_MAX, DB_POOL_MIN: process.env.DB_POOL_MIN };
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.setTimeout(30000);

const { randomUUID } = require('node:crypto');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

postgres('withReceiptSendLock', () => {
  let db; let withReceiptSendLock; let _slots;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    // The supported small pool: lock sessions must not come out of it.
    process.env.DB_POOL_MAX = '2';
    process.env.DB_POOL_MIN = '2';
    db = require('../models/db');
    ({ withReceiptSendLock, _slots } = require('../services/receipt-send-lock'));
  });
  afterAll(async () => {
    await db?.destroy();
    process.env.DB_POOL_MAX = ORIGINAL_ENV.DB_POOL_MAX;
    process.env.DB_POOL_MIN = ORIGINAL_ENV.DB_POOL_MIN;
  });

  const lockRows = async () => (await db.raw(
    "select pid from pg_locks where locktype = 'advisory' and objsubid = 2 and classid = ((hashtext('receipt-resend')::bigint & 4294967295)::bigint)::oid",
  )).rows;
  const waitFor = async (predicate) => {
    for (let i = 0; i < 300 && !(await predicate()); i += 1) await sleep(10);
    expect(await predicate()).toBe(true);
  };
  const gate = () => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, release };
  };

  test('the pool really is 2', () => {
    expect(db.client.pool.max).toBe(2);
  });

  test('pool of 2, two different invoices held at once: both bodies still run pooled queries, no deadlock', async () => {
    const a = randomUUID(); const b = randomUUID();
    const hold = gate();
    const body = async () => {
      // Two concurrent pooled queries inside each locked section — a pooled lock transaction
      // per send would already have taken both pool connections here and deadlocked.
      await Promise.all([db.raw('select pg_sleep(0.05)'), db.raw('select pg_sleep(0.05)')]);
      await hold.promise;
      await Promise.all([db.raw('select 1'), db.raw('select 2')]);
      return 'ran';
    };
    const first = withReceiptSendLock(a, body);
    const second = withReceiptSendLock(b, body);
    await waitFor(async () => (await lockRows()).length === 2);
    hold.release();
    expect(await first).toMatchObject({ acquired: true, value: 'ran', lost: false });
    expect(await second).toMatchObject({ acquired: true, value: 'ran', lost: false });
    expect(await lockRows()).toHaveLength(0);
    expect(_slots.openCount()).toBe(0);
  });

  test('one holder per invoice; the same invoice is refused as busy with no effect; released on exit', async () => {
    const a = randomUUID();
    const hold = gate();
    const first = withReceiptSendLock(a, async () => { await hold.promise; return 'done'; });
    await waitFor(async () => (await lockRows()).length === 1);
    const ran = jest.fn();
    expect(await withReceiptSendLock(a, async () => { ran(); })).toEqual({ acquired: false, reason: 'busy' });
    expect(ran).not.toHaveBeenCalled();
    hold.release();
    expect(await first).toMatchObject({ acquired: true, value: 'done' });
    expect(await lockRows()).toHaveLength(0);
    expect(await withReceiptSendLock(a, async () => 'again')).toMatchObject({ acquired: true, value: 'again' });
  });

  test('slots exhausted: refused like in flight (no wait, no effect), and the pool is untouched; a release frees a slot', async () => {
    const hold = gate();
    const holders = Array.from({ length: 4 }, () => withReceiptSendLock(randomUUID(), async () => { await hold.promise; return 'held'; }));
    await waitFor(async () => (await lockRows()).length === 4);
    const ran = jest.fn();
    const started = Date.now();
    expect(await withReceiptSendLock(randomUUID(), async () => { ran(); })).toEqual({ acquired: false, reason: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ran).not.toHaveBeenCalled();
    // The pool still serves ordinary queries while every slot is taken.
    expect((await db.raw('select 1 as n')).rows[0].n).toBe(1);
    hold.release();
    await Promise.all(holders);
    expect(_slots.openCount()).toBe(0);
    expect(await withReceiptSendLock(randomUUID(), async () => 'free again')).toMatchObject({ acquired: true });
  });

  test('released when the body throws', async () => {
    const id = randomUUID();
    await expect(withReceiptSendLock(id, async () => { throw new Error('leg blew up'); })).rejects.toThrow('leg blew up');
    expect(await lockRows()).toHaveLength(0);
    expect(_slots.openCount()).toBe(0);
    expect(await withReceiptSendLock(id, async () => 'ok')).toMatchObject({ acquired: true, value: 'ok' });
  });

  test('the session killed mid-work: owner.lost() flips, another send can take the lock while the first is still running, the slot is freed', async () => {
    const id = randomUUID();
    const hold = gate();
    let sawLost = null;
    const first = withReceiptSendLock(id, async (owner) => {
      await hold.promise;
      sawLost = owner.lost();
      return 'finished after loss';
    });
    await waitFor(async () => (await lockRows()).length === 1);
    const [{ pid }] = await lockRows();
    await db.raw('select pg_terminate_backend(?)', [pid]);
    await waitFor(async () => (await lockRows()).length === 0);
    // The first send is still running, but its lock is gone: a second send takes it now.
    const second = await withReceiptSendLock(id, async () => 'second took it');
    expect(second).toMatchObject({ acquired: true, value: 'second took it' });
    hold.release();
    // The first body checks ownership before its next effect, and sees it lost.
    const out = await first;
    expect(sawLost).toBe(true);
    expect(out).toMatchObject({ acquired: true, value: 'finished after loss', lost: true });
    expect(_slots.openCount()).toBe(0);
  });

  test('the lease bounds a hung send: past it the session is closed, the lock dropped and owner.lost() is true', async () => {
    const id = randomUUID();
    const hold = gate();
    let lostAfterLease = null;
    const first = withReceiptSendLock(id, async (owner) => {
      await hold.promise;
      lostAfterLease = owner.lost();
      return 'late';
    }, { leaseMs: 300 });
    await waitFor(async () => (await lockRows()).length === 1);
    await waitFor(async () => (await lockRows()).length === 0);
    expect(await withReceiptSendLock(id, async () => 'next send')).toMatchObject({ acquired: true, value: 'next send' });
    hold.release();
    expect(await first).toMatchObject({ acquired: true, value: 'late', lost: true });
    expect(lostAfterLease).toBe(true);
    expect(_slots.openCount()).toBe(0);
  });
});
