import { describe, expect, it } from "vitest";
import {
  addOnActualsProblem,
  areaAddOnOption,
  areaAddOnRowLabel,
  buildAreaAddOnRequest,
  buildKnownAreas,
  isAreaAddOnOnly,
  missingAddOnActuals,
  newAddOnEntry,
  pickedGrass,
  readAreaAddOnCatalog,
  savedAreaAddOnVisit,
  savedAreaAddOns,
  tierSelectValue,
  withTierChoice,
} from "./areaAddOns";
import { calculateEstimate } from "./estimateEngine";
import { humanizeQuoteReason } from "./quoteDisplay";

const item = { key: "k", name: "K", areaLabel: "bed", tiers: [1000, 2000, 3500], limitText: "2 in 12 months", requiresGrassTrack: null };
const grassItem = { ...item, key: "g", requiresGrassTrack: "st_augustine" };

describe("area add-on catalog read", () => {
  it("fails closed on a missing, disabled or malformed block", () => {
    expect(readAreaAddOnCatalog({})).toEqual({ enabled: false, items: [] });
    expect(readAreaAddOnCatalog(null)).toEqual({ enabled: false, items: [] });
    expect(readAreaAddOnCatalog({ areaAddOns: { enabled: true, items: [] } }).enabled).toBe(false);
    expect(readAreaAddOnCatalog({ areaAddOns: { enabled: "yes", items: [item] } }).enabled).toBe(false);
    expect(readAreaAddOnCatalog({ areaAddOns: { enabled: false, items: [item] } }).items).toHaveLength(1);
  });

  it("sorts tiers and keeps a flat job's tiers as null", () => {
    const { items } = readAreaAddOnCatalog({ areaAddOns: { enabled: true, items: [{ ...item, tiers: [3500, 1000, 2000] }, { ...item, key: "flat", tiers: null }, { key: 7 }] } });
    expect(items.map((i) => i.key)).toEqual(["k", "flat"]);
    expect(items[0].tiers).toEqual([1000, 2000, 3500]);
    expect(items[1].tiers).toBeNull();
  });
});

describe("area add-on entries", () => {
  it("starts at the smallest tier that holds the known area, else the smallest tier, else larger", () => {
    expect(newAddOnEntry(item, { sqft: 1000 }).areaSqFt).toBe("1000");
    expect(newAddOnEntry(item, { sqft: 1001 }).areaSqFt).toBe("2000");
    expect(newAddOnEntry(item, null).areaSqFt).toBe("1000");
    expect(newAddOnEntry(item, { sqft: 3500.4 })).toMatchObject({ areaSqFt: "3501", larger: true });
    expect(newAddOnEntry({ ...item, tiers: null }, { sqft: 900 })).toEqual({});
  });

  it("shows the manual-quote choice for an area above the largest tier and keeps a real area with it", () => {
    expect(tierSelectValue(item, { areaSqFt: "5200" })).toBe("larger");
    expect(tierSelectValue(item, { areaSqFt: "450" })).toBe("1000");
    expect(tierSelectValue(item, { areaSqFt: "" })).toBe("");
    expect(withTierChoice(item, { areaSqFt: "2000" }, "larger", { sqft: 6000 })).toMatchObject({ larger: true, areaSqFt: "6000" });
    expect(withTierChoice(item, { areaSqFt: "2000" }, "larger", null)).toMatchObject({ larger: true, areaSqFt: "" });
    expect(withTierChoice(item, { areaSqFt: "9000", larger: true }, "2000", null)).toMatchObject({ larger: false, areaSqFt: "2000" });
  });
});

