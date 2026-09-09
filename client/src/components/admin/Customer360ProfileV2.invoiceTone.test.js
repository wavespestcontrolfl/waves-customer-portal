import { describe, expect, it } from "vitest";
import { invoiceStatusTone } from "./Customer360ProfileV2";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const DAY = 86400000;

describe("invoiceStatusTone (F0068)", () => {
  it("reads paid and prepaid as strong, draft and void as neutral", () => {
    expect(invoiceStatusTone({ status: "paid" }, NOW)).toBe("strong");
    expect(invoiceStatusTone({ status: "prepaid" }, NOW)).toBe("strong");
    expect(invoiceStatusTone({ status: "draft" }, NOW)).toBe("neutral");
    expect(invoiceStatusTone({ status: "void" }, NOW)).toBe("neutral");
  });

  it("alerts on a stored overdue status", () => {
    expect(invoiceStatusTone({ status: "overdue" }, NOW)).toBe("alert");
  });

  it("derives overdue for sent/viewed invoices past the 7-day grace, like the late-payment checker", () => {
    const due = new Date(NOW - 8 * DAY).toISOString();
    expect(invoiceStatusTone({ status: "sent", due_date: due }, NOW)).toBe("alert");
    expect(invoiceStatusTone({ status: "viewed", due_date: due }, NOW)).toBe("alert");
    // due_date null → created_at stands in
    expect(invoiceStatusTone({ status: "sent", due_date: null, created_at: due }, NOW)).toBe("alert");
  });

  it("keeps a sent invoice inside its grace, or with no dates, neutral", () => {
    const recent = new Date(NOW - 3 * DAY).toISOString();
    expect(invoiceStatusTone({ status: "sent", due_date: recent }, NOW)).toBe("neutral");
    expect(invoiceStatusTone({ status: "viewed", due_date: new Date(NOW + DAY).toISOString() }, NOW)).toBe("neutral");
    expect(invoiceStatusTone({ status: "sent" }, NOW)).toBe("neutral");
  });
});
