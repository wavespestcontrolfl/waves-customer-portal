import { describe, expect, it } from "vitest";
import { calculateEstimate, oneTimeMosquitoLadderPrice } from "./estimateEngine";

// Client mirror of the 2026-08-08 mosquito +5% reprice and the cadence
// bound (owner directives; server truth in MOSQUITO.basePrices /
// ONE_TIME.mosquito + mosquito-cadence-guard.test.js). The client anchor
// tables are hand-synced static copies — these pins fail loudly if a
// future server reprice forgets this mirror.

function mosquitoInput(overrides = {}) {
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
    svcMosquito: true,
    ...overrides,
  };
}

function mosquitoTiers(est) {
  // R.mq rows carry no tier key — key by visits (9 = seasonal, 12 = monthly).
  const by = {};
  (est.results.mq || est.mq || []).forEach((t) => { by[t.v] = t; });
  return by;
}

describe("mosquito +5% reprice — client mirror pins", () => {
  it("small-lot per-visit prices carry the raised anchors (77/69 at low pressure)", () => {
    // 6,000 sqft lot, all pressure factors off → multiplier 1.0, so the
    // per-visit IS the interpolated anchor (below the 8,000 first anchor).
    const est = calculateEstimate(mosquitoInput({ lotSqFt: 6000, treeDensity: "LIGHT", shrubDensity: "LIGHT", landscapeComplexity: "SIMPLE" }));
    const by = mosquitoTiers(est);
    expect(by[9].pv).toBe(77);
    expect(by[12].pv).toBe(69);
  });

  it("monthly12 per-visit never lands above seasonal9 at any lot size (cadence bound)", () => {
    for (const lotSqFt of [5000, 10000, 16000, 24000, 40000, 70000]) {
      const by = mosquitoTiers(calculateEstimate(mosquitoInput({ lotSqFt })));
      expect(by[12].pv).toBeLessThanOrEqual(by[9].pv);
    }
  });

  it("one-time ladder carries the raised buckets and over-acre increment", () => {
    expect(oneTimeMosquitoLadderPrice(7000)).toBe(156);
    expect(oneTimeMosquitoLadderPrice(11000)).toBe(177);
    expect(oneTimeMosquitoLadderPrice(43560)).toBe(282);
    // 43560 + 21,440 over → 3 increments of $42 on the $282 base.
    expect(oneTimeMosquitoLadderPrice(65000)).toBe(282 + 3 * 42);
  });
});
