/**
 * The per-invoice receipt send lock on real PostgreSQL (advisory lock on its own
 * connection, nothing persisted): one holder at a time, released on every exit,
 * and dropped by the server when the idle limit passes.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('withReceiptSendLock', () => {
  let db; let withReceiptSendLock;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    db = require('../models/db');
    ({ withReceiptSendLock } = require('../services/receipt-send-lock'));
  });
  afterAll(async () => { await db.destroy(); });
  const held = async () => Number((await db.raw(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' and objsubid = 2 and classid = ((hashtext('receipt-resend')::bigint & 4294967295)::bigint)::oid",
  )).rows[0].n);

  test('one holder at a time per invoice; another invoice is independent; released on exit', async () => {
    const a = randomUUID(); const b = randomUUID();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = withReceiptSendLock(a, async () => { await gate; return 'done'; });
    for (let i = 0; i < 100 && (await held()) < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(await held()).toBe(1);
    expect(await withReceiptSendLock(a, async () => 'never')).toEqual({ acquired: false });
    expect(await withReceiptSendLock(b, async () => 'other')).toEqual({ acquired: true, value: 'other' });
    release();
    expect(await first).toEqual({ acquired: true, value: 'done' });
    expect(await held()).toBe(0);
    expect(await withReceiptSendLock(a, async () => 'again')).toEqual({ acquired: true, value: 'again' });
  });

  test('released when the body throws', async () => {
    const id = randomUUID();
    await expect(withReceiptSendLock(id, async () => { throw new Error('leg blew up'); })).rejects.toThrow('leg blew up');
    expect(await held()).toBe(0);
    expect(await withReceiptSendLock(id, async () => 'ok')).toEqual({ acquired: true, value: 'ok' });
  });

  test('a hung body cannot pin the lock past the idle limit: the server ends the session, the lock is dropped, the body still returns', async () => {
    const id = randomUUID();
    const out = await withReceiptSendLock(id, async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return 'finished late';
    }, { idleLimitMs: 300 });
    // The connection was ended by the server (idle_in_transaction_session_timeout) mid-body; the body's own result survives.
    expect(out).toEqual({ acquired: true, value: 'finished late' });
    expect(await held()).toBe(0);
    expect(await withReceiptSendLock(id, async () => 'ok')).toEqual({ acquired: true, value: 'ok' });
  });
});
