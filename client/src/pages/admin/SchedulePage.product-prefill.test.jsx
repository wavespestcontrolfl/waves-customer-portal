import { describe, expect, it } from "vitest";

import {
  allowedTargetLinesForServiceType,
  allowedTargetLinesForVisit,
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

describe("allowedTargetLinesForServiceType", () => {
  it("classifies single-line service names", () => {
    expect(allowedTargetLinesForServiceType("Quarterly Pest Control")).toEqual(
      new Set(["pest"]),
    );
    expect(allowedTargetLinesForServiceType("Lawn Care Program")).toEqual(
      new Set(["lawn"]),
    );
    expect(allowedTargetLinesForServiceType("Tree & Shrub Care")).toEqual(
      new Set(["tree_shrub"]),
    );
  });

  it("keeps BOTH lines for a combined visit's raw name", () => {
    expect(allowedTargetLinesForServiceType("Lawn + Tree & Shrub")).toEqual(
      new Set(["lawn", "tree_shrub"]),
    );
    // Pest-primary combined names classify pest but keep the termite line.
    expect(
      allowedTargetLinesForServiceType("Quarterly Pest + Termite Bait Station"),
    ).toEqual(new Set(["pest", "termite"]));
  });

  it("mirrors the classifier's exclusions", () => {
    // "Tree Line Mosquito Treatment" is mosquito work, not tree & shrub.
    expect(
      allowedTargetLinesForServiceType("Tree Line Mosquito Treatment"),
    ).toEqual(new Set(["mosquito"]));
    // "Palmetto" is a roach, never palm work.
    expect(
      allowedTargetLinesForServiceType("Palmetto Roach Knockdown"),
    ).toEqual(new Set(["pest"]));
  });
});

describe("allowedTargetLinesForVisit", () => {
  it("unions a scheduled add-on's line into the visit's set", () => {
    // A quarterly pest visit with a mosquito add-on really does treat for
    // mosquitoes — In2Care must keep its targets there (codex P2 r2).
    expect(
      allowedTargetLinesForVisit({
        serviceType: "Quarterly Pest Control",
        extraServiceTypes: ["One-Time Mosquito Treatment"],
      }),
    ).toEqual(new Set(["pest", "mosquito"]));
    // serviceAddons objects work too — the week/month payloads carry both.
    expect(
      allowedTargetLinesForVisit({
        serviceType: "Quarterly Pest Control",
        serviceAddons: [{ serviceName: "Lawn Care Program" }],
      }),
    ).toEqual(new Set(["pest", "lawn"]));
  });

  it("still prefers the raw name over the normalized one", () => {
    expect(
      allowedTargetLinesForVisit({
        serviceType: "Tree & Shrub Care", // week view's normalized value
        serviceTypeRaw: "Lawn + Tree & Shrub",
      }),
    ).toEqual(new Set(["lawn", "tree_shrub"]));
  });

  it("tolerates a bare row with no add-on fields", () => {
    expect(allowedTargetLinesForVisit({ serviceType: "Lawn Care Program" })).toEqual(
      new Set(["lawn"]),
    );
    expect(allowedTargetLinesForVisit({})).toEqual(
      allowedTargetLinesForServiceType(undefined),
    );
  });
});

const lines = (serviceType) => allowedTargetLinesForServiceType(serviceType);

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
    expect(filterLabelTargetsForLine(TALSTAR, lines("Quarterly Pest Control"))).toEqual([
      "Ghost ants",
      "Big-headed ants",
      "Fire ants",
    ]);
  });

  it("keeps only lawn-relevant targets on a lawn visit (fire ants are both)", () => {
    expect(filterLabelTargetsForLine(TALSTAR, lines("Lawn Care Program"))).toEqual([
      "Fire ants",
      "Southern chinch bugs",
    ]);
  });

  it("keeps fleas and ticks on a lawn visit — the turf insecticides carry them", () => {
    // Topchoice Granular is turf insect control; its label targets are all
    // yard work, so a lawn visit gets the full cap, not two (codex P2 r2).
    const TOPCHOICE = ["Fire ants", "Tawny mole crickets", "Fleas", "Ticks"];
    expect(filterLabelTargetsForLine(TOPCHOICE, lines("Lawn Care Program"))).toEqual([
      "Fire ants",
      "Tawny mole crickets",
      "Fleas",
    ]);
    // They still read on the pest line — mole crickets are the turf-only one.
    expect(
      filterLabelTargetsForLine(TOPCHOICE, lines("Quarterly Pest Control")),
    ).toEqual(["Fire ants", "Fleas", "Ticks"]);
  });

  it("prefills nothing ornamental-appropriate from a structural label on tree & shrub", () => {
    expect(filterLabelTargetsForLine(TALSTAR, lines("Tree & Shrub Care"))).toEqual([]);
  });

  it("keeps a combined visit's targets from BOTH lines", () => {
    const combined = lines("Lawn + Tree & Shrub");
    expect(filterLabelTargetsForLine(TALSTAR, combined)).toEqual([
      "Fire ants",
      "Southern chinch bugs",
    ]);
    expect(
      filterLabelTargetsForLine(["Spider mites", "Leafminers"], combined),
    ).toEqual(["Spider mites", "Leafminers"]);
  });

  it("keeps ornamental targets on tree & shrub and drops them elsewhere", () => {
    const avid = ["Spider mites", "Leafminers"];
    expect(filterLabelTargetsForLine(avid, lines("Tree & Shrub Care"))).toEqual(avid);
    // "Spider mites" must classify as ornamental, not as a spider.
    expect(filterLabelTargetsForLine(avid, lines("Quarterly Pest Control"))).toEqual([]);
  });

  it("keeps caterpillars on lawn AND tree & shrub — Conserve SC treats both", () => {
    const conserve = ["Caterpillars", "Chilli thrips", "Tropical sod webworms"];
    expect(filterLabelTargetsForLine(conserve, lines("Lawn Care Program"))).toEqual([
      "Caterpillars",
      "Tropical sod webworms",
    ]);
    expect(filterLabelTargetsForLine(conserve, lines("Tree & Shrub Care"))).toEqual([
      "Caterpillars",
      "Chilli thrips",
    ]);
  });

  it("keeps only mosquito targets on a mosquito visit", () => {
    expect(filterLabelTargetsForLine(BIFEN_IT, lines("WaveGuard Mosquito"))).toEqual([
      "Mosquitoes",
    ]);
  });

  it("keeps WDO targets on a termite visit, including carpenter ants", () => {
    const termidor = [
      "Subterranean termites",
      "Formosan termites",
      "Carpenter ants",
    ];
    expect(
      filterLabelTargetsForLine(termidor, lines("Termite Treatment")),
    ).toEqual(termidor);
    // A pest-primary combined visit keeps its termite targets too.
    expect(
      filterLabelTargetsForLine(
        termidor,
        lines("Quarterly Pest + Termite Bait Station"),
      ),
    ).toEqual(termidor);
  });

  it("keeps turf insects on lawn — mole crickets are not household crickets", () => {
    expect(
      filterLabelTargetsForLine(
        ["White grubs", "Tawny mole crickets", "Tropical sod webworms"],
        lines("Lawn Care Program"),
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
    const kept = filterLabelTargetsForLine(lesco, lines("Lawn Care Program"));
    expect(kept).toHaveLength(MAX_LABEL_TARGET_PREFILL);
    expect(kept).toEqual(lesco.slice(0, MAX_LABEL_TARGET_PREFILL));
  });

  it("defaults a missing/empty line set to the pest line", () => {
    expect(filterLabelTargetsForLine(TALSTAR, undefined)).toEqual([
      "Ghost ants",
      "Big-headed ants",
      "Fire ants",
    ]);
    expect(filterLabelTargetsForLine(TALSTAR, new Set())).toEqual([
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
