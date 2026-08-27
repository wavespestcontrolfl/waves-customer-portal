/**
 * Client fallback-engine mirror of the Standard-only rodent trapping plan
 * (owner 2026-08-26): a flat price with unlimited callbacks.
 *
 * The price comes from pricing_config.rodent_trapping.standard_price via
 * applyServerRodentTrappingPricingConfig — never a baked literal — for the
 * same reason the termite appliers exist: db-bridge overlays that row onto
 * the server pricer, so an admin edit must not silently diverge the fallback
 * quote from what the server will save (codex #3521 uncapped P1).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  applyServerRodentTrappingPricingConfig,
  calculateEstimate,
} from "./estimateEngine";

function trappingInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: "1",
    lotSqFt: 10000,
    propertyType: "Single Family",
    shrubDensity: "MODERATE",
    treeDensity: "MODERATE",
    landscapeComplexity: "MODERATE",
    svcRodentTrap: true,
    ...overrides,
  };
}

const trappingRow = (E) => (E.oneTime?.items || []).find((i) => i.name === "Trapping");

// Every test must leave the module-level price at its default.
afterEach(() => applyServerRodentTrappingPricingConfig(null));

describe("rodent trapping — client fallback engine", () => {
  it("prices the Standard plan at the in-code default when no config is applied", () => {
    const row = trappingRow(calculateEstimate(trappingInput()));
    expect(row).toBeTruthy();
    expect(row.price).toBe(350);
    expect(row.detail).toMatch(/same active trapping job/);
  });

  it("previews the DB-authoritative standard_price once applied", () => {
    expect(applyServerRodentTrappingPricingConfig({ standard_price: 375 })).toBe(375);
    expect(trappingRow(calculateEstimate(trappingInput())).price).toBe(375);
  });

  it("an absent or invalid config resets the default (kill-value pattern)", () => {
    applyServerRodentTrappingPricingConfig({ standard_price: 399 });
    for (const bad of [null, undefined, {}, { standard_price: 0 }, { standard_price: "nope" }, { standard_price: -5 }]) {
      expect(applyServerRodentTrappingPricingConfig(bad)).toBe(350);
    }
    expect(trappingRow(calculateEstimate(trappingInput())).price).toBe(350);
  });
});
