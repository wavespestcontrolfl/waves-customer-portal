import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_HELP_TEXT,
  invoiceDiscountDollars,
  invoiceLineAmount,
  ATTACHMENT_VISIBILITY_TEXT,
  attachmentTotalBytes,
  buildInvoiceListParams,
  canAddInvoiceAttachments,
  invoiceAttachmentLimitLabel,
  invoiceCreatedSendFailedToast,
  invoiceCreatedSendToast,
  invoiceDepositCreditTotal,
  invoiceListRowDate,
  isAllowedAttachmentFile,
  noticeCandidateLabel,
  orderNoticeCandidates,
  persistedSendDisposition,
  validateAttachmentFiles,
} from "./AdminInvoicesPage.jsx";

describe("AdminInvoicesPage Zelle notice candidates", () => {
  const near = { invoice_id: "n", invoice_number: "WPC-2026-0003", customer_name: "Sam Roe", amount_due_cents: 12000, exact_amount: false, name_match: false };
  const exact = { invoice_id: "e", invoice_number: "WPC-2026-0002", customer_name: "Pat Roe", amount_due_cents: 11700, exact_amount: true, name_match: false };
  const best = { invoice_id: "b", invoice_number: "WPC-2026-0001", customer_name: "Pat Doe", amount_due_cents: 11700, exact_amount: true, name_match: true };
  const nameOnly = { invoice_id: "m", invoice_number: "WPC-2026-0004", customer_name: "Pat Doe", amount_due_cents: 9900, exact_amount: false, name_match: true };

  it("orders exact+name, then exact amount, then name-only, then the rest — stable within a band", () => {
    expect(orderNoticeCandidates([near, nameOnly, exact, best]).map((c) => c.invoice_id)).toEqual(["b", "e", "m", "n"]);
    const twoExact = orderNoticeCandidates([{ ...exact, invoice_id: "e1" }, { ...exact, invoice_id: "e2" }]);
    expect(twoExact.map((c) => c.invoice_id)).toEqual(["e1", "e2"]);
  });

  it("tolerates a missing or malformed candidate list", () => {
    expect(orderNoticeCandidates(undefined)).toEqual([]);
    expect(orderNoticeCandidates("nope")).toEqual([]);
  });

  it("labels a candidate with number, customer, amount due and its match flags", () => {
    expect(noticeCandidateLabel(best)).toBe("WPC-2026-0001 · Pat Doe · $117.00 (exact amount, name match)");
    expect(noticeCandidateLabel(near)).toBe("WPC-2026-0003 · Sam Roe · $120.00");
  });
});

describe("AdminInvoicesPage customer handoff", () => {
  it("passes the customer context through to the invoice list endpoint", () => {
    expect(
      buildInvoiceListParams({
        customerFilterId: "cust-123",
        filter: "unpaid",
        query: "Quarterly",
      }).toString(),
    ).toContain("customerId=cust-123");
  });

  it("omits customerId for the ordinary all-invoices view", () => {
    expect(buildInvoiceListParams().has("customerId")).toBe(false);
  });
});

describe("AdminInvoicesPage invoice list dates", () => {
  it("groups full ISO service dates by the service calendar day", () => {
    const rowDate = invoiceListRowDate({
      service_date: "2026-05-18T00:00:00.000Z",
      created_at: "2026-05-19T14:30:00.000Z",
    });

    expect(rowDate).toBeInstanceOf(Date);
    expect(Number.isNaN(rowDate.getTime())).toBe(false);
    expect(rowDate.toLocaleDateString("en-US")).toBe("5/18/2026");
  });

  it("falls back to created_at when service_date is missing or invalid", () => {
    const rowDate = invoiceListRowDate({
      service_date: "not-a-date",
      created_at: "2026-05-19T14:30:00.000Z",
    });

    expect(rowDate).toBeInstanceOf(Date);
    expect(Number.isNaN(rowDate.getTime())).toBe(false);
    expect(rowDate.toISOString()).toBe("2026-05-19T14:30:00.000Z");
  });
});

