import { describe, expect, it } from "vitest";
import { calculateEstimate } from "./estimateEngine";

// The browser fallback never stamps the 2026-11-26 specialty rule (pricingMetadata.legacySpecialty1126): it does not mirror the
// $349 added bed bug room, the $85 per added mosquito acre above 2 acres or the wasp / yellow jacket levels, so a fallback save with
// any of these rows is refused by the server (409, reload) and priced there (admin-estimate-persistence
// assertSpecialtyClientFallbackSave).
const home = (overrides = {}) => ({
  homeSqFt: 1500, stories: "1", lotSqFt: 10000, propertyType: "Single Family", isAfterHours: false, isRecurringCustomer: false,
  ...overrides,
});
const stamped = (est) => Object.prototype.hasOwnProperty.call(est.pricingMetadata, "legacySpecialty1126")
  || Object.prototype.hasOwnProperty.call(est.routingMetadata || {}, "legacySpecialty1126");

describe("the browser fallback does not stamp bed bug, mosquito or wasp rows", () => {
  it("bed bug, mosquito (any lot size) and a priced wasp carry no specialty stamp", () => {
    const bedBug = calculateEstimate(home({ svcBedbug: true, bedbugMethod: "CHEMICAL", bedbugSeverity: "light", bedbugPrepStatus: "ready", bedbugOccupancyType: "singleFamily", bedbugRooms: 3 }));
    expect(bedBug.oneTime.specItems.some((item) => item.name === "Bed Bug Chemical")).toBe(true);
    expect(stamped(bedBug)).toBe(false);
    for (const lotSqFt of [10000, 87120, 130680]) {
      const mosquito = calculateEstimate(home({ lotSqFt, svcMosquito: true }));
      expect(mosquito.results.mq.length).toBeGreaterThan(0);
      expect(stamped(mosquito)).toBe(false);
    }
    const wasp = calculateEstimate(home({ svcWasp: true }));
    expect(wasp.oneTime.specItems.some((item) => item.name === "Wasp/Bee")).toBe(true);
    expect(stamped(wasp)).toBe(false);
  });

  it("a wasp included on the recurring pest program is a $0 row in the full specItems list only, and is not stamped either", () => {
    const est = calculateEstimate(home({ svcPest: true, svcWasp: true }));
    const row = est.specItems.find((item) => item.name === "Wasp/Bee");
    expect(row).toMatchObject({ price: 0, onProg: true });
    expect(est.oneTime.specItems.some((item) => item.name === "Wasp/Bee")).toBe(false);
    expect(stamped(est)).toBe(false);
  });

  it("the price math for these rows is the same as before the rule (the browser mirrors none of it)", () => {
    const rooms = (n) => calculateEstimate(home({ svcBedbug: true, bedbugMethod: "CHEMICAL", bedbugSeverity: "light", bedbugPrepStatus: "ready", bedbugOccupancyType: "singleFamily", bedbugRooms: n }))
      .oneTime.specItems.find((item) => item.name === "Bed Bug Chemical").price;
    // The old per-room curve: 2 rooms is not one room + $349.
    expect(rooms(2) - rooms(1)).not.toBe(349);
    const mosquito = (lotSqFt) => calculateEstimate(home({ lotSqFt, svcMosquito: true })).results.mq[0].pv;
    expect(mosquito(130680)).toBe(mosquito(87120));
  });
});
