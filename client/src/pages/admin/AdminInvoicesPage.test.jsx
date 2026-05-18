import { describe, expect, it } from "vitest";
import { invoiceListRowDate } from "./AdminInvoicesPage.jsx";

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
