import { describe, expect, it } from "vitest";
import { autoActionNote } from "./emailAutoAction";

describe("autoActionNote", () => {
  it("keeps the existing labels", () => {
    expect(autoActionNote({ classification: "vendor_invoice" })).toEqual({ text: "Expense logged", needsReview: false });
    expect(autoActionNote({ classification: "vendor_invoice", auto_action: "expense_created:42", expense_id: "e1" }).text).toBe("Expense logged");
    expect(autoActionNote({ classification: "lead_inquiry" }).text).toBe("Lead created");
    expect(autoActionNote({ classification: "other" })).toBeNull();
  });
  it("flags an unauthenticated invoice for review instead of claiming a logged expense", () => {
    expect(autoActionNote({ classification: "vendor_invoice", auto_action: "invoice_detected:unauthenticated" }))
      .toEqual({ text: "Invoice — check sender, not logged", needsReview: true });
  });
  it("does not claim a logged expense for other invoice_detected outcomes", () => {
    for (const a of ["invoice_detected:not_paid", "invoice_detected:no_amount", "invoice_detected:12:expense_failed"]) {
      expect(autoActionNote({ classification: "vendor_invoice", auto_action: a })).toEqual({ text: "Invoice — not logged", needsReview: false });
    }
  });
});
