/**
 * email-division/ledger.js — unit coverage for the codex round-1 findings
 * (mocked db; the PG suite proves the real concurrency/locking behavior).
 */

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn(async (run) => run(db));
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((expr) => expr);
  return db;
});
jest.mock('../services/email-division/eligibility', () => ({
  eligibleForEmail: jest.fn(),
  REASONS: {
    CAP_WEEKLY_BROADCAST: 'CAP_WEEKLY_BROADCAST',
    CAP_WEEKLY_ALERT: 'CAP_WEEKLY_ALERT',
    CAP_SAME_DAY: 'CAP_SAME_DAY',
  },
}));

const db = require('../models/db');
const { eligibleForEmail } = require('../services/email-division/eligibility');
const Ledger = require('../services/email-division/ledger');

// Only `marketing_email_ledger` is ever queried by ledger.js — a queue of
// chain objects, one per call in the order the code makes them.
function chain({ first, result = [], updateReturn = 1 } = {}) {
  const calls = [];
  const q = { calls };
  ['where', 'whereNot', 'select', 'onConflict', 'ignore'].forEach((m) => {
    q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; });
  });
  q.first = jest.fn(async (...a) => { calls.push(['first', ...a]); return first; });
  q.update = jest.fn(async (patch) => { calls.push(['update', patch]); return updateReturn; });
  q.returning = jest.fn(async (...a) => { calls.push(['returning', ...a]); return result; });
  q.insert = jest.fn((row) => { calls.push(['insert', row]); return q; });
  return q;
}

function setQueue(entries) {
  const queue = [...entries];
  db.mockImplementation((table) => {
    if (table !== 'marketing_email_ledger') throw new Error(`unexpected table ${table}`);
    if (!queue.length) throw new Error('exhausted marketing_email_ledger queue');
    return queue.shift();
  });
}

beforeEach(() => jest.clearAllMocks());

test('finding 1: a stale reservation is settled to failed/abandoned_reservation before the cap is honored', async () => {
  eligibleForEmail.mockResolvedValue({ ok: true, reason: null, checks: { customerEmail: 'sandy@example.test' } });
  const settleQ = chain({ updateReturn: 1 });
  const idempQ = chain({ first: undefined });
  const outstandingQ = chain({ first: undefined });
  const insertQ = chain({ result: [{ id: 'row-1', status: 'reserved' }] });
  setQueue([settleQ, idempQ, outstandingQ, insertQ]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'key-1', now: new Date('2026-09-28T12:00:00Z'),
  });

  expect(result.ok).toBe(true);
  const settleUpdate = settleQ.calls.find((c) => c[0] === 'update');
  expect(settleUpdate[1]).toMatchObject({ status: 'failed', reason: 'abandoned_reservation' });
  expect(settleQ.calls.some((c) => c[0] === 'where' && c[1]?.status === 'reserved')).toBe(true);
});

test('finding 2: an existing idempotency key returns duplicate:true for whatever status it holds, without checking eligibility', async () => {
  const settleQ = chain({ updateReturn: 0 });
  const existingRow = { id: 'row-existing', status: 'sent', customer_id: 'cust-1' };
  const idempQ = chain({ first: existingRow });
  setQueue([settleQ, idempQ]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'existing-key', now: new Date(),
  });

  expect(result).toEqual({ ok: true, reason: null, row: existingRow, duplicate: true });
  expect(eligibleForEmail).not.toHaveBeenCalled();
});

test('finding 3: markFailed/markSkipped only move a still-reserved row, and report whether one changed', async () => {
  setQueue([chain({ first: { customer_id: 'cust-1' } }), chain({ updateReturn: 0 })]);
  await expect(Ledger.markFailed('row-1', 'provider_rejected')).resolves.toBe(false);

  const lookupQ = chain({ first: { customer_id: 'cust-1' } });
  const updateQ = chain({ updateReturn: 1 });
  setQueue([lookupQ, updateQ]);
  await expect(Ledger.markSkipped('row-2', 'unsubscribed')).resolves.toBe(true);
  const updateWhere = updateQ.calls.find((c) => c[0] === 'where');
  expect(updateWhere[1]).toEqual({ id: 'row-2', status: 'reserved' });
  expect(updateQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'skipped', reason: 'unsubscribed' });
});

test('CI push audit: a markSent retry on an already-sent row is a no-op (scoped to status: reserved)', async () => {
  const lookupQ = chain({ first: { customer_id: 'cust-1' } });
  const updateQ = chain({ updateReturn: 0 }); // already 'sent' — the WHERE no longer matches
  setQueue([lookupQ, updateQ]);

  const changed = await Ledger.markSent('row-1', { emailMessageId: 'msg-retry' });
  expect(changed).toBe(0);
  const updateWhere = updateQ.calls.find((c) => c[0] === 'where');
  expect(updateWhere[1]).toEqual({ id: 'row-1', status: 'reserved' });
});
