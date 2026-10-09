import { describe, expect, it } from "vitest";
import {
  buildAreaAddOnRequest,
  buildKnownAreas,
  isAreaAddOnOnly,
  newAddOnEntry,
  pickedGrass,
  readAreaAddOnCatalog,
  savedAreaAddOns,
  tierSelectValue,
  withTierChoice,
} from "./areaAddOns";
import { calculateEstimate } from "./estimateEngine";
import { humanizeQuoteReason } from "./quoteDisplay";

const item = { key: "k", name: "K", areaLabel: "bed", tiers: [1000, 2000, 3500], maxPerYear: 2, requiresGrassTrack: null };
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
    expect(newAddOnEntry({ ...item, tiers: null }, { sqft: 900 })).toEqual({ visitContext: "standalone" });
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
      { key: "g", areaSqFt: 1000, visitContext: "standalone", grassType: "zoysia" },
      { key: "k", areaSqFt: 1000, visitContext: "standalone" },
    ]);
    for (const entry of [{ areaSqFt: "1000" }, { areaSqFt: "1000", grassType: "" }, { areaSqFt: "1000", grassType: "  " }]) {
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
      b: { visitContext: "standalone" },
      c: { areaSqFt: "", larger: true },
    });
    expect(list).toEqual([
      { key: "a", areaSqFt: 2000, visitContext: "sameTripAddOn" },
      { key: "b", visitContext: "standalone" },
      { key: "c", visitContext: "standalone" },
    ]);
  });

  it("reads a saved estimate from its form snapshot first, then from the stored request", () => {
    const snapshot = { a: { areaSqFt: "1000", larger: false, visitContext: "standalone" } };
    expect(savedAreaAddOns({ inputs: { areaAddOns: snapshot }, engineRequest: { options: { areaAddOns: [{ key: "z" }] } } })).toBe(snapshot);
    expect(savedAreaAddOns({ inputs: {}, engineRequest: { options: { areaAddOns: [{ key: "z", areaSqFt: 700, visitContext: "sameTripAddOn" }, { areaSqFt: 5 }] } } }))
      .toEqual({ z: { areaSqFt: "700", larger: false, visitContext: "sameTripAddOn" } });
    expect(savedAreaAddOns({})).toEqual({});
  });

  it("reads a saved grass back, and the sent unknown as not chosen", () => {
    const list = [{ key: "g", areaSqFt: 1000, grassType: "zoysia" }, { key: "h", areaSqFt: 1000, grassType: "unknown" }, { key: "k", areaSqFt: 1000 }];
    expect(savedAreaAddOns({ inputs: {}, engineRequest: { options: { areaAddOns: list } } })).toEqual({
      g: { areaSqFt: "1000", larger: false, visitContext: "standalone", grassType: "zoysia" },
      h: { areaSqFt: "1000", larger: false, visitContext: "standalone", grassType: "" },
      k: { areaSqFt: "1000", larger: false, visitContext: "standalone" },
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
