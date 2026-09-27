import { describe, expect, it } from "vitest";
import { formatMeasuredAmount, formatMeasuredRange } from "./mix-amount";

describe("formatMeasuredAmount", () => {
  it("never shows mL: small liquid doses read as measuring-spoon teaspoons", () => {
    expect(formatMeasuredAmount(0.16, "fl_oz")).toBe("1 tsp");
    expect(formatMeasuredAmount(0.32, "fl oz")).toBe("2 tsp");
    expect(formatMeasuredAmount(0.29, "fl_oz")).toBe("1¾ tsp");
    expect(formatMeasuredAmount(0.5, "fl_oz")).toBe("3 tsp");
  });

  it("uses eighths below half a teaspoon", () => {
    expect(formatMeasuredAmount(0.04, "fl_oz")).toBe("¼ tsp");
    expect(formatMeasuredAmount(0.0625, "fl_oz")).toBe("⅜ tsp");
    expect(formatMeasuredAmount(0.01, "fl_oz")).toBe("under ⅛ tsp");
  });

  it("keeps 1 fl oz and up in fluid ounces for the ounce cup", () => {
    expect(formatMeasuredAmount(1.28, "fl_oz")).toBe("1.28 fl oz");
    expect(formatMeasuredAmount(5.12, "fl_oz")).toBe("5.12 fl oz");
    expect(formatMeasuredAmount(140.8, "fl_oz")).toBe("141 fl oz");
  });

  it("converts amounts stored in mL or liters instead of showing them", () => {
    expect(formatMeasuredAmount(10, "ml")).toBe("2 tsp");
    expect(formatMeasuredAmount(59.147, "mL")).toBe("2 fl oz");
    expect(formatMeasuredAmount(1, "l")).toBe("33.81 fl oz");
    expect(formatMeasuredAmount(0, "ml")).toBe("0 fl oz");
    for (const [amount, unit] of [[0.2, "fl_oz"], [7, "ml"], [0.003, "l"], [3, "cc"]]) {
      expect(formatMeasuredAmount(amount, unit)).not.toMatch(/\bml\b|milliliter/i);
    }
  });

  it("leaves dry weights and other units as they were", () => {
    expect(formatMeasuredAmount(0.5, "oz")).toBe("14.2 g");
    expect(formatMeasuredAmount(2.5, "oz")).toBe("2.5 oz");
    expect(formatMeasuredAmount(3, "lb")).toBe("3 lb");
    expect(formatMeasuredAmount(12, "")).toBe("12");
  });

  it("returns null for missing or non-numeric amounts", () => {
    expect(formatMeasuredAmount(null, "fl_oz")).toBeNull();
    expect(formatMeasuredAmount("", "fl_oz")).toBeNull();
    expect(formatMeasuredAmount("abc", "fl_oz")).toBeNull();
  });
});

describe("formatMeasuredRange", () => {
  it("rounds a teaspoon range inward so it never leaves the label range", () => {
    // Mainspring GNL 4–8 fl oz / 100 gal in a 4-gal FlowZone.
    expect(formatMeasuredRange(0.16, 0.32, "fl_oz")).toBe("1 tsp – 1¾ tsp");
    // Same product in one gallon.
    expect(formatMeasuredRange(0.04, 0.08, "fl_oz")).toBe("¼ tsp – ⅜ tsp");
  });

  it("collapses to one measure when both ends round to it", () => {
    // Distance IGR 6–8 fl oz / 100 gal in one gallon.
    expect(formatMeasuredRange(0.06, 0.08, "fl_oz")).toBe("⅜ tsp");
  });

  it("keeps the exact fl oz range when no spoon step fits inside it, never a spoon off the label", () => {
    // ⅜ tsp (0.0625 fl oz) sits below this range and ½ tsp (0.0833) above it.
    expect(formatMeasuredRange(0.07, 0.075, "fl_oz")).toBe("0.07 fl oz – 0.075 fl oz");
    expect(formatMeasuredRange(0.08, 0.081, "fl_oz")).toBe("0.08 fl oz – 0.081 fl oz");
  });

  it("keeps a range that reaches 1 fl oz in fluid ounces end to end", () => {
    expect(formatMeasuredRange(0.9, 1.5, "fl_oz")).toBe("0.9 fl oz – 1.5 fl oz");
    expect(formatMeasuredRange(4.4, 8.8, "fl_oz")).toBe("4.4 fl oz – 8.8 fl oz");
  });

  it("formats a single amount when there is no high end", () => {
    expect(formatMeasuredRange(0.16, null, "fl_oz")).toBe("1 tsp");
  });

  it("formats dry ranges without mL", () => {
    expect(formatMeasuredRange(0.24, 0.56, "oz")).toBe("6.8 g – 15.9 g");
  });
});
