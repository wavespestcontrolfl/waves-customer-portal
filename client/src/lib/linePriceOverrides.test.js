import { describe, expect, it } from "vitest";
import { buildLinePriceOverridesPayload, overridableLines } from "./linePriceOverrides";

describe("overridableLines", () => {
  it("lists priced one-time + specialty lines, skipping quote-required, included and roach-fee rows", () => {
    const estimate = {
      oneTime: {
        items: [
          { service: "one_time_pest", name: "One-Time Pest", price: 240 },
          { service: "pest_initial_roach", name: "Cockroach Treatment", price: 199 },
          { service: "wdo_inspection", name: "WDO", price: 300, priceOverridden: true, enginePrice: 250, priceOverrideReason: "owner" },
        ],
      },
      specItems: [
        { service: "stinging_insect", name: "Wasp", price: 250 },
        { service: "exclusion", name: "Exclusion", price: null, quoteRequired: true },
        { service: "rodent_inspection", name: "Inspection", price: 0, onProg: true },
        { service: "wdo_inspection", name: "WDO dup", price: 300 },
      ],
    };
    expect(overridableLines(estimate)).toEqual([
      { service: "one_time_pest", name: "One-Time Pest", price: 240, enginePrice: 240, priceOverridden: false, reason: "" },
      { service: "wdo_inspection", name: "WDO", price: 300, enginePrice: 250, priceOverridden: true, reason: "owner" },
      { service: "stinging_insect", name: "Wasp", price: 250, enginePrice: 250, priceOverridden: false, reason: "" },
    ]);
  });

  it("is empty without an estimate", () => {
    expect(overridableLines(null)).toEqual([]);
  });
});

describe("buildLinePriceOverridesPayload", () => {
  it("drops blank entries and keeps typed amounts with a trimmed reason", () => {
    expect(
      buildLinePriceOverridesPayload({
        one_time_pest: { price: "400", reason: " carpenter ant infestation ", name: "One-Time Pest" },
        wdo_inspection: { price: "", reason: "ignored" },
      }),
    ).toEqual({ payload: { one_time_pest: { price: 400, reason: "carpenter ant infestation" } }, error: null });
  });

  it("returns null when nothing is typed", () => {
    expect(buildLinePriceOverridesPayload({})).toEqual({ payload: null, error: null });
    expect(buildLinePriceOverridesPayload(undefined)).toEqual({ payload: null, error: null });
  });

  it("refuses a present-but-invalid amount so the operator is told instead of priced silently", () => {
    const { payload, error } = buildLinePriceOverridesPayload({
      one_time_pest: { price: "-5", name: "One-Time Pest" },
    });
    expect(payload).toBeNull();
    expect(error).toMatch(/One-Time Pest must be a positive dollar amount/);
  });
});
