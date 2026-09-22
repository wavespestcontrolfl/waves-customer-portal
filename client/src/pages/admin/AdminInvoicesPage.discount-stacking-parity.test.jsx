/**
 * Slice 5 of #4405 — Codex round-2 pre-push audit P0: this form's own
 * discount preview (computeInvoiceLineDiscountTotal, AdminInvoicesPage.jsx)
 * still computed additively while server/services/invoice.js's
 * InvoiceService.create now compounds — $111 at 10%+5% previewed $94.35 but
 * saved $94.90, and Create-and-send could immediately deliver the higher
 * invoice the operator never saw.
 *
 * This file drives the SAME fixture matrix
 * invoice-create-discount-stacking-parity.test.js (server) uses through the
 * form's own pure preview function, asserting the identical totals both
 * gate states already assert server-side — a literal cross-package JSON
 * fixture isn't shared (client/ and server/tests/ have no existing shared-
 * fixture convention), so the numbers are duplicated deliberately, the same
 * way discountStack.server-parity.test.js duplicates its own worked
 * examples against the server module it imports directly.
 *
 * This form has no document-level (invoice-wide) discount picker — every
 * discount is a per-line pick — so a fixture with N discounts against one
 * subtotal models as N per-line picks on a single line whose gross equals
 * that subtotal; stacking N document-wide terms on a one-line document and
 * stacking N line-scoped terms on that same line's own gross are the
 * identical computation, so the server fixture's expected totals apply
 * unchanged.
 */
import { describe, expect, test } from "vitest";
import {
  computeInvoiceLineDiscountTotal,
  invoiceDiscountItemTerm,
} from "./AdminInvoicesPage.jsx";

let nextId = 0;
function discountRow(overrides) {
  return {
    id: `discount-${nextId++}`,
    discount_type: "percentage",
    amount: 10,
    max_discount_dollars: null,
    is_active: true,
    show_in_invoices: true,
    ...overrides,
  };
}

// One service line ("line-1") carrying every fixture discount as a
// per-line pick (discount_for: "line-1") — see the file header for why
// this is equivalent to the server fixture's document-level picks.
function lineItemsFor(subtotal, discountRows) {
  return [
    { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: subtotal },
    ...discountRows.map((d, i) => ({
      client_id: `disc-${i}`,
      _kind: "discount",
      discount_id: d.id,
      discount_for: "line-1",
      description: d.name || "Discount",
      quantity: 1,
      unit_price: -1, // the form's own stored guess — irrelevant here; the
      // total is recomputed from discount_id + availableDiscounts, never
      // trusted off this stored value (mirrors the server's own fresh-pick
      // contract: a submitted amount is never trusted for a catalog pick).
    })),
  ];
}

// The exact fixture matrix invoice-create-discount-stacking-parity.test.js
// (server) uses, each paired with the total that test asserts.
const FIXTURE_MATRIX = [
  { subtotal: 111, discounts: [{ discount_type: "percentage", amount: 10 }, { discount_type: "percentage", amount: 5 }], expected: 16.1 },
  { subtotal: 111, discounts: [{ discount_type: "percentage", amount: 10 }, { discount_type: "fixed_amount", amount: 25 }], expected: 33.6 },
  { subtotal: 100, discounts: [{ discount_type: "percentage", amount: 50, max_discount_dollars: 10 }, { discount_type: "percentage", amount: 10 }], expected: 19 },
  { subtotal: 250, discounts: [
    { discount_type: "fixed_amount", amount: 20 },
    { discount_type: "percentage", amount: 15 },
    { discount_type: "percentage", amount: 5, max_discount_dollars: 8 },
  ], expected: 62.5 },
  { subtotal: 60, discounts: [{ discount_type: "fixed_amount", amount: 15 }], expected: 15 },
];

describe("AdminInvoicesPage discount preview — gate ON compounds, matching the server exactly", () => {
  test.each(FIXTURE_MATRIX)("subtotal $%p compounds to \\$%p", ({ subtotal, discounts, expected }) => {
    const rows = discounts.map((d) => discountRow(d));
    const lineItems = lineItemsFor(subtotal, rows);
    const total = computeInvoiceLineDiscountTotal({
      lineItems,
      availableDiscounts: rows,
      stackingEnabled: true,
    });
    expect(total).toBe(expected);
  });

  test("the owner ruling worked example #1: 10% then 5% off $111 compounds to $16.10, never the additive $16.65", () => {
    const rows = [discountRow({ discount_type: "percentage", amount: 10 }), discountRow({ discount_type: "percentage", amount: 5 })];
    const total = computeInvoiceLineDiscountTotal({
      lineItems: lineItemsFor(111, rows),
      availableDiscounts: rows,
      stackingEnabled: true,
    });
    expect(total).toBe(16.1);
  });

  test("the owner ruling worked example #2: 10% plus a $25 credit off $111 is $33.60, never the additive $36.10", () => {
    const rows = [discountRow({ discount_type: "percentage", amount: 10 }), discountRow({ discount_type: "fixed_amount", amount: 25 })];
    const total = computeInvoiceLineDiscountTotal({
      lineItems: lineItemsFor(111, rows),
      availableDiscounts: rows,
      stackingEnabled: true,
    });
    expect(total).toBe(33.6);
  });

  test("a fresh pick's ADD-TIME sizing (invoiceDiscountItemTerm + the client engine) also compounds on what an existing sibling pick already left", () => {
    const discountRowById = new Map([
      ["ten-pct", discountRow({ id: "ten-pct", discount_type: "percentage", amount: 10 })],
      ["five-pct", discountRow({ id: "five-pct", discount_type: "percentage", amount: 5 })],
    ]);
    const existing = { discount_id: "ten-pct", discount_for: "line-1" };
    const fresh = { discount_id: "five-pct", discount_for: "line-1" };
    const terms = [existing, fresh].map((item) => invoiceDiscountItemTerm(item, discountRowById));
    expect(terms).toEqual([
      { discountType: "percentage", amount: 10, maxDiscountDollars: null },
      { discountType: "percentage", amount: 5, maxDiscountDollars: null },
    ]);
  });
});

describe("AdminInvoicesPage discount preview — gate OFF stays additive, byte-identical to before this lane", () => {
  test.each(FIXTURE_MATRIX)("subtotal $%p", ({ subtotal, discounts }) => {
    const rows = discounts.map((d) => discountRow(d));
    // lineItemsFor's own discount items each carry unit_price: -1 — gate
    // off never reads discount_id/catalog rows at all, it sums each item's
    // OWN already-set amount, exactly as the pre-lane form did.
    const total = computeInvoiceLineDiscountTotal({
      lineItems: lineItemsFor(subtotal, rows),
      availableDiscounts: rows,
      stackingEnabled: false,
    });
    expect(total).toBe(discounts.length);
  });

  test("the owner ruling worked example #1, gate off: 10% then 5% previews the additive $16.65, never the compounded $16.10", () => {
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 111 },
      { client_id: "d1", _kind: "discount", discount_id: "ten-pct", discount_for: "line-1", quantity: 1, unit_price: -11.1, amount: -11.1 },
      { client_id: "d2", _kind: "discount", discount_id: "five-pct", discount_for: "line-1", quantity: 1, unit_price: -5.55, amount: -5.55 },
    ];
    const total = computeInvoiceLineDiscountTotal({
      lineItems,
      availableDiscounts: [],
      stackingEnabled: false,
    });
    expect(total).toBe(16.65);
  });
});
