/**
 * client/src/pages/admin/AdminInvoicesPage.jsx — GitHub round 4 on PR
 * #4655 (90d4eba989), the LAST patch round on this lane. Filename says r5
 * (r4-findings.test.jsx doesn't exist on the client side yet, but r1/r2
 * are taken — r5 keeps this file's number aligned with the server-side
 * companion for the same round).
 *
 * P1 (AdminInvoicesPage.jsx ~432): a baseline edit row (no trusted
 * stored_discount_source at all — an ordinary discount THIS FORM added on
 * a prior save) must preview frozen at its saved dollars once persisted,
 * matching invoice.js's isFrozenByPosition exactly — a $100 line carrying
 * a saved $10 percentage discount, edited to $200, must still preview $10
 * off (matching what Save bills: $190), never a live-recomputed $20.
 *
 * P1 (AdminInvoicesPage.jsx ~5700): the write binds the CONFIRMED gate
 * state the preview ran under (expected_discount_stacking) — covered by
 * stackingStillFresh's return shape, exercised through the render suite
 * (AdminInvoicesFoundation.test.jsx); this file pins the pure-function
 * half (isStoredInvoiceDiscountItem / invoiceDiscountItemTerm /
 * computeInvoiceLineDiscountTotal / repriceLineWithNewDiscountPick all
 * accepting and honoring persistedClientIds).
 */
import { describe, expect, test } from "vitest";
import {
  computeInvoiceLineDiscountTotal,
  invoiceDiscountItemTerm,
  isStoredInvoiceDiscountItem,
  repriceLineWithNewDiscountPick,
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

describe("isStoredInvoiceDiscountItem — persistedClientIds grandfathers an ordinary saved row, not only a trusted stamp", () => {
  test("a plain discount item with no stored source is NOT frozen when persistedClientIds is omitted (existing behavior unchanged)", () => {
    const item = { client_id: "d1", discount_id: "row-1", unit_price: -10, amount: -10 };
    expect(isStoredInvoiceDiscountItem(item)).toBe(false);
  });

  test("the SAME item IS frozen once its client_id is in persistedClientIds", () => {
    const item = { client_id: "d1", discount_id: "row-1", unit_price: -10, amount: -10 };
    expect(isStoredInvoiceDiscountItem(item, new Set(["d1"]))).toBe(true);
  });

  test("a NEW (not-yet-persisted) item with a different client_id is not frozen by an unrelated persisted set", () => {
    const item = { client_id: "d2", discount_id: "row-1", unit_price: -10, amount: -10 };
    expect(isStoredInvoiceDiscountItem(item, new Set(["d1"]))).toBe(false);
  });

  test("a trusted stored-source item stays frozen regardless of persistedClientIds (source check runs first)", () => {
    const item = {
      client_id: "d3", stored_discount_source: "scheduled_service", discount_dollars: 30,
      unit_price: -30, amount: -30,
    };
    expect(isStoredInvoiceDiscountItem(item)).toBe(true);
    expect(isStoredInvoiceDiscountItem(item, new Set())).toBe(true);
  });
});

describe("invoiceDiscountItemTerm — a persisted plain row's frozen face value falls back to its own line amount (no discount_dollars field)", () => {
  test("a persisted row with no discount_dollars resolves its term from its own amount, not NaN", () => {
    const item = { client_id: "d1", discount_id: "row-1", unit_price: -10, amount: -10 };
    const term = invoiceDiscountItemTerm(item, new Map(), new Set(["d1"]));
    expect(term).toEqual({ discountType: "fixed_amount", amount: 10 });
  });

  test("without persistedClientIds, the same item resolves LIVE from the catalog row instead (unchanged prior behavior)", () => {
    const row = discountRow({ id: "row-1", discount_type: "fixed_amount", amount: 25 });
    const item = { client_id: "d1", discount_id: "row-1", unit_price: -10, amount: -10 };
    const term = invoiceDiscountItemTerm(item, new Map([["row-1", row]]));
    expect(term).toEqual({ discountType: "fixed_amount", amount: 25, maxDiscountDollars: null });
  });
});

describe("computeInvoiceLineDiscountTotal — a $100→$200 edited line with a persisted $10 (10%) discount previews $10, not a live-recomputed $20", () => {
  test("gate ON: the persisted discount stays frozen at its saved dollars through a gross-amount change", () => {
    const persistedClientIds = new Set(["d1"]);
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 200, amount: 200 },
      {
        client_id: "d1", _kind: "discount", discount_id: "row-1", discount_for: "line-1",
        quantity: 1, unit_price: -10, amount: -10,
      },
    ];
    const total = computeInvoiceLineDiscountTotal({
      lineItems,
      availableDiscounts: [discountRow({ id: "row-1", discount_type: "percentage", amount: 10 })],
      stackingEnabled: true,
      persistedClientIds,
    });
    expect(total).toBe(10);
  });

  test("gate ON, same fixture, WITHOUT persistedClientIds: the discount is live-recomputed to $20 off the new $200 gross (the bug this fix closes)", () => {
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 200, amount: 200 },
      {
        client_id: "d1", _kind: "discount", discount_id: "row-1", discount_for: "line-1",
        quantity: 1, unit_price: -10, amount: -10,
      },
    ];
    const total = computeInvoiceLineDiscountTotal({
      lineItems,
      availableDiscounts: [discountRow({ id: "row-1", discount_type: "percentage", amount: 10 })],
      stackingEnabled: true,
    });
    expect(total).toBe(20);
  });
});

