// Codex r1 P1 (dunning-combined-message lane): selfPayAtDispatchMany is
// the multi-invoice provider-boundary ownership check a combined dunning
// touch's SMS/push and email legs both run immediately before dispatch —
// every included invoice must still be self-pay, not just one. Fails
// closed on the first ineligible or unreadable invoice.
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

describe('selfPayAtDispatchMany', () => {
  test('ok:true when every included invoice is self-pay and not withdrawn', async () => {
    const db = fakeDatabase([
      { id: 'inv-A', payer_id: null, scheduled_send_error: null },
      { id: 'inv-B', payer_id: null, scheduled_send_error: null },
    ]);
    const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
    await expect(check()).resolves.toEqual({ ok: true });
  });

  test('ok:false when ONE non-anchor invoice moved to a third-party payer — not just the first id', async () => {
    const db = fakeDatabase([
      { id: 'inv-A', payer_id: null, scheduled_send_error: null },
      { id: 'inv-B', payer_id: 'payer-1', scheduled_send_error: null },
    ]);
    const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVOICE_PAYER_BILLED');
    expect(result.reason).toContain('inv-B');
  });

  test('ok:false when a non-anchor invoice was withdrawn (payer_billed: stamp) even with a null payer_id', async () => {
    const db = fakeDatabase([
      { id: 'inv-A', payer_id: null, scheduled_send_error: null },
      { id: 'inv-B', payer_id: null, scheduled_send_error: 'payer_billed:payer-1' },
    ]);
    const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVOICE_PAYER_BILLED');
  });

  test('ok:false (fail closed) when an included invoice could not be re-read', async () => {
    const db = fakeDatabase([
      { id: 'inv-A', payer_id: null, scheduled_send_error: null },
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
    const db = fakeDatabase([{ id: 'inv-A', payer_id: null, scheduled_send_error: null }]);
    const check = selfPayAtDispatchMany(['inv-A', 'inv-A', 'inv-A'], db);
    await expect(check()).resolves.toEqual({ ok: true });
  });

  // Codex r2 P1: the combined dunning message freezes each invoice's
  // amount-due cents (resolveCombinedPayLink's lineCents) well before this
  // check runs at the actual provider boundary. A payment, credit
  // application, or edit landing in that window must refuse the send
  // rather than let it go out quoting a stale amount.
  describe('expectedCents (third arg) — revalidates each invoice\'s LIVE amount due', () => {
    test('ok:true when every invoice\'s live amount due still matches its snapshotted cents', async () => {
      const db = fakeDatabase([
        { id: 'inv-A', payer_id: null, scheduled_send_error: null, total: 150, credit_applied: 0 },
        { id: 'inv-B', payer_id: null, scheduled_send_error: null, total: 80.5, credit_applied: 0.5 },
      ]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db, { 'inv-A': 15000, 'inv-B': 8000 });
      await expect(check()).resolves.toEqual({ ok: true });
    });

    test('ok:false, retryable, when a NON-anchor invoice\'s live amount due changed since the message quoted it', async () => {
      const db = fakeDatabase([
        { id: 'inv-A', payer_id: null, scheduled_send_error: null, total: 150, credit_applied: 0 },
        // A payment landed on inv-B between the quote and this check —
        // amount due dropped from $80.00 to $30.00.
        { id: 'inv-B', payer_id: null, scheduled_send_error: null, total: 80, credit_applied: 50 },
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
        { id: 'inv-A', payer_id: null, scheduled_send_error: null, total: 200, credit_applied: 0 },
        { id: 'inv-B', payer_id: null, scheduled_send_error: null, total: 80, credit_applied: 0 },
      ]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db, { 'inv-A': 15000, 'inv-B': 8000 });
      const result = await check();
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVOICE_AMOUNT_CHANGED');
      expect(result.retryable).toBe(true);
      expect(result.reason).toContain('inv-A');
    });

    test('a third-party-payer refusal is still checked FIRST — ownership, not amount, is the reported reason', async () => {
      const db = fakeDatabase([
        { id: 'inv-A', payer_id: 'payer-1', scheduled_send_error: null, total: 999, credit_applied: 0 },
        { id: 'inv-B', payer_id: null, scheduled_send_error: null, total: 80, credit_applied: 0 },
      ]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db, { 'inv-A': 15000, 'inv-B': 8000 });
      const result = await check();
      expect(result.code).toBe('INVOICE_PAYER_BILLED');
    });

    test('omitted (no third arg): byte-identical to before — no amount check runs even when total/credit_applied are absent from the row', async () => {
      const db = fakeDatabase([
        { id: 'inv-A', payer_id: null, scheduled_send_error: null },
        { id: 'inv-B', payer_id: null, scheduled_send_error: null },
      ]);
      const check = selfPayAtDispatchMany(['inv-A', 'inv-B'], db);
      await expect(check()).resolves.toEqual({ ok: true });
    });
  });
});
