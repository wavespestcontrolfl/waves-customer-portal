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
import { discountRowCaption, sanitizeInvoiceLineItemsForSubmit } from "./AdminInvoicesPage.jsx";
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

// Pre-push audit P1 round 1 (this slice): server/services/invoice.js
// only admits an unparented (document-wide) item into its document stack
// when it is trusted/persisted OR carries NO discount_id — a fresh
// catalog-referenced document-wide pick (discount_id set, discount_for:
// null — exactly what the new invoice-wide picker creates) otherwise
// throws "Invalid line-item discount" on save. invoice.js itself is owned
// by another lane in this split; this is the client-only accommodation.
//
// Pre-push audit P0 round 2: safe ONLY for a FIXED-amount term — a
// document PERCENTAGE term's own canonical bucket compounds LAST; once
// stripped to a literal credit it becomes a FIXED term, which compounds
// FIRST, so an invoice already carrying another term can SAVE a
// genuinely different total than the one just previewed. This function
// re-checks the row's own type independently of the picker
// (matchingDocumentDiscounts, AdminInvoicesPage.jsx) that is supposed to
// only ever offer fixed-type rows in the first place.
describe("sanitizeInvoiceLineItemsForSubmit — the server's actual accepted shape for a fresh document-wide pick", () => {
  const fixedRow = { id: "twenty-five-fixed", discount_type: "fixed_amount", amount: 25 };
  const percentRow = { id: "silver-id", discount_type: "percentage", amount: 10 };

  test("a FRESH fixed-type document-wide pick loses its catalog reference at the submit boundary", () => {
    const items = [
      { client_id: "d1", _kind: "discount", discount_for: null, discount_id: "twenty-five-fixed", discount_key: "twenty_five", description: "Twenty Five Dollars (the whole invoice)", unit_price: -25, amount: -25 },
    ];
    const discountRowById = new Map([[fixedRow.id, fixedRow]]);
    const sanitized = sanitizeInvoiceLineItemsForSubmit(items, new Set(), discountRowById);
    expect(sanitized[0]).not.toHaveProperty("discount_id");
    expect(sanitized[0]).not.toHaveProperty("discount_key");
    expect(sanitized[0].unit_price).toBe(-25);
    expect(sanitized[0].description).toBe("Twenty Five Dollars (the whole invoice)");
  });

  test("a FRESH percentage-type document-wide item keeps its discount_id — stripping it would change canonical order and silently save a different total", () => {
    const items = [
      { client_id: "d1", _kind: "discount", discount_for: null, discount_id: "silver-id", unit_price: -10, amount: -10 },
    ];
    const discountRowById = new Map([[percentRow.id, percentRow]]);
    const sanitized = sanitizeInvoiceLineItemsForSubmit(items, new Set(), discountRowById);
    expect(sanitized[0].discount_id).toBe("silver-id");
  });

  test("a fresh item whose catalog row can't be found is still safe to strip — the live preview itself already treats a rowless pick as fixed", () => {
    const items = [
      { client_id: "d1", _kind: "discount", discount_for: null, discount_id: "deactivated-row", unit_price: -10, amount: -10 },
    ];
    const sanitized = sanitizeInvoiceLineItemsForSubmit(items, new Set(), new Map());
    expect(sanitized[0]).not.toHaveProperty("discount_id");
  });

  test("a PERSISTED document-wide item (its client_id already saved) keeps its discount_id — it's already frozen, and re-sending it unchanged is a no-op read either way", () => {
    const items = [
      { client_id: "d1", _kind: "discount", discount_for: null, discount_id: "twenty-five-fixed", unit_price: -25, amount: -25 },
    ];
    const discountRowById = new Map([[fixedRow.id, fixedRow]]);
    const sanitized = sanitizeInvoiceLineItemsForSubmit(items, new Set(["d1"]), discountRowById);
    expect(sanitized[0].discount_id).toBe("twenty-five-fixed");
  });

  test("a STORED stamp (trusted source) keeps its discount_id regardless of persistedClientIds", () => {
    const items = [
      { client_id: "d1", _kind: "discount", discount_for: null, discount_id: "silver-id", stored_discount_source: "scheduled_service", discount_dollars: 10, unit_price: -10, amount: -10 },
    ];
    const sanitized = sanitizeInvoiceLineItemsForSubmit(items, new Set());
    expect(sanitized[0].discount_id).toBe("silver-id");
  });

  test("a fresh PER-LINE pick (discount_for set) is untouched — the server DOES validate those against the live catalog row, and this must never defeat that check", () => {
    const items = [
      { client_id: "d1", _kind: "discount", discount_for: "line-1", discount_id: "ten-pct", unit_price: -10, amount: -10 },
    ];
    const sanitized = sanitizeInvoiceLineItemsForSubmit(items, new Set());
    expect(sanitized[0].discount_id).toBe("ten-pct");
  });

  test("an id-less document-wide credit (already the server's accepted shape) and every service line pass through unchanged", () => {
    const items = [
      { client_id: "l1", _kind: "service", description: "Service", quantity: 1, unit_price: 100 },
      { client_id: "d1", _kind: "discount", discount_for: null, description: "Referral Credit", unit_price: -25, amount: -25 },
    ];
    const sanitized = sanitizeInvoiceLineItemsForSubmit(items, new Set());
    expect(sanitized).toEqual(items);
  });
});

