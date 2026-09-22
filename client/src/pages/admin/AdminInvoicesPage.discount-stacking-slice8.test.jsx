/**
 * Slice 8 of #4405 (Invoice UI): AdminInvoicesPage.jsx's remaining
 * preview-display gaps slice 5 (#4655) left open — a read-only discount
 * row shows only its description/amount, with no indication of whether it
 * is a frozen stored stamp or a fresh catalog pick, what it's capped at,
 * or (for a document-wide/scoped credit, only addable through this
 * slice's new invoice-wide picker) which line(s) it actually reaches.
 *
 * discountRowCaption is the ONE place that builds this caption — used by
 * the read-only row render and pinned here directly, pure-function only
 * (no rendering). Gate-off behavior isn't a separate case: the caller
 * only ever invokes this under `stackingEnabled &&`, so an unreachable
 * function under the gate is the parity guarantee, not a branch inside it.
 */
import { describe, expect, test } from "vitest";
import { discountRowCaption } from "./AdminInvoicesPage.jsx";

describe("discountRowCaption — origin", () => {
  test("a scheduled_service stamp reads as frozen, from a visit", () => {
    const item = { discount_for: null, stored_discount_source: "scheduled_service", discount_dollars: 10 };
    expect(discountRowCaption({ item, serviceLineItems: [], discountRowById: new Map() }))
      .toBe("Frozen — from visit · Applies to: entire invoice");
  });

  test("a validated_checkout stamp reads as frozen, from checkout", () => {
    const item = { discount_for: "l1", stored_discount_source: "validated_checkout", discount_dollars: 10 };
    expect(discountRowCaption({ item, serviceLineItems: [], discountRowById: new Map() }))
      .toBe("Frozen — from checkout");
  });

  test("an ordinary persisted row (no trusted source) reads as frozen, saved, via persistedClientIds", () => {
    const item = { client_id: "d1", discount_for: "l1", discount_id: "row-1" };
    expect(discountRowCaption({
      item, serviceLineItems: [], discountRowById: new Map(), persistedClientIds: new Set(["d1"]),
    })).toBe("Frozen — saved");
  });

  test("a fresh (unsaved) per-line pick has no origin caption at all", () => {
    const item = { client_id: "d1", discount_for: "l1", discount_id: "row-1" };
    expect(discountRowCaption({ item, serviceLineItems: [], discountRowById: new Map() })).toBeNull();
  });
});

describe("discountRowCaption — applies-to, document-wide/scoped credits only", () => {
  const lines = [
    { client_id: "l1", description: "Quarterly Pest", service_key: "pest" },
    { client_id: "l2", description: "Monthly Mosquito", service_key: "mosquito" },
  ];

  test("an unscoped document-wide credit reaches the entire invoice", () => {
    const item = { discount_for: null, stored_discount_source: "scheduled_service", discount_dollars: 10 };
    expect(discountRowCaption({ item, serviceLineItems: lines, discountRowById: new Map() }))
      .toBe("Frozen — from visit · Applies to: entire invoice");
  });

  test("a scoped document-wide credit names the line(s) it reaches", () => {
    const item = {
      discount_for: null, stored_discount_source: "scheduled_service", discount_dollars: 10,
      document_scope_service_key: "pest",
    };
    expect(discountRowCaption({ item, serviceLineItems: lines, discountRowById: new Map() }))
      .toBe("Frozen — from visit · Applies to: Quarterly Pest");
  });

  test("an orphaned scope (matches no line) reads as resolving to $0, not a silent full-face replay", () => {
    const item = {
      discount_for: null, stored_discount_source: "scheduled_service", discount_dollars: 10,
      document_scope_service_key: "termite",
    };
    expect(discountRowCaption({ item, serviceLineItems: lines, discountRowById: new Map() }))
      .toBe("Frozen — from visit · Applies to: no matching line (resolves to $0)");
  });

  test("a per-line pick (discount_for set) never gets an applies-to caption — its row is already nested under that line", () => {
    const item = { discount_for: "l1", stored_discount_source: "scheduled_service", discount_dollars: 10 };
    expect(discountRowCaption({ item, serviceLineItems: lines, discountRowById: new Map() }))
      .toBe("Frozen — from visit");
  });
});

describe("discountRowCaption — cap", () => {
  test("a fresh catalog pick with a cap shows it", () => {
    const item = { client_id: "d1", discount_for: "l1", discount_id: "row-1" };
    const discountRowById = new Map([["row-1", { id: "row-1", discount_type: "percentage", amount: 50, max_discount_dollars: 15 }]]);
    expect(discountRowCaption({ item, serviceLineItems: [], discountRowById })).toBe("capped at $15.00");
  });

  test("a custom (operator-typed) amount never shows a catalog cap, even if its preset row carries one", () => {
    const item = { client_id: "d1", discount_for: "l1", discount_id: "row-1", custom_discount_amount: 40 };
    const discountRowById = new Map([["row-1", { id: "row-1", discount_type: "variable_amount", amount: 0, max_discount_dollars: 15 }]]);
    expect(discountRowCaption({ item, serviceLineItems: [], discountRowById })).toBeNull();
  });

  test("no cap on the row, no caption fragment for it", () => {
    const item = { client_id: "d1", discount_for: "l1", discount_id: "row-1" };
    const discountRowById = new Map([["row-1", { id: "row-1", discount_type: "fixed_amount", amount: 10, max_discount_dollars: null }]]);
    expect(discountRowCaption({ item, serviceLineItems: [], discountRowById })).toBeNull();
  });

  test("origin, applies-to and cap combine in one caption, in that order", () => {
    const item = {
      discount_for: null, stored_discount_source: "scheduled_service", discount_dollars: 10,
      document_scope_service_key: "pest", discount_id: "row-1",
    };
    const discountRowById = new Map([["row-1", { id: "row-1", discount_type: "percentage", amount: 10, max_discount_dollars: 15 }]]);
    expect(discountRowCaption({ item, serviceLineItems: sampleLines(), discountRowById }))
      .toBe("Frozen — from visit · Applies to: Quarterly Pest · capped at $15.00");
  });
});

function sampleLines() {
  return [
    { client_id: "l1", description: "Quarterly Pest", service_key: "pest" },
    { client_id: "l2", description: "Monthly Mosquito", service_key: "mosquito" },
  ];
}
