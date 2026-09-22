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
import { discountRowCaption, invoiceDiscountItemTerm, invoiceDocumentTerms } from "./AdminInvoicesPage.jsx";
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

  // GitHub review round 1 P1 (PR #4659, round 3): discountRowScopeLabel
  // only ever read item.document_scope_service_key/_category — a FRESH
  // (unsaved) pick has neither yet, only its catalog row's OWN
  // service_key_filter/_category_filter, so a WDO-only fresh pick always
  // read as "Applies to: entire invoice" in the preview even though it
  // would only ever discount the WDO line. Now derived from the SAME
  // fresh-vs-stored resolveDocumentEligibleLines logic invoiceDocumentTerms
  // uses for pricing, so the caption and the actual computed discount can
  // never disagree.
  test("a FRESH (unsaved) catalog pick with a scoped row names the line it reaches, not 'entire invoice'", () => {
    const item = { client_id: "d1", discount_for: null, discount_id: "wdo-row" };
    const discountRowById = new Map([["wdo-row", { id: "wdo-row", discount_type: "percentage", amount: 100, service_key_filter: "pest" }]]);
    expect(discountRowCaption({ item, serviceLineItems: lines, discountRowById }))
      .toBe("Applies to: Quarterly Pest");
  });

  test("a FRESH catalog pick with an unscoped row (no filter) still reads as the entire invoice", () => {
    const item = { client_id: "d1", discount_for: null, discount_id: "plain-row" };
    const discountRowById = new Map([["plain-row", { id: "plain-row", discount_type: "percentage", amount: 10 }]]);
    expect(discountRowCaption({ item, serviceLineItems: lines, discountRowById })).toBe("Applies to: entire invoice");
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

// Pre-push audit P1 (coordinator scope extension, round 3): server/
// services/invoice.js's documentEntryTerms tags both its fresh AND
// stored branches with `id: <discount_id>` — the client mirror must
// match, or two document-wide terms tied on rank/value/cap/scope break
// the tie by ARRAY POSITION here but by catalog id there, so the
// PREVIEW's per-row split can disagree with what the SAVE actually
// records (same total either way — this is a display/attribution bug,
// not a money one).
describe("invoiceDocumentTerms — carries each item's discount_id as the term's id (client/server identity-tiebreak parity)", () => {
  test("a fresh document-wide pick's term carries its discount_id", () => {
    const items = [{ client_id: "d1", _kind: "discount", discount_for: null, discount_id: "row-1" }];
    const discountRowById = new Map([["row-1", { id: "row-1", discount_type: "fixed_amount", amount: 20 }]]);
    const terms = invoiceDocumentTerms(items, [], discountRowById, new Set());
    expect(terms[0].id).toBe("row-1");
  });

  test("a STORED document-wide item's term also carries its discount_id", () => {
    const items = [{ client_id: "d1", _kind: "discount", discount_for: null, discount_id: "row-1", discount_dollars: 20 }];
    const terms = invoiceDocumentTerms(items, [], new Map(), new Set(["d1"]));
    expect(terms[0].id).toBe("row-1");
  });

  test("a plain id-less literal credit's term carries id: undefined — no fabricated identity", () => {
    const items = [{ client_id: "d1", _kind: "discount", discount_for: null, description: "Referral Credit" }];
    const terms = invoiceDocumentTerms(items, [], new Map(), new Set());
    expect(terms[0].id).toBeUndefined();
  });
});

// GitHub review round 1 P1 (PR #4659): a FRESH document-wide pick's
// catalog row can carry its own service_key_filter/_category_filter
// (e.g. the active waveguard_member_wdo seed, restricted to
// wdo_inspection) — invoiceDocumentTerms must scope the term to just the
// matching line(s), the same way it already does for a STORED item's
// document_scope_service_key/_category, or the preview would show the
// discount hitting every line instead of just the WDO one.
describe("invoiceDocumentTerms — a FRESH pick with a scoped catalog row is scoped, not applied invoice-wide (client mirror of the server fix)", () => {
  const serviceLineItems = [
    { client_id: "l-wdo", description: "WDO Inspection", service_key: "wdo_inspection" },
    { client_id: "l-pest", description: "Quarterly Pest", service_key: "pest_control" },
  ];

  test("a scoped catalog row resolves eligibleLines to just the matching line", () => {
    const items = [{ client_id: "d1", _kind: "discount", discount_for: null, discount_id: "wdo-row" }];
    const discountRowById = new Map([["wdo-row", { id: "wdo-row", discount_type: "percentage", amount: 100, service_key_filter: "wdo_inspection" }]]);
    const terms = invoiceDocumentTerms(items, serviceLineItems, discountRowById, new Set());
    expect(terms[0].eligibleLines).toEqual([0]);
  });

  test("an unscoped catalog row (no filter) carries no eligibleLines at all", () => {
    const items = [{ client_id: "d1", _kind: "discount", discount_for: null, discount_id: "plain-row" }];
    const discountRowById = new Map([["plain-row", { id: "plain-row", discount_type: "percentage", amount: 10 }]]);
    const terms = invoiceDocumentTerms(items, serviceLineItems, discountRowById, new Set());
    expect(terms[0]).not.toHaveProperty("eligibleLines");
  });

  test("a scoped row matching no line resolves an EMPTY eligibleLines (orphaned, $0), not undefined (unscoped)", () => {
    const items = [{ client_id: "d1", _kind: "discount", discount_for: null, discount_id: "termite-row" }];
    const discountRowById = new Map([["termite-row", { id: "termite-row", discount_type: "percentage", amount: 100, service_key_filter: "termite" }]]);
    const terms = invoiceDocumentTerms(items, serviceLineItems, discountRowById, new Set());
    expect(terms[0].eligibleLines).toEqual([]);
  });

  test("no service_key anywhere on the invoice (no pickService use) resolves the scoped row to an EMPTY eligibleLines — a FRESH pick fails CLOSED, unlike a stored stamp's legacy fallback", () => {
    // GitHub review round 1 P0, second finding (PR #4659, round 2): the
    // "no service_key data anywhere ⇒ unscoped" fallback is preserved
    // ONLY for a STORED item's own document_scope_service_key/_category
    // (a pre-lane invoice whose stamp predates service_key tracking has
    // no scope concept to begin with). A FRESH pick has no such excuse —
    // the operator is choosing a scoped catalog row right now, against
    // lines that plainly carry no service_key at all, so there is no
    // verifiable match. Admitting it unscoped would let a WDO-only 100%
    // discount hit a hand-typed line it was never meant to touch.
    const items = [{ client_id: "d1", _kind: "discount", discount_for: null, discount_id: "wdo-row" }];
    const discountRowById = new Map([["wdo-row", { id: "wdo-row", discount_type: "percentage", amount: 100, service_key_filter: "wdo_inspection" }]]);
    const terms = invoiceDocumentTerms(items, [{ client_id: "l1", description: "Hand-typed line" }], discountRowById, new Set());
    expect(terms[0].eligibleLines).toEqual([]);
  });
});

// Coordinator design call (round 3 on PR #4659, GitHub review P0 on
// invoice.js:807) — client mirror. A STORED item's persisted scope used
// to always resolve via invoiceServiceScopeEligibleLines' legacy "no
// service_key anywhere ⇒ unscoped" fallback, even when the item was
// itself priced under this engine (marked stacking_regime === "compound"
// server-side and carried straight through in the invoice's line_items
// JSON). Now a marked item resolves STRICTLY (fail-closed), matching the
// server; only a genuinely unmarked stamp keeps the legacy fallback.
describe("invoiceDocumentTerms — a STORED item marked stacking_regime 'compound' resolves its scope STRICTLY, never the legacy fallback", () => {
  test("a marked stored item whose scoped line is gone resolves an EMPTY eligibleLines ($0), never unscoped", () => {
    const items = [{
      client_id: "d1", _kind: "discount", discount_for: null, discount_id: "wdo-row",
      discount_dollars: 50, stacking_regime: "compound", document_scope_service_key: "wdo_inspection",
    }];
    // Only a hand-typed, unkeyed line remains — the WDO line that this
    // stamp's own scope names has been removed from the invoice.
    const terms = invoiceDocumentTerms(items, [{ client_id: "l1", description: "Hand-typed line" }], new Map(), new Set(["d1"]));
    expect(terms[0].eligibleLines).toEqual([]);
  });

  test("an UNMARKED stored item (no stacking_regime — genuine pre-gate history) still falls back to unscoped in the same situation", () => {
    const items = [{
      client_id: "d1", _kind: "discount", discount_for: null, discount_id: "wdo-row",
      discount_dollars: 50, document_scope_service_key: "wdo_inspection",
      // deliberately NO stacking_regime — this is the whole point
    }];
    const terms = invoiceDocumentTerms(items, [{ client_id: "l1", description: "Hand-typed line" }], new Map(), new Set(["d1"]));
    expect(terms[0]).not.toHaveProperty("eligibleLines");
  });
});

// Pre-push audit P0 (coordinator scope extension, round 3): a STORED
// item's term must replay its ORIGINAL sort key (stack_sort_kind/_value/
// _cap, persisted server-side onto the saved line item) — without this,
// the EDIT-mode preview of an existing document-wide percentage term
// would use the pre-fix unstable canonical-order position even though
// the server now saves it correctly, a preview/save mismatch.
describe("invoiceDiscountItemTerm — a STORED item replays its persisted sort key for canonical-order stability", () => {
  test("a stored item carrying stack_sort_kind/_value/_cap includes them on its term, alongside the frozen fixed_amount/dollars", () => {
    const item = {
      client_id: "d1", discount_for: null, discount_dollars: 12,
      stack_sort_kind: "percentage", stack_sort_value: 50, stack_sort_cap: 30,
    };
    const term = invoiceDiscountItemTerm(item, new Map(), new Set(["d1"]));
    expect(term).toMatchObject({
      discountType: "fixed_amount", amount: 12,
      sortKind: "percentage", sortValue: 50, sortCap: 30,
    });
  });

  test("a stored item saved BEFORE this fix existed (no stack_sort_kind at all) omits the sort-key override — unchanged fallback behavior", () => {
    const item = { client_id: "d1", discount_for: null, discount_dollars: 12 };
    const term = invoiceDiscountItemTerm(item, new Map(), new Set(["d1"]));
    expect(term).toEqual({ discountType: "fixed_amount", amount: 12 });
    expect(term).not.toHaveProperty("sortKind");
  });
});

function sampleLines() {
  return [
    { client_id: "l1", description: "Quarterly Pest", service_key: "pest" },
    { client_id: "l2", description: "Monthly Mosquito", service_key: "mosquito" },
  ];
}
