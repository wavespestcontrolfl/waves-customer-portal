import { describe, expect, it } from "vitest";

import {
  defaultApplicationMethod,
  derivedTotalAmount,
  filterLabelTargetsForLine,
  MAX_LABEL_TARGET_PREFILL,
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

describe("filterLabelTargetsForLine", () => {
  // Real catalog rows (products_catalog.target_pests, prod 2026-08-01).
  const TALSTAR = [
    "Ghost ants",
    "Big-headed ants",
    "Fire ants",
    "Smokybrown cockroaches",
    "Southern chinch bugs",
  ];
  const BIFEN_IT = [
    "Ghost ants",
    "Big-headed ants",
    "Fire ants",
    "American cockroaches",
    "Wolf spiders",
    "Mosquitoes",
  ];

  it("drops turf targets on a pest visit and caps at the prefill max", () => {
    expect(filterLabelTargetsForLine(TALSTAR, "pest")).toEqual([
      "Ghost ants",
      "Big-headed ants",
      "Fire ants",
    ]);
  });

  it("keeps only lawn-relevant targets on a lawn visit (fire ants are both)", () => {
    expect(filterLabelTargetsForLine(TALSTAR, "lawn")).toEqual([
      "Fire ants",
      "Southern chinch bugs",
    ]);
  });

  it("prefills nothing ornamental-appropriate from a structural label on tree & shrub", () => {
    expect(filterLabelTargetsForLine(TALSTAR, "tree_shrub")).toEqual([]);
  });

  it("keeps ornamental targets on tree & shrub and drops them elsewhere", () => {
    const avid = ["Spider mites", "Leafminers"];
    expect(filterLabelTargetsForLine(avid, "tree_shrub")).toEqual(avid);
    // "Spider mites" must classify as ornamental, not as a spider.
    expect(filterLabelTargetsForLine(avid, "pest")).toEqual([]);
  });

  it("keeps only mosquito targets on a mosquito visit", () => {
    expect(filterLabelTargetsForLine(BIFEN_IT, "mosquito")).toEqual([
      "Mosquitoes",
    ]);
  });

  it("keeps WDO targets on a termite visit, including carpenter ants", () => {
    expect(
      filterLabelTargetsForLine(
        ["Subterranean termites", "Formosan termites", "Carpenter ants"],
        "termite",
      ),
    ).toEqual(["Subterranean termites", "Formosan termites", "Carpenter ants"]);
  });

  it("keeps turf insects on lawn — mole crickets are not household crickets", () => {
    expect(
      filterLabelTargetsForLine(
        ["White grubs", "Tawny mole crickets", "Tropical sod webworms"],
        "lawn",
      ),
    ).toEqual(["White grubs", "Tawny mole crickets", "Tropical sod webworms"]);
  });

  it("passes unclassified targets (nutrition goals) on any line, still capped", () => {
    const lesco = [
      "Nitrogen green-up",
      "Color & density",
      "Potassium root support",
      "Iron chlorosis (yellowing turf)",
    ];
    const kept = filterLabelTargetsForLine(lesco, "lawn");
    expect(kept).toHaveLength(MAX_LABEL_TARGET_PREFILL);
    expect(kept).toEqual(lesco.slice(0, MAX_LABEL_TARGET_PREFILL));
  });

  it("defaults an unknown category to the pest line", () => {
    expect(filterLabelTargetsForLine(TALSTAR, undefined)).toEqual([
      "Ghost ants",
      "Big-headed ants",
      "Fire ants",
    ]);
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