describe("grass-bound add-on entries", () => {
  it("start with no grass unless the rep already chose one; other add-ons carry no grass field", () => {
    expect(newAddOnEntry(grassItem, null)).toMatchObject({ grassType: "" });
    expect(newAddOnEntry(grassItem, null, "bermuda")).toMatchObject({ grassType: "bermuda" });
    expect(newAddOnEntry(item, null, "bermuda")).not.toHaveProperty("grassType");
  });

  it("pick up a grass only after the rep edited the grass field, never the untouched default", () => {
    const choices = [{ value: "st_augustine" }, { value: "bermuda" }];
    expect(pickedGrass({ grassType: "st_augustine", _manualFields: [] }, choices)).toBeNull();
    expect(pickedGrass({ grassType: "st_augustine" }, choices)).toBeNull();
    expect(pickedGrass({ grassType: "bermuda", _manualFields: ["bedArea", "grassType"] }, choices)).toBe("bermuda");
    expect(pickedGrass({ grassType: "unknown", _manualFields: ["grassType"] }, choices)).toBeNull();
    expect(pickedGrass(null, choices)).toBeNull();
  });

  it("send the entry's own grass, else an explicit unknown, whether the catalog or the entry says it is grass-bound", () => {
    const catalog = { enabled: true, items: [grassItem, item] };
    expect(buildAreaAddOnRequest({ g: { areaSqFt: "1000", grassType: "zoysia" }, k: { areaSqFt: "1000" } }, catalog)).toEqual([
      { key: "g", areaSqFt: 1000, grassType: "zoysia" },
      { key: "k", areaSqFt: 1000 },
    ]);
    // A null grass is "not chosen", like the empty one: the server prices it as unknown too, never as the form's grass.
    for (const entry of [{ areaSqFt: "1000" }, { areaSqFt: "1000", grassType: "" }, { areaSqFt: "1000", grassType: "  " }, { areaSqFt: "1000", grassType: null }]) {
      expect(buildAreaAddOnRequest({ g: entry }, catalog)[0].grassType).toBe("unknown");
    }
    // No catalog (not loaded): an entry that carries a grass field still sends one.
    expect(buildAreaAddOnRequest({ g: { areaSqFt: "1000", grassType: "" } })[0].grassType).toBe("unknown");
    expect(buildAreaAddOnRequest({ g: { areaSqFt: "1000", grassType: "bahia" } })[0].grassType).toBe("bahia");
  });
});

describe("request and saved estimates", () => {
  it("sends nothing for an empty selection, one entry per key otherwise, never applications", () => {
    expect(buildAreaAddOnRequest({})).toBeUndefined();
    expect(buildAreaAddOnRequest(undefined)).toBeUndefined();
    const list = buildAreaAddOnRequest({
      a: { areaSqFt: "2000", larger: false, visitContext: "sameTripAddOn", applications: 2 },
      b: {},
      c: { areaSqFt: "", larger: true },
    });
    // The visit is never inside an entry, even one saved by an older build.
    expect(list).toEqual([{ key: "a", areaSqFt: 2000 }, { key: "b" }, { key: "c" }]);
  });

  it("sends the group visit once beside the list, and nothing when no add-on is selected", () => {
    expect(areaAddOnOption({ a: {} })).toEqual({ areaAddOns: [{ key: "a" }], areaAddOnVisit: "standalone" });
    expect(areaAddOnOption({ a: {} }, null, "sameTripAddOn").areaAddOnVisit).toBe("sameTripAddOn");
    expect(areaAddOnOption({ a: {} }, null, "builderBatch").areaAddOnVisit).toBe("standalone");
    expect(areaAddOnOption({}, null, "sameTripAddOn")).toEqual({});
  });

  it("reads a saved estimate from its form snapshot first, then from the stored request", () => {
    const snapshot = { a: { areaSqFt: "1000", larger: false } };
    expect(savedAreaAddOns({ inputs: { areaAddOns: snapshot }, engineRequest: { options: { areaAddOns: [{ key: "z" }] } } })).toEqual(snapshot);
    expect(savedAreaAddOns({ inputs: {}, engineRequest: { options: { areaAddOns: [{ key: "z", areaSqFt: 700 }, { areaSqFt: 5 }] } } }))
      .toEqual({ z: { areaSqFt: "700", larger: false } });
    expect(savedAreaAddOns({})).toEqual({});
    // An entry saved with its own visit (older build) loses it.
    expect(savedAreaAddOns({ inputs: { areaAddOns: { a: { areaSqFt: "1000", visitContext: "sameTripAddOn" } } } })).toEqual({ a: { areaSqFt: "1000" } });
  });

  it("reads the saved group visit: the form field, the stored request, else same visit only if every old entry had it", () => {
    expect(savedAreaAddOnVisit({ inputs: { areaAddOnVisit: "sameTripAddOn" } })).toBe("sameTripAddOn");
    expect(savedAreaAddOnVisit({ engineRequest: { options: { areaAddOnVisit: "sameTripAddOn" } } })).toBe("sameTripAddOn");
    expect(savedAreaAddOnVisit({ inputs: { areaAddOnVisit: "bogus" } })).toBe("standalone");
    expect(savedAreaAddOnVisit({})).toBe("standalone");
    const same = { visitContext: "sameTripAddOn" };
    expect(savedAreaAddOnVisit({ inputs: { areaAddOns: { a: same, b: same } } })).toBe("sameTripAddOn");
    expect(savedAreaAddOnVisit({ inputs: { areaAddOns: { a: same, b: { visitContext: "standalone" } } } })).toBe("standalone");
    expect(savedAreaAddOnVisit({ engineRequest: { options: { areaAddOns: [{ key: "a", ...same }] } } })).toBe("sameTripAddOn");
  });

  it("labels a preview row by what it was priced as", () => {
    const row = (extra) => areaAddOnRowLabel({ service: "area_addon", ...extra }, "fallback");
    expect(row({ visitContext: "standalone", carriesVisitDrive: true })).toBe("Own visit");
    expect(row({ visitContext: "standalone" })).toBe("Own visit");
    expect(row({ visitContext: "standalone", carriesVisitDrive: false })).toBe("Own visit, with the other add-ons");
    expect(row({ visitContext: "sameTripAddOn", carriesVisitDrive: false })).toBe("Same visit");
    expect(areaAddOnRowLabel({ service: "dethatching" }, "fallback")).toBe("fallback");
  });

  it("reads a saved grass back, and the sent unknown as not chosen", () => {
    const list = [{ key: "g", areaSqFt: 1000, grassType: "zoysia" }, { key: "h", areaSqFt: 1000, grassType: "unknown" }, { key: "k", areaSqFt: 1000 }];
    expect(savedAreaAddOns({ inputs: {}, engineRequest: { options: { areaAddOns: list } } })).toEqual({
      g: { areaSqFt: "1000", larger: false, grassType: "zoysia" },
      h: { areaSqFt: "1000", larger: false, grassType: "" },
      k: { areaSqFt: "1000", larger: false },
    });
  });
});

