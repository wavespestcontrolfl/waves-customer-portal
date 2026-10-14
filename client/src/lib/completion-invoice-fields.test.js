import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { completionInvoiceFields } from "./completion-invoice-fields";

describe("completionInvoiceFields", () => {
  it("marks the invoice as handled for a visit whose invoice was already sent", () => {
    expect(completionInvoiceFields({ completionInvoiceAlreadySent: true })).toEqual({ invoiceAlreadySent: true });
  });

  it("adds nothing for every other visit, as the full form posts nothing for them", () => {
    expect(completionInvoiceFields(null)).toEqual({});
    expect(completionInvoiceFields(undefined)).toEqual({});
    expect(completionInvoiceFields({})).toEqual({});
    expect(completionInvoiceFields({ completionInvoiceAlreadySent: false })).toEqual({});
    // A charge taken at the door leaves the invoice for the server to find by
    // the visit; no field rides the body.
    expect(completionInvoiceFields({ checkoutInvoiceId: "inv-fixture", checkoutInvoiceToken: "tok-fixture", checkoutInvoiceStatus: "paid" })).toEqual({});
  });

  it("is the one rule: the full form's body is built with it, not with a copy", () => {
    const source = readFileSync(new URL("../pages/admin/SchedulePage.jsx", import.meta.url), "utf8");
    expect(source).toContain('import { completionInvoiceFields } from "../../lib/completion-invoice-fields";');
    expect(source).toContain("Object.assign(body, completionInvoiceFields(service));");
    expect(source).not.toMatch(/body\.invoiceAlreadySent\s*=/);
    for (const sheet of ["FastCompleteSheet", "FastCompleteLawnSheet", "FastCompleteLawnReserviceSheet", "FastCompleteTreeShrubSheet"]) {
      const text = readFileSync(new URL(`../components/tech/${sheet}.jsx`, import.meta.url), "utf8");
      expect(text, sheet).toContain("invoiceFields: completionInvoiceFields(service)");
      expect(text, sheet).not.toMatch(/invoiceAlreadySent\s*[:=]/);
    }
  });
});
