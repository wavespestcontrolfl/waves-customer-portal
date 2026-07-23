import { describe, expect, it } from "vitest";

import {
  defaultApplicationMethod,
  derivedTotalAmount,
  productControlsTargets,
  productTargetsNutrition,
} from "./SchedulePage.jsx";

describe("defaultApplicationMethod", () => {
  it("routes liquid fertilizers to broadcast spray, not granular", () => {
    expect(
      defaultApplicationMethod(
        { name: "LESCO K-Flow 0-0-25", category: "fertilizer", rate_unit: "fl_oz" },
        "lawn_care",
      ),
    ).toBe("broadcast_spray");
    expect(
      defaultApplicationMethod(
        {
          name: "LESCO Green Flo 6-0-0 10% Ca Turfgrass Liquid Fertilizer",
          category: "Fertilizer",
        },
        "lawn_care",
      ),
    ).toBe("broadcast_spray");
  });

  it("keeps granular fertilizers on granular broadcast", () => {
    expect(
      defaultApplicationMethod(
        {
          name: "LESCO 24-0-11 75% PolyPlus OPTI 3% Fe 1% Mn AS Turfgrass Granular Fertilizer",
          category: "Fertilizer",
          rate_unit: "lb",
        },
        "lawn_care",
      ),
    ).toBe("granular_broadcast");
  });

  it("still routes baits to bait placement", () => {
    expect(
      defaultApplicationMethod(
        { name: "Advion Cockroach Gel Bait", category: "bait" },
        "pest_control",
      ),
    ).toBe("bait_placement");
  });
});

describe("derivedTotalAmount", () => {
  it("computes rate × sqft / 1,000 in the rate's unit", () => {
    expect(derivedTotalAmount(3, 4000)).toBe(12);
    expect(derivedTotalAmount("3.0000", "4000")).toBe(12);
    expect(derivedTotalAmount(0.5, 5500)).toBe(2.75);
  });

  it("stays blank when either side is missing or unusable", () => {
    expect(derivedTotalAmount("", 4000)).toBe("");
    expect(derivedTotalAmount(3, "")).toBe("");
    expect(derivedTotalAmount(0, 4000)).toBe("");
    expect(derivedTotalAmount("abc", 4000)).toBe("");
  });
});

describe("productControlsTargets", () => {
  it("hides targets for adjuvants, soil products, and growth regulators", () => {
    expect(productControlsTargets({ category: "Adjuvant" })).toBe(false);
    expect(productControlsTargets({ category: "soil_surfactant" })).toBe(false);
    expect(productControlsTargets({ category: "Plant Growth Regulator" })).toBe(false);
  });

  it("keeps targets for fertilizers — they collect nutrition goals", () => {
    expect(productControlsTargets({ category: "fertilizer" })).toBe(true);
    expect(productControlsTargets({ category: "Micronutrient Fertilizer" })).toBe(true);
  });

  it("keeps targets for pest/weed/disease control products and unknown rows", () => {
    expect(productControlsTargets({ category: "insecticide" })).toBe(true);
    expect(productControlsTargets({ category: "herbicide" })).toBe(true);
    expect(productControlsTargets({ category: "termiticide" })).toBe(true);
    expect(productControlsTargets({ category: "" })).toBe(true);
    expect(productControlsTargets(undefined)).toBe(true);
  });
});

describe("productTargetsNutrition", () => {
  it("flags fertilizer-family products for the nutrition suggestion list", () => {
    expect(productTargetsNutrition({ category: "fertilizer" })).toBe(true);
    expect(productTargetsNutrition({ category: "Micronutrient Fertilizer" })).toBe(true);
    expect(productTargetsNutrition({ product_category: "Biostimulant" })).toBe(true);
  });

  it("stays false for control products and unknown rows", () => {
    expect(productTargetsNutrition({ category: "insecticide" })).toBe(false);
    expect(productTargetsNutrition({ category: "herbicide" })).toBe(false);
    expect(productTargetsNutrition({ category: "" })).toBe(false);
    expect(productTargetsNutrition(undefined)).toBe(false);
  });
});
