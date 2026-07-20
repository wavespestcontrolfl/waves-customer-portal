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
  it("a fractional configured floor rounds to whole dollars, mirroring the db-bridge r() rule (codex P1)", () => {
    // The server bridge stores r(89.50) = 90 into PEST.floor. A cents-keeping
    // client would price the bound tier at 89.50 — below the server floor —
    // and the save gate would 409 every freshly generated fallback save.
    applyServerPestPricingConfig({ enforce_floor_post_discount: true, floor: 89.5 });
    const est = calculateEstimate(lawnInput({
      svcPest: true,
      homeSqFt: 1000,
      shrubDensity: "LIGHT",
      landscapeComplexity: "SIMPLE",
    }));
    expect(est.error).toBeUndefined();
    const tier = est.results.pestTiers.find((t) => t.apps === 4);
    expect(tier.floorPa).toBeCloseTo(90, 2);
    expect(est.result?.pricingMetadata?.pestProgramFloorPerVisit ?? est.pricingMetadata?.pestProgramFloorPerVisit).toBe(90);
  });


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

  it("re-armed at a configured floor: stamps pest_base.floor, not a hardcoded $89 (pre-push codex P0 round 9)", () => {
    // The DB row can re-arm at any floor (e.g. $79) — the fallback must
    // stamp/give back the SAME value the server's pestProgramFloorPerVisit
    // reads (PEST.floor), or preview and view/accept disagree.
    expect(applyServerPestPricingConfig({ enforce_floor_post_discount: true, floor: 79 })).toBe(true);
    const est = calculateEstimate(lawnInput({
      svcPest: true,
      homeSqFt: 1000,
      shrubDensity: "LIGHT",
      landscapeComplexity: "SIMPLE",
    }));
    expect(est.error).toBeUndefined();
    const tier = est.results.pestTiers.find((t) => t.apps === 4);
    expect(tier.floorPa).toBeCloseTo(79, 2);
    expect(tier.floorAnn).toBeCloseTo(316, 2);
    // Silver 10% on a $95 visit ($85.50) stays ABOVE a $79 floor — no
    // give-back at this configured value, unlike the $89 case above.
    expect(est.recurring.pestProgramFloorApplied).toBe(false);
  });

  it("the list-price bottom follows the configured pest_base.floor (codex P2 round 10 #2827)", () => {
    // Server basePrice = Math.max(PEST.floor, base + adj) with PEST.floor
    // db-synced — the fallback bottom must move with it, floor armed or
    // not. 800 sf townhome bottoms at $89 by default; a $95 floor lifts it.
    const townhome = {
      homeSqFt: 800,
      stories: 1,
      lotSqFt: 10000,
      propertyType: "townhome_end",
      shrubDensity: "LIGHT",
      treeDensity: "LIGHT",
      landscapeComplexity: "SIMPLE",
      svcPest: true,
      isAfterHours: false,
      isRecurringCustomer: false,
    };
    const defaultBottom = calculateEstimate(townhome);
    expect(defaultBottom.results.pestTiers.find((t) => t.apps === 4).pa).toBeCloseTo(89, 2);

    applyServerPestPricingConfig({ floor: 95 });
    const lifted = calculateEstimate(townhome);
    expect(lifted.results.pestTiers.find((t) => t.apps === 4).pa).toBeCloseTo(95, 2);
    // One-time pest anchors on the same quarterly base — it moves too.
    const ot = lifted.oneTime?.items?.find?.((i) => i.service === "one_time_pest")
      ?? (lifted.results.oneTime || []).find?.((i) => i.service === "one_time_pest");
    if (ot) expect(Number(ot.price ?? ot.amount)).toBeGreaterThanOrEqual(Math.round(95 * 2.2));
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

  it("surfaces the manual-discount lawn warning on a lawn-only fallback quote (codex P2 round 9 #2827)", () => {
    // No WaveGuard (single service) — a 40% owner-entered manual discount
    // on the thin 12,000 sqft standard cell drops collected margin far
    // below 35%. Nothing caps it; the warn-only entry mirrors the server's
    // manual_discount_below_margin_floor and renders a review note.
    const est = calculateEstimate(lawnInput({
      measuredTurfSf: 12000,
      lawnFreq: "6",
      manualDiscount: { type: "PERCENT", value: 40 },
    }));
    expect(est.error).toBeUndefined();
    const warning = (est.recurring.marginWarnings || []).find(
      (w) => w.service === "lawn_care" && w.type === "manual_discount_below_margin_floor",
    );
    expect(warning).toBeTruthy();
    expect(warning.margin).toBeLessThan(0.35);
    const notes = collectMarginReviewNotes(est);
    expect(notes.some((n) => n.includes("Lawn Care") && n.includes("manual discount"))).toBe(true);
  });

  it("re-armed: a market-priced lawn row still cannot DISCOUNT below its cost floor (codex P2 round 9 #2827)", () => {
    // 3,000 sqft 9x: market $564 sits ABOVE the $531.09 floor, so selection
    // is untouched — but Silver 10% would land at $507.60. The armed
    // post-discount guard gives back the overshoot and holds the lawn slice
    // at its floor, matching the server caps and the public-ladder
    // re-clamp (save == accept). At-floor = no breach warning.
    applyServerLawnPricingConfig({ useLawnCostFloor: true });
    const est = calculateEstimate(lawnInput({ svcPest: true, measuredTurfSf: 3000 }));
    expect(est.error).toBeUndefined();
    const nine = est.results.lawn.find((t) => t.v === 9);
    expect(nine.costFloorApplied).toBe(false);
    expect(nine.ann).toBeGreaterThan(nine.costFloorAnnual);
    const pestAfter = Math.round(est.results.pest.ann * 0.9 * 100) / 100;
    expect(est.recurring.annualAfterDiscount - pestAfter).toBeCloseTo(nine.costFloorAnnual, 1);
    const warning = (est.recurring.marginWarnings || []).find(
      (w) => w.type === "waveguard_discount_below_margin_floor",
    );
    expect(warning).toBeUndefined();
    // The resolved arm state rides the result for view/accept parity.
    expect(est.pricingMetadata.lawnCostFloorArmed).toBe(true);
  });

  it("stamps the disarmed arm state on every fallback result", () => {
    const est = calculateEstimate(lawnInput());
    expect(est.pricingMetadata.lawnCostFloorArmed).toBe(false);
    expect(est.pricingMetadata.lawnProgramMinimumMonthly).toBe(0);
  });

  it("stamps the re-armed program minimum so view/accept replays the save (pre-push codex P0 round 9)", () => {
    applyServerLawnPricingConfig({ programMinimumMonthly: 50 });
    const est = calculateEstimate(lawnInput());
    expect(est.error).toBeUndefined();
    expect(est.pricingMetadata.lawnProgramMinimumMonthly).toBe(50);
  });
});

