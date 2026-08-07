import { afterEach, describe, expect, it } from "vitest";
import { applyServerLawnPricingConfig, calculateEstimate } from "./estimateEngine";

// Client mirror of the server's cadence-discount runtime guards (codex #3274
// r3, server coverage in server/tests/lawn-cadence-discount-arming.test.js):
//
// P1 — the -4%/-8% lookup caps ride lawn_pricing_v2.cadenceFreqDiscountArmed
// (absent = armed in-code default; migrate:down of 20260807120000 writes
// false), delivered here via applyServerLawnPricingConfig on mount. A
// rollback must stop the fallback engine re-clamping restored bracket
// values, while the 2026-07-29 12x-never-above-9x bound stays unconditional.
//
// P2 — under a live useLawnCostFloor re-arm each cadence floors
// independently; the engine resolves the three together by lifting the
// lower-frequency legs so the promised per-application ladder cannot invert.

function lawnInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: "1",
    lotSqFt: 30000,
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
    ...overrides,
  };
}

function lawnByVisits(est) {
  const by = {};
  est.results.lawn.forEach((t) => { by[t.v] = t; });
  return by;
}

afterEach(() => {
  applyServerLawnPricingConfig(null);
});

describe("cadence discount arm switch — client fallback mirror", () => {
  // 8,125 sqft: independent per-column interpolation rounding makes the
  // runtime caps BIND on the baked grid (same fixture as the server suite).
  it("an explicit false from the row (migrate:down) releases the caps; the 6x anchor never moves", () => {
    const armed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 8125 })));
    applyServerLawnPricingConfig({ cadenceFreqDiscountArmed: false });
    const disarmed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 8125 })));

    expect(disarmed[6].pa).toBe(armed[6].pa);
    expect(disarmed[9].pa).toBeGreaterThan(armed[9].pa);
    expect(disarmed[12].pa).toBeGreaterThan(armed[12].pa);
    // Pre-discount 12x-never-above-9x bound survives the rollback.
    expect(disarmed[12].pa).toBeLessThanOrEqual(disarmed[9].pa + 0.01);
  });

  it("disarmed selects the pre-discount GRID at an exact changed bracket (rollback dollar parity)", () => {
    // 12,000 sqft st_augustine is a cell the migration lowered (9x 92→89,
    // 12x 122→114). Releasing the caps alone is not enough — the fallback
    // must also stop quoting the baked discounted cells, or a migrate:down
    // leaves it underquoting the restored server brackets (pre-push audit
    // P0 on #3274 r3). The 6x anchor is identical in both grids.
    const armed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    expect(armed[6].mo).toBe(62);
    expect(armed[9].mo).toBe(89);
    expect(armed[12].mo).toBe(114);

    applyServerLawnPricingConfig({ cadenceFreqDiscountArmed: false });
    const disarmed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    expect(disarmed[6].mo).toBe(62);
    expect(disarmed[9].mo).toBe(92);
    expect(disarmed[12].mo).toBe(122);
  });

  it("the discount ends at the table edge — >20k gets a per-app parity floor (owner ruling 2026-08-07)", () => {
    // Above the table 9x/12x per-app is floored at the extrapolated 6x
    // anchor per-app (no frequency discount; server mirror), and the
    // 12x≤9x bound still holds. Disarming removes the floor along with
    // the caps (pre-discount extrapolation).
    const armed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 25000 })));
    expect(armed[9].pa).toBeGreaterThanOrEqual(armed[6].pa - 0.01);
    expect(armed[12].pa).toBeGreaterThanOrEqual(armed[6].pa - 0.01);
    expect(armed[12].pa).toBeLessThanOrEqual(armed[9].pa + 0.01);

    applyServerLawnPricingConfig({ cadenceFreqDiscountArmed: false });
    const disarmed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 25000 })));
    // Disarmed switches to the pre-discount grid: the 6x anchor is
    // identical in both grids, the 12x≤9x bound holds, and the raw
    // pre-discount 9x extrapolation sits at-or-above the anchor per-app
    // on its own (which is why the parity floor is the armed equivalent).
    expect(disarmed[6].pa).toBe(armed[6].pa);
    expect(disarmed[12].pa).toBeLessThanOrEqual(disarmed[9].pa + 0.01);
    expect(disarmed[9].pa).toBeGreaterThanOrEqual(disarmed[6].pa - 0.01);
  });

  it("absent/invalid config keeps the armed default (kill-value pattern)", () => {
    applyServerLawnPricingConfig({});
    const by = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12500 })));
    expect(by[9].pa).toBeLessThanOrEqual(by[6].pa * 0.96 + 0.01);
    expect(by[12].pa).toBeLessThanOrEqual(by[6].pa * 0.92 + 0.01);
  });
});

describe("cadence ladder under ARMED cost floors — client fallback mirror", () => {
  it("floored cadences keep the promised ladder via the lift", () => {
    applyServerLawnPricingConfig({ useLawnCostFloor: true });
    const by = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    expect(by[9].pa).toBeLessThanOrEqual(by[6].pa * 0.96 + 0.02);
    expect(by[12].pa).toBeLessThanOrEqual(by[6].pa * 0.92 + 0.02);
    expect(by[12].pa).toBeLessThanOrEqual(by[9].pa + 0.01);
    // The lift only raises: every leg still clears its own floor.
    [6, 9, 12].forEach((v) => {
      expect(by[v].ann).toBeGreaterThanOrEqual(Math.floor(by[v].costFloorAnnual));
    });
  });

  it("a rolled-back discount skips the lift (pre-discount floor behavior)", () => {
    applyServerLawnPricingConfig({ useLawnCostFloor: true, cadenceFreqDiscountArmed: false });
    const by = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    [6, 9, 12].forEach((v) => {
      expect(by[v].cadenceLadderLiftApplied).toBeUndefined();
    });
  });

  it("lifted legs carry lift provenance, not a market label (codex r4 P2)", () => {
    applyServerLawnPricingConfig({ useLawnCostFloor: true });
    const by = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    const lifted = [6, 9, 12].map((v) => by[v]).find((t) => t.cadenceLadderLiftApplied);
    expect(lifted).toBeTruthy();
    expect(lifted.ann).toBeGreaterThan(lifted.marketAnnual);
    expect(lifted.pricingSource).toBe("CADENCE_LADDER_LIFT");
  });
});

describe("one-time lawn anchors on the undiscounted 6x column — client mirror (codex r4 P1)", () => {
  function otLawnInput(overrides = {}) {
    return lawnInput({
      svcLawn: false,
      svcOnetimeLawn: true,
      otLawnType: "WEED",
      measuredTurfSf: 20000,
      ...overrides,
    });
  }
  const otLawnItem = (est) => est.oneTime.items.find((i) => i.name.startsWith("OT Lawn"));

  it("the requested plan cadence no longer changes the one-time price", () => {
    // 20,000 sqft: the 9x column fell under the discount; the 6x anchor
    // never moved. The one-time base must be cadence-independent.
    const at6 = otLawnItem(calculateEstimate(otLawnInput({ lawnFreq: "6" })));
    const at9 = otLawnItem(calculateEstimate(otLawnInput({ lawnFreq: "9" })));
    const at12 = otLawnItem(calculateEstimate(otLawnInput({ lawnFreq: "12" })));
    expect(at6).toBeTruthy();
    expect(at9.price).toBe(at6.price);
    expect(at12.price).toBe(at6.price);
  });
});
