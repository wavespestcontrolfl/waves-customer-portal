import { describe, expect, it } from "vitest";
import { treeDensityAffectsPrice } from "./estimateEngine";

// The Tree density box shows only when a picked service reads it with the
// inputs the form has now (pest never does: owner directive 2026-07-30).
// Server evidence is in the function comment.
describe("treeDensityAffectsPrice", () => {
  it("is false when nothing is picked or only services that ignore tree density are picked", () => {
    expect(treeDensityAffectsPrice({})).toBe(false);
    expect(treeDensityAffectsPrice()).toBe(false);
    expect(treeDensityAffectsPrice({ svcPest: true })).toBe(false);
    expect(treeDensityAffectsPrice({ svcPest: true, svcOnetimePest: true })).toBe(false);
    expect(treeDensityAffectsPrice({ svcOnetimeMosquito: true })).toBe(false);
    expect(treeDensityAffectsPrice({ svcMisting: true, svcInjection: true })).toBe(false);
    expect(treeDensityAffectsPrice({ svcTermiteBait: true, svcRodentBait: true })).toBe(false);
    expect(treeDensityAffectsPrice({ svcFlea: true })).toBe(false);
  });

  it("is true for recurring mosquito and for the flea exterior spray", () => {
    expect(treeDensityAffectsPrice({ svcMosquito: true })).toBe(true);
    expect(treeDensityAffectsPrice({ svcPest: true, svcMosquito: true })).toBe(true);
    expect(treeDensityAffectsPrice({ svcFlea: true, svcFleaExterior: true })).toBe(true);
  });

  it("is true for Tree & Shrub only while it has no tree count to price from", () => {
    expect(treeDensityAffectsPrice({ svcTs: true })).toBe(true);
    expect(treeDensityAffectsPrice({ svcPest: true, svcTs: true, treeCount: "  " })).toBe(true);
    // A typed count, zero included, is the count.
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: "6" })).toBe(false);
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: "0" })).toBe(false);
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: 0 })).toBe(false);
    // A cleared box still sends the lookup's positive count.
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: "" }, { lookupTreeCount: 9 })).toBe(false);
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: "" }, { lookupTreeCount: 0 })).toBe(true);
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: "6", svcMosquito: true })).toBe(true);
  });

  it("is true for a turf-priced service only while the lawn area is not measured", () => {
    expect(treeDensityAffectsPrice({ svcLawn: true }, { turfPricedUnconfirmed: true })).toBe(true);
    expect(treeDensityAffectsPrice({ svcLawn: true }, { turfPricedUnconfirmed: false })).toBe(false);
    expect(treeDensityAffectsPrice({ svcPest: true }, { turfPricedUnconfirmed: false })).toBe(false);
  });
});
