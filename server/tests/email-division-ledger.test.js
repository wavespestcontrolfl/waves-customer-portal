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
    IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  },
}));

const db = require('../models/db');
const { eligibleForEmail } = require('../services/email-division/eligibility');
const Ledger = require('../services/email-division/ledger');

// Two tables are queried by ledger.js — `marketing_email_ledger` and, for the
// reconciliation with the delivery authority, `email_messages`. One queue per
// table, one chain per call in the order the code makes them. A chain awaited
// directly (the stale-row select) resolves to `rows`.
function chain({ first, result = [], rows = [], updateReturn = 1 } = {}) {
  const calls = [];
  const q = { calls };
  ['where', 'whereNot', 'whereNotNull', 'select', 'onConflict', 'ignore'].forEach((m) => {
    q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; });
  });
  q.first = jest.fn(async (...a) => { calls.push(['first', ...a]); return first; });
  q.update = jest.fn(async (patch) => { calls.push(['update', patch]); return updateReturn; });
  q.returning = jest.fn(async (...a) => { calls.push(['returning', ...a]); return result; });
  q.insert = jest.fn((row) => { calls.push(['insert', row]); return q; });
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

function setQueue(entries, emailMessages = []) {
  const queues = { marketing_email_ledger: [...entries], email_messages: [...emailMessages] };
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue) throw new Error(`unexpected table ${table}`);
    if (!queue.length) throw new Error(`exhausted ${table} queue`);
    return queue.shift();
  });
}

beforeEach(() => jest.clearAllMocks());

test('finding 1: a stale reservation is settled to failed/abandoned_reservation before the cap is honored', async () => {
  eligibleForEmail.mockResolvedValue({ ok: true, reason: null, checks: { customerEmail: 'sandy@example.test' } });
  const staleQ = chain({ rows: [{ id: 'row-stale', idempotency_key: 'key-old' }] });
  const settleQ = chain({ updateReturn: 1 });
  const idempQ = chain({ first: undefined });
  const outstandingQ = chain({ first: undefined });
  const insertQ = chain({ result: [{ id: 'row-1', status: 'reserved' }] });
  setQueue([staleQ, settleQ, idempQ, outstandingQ, insertQ], [chain({ first: undefined })]); // no accepted message for key-old

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'key-1', now: new Date('2026-09-28T12:00:00Z'),
  });

  expect(result.ok).toBe(true);
  const settleUpdate = settleQ.calls.find((c) => c[0] === 'update');
  expect(settleUpdate[1]).toMatchObject({ status: 'failed', reason: 'abandoned_reservation' });
  expect(settleQ.calls.some((c) => c[0] === 'where' && c[1]?.status === 'reserved')).toBe(true);
  expect(staleQ.calls.some((c) => c[0] === 'where' && c[1]?.status === 'reserved')).toBe(true);
});

test('GitHub round P1: a stale reservation whose key email_messages shows as accepted completes as SENT (linked), never abandoned', async () => {
  eligibleForEmail.mockResolvedValue({ ok: true, reason: null, checks: { customerEmail: 'sandy@example.test' } });
  const staleQ = chain({ rows: [{ id: 'row-stale', idempotency_key: 'key-old' }] });
  const settleQ = chain({ updateReturn: 1 });
  const idempQ = chain({ first: undefined });
  const outstandingQ = chain({ first: undefined });
  const insertQ = chain({ result: [{ id: 'row-1', status: 'reserved' }] });
  const accepted = { id: 'msg-9', sent_at: new Date('2026-09-28T11:31:00Z') };
  const acceptedQ = chain({ first: accepted });
  setQueue([staleQ, settleQ, idempQ, outstandingQ, insertQ], [acceptedQ]);

  await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'key-1', now: new Date('2026-09-28T12:00:00Z'),
  });

  expect(acceptedQ.calls).toEqual(expect.arrayContaining([['where', { idempotency_key: 'key-old' }], ['whereNotNull', 'sent_at']]));
  const settleUpdate = settleQ.calls.find((c) => c[0] === 'update');
  expect(settleUpdate[1]).toMatchObject({ status: 'sent', email_message_id: 'msg-9', sent_at: accepted.sent_at, reason: 'reconciled_from_email_messages' });
  expect(settleQ.calls.some((c) => c[0] === 'where' && c[1]?.id === 'row-stale' && c[1]?.status === 'reserved')).toBe(true);
});

test('finding 2: an existing idempotency key returns duplicate:true for whatever status it holds, without checking eligibility', async () => {
  const staleQ = chain({ rows: [] });
  const existingRow = { id: 'row-existing', status: 'sent', customer_id: 'cust-1', stream: 'broadcast', email_key: 'mkt.broadcast.fall' };
  const idempQ = chain({ first: existingRow });
  setQueue([staleQ, idempQ]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'existing-key', now: new Date(),
  });

  expect(result).toEqual({ ok: true, reason: null, row: existingRow, duplicate: true });
  expect(eligibleForEmail).not.toHaveBeenCalled();
});

test('GitHub round P2: an idempotency key that already names ANOTHER customer/stream/email is refused, not returned as a duplicate', async () => {
  const otherCustomersRow = { id: 'row-other', status: 'reserved', customer_id: 'cust-2', stream: 'broadcast', email_key: 'mkt.broadcast.fall' };
  setQueue([chain({ rows: [] }), chain({ first: otherCustomersRow })]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'campaign-key', now: new Date(),
  });

  expect(result).toEqual({ ok: false, reason: 'IDEMPOTENCY_KEY_CONFLICT', row: null, duplicate: false });
  expect(eligibleForEmail).not.toHaveBeenCalled();

  // …and the same key for the same customer but a different email is a conflict too.
  setQueue([chain({ rows: [] }), chain({ first: { ...otherCustomersRow, customer_id: 'cust-1', email_key: 'mkt.broadcast.other' } })]);
  const sameCustomer = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'campaign-key', now: new Date(),
  });
  expect(sameCustomer.reason).toBe('IDEMPOTENCY_KEY_CONFLICT');
});

test('finding 3: markFailed/markSkipped only move a still-reserved row, and report whether one changed', async () => {
  setQueue([chain({ first: { customer_id: 'cust-1', idempotency_key: 'k1' } }), chain({ updateReturn: 0 })], [chain({ first: undefined })]);
  await expect(Ledger.markFailed('row-1', 'provider_rejected')).resolves.toBe(false);

  const lookupQ = chain({ first: { customer_id: 'cust-1', idempotency_key: 'k1' } });
  const updateQ = chain({ updateReturn: 1 });
  setQueue([lookupQ, updateQ], [chain({ first: undefined })]);
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
