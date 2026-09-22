/**
 * GitHub Codex round 2 on PR #4655 (714f0ca821) — two client findings,
 * addressed per the coordinator's ruling (prepared locally; not yet
 * re-pushed as of this commit).
 */
import { describe, expect, test } from "vitest";
import {
  computeInvoiceLineDiscountTotal,
  invoiceSubmitNeedsStackingCheck,
  repriceLineWithNewDiscountPick,
  stackingProbeMatchesPreview,
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

// P1 (:6296 region — stackingStillFresh): a discount-free save must never
// depend on the stacking-probe endpoint's availability.
describe("invoiceSubmitNeedsStackingCheck — the probe only gates submits that could actually diverge", () => {
  test("no discount line items, gate not known-on: the probe is skipped", () => {
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
    ];
    expect(invoiceSubmitNeedsStackingCheck(lineItems, false)).toBe(false);
  });

  test("a per-line discount pick present: the probe is required", () => {
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
      { client_id: "d1", _kind: "discount", discount_for: "line-1", quantity: 1, unit_price: -10 },
    ];
    expect(invoiceSubmitNeedsStackingCheck(lineItems, false)).toBe(true);
  });

  test("a document-wide (unparented) credit present: the probe is required", () => {
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
      { client_id: "credit-1", _kind: "discount", discount_for: null, quantity: 1, unit_price: -30 },
    ];
    expect(invoiceSubmitNeedsStackingCheck(lineItems, false)).toBe(true);
  });

  test("no discount line items, but the gate is confirmed ON: the probe still runs (belt-and-suspenders)", () => {
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
    ];
    expect(invoiceSubmitNeedsStackingCheck(lineItems, true)).toBe(true);
  });

  // Component-level pins of the full submit contract (probe-failed +
  // no-discount succeeds; probe-failed + discounted refuses) live in
  // AdminInvoicesFoundation.test.jsx, which renders the real create form
  // against a real (mocked) fetch — this file only pins the pure decision
  // function these submit paths gate on.
  test("stackingProbeMatchesPreview still refuses a known:false probe result regardless of this gate (unchanged contract)", () => {
    expect(stackingProbeMatchesPreview({ enabled: false, known: false }, false)).toBe(false);
  });
});

// P1 (repriceLineWithNewDiscountPick region): adding a fresh line pick
// must account for a document-wide credit ALREADY on the invoice, running
// the SAME stackDocumentDiscounts pass server/services/invoice.js's
// stackInvoiceDocumentDiscounts would run on save.
describe("repriceLineWithNewDiscountPick — accounts for an existing document-wide credit", () => {
  test("a $30 unparented credit already on the invoice: adding a fresh 10% line pick on $100 prices it at $7, not the un-interleaved $10", () => {
    const tenPct = discountRow({ discount_type: "percentage", amount: 10 });
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
      { client_id: "credit-1", _kind: "discount", discount_for: null, quantity: 1, unit_price: -30 },
    ];
    const { lineItems: repriced, dollars } = repriceLineWithNewDiscountPick({
      lineItems,
      parentClientId: "line-1",
      newTerm: { discountType: "percentage", amount: 10 },
      discountRowById: new Map([[tenPct.id, tenPct]]),
    });
    // The server's exact numbers: $30 fixed off first (document-wide,
    // reaches the whole document), remaining $70, then 10% of $70 = $7 —
    // never the $10 a single-line-only stack (ignoring the credit) gives.
    expect(dollars).toBe(7);
    // The document-wide credit itself is untouched — it's never a sibling
    // of this line, so repriceLineWithNewDiscountPick correctly leaves it
    // alone (it's summed/interleaved by computeInvoiceLineDiscountTotal on
    // render, not rewritten here).
    const creditItem = repriced.find((i) => i.client_id === "credit-1");
    expect(creditItem.unit_price).toBe(-30);

    // Confirms the aggregate agrees exactly with this per-pick sizing —
    // the same $37 total ($30 + $7) the server's worked example gives.
    const withNewPick = [
      ...repriced,
      { client_id: "d1", _kind: "discount", discount_for: "line-1", discount_id: tenPct.id, quantity: 1, unit_price: -dollars, amount: -dollars },
    ];
    const total = computeInvoiceLineDiscountTotal({
      lineItems: withNewPick,
      availableDiscounts: [tenPct],
      stackingEnabled: true,
    });
    expect(total).toBe(37);
  });

  test("an existing FRESH sibling on the SAME line is still correctly repriced alongside the document credit", () => {
    const fivePct = discountRow({ id: "five-pct", discount_type: "percentage", amount: 5 });
    const thirtyFixed = discountRow({ id: "thirty-fixed", discount_type: "fixed_amount", amount: 20 });
    const existingFivePctItem = {
      client_id: "d1", _kind: "discount", discount_for: "line-1",
      discount_id: "five-pct", quantity: 1, unit_price: -5, amount: -5,
    };
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
      { client_id: "credit-1", _kind: "discount", discount_for: null, quantity: 1, unit_price: -20 },
      existingFivePctItem,
    ];
    const discountRowById = new Map([["five-pct", fivePct], ["thirty-fixed", thirtyFixed]]);
    // Server reference: document $20 first (reaches the whole $100 line),
    // remaining $80; then percentages by rate descending — only one here
    // (5%) plus the newly-added one below, tied at... use a DIFFERENT new
    // rate so order is unambiguous: adding a 5% duplicate ties on rate, so
    // canonical order falls to identity — irrelevant to this assertion,
    // which only checks the TOTAL discount agrees with the engine.
    const { lineItems: repriced, dollars } = repriceLineWithNewDiscountPick({
      lineItems,
      parentClientId: "line-1",
      newTerm: { discountType: "percentage", amount: 5 },
      discountRowById,
    });
    const total = computeInvoiceLineDiscountTotal({
      lineItems: [
        ...repriced,
        { client_id: "d2", _kind: "discount", discount_for: "line-1", discount_id: "five-pct", quantity: 1, unit_price: -dollars, amount: -dollars },
      ],
      availableDiscounts: [fivePct, thirtyFixed],
      stackingEnabled: true,
    });
    // $20 document credit first (remaining $80), then the two 5% picks
    // COMPOUND sequentially on what's left — $4, then 5% of the remaining
    // $76 = $3.80, not two independent $4s — for $27.80 total.
    expect(total).toBe(27.8);
  });
});
