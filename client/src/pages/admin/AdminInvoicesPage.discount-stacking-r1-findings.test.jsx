/**
 * GitHub Codex round 1 on PR #4655 (9ba05da027) — four client findings,
 * each pinned here directly against the exported pure functions.
 */
import { describe, expect, test } from "vitest";
import {
  computeInvoiceLineDiscountTotal,
  invoiceDiscountItemTerm,
  isStoredInvoiceDiscountItem,
  repriceLineWithNewDiscountPick,
  stackingProbeMatchesPreview,
} from "./AdminInvoicesPage.jsx";

// P1 (:5494): reject a submit when the stacking probe is UNKNOWN, not just
// when it disagrees with the preview.
describe("stackingProbeMatchesPreview — submit-time freshness contract", () => {
  test("known:false always refuses, even when enabled happens to equal the preview's", () => {
    expect(stackingProbeMatchesPreview({ enabled: false, known: false }, false)).toBe(false);
    expect(stackingProbeMatchesPreview({ enabled: true, known: false }, true)).toBe(false);
  });

  test("known:true and a matching enabled value passes", () => {
    expect(stackingProbeMatchesPreview({ enabled: true, known: true }, true)).toBe(true);
    expect(stackingProbeMatchesPreview({ enabled: false, known: true }, false)).toBe(true);
  });

  test("known:true but a DIFFERENT enabled value still refuses (the pre-existing mismatch case)", () => {
    expect(stackingProbeMatchesPreview({ enabled: true, known: true }, false)).toBe(false);
  });
});

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

// P1 (:429): a document-level (unparented) credit must reduce the base a
// line's own fresh percentage compounds against — the server's exact
// worked example.
describe("computeInvoiceLineDiscountTotal — document-wide credits interleave with line picks", () => {
  test("a $30 unparented credit plus a 10% line pick on $100 previews $37 ($63 total), never the un-interleaved $40", () => {
    const tenPct = discountRow({ discount_type: "percentage", amount: 10 });
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
      { client_id: "credit-1", _kind: "discount", discount_for: null, quantity: 1, unit_price: -30 },
      { client_id: "d1", _kind: "discount", discount_id: tenPct.id, discount_for: "line-1", quantity: 1, unit_price: -1 },
    ];
    const total = computeInvoiceLineDiscountTotal({
      lineItems,
      availableDiscounts: [tenPct],
      stackingEnabled: true,
    });
    expect(total).toBe(37);
  });

  test("the $30 credit alone (no line pick) still previews exactly $30", () => {
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
      { client_id: "credit-1", _kind: "discount", discount_for: null, quantity: 1, unit_price: -30 },
    ];
    const total = computeInvoiceLineDiscountTotal({ lineItems, availableDiscounts: [], stackingEnabled: true });
    expect(total).toBe(30);
  });
});

// P1 (:391): a trusted stored/frozen line stamp must never be recomputed
// live off the catalog, even when its row is still active and even when
// the line's own gross has since changed.
describe("invoiceDiscountItemTerm / isStoredInvoiceDiscountItem — stored stamps stay frozen", () => {
  test("a scheduled_service stamp with an ACTIVE catalog row still resolves its OWN frozen dollars, not a live recompute", () => {
    const activeCatalogRow = discountRow({ id: "silver-id", discount_type: "percentage", amount: 10 });
    const stampItem = {
      discount_id: "silver-id",
      discount_dollars: 10,
      stored_discount_source: "scheduled_service",
      quantity: 1,
      unit_price: -10,
    };
    expect(isStoredInvoiceDiscountItem(stampItem)).toBe(true);
    const discountRowById = new Map([["silver-id", activeCatalogRow]]);
    expect(invoiceDiscountItemTerm(stampItem, discountRowById)).toEqual({
      discountType: "fixed_amount",
      amount: 10,
    });
  });

  test("the server's own worked example: a $100 line with a frozen $10 stamp edited to $200 still previews $10 off, never a live-recomputed $20", () => {
    const activeCatalogRow = discountRow({ id: "silver-id", discount_type: "percentage", amount: 10 });
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 200 },
      {
        client_id: "d1", _kind: "discount", discount_for: "line-1",
        discount_id: "silver-id", discount_dollars: 10, stored_discount_source: "scheduled_service",
        quantity: 1, unit_price: -10,
      },
    ];
    const total = computeInvoiceLineDiscountTotal({
      lineItems,
      availableDiscounts: [activeCatalogRow],
      stackingEnabled: true,
    });
    expect(total).toBe(10);
  });

  test("an UNTRUSTED source (not scheduled_service/validated_checkout) is not treated as stored — falls through to the catalog", () => {
    const row = discountRow({ id: "d1", discount_type: "fixed_amount", amount: 25 });
    const item = { discount_id: "d1", discount_dollars: 999, stored_discount_source: "some_other_source" };
    expect(isStoredInvoiceDiscountItem(item)).toBe(false);
    expect(invoiceDiscountItemTerm(item, new Map([["d1", row]]))).toEqual({
      discountType: "fixed_amount",
      amount: 25,
      maxDiscountDollars: null,
    });
  });
});

