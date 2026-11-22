import { describe, expect, it } from "vitest";
import { pickedServiceCanReadTreeDensity } from "./estimateEngine";

// The Tree density box hides only when no picked service has any read of tree
// density (pest never does: owner directive 2026-07-30). The rule is
// service-level on purpose; the function comment says why.
describe("pickedServiceCanReadTreeDensity", () => {
  it("is false when nothing is picked or only services that never read tree density are picked", () => {
    expect(pickedServiceCanReadTreeDensity({})).toBe(false);
    expect(pickedServiceCanReadTreeDensity()).toBe(false);
    expect(pickedServiceCanReadTreeDensity({ svcPest: true })).toBe(false);
    expect(pickedServiceCanReadTreeDensity({ svcPest: true, svcOnetimePest: true })).toBe(false);
    expect(pickedServiceCanReadTreeDensity({ svcOnetimeMosquito: true })).toBe(false);
    expect(pickedServiceCanReadTreeDensity({ svcMisting: true, svcInjection: true, svcPlugging: true })).toBe(false);
    expect(pickedServiceCanReadTreeDensity({ svcTermiteBait: true, svcRodentBait: true })).toBe(false);
    expect(pickedServiceCanReadTreeDensity({ svcFlea: true })).toBe(false);
  });

  it.each([
    ["Tree & Shrub", { svcTs: true }],
    ["recurring mosquito", { svcMosquito: true }],
    ["lawn care", { svcLawn: true }],
    ["one-time lawn", { svcOnetimeLawn: true }],
    ["dethatching", { svcDethatch: true }],
    ["top dressing", { svcTopdress: true }],
    ["the flea exterior spray", { svcFlea: true, svcFleaExterior: true }],
  ])("is true for %s, alone or beside pest", (_label, picked) => {
    expect(pickedServiceCanReadTreeDensity(picked)).toBe(true);
    expect(pickedServiceCanReadTreeDensity({ svcPest: true, ...picked })).toBe(true);
  });

  it("does not hide the box on other inputs: a service that can read it keeps it shown", () => {
    expect(pickedServiceCanReadTreeDensity({ svcTs: true, treeCount: "6" })).toBe(true);
    expect(pickedServiceCanReadTreeDensity({ svcLawn: true, measuredTurfSf: "4200" })).toBe(true);
    expect(pickedServiceCanReadTreeDensity({ svcTopdress: true, topDressArea: "800" })).toBe(true);
  });
});