describe("add-on-only selection", () => {
  it("is true only with no other service and at least one add-on", () => {
    expect(isAreaAddOnOnly([], { a: {} })).toBe(true);
    expect(isAreaAddOnOnly([], {})).toBe(false);
    expect(isAreaAddOnOnly([], undefined)).toBe(false);
    expect(isAreaAddOnOnly(["PEST"], { a: {} })).toBe(false);
    expect(isAreaAddOnOnly(undefined, { a: {} })).toBe(false);
  });
});

describe("known areas", () => {
  it("names the source and skips an unknown area", () => {
    const known = buildKnownAreas({ bedSqFt: "450", manualFields: ["bedArea"], lawnSqFt: 4200, turfSource: "Confirmed" });
    expect(known.bed).toMatchObject({ sqft: 450, source: "Bed area entered" });
    expect(known.lawn).toMatchObject({ sqft: 4200, source: "Confirmed lawn area" });
    expect(buildKnownAreas({ bedSqFt: "", lawnSqFt: 0, turfSource: "No estimate" })).toEqual({ bed: null, lawn: null });
  });
});

describe("server-only pricing", () => {
  it("the client mirror refuses a request that carries add-ons instead of leaving them out", () => {
    expect(() => calculateEstimate({ areaAddOns: [{ key: "web_sweep" }] })).toThrow(/server-only/);
  });

  it("gives the two custom-quote reasons plain wording", () => {
    expect(humanizeQuoteReason("area_addon_area_above_largest_tier")).toMatch(/larger than our standard add-on sizes/);
    expect(humanizeQuoteReason("area_addon_grass_not_covered_by_label_rate")).toMatch(/St\. Augustine lawns only/);
  });
});

describe("isAreaAddOnPricedPerApplication", () => {
  it("is true for an add-on row (by service or by the unit marker) and false for any other row", async () => {
    const { isAreaAddOnPricedPerApplication } = await import("./areaAddOns");
    expect(isAreaAddOnPricedPerApplication({ service: "area_addon" })).toBe(true);
    expect(isAreaAddOnPricedPerApplication({ priceUnit: "application" })).toBe(true);
    expect(isAreaAddOnPricedPerApplication({ service: "one_time_pest" })).toBe(false);
    expect(isAreaAddOnPricedPerApplication(null)).toBe(false);
  });
});

