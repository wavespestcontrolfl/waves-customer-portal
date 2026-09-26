import { describe, expect, it } from "vitest";
import { palmPrefillAllowed, subdivisionMedianPrefillSqFt, lookupHomeSqFtPrefill, homeSqFtIsUnverifiedPlatMedian, lookupLotIsUnitParcel, scopeUnitParcelProfile } from "./lookupPrefill";

describe("palm-count prefill gate", () => {
  it("prefills a server-trusted count", () => {
    expect(palmPrefillAllowed({ estimatedPalmCount: 7, palmCountTrusted: true })).toBe(true);
  });

  it("suppresses an affirmatively distrusted count — the operator counts instead", () => {
    expect(palmPrefillAllowed({ estimatedPalmCount: 9, palmCountTrusted: false })).toBe(false);
  });

  it("keeps the pre-existing prefill for legacy payloads with no verdict", () => {
    expect(palmPrefillAllowed({ estimatedPalmCount: 7 })).toBe(true);
  });

  it("never prefills without a positive count", () => {
    expect(palmPrefillAllowed({ estimatedPalmCount: 0, palmCountTrusted: true })).toBe(false);
    expect(palmPrefillAllowed(null)).toBe(false);
  });
});

describe("condo record on the development parcel (unit_parcel lot flag)", () => {
  const flagged = {
    lotSqFt: 400000, estimatedTurfSf: 25000, estimatedBedAreaSf: 6000, imperviousSurfacePercent: 35,
    shrubDensity: "HEAVY",
    fieldVerifyFlags: [{ field: "lotSize", scope: "unit_parcel", reason: "development parcel" }],
  };

  it("detects only the scoped lot flag", () => {
    expect(lookupLotIsUnitParcel(flagged)).toBe(true);
    // A generic lot disagreement impugns the number, not its scope.
    expect(lookupLotIsUnitParcel({ fieldVerifyFlags: [{ field: "lotSize", reason: "sources disagree" }] })).toBe(false);
    expect(lookupLotIsUnitParcel({})).toBe(false);
    expect(lookupLotIsUnitParcel(null)).toBe(false);
  });

  it("withholds the parcel-scope area reads and keeps everything else", () => {
    const scoped = scopeUnitParcelProfile(flagged);
    expect(scoped.estimatedTurfSf).toBeUndefined();
    expect(scoped.estimatedBedAreaSf).toBeUndefined();
    expect(scoped.imperviousSurfacePercent).toBeUndefined();
    expect(scoped.shrubDensity).toBe("HEAVY");
    // The lot stays as display context — it is simply never prefilled.
    expect(scoped.lotSqFt).toBe(400000);
    // The caller's object is not mutated; an unflagged profile passes through.
    expect(flagged.estimatedTurfSf).toBe(25000);
    const house = { lotSqFt: 9000, estimatedTurfSf: 5000 };
    expect(scopeUnitParcelProfile(house)).toBe(house);
    expect(scopeUnitParcelProfile(null)).toBeNull();
  });
});

// Unassessed vacant parcel (new construction the roll hasn't posted): the
// server exposes the plat's assessed-neighbor median beside an EMPTY homeSqFt.
const VACANT_WITH_MEDIAN = { homeSqFt: 0, unassessedVacantParcel: true, subdivisionMedian: { medianSqft: 3071, sampleCount: 174, minSqft: 2101, maxSqft: 3242 } };

