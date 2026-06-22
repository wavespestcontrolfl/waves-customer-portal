import { describe, expect, it } from "vitest";
import { computeProvisionalState, provisionalSummary } from "./estimateProvisional";

describe("computeProvisionalState", () => {
  it("flags the reported 0/100 new-construction case as provisional", () => {
    const s = computeProvisionalState({
      level: "low",
      score: 0,
      verifiedCriticalFields: 0,
      totalCriticalFields: 4,
      missingCriticalFields: ["squareFootage", "lotSize", "stories", "propertyType"],
    });
    expect(s).toEqual({ provisional: true, verified: 0, total: 4, missing: 4 });
  });

  it("is provisional when a critical field is missing even if quality is not low", () => {
    const s = computeProvisionalState({
      level: "medium",
      verifiedCriticalFields: 3,
      totalCriticalFields: 4,
      missingCriticalFields: ["lotSize"],
    });
    expect(s.provisional).toBe(true);
    expect(s.missing).toBe(1);
  });

  it("is NOT provisional for solid data (high, nothing missing) — even if not all 4 are tech-verified", () => {
    const s = computeProvisionalState({
      level: "high",
      verifiedCriticalFields: 2,
      totalCriticalFields: 4,
      missingCriticalFields: [],
    });
    expect(s.provisional).toBe(false);
  });

  it("is NOT provisional at medium quality with no missing fields (avoids over-nagging)", () => {
    const s = computeProvisionalState({
      level: "medium",
      verifiedCriticalFields: 4,
      totalCriticalFields: 4,
      missingCriticalFields: [],
    });
    expect(s.provisional).toBe(false);
  });

  it("handles a missing/empty data-quality object without throwing", () => {
    expect(computeProvisionalState(null)).toEqual({ provisional: false, verified: 0, total: 4, missing: 0 });
    expect(computeProvisionalState(undefined).provisional).toBe(false);
    expect(computeProvisionalState({}).total).toBe(4); // defaults to 4 critical fields
  });
});

describe("provisionalSummary", () => {
  it("reads N/total with a missing note", () => {
    expect(provisionalSummary({ provisional: true, verified: 0, total: 4, missing: 4 }))
      .toBe("0/4 key property facts confirmed, 4 missing");
  });

  it("omits the missing note when nothing is missing", () => {
    expect(provisionalSummary({ provisional: true, verified: 3, total: 4, missing: 0 }))
      .toBe("3/4 key property facts confirmed");
  });

  it("returns empty string when not provisional", () => {
    expect(provisionalSummary({ provisional: false })).toBe("");
    expect(provisionalSummary(null)).toBe("");
  });
});
