import { afterEach, describe, expect, it } from "vitest";
import { applyServerPalmPricingConfig, calculateEstimate } from "./estimateEngine";

afterEach(() => applyServerPalmPricingConfig(null));

// Client mirror of the palm credit rule (owner 2026-11-26; server coverage in
// server/tests/pricing-seven-small-faults.test.js): the $75 per-visit minimum holds after the $10 per palm credit.
function palmInput(palms, overrides = {}) {
  return {
    homeSqFt: 2200,
    stories: "1",
    lotSqFt: 9000,
    propertyType: "Single Family",
    shrubDensity: "MODERATE",
    treeDensity: "MODERATE",
    landscapeComplexity: "MODERATE",
    svcInjection: true,
    palmTreatmentCount: palms,
    existingQualifyingServices: ["pest_control", "lawn_care", "mosquito"],
    ...overrides,
  };
}

describe("palm credit never pushes the line below the per-visit minimum — client mirror", () => {
  it("1 and 2 palms on Gold stay at the minimum, never cheaper with more palms", () => {
    const one = calculateEstimate(palmInput(1)).results.injection;
    const two = calculateEstimate(palmInput(2)).results.injection;
    expect(one.annualAfterCredits).toBe(150);
    expect(two.annualAfterCredits).toBeGreaterThanOrEqual(one.annualAfterCredits);
  });

  it("3 palms above the minimum keep the full credit", () => {
    const three = calculateEstimate(palmInput(3)).results.injection;
    expect(three.flatCreditAnnual).toBe(30);
  });

  it("reads the configured per-visit minimum: a $60 minimum lets one $75 palm earn its full credit", () => {
    applyServerPalmPricingConfig({ min_per_visit: 60 });
    const one = calculateEstimate(palmInput(1)).results.injection;
    expect(one.annualBeforeCredits).toBe(150);
    expect(one.flatCreditAnnual).toBe(10);
  });
});
