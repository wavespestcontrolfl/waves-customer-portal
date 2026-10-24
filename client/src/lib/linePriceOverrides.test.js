import { describe, expect, it } from "vitest";
import { buildLinePriceOverridesPayload, overridableLines } from "./linePriceOverrides";

describe("overridableLines", () => {
  it("lists only the rows the engine stamped priceOverridable, once each", () => {
    const estimate = {
      oneTime: {
        items: [
          { service: "one_time_pest", name: "One-Time Pest", price: 240, priceOverridable: true },
          { service: "pest_initial_roach", name: "Cockroach Treatment", price: 199 },
          {
            service: "wdo_inspection", name: "WDO", price: 300, priceOverridable: true,
            priceOverridden: true, enginePrice: 250, priceOverrideReason: "owner",
          },
          // Mapper-built from a nested engine field: priced, but no engine line carries the key.
          { service: "mosquito_misting_installation", name: "Smart system Installation", price: 4595 },
        ],
      },
      specItems: [
        { service: "stinging_insect", name: "Wasp", price: 250, priceOverridable: true },
        { service: "exclusion", name: "Exclusion", price: null, quoteRequired: true },
        { service: "rodent_inspection", name: "Inspection", price: 0, onProg: true },
        { service: "trap_only_retainer", name: "Trap-Only Retainer", price: 495, retainerBilling: "annual" },
        { service: "wdo_inspection", name: "WDO dup", price: 300, priceOverridable: true },
      ],
    };
    expect(overridableLines(estimate)).toEqual([
      { service: "one_time_pest", name: "One-Time Pest", price: 240, enginePrice: 240, priceOverridden: false, reason: "" },
      { service: "wdo_inspection", name: "WDO", price: 300, enginePrice: 250, priceOverridden: true, reason: "owner" },
      { service: "stinging_insect", name: "Wasp", price: 250, enginePrice: 250, priceOverridden: false, reason: "" },
    ]);
  });

  it("reads the engine number of a total-priced line from engineTotal", () => {
    const estimate = {
      specItems: [{
        service: "flea_package", name: "Flea", price: 600, priceOverridable: true, priceOverridden: true, engineTotal: 350,
      }],
    };
    expect(overridableLines(estimate)[0]).toMatchObject({ price: 600, enginePrice: 350, priceOverridden: true });
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
