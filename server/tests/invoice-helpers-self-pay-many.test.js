// Codex round-4 P2 (dunning-combined-message lane): selfPayAtDispatchMany
// is the multi-invoice provider-boundary eligibility check a combined
// dunning touch's SMS/push and email legs both run immediately before
// dispatch — every included invoice must still be self-pay AND still
// collectible (not terminal) AND still the expected customer's, not just
// the anchor. Fails closed on the first ineligible or unreadable invoice.
// Ported from the closed wide dunning-unification branch
// (~/wt-dunning-combined-20260928, HEAD server/services/invoice-helpers.js)
// with its own Codex r3 P1 finding applied: that branch's version never
// rejected a terminal invoice (paid/void/processing/…) — only payer_id and
// the withdrawal stamp — so a sibling that settled between the snapshot
// and dispatch would still be quoted. This port adds the terminal check
// and an explicit expected-customer check.
const { selfPayAtDispatchMany } = require('../services/invoice-helpers');

// A minimal fake knex-like query builder over an in-memory invoice list,
// supporting exactly the whereIn(...).select(...) shape the function uses.
function fakeDatabase(invoiceRows) {
  return (table) => {
    if (table !== 'invoices') throw new Error(`unexpected table: ${table}`);
    return {
      whereIn: (col, ids) => ({
        select: async () => invoiceRows.filter((row) => ids.map(String).includes(String(row.id))),
      }),
    };
  };
}

function row(overrides = {}) {
  return { id: 'inv-A', customer_id: 'cust-1', status: 'sent', payer_id: null, scheduled_send_error: null, ...overrides };
}