// Codex round 8 P1 on #6135: a product row for an area add-on starts at the GOVERNED rate the server carried on the
// schedule feed, never at the catalog default.
describe("the governed rate on an add-on's product row", () => {
  const arena = { id: "prod-arena", name: "Arena 50 WDG" };
  const catalogRow = { rate: 0.29, rateUnit: "oz", amountUnit: "oz", catalogRateUnit: "oz", maxLabelRatePer1000: 0.37, totalAmount: 0.58, areaValue: 2000, areaUnit: "sqft" };
  const governed = { ratePer1000: 0.147, rateUnit: "oz", productName: "Arena 50 WDG", withheld: null };
  const spot = { key: "area_addon_lawn_insect_spot", name: "Lawn Insect Spot Treatment", governed };
  const host = { completionProfile: { serviceKey: "lawn_standard" }, areaAddOns: [spot] };
  const ownVisit = { completionProfile: { serviceKey: "area_addon_lawn_insect_spot" }, areaAddOnOwn: { key: "area_addon_lawn_insect_spot", governed } };

  it("a tagged row on a host visit takes the add-on's rate, unit, ceiling and the amount for its treated area", async () => {
    const { withGovernedAddOnRate } = await import("./areaAddOns");
    expect(withGovernedAddOnRate(host, { ...arena, areaAddOnKey: spot.key }, catalogRow)).toMatchObject({
      rate: 0.147, rateUnit: "oz", amountUnit: "oz", catalogRateUnit: "oz", maxLabelRatePer1000: 0.147, totalAmount: 0.29,
    });
    // No treated area yet: no amount (the catalog's is never kept).
    expect(withGovernedAddOnRate(host, { ...arena, areaAddOnKey: spot.key }, { ...catalogRow, areaValue: "", totalAmount: "" }).totalAmount).toBe("");
  });

  it("an untagged row on a visit whose own service is a chemical add-on takes its own", async () => {
    const { withGovernedAddOnRate } = await import("./areaAddOns");
    expect(withGovernedAddOnRate(ownVisit, arena, catalogRow)).toMatchObject({ rate: 0.147, maxLabelRatePer1000: 0.147 });
  });

  it("another product, a held-back rate or a feed with no governed rate: NO rate, never the catalog default", async () => {
    const { withGovernedAddOnRate } = await import("./areaAddOns");
    const blank = { rate: "", maxLabelRatePer1000: null, totalAmount: "" };
    expect(withGovernedAddOnRate(host, { id: "p", name: "Topchoice", areaAddOnKey: spot.key }, catalogRow)).toMatchObject(blank);
    expect(withGovernedAddOnRate({ ...host, areaAddOns: [{ ...spot, governed: { ...governed, withheld: "The label rate is not verified yet." } }] }, { ...arena, areaAddOnKey: spot.key }, catalogRow)).toMatchObject(blank);
    expect(withGovernedAddOnRate({ ...host, areaAddOns: [{ key: spot.key, name: spot.name }] }, { ...arena, areaAddOnKey: spot.key }, catalogRow)).toMatchObject(blank);
    expect(withGovernedAddOnRate({ ...ownVisit, areaAddOnOwn: undefined }, arena, catalogRow)).toMatchObject(blank);
  });

  it("a row that belongs to no add-on comes back unchanged (ordinary visits, a web sweep, an add-on the visit does not carry)", async () => {
    const { withGovernedAddOnRate } = await import("./areaAddOns");
    const plain = { completionProfile: { serviceKey: "pest_general_quarterly" } };
    expect(withGovernedAddOnRate(plain, arena, catalogRow)).toBe(catalogRow);
    expect(withGovernedAddOnRate({ completionProfile: { serviceKey: "area_addon_web_sweep" } }, arena, catalogRow)).toBe(catalogRow);
    expect(withGovernedAddOnRate(host, { ...arena, areaAddOnKey: "area_addon_fire_ant_yard" }, catalogRow)).toBe(catalogRow);
    expect(withGovernedAddOnRate(null, arena, catalogRow)).toBe(catalogRow);
  });

  it("the rate reads as plain words, and not at all when held back", async () => {
    const { governedRateText } = await import("./areaAddOns");
    expect(governedRateText(governed)).toBe("0.147 oz per 1,000 sq ft");
    expect(governedRateText({ ratePer1000: 0.184, rateUnit: "fl_oz" })).toBe("0.184 fl oz per 1,000 sq ft");
    expect(governedRateText({ ...governed, withheld: "x" })).toBeNull();
    expect(governedRateText(undefined)).toBeNull();
  });

  it("the attached add-ons of any visit get fields, and a tagged chemical row is lawn family on a pest host or a web sweep visit", async () => {
    const { hostAreaAddOns, areaAddOnRowServiceType } = await import("./areaAddOns");
    expect(hostAreaAddOns(ownVisit)).toEqual([]);
    expect(hostAreaAddOns({ ...ownVisit, areaAddOns: [{ key: "area_addon_bed_pre_emergent" }, { key: "pest_x" }] })).toEqual([{ key: "area_addon_bed_pre_emergent" }]);
    const sweepVisit = { completionProfile: { serviceKey: "area_addon_web_sweep" } };
    expect(areaAddOnRowServiceType(sweepVisit, "Web Sweep", { areaAddOnKey: "area_addon_lawn_insect_spot" })).toBe("Lawn Care");
    expect(areaAddOnRowServiceType(sweepVisit, "Web Sweep", {})).toBe("Web Sweep");
    expect(areaAddOnRowServiceType(ownVisit, "Lawn Insect Spot Treatment", {})).toBe("Lawn Care");
  });
});

