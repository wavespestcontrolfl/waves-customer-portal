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

// The 6x/standard column is retired for new sales (owner directive
// 2026-09-24) and no longer on the client ladder, so the -4%/-8% relations
// are checked against its per-app ANCHOR pinned from the server engine
// (priceLawnCare(..., { tier: 'standard', includeHiddenTiers: true })
// .perApp, st_augustine; identical to the pre-retirement client 6x row). The
// anchor itself stays covered server-side in
// server/tests/lawn-cadence-discount-arming.test.js.
const SIX_X_ANCHOR_PER_APP = { 12500: 128, 25000: 218 };

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
  it("an explicit false from the row (migrate:down) releases the caps on the sold 9x/12x legs", () => {
    const armed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 8125 })));
    applyServerLawnPricingConfig({ cadenceFreqDiscountArmed: false });
    const disarmed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 8125 })));

    // Only the sold cadences are on the ladder (6x retired 2026-09-24).
    expect(Object.keys(armed).map(Number)).toEqual([9, 12]);
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
    // P0 on #3274 r3). (The retired 6x anchor is identical in both grids.)
    const armed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    expect(armed[9].mo).toBe(89);
    expect(armed[12].mo).toBe(114);

    applyServerLawnPricingConfig({ cadenceFreqDiscountArmed: false });
    const disarmed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    expect(disarmed[9].mo).toBe(92);
    expect(disarmed[12].mo).toBe(122);
  });

  it("the discount ends at the table edge — >20k gets a per-app parity floor (owner ruling 2026-08-07)", () => {
    // Above the table 9x/12x per-app is floored at the extrapolated 6x
    // anchor per-app (no frequency discount; server mirror), and the
    // 12x≤9x bound still holds. Disarming removes the floor along with
    // the caps (pre-discount extrapolation).
    const anchor = SIX_X_ANCHOR_PER_APP[25000];
    const armed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 25000 })));
    expect(armed[9].pa).toBeGreaterThanOrEqual(anchor - 0.01);
    expect(armed[12].pa).toBeGreaterThanOrEqual(anchor - 0.01);
    expect(armed[12].pa).toBeLessThanOrEqual(armed[9].pa + 0.01);

    applyServerLawnPricingConfig({ cadenceFreqDiscountArmed: false });
    const disarmed = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 25000 })));
    // Disarmed switches to the pre-discount grid: the 12x≤9x bound holds,
    // and the raw pre-discount 9x extrapolation sits at-or-above the
    // (grid-identical) 6x anchor per-app on its own (which is why the parity
    // floor is the armed equivalent).
    expect(disarmed[12].pa).toBeLessThanOrEqual(disarmed[9].pa + 0.01);
    expect(disarmed[9].pa).toBeGreaterThanOrEqual(anchor - 0.01);
  });

  it("rolled-back edge parity restores FREQ_DISCOUNT semantics >20k — client mirror (audit P1)", () => {
    const parity = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 25000 })));
    applyServerLawnPricingConfig({ edgeParityFloorArmed: false });
    const rolledBack = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 25000 })));
    const anchor = SIX_X_ANCHOR_PER_APP[25000];
    expect(rolledBack[9].pa).toBeLessThan(parity[9].pa);
    expect(rolledBack[9].pa).toBeLessThanOrEqual(anchor * 0.96 + 0.01);
    expect(rolledBack[12].pa).toBeLessThanOrEqual(anchor * 0.92 + 0.01);
  });

  it("absent/invalid config keeps the armed default (kill-value pattern)", () => {
    applyServerLawnPricingConfig({});
    const anchor = SIX_X_ANCHOR_PER_APP[12500];
    const by = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12500 })));
    expect(by[9].pa).toBeLessThanOrEqual(anchor * 0.96 + 0.01);
    expect(by[12].pa).toBeLessThanOrEqual(anchor * 0.92 + 0.01);
  });
});

describe("cadence ladder under ARMED cost floors — client fallback mirror", () => {
  it("floored sold cadences keep the promised 12x-never-above-9x ladder", () => {
    applyServerLawnPricingConfig({ useLawnCostFloor: true });
    const by = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    expect(Object.keys(by).map(Number)).toEqual([9, 12]);
    expect(by[12].pa).toBeLessThanOrEqual(by[9].pa + 0.01);
    // Every sold leg still clears its own floor.
    [9, 12].forEach((v) => {
      expect(by[v].ann).toBeGreaterThanOrEqual(Math.floor(by[v].costFloorAnnual));
    });
  });

  it("a rolled-back discount skips the lift (pre-discount floor behavior)", () => {
    applyServerLawnPricingConfig({ useLawnCostFloor: true, cadenceFreqDiscountArmed: false });
    const by = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    [9, 12].forEach((v) => {
      expect(by[v].cadenceLadderLiftApplied).toBeUndefined();
    });
  });

  it("floored sold legs carry their own floor provenance — the lifted leg was the retired 6x (server mirror)", () => {
    // Under an armed floor only the 6x leg was ever lifted on the live grid;
    // with 6x retired (2026-09-24) the sold 9x/12x legs price at their own
    // floors, exactly as the server's customer-facing tiers do.
    applyServerLawnPricingConfig({ useLawnCostFloor: true });
    const by = lawnByVisits(calculateEstimate(lawnInput({ measuredTurfSf: 12000 })));
    [9, 12].forEach((v) => {
      expect(by[v].cadenceLadderLiftApplied).toBeUndefined();
      expect(by[v].pricingSource).toBe("COST_FLOOR");
    });
  });
});

describe("retired lawn cadences resolve to the 9x default in the fallback engine", () => {
  // 4x retired 2026-07-09; 6x retired for new sales 2026-09-24 (server
  // mirror: resolveLawnTier / LAWN_TIERS.standard.hidden). A stale form
  // value lands on 9x and the ladder offers only the sold cadences.
  it.each(["4", "6"])("lawnFreq %s selects 9x", (lawnFreq) => {
    const est = calculateEstimate(lawnInput({ measuredTurfSf: 5000, lawnFreq }));
    expect(est.results.lawn.map((t) => t.v)).toEqual([9, 12]);
    const selected = est.results.lawn.filter((t) => t.recommended);
    expect(selected.map((t) => t.v)).toEqual([9]);
    const at9 = calculateEstimate(lawnInput({ measuredTurfSf: 5000, lawnFreq: "9" }));
    expect(est.results.lawn).toEqual(at9.results.lawn);
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
