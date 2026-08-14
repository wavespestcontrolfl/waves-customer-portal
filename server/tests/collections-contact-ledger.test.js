/**
 * collections/contact-ledger — idempotent reservation semantics.
 *
 * Pins: a keyed recordContact uses ON CONFLICT DO NOTHING on the
 * idempotency key and REUSES the standing row when the insert is a no-op
 * (retryable callers never double-count a frequency-window touch); a keyed
 * conflict that then finds no row throws (fail closed); keyless inserts are
 * unchanged (no onConflict, throw on no id); markDelivered stamps by key,
 * best-effort, never throws.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { recordContact, markDelivered } = require('../services/collections/contact-ledger');

function insertChain({ returned = [{ id: 'led-1' }] } = {}) {
  const q = {};
  q.insert = jest.fn(() => q);
  q.onConflict = jest.fn(() => q);
  q.ignore = jest.fn(() => q);
  q.returning = jest.fn(async () => returned);
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => undefined);
  q.update = jest.fn(async () => 1);
  return q;
}

const ARGS = {
  customerId: 'cust-1', channel: 'sms', purpose: 'late_payment',
  invoiceIds: ['inv-1'], source: 'invoice_followup_replay',
};

beforeEach(() => jest.clearAllMocks());

test('keyed insert takes the ON CONFLICT DO NOTHING path and returns the fresh row', async () => {
  const q = insertChain();
  db.mockReturnValue(q);
  const entry = await recordContact({ ...ARGS, idempotencyKey: 'followup-replay:rk-1' });
  expect(q.insert).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: 'followup-replay:rk-1' }));
  expect(q.onConflict).toHaveBeenCalledWith('idempotency_key');
  expect(q.ignore).toHaveBeenCalled();
  expect(entry).toMatchObject({ id: 'led-1' });
  expect(entry.reused).toBeUndefined();
});

test('keyed retry (conflict, nothing inserted) REUSES the standing row', async () => {
  const q = insertChain({ returned: [] });
  q.first = jest.fn(async () => ({ id: 'led-9', metadata: '{"replay":true}' }));
  db.mockReturnValue(q);
  const entry = await recordContact({ ...ARGS, idempotencyKey: 'followup-replay:rk-1' });
  expect(entry).toEqual({ id: 'led-9', metadata: { replay: true }, reused: true });
});

test('keyed conflict with no standing row throws — the caller must hold, not send unledgered', async () => {
  const q = insertChain({ returned: [] });
  db.mockReturnValue(q);
  await expect(recordContact({ ...ARGS, idempotencyKey: 'followup-replay:rk-1' }))
    .rejects.toThrow('neither inserted nor found');
});

test('keyless insert never touches onConflict and throws when no id comes back', async () => {
  const ok = insertChain();
  db.mockReturnValue(ok);
  const entry = await recordContact(ARGS);
  expect(ok.onConflict).not.toHaveBeenCalled();
  expect(entry).toMatchObject({ id: 'led-1' });

  const empty = insertChain({ returned: [] });
  db.mockReturnValue(empty);
  await expect(recordContact(ARGS)).rejects.toThrow('returned no id');
});

test('markDelivered stamps by key and never throws on failure', async () => {
  const q = insertChain();
  db.mockReturnValue(q);
  await expect(markDelivered('followup-replay:rk-1')).resolves.toBe(true);
  expect(q.where).toHaveBeenCalledWith({ idempotency_key: 'followup-replay:rk-1' });

  q.update = jest.fn(async () => { throw new Error('db down'); });
  await expect(markDelivered('followup-replay:rk-1')).resolves.toBe(false);
  await expect(markDelivered(null)).resolves.toBe(false);
});
