/**
 * Combined full-balance payment (GATE_PAY_INCLUDE_BALANCE) — pure-logic
 * contract tests for the allocation codec and ownership rules the money
 * seams (mint / quote / finalize / confirm / webhook settle) all share.
 * The DB-backed selection + settle paths are exercised through the route
 * suites; these pin the invariants that make a combined PI unambiguous:
 * cents-exact allocation totals, roundtrip-stable metadata encoding, and
 * sibling ownership via allocation membership.
 */

const {
  buildAllocation,
  allocationTotalCents,
  encodeAllocation,
  parseCombinedAllocation,
  isCombinedPiMetadata,
  paymentIntentOwnsInvoice,
  amountDueCents,
  MAX_COMBINED_SIBLINGS,
} = require('../services/pay-combined');

const inv = (id, number, total, credit = 0) => ({
  id, invoice_number: number, total, credit_applied: credit,
});

describe('pay-combined allocation codec', () => {
  const anchor = inv('aaaaaaaa-0000-0000-0000-000000000001', 'WPC-2026-0378', 105.30);
  const sibling = inv('bbbbbbbb-0000-0000-0000-000000000002', 'WPC-2026-0316', 44.55);

  test('buildAllocation is anchor-first with cents-exact remainders', () => {
    const alloc = buildAllocation(anchor, [sibling]);
    expect(alloc).toEqual([
      { invoiceId: anchor.id, invoiceNumber: 'WPC-2026-0378', cents: 10530, serviceDate: null, dueDate: null },
      { invoiceId: sibling.id, invoiceNumber: 'WPC-2026-0316', cents: 4455, serviceDate: null, dueDate: null },
    ]);
    expect(allocationTotalCents(alloc)).toBe(14985);
  });

  test('remainder nets credit_applied in integer cents (no float drift)', () => {
    // 117.00 − 11.70 credit — the float-subtraction shape that produces
    // 105.30000000000001 in naive math.
    expect(amountDueCents(inv('x', 'N', 117.00, 11.70))).toBe(10530);
  });

  test('encode → parse roundtrip preserves ids and cents', () => {
    const alloc = buildAllocation(anchor, [sibling]);
    const encoded = encodeAllocation(alloc);
    expect(encoded).toBe(`${anchor.id}:10530,${sibling.id}:4455`);
    expect(parseCombinedAllocation({ combined_allocation: encoded })).toEqual([
      { invoiceId: anchor.id, cents: 10530 },
      { invoiceId: sibling.id, cents: 4455 },
    ]);
  });

  test('encoded allocation at the sibling cap fits Stripe metadata (500 chars)', () => {
    const rows = Array.from({ length: MAX_COMBINED_SIBLINGS }, (_, i) =>
      inv(`cccccccc-0000-0000-0000-00000000000${i}`, `WPC-2026-0${100 + i}`, 9999.99));
    const encoded = encodeAllocation(buildAllocation(anchor, rows));
    expect(encoded.length).toBeLessThanOrEqual(500);
  });

  test('absent allocation parses as null (single-invoice PI)', () => {
    expect(parseCombinedAllocation({})).toBeNull();
    expect(parseCombinedAllocation({ combined_allocation: '' })).toBeNull();
    expect(parseCombinedAllocation(undefined)).toBeNull();
    expect(isCombinedPiMetadata({ combined_allocation: '' })).toBe(false);
  });

  test('present-but-malformed allocation THROWS — a combined PI must never fall back to single-invoice settle', () => {
    expect(() => parseCombinedAllocation({ combined_allocation: 'not-an-allocation' })).toThrow();
    expect(() => parseCombinedAllocation({ combined_allocation: `${anchor.id}:-5` })).toThrow();
    expect(() => parseCombinedAllocation({ combined_allocation: `${anchor.id}:1.5` })).toThrow();
    expect(() => parseCombinedAllocation({ combined_allocation: ':100' })).toThrow();
  });

  test('zero-cent shares fail closed — no invoice may "settle" on money that never covered it', () => {
    expect(() => parseCombinedAllocation({ combined_allocation: `${anchor.id}:0` })).toThrow();
  });

  test('duplicate invoice ids fail closed — one invoice must never absorb two shares', () => {
    expect(() => parseCombinedAllocation({
      combined_allocation: `${anchor.id}:100,${anchor.id}:200`,
    })).toThrow(/Duplicate invoice/);
  });

  test('allocations above the anchor+cap bound fail closed', () => {
    const over = Array.from({ length: MAX_COMBINED_SIBLINGS + 2 }, (_, i) => `id-${i}:100`).join(',');
    expect(() => parseCombinedAllocation({ combined_allocation: over })).toThrow(/bound/);
  });
});

describe('paymentIntentOwnsInvoice', () => {
  const anchorId = 'aaaaaaaa-0000-0000-0000-000000000001';
  const siblingId = 'bbbbbbbb-0000-0000-0000-000000000002';
  const meta = {
    waves_invoice_id: anchorId,
    combined_allocation: `${anchorId}:10530,${siblingId}:4455`,
  };

  test('anchor owns via waves_invoice_id', () => {
    expect(paymentIntentOwnsInvoice(meta, anchorId)).toBe(true);
  });

  test('sibling owns via allocation membership', () => {
    expect(paymentIntentOwnsInvoice(meta, siblingId)).toBe(true);
  });

  test('an unrelated invoice never owns', () => {
    expect(paymentIntentOwnsInvoice(meta, 'dddddddd-0000-0000-0000-000000000009')).toBe(false);
  });

  test('single-invoice PI: only the stamped invoice owns', () => {
    const single = { waves_invoice_id: anchorId };
    expect(paymentIntentOwnsInvoice(single, anchorId)).toBe(true);
    expect(paymentIntentOwnsInvoice(single, siblingId)).toBe(false);
  });

  test('malformed allocation fails CLOSED for non-anchor invoices', () => {
    const bad = { waves_invoice_id: anchorId, combined_allocation: 'garbage' };
    expect(paymentIntentOwnsInvoice(bad, siblingId)).toBe(false);
    expect(paymentIntentOwnsInvoice(bad, anchorId)).toBe(true);
  });
});
