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
import { isCommercialEstimateInput } from "../../lib/estimateEngine";

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

  // Primary review of PR #4840 r7 P1: an operator corrects a false-positive
  // suite lookup to residential — the frozen suiteSize on baseProfile must
  // no longer force a single-story footprint once the CURRENT form says
  // residential.
  it("a suite-flagged baseProfile with the form corrected to residential uses the ordinary per-story footprint, not homeSqFt as-is", () => {
    const correctedForm = { ...baseForm, isCommercial: "NO", propertyType: "Single Family" };
    const profile = buildTurfRequestProfile(suiteProfile(), correctedForm);
    expect(profile.isCommercial).toBe(false);
    // 1,400 / 2 stories = 700 — the ordinary residential derivation, not the
    // suite's frozen 1,400-as-footprint rule.
    expect(profile.footprint).toBe(700);
  });

  it("a suite-flagged baseProfile still uses the suite rule while the form says commercial (control)", () => {
    const profile = buildTurfRequestProfile(suiteProfile(), { ...baseForm, isCommercial: "YES" });
    expect(profile.isCommercial).toBe(true);
    expect(profile.footprint).toBe(1400);
  });

  // Primary review of PR #4840 r7 P2: the server's footprintSizeEstimated
  // check now reads THIS provenance stamp instead of comparing the priced
  // value to the type default — an operator who typed/confirmed a value
  // equal to the default must still clear the flag.
  describe("_homeSqFtManuallyEdited provenance stamp (server footprintSizeEstimated gate)", () => {
    it("is true once the operator has typed into the Home Sq Ft box", () => {
      const profile = buildTurfRequestProfile(suiteProfile(), { ...baseForm, _homeSqFtEdited: true });
      expect(profile._homeSqFtManuallyEdited).toBe(true);
    });
    it("is false/absent for an untouched lookup prefill", () => {
      const profile = buildTurfRequestProfile(suiteProfile(), baseForm);
      expect(profile._homeSqFtManuallyEdited).toBe(false);
    });
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

// Primary review of PR #4840 r7 P1: the termite-footprint prefill effect
// gates `form._suiteSizedLookup` on the form STILL being commercial
// (`suiteSized = form._suiteSizedLookup && isCommercialEstimateInput(form)`)
// before passing it to termiteFootprintFromHome — this exercises that exact
// composed guard so a stale _suiteSizedLookup flag from before a
// residential correction can never re-freeze the single-story rule.
describe("the termite-footprint effect's suite gate (form._suiteSizedLookup && isCommercialEstimateInput(form))", () => {
  it("a suite lookup still classified commercial: the suite rule applies", () => {
    const form = { isCommercial: "YES", propertyType: "Commercial", _suiteSizedLookup: true, homeSqFt: "1400", stories: "2" };
    const suiteSized = form._suiteSizedLookup && isCommercialEstimateInput(form);
    expect(termiteFootprintFromHome(form.homeSqFt, form.stories, suiteSized)).toBe(1400);
  });

  it("a suite lookup corrected to residential: the suite rule no longer applies — per-story math resumes", () => {
    const form = { isCommercial: "NO", propertyType: "Single Family", _suiteSizedLookup: true, homeSqFt: "1400", stories: "2" };
    const suiteSized = form._suiteSizedLookup && isCommercialEstimateInput(form);
    expect(suiteSized).toBe(false);
    expect(termiteFootprintFromHome(form.homeSqFt, form.stories, suiteSized)).toBe(700);
  });
});
