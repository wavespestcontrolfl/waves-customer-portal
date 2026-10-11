import { describe, expect, it } from "vitest";
import { FOOTPRINT_FREE_ONLY_SERVICES, isFootprintFreeSelection } from "./estimate-footprint";

describe("which selections generate with no home or lot size", () => {
  it.each(FOOTPRINT_FREE_ONLY_SERVICES)("%s alone does, with or without an add-on list", (key) => {
    expect(isFootprintFreeSelection([key], {})).toBe(true);
    expect(isFootprintFreeSelection([key], { web_sweep: { areaSqFt: "" } })).toBe(true);
  });

  it("the same services next to another selection do not (the footprint prices the other one)", () => {
    for (const key of FOOTPRINT_FREE_ONLY_SERVICES) {
      expect(isFootprintFreeSelection([key, "PEST"], {})).toBe(false);
      expect(isFootprintFreeSelection(["PEST", key], {})).toBe(false);
    }
  });

  it("an ordinary service alone, or nothing selected, needs the footprint", () => {
    expect(isFootprintFreeSelection(["PEST"], {})).toBe(false);
    expect(isFootprintFreeSelection(["LAWN"], undefined)).toBe(false);
    expect(isFootprintFreeSelection([], {})).toBe(false);
    expect(isFootprintFreeSelection(undefined, undefined)).toBe(false);
  });

  it("area add-ons alone do; add-ons beside any selected service do not", () => {
    const addOns = { bed_pre_emergent: { areaSqFt: 1000 } };
    expect(isFootprintFreeSelection([], addOns)).toBe(true);
    expect(isFootprintFreeSelection(["PEST"], addOns)).toBe(false);
    expect(isFootprintFreeSelection(["BEDBUG", "PEST"], addOns)).toBe(false);
  });
});
