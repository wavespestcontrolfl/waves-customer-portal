import { describe, expect, it } from "vitest";

import {
  allowedTargetLinesForServiceType,
  allowedTargetLinesForVisit,
  ALL_TARGET_LINES,
  defaultApplicationMethod,
  derivedTotalAmount,
  filterLabelTargetsForLine,
  labelTargetLines,
  MAX_LABEL_TARGET_PREFILL,
  productControlsTargets,
  productTargetsNutrition,
} from "./SchedulePage.jsx";

// Every distinct products_catalog.target_pests value in prod on 2026-08-01,
// UNIONED with every value the seed migrations write — a target can be seeded
// without showing up in the prod snapshot (Talpirid's "Moles" is active on any
// database built from the repo migrations, but absent from prod's catalog).
// Classification fails CLOSED — an unclassified target prefills nowhere — so
// this fixture is the tripwire: add a target the patterns don't recognize and
// this test fails instead of the prefill quietly going empty in the field.
const CATALOG_TARGETS = [
  "Aedes mosquitoes", "Aedes mosquitoes (container breeders)", "American cockroach",
  "American cockroaches", "Annual bluegrass (Poa annua)", "annual grassy weeds",
  "Anthracnose", "ants", "Ants", "Aphids", "Armyworms", "Bed bugs",
  "Big-headed ants", "Billbugs", "Broad mites", "broadleaf weeds", "Brown patch",
  "Brown patch / large patch", "Brown-banded cockroach", "Calcium deficiency",
  "Carpenter ants", "Caterpillars", "centipedes", "Chamberbitter", "Chickweed",
  "Chilli thrips", "Chinch bugs", "Clover", "cockroaches", "Cockroaches",
  "Color & density", "Crabgrass", "Crabgrass (pre-emergent)", "Crazy ants",
  "Crickets", "Culex mosquitoes", "Darkling beetles", "Deep green color",
  "Dollar spot", "Dollarweed", "Doveweed", "Drain flies", "drywood termites",
  "Drywood termites", "Earwigs", "Fairy ring", "Fall armyworms", "Ficus whitefly",
  "Fire ants", "fleas", "Fleas", "Flies", "Florida pusley", "Formosan termites",
  "Foxtail", "German cockroach", "German cockroaches", "Ghost ants", "Goosegrass",
  "Goosegrass (pre-emergent)", "Gray leaf spot", "Green kyllinga", "House flies",
  "House mice", "Iron chlorosis (yellowing turf)", "Kyllinga", "Large patch",
  "Leaf spot", "Leafminers", "Mealybugs", "Mole crickets", "moles",
  "mosquito larvae", "Mosquito larvae", "Mosquito larvae (standing water)",
  "mosquitoes", "Mosquitoes", "Nitrogen green-up", "Norway rats", "Nuisance ants",
  "Oriental cockroach", "Pantry moths & beetles", "Paper wasps", "Pharaoh ants",
  "Poa annua", "Potassium deficiency", "Potassium root support", "Purple nutsedge",
  "Pythium blight", "Rice flatsedge", "roaches", "Roof rats",
  "Root strength & stress tolerance", "Rugose spiraling whitefly", "Scale insects",
  "Scorpions", "silverfish", "Silverfish", "Smokybrown cockroaches", "Sod webworms",
  "Soft scale insects", "Southern chinch bugs", "Spider mites", "spiders",
  "Spiders", "Spurge", "subterranean termites", "Subterranean termites",
  "Summer patch", "Take-all root rot", "Tawny mole crickets", "ticks", "Ticks",
  "Torpedograss", "Tropical sod webworms", "turf disease",
  "Twospotted spider mites", "Virginia buttonweed", "Wasps", "White grubs",
  "White-footed ants", "Whiteflies", "Widow spiders", "Wolf spiders", "Wood borers",
  "Wood decay fungi", "Wood-boring beetles", "Wood-destroying beetles",
  "Yellow nutsedge",
  // Added by 20260801300000, which fills the products that carried no targets.
  "Bahiagrass", "Lawn burweed", "Palm bud rot (Phytophthora)",
  "Lethal bronzing (palm) — preventive", "Lethal yellowing (palm) — preventive",
  "Pythium blight", "Pythium damping-off", "Pythium root rot", "Wood-decay fungi",
];

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

