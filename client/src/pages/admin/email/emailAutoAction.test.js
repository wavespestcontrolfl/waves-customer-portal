import { describe, expect, it } from "vitest";
import { autoActionNote } from "./emailAutoAction";

describe("autoActionNote", () => {
  it("keeps the labels for other categories", () => {
    expect(autoActionNote({ classification: "lead_inquiry" }).text).toBe("Lead created");
    expect(autoActionNote({ classification: "other" })).toBeNull();
  });
  it("says Expense logged only for an invoice linked to an expense", () => {
    expect(autoActionNote({ classification: "vendor_invoice", expense_id: "e1", auto_action: "expense_created:42" })).toEqual({ text: "Expense logged", needsReview: false });
    expect(autoActionNote({ classification: "vendor_invoice", expense_id: "e1", auto_action: "invoice_detected:unauthenticated" }).text).toBe("Expense logged");
  });
  it("says not logged for an invoice with no expense link, whatever its marker", () => {
    for (const a of [null, undefined, "operational_sender_skipped", "invoice_detected:not_paid", "invoice_detected:no_amount", "invoice_detected:12:expense_failed"]) {
      expect(autoActionNote({ classification: "vendor_invoice", auto_action: a })).toEqual({ text: "Invoice — not logged", needsReview: false });
    }
  });
  it("flags an unauthenticated invoice for review", () => {
    expect(autoActionNote({ classification: "vendor_invoice", auto_action: "invoice_detected:unauthenticated" }))
      .toEqual({ text: "Invoice — check sender, not logged", needsReview: true });
  });
});
