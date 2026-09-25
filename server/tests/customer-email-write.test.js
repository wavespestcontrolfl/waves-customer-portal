/**
 * services/customer-email-write.js — the Customer 360 operator email write
 * as a callable (PR #4802 round 8: the triage read-back confirm delegates to
 * it). Pins the sequence the Customer 360 edit uses: customers row FOR
 * UPDATE → shared address key → cross-account refusal (under the key) →
 * diff-gated write → fanout in the same transaction. The fanout itself is
 * mocked (customer-email-fanout.test.js owns it). Synthetic example.com
 * addresses only.
 */
const mockPropagateCustomerEmailChange = jest.fn(async () => ({ pendingConfirmation: { token: 't' } }));
jest.mock('../services/customer-email-fanout', () => ({
  propagateCustomerEmailChange: mockPropagateCustomerEmailChange,
}));

const { applyOperatorCustomerEmail, findCrossAccountEmailConflict } = require('../services/customer-email-write');

function fakeTrx(customers, { isTransaction = true } = {}) {
  const order = [];
  const rows = customers.map((c) => ({ ...c }));
  const trx = (table) => {
    if (table !== 'customers') throw new Error(`unexpected table ${table}`);
    const preds = [];
    const api = {
      where(obj) { preds.push((r) => Object.entries(obj).every(([k, v]) => r[k] === v)); return api; },
      whereNull(col) { preds.push((r) => r[col] == null); return api; },
      whereNot(obj) { preds.push((r) => Object.entries(obj).every(([k, v]) => r[k] !== v)); return api; },
      whereRaw(sql, [value]) {
        const col = /LOWER\((\w+)\)/.exec(sql)[1];
        if (/SPLIT_PART/.test(sql)) {
          // The Google mailbox-identity predicate (GOOGLE_MAILBOX_SQL),
          // evaluated with the shared JS identity it mirrors.
          const { googleMailboxIdentity } = jest.requireActual('../utils/customer-comms-lock');
          preds.push((r) => googleMailboxIdentity(String(r[col] ?? '').trim().toLowerCase()) === `${value}@gmail.com`);
          return api;
        }
        preds.push((r) => String(r[col] ?? '').toLowerCase() === value);
        return api;
      },
      forUpdate() { order.push('row-lock'); return api; },
      first: async () => { const r = rows.find((x) => preds.every((p) => p(x))); return r ? { ...r } : undefined; },
      select: async () => rows.filter((x) => preds.every((p) => p(x))),
      update: async (patch) => {
        const hit = rows.filter((x) => preds.every((p) => p(x)));
        if (Object.prototype.hasOwnProperty.call(patch, 'email')) order.push('email-write');
        hit.forEach((x) => Object.assign(x, patch));
        return hit.length;
      },
    };
    return api;
  };
  trx.isTransaction = isTransaction;
  trx.raw = async (sql, bindings) => { order.push(`key:${bindings[0]}`); };
  return { trx, rows, order };
}

beforeEach(() => jest.clearAllMocks());

describe('applyOperatorCustomerEmail', () => {
  test('row lock → address key → write → fanout, and hands the deferred sends back', async () => {
    const { trx, rows, order } = fakeTrx([{ id: 'c1', email: 'old@example.com', account_id: 'a1' }]);
    const result = await applyOperatorCustomerEmail(trx, { customerId: 'c1', email: ' New@Example.com ', source: 'triage_confirm' });
    expect(result.outcome).toBe('changed');
    expect(result.emailSync).toEqual({ pendingConfirmation: { token: 't' } });
    expect(order).toEqual(['row-lock', 'key:customer-email:new@example.com', 'email-write']);
    expect(rows[0].email).toBe('new@example.com');
    expect(mockPropagateCustomerEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ id: 'c1', email: 'old@example.com' }),
        after: expect.objectContaining({ id: 'c1', email: 'new@example.com' }),
        source: 'triage_confirm',
      }),
      trx,
    );
  });

  test('refuses an address another account holds — decided under the key, before any write', async () => {
    const { trx, rows, order } = fakeTrx([
      { id: 'c1', email: null, account_id: 'a1' },
      { id: 'c2', email: 'taken@example.com', account_id: 'a2', deleted_at: null },
    ]);
    const result = await applyOperatorCustomerEmail(trx, { customerId: 'c1', email: 'taken@example.com' });
    expect(result).toEqual({ outcome: 'email_in_use', conflict: { id: 'c2', account_id: 'a2' } });
    expect(order).toEqual(['row-lock', 'key:customer-email:taken@example.com']);
    expect(rows[0].email).toBeNull();
    expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
  });

  test('a same-account sibling and an archived holder do not block', async () => {
    const { trx, rows } = fakeTrx([
      { id: 'c1', email: null, account_id: 'a1' },
      { id: 'c2', email: 'shared@example.com', account_id: 'a1', deleted_at: null },
      { id: 'c3', email: 'shared@example.com', account_id: 'a9', deleted_at: '2026-01-01' },
    ]);
    const result = await applyOperatorCustomerEmail(trx, { customerId: 'c1', email: 'shared@example.com' });
    expect(result.outcome).toBe('changed');
    expect(rows[0].email).toBe('shared@example.com');
  });

  test('an unchanged address is a no-op write (no fanout), still locked and ownership-checked', async () => {
    const { trx, order } = fakeTrx([{ id: 'c1', email: 'Same@Example.com', account_id: 'a1' }]);
    const result = await applyOperatorCustomerEmail(trx, { customerId: 'c1', email: 'same@example.com' });
    expect(result.outcome).toBe('unchanged');
    expect(result.emailSync).toBeNull();
    expect(order).toEqual(['row-lock', 'key:customer-email:same@example.com']);
    expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
  });

  test('a missing customer row reports customer_not_found', async () => {
    const { trx } = fakeTrx([]);
    await expect(applyOperatorCustomerEmail(trx, { customerId: 'nope', email: 'x@example.com' }))
      .resolves.toEqual({ outcome: 'customer_not_found' });
  });

  test('codex round 9: an archived (soft-deleted) customer reports customer_not_found and is never written', async () => {
    const { trx } = fakeTrx([{ id: 'c1', email: null, account_id: 'a1', deleted_at: '2026-01-01' }]);
    await expect(applyOperatorCustomerEmail(trx, { customerId: 'c1', email: 'x@example.com' }))
      .resolves.toEqual({ outcome: 'customer_not_found' });
    expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
  });

  test('refuses to run outside a transaction, and refuses an invalid address', async () => {
    const outside = fakeTrx([{ id: 'c1', email: null }], { isTransaction: false });
    await expect(applyOperatorCustomerEmail(outside.trx, { customerId: 'c1', email: 'x@example.com' }))
      .rejects.toThrow('requires a transaction');
    const inside = fakeTrx([{ id: 'c1', email: null }]);
    await expect(applyOperatorCustomerEmail(inside.trx, { customerId: 'c1', email: 'not-an-email' }))
      .rejects.toThrow('requires a valid email');
  });
});

