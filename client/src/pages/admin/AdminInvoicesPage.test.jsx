import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_HELP_TEXT,
  adminFetch,
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
  VISIT_STATE_CONFLICT_CODES,
  confirmedBalanceFromError,
  createInvoiceBlocker,
  isLinkedVisitGone,
  openVisitBalanceKey,
  openVisitCreateExpectations,
  openVisitSendTimingBlocked,
  openVisitReviewRequestBlocked,
  previewLinkedBalance,
  reconcileSelectedOpenVisit,
  visitPickerResponseIsCurrent,
  reloadsVisitPickerAfterCreateError,
  resolveLinkedBalance,
  noticeCandidateLabel,
  orderNoticeCandidates,
  persistedSendDisposition,
  validateAttachmentFiles,
} from "./AdminInvoicesPage.jsx";

describe("AdminInvoicesPage adminFetch error shape", () => {
  it("keeps the server's error code on a refused request so callers can branch on it (deposit drift → reload the visit)", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "tok" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "The deposit credit changed while this invoice was being created — nothing was created.", code: "DEPOSIT_CREDIT_CHANGED" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    )));
    try {
      await expect(adminFetch("/admin/invoices", { method: "POST", body: "{}" })).rejects.toMatchObject({
        status: 409,
        code: "DEPOSIT_CREDIT_CHANGED",
        message: expect.stringContaining("nothing was created"),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("AdminInvoicesPage adminFetch refused payload", () => {
  it("carries the server's drift figures on a BALANCE_CHANGED refusal so the form can show what would be billed", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "tok" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "The balance this invoice would bill ($68.00) differs — nothing was created.", code: "BALANCE_CHANGED", expectedBalanceDue: 76.19, balanceDue: 68, invoiceTotal: 117, appliedDepositCredit: 49 }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    )));
    try {
      await expect(adminFetch("/admin/invoices", { method: "POST", body: "{}" })).rejects.toMatchObject({
        status: 409,
        code: "BALANCE_CHANGED",
        body: { balanceDue: 68, invoiceTotal: 117, appliedDepositCredit: 49 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("AdminInvoicesPage open-visit link: balance confirmation (Codex P1 r2)", () => {
  const visit = { id: "v1", deposit_credit: 49, scheduled_date: "2040-03-04" };
  const lines = [{ description: "Quarterly", quantity: 1, unit_price: 117 }];
  const key = openVisitBalanceKey({ selectedOpenVisit: visit, lineItems: lines });

  it("sends the previewed deposit AND the previewed balance for the linked create; nothing for an unlinked one", () => {
    expect(openVisitCreateExpectations({ selectedOpenVisit: visit, balanceDue: 76.19, confirmedBalance: null, balanceKey: key }))
      .toEqual({ expectedDepositCredit: 49, expectedBalanceDue: 76.19 });
    expect(openVisitCreateExpectations({ selectedOpenVisit: null, balanceDue: 76.19 })).toEqual({});
  });

  it("keeps the server's figures from a BALANCE_CHANGED refusal, keyed to the form state; other errors yield nothing", () => {
    const err = Object.assign(new Error("differs"), { code: "BALANCE_CHANGED", body: { balanceDue: 68, invoiceTotal: 117, appliedDepositCredit: 49 } });
    expect(confirmedBalanceFromError(err, key)).toEqual({ key, balanceDue: 68, invoiceTotal: 117, appliedDepositCredit: 49 });
    expect(confirmedBalanceFromError(Object.assign(new Error("x"), { code: "DEPOSIT_CREDIT_CHANGED", body: { balanceDue: 68 } }), key)).toBeNull();
    expect(confirmedBalanceFromError(Object.assign(new Error("x"), { code: "BALANCE_CHANGED", body: {} }), key)).toBeNull();
  });

  it("the next Create sends the server-confirmed balance while the form still matches — and drops back to the preview once a line changes", () => {
    const confirmed = { key, balanceDue: 68, invoiceTotal: 117, appliedDepositCredit: 49 };
    expect(openVisitCreateExpectations({ selectedOpenVisit: visit, balanceDue: 68, confirmedBalance: confirmed, balanceKey: key }))
      .toEqual({ expectedDepositCredit: 49, expectedBalanceDue: 68 });
    const editedKey = openVisitBalanceKey({ selectedOpenVisit: visit, lineItems: [{ ...lines[0], unit_price: 150 }] });
    expect(editedKey).not.toBe(key);
    expect(openVisitCreateExpectations({ selectedOpenVisit: visit, balanceDue: 111.5, confirmedBalance: confirmed, balanceKey: editedKey }))
      .toEqual({ expectedDepositCredit: 49, expectedBalanceDue: 111.5 });
    // A different visit (or a moved deposit) is a different key too.
    expect(openVisitBalanceKey({ selectedOpenVisit: { ...visit, deposit_credit: 20 }, lineItems: lines })).not.toBe(key);
  });
});

describe("AdminInvoicesPage open-visit link: send timing (Codex P1 r2)", () => {
  it("blocks a future send time for a linked open visit — the completion sends it — but allows now and draft", () => {
    const visit = { id: "v1" };
    expect(openVisitSendTimingBlocked("tomorrow_8", visit)).toBe(true);
    expect(openVisitSendTimingBlocked("custom", visit)).toBe(true);
    expect(openVisitSendTimingBlocked("now", visit)).toBe(false);
    expect(openVisitSendTimingBlocked("draft", visit)).toBe(false);
    expect(openVisitSendTimingBlocked("custom", null)).toBe(false);
  });
});

describe("AdminInvoicesPage open-visit link: no review ask before completion (Codex P1 r4)", () => {
  it("blocks the review toggle for a linked open visit and leaves standalone invoices alone", () => {
    expect(openVisitReviewRequestBlocked({ id: "v1" })).toBe(true);
    expect(openVisitReviewRequestBlocked(null)).toBe(false);
    expect(openVisitReviewRequestBlocked(undefined)).toBe(false);
  });
});

describe("AdminInvoicesPage open-visit link: picker refresh after a create conflict (Codex P2 r2)", () => {
  it("reloads the picker for every visit-state conflict code, not only deposit drift", () => {
    for (const code of ["DEPOSIT_CREDIT_CHANGED", "DEPOSIT_CREDIT_UNVERIFIABLE", "BALANCE_CHANGED", "visit_not_open", "visit_link_moved", "visit_invoice_refunded", "visit_billing_changing", "visit_prepaid", "visit_billing_unverifiable", "visit_already_invoiced", "SCHEDULED_PRICE_MOVED", "PAYER_CHANGED"]) {
      expect(VISIT_STATE_CONFLICT_CODES).toContain(code);
      expect(reloadsVisitPickerAfterCreateError(code)).toBe(true);
    }
    expect(reloadsVisitPickerAfterCreateError(undefined)).toBe(false);
    expect(reloadsVisitPickerAfterCreateError("HTTP 500")).toBe(false);
  });

  it("retains the selected visit when the reload no longer lists it (so linkedVisitGone renders) and refreshes it when it does", () => {
    const stale = { id: "v1", deposit_credit: 49 };
    expect(reconcileSelectedOpenVisit(stale, [{ id: "v2" }])).toBe(stale);
    expect(reconcileSelectedOpenVisit(stale, [])).toBe(stale);
    expect(reconcileSelectedOpenVisit(stale, [{ id: "v1", deposit_credit: 20 }])).toEqual({ id: "v1", deposit_credit: 20 });
    expect(reconcileSelectedOpenVisit(null, [{ id: "v1" }])).toBeNull();
  });
});

describe("AdminInvoicesPage open-visit link: stale picker responses (pre-push P1 r3)", () => {
  it("applies a picker response only for the customer still selected — never after a switch or a clear", () => {
    expect(visitPickerResponseIsCurrent("c1", "c1")).toBe(true);
    expect(visitPickerResponseIsCurrent(7, "7")).toBe(true);
    expect(visitPickerResponseIsCurrent("c2", "c1")).toBe(false);
    expect(visitPickerResponseIsCurrent(null, "c1")).toBe(false);
    expect(visitPickerResponseIsCurrent(undefined, "c1")).toBe(false);
  });
});

describe("AdminInvoicesPage CreateInvoice flattening (Codex P2 r3)", () => {
  it("isLinkedVisitGone: true only when a selected visit dropped out of the open list", () => {
    expect(isLinkedVisitGone({ id: "v1" }, [{ id: "v2" }])).toBe(true);
    expect(isLinkedVisitGone({ id: "v1" }, [{ id: "v1" }])).toBe(false);
    expect(isLinkedVisitGone(null, [])).toBe(false);
    expect(isLinkedVisitGone({ id: "v1" }, undefined)).toBe(true);
  });

  it("previewLinkedBalance: caps the credit at the total and rounds the remainder to the cent", () => {
    expect(previewLinkedBalance({ selectedOpenVisit: { deposit_credit: 49 }, total: 117 }))
      .toEqual({ depositCredit: 49, previewBalanceDue: 68 });
    expect(previewLinkedBalance({ selectedOpenVisit: { deposit_credit: 200 }, total: 117 }))
      .toEqual({ depositCredit: 117, previewBalanceDue: 0 });
    expect(previewLinkedBalance({ selectedOpenVisit: null, total: 117 }))
      .toEqual({ depositCredit: 0, previewBalanceDue: 117 });
    expect(previewLinkedBalance({ selectedOpenVisit: { deposit_credit: -5 }, total: 117 }))
      .toEqual({ depositCredit: 0, previewBalanceDue: 117 });
  });

  it("resolveLinkedBalance: the server-confirmed balance wins only while the form matches the key it was computed for", () => {
    const confirmed = { key: "k1", balanceDue: 68, invoiceTotal: 117, appliedDepositCredit: 49 };
    expect(resolveLinkedBalance({ confirmedBalance: confirmed, balanceKey: "k1", previewBalanceDue: 68 }))
      .toEqual({ serverBalance: confirmed, balanceDue: 68 });
    expect(resolveLinkedBalance({ confirmedBalance: confirmed, balanceKey: "k2", previewBalanceDue: 111.5 }))
      .toEqual({ serverBalance: null, balanceDue: 111.5 });
    expect(resolveLinkedBalance({ confirmedBalance: null, balanceKey: "k1", previewBalanceDue: 68 }))
      .toEqual({ serverBalance: null, balanceDue: 68 });
  });

  it("createInvoiceBlocker: one rule per reason, first failing rule wins, null when nothing blocks", () => {
    const ready = {
      selectedCustomer: { id: "c1" },
      lineItems: [{ _kind: "service", description: "Quarterly", unit_price: 117 }],
      serviceDate: "2040-03-04",
      dueDate: "2040-03-18",
      sendTiming: "now",
      scheduledFor: null,
      requestReview: false,
      reviewDelay: null,
      linkedVisitGone: false,
      selectedOpenVisit: null,
    };
    expect(createInvoiceBlocker(ready)).toBeNull();
    expect(createInvoiceBlocker({ ...ready, selectedCustomer: null })).toMatch(/Select a customer/);
    expect(createInvoiceBlocker({ ...ready, lineItems: [{ _kind: "service", description: "", unit_price: 0 }] })).toMatch(/line item/);
    expect(createInvoiceBlocker({ ...ready, serviceDate: null })).toMatch(/service date/);
    expect(createInvoiceBlocker({ ...ready, dueDate: null })).toMatch(/due date/);
    expect(createInvoiceBlocker({ ...ready, sendTiming: "custom", scheduledFor: null })).toMatch(/send time/);
    expect(createInvoiceBlocker({ ...ready, sendTiming: "custom", scheduledFor: "2040-03-05T08:00" })).toBeNull();
    expect(createInvoiceBlocker({ ...ready, sendTiming: "now", requestReview: true, reviewDelay: null })).toMatch(/review request time/);
    // A linked OPEN visit blocks the ask: the checkbox renders off, so a
    // still-true underlying state (enabled → Custom with no date → visit
    // linked) must not block Create on a review time (Codex P2 r6).
    expect(createInvoiceBlocker({ ...ready, sendTiming: "now", requestReview: true, reviewDelay: null, selectedOpenVisit: { id: "v1" } })).toBeNull();
    expect(createInvoiceBlocker({ ...ready, linkedVisitGone: true })).toMatch(/no longer open/);
    expect(createInvoiceBlocker({ ...ready, sendTiming: "custom", scheduledFor: "2040-03-05T08:00", selectedOpenVisit: { id: "v1" } }))
      .toMatch(/sent now or saved as a draft/);
  });
});

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
  it("a first delivery the completion already owns is a no-op in both shapes: delivered, or queued for the send window (Codex P2 r8)", () => {
    expect(invoiceCreatedSendToast("WPC-2026-0001", { ok: true, already_delivered: true, sms: { ok: false }, email: { ok: false } })).toMatch(/already delivered by the visit's completion, not sent again/);
    expect(invoiceCreatedSendToast("WPC-2026-0001", { ok: true, queued_delivery: true, sms: { ok: false, code: "queued_pay_link" }, email: { ok: false, code: "queued_pay_link" } })).toMatch(/already queued the text for the send window, not sent again/);
  });

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

  it("reports a first delivery the completion already made as a no-op, never as a failed send", () => {
    expect(
      invoiceCreatedSendToast("WPC-2026-0001", {
        ok: true,
        already_delivered: true,
        sms: { ok: false, code: "already_delivered" },
        email: { ok: false, code: "already_delivered" },
      }),
    ).toBe(
      "Invoice created: WPC-2026-0001 — already delivered by the visit's completion, not sent again",
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
