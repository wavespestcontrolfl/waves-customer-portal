import { describe, expect, it } from "vitest";
import { formatMoney, daysSince, FREE_REASONS } from "./BillingRecoveryPage";

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

  it("free reasons cover the Adam-locked no-cost taxonomy", () => {
    expect(FREE_REASONS).toContain("In-window rodent trap check");
    expect(FREE_REASONS).toContain("Appointment service (no-cost)");
    expect(FREE_REASONS).toContain("Warranty callback / re-treat");
    expect(FREE_REASONS.length).toBeGreaterThanOrEqual(5);
  });
});
