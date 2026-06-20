import { describe, expect, it } from "vitest";
import { formatMoney, daysSince, formatDateOnly, formatETDate, FREE_REASONS } from "./BillingRecoveryPage";

describe("BillingRecoveryPage helpers", () => {
  it("formats money with USD + thousands separators", () => {
    expect(formatMoney(3473.85)).toBe("$3,473.85");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(null)).toBe("$0.00");
    expect(formatMoney(undefined)).toBe("$0.00");
    expect(formatMoney("129")).toBe("$129.00");
  });

  it("daysSince returns null for bad input and a non-negative integer otherwise", () => {
    expect(daysSince(null)).toBeNull();
    expect(daysSince("not-a-date")).toBeNull();
    const d = daysSince(new Date(Date.now() - 3 * 86400000).toISOString());
    expect(d).toBeGreaterThanOrEqual(2);
    expect(d).toBeLessThanOrEqual(4);
  });

  it("formatDateOnly renders date-only fields without UTC drift", () => {
    expect(formatDateOnly("2026-06-19")).toBe("6/19/2026");
    expect(formatDateOnly("2026-06-19T00:00:00Z")).toBe("6/19/2026");
    expect(formatDateOnly(null)).toBe("—");
    expect(formatDateOnly("garbage")).toBe("garbage");
  });

  it("formatETDate renders timestamps in ET and handles bad input", () => {
    expect(formatETDate(null)).toBe("—");
    expect(formatETDate("garbage")).toBe("—");
    expect(formatETDate("2026-06-18T12:00:00Z")).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  it("free reasons cover the Adam-locked no-cost taxonomy", () => {
    expect(FREE_REASONS).toContain("In-window rodent trap check");
    expect(FREE_REASONS).toContain("Appointment service (no-cost)");
    expect(FREE_REASONS).toContain("Warranty callback / re-treat");
    expect(FREE_REASONS.length).toBeGreaterThanOrEqual(5);
  });
});