// Pre-push audit P0 round 2, numeric proof: WHY the picker restricts to
// fixed-type only. Fixture: a $100 line already carries a 10% LINE pick;
// a document-wide term is added on top. stackDocumentDiscounts is the
// exact engine both this form's live preview AND server/services/invoice.js
// run (client mirror / server original) — this drives it twice per case:
// once with the document term expressed with its REAL catalog type (what
// the preview sees before submit), once as the literal fixed_amount term
// the server would actually apply once discount_id is stripped (what
// gets SAVED). A fixed-type term is provably invariant; a percentage-type
// term is provably NOT — reproducing the auditor's own $81 vs $81.90 find.
describe("why matchingDocumentDiscounts restricts to fixed-type only — numeric proof", () => {
  function stackedTotal(documentTerm) {
    const stacked = stackDocumentDiscounts({
      lines: [{ gross: 100, terms: [{ discountType: "percentage", amount: 10 }] }],
      documentTerms: [documentTerm],
    });
    return stacked.lines[0].net;
  }

  test("a FIXED $20 document term: previewed-as-catalog and saved-as-literal totals match exactly", () => {
    const previewedAsCatalog = stackedTotal({ discountType: "fixed_amount", amount: 20 });
    const savedAsLiteral = stackedTotal({ discountType: "fixed_amount", amount: 20 });
    expect(savedAsLiteral).toBe(previewedAsCatalog);
  });

  test("a PERCENTAGE 10% document term: previewed-as-catalog (compounds LAST, $81) disagrees with saved-as-a-stripped-literal ($9 fixed, compounds FIRST, $81.90) — exactly why this type is excluded from the picker", () => {
    const previewedAsCatalog = stackedTotal({ discountType: "percentage", amount: 10 });
    // The line's own 10% alone (no document term) leaves $90 — the
    // document term's OWN dollar contribution is whatever it took beyond
    // that, i.e. the exact $9 sanitizeInvoiceLineItemsForSubmit would
    // freeze into a literal credit if this type weren't excluded first.
    const lineOnlyNet = 90;
    const resolvedDollars = lineOnlyNet - previewedAsCatalog;
    const savedAsLiteral = stackedTotal({ discountType: "fixed_amount", amount: resolvedDollars });
    expect(previewedAsCatalog).toBe(81);
    expect(resolvedDollars).toBe(9);
    expect(savedAsLiteral).toBe(81.9);
    expect(savedAsLiteral).not.toBe(previewedAsCatalog);
  });
});

function sampleLines() {
  return [
    { client_id: "l1", description: "Quarterly Pest", service_key: "pest" },
    { client_id: "l2", description: "Monthly Mosquito", service_key: "mosquito" },
  ];
}
