// @vitest-environment jsdom
/**
 * buildTurfRequestProfile — commercial-suite footprint fix (primary review
 * of PR #4840, item C.4): the function used to overwrite footprint with
 * homeSqFt / stories for every commercial profile, so a 1,400 sq ft suite
 * in a 2-story plaza priced a 700 sq ft footprint. A suite-sized profile
 * (server/services/commercial-suite-size/, marked by a `suiteSize` field)
 * has no story count of its own — the suite IS the footprint.
 */
import { describe, expect, it } from "vitest";
import { buildTurfRequestProfile, termiteFootprintFromHome } from "./EstimateToolViewV2";

const baseForm = {
  homeSqFt: "",
  lotSqFt: "",
  stories: "",
  bedArea: "",
  hasPool: "NO",
  hasPoolCage: "NO",
  isCommercial: "YES",
};

function suiteProfile(overrides = {}) {
  return {
    homeSqFt: 1400,
    stories: 2, // the BUILDING's story count — the suite has none of its own
    isCommercial: true,
    suiteSize: { value: 1400, source: "license_seats", confidence: "medium", businessName: "Test Taco Shop" },
    ...overrides,
  };
}

describe("buildTurfRequestProfile — suite-sized commercial profile", () => {
  it("keeps footprint equal to the suite's own size, never divided by the building's story count", () => {
    const profile = buildTurfRequestProfile(suiteProfile(), baseForm);
    expect(profile.homeSqFt).toBe(1400);
    expect(profile.footprint).toBe(1400);
  });

  it("still divides by stories for an ordinary (non-suite) commercial whole-building profile", () => {
    const buildingProfile = { homeSqFt: 2800, stories: 2, isCommercial: true };
    const profile = buildTurfRequestProfile(buildingProfile, baseForm);
    expect(profile.footprint).toBe(1400); // 2800 / 2 stories, unaffected — the pre-existing behavior
  });

  it("a manually-edited home sqft on a suite profile still keeps footprint === homeSqFt (single-story basis)", () => {
    const profile = buildTurfRequestProfile(suiteProfile(), { ...baseForm, homeSqFt: "1650" });
    expect(profile.homeSqFt).toBe(1650);
    expect(profile.footprint).toBe(1650);
  });

  it("a suite profile with footprintUnknown never derives a footprint anyway (suite branch is checked first)", () => {
    const profile = buildTurfRequestProfile(suiteProfile({ footprintUnknown: true }), baseForm);
    expect(profile.footprint).toBe(1400);
  });
});

describe("termiteFootprintFromHome", () => {
  it("a suite-sized lookup never divides by the building's story count", () => {
    expect(termiteFootprintFromHome(1400, "2", true)).toBe(1400);
  });
  it("an ordinary home still derives footprint from stories", () => {
    expect(termiteFootprintFromHome(2400, "2", false)).toBe(1200);
    expect(termiteFootprintFromHome(2400, "", false)).toBe(2400);
  });
});