describe('findCrossAccountEmailConflict', () => {
  test('matches case-insensitively and ignores the customer itself', async () => {
    const { trx } = fakeTrx([
      { id: 'c1', email: 'a@example.com', account_id: 'a1', deleted_at: null },
      { id: 'c2', email: 'A@Example.com', account_id: 'a2', deleted_at: null },
    ]);
    expect(await findCrossAccountEmailConflict(trx, { customerId: 'c1', accountId: 'a1', email: 'a@example.com' }))
      .toMatchObject({ id: 'c2' });
    expect(await findCrossAccountEmailConflict(trx, { customerId: 'c2', accountId: 'a2', email: 'a@example.com' }))
      .toMatchObject({ id: 'c1' });
    expect(await findCrossAccountEmailConflict(trx, { customerId: 'c1', accountId: 'a1', email: '' })).toBeNull();
  });

  test('codex round 10: a Gmail dot/+tag variant of another account\'s mailbox conflicts (same inbox)', async () => {
    const { trx } = fakeTrx([
      { id: 'c1', email: 'mine@example.com', account_id: 'a1', deleted_at: null },
      { id: 'c2', email: 'johndoe@gmail.com', account_id: 'a2', deleted_at: null },
    ]);
    expect(await findCrossAccountEmailConflict(trx, { customerId: 'c1', accountId: 'a1', email: 'john.doe+calls@gmail.com' }))
      .toMatchObject({ id: 'c2' });
    expect(await findCrossAccountEmailConflict(trx, { customerId: 'c1', accountId: 'a1', email: 'John.Doe@googlemail.com' }))
      .toMatchObject({ id: 'c2' });
  });

  test('codex round 10: the Gmail identity still honors same-account siblings, archived holders, and non-Google domains', async () => {
    const { trx } = fakeTrx([
      { id: 'c1', email: 'mine@example.com', account_id: 'a1', deleted_at: null },
      { id: 'c2', email: 'johndoe@gmail.com', account_id: 'a1', deleted_at: null },
      { id: 'c3', email: 'john.doe@gmail.com', account_id: 'a3', deleted_at: '2026-09-01' },
      { id: 'c4', email: 'janedoe@example.com', account_id: 'a4', deleted_at: null },
    ]);
    expect(await findCrossAccountEmailConflict(trx, { customerId: 'c1', accountId: 'a1', email: 'john.doe+x@gmail.com' })).toBeNull();
    // Dots and tags are significant outside Google — no identity match.
    expect(await findCrossAccountEmailConflict(trx, { customerId: 'c1', accountId: 'a1', email: 'jane.doe@example.com' })).toBeNull();
  });
});

describe('applyOperatorCustomerEmail — Gmail mailbox identity (codex round 10)', () => {
  test('refuses john.doe+calls@gmail.com when another account owns johndoe@gmail.com, before any write', async () => {
    const { trx, rows, order } = fakeTrx([
      { id: 'c1', email: 'old@example.com', account_id: 'a1' },
      { id: 'c2', email: 'johndoe@gmail.com', account_id: 'a2' },
    ]);
    const result = await applyOperatorCustomerEmail(trx, { customerId: 'c1', email: 'john.doe+calls@gmail.com' });
    expect(result).toEqual({ outcome: 'email_in_use', conflict: { id: 'c2', account_id: 'a2' } });
    expect(order).not.toContain('email-write');
    expect(rows[0].email).toBe('old@example.com');
    expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
  });
});
