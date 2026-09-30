/**
 * tryAcquireScheduledInvoiceMintLock (server/services/scheduled-invoice-mint.js)
 * — the non-blocking sibling of acquireScheduledInvoiceMintLock, added for
 * the 'following' sibling price propagation (owner ruling 2026-09-28,
 * pre-push audit P1): a caller that already holds one visit's mint lock
 * must never BLOCK waiting on another's — that's a real ABBA deadlock
 * against a second transaction acquiring the same two locks in the
 * opposite order. This function must never block, must return a boolean,
 * and must use the SAME lock key derivation as the blocking form.
 */
const {
  acquireScheduledInvoiceMintLock,
  tryAcquireScheduledInvoiceMintLock,
  SCHEDULED_SERVICE_INVOICE_MINT_LOCK,
} = require('../services/scheduled-invoice-mint');

function fakeTrx(rawResult) {
  const calls = [];
  return {
    raw: jest.fn(async (sql, params) => { calls.push({ sql, params }); return rawResult; }),
    _calls: calls,
  };
}

test('returns true when pg_try_advisory_xact_lock reports the lock acquired', async () => {
  const trx = fakeTrx({ rows: [{ acquired: true }] });
  await expect(tryAcquireScheduledInvoiceMintLock(trx, 'visit-1')).resolves.toBe(true);
});

test('returns false when pg_try_advisory_xact_lock reports the lock already held elsewhere — never throws, never blocks', async () => {
  const trx = fakeTrx({ rows: [{ acquired: false }] });
  await expect(tryAcquireScheduledInvoiceMintLock(trx, 'visit-1')).resolves.toBe(false);
});

test('a malformed/empty result is treated as NOT acquired (fail-closed — never a truthy default)', async () => {
  await expect(tryAcquireScheduledInvoiceMintLock(fakeTrx(undefined), 'visit-1')).resolves.toBe(false);
  await expect(tryAcquireScheduledInvoiceMintLock(fakeTrx({}), 'visit-1')).resolves.toBe(false);
  await expect(tryAcquireScheduledInvoiceMintLock(fakeTrx({ rows: [] }), 'visit-1')).resolves.toBe(false);
});

test('uses the SAME lock key namespace and id as the blocking acquire — byte-identical, or the two stop contending', async () => {
  const trx = fakeTrx({ rows: [{ acquired: true }] });
  await tryAcquireScheduledInvoiceMintLock(trx, 'visit-42');
  const tryParams = trx._calls[0].params;

  const blockingTrx = { raw: jest.fn(async () => {}) };
  await acquireScheduledInvoiceMintLock(blockingTrx, 'visit-42');
  const blockingParams = blockingTrx.raw.mock.calls[0][1];

  expect(tryParams).toEqual(blockingParams);
  expect(tryParams[0]).toBe(SCHEDULED_SERVICE_INVOICE_MINT_LOCK);
  expect(tryParams[1]).toBe('visit-42');
});

test('the SQL is the non-blocking pg_try_advisory_xact_lock form, not the blocking one', async () => {
  const trx = fakeTrx({ rows: [{ acquired: true }] });
  await tryAcquireScheduledInvoiceMintLock(trx, 'visit-1');
  expect(trx._calls[0].sql).toMatch(/pg_try_advisory_xact_lock/);
  expect(trx._calls[0].sql).not.toMatch(/pg_advisory_xact_lock\(/); // not the blocking call as a substring escape hatch
});