describe("labelTargetLines", () => {
  it("classifies every target in the live catalog", () => {
    const unclassified = CATALOG_TARGETS.filter((t) => labelTargetLines(t).length === 0);
    expect(unclassified).toEqual([]);
  });

  it("fails closed on a target no pattern recognizes", () => {
    // The old behaviour passed these on EVERY line, which is how a pest visit
    // ended up prefilling "Chickweed" after its real weeds were filtered out.
    expect(labelTargetLines("Glyptotendipes paripes")).toEqual([]);
    expect(filterLabelTargetsForLine(["Glyptotendipes paripes"], lines("Quarterly Pest Control")))
      .toEqual([]);
  });

  it("keeps lawn weeds and turf diseases off a pest visit", () => {
    // Every one of these used to fail open.
    const wasFailOpen = [
      "Chickweed",
      "Foxtail",
      "Rice flatsedge",
      "Anthracnose",
      "Summer patch",
      "Leaf spot",
    ];
    wasFailOpen.forEach((t) => expect(labelTargetLines(t)).toEqual(["lawn"]));
    expect(filterLabelTargetsForLine(wasFailOpen, lines("Quarterly Pest Control"))).toEqual([]);
    // SpeedZone Southern on a pest visit now prefills nothing at all, rather
    // than dropping its three real weeds and keeping the unrecognized one.
    expect(
      filterLabelTargetsForLine(
        ["Dollarweed", "Clover", "Spurge", "Chickweed"],
        lines("Quarterly Pest Control"),
      ),
    ).toEqual([]);
  });

  it("still distinguishes ornamental leaf spot from the turf one", () => {
    expect(labelTargetLines("Fungal leaf spot")).toEqual(["tree_shrub"]);
    expect(labelTargetLines("Gray leaf spot")).toEqual(["lawn"]);
    expect(labelTargetLines("Leaf spot")).toEqual(["lawn"]);
  });

  it("passes nutrition goals on every line", () => {
    // A fertilizer gets applied to turf and to palms alike.
    ["Nitrogen green-up", "Potassium deficiency", "Color & density"].forEach((t) =>
      expect(labelTargetLines(t)).toEqual(ALL_TARGET_LINES),
    );
    // But an explicitly turf-worded goal stays on the lawn line.
    expect(labelTargetLines("Iron chlorosis (yellowing turf)")).toEqual(["lawn"]);
  });

  it("reads darkling beetles as a structural pest", () => {
    // Elector PSP carries it next to house flies.
    expect(labelTargetLines("Darkling beetles")).toEqual(["pest"]);
  });

  it("NEVER prefills a target nothing controls", () => {
    // UF/IFAS: Ganoderma butt rot has no chemical control and Thielaviopsis
    // trunk rot has no prevention or cure. A chip on a completed visit reads
    // as "this product treated it", so these must never fill automatically —
    // on ANY line, and even if someone adds them to a product's catalog row.
    ["Ganoderma butt rot", "Ganoderma zonatum", "Thielaviopsis trunk rot"].forEach((t) =>
      expect(labelTargetLines(t)).toEqual([]),
    );
    ALL_TARGET_LINES.forEach((line) =>
      expect(
        filterLabelTargetsForLine(
          ["Ganoderma butt rot", "Palm leaf spot"],
          new Set([line]),
        ),
      ).not.toContain("Ganoderma butt rot"),
    );
  });

  it("files palm diseases as tree & shrub, not turf", () => {
    // The lawn pattern claims a bare "leaf spot", so without an ornamental
    // check first "Palm leaf spot" would file as turf.
    [
      "Palm leaf spot",
      "Palm bud rot (Phytophthora)",
      "Lethal bronzing (palm) — preventive",
      "Lethal yellowing (palm) — preventive",
      "Fusarium wilt (palm)",
      "Downy mildew",
    ].forEach((t) => expect(labelTargetLines(t)).toEqual(["tree_shrub"]));
    // Turf oomycetes keep their own wording and stay on the lawn line.
    expect(labelTargetLines("Pythium blight")).toEqual(["lawn"]);
    expect(labelTargetLines("Pythium damping-off")).toEqual(["lawn"]);
    expect(labelTargetLines("Pythium root rot")).toEqual(["lawn"]);
    // A palm visit gets the palm disease; a lawn visit gets none of it.
    expect(
      filterLabelTargetsForLine(
        ["Lethal bronzing (palm) — preventive"],
        lines("Tree & Shrub Care"),
      ),
    ).toEqual(["Lethal bronzing (palm) — preventive"]);
    expect(
      filterLabelTargetsForLine(
        ["Lethal bronzing (palm) — preventive"],
        lines("Lawn Care Program"),
      ),
    ).toEqual([]);
  });

  it("classifies the weeds and WDO wording the fill migration introduces", () => {
    expect(labelTargetLines("Bahiagrass")).toEqual(["lawn"]);
    expect(labelTargetLines("Lawn burweed")).toEqual(["lawn"]);
    // Hyphenated and spaced spellings both read as WDO work.
    expect(labelTargetLines("Wood-decay fungi")).toEqual(["termite"]);
    expect(labelTargetLines("Wood decay fungi")).toEqual(["termite"]);
  });

  it("reads moles as a pest target without stealing mole crickets", () => {
    // Talpirid's only target is "Moles"; failing closed would have left a mole
    // treatment with nothing prefilled at all (codex P2 r3).
    expect(labelTargetLines("Moles")).toEqual(["pest"]);
    expect(filterLabelTargetsForLine(["Moles"], lines("Quarterly Pest Control"))).toEqual([
      "Moles",
    ]);
    // The turf pattern still claims mole crickets first.
    expect(labelTargetLines("Tawny mole crickets")).toEqual(["lawn"]);
    expect(labelTargetLines("Mole crickets")).toEqual(["lawn"]);
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