describe('selfPayAtDispatchMany', () => {
  test('ok:true when every included invoice is self-pay, collectible, and not withdrawn', async () => {
    const db = fakeDatabase([row({ id: 'inv-A' }), row({ id: 'inv-B' })]);
    const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
    await expect(check()).resolves.toEqual({ ok: true });
  });

  test('ok:false when ONE non-anchor invoice moved to a third-party payer — not just the first id', async () => {
    const db = fakeDatabase([row({ id: 'inv-A' }), row({ id: 'inv-B', payer_id: 'payer-1' })]);
    const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVOICE_PAYER_BILLED');
    expect(result.reason).toContain('inv-B');
  });

  test('ok:false when a non-anchor invoice was withdrawn (payer_billed: stamp) even with a null payer_id', async () => {
    const db = fakeDatabase([row({ id: 'inv-A' }), row({ id: 'inv-B', scheduled_send_error: 'payer_billed:payer-1' })]);
    const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVOICE_PAYER_BILLED');
  });

  // Codex r3 P1 on the closed branch this is ported from — the fix applied
  // here.
  describe('terminal invoices (Codex r3 P1 fix applied on port)', () => {
    test.each(['paid', 'prepaid', 'void', 'processing', 'refunded', 'canceled', 'cancelled'])(
      'ok:false when a non-anchor invoice went %s between the snapshot and dispatch',
      async (status) => {
        const db = fakeDatabase([row({ id: 'inv-A' }), row({ id: 'inv-B', status })]);
        const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
        const result = await check();
        expect(result.ok).toBe(false);
        expect(result.code).toBe('INVOICE_TERMINAL');
        expect(result.reason).toContain('inv-B');
      },
    );

    test('ok:false when the ANCHOR itself went terminal, not just a sibling', async () => {
      const db = fakeDatabase([row({ id: 'inv-A', status: 'paid' }), row({ id: 'inv-B' })]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
      const result = await check();
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVOICE_TERMINAL');
      expect(result.reason).toContain('inv-A');
    });

    test('a terminal refusal is checked BEFORE ownership — reported first regardless of order', async () => {
      const db = fakeDatabase([row({ id: 'inv-A' }), row({ id: 'inv-B', status: 'paid', payer_id: 'payer-1' })]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
      const result = await check();
      expect(result.code).toBe('INVOICE_TERMINAL');
    });
  });

  describe('expected customer (Codex round-4 P2: "same customer" check)', () => {
    test('ok:false when a non-anchor invoice no longer belongs to the expected customer', async () => {
      const db = fakeDatabase([row({ id: 'inv-A' }), row({ id: 'inv-B', customer_id: 'cust-2' })]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db, null, 'cust-1');
      const result = await check();
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVOICE_CUSTOMER_MISMATCH');
      expect(result.reason).toContain('inv-B');
    });

    test('omitted expectedCustomerId: no ownership-by-customer check runs', async () => {
      const db = fakeDatabase([row({ id: 'inv-A' }), row({ id: 'inv-B', customer_id: 'cust-2' })]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
      await expect(check()).resolves.toEqual({ ok: true });
    });
  });

  test('ok:false (fail closed) when an included invoice could not be re-read', async () => {
    const db = fakeDatabase([
      row({ id: 'inv-A' }),
      // inv-B missing entirely from the re-read result.
    ]);
    const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVOICE_UNREADABLE');
    expect(result.reason).toContain('inv-B');
  });

  test('ok:false (fail closed) on an empty invoice list', async () => {
    const db = fakeDatabase([]);
    const check = selfPayAtDispatchMany([], db);
    const result = await check();
    expect(result.ok).toBe(false);
  });

  test('ok:false (fail closed) when the query throws', async () => {
    const db = () => ({ whereIn: () => ({ select: async () => { throw new Error('connection lost'); } }) });
    const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVOICE_UNREADABLE');
  });

  test('deduplicates repeated invoice ids without affecting the verdict', async () => {
    const db = fakeDatabase([row({ id: 'inv-A' })]);
    const check = selfPayAtDispatchMany(['inv-A', 'inv-A', 'inv-A'], db);
    await expect(check()).resolves.toEqual({ ok: true });
  });

  // Codex r2 P1 on the closed branch this is ported from: the combined
  // dunning message freezes each invoice's amount-due cents
  // (resolveCombinedVariant's own lineCents) well before this check runs
  // at the actual provider boundary. A payment, credit application, or
  // edit landing in that window must refuse the send rather than let it go
  // out quoting a stale amount.
  describe('expectedCents (third arg) — revalidates each invoice\'s LIVE amount due', () => {
    test('ok:true when every invoice\'s live amount due still matches its snapshotted cents', async () => {
      const db = fakeDatabase([
        row({ id: 'inv-A', total: 150, credit_applied: 0 }),
        row({ id: 'inv-B', total: 80.5, credit_applied: 0.5 }),
      ]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db, { 'inv-A': 15000, 'inv-B': 8000 });
      await expect(check()).resolves.toEqual({ ok: true });
    });

    test('ok:false, retryable, when a NON-anchor invoice\'s live amount due changed since the message quoted it', async () => {
      const db = fakeDatabase([
        row({ id: 'inv-A', total: 150, credit_applied: 0 }),
        // A payment landed on inv-B between the quote and this check —
        // amount due dropped from $80.00 to $30.00.
        row({ id: 'inv-B', total: 80, credit_applied: 50 }),
      ]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db, { 'inv-A': 15000, 'inv-B': 8000 });
      const result = await check();
      expect(result).toEqual({
        ok: false,
        code: 'INVOICE_AMOUNT_CHANGED',
        retryable: true,
        reason: expect.stringContaining('inv-B'),
      });
    });

    test('ok:false, retryable, on the ANCHOR invoice too, not just a sibling', async () => {
      const db = fakeDatabase([
        row({ id: 'inv-A', total: 200, credit_applied: 0 }),
        row({ id: 'inv-B', total: 80, credit_applied: 0 }),
      ]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db, { 'inv-A': 15000, 'inv-B': 8000 });
      const result = await check();
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVOICE_AMOUNT_CHANGED');
      expect(result.retryable).toBe(true);
      expect(result.reason).toContain('inv-A');
    });

    test('a third-party-payer refusal is still checked before amount — ownership, not amount, is the reported reason', async () => {
      const db = fakeDatabase([
        row({ id: 'inv-A', payer_id: 'payer-1', total: 999, credit_applied: 0 }),
        row({ id: 'inv-B', total: 80, credit_applied: 0 }),
      ]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db, { 'inv-A': 15000, 'inv-B': 8000 });
      const result = await check();
      expect(result.code).toBe('INVOICE_PAYER_BILLED');
    });

    test('omitted (no third arg): no amount check runs even when total/credit_applied are absent from the row', async () => {
      const db = fakeDatabase([row({ id: 'inv-A' }), row({ id: 'inv-B' })]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
      await expect(check()).resolves.toEqual({ ok: true });
    });
  });
});
