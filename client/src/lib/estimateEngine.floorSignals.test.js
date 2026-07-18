import { afterEach, describe, expect, it } from "vitest";
import {
  applyServerLawnPricingConfig,
  applyServerPestPricingConfig,
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
  // The setters mutate module state — restore the DISARMED defaults.
  applyServerLawnPricingConfig(null);
  applyServerPestPricingConfig(null);
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

describe("applyServerPestPricingConfig — live pest floor re-arm in the fallback engine", () => {
  it("defaults disarmed: no floor metadata on pest tiers, WaveGuard applies in full", () => {
    const est = calculateEstimate(lawnInput({ svcPest: true }));
    expect(est.error).toBeUndefined();
    const tier = est.results.pestTiers.find((t) => t.apps === 4);
    expect(tier.floorAnn).toBeUndefined();
    expect(est.recurring.pestProgramFloorApplied).toBe(false);
  });

  it("re-armed: stamps floorPa/floorAnn/floorMo and gives back the WaveGuard overshoot (codex P2 round 8 #2827)", () => {
    // Small simple home prices pest near the $89 bottom ($95/visit here);
    // Silver (pest + lawn) 10% would cut it below the $89-per-visit floor
    // ($85.50), so the armed give-back holds the pest slice at the floor
    // exactly like the server's applyMarginGuard lift.
    expect(applyServerPestPricingConfig({ enforce_floor_post_discount: true })).toBe(true);
    const est = calculateEstimate(lawnInput({
      svcPest: true,
      homeSqFt: 1000,
      shrubDensity: "LIGHT",
      landscapeComplexity: "SIMPLE",
    }));
    expect(est.error).toBeUndefined();
    const tier = est.results.pestTiers.find((t) => t.apps === 4);
    expect(tier.floorPa).toBeCloseTo(89, 2);
    expect(tier.floorAnn).toBeCloseTo(356, 2);
    expect(est.results.pest.pa).toBeLessThan(98.9);
    expect(est.recurring.pestProgramFloorApplied).toBe(true);
  });
});

describe("fallback lawn margin visibility — report-only WaveGuard breach warning", () => {
  it("surfaces the below-margin lawn warning on a discounted fallback bundle and renders a review note", () => {
    // 12,000 sqft standard/6x St. Augustine is a thin-margin cell; the
    // Silver 10% (pest + lawn) drops collected margin under the 35% review
    // floor. Nothing is capped — the warning is the visibility the ruling
    // depends on (codex P2 round 8 #2827).
    const est = calculateEstimate(lawnInput({ svcPest: true, measuredTurfSf: 12000, lawnFreq: "6" }));
    expect(est.error).toBeUndefined();
    const warning = (est.recurring.marginWarnings || []).find(
      (w) => w.service === "lawn_care" && w.type === "waveguard_discount_below_margin_floor",
    );
    expect(warning).toBeTruthy();
    expect(warning.margin).toBeLessThan(0.35);
    const notes = collectMarginReviewNotes(est);
    expect(notes.some((n) => n.includes("Lawn Care") && n.includes("35%"))).toBe(true);
  });

  it("stays silent without a WaveGuard discount (single-service lawn quote)", () => {
    const est = calculateEstimate(lawnInput({ measuredTurfSf: 3000 }));
    const warning = (est.recurring?.marginWarnings || []).find(
      (w) => w.type === "waveguard_discount_below_margin_floor",
    );
    expect(warning).toBeUndefined();
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