describe("repriceLineWithNewDiscountPick — a persisted sibling on the same line is never rewritten, only a fresh sibling is", () => {
  test("a persisted (frozen) sibling's own dollars are left untouched when a new pick reprices the line", () => {
    const persistedClientIds = new Set(["d1"]);
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 100, amount: 100 },
      {
        client_id: "d1", _kind: "discount", discount_id: "row-1", discount_for: "line-1",
        quantity: 1, unit_price: -10, amount: -10,
      },
    ];
    const result = repriceLineWithNewDiscountPick({
      lineItems,
      parentClientId: "line-1",
      newTerm: { discountType: "fixed_amount", amount: 20 },
      discountRowById: new Map([["row-1", discountRow({ id: "row-1", discount_type: "fixed_amount", amount: 10 })]]),
      persistedClientIds,
    });
    const sibling = result.lineItems.find((i) => i.client_id === "d1");
    expect(sibling.amount).toBe(-10);
  });
});

// Codex pre-push audit P1 (round 6 on PR #4655): "same on the client
// preview" — computeInvoiceLineDiscountTotal's gate-OFF path is the
// additive early return, which sums each discount item's OWN CURRENT
// face value directly and never consults persistedClientIds at all — so
// it was ALREADY byte-identical to main under gate off, with or without
// this round's server-side stacking_regime marker. Pinned directly so a
// future change can't silently make the client's additive path start
// reading persistedClientIds (which would reproduce the exact server-side
// mistake this round's audit caught).
describe("computeInvoiceLineDiscountTotal — gate OFF ignores persistedClientIds entirely (matches main)", () => {
  test("a persisted discount item sums its OWN current face value under gate off, regardless of persistedClientIds", () => {
    const persistedClientIds = new Set(["d1"]);
    const lineItems = [
      { client_id: "line-1", _kind: "service", description: "Service", quantity: 1, unit_price: 200, amount: 200 },
      { client_id: "d1", _kind: "discount", discount_id: "row-1", discount_for: "line-1", quantity: 1, unit_price: -10, amount: -10 },
    ];
    const total = computeInvoiceLineDiscountTotal({
      lineItems,
      availableDiscounts: [discountRow({ id: "row-1", discount_type: "percentage", amount: 10 })],
      stackingEnabled: false,
      persistedClientIds,
    });
    // Just the item's own face value ($10) — never a live 10%-of-$200
    // recompute (that's a SAVE-time server concern under gate off) and
    // never anything persistedClientIds-gated.
    expect(total).toBe(10);
  });
});
