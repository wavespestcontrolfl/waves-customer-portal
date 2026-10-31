import { describe, expect, it } from "vitest";
import { calculateEstimate } from "./estimateEngine";

// Top Dressing is quote-only (owner 2026-10-29): the formula is a floor that
// loses money on larger lawns, so the office prices every job by hand. The
// client engine mirrors the server line: no sendable price, the existing
// custom-quote markers, and the formula only as baseEstimatePrice.
function input(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: "1",
    lotSqFt: 16000,
    measuredTurfSf: 8000,
    propertyType: "Single Family",
    shrubDensity: "MODERATE",
    treeDensity: "MODERATE",
    landscapeComplexity: "MODERATE",
    grassType: "st_augustine",
    svcTopdress: true,
    svcLawn: false,
    isRecurringCustomer: false,
    isAfterHours: false,
    ...overrides,
  };
}

const topDressingRow = (result) =>
  result.oneTime.items.find((item) => item.name === "Lawn Top Dressing Service");

describe("client estimate engine: top dressing is quote-only", () => {
  it("emits a quote-required row with no price and the custom-quote markers", () => {
    const result = calculateEstimate(input());
    expect(result.error).toBeUndefined();
    const row = topDressingRow(result);
    expect(row).toMatchObject({
      price: null,
      quoteRequired: true,
      requiresCustomQuote: true,
      requiresManualReview: true,
      customQuoteReason: "top_dressing_quote_only",
      manualReviewReasons: ["top_dressing_quote_only"],
    });
    expect(row.baseEstimatePrice).toBeGreaterThan(0);
    expect(result.oneTime.otSubtotal).toBe(0);
  });

  it("leaves no tier as a sendable price", () => {
    const result = calculateEstimate(input());
    expect(result.results.td).toBeUndefined();
    expect(result.results.tdTiers).toHaveLength(2);
    for (const tier of result.results.tdTiers) {
      expect(tier.price).toBeNull();
      expect(tier.quoteRequired).toBe(true);
      expect(tier.baseEstimatePrice).toBeGreaterThan(0);
    }
  });

  it("stays quote-only with an explicit top-dress area", () => {
    const result = calculateEstimate(input({ topDressArea: 2500 }));
    const row = topDressingRow(result);
    expect(row.price).toBeNull();
    expect(row.requiresCustomQuote).toBe(true);
    expect(row.customQuoteReason).toBe("top_dressing_quote_only");
  });

  it("stays quote-only when bundled with a recurring lawn", () => {
    const result = calculateEstimate(input({ svcLawn: true, lawnFreq: "9" }));
    const row = topDressingRow(result);
    expect(row.price).toBeNull();
    expect(row.requiresCustomQuote).toBe(true);
  });

  it("keeps the turf reason first when the turf basis is low confidence", () => {
    // No measured turf: the area falls back to the lot, a LOW-confidence basis.
    const result = calculateEstimate(input({ measuredTurfSf: undefined }));
    const row = topDressingRow(result);
    expect(row.requiresCustomQuote).toBe(true);
    expect(row.customQuoteReason).toBe("low_confidence_turf_requires_field_verification");
    expect(row.manualReviewReasons).toEqual([
      "low_confidence_turf_requires_field_verification",
      "top_dressing_quote_only",
    ]);
  });

  it("an explicit area drops only the turf reason on a low-confidence basis", () => {
    const result = calculateEstimate(input({ measuredTurfSf: undefined, topDressArea: 2500 }));
    const row = topDressingRow(result);
    expect(row.customQuoteReason).toBe("top_dressing_quote_only");
    expect(row.manualReviewReasons).toEqual(["top_dressing_quote_only"]);
  });
});
