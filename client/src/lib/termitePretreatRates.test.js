import { describe, expect, it } from "vitest";
import { computePretreatChemistry, lookupPretreatProduct } from "./termitePretreatRates";

describe("lookupPretreatProduct", () => {
  it("matches case-insensitively with extra whitespace", () => {
    expect(lookupPretreatProduct("  TERMIDOR   sc ")?.label).toBe("Termidor SC");
  });

  it("matches catalog names carrying a formulation suffix", () => {
    expect(lookupPretreatProduct("Termidor SC 20 oz")?.label).toBe("Termidor SC");
    expect(lookupPretreatProduct("Talstar P Professional")?.label).toBe("Talstar P");
  });

  it("does not match unrelated products or prefixes without a word break", () => {
    expect(lookupPretreatProduct("Termidor HE")).toBeNull();
    expect(lookupPretreatProduct("Taurus SC")).toBeNull();
    expect(lookupPretreatProduct("")).toBeNull();
    expect(lookupPretreatProduct(null)).toBeNull();
  });
});

describe("computePretreatChemistry", () => {
  it("returns unknown_product for blank or unrecognized products", () => {
    expect(computePretreatChemistry({ productName: "" }).status).toBe("unknown_product");
    expect(computePretreatChemistry({ productName: "Taurus SC" }).status).toBe("unknown_product");
    expect(computePretreatChemistry().status).toBe("unknown_product");
  });

  it("flags Trelona bait and Bora-Care (wood treatment) as not applicable", () => {
    // The catalog seeds "Trelona ATBS" (+ suffixed variants); ATBB is the
    // free-text alias. All must resolve — an unrecognized bait name would
    // skip the not-applicable force-clear and leave stale liquid chemistry.
    for (const name of ["Trelona ATBS", "Trelona ATBS Bait Station", "Trelona ATBS RFID", "Trelona ATBB"]) {
      const bait = computePretreatChemistry({ productName: name, squareFootage: "2000" });
      expect(bait.status).toBe("not_applicable");
      expect(bait.kind).toBe("bait");
      expect(bait.note).toMatch(/bait system/i);
    }

    const wood = computePretreatChemistry({ productName: "Bora-Care" });
    expect(wood.status).toBe("not_applicable");
    expect(wood.kind).toBe("wood_treatment");
  });

  it("computes horizontal-only gallons at 1 gal per 10 sq ft", () => {
    const result = computePretreatChemistry({ productName: "Termidor SC", squareFootage: "2400" });
    expect(result.status).toBe("ok");
    expect(result.concentrationPct).toBe("0.060");
    expect(result.gallons).toBe(240);
    expect(result.gallonsText).toBe("240");
    expect(result.verticalGallons).toBe(0);
  });

  it("computes vertical gallons at 4 gal per 10 LF per ft of depth", () => {
    const result = computePretreatChemistry({
      productName: "Talstar P",
      linearFeet: "150",
      trenchDepthFt: "1.5",
    });
    expect(result.status).toBe("ok");
    expect(result.concentrationPct).toBe("0.060");
    expect(result.gallons).toBe(90); // 150/10 * 4 * 1.5
    expect(result.assumedDepth).toBe(false);
  });

  it("converts inch trench-depth notation to feet instead of reading it as feet", () => {
    for (const notation of ["6 in", '6"', "6-inch", "6in."]) {
      const result = computePretreatChemistry({
        productName: "Termidor SC",
        linearFeet: "100",
        trenchDepthFt: notation,
      });
      expect(result.verticalGallons).toBe(20); // 100/10 * 4 * 0.5, NOT 6 ft
      expect(result.assumedDepth).toBe(false);
    }
    const feet = computePretreatChemistry({
      productName: "Termidor SC",
      linearFeet: "100",
      trenchDepthFt: "1.5 ft",
    });
    expect(feet.verticalGallons).toBe(60); // explicit ft stays feet
  });

  it("combines horizontal + vertical and assumes the 0.5 ft label-standard depth when blank", () => {
    const result = computePretreatChemistry({
      productName: "Premise 2",
      squareFootage: "1,500 sq ft",
      linearFeet: "220 LF",
    });
    expect(result.status).toBe("ok");
    expect(result.concentrationPct).toBe("0.050");
    expect(result.horizontalGallons).toBe(150);
    // Same 0.5 ft default as the pricing engine's finished-gallons math —
    // the certificate must not print different chemistry than the work order.
    expect(result.verticalGallons).toBe(44); // 220/10 * 4 * 0.5
    expect(result.gallons).toBe(194);
    expect(result.assumedDepth).toBe(true);
    expect(result.note).toMatch(/assuming the 0.5 ft label-standard depth/);
  });

  it("returns concentration with null gallons when no dimensions are entered", () => {
    const result = computePretreatChemistry({ productName: "Termidor SC" });
    expect(result.status).toBe("ok");
    expect(result.concentrationPct).toBe("0.060");
    expect(result.gallons).toBeNull();
    expect(result.gallonsText).toBe("");
  });

  it("ignores zero and non-numeric dimensions", () => {
    const result = computePretreatChemistry({
      productName: "Termidor SC",
      squareFootage: "0",
      linearFeet: "TBD",
    });
    expect(result.gallons).toBeNull();
  });

  it("rounds fractional gallons to one decimal", () => {
    const result = computePretreatChemistry({ productName: "Termidor SC", squareFootage: "1234" });
    expect(result.gallons).toBe(123.4);
    expect(result.gallonsText).toBe("123.4");
  });
});
