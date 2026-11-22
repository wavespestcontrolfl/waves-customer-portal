import { describe, expect, it } from "vitest";
import { treeDensityAffectsPrice } from "./estimateEngine";

// The Tree density box shows only when a picked service reads it (pest does
// not: owner directive 2026-07-30). Server evidence is in the function comment.
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

  it("is true for Tree & Shrub and for recurring mosquito", () => {
    expect(treeDensityAffectsPrice({ svcTs: true })).toBe(true);
    expect(treeDensityAffectsPrice({ svcMosquito: true })).toBe(true);
  });

  it("is false for Tree & Shrub once a tree count is typed, zero included: the count replaces the density", () => {
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: "6" })).toBe(false);
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: "0" })).toBe(false);
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: 0 })).toBe(false);
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: "  " })).toBe(true);
    expect(treeDensityAffectsPrice({ svcTs: true, treeCount: "6", svcMosquito: true })).toBe(true);
  });

  it("stays true when pest is picked alongside a service that reads it", () => {
    expect(treeDensityAffectsPrice({ svcPest: true, svcMosquito: true })).toBe(true);
    expect(treeDensityAffectsPrice({ svcPest: true, svcTs: true })).toBe(true);
  });

  it("is true for lawn services, whose turf estimate and review read it", () => {
    expect(treeDensityAffectsPrice({ svcLawn: true })).toBe(true);
    expect(treeDensityAffectsPrice({ svcOnetimeLawn: true })).toBe(true);
    expect(treeDensityAffectsPrice({ svcDethatch: true })).toBe(true);
  });

  it("is true for top dressing only when it prices from turf (no typed area)", () => {
    expect(treeDensityAffectsPrice({ svcTopdress: true })).toBe(true);
    expect(treeDensityAffectsPrice({ svcTopdress: true, topDressArea: "800" })).toBe(false);
  });

  it("is true for the flea exterior spray", () => {
    expect(treeDensityAffectsPrice({ svcFlea: true, svcFleaExterior: true })).toBe(true);
  });
});
