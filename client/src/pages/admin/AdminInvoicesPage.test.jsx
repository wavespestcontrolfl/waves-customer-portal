import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_HELP_TEXT,
  ATTACHMENT_VISIBILITY_TEXT,
  attachmentTotalBytes,
  canAddInvoiceAttachments,
  invoiceAttachmentLimitLabel,
  invoiceDepositCreditTotal,
  invoiceListRowDate,
  isAllowedAttachmentFile,
  validateAttachmentFiles,
} from "./AdminInvoicesPage.jsx";

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
