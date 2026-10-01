import { describe, expect, it } from "vitest";
import { formatLabelRate, formatMeasuredAmount, formatMeasuredRange } from "./mix-amount";

const FRACTION_VALUE = { "": 0, "⅛": 0.125, "¼": 0.25, "⅜": 0.375, "½": 0.5, "⅝": 0.625, "¾": 0.75, "⅞": 0.875 };
function spoonTeaspoons(text) {
  const match = /^(\d*)([⅛¼⅜½⅝¾⅞]?) tsp/.exec(text);
  return match ? Number(match[1] || 0) + FRACTION_VALUE[match[2]] : null;
}

describe("formatMeasuredAmount", () => {
  it("never shows mL: a small liquid dose reads as measuring-spoon teaspoons", () => {
    expect(formatMeasuredAmount(0.5, "fl_oz")).toBe("3 tsp");
    expect(formatMeasuredAmount(1 / 6, "fl oz")).toBe("1 tsp");
    expect(formatMeasuredAmount(0.0625, "fl_oz")).toBe("⅜ tsp");
  });

  it("shows a single dose as spoons only when a spoon step measures it; otherwise the exact fl oz", () => {
    // Fixed rate 8 fl oz / 100 gal in a 4-gal FlowZone: 1⅞ tsp is 2% under; 2 tsp would be over.
    expect(formatMeasuredAmount(0.32, "fl_oz")).toBe("1⅞ tsp");
    // ⅞ tsp would be 9% under and ⅛ tsp 48% under: the exact amount stands.
    expect(formatMeasuredAmount(0.16, "fl_oz")).toBe("0.16 fl oz");
    expect(formatMeasuredAmount(0.04, "fl_oz")).toBe("0.04 fl oz");
    expect(formatMeasuredAmount(0.01, "fl_oz")).toBe("0.01 fl oz");
  });

  it("never shows a spoon amount above a dose or more than 5% under it", () => {
    for (let hundredths = 1; hundredths < 100; hundredths += 1) {
      const flOz = hundredths / 100;
      const tsp = spoonTeaspoons(formatMeasuredAmount(flOz, "fl_oz"));
      if (tsp == null) continue;
      expect(tsp / 6).toBeLessThanOrEqual(flOz + 1e-9);
      expect(tsp / 6).toBeGreaterThanOrEqual(flOz * 0.95 - 1e-9);
    }
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

  it("keeps a shortage's signed deficit (on hand below zero)", () => {
    expect(formatMeasuredAmount(-2.5, "fl_oz")).toBe("-2.5 fl oz");
    expect(formatMeasuredAmount(-10, "ml")).toBe("-0.338 fl oz");
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

  it("treats a fixed rate (no high end) as a single dose", () => {
    expect(formatMeasuredRange(0.32, null, "fl_oz")).toBe("1⅞ tsp");
    expect(formatMeasuredRange(0.04, null, "fl_oz")).toBe("0.04 fl oz");
  });

  it("formats dry ranges without mL", () => {
    expect(formatMeasuredRange(0.24, 0.56, "oz")).toBe("6.8 g – 15.9 g");
  });
});

describe("formatLabelRate", () => {
  it("keeps a label's own numbers exact", () => {
    expect(formatLabelRate(0.04, 0.08, "fl_oz")).toBe("0.04–0.08 fl oz");
    expect(formatLabelRate(0.0725, 0.16, "fl_oz")).toBe("0.0725–0.16 fl oz");
    expect(formatLabelRate(2, null, "oz")).toBe("2 oz");
    expect(formatLabelRate(1, 1, "fl_oz")).toBe("1 fl oz");
  });

  it("reads a rate stored in mL or liters in fl oz, never mL", () => {
    expect(formatLabelRate(1.25, 5, "ml")).toBe("0.042–0.169 fl oz");
    expect(formatLabelRate(0.01, null, "l")).toBe("0.338 fl oz");
  });
});
