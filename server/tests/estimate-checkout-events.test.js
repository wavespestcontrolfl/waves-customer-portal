/**
 * estimate-checkout-events — the payment-step-reached recorder the two card
 * intent endpoints call. Pins: one row per (estimate, kind) with
 * updated_at/setup_intent_id merged on re-reach, and the guaranteed
 * non-throwing contract (this runs inline on a customer-facing payment
 * endpoint — a logging failure must never break the intent response).
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { recordCheckoutStepReached, CHECKOUT_KIND } = require('../services/estimate-checkout-events');

function makeBuilder({ failWith } = {}) {
  const b = { calls: {} };
  b.insert = jest.fn((payload) => { b.calls.insert = payload; return b; });
  b.onConflict = jest.fn((cols) => { b.calls.onConflict = cols; return b; });
  b.merge = jest.fn((payload) => { b.calls.merge = payload; return b; });
  b.then = (resolve, reject) => (failWith
    ? Promise.reject(failWith).then(resolve, reject)
    : Promise.resolve(1).then(resolve, reject));
  return b;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('upserts one row per (estimate, kind), bumping updated_at on re-reach', async () => {
  const b = makeBuilder();
  db.mockReturnValue(b);

  const ok = await recordCheckoutStepReached('est-1', CHECKOUT_KIND.RECURRING_CARD, 'seti_123');

  expect(ok).toBe(true);
  expect(db).toHaveBeenCalledWith('estimate_checkout_events');
  expect(b.calls.insert).toEqual({
    estimate_id: 'est-1',
    kind: 'recurring_card',
    setup_intent_id: 'seti_123',
  });
  expect(b.calls.onConflict).toEqual(['estimate_id', 'kind']);
  expect(b.calls.merge).toEqual({
    setup_intent_id: 'seti_123',
    updated_at: 'NOW()',
  });
});

test('never throws on a database error — logs and returns false', async () => {
  db.mockReturnValue(makeBuilder({ failWith: new Error('relation does not exist') }));

  await expect(
    recordCheckoutStepReached('est-1', CHECKOUT_KIND.CARD_HOLD, 'seti_456'),
  ).resolves.toBe(false);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('log skipped for estimate est-1'),
  );
});

test('no-ops without an estimate id or kind', async () => {
  expect(await recordCheckoutStepReached(null, 'card_hold', 'x')).toBe(false);
  expect(await recordCheckoutStepReached('est-1', null, 'x')).toBe(false);
  expect(db).not.toHaveBeenCalled();
});
