import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_HELP_TEXT,
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
  persistedSendDisposition,
  validateAttachmentFiles,
} from "./AdminInvoicesPage.jsx";

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

  it("any committed state blocks the auto-resend prompt (duplicate comms hazard)", () => {
    for (const status of ["scheduled", "sent", "viewed", "overdue", "paid", "prepaid"]) {
      expect(persistedSendDisposition({ status })).toBe("committed");
    }
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
