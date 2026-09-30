/**
 * collections flags writer — the ONE mechanism every flag write/release goes
 * through (relay webhooks, conversation, and ops/agents/collections-flag.js).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => { const fn = jest.fn(); fn.fn = { now: jest.fn(() => 'NOW()') }; return fn; });

const db = require('../models/db');
const { writeFlag, releaseFlag, activeFlags } = require('../services/collections/outbound-voice/flags');

function chain({ updateResult = 1, rows = [], insertThrows = null } = {}) {
  const q = {};
  ['where', 'whereNull', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(async () => rows);
  q.update = jest.fn(async () => updateResult);
  q.insert = jest.fn(async () => { if (insertThrows) throw insertThrows; return [1]; });
  return q;
}
beforeEach(() => jest.clearAllMocks());

test('writeFlag inserts once; a unique-violation (already active) is success-by-intent', async () => {
  db.mockImplementation(() => chain());
  expect(await writeFlag({ customerId: 'c-1', flag: 'pays_by_check', reason: 'r', createdBy: 'owner:ops-script' })).toEqual({ ok: true, created: true });
  db.mockImplementation(() => chain({ insertThrows: Object.assign(new Error('dup'), { code: '23505' }) }));
  expect(await writeFlag({ customerId: 'c-1', flag: 'pays_by_check' })).toEqual({ ok: true, created: false });
  expect(await writeFlag({ customerId: null, flag: 'pays_by_check' })).toEqual({ ok: false, reason: 'missing_args' });
});

test('releaseFlag stamps released_at on the active row only — never deletes; idempotent', async () => {
  const q = chain({ updateResult: 1 }); db.mockImplementation(() => q);
  expect(await releaseFlag({ customerId: 'c-1', flag: 'pays_by_check' })).toEqual({ ok: true, released: 1 });
  expect(q.where).toHaveBeenCalledWith({ customer_id: 'c-1', flag: 'pays_by_check' });
  expect(q.whereNull).toHaveBeenCalledWith('released_at');
  expect(q.update).toHaveBeenCalledWith({ released_at: 'NOW()' });
  db.mockImplementation(() => chain({ updateResult: 0 }));
  expect(await releaseFlag({ customerId: 'c-1', flag: 'pays_by_check' })).toEqual({ ok: true, released: 0 });
  expect(await releaseFlag({ customerId: 'c-1' })).toEqual({ ok: false, reason: 'missing_args' });
});

test('activeFlags lists unreleased rows oldest first', async () => {
  const q = chain({ rows: [{ flag: 'pays_by_check' }] }); db.mockImplementation(() => q);
  expect(await activeFlags('c-1')).toEqual([{ flag: 'pays_by_check' }]);
  expect(q.whereNull).toHaveBeenCalledWith('released_at');
  expect(q.orderBy).toHaveBeenCalledWith('created_at', 'asc');
  expect(await activeFlags(null)).toEqual([]);
});

test('B10: a collection_hold write takes the per-customer exclusive lock inside a transaction BEFORE the insert; other flags stay a plain insert', async () => {
  const order = [];
  const trxInsert = jest.fn(async () => { order.push('insert'); return [1]; });
  const trx = jest.fn(() => ({ insert: trxInsert }));
  trx.raw = jest.fn(async (sql) => { order.push(`raw:${sql}`); });
  db.transaction = jest.fn(async (cb) => cb(trx));
  expect(await writeFlag({ customerId: 'c-1', flag: 'collection_hold', reason: 'r' })).toEqual({ ok: true, created: true });
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(order[0]).toMatch(/lock_timeout/);
  expect(order[1]).toMatch(/^raw:SELECT pg_advisory_xact_lock\(/);
  expect(order[2]).toBe('insert');
  expect(trx.raw.mock.calls[1][1]).toEqual(['collections_hold:c-1']);

  db.transaction.mockClear();
  db.mockImplementation(() => chain());
  await writeFlag({ customerId: 'c-1', flag: 'pays_by_check' });
  expect(db.transaction).not.toHaveBeenCalled();
});