// P2 (:5885): adding a discount that sorts AHEAD of an existing sibling in
// canonical order must reprice that sibling's own displayed row, not just
// size itself.
describe("repriceLineWithNewDiscountPick — canonical reordering reprices existing sibling rows", () => {
  test("adding a $30 fixed credit after an existing 5% pick on $100 drops the 5% row from $5 to $3.50, and prices the new credit at $30", () => {
    const fivePct = discountRow({ id: "five-pct", discount_type: "percentage", amount: 5 });
    const thirtyFixed = discountRow({ id: "thirty-fixed", discount_type: "fixed_amount", amount: 30 });
    const existingFivePctItem = {
      client_id: "d1", _kind: "discount", discount_for: "line-1",
      discount_id: "five-pct", quantity: 1, unit_price: -5, amount: -5,
    };
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
      existingFivePctItem,
    ];
    const discountRowById = new Map([["five-pct", fivePct], ["thirty-fixed", thirtyFixed]]);
    const { lineItems: repriced, dollars } = repriceLineWithNewDiscountPick({
      lineItems,
      parentClientId: "line-1",
      newTerm: { discountType: "fixed_amount", amount: 30 },
      discountRowById,
    });
    expect(dollars).toBe(30);
    const repricedFivePct = repriced.find((i) => i.client_id === "d1");
    expect(repricedFivePct.unit_price).toBe(-3.5);
    expect(repricedFivePct.amount).toBe(-3.5);
    // Simulate addDiscountToLine's own next step (splicing the new pick's
    // own item in) and confirm the aggregate agrees with the per-row math
    // above, not just the total on its own.
    const withNewPick = [
      ...repriced,
      { client_id: "d2", _kind: "discount", discount_for: "line-1", discount_id: "thirty-fixed", quantity: 1, unit_price: -dollars, amount: -dollars },
    ];
    const total = computeInvoiceLineDiscountTotal({
      lineItems: withNewPick,
      availableDiscounts: [fivePct, thirtyFixed],
      stackingEnabled: true,
    });
    expect(total).toBe(33.5);
  });

  test("a stored/frozen sibling is NEVER repriced, even when a new pick sorts ahead of it", () => {
    const stampItem = {
      client_id: "d1", _kind: "discount", discount_for: "line-1",
      discount_id: "silver-id", discount_dollars: 10, stored_discount_source: "scheduled_service",
      quantity: 1, unit_price: -10, amount: -10,
    };
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
      stampItem,
    ];
    const bigFixed = discountRow({ id: "big-fixed", discount_type: "fixed_amount", amount: 95 });
    const { lineItems: repriced } = repriceLineWithNewDiscountPick({
      lineItems,
      parentClientId: "line-1",
      newTerm: { discountType: "fixed_amount", amount: 95 },
      discountRowById: new Map([["big-fixed", bigFixed]]),
    });
    const repricedStamp = repriced.find((i) => i.client_id === "d1");
    expect(repricedStamp.unit_price).toBe(-10);
    expect(repricedStamp.amount).toBe(-10);
  });
});
