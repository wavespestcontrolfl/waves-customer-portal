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

  it("matches LESCO Crosscheck Plus, the house bifenthrin (label pages 29-32: 0.06%)", () => {
    expect(lookupPretreatProduct("LESCO Crosscheck Plus")).toMatchObject({ label: "LESCO Crosscheck Plus", kind: "soil_liquid", concentrationPct: "0.060" });
    expect(computePretreatChemistry({ productName: "lesco crosscheck plus", squareFootage: "1,800", linearFeet: "220", trenchDepthFt: "0.5" }))
      .toMatchObject({ status: "ok", concentrationPct: "0.060", gallons: 224 });
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
    const leadingDot = computePretreatChemistry({
      productName: "Termidor SC",
      linearFeet: "100",
      trenchDepthFt: ".5",
    });
    expect(leadingDot.verticalGallons).toBe(20); // half a foot, NOT 5 ft
  });

  it("puts LESCO Crosscheck Plus at 0.12% on the label chart's half volume, horizontal and vertical", () => {
    // Label page 31, Volume Adjustment Chart: 0.06% = 1 gal / 10 sq ft and 4 gal / 10 LF; 0.12% = 0.5 gal and 2 gal.
    for (const typed of ["0.12", "0.120", "0.12%", " 0.12 % ", ".12"]) {
      const result = computePretreatChemistry({
        productName: "LESCO Crosscheck Plus",
        squareFootage: "1,800",
        linearFeet: "220",
        trenchDepthFt: "0.5",
        concentrationPct: typed,
      });
      expect(result).toMatchObject({
        status: "ok",
        concentrationPct: "0.060", // the auto-fill value stays the label standard
        volumeAdjusted: true,
        horizontalGallons: 90,
        verticalGallons: 22,
        gallons: 112,
        gallonsText: "112",
      });
      expect(result.note).toBe(
        "90 gal horizontal (0.5 gal / 10 sq ft, the label's 0.12% volume adjustment)"
          + " + 22 gal vertical (2 gal / 10 LF per ft of depth, the label's 0.12% volume adjustment)",
      );
    }
  });

  it("keeps the labeled volume at any other dilution, and for products whose chart was not read", () => {
    // Only a bare percentage matches the chart: another unit or a range is not the 0.12% dilution.
    for (const typed of [undefined, "", "0.060", "0.06", "0.1", "0.125", "1.2", "12", "0.12 fl oz/gal", "0.12-0.125"]) {
      expect(computePretreatChemistry({
        productName: "LESCO Crosscheck Plus",
        linearFeet: "200",
        trenchDepthFt: "1",
        concentrationPct: typed,
      })).toMatchObject({ volumeAdjusted: false, verticalGallons: 80, gallons: 80 });
    }
    for (const productName of ["Talstar P", "Termidor SC", "Premise 2"]) {
      expect(computePretreatChemistry({
        productName,
        linearFeet: "200",
        trenchDepthFt: "1",
        concentrationPct: "0.12",
      })).toMatchObject({ volumeAdjusted: false, gallons: 80 });
    }
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
