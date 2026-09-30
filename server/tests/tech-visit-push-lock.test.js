// utils/tech-visit-push-lock.js — the per-visit, cross-instance lock around
// a tech push. A clean "stale" verdict skips the send; a lock or recheck
// error sends anyway (fail open); the send's own error propagates after the
// lock is released; a bulk burst never holds more than the slot cap.
jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const {
  sendUnderVisitPushLock, LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS, SEND_BUDGET_MS, MAX_HOLD_MS, _test,
} = require('../utils/tech-visit-push-lock');

function primeDb({ lockError = null } = {}) {
  const trx = {
    raw: jest.fn(async (sql) => {
      if (lockError && /pg_advisory_xact_lock/.test(sql)) throw lockError;
    }),
  };
  // A nested knex transaction is a savepoint on the same connection.
  trx.transaction = jest.fn(async (fn) => fn(trx));
  db.transaction = jest.fn(async (fn) => fn(trx));
  db.client = { pool: { max: 20 } };
  return trx;
}

beforeEach(() => jest.clearAllMocks());

test('takes a transaction-scoped lock keyed on the visit, bounds the holder after the grant, then sends on the lock\'s connection', async () => {
  const trx = primeDb();
  const send = jest.fn(async () => 'ok');
  const before = Date.now();
  const out = await sendUnderVisitPushLock('visit-1', { send });
  expect(trx.raw.mock.calls).toEqual([
    [`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`],
    ['SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['tech-visit-push:visit-1']],
    // Only after the grant, so it never cuts the wait short.
    [`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`],
  ]);
  const [conn, { deadlineAt }] = send.mock.calls[0];
  expect(conn).toBe(trx);
  expect(deadlineAt).toBeGreaterThanOrEqual(before + SEND_BUDGET_MS);
  expect(deadlineAt).toBeLessThanOrEqual(Date.now() + SEND_BUDGET_MS);
  expect(out).toEqual({ sent: true, locked: true, result: 'ok' });
});

test('a waiter outlasts the longest legitimate hold (it never gives up on a holder still sending)', () => {
  // Several statements + the send budget + one worst-case leg (FCM OAuth + send).
  expect(MAX_HOLD_MS).toBeGreaterThanOrEqual(4 * STATEMENT_TIMEOUT_MS + SEND_BUDGET_MS + 16000);
  expect(LOCK_TIMEOUT_MS).toBeGreaterThan(MAX_HOLD_MS);
});

// The real sender: lookup, then beforeDispatch, then the provider handoff.
function sender(handoff = jest.fn(async () => 'ok'), events = []) {
  const send = jest.fn(async (conn, { beforeDispatch }) => {
    events.push('lookup');
    if ((await beforeDispatch()) === false) return { superseded: true };
    events.push('handoff');
    return handoff();
  });
  send.handoff = handoff;
  return send;
}

test('the recheck runs under the lock, AFTER the lookup and right before the handoff; a clean false sends nothing', async () => {
  const trx = primeDb();
  const events = [];
  const isCurrent = jest.fn(async (conn) => { expect(conn).toBe(trx); events.push('recheck'); return false; });
  const send = sender(undefined, events);
  const out = await sendUnderVisitPushLock('visit-1', { isCurrent, send });
  expect(events).toEqual(['lookup', 'recheck']);
  expect(out).toEqual({ sent: false, stale: true, locked: true });
  expect(send.handoff).not.toHaveBeenCalled();
});

test('a current recheck hands off after it', async () => {
  primeDb();
  const events = [];
  const send = sender(undefined, events);
  const out = await sendUnderVisitPushLock('visit-1', { isCurrent: async () => { events.push('recheck'); return true; }, send });
  expect(events).toEqual(['lookup', 'recheck', 'handoff']);
  expect(out).toEqual({ sent: true, locked: true, result: 'ok' });
});

test('a recheck error sends anyway, and the recheck ran in a savepoint so the lock\'s transaction stays usable', async () => {
  const trx = primeDb();
  const send = sender();
  const out = await sendUnderVisitPushLock('visit-1', { isCurrent: async () => { throw new Error('db'); }, send });
  expect(trx.transaction).toHaveBeenCalledTimes(1);
  expect(out.sent).toBe(true);
  expect(send.handoff).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe(trx);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('recheck failed'));
});

test('a lock error sends once, unordered; no PII or SQL in the log', async () => {
  primeDb({ lockError: Object.assign(new Error('canceling statement due to lock timeout SELECT secret'), { code: '55P03' }) });
  const send = jest.fn(async () => 'ok');
  const out = await sendUnderVisitPushLock('visit-1', { send });
  expect(out).toEqual({ sent: true, locked: false, result: 'ok' });
  expect(send).toHaveBeenCalledTimes(1);
  // No lock → the pool, and no deadline to honour.
  expect(send.mock.calls[0]).toEqual([null, { deadlineAt: null, beforeDispatch: expect.any(Function) }]);
  const msg = logger.warn.mock.calls[0][0];
  expect(msg).toContain('55P03');
  expect(msg).not.toContain('secret');
});

test('the send\'s own error propagates, and is never retried outside the lock', async () => {
  primeDb();
  const send = jest.fn(async () => { throw new Error('apns down'); });
  await expect(sendUnderVisitPushLock('visit-1', { send })).rejects.toThrow('apns down');
  expect(send).toHaveBeenCalledTimes(1);
});

test('a commit failure after the send never sends twice', async () => {
  db.transaction = jest.fn(async (fn) => { await fn({ raw: jest.fn(async () => {}) }); throw new Error('commit lost'); });
  const send = jest.fn(async () => 'ok');
  const out = await sendUnderVisitPushLock('visit-1', { send });
  expect(send).toHaveBeenCalledTimes(1);
  expect(out.sent).toBe(true);
});

test('holders are capped at a fraction of the pool; the rest wait holding no connection', async () => {
  primeDb();
  db.client = { pool: { max: 8 } };
  expect(_test.maxHolders()).toBe(2);
  let inFlight = 0;
  let peak = 0;
  const releases = [];
  const send = () => new Promise((resolve) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    releases.push(() => { inFlight -= 1; resolve('ok'); });
  });
  const all = Promise.all(['a', 'b', 'c', 'd'].map((v) => sendUnderVisitPushLock(v, { send })));
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setImmediate(r));
    expect(db.transaction.mock.calls.length).toBeLessThanOrEqual(2 + i);
    releases.shift()();
  }
  await all;
  expect(peak).toBe(2);
});