// Codex round 11 P2 on #6135: a row recorded for a chemical add-on is that add-on's application record, so the form asks
// for its rate, unit, treated square feet and amount before the server would refuse the completion.
describe("an add-on's application row needs its actuals", () => {
  const complete = { name: "Arena 50 WDG", areaAddOnKey: "area_addon_lawn_insect_spot", rate: 0.147, rateUnit: "oz", areaValue: 2000, areaUnit: "sqft", totalAmount: 0.29 };
  const host = { completionProfile: { serviceKey: "pest_general_quarterly" }, areaAddOns: [{ key: "area_addon_lawn_insect_spot", name: "Lawn Insect Spot Treatment" }] };
  const ownVisit = { completionProfile: { serviceKey: "area_addon_lawn_insect_spot" } };

  it("names what a row lacks, in the order the form shows it", () => {
    expect(missingAddOnActuals(complete)).toEqual([]);
    expect(missingAddOnActuals({ ...complete, rate: "" })).toEqual(["application rate"]);
    expect(missingAddOnActuals({ ...complete, rate: 0 })).toEqual(["application rate"]);
    expect(missingAddOnActuals({ ...complete, rateUnit: "" })).toEqual(["rate unit"]);
    expect(missingAddOnActuals({ ...complete, areaValue: "", areaUnit: "" })).toEqual(["treated square feet"]);
    expect(missingAddOnActuals({ ...complete, areaUnit: "linear_ft" })).toEqual(["treated square feet"]);
    expect(missingAddOnActuals({ ...complete, rate: "", areaValue: "" })).toEqual(["application rate", "treated square feet"]);
  });

  it("the total is filled from the rate and area for a per-area unit, and typed for a per-gallon mix", () => {
    expect(missingAddOnActuals({ ...complete, totalAmount: "" })).toEqual([]);
    expect(missingAddOnActuals({ ...complete, rateUnit: "lb/1000sf", totalAmount: "" })).toEqual([]);
    expect(missingAddOnActuals({ ...complete, rateUnit: "oz/gal", totalAmount: "" })).toEqual(["total amount"]);
    expect(missingAddOnActuals({ ...complete, rateUnit: "oz/gal", totalAmount: 4 })).toEqual([]);
  });

  it("the sentence names the add-on, the product and the fields, for a tagged row and for the visit's own add-on row", () => {
    expect(addOnActualsProblem(host, [{ ...complete, rate: "" }])).toBe("Lawn Insect Spot Treatment add-on: enter the application rate for Arena 50 WDG, then complete the visit.");
    expect(addOnActualsProblem(ownVisit, [{ name: "Arena 50 WDG", rate: "", areaValue: "", areaUnit: "" }])).toBe("Area add-on: enter the application rate and treated square feet for Arena 50 WDG, then complete the visit.");
    expect(addOnActualsProblem(host, [complete])).toBeNull();
  });

  it("the host's own rows and a web sweep are never checked", () => {
    expect(addOnActualsProblem(host, [{ name: "Host product", rate: "", areaValue: "", areaUnit: "" }])).toBeNull();
    expect(addOnActualsProblem(host, [{ name: "Sweep", areaAddOnKey: "area_addon_web_sweep", rate: "" }])).toBeNull();
    expect(addOnActualsProblem({ completionProfile: { serviceKey: "area_addon_web_sweep" } }, [{ name: "x", rate: "" }])).toBeNull();
    expect(addOnActualsProblem(host, undefined)).toBeNull();
  });
});