describe("AdminInvoicesPage invoice attachment helpers", () => {
  const file = (name, size, type = "") => ({ name, size, type });

  it("keeps the visible attachment copy tied to the configured constraints", () => {
    expect(ATTACHMENT_HELP_TEXT).toBe(
      "Attach up to 10 files totaling 25 MB. Supported file types: JPG, PNG, GIF, TIFF, BMP, and PDF.",
    );
    expect(ATTACHMENT_VISIBILITY_TEXT).toContain("invoice/payment link");
  });

  it("allows supported attachment types by MIME type or extension", () => {
    expect(isAllowedAttachmentFile(file("photo", 1024, "image/png"))).toBe(true);
    expect(isAllowedAttachmentFile(file("inspection.PDF", 1024))).toBe(true);
    expect(isAllowedAttachmentFile(file("notes.txt", 1024, "text/plain"))).toBe(false);
  });

  it("validates count, total size, and unsupported files before upload", () => {
    const tenSmallPdfs = Array.from({ length: 10 }, (_, idx) => file(`doc-${idx}.pdf`, 1024));
    expect(validateAttachmentFiles([], tenSmallPdfs)).toBeNull();

    expect(validateAttachmentFiles(tenSmallPdfs, [file("extra.pdf", 1024)])).toBe(
      "Attach up to 10 files",
    );

    expect(validateAttachmentFiles([], [file("large.pdf", 25 * 1024 * 1024 + 1)])).toBe(
      "Attachments can total up to 25 MB",
    );

    expect(validateAttachmentFiles([], [file("script.exe", 1024)])).toBe(
      "Supported file types: JPG, PNG, GIF, TIFF, BMP, and PDF",
    );
  });

  it("reports and disables the add action at the attachment limits", () => {
    const existing = [
      { file_size_bytes: 5 * 1024 * 1024 },
      file("receipt.pdf", 512),
    ];

    expect(attachmentTotalBytes(existing)).toBe(5 * 1024 * 1024 + 512);
    expect(invoiceAttachmentLimitLabel(existing)).toBe("2/10 files · 5.0 MB/25 MB");
    expect(canAddInvoiceAttachments(existing)).toBe(true);
    expect(canAddInvoiceAttachments(Array.from({ length: 10 }, (_, idx) => file(`doc-${idx}.pdf`, 1)))).toBe(false);
    expect(canAddInvoiceAttachments([file("max.pdf", 25 * 1024 * 1024)])).toBe(false);
  });
});

describe("AdminInvoicesPage deposit credit chip", () => {
  it("totals only deposit_credit lines, as positive dollars", () => {
    expect(
      invoiceDepositCreditTotal([
        { description: "WaveGuard Membership", amount: 376, quantity: 1 },
        {
          description: "Deposit credit (paid at acceptance)",
          category: "deposit_credit",
          amount: -49,
        },
      ]),
    ).toBe(49);
  });

  it("ignores other negative lines (discounts) and junk entries", () => {
    expect(
      invoiceDepositCreditTotal([
        { description: "Service", amount: 100 },
        { description: "Referral discount", category: "discount", amount: -20 },
        null,
        { category: "deposit_credit", amount: "nope" },
      ]),
    ).toBe(0);
  });

  it("returns 0 for missing or non-array line items", () => {
    expect(invoiceDepositCreditTotal(undefined)).toBe(0);
    expect(invoiceDepositCreditTotal("[]")).toBe(0);
    expect(invoiceDepositCreditTotal([])).toBe(0);
  });
});

describe("AdminInvoicesPage create-path send toasts", () => {
  it("reports both channels when the send fully succeeds", () => {
    expect(
      invoiceCreatedSendToast("WPC-2026-0001", {
        ok: true,
        sms: { ok: true },
        email: { ok: true, recipient: { email: "billing@example.com" } },
      }),
    ).toBe(
      "Invoice created & sent: WPC-2026-0001 (SMS + email to billing@example.com)",
    );
  });

  it("calls out the failed channel on a partial send instead of claiming a full send", () => {
    expect(
      invoiceCreatedSendToast("WPC-2026-0001", {
        ok: true,
        sms: { ok: true },
        email: { ok: false, error: "no email on file" },
      }),
    ).toBe("Invoice created: WPC-2026-0001 — sent via SMS; email failed");
    expect(
      invoiceCreatedSendToast("WPC-2026-0001", {
        ok: true,
        sms: { ok: false },
        email: { ok: true },
      }),
    ).toBe("Invoice created: WPC-2026-0001 — sent via email; SMS failed");
  });

  it("points at Resend when no channel went out", () => {
    expect(
      invoiceCreatedSendToast("WPC-2026-0001", {
        ok: false,
        sms: { ok: false },
        email: { ok: false },
      }),
    ).toBe(
      "Invoice created but not sent: WPC-2026-0001 — use Resend on the invoice",
    );
  });

  it("post-create failure toast names the action and surfaces the server reason", () => {
    expect(
      invoiceCreatedSendFailedToast(
        "WPC-2026-0001",
        "sent",
        new Error("Invoice send already in progress"),
      ),
    ).toBe(
      "Invoice WPC-2026-0001 created but not sent — Invoice send already in progress. Use Resend on the invoice.",
    );
    // Defensive: no invoice number / no error object still reads sensibly.
    expect(invoiceCreatedSendFailedToast(null, "scheduled", undefined)).toBe(
      "Invoice created but not scheduled — send failed. Use Resend on the invoice.",
    );
  });
});

