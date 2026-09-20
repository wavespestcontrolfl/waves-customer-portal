import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_HELP_TEXT,
  ATTACHMENT_VISIBILITY_TEXT,
  attachmentTotalBytes,
  batchSendToast,
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
  sendErrorMessage,
  resendConflictMessage,
  sendOutcomeMessage,
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

  // A first-delivery request (firstDelivery: true) finding the invoice
  // already owned by another live delivery is a 200 ok success carrying
  // already_delivered / queued_delivery, not a thrown error — sms.ok and
  // email.ok are both false by construction, so these must be read as a
  // no-op success, never "send failed" (round-6 P1 #4131).
  it("reports a first-delivery already_delivered outcome as a no-op success", () => {
    expect(
      invoiceCreatedSendToast("WPC-2026-0001", {
        ok: true,
        already_delivered: true,
        sms: { ok: false, code: "already_delivered" },
        email: { ok: false, code: "already_delivered" },
      }),
    ).toBe("Invoice created: WPC-2026-0001 — already delivered");
  });

  it("reports a first-delivery queued_delivery outcome as a no-op success", () => {
    expect(
      invoiceCreatedSendToast("WPC-2026-0001", {
        ok: true,
        queued_delivery: true,
        sms: { ok: false, code: "queued_pay_link" },
        email: { ok: false, code: "queued_pay_link" },
      }),
    ).toBe("Invoice created: WPC-2026-0001 — queued for the send window");
  });
});

describe("AdminInvoicesPage send outcome/error helpers", () => {
  it("sendOutcomeMessage reads the five no-op-success flags a 200 response can carry", () => {
    expect(sendOutcomeMessage({ covered_by_credit: true })).toBe(
      "fully covered by account credit, nothing to send",
    );
    // #4131 slice 4: a zero-due visit invoice settled (now prepaid) rather
    // than being delivered — same no-op-success shape as covered_by_credit.
    expect(sendOutcomeMessage({ settled_zero_due: true })).toBe(
      "nothing due — invoice marked prepaid, nothing to send",
    );
    expect(sendOutcomeMessage({ already_delivered: true })).toBe(
      "already delivered",
    );
    expect(sendOutcomeMessage({ queued_delivery: true })).toBe(
      "queued for the send window",
    );
    // Pre-push audit P1 (PR #4633): a concurrent first-delivery claim
    // already won the race — a no-op success, never a failure.
    expect(sendOutcomeMessage({ in_progress: true })).toBe(
      "already being delivered",
    );
    expect(sendOutcomeMessage({ ok: true, sms: { ok: true } })).toBeNull();
    expect(sendOutcomeMessage(null)).toBeNull();
  });

  // Reached only by an explicit Resend — a first delivery never throws
  // these as errors (see the no-op-success cases above).
  it("sendErrorMessage translates a thrown send error's code for a Resend", () => {
    expect(sendErrorMessage({ code: "queued_pay_link" })).toBe(
      "queued for the send window",
    );
    expect(sendErrorMessage({ code: "already_delivered" })).toBe(
      "already delivered",
    );
    expect(sendErrorMessage({ code: "delivery_in_progress" })).toBe(
      "already being delivered",
    );
    expect(sendErrorMessage({ code: "send_claim_lost" })).toBeNull();
    expect(sendErrorMessage(new Error("boom"))).toBeNull();
  });

  // Codex round-3 P2 #4131: settled_count only exists on /batch/send — a
  // zero-due invoice settled instead of sent must show up distinctly, or
  // sent_count + failed_count alone reads as an unexplained shortfall.
  it("batchSendToast surfaces settled_count alongside held_count and failed_count", () => {
    expect(
      batchSendToast({ sent_count: 2, total: 3, settled_count: 1 }, "invoice"),
    ).toBe("Sent 2 of 3 invoices (1 settled — nothing due)");
    expect(
      batchSendToast({ sent_count: 1, total: 1 }, "invoice"),
    ).toBe("Sent 1 of 1 invoice");
    expect(
      batchSendToast(
        { sent_count: 1, total: 4, settled_count: 1, held_count: 1, failed_count: 1 },
        "invoice",
      ),
    ).toBe(
      "Sent 1 of 4 invoices (1 settled — nothing due) (1 held for review) (1 failed)",
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

describe("resendConflictMessage", () => {
  it("words a refused Resend as a block, distinct from the first-delivery no-op phrasing", () => {
    const blocked = resendConflictMessage({ code: "queued_pay_link" });
    expect(blocked).toMatch(/^Invoice send blocked:/);
    expect(blocked).not.toBe(sendErrorMessage({ code: "queued_pay_link" }));
    expect(resendConflictMessage({ code: "already_delivered" })).toMatch(/^Invoice send blocked:/);
    // Pre-push audit P1 (PR #4633): a concurrent claim in progress is a
    // real conflict for a deliberate Resend, not the first-delivery no-op.
    expect(resendConflictMessage({ code: "delivery_in_progress" })).toBe(
      "Invoice send blocked: a delivery is already in progress",
    );
    expect(resendConflictMessage({ code: "send_claim_lost" })).toBeNull();
    expect(resendConflictMessage(new Error("boom"))).toBeNull();
  });
});
