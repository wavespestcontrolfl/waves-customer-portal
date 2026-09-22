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
import { stackDocumentDiscounts } from "../../lib/discountStack";

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

// Coordinator scope extension (2026-09): server/services/invoice.js came
// free of its prior lane and now accepts a FRESH document-wide catalog
// pick directly (documentEntryTerms preserves its OWN type via
// lineItemDiscountTerm — the same per-type resolution a line pick already
// got — instead of forcing fixed_amount), so the earlier client-only
// sanitizeInvoiceLineItemsForSubmit workaround (which stripped discount_id
// at the submit boundary) is gone — a fresh document-wide pick now rides
// its discount_id all the way to the server unchanged, same as a per-line
// pick always has.
//
// This is WHY that matters, pinned directly against stackDocumentDiscounts
// — the exact engine both this form's live preview AND
// server/services/invoice.js run (client mirror / server original).
// Fixture: a $100 line already carries a 10% LINE pick; a document-wide
// term is added on top. A document PERCENTAGE term occupies a DIFFERENT
// canonical-order bucket (compounds LAST) than a FIXED term (compounds
// FIRST) — so the server's fix (preserving a fresh document pick's own
// type) is what keeps the previewed total ($81) equal to the saved one;
// forcing it to fixed_amount (the old, now-removed workaround) would have
// silently saved $81.90 instead.
describe("why the server preserves a fresh document-wide pick's own type — numeric proof", () => {
  function stackedTotal(documentTerm) {
    const stacked = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [{ discountType: "percentage", amount: 10 }] }],
      documentTerms: [documentTerm],
    });
    return stacked.lines[0].net;
  }

  test("a FIXED $20 document term: same total whether it's a literal credit or a fixed catalog pick (one canonical bucket either way)", () => {
    const asLiteralCredit = stackedTotal({ discountType: "fixed_amount", amount: 20 });
    const asCatalogFixedPick = stackedTotal({ discountType: "fixed_amount", amount: 20 });
    expect(asCatalogFixedPick).toBe(asLiteralCredit);
  });

  test("a PERCENTAGE 10% document term preserved as its own type totals $81 — forcing it to a fixed literal (the old workaround) would have totaled $81.90 instead", () => {
    const preservedAsPercentage = stackedTotal({ discountType: "percentage", amount: 10 });
    // The line's own 10% alone (no document term) leaves $90 — the
    // document term's OWN dollar contribution is whatever it took beyond
    // that, i.e. the exact $9 the old, now-removed sanitizer would have
    // frozen into a literal credit.
    const lineOnlyNet = 90;
    const resolvedDollars = lineOnlyNet - preservedAsPercentage;
    const forcedToFixedLiteral = stackedTotal({ discountType: "fixed_amount", amount: resolvedDollars });
    expect(preservedAsPercentage).toBe(81);
    expect(resolvedDollars).toBe(9);
    expect(forcedToFixedLiteral).toBe(81.9);
    expect(forcedToFixedLiteral).not.toBe(preservedAsPercentage);
  });
});

function sampleLines() {
  return [
    { client_id: "l1", description: "Quarterly Pest", service_key: "pest" },
    { client_id: "l2", description: "Monthly Mosquito", service_key: "mosquito" },
  ];
}