describe("AdminInvoicesPage create-path toast edge cases", () => {
  it("reports a credit-covered invoice as a success, never as a failed send", () => {
    expect(
      invoiceCreatedSendToast("WPC-2026-0001", {
        ok: true,
        covered_by_credit: true,
        sms: { ok: false, code: "covered_by_credit" },
        email: { ok: false, code: "covered_by_credit" },
      }),
    ).toBe(
      "Invoice created: WPC-2026-0001 — fully covered by account credit, nothing to send",
    );
  });

  it("failure toast accepts a custom recovery instruction (schedule retry keeps the builder open)", () => {
    expect(
      invoiceCreatedSendFailedToast(
        "WPC-2026-0001",
        "scheduled",
        new Error("scheduledFor must be in the future"),
        "Adjust the time and press the button again to schedule this same invoice.",
      ),
    ).toBe(
      "Invoice WPC-2026-0001 created but not scheduled — scheduledFor must be in the future. Adjust the time and press the button again to schedule this same invoice.",
    );
  });
});

describe("AdminInvoicesPage ambiguous-send disposition", () => {
  it("only a provably-draft row is offered an automatic resend", () => {
    expect(persistedSendDisposition({ status: "draft" })).toBe("unsent");
  });

  it("only DELIVERED states classify as committed", () => {
    for (const status of ["sent", "viewed", "overdue", "paid", "prepaid"]) {
      expect(persistedSendDisposition({ status })).toBe("committed");
    }
  });

  it("non-delivered non-draft states block resend WITHOUT claiming delivery (scheduled/void/processing)", () => {
    for (const status of ["scheduled", "void", "processing"]) {
      expect(persistedSendDisposition({ status })).toBe("unknown");
    }
  });

  it("a draft with an email delivery stamp is NOT provably unsent (email-leg provider success)", () => {
    expect(
      persistedSendDisposition({ status: "draft", email_sent_at: "2026-08-24T10:00:00Z" }),
    ).toBe("unknown");
  });

  it("an unverifiable row fails closed as unknown", () => {
    expect(persistedSendDisposition(null)).toBe("unknown");
    expect(persistedSendDisposition({})).toBe("unknown");
  });

  it("a live 'sending' claim is unknown, not committed — the server can still fail and restore draft", () => {
    expect(persistedSendDisposition({ status: "sending" })).toBe("unknown");
  });

  it("a draft row with a delivery stamp is NOT provably unsent (provider-success/db-failure)", () => {
    expect(
      persistedSendDisposition({ status: "draft", sms_sent_at: "2026-08-24T10:00:00Z" }),
    ).toBe("unknown");
    expect(
      persistedSendDisposition({ status: "draft", sent_at: "2026-08-24T10:00:00Z" }),
    ).toBe("unknown");
    expect(
      persistedSendDisposition({ status: "draft", sent_at: null, sms_sent_at: null }),
    ).toBe("unsent");
  });
});

