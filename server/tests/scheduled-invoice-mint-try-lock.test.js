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
  acquireScheduledMintLockChain,
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

// B08: a membership-dues mint holds the customer FOR SHARE (not FOR KEY SHARE)
// through its insert so the billing terms it judged cannot change under it. The
// customer lock stays BEFORE the visit-row lock either way.
describe('acquireScheduledMintLockChain — customer lock strength', () => {
  function chainTrx() {
    const order = [];
    const visitQb = {
      where: jest.fn(() => visitQb),
      forUpdate: jest.fn(() => { order.push('visit FOR UPDATE'); return visitQb; }),
      first: jest.fn(async () => ({ id: 'visit-1', status: 'confirmed' })),
    };
    const trx = jest.fn(() => visitQb);
    trx.raw = jest.fn(async (sql) => { order.push(String(sql)); return { rows: [] }; });
    trx._order = order;
    return trx;
  }

  test('default: FOR KEY SHARE on the customer, ahead of the visit row lock', async () => {
    const trx = chainTrx();
    await acquireScheduledMintLockChain(trx, { scheduledServiceId: 'visit-1', customerId: 'cust-1' });
    const customerAt = trx._order.findIndex((o) => /FROM customers WHERE id = \? FOR KEY SHARE$/.test(o));
    expect(customerAt).toBeGreaterThanOrEqual(0);
    expect(customerAt).toBeLessThan(trx._order.indexOf('visit FOR UPDATE'));
  });

  test("customerLock 'share' (dues mint): FOR SHARE on the customer, still ahead of the visit row lock — with and without a known customer id", async () => {
    for (const customerId of ['cust-1', null]) {
      const trx = chainTrx();
      await acquireScheduledMintLockChain(trx, { scheduledServiceId: 'visit-1', customerId, customerLock: 'share' });
      const customerAt = trx._order.findIndex((o) => /FROM customers WHERE id = .* FOR SHARE$/.test(o));
      expect(customerAt).toBeGreaterThanOrEqual(0);
      expect(trx._order.some((o) => /FOR KEY SHARE/.test(o))).toBe(false);
      expect(customerAt).toBeLessThan(trx._order.indexOf('visit FOR UPDATE'));
    }
  });
});