describe("plat-median home sq ft prefill", () => {
  it("prefills the plat median when the record has no home sq ft", () => {
    expect(subdivisionMedianPrefillSqFt(VACANT_WITH_MEDIAN)).toBe(3071);
    expect(lookupHomeSqFtPrefill(VACANT_WITH_MEDIAN)).toBe("3071");
  });

  it("a real record value always wins over the median", () => {
    const built = { ...VACANT_WITH_MEDIAN, homeSqFt: 2980 };
    expect(subdivisionMedianPrefillSqFt(built)).toBeNull();
    expect(lookupHomeSqFtPrefill(built)).toBe("2980");
  });

  it("leaves the field empty without a usable median — the flat default applies as before", () => {
    expect(lookupHomeSqFtPrefill({ homeSqFt: 0, subdivisionMedian: null })).toBe("");
    expect(lookupHomeSqFtPrefill({ homeSqFt: 0, subdivisionMedian: { medianSqft: 0, sampleCount: 174 } })).toBe("");
    expect(lookupHomeSqFtPrefill(null)).toBe("");
    expect(subdivisionMedianPrefillSqFt(undefined)).toBeNull();
  });

  it("never prefills for an unconfirmed address — the parcel itself may be wrong", () => {
    const flagged = { ...VACANT_WITH_MEDIAN, fieldVerifyFlags: [{ field: "address", priority: "HIGH", reason: "house number mismatch" }] };
    expect(subdivisionMedianPrefillSqFt(flagged)).toBeNull();
    expect(lookupHomeSqFtPrefill(flagged)).toBe("");
    expect(homeSqFtIsUnverifiedPlatMedian({ homeSqFt: "3071" }, flagged)).toBe(false);
    // Other flags (the vacant-parcel situation flag itself) do not block it.
    const vacantFlagged = { ...VACANT_WITH_MEDIAN, fieldVerifyFlags: [{ field: "vacantParcel", priority: "HIGH", reason: "x" }] };
    expect(subdivisionMedianPrefillSqFt(vacantFlagged)).toBe(3071);
  });

  it("rounds a fractional median to a whole sq ft", () => {
    expect(subdivisionMedianPrefillSqFt({ homeSqFt: 0, subdivisionMedian: { medianSqft: 3070.5 } })).toBe(3071);
  });
});

describe("plat-median prefill across save and reopen", () => {
  // A saved estimate stores the form's homeSqFt (the median) on the profile
  // it restores on reopen, still carrying subdivisionMedian.
  const REOPENED = { ...VACANT_WITH_MEDIAN, homeSqFt: 3071 };

  it("still reads the restored median as the estimate, so the verify guard stays on", () => {
    expect(subdivisionMedianPrefillSqFt(REOPENED)).toBe(3071);
    expect(homeSqFtIsUnverifiedPlatMedian({ homeSqFt: "3071" }, REOPENED)).toBe(true);
  });

  it("a size the operator typed before saving stays verifiable after reopen (edited flag lost)", () => {
    expect(homeSqFtIsUnverifiedPlatMedian({ homeSqFt: "3000" }, { ...VACANT_WITH_MEDIAN, homeSqFt: 3000 })).toBe(false);
    expect(subdivisionMedianPrefillSqFt({ ...VACANT_WITH_MEDIAN, homeSqFt: 3000 })).toBeNull();
  });
});

describe("plat-median prefill never saves as tech-verified", () => {
  it("blocks the verify save while the prefill is untouched", () => {
    expect(homeSqFtIsUnverifiedPlatMedian({ homeSqFt: "3071", _homeSqFtEdited: false }, VACANT_WITH_MEDIAN)).toBe(true);
  });

  it("clears once the operator has typed a size, or when the record has its own value", () => {
    expect(homeSqFtIsUnverifiedPlatMedian({ homeSqFt: "3000", _homeSqFtEdited: true }, VACANT_WITH_MEDIAN)).toBe(false);
    expect(homeSqFtIsUnverifiedPlatMedian({ homeSqFt: "2980", _homeSqFtEdited: false }, { ...VACANT_WITH_MEDIAN, homeSqFt: 2980 })).toBe(false);
    expect(homeSqFtIsUnverifiedPlatMedian({ homeSqFt: "2980" }, { homeSqFt: 2980 })).toBe(false);
    expect(homeSqFtIsUnverifiedPlatMedian(null, VACANT_WITH_MEDIAN)).toBe(false);
  });
});
