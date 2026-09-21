import { describe, expect, it } from "vitest";
import { palmPrefillAllowed, subdivisionMedianPrefillSqFt, lookupHomeSqFtPrefill, homeSqFtIsUnverifiedPlatMedian } from "./lookupPrefill";

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
