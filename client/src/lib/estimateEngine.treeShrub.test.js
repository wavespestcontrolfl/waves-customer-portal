import { describe, expect, it } from "vitest";
import { calculateEstimate } from "./estimateEngine";

/**
 * T&S audit 2026-07-18 P2: the admin estimate builder prices from this v1
 * engine, and its lot-derived bed area had drifted from the server pricing
 * engine — a 12,000 sf cap (server: BED_AREA_CAP 8,000) and a complexity
 * bump on COMPLEX only (server: complex OR moderate). These pin the
 * server-parity semantics.
 */

function tsInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: "1",
    lotSqFt: 20000,
    propertyType: "Single Family",
    hasPool: false,
    hasPoolCage: false,
    hasLargeDriveway: false,
    shrubDensity: "MODERATE",
    treeDensity: "MODERATE",
    landscapeComplexity: "SIMPLE",
    nearWater: false,
    isAfterHours: false,
    isRecurringCustomer: false,
    svcTs: true,
    grassType: "st_augustine",
    roachModifier: "NONE",
    ...overrides,
  };
}

const tsAnnual = (input) => {
  const rows = calculateEstimate(input)?.results?.ts;
  expect(Array.isArray(rows) && rows.length).toBeTruthy();
  // Standard (6x) row — index 1 is the engine's recommended standard tier.
  return rows[1].ann;
};

describe("tree & shrub lot-derived bed area — server parity", () => {
  it("caps derived bed area at 8,000 sf (server BED_AREA_CAP), not the old 12,000", () => {
    // 80,000 sf lot, HEAVY shrubs → raw 0.25 * 80,000 = 20,000 sf, capped.
    const derived = tsAnnual(tsInput({ lotSqFt: 80000, shrubDensity: "HEAVY" }));
    const explicit8k = tsAnnual(tsInput({ lotSqFt: 80000, shrubDensity: "HEAVY", bedArea: 8000 }));
    const explicit12k = tsAnnual(tsInput({ lotSqFt: 80000, shrubDensity: "HEAVY", bedArea: 12000 }));
    expect(derived).toBe(explicit8k);
    expect(derived).not.toBe(explicit12k);
  });

  it("MODERATE landscape complexity adds bed density like the server (complex OR moderate)", () => {
    // 20,000 sf lot, MODERATE shrubs: 0.18 vs 0.23 → 3,600 vs 4,600 sf —
    // both under the cap, so the bump must show up in the price.
    const simple = tsAnnual(tsInput({ landscapeComplexity: "SIMPLE" }));
    const moderate = tsAnnual(tsInput({ landscapeComplexity: "MODERATE" }));
    const complex = tsAnnual(tsInput({ landscapeComplexity: "COMPLEX" }));
    expect(moderate).toBeGreaterThan(simple);
    expect(moderate).toBe(complex); // same +0.05 bump on both, matching BED_DENSITY.complexAdd
  });

  it("explicit bed area is authoritative — no cap, no complexity bump", () => {
    const a = tsAnnual(tsInput({ bedArea: 5000, landscapeComplexity: "SIMPLE" }));
    const b = tsAnnual(tsInput({ bedArea: 5000, landscapeComplexity: "MODERATE" }));
    expect(a).toBe(b);
  });
});
