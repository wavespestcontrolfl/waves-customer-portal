import { describe, expect, it } from "vitest";
import { tankCoverageLines, tankFillLines } from "./protocolTankOptions";

describe("named per-tank lines (no sprayer picked, the big tanks differ)", () => {
  it("names each tank's coverage and full-tank fill; one rig gives none", () => {
    const equipment = { tankCoverageSqft: null, tankOptions: [
      { systemName: "110-Gallon Spray Tank #1", carrierGalPer1000: 2, tankCoverageSqft: 55000 },
      { systemName: "Udor tank #2", carrierGalPer1000: 4, tankCoverageSqft: 27500 },
    ] };
    expect(tankCoverageLines(equipment)).toEqual([
      "110-Gallon Spray Tank #1: 2 gal per 1,000 sq ft, 55,000 sq ft per tank",
      "Udor tank #2: 4 gal per 1,000 sq ft, 27,500 sq ft per tank",
    ]);
    const item = { tankAmounts: { tankOptions: [
      { sprayerName: "110-Gallon Spray Tank #1", fullTank: { gallons: 110, amount: 20.185, amountUnit: "fl_oz" } },
      { sprayerName: "Udor tank #2", fullTank: { gallons: 110, amount: 10.092, amountUnit: "fl_oz" } },
    ] } };
    expect(tankFillLines(item)).toEqual(["20.185 fl oz per 110 gal · 110-Gallon Spray Tank #1", "10.092 fl oz per 110 gal · Udor tank #2"]);
    expect(tankCoverageLines({ tankCoverageSqft: 55000 })).toEqual([]);
    expect(tankFillLines({ tankAmounts: {} })).toEqual([]);
    // One rig: the single figure given as the fallback.
    expect(tankCoverageLines({ tankCoverageSqft: 55000 }, "55,000 sq ft/tank")).toEqual(["55,000 sq ft/tank"]);
    expect(tankFillLines({ ...item, fullTankMix: { amount: 1 } }, "1 oz/tank")).toEqual(["1 oz/tank"]);
  });
});
