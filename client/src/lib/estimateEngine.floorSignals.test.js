import { afterEach, describe, expect, it } from "vitest";
import {
  applyServerLawnPricingConfig,
  calculateEstimate,
  collectMarginReviewNotes,
} from "./estimateEngine";

// Fallback-engine input (no enriched property): mirrors the shape
// EstimatePage submits when the server estimator path is unavailable.
function lawnInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: "1",
    lotSqFt: 10000,
    propertyType: "Single Family",
    hasPool: false,
    hasPoolCage: false,
    hasLargeDriveway: false,
    shrubDensity: "MODERATE",
    treeDensity: "MODERATE",
    landscapeComplexity: "MODERATE",
    nearWater: false,
    isAfterHours: false,
    isRecurringCustomer: false,
    svcLawn: true,
    lawnFreq: "9",
    grassType: "st_augustine",
    measuredTurfSf: 3000,
    ...overrides,
  };
}

afterEach(() => {
  // The setter mutates module state — restore the DISARMED default (0).
  applyServerLawnPricingConfig(null);
});

describe("applyServerLawnPricingConfig — live lawn program minimum in the fallback engine", () => {
  it("defaults to DISARMED: small-lawn tiers price off the market table, no minimum", () => {
    const est = calculateEstimate(lawnInput());
    expect(est.error).toBeUndefined();
    const sixApp = est.results.lawn.find((t) => t.v === 6);
    expect(sixApp.programMinimumApplied).toBe(false);
    expect(sixApp.mo).toBeLessThan(50);
  });

  it("honors a server-provided re-armed minimum (codex P1 #2827: live DB re-arm reaches fallback saves)", () => {
    expect(applyServerLawnPricingConfig({ programMinimumMonthly: 50 })).toBe(50);
    const est = calculateEstimate(lawnInput());
    expect(est.error).toBeUndefined();
    const sixApp = est.results.lawn.find((t) => t.v === 6);
    // Market ~$30/mo at 3,000 sf clamps up to the $50/mo program minimum —
    // the same clamp the server applies, so the public route will accept
    // the persisted rows instead of forcing a requote.
    expect(sixApp.programMinimumApplied).toBe(true);
    expect(sixApp.mo).toBeGreaterThanOrEqual(50);
    expect(sixApp.pricingSource).toBe("PROGRAM_MINIMUM");
  });

  it("treats unset/invalid config as the disarmed default", () => {
    expect(applyServerLawnPricingConfig(undefined)).toBe(0);
    expect(applyServerLawnPricingConfig({})).toBe(0);
    expect(applyServerLawnPricingConfig({ programMinimumMonthly: "not-a-number" })).toBe(0);
    expect(applyServerLawnPricingConfig({ programMinimumMonthly: -25 })).toBe(0);
    const est = calculateEstimate(lawnInput());
    const sixApp = est.results.lawn.find((t) => t.v === 6);
    expect(sixApp.programMinimumApplied).toBe(false);
  });

  it("honors a server-provided cost-floor re-arm: floor SELECTION follows the live switch (codex P2 #2827 merge-main)", () => {
    // Fixture where the 9x cost floor clears its market cell (4,500 sqft:
    // $591.25 floor vs $588 market on the server table this mirrors).
    const before = calculateEstimate(lawnInput({ measuredTurfSf: 4500 }));
    const beforeNine = before.results.lawn.find((t) => t.v === 9);
    expect(beforeNine.costFloorAnnual).toBeGreaterThan(beforeNine.marketAnnual);
    expect(beforeNine.costFloorApplied).toBe(false);

    applyServerLawnPricingConfig({ useLawnCostFloor: true });
    const est = calculateEstimate(lawnInput({ measuredTurfSf: 4500 }));
    const nine = est.results.lawn.find((t) => t.v === 9);
    expect(nine.costFloorApplied).toBe(true);
    expect(nine.pricingSource).toBe("COST_FLOOR");
    expect(nine.ann).toBeGreaterThanOrEqual(nine.marketAnnual);
  });

  it("cost-floor re-arm resets with the config like the program minimum", () => {
    applyServerLawnPricingConfig({ useLawnCostFloor: true });
    applyServerLawnPricingConfig(null);
    const est = calculateEstimate(lawnInput({ measuredTurfSf: 4500 }));
    const nine = est.results.lawn.find((t) => t.v === 9);
    expect(nine.costFloorApplied).toBe(false);
  });
});

describe("collectMarginReviewNotes — report-only low-margin signals for the estimator panel", () => {
  it("returns [] for empty/missing input and for estimates without signals", () => {
    expect(collectMarginReviewNotes(null)).toEqual([]);
    expect(collectMarginReviewNotes({})).toEqual([]);
    expect(
      collectMarginReviewNotes({
        marginWarnings: [],
        results: { pest: { belowMarginFloor: false, belowProgramFloor: false } },
      }),
    ).toEqual([]);
  });

  it("renders the per-line pest and tree & shrub signals with margin percent and floor reference", () => {
    const notes = collectMarginReviewNotes({
      results: {
        pest: {
          belowMarginFloor: true,
          belowProgramFloor: true,
          finalMargin: 0.283,
          floorAnn: 356,
        },
        tsMeta: { belowMarginFloor: true, finalMargin: 0.31 },
      },
    });
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("Pest Control");
    expect(notes[0]).toContain("28.3%");
    expect(notes[1]).toContain("Pest Control");
    expect(notes[1]).toContain("$356.00");
    expect(notes[2]).toContain("Tree & Shrub");
    expect(notes[2]).toContain("31.0%");
  });

  it("renders manual-discount margin warnings from the mapped payload", () => {
    const notes = collectMarginReviewNotes({
      marginWarnings: [
        {
          service: "pest_control",
          type: "manual_discount_below_margin_floor",
          margin: 0.312,
          marginFloor: 0.35,
          finalAnnual: 320.4,
        },
        {
          service: "pest_control",
          type: "manual_discount_below_pest_program_floor",
          programFloorAnnual: 356,
          finalAnnual: 320.4,
        },
      ],
    });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("31.2%");
    expect(notes[0]).toContain("35.0%");
    expect(notes[1]).toContain("$320.40");
    expect(notes[1]).toContain("$356.00");
  });

  it("reads client-fallback warnings from recurring.marginWarnings", () => {
    const notes = collectMarginReviewNotes({
      recurring: { marginWarnings: [{ message: "plain warning text" }] },
    });
    expect(notes).toEqual(["plain warning text"]);
  });
});