describe("collectMarginReviewNotes — standing lawn margin (no discount) — codex P2 round 12 #2827", () => {
  it("surfaces a thin market-priced lawn line with no discounts at all", () => {
    // 12,000 sqft standard/6x St. Augustine is a thin-margin cell at its
    // MARKET price — no WaveGuard (single service), no manual discount, so
    // the discount warnings stay silent, but the owner still needs the
    // report-only note before sending.
    const est = calculateEstimate(lawnInput({ measuredTurfSf: 12000, lawnFreq: "6" }));
    expect(est.error).toBeUndefined();
    const notes = collectMarginReviewNotes(est);
    expect(notes.some((n) => n.startsWith("Lawn Care") && n.includes("35%"))).toBe(true);
  });

  it("does not double-note lawn when a discount warning already covers it", () => {
    const est = calculateEstimate(lawnInput({
      measuredTurfSf: 12000,
      lawnFreq: "6",
      manualDiscount: { type: "PERCENT", value: 40 },
    }));
    const notes = collectMarginReviewNotes(est);
    expect(notes.filter((n) => n.startsWith("Lawn Care")).length).toBe(1);
  });

  it("normalizes a raw-service-key WaveGuard lawn warning so the dedupe catches it (codex P3 round 13 #2827)", () => {
    // Server-engine warnings carry messages starting "lawn_care …" — the
    // typed branch must normalize them to the Lawn Care label so a thin
    // WaveGuard-discounted lawn line yields exactly ONE review note.
    const notes = collectMarginReviewNotes({
      recurring: {
        marginWarnings: [{
          service: "lawn_care",
          type: "waveguard_discount_below_margin_floor",
          margin: 0.31,
          marginFloor: 0.35,
          finalAnnual: 546,
          message: "lawn_care: WaveGuard discount drops collected margin to 31.0% (below the 35% review floor) — price stands as discounted.",
        }],
      },
      results: {
        lawn: [{ recommended: true, ann: 546, costs: { total: 380 } }],
      },
    });
    const lawnNotes = notes.filter((n) => n.startsWith("Lawn Care"));
    expect(lawnNotes.length).toBe(1);
    expect(lawnNotes[0]).toContain("WaveGuard");
    expect(lawnNotes[0]).toContain("35%");
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