describe("AdminInvoicesPage stacked line-item discounts", () => {
  const SILVER = { id: "silver", name: "WaveGuard Silver", discount_type: "percentage", amount: 10, stack_group: "tier", is_stackable: false };
  const MILITARY = { id: "military", name: "Military Discount", discount_type: "percentage", amount: 5, is_stackable: true };
  const REFERRAL = { id: "referral", name: "Referral Credit", discount_type: "fixed_amount", amount: 25, is_stackable: true };
  const CATALOG = [SILVER, MILITARY, REFERRAL];
  const service = { client_id: "line-1", description: "Quarterly Pest", quantity: 1, unit_price: 111 };
  const discountRow = (d, extra = {}) => ({
    client_id: `d-${d.id}`, _kind: "discount", discount_id: d.id,
    discount_for: "line-1", description: d.name, quantity: 1, unit_price: -1, ...extra,
  });

  it("compounds a second percentage on what is left, never additively", () => {
    const dollars = invoiceDiscountDollars([service, discountRow(SILVER), discountRow(MILITARY)], CATALOG);
    expect(dollars.get("d-silver")).toBe(11.1);
    // 5% of the remaining $99.90, not 5% of $111 ($5.55).
    expect(dollars.get("d-military")).toBe(5);
    expect(dollars.get("d-silver") + dollars.get("d-military")).toBe(16.1);
  });

  it("takes a dollar credit before the percentage", () => {
    const dollars = invoiceDiscountDollars([service, discountRow(SILVER), discountRow(REFERRAL)], CATALOG);
    expect(dollars.get("d-referral")).toBe(25);
    expect(dollars.get("d-silver")).toBe(8.6);
  });

  it("honors an operator-entered custom amount on the row", () => {
    const custom = { id: "custom_pct", name: "Custom Percentage Discount", discount_type: "percentage", amount: 0, discount_key: "custom_percent" };
    const dollars = invoiceDiscountDollars(
      [service, discountRow(custom, { custom_discount_percentage: 20 })],
      [custom],
    );
    expect(dollars.get("d-custom_pct")).toBe(22.2);
  });

  it("stacks each parent line independently", () => {
    const second = { client_id: "line-2", description: "Mosquito", quantity: 1, unit_price: 60 };
    const items = [
      service, discountRow(SILVER),
      second, { ...discountRow(SILVER), client_id: "d2-silver", discount_for: "line-2" },
    ];
    const dollars = invoiceDiscountDollars(items, CATALOG);
    expect(dollars.get("d-silver")).toBe(11.1);
    expect(dollars.get("d2-silver")).toBe(6);
  });

  it("leaves an orphan or catalog-less row to the caller, and tolerates junk", () => {
    const orphan = { client_id: "d-orphan", _kind: "discount", discount_id: "gone", discount_for: "missing-line", quantity: 1, unit_price: -9 };
    expect(invoiceDiscountDollars([service, orphan], CATALOG).has("d-orphan")).toBe(false);
    // A row whose catalog entry is gone still stacks, at its own amount.
    const unknown = { ...orphan, client_id: "d-unknown", discount_for: "line-1" };
    expect(invoiceDiscountDollars([service, unknown], CATALOG).get("d-unknown")).toBe(9);
    expect(invoiceDiscountDollars(undefined, undefined).size).toBe(0);
  });

  it("freezes a stored visit stamp and compounds the hand-added row on what it left", () => {
    const stamp = {
      client_id: "d-stamp", _kind: "discount", discount_for: "line-1",
      description: "WaveGuard Silver", quantity: 1, unit_price: -11.1,
      discount_amount: 10, discount_dollars: 11.1, use_stored_discount: true,
    };
    const dollars = invoiceDiscountDollars([service, stamp, discountRow(MILITARY)], CATALOG);
    // The stamp keeps its own dollars (absent from the map) and Military
    // takes 5% of the $99.90 it left.
    expect(dollars.has("d-stamp")).toBe(false);
    expect(dollars.get("d-military")).toBe(5);
  });

  it("reads a saved row's own amount when the catalog row carries none (the custom presets)", () => {
    const custom = { id: "custom_dollar", name: "Custom Dollar Discount", discount_type: "fixed_amount", amount: 0, discount_key: "custom_dollar" };
    const saved = { ...discountRow(custom), discount_amount: 50 };
    expect(invoiceDiscountDollars([service, saved], [custom]).get("d-custom_dollar")).toBe(50);
  });

  it("never lets stacked discounts drive a line below zero", () => {
    const big = { id: "big", name: "Huge", discount_type: "fixed_amount", amount: 200, is_stackable: true };
    const dollars = invoiceDiscountDollars(
      [service, discountRow(big), discountRow(MILITARY)],
      [big, MILITARY],
    );
    expect(dollars.get("d-big")).toBe(111);
    expect(dollars.get("d-military")).toBe(0);
  });

  it("computes a line's own signed amount", () => {
    expect(invoiceLineAmount({ quantity: 2, unit_price: 55.5 })).toBe(111);
    expect(invoiceLineAmount({ unit_price: -11.1 })).toBe(-11.1);
    expect(invoiceLineAmount({})).toBe(0);
  });
});
