/**
 * Client fallback-engine mirror of the termite station rental option
 * (owner 2026-07-26).
 *
 * The fallback engine is what the admin estimator previews from when the
 * server pricer is unreachable, so it has to reach the SAME doorstep as
 * server priceTermiteBait + priceTermiteStationRental: renting zeroes the
 * one-time install and adds a whole-dollar per-application recovery line
 * that is neither tier-counted nor bundle-discountable.
 *
 * The horizon comes from pricing_config.termite_rental via
 * applyServerTermiteRentalPricingConfig — never a baked literal — for the
 * same reason the bond rates do: an admin edit must not silently diverge the
 * fallback quote from the saved one.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  applyServerTermiteRentalPricingConfig,
  calculateEstimate,
} from "./estimateEngine";

function termiteInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: "1",
    lotSqFt: 10000,
    propertyType: "Single Family",
    shrubDensity: "MODERATE",
    treeDensity: "MODERATE",
    landscapeComplexity: "MODERATE",
    svcTermiteBait: true,
    termiteBaitSystem: "advance",
    termiteMonitoringTier: "basic",
    termiteBondTerm: "none",
    ...overrides,
  };
}

const rentalRow = (E) =>
  (E.recurring?.services || []).find((s) => s.service === "termite_station_rental");

// Every test must leave the module-level horizon at its default.
afterEach(() => applyServerTermiteRentalPricingConfig(null));

describe("termite station rental — client fallback engine", () => {
  it("purchase (default) bills the install and adds no rental line", () => {
    const E = calculateEstimate(termiteInput());
    expect(E.results.tmBait.ownership).toBe("own");
    expect(E.results.tmBait.stationsOwnedBy).toBe("customer");
    expect(E.results.tmBait.rented).toBeUndefined();
    expect(rentalRow(E)).toBeUndefined();
    expect(E.oneTime.total).toBeGreaterThan(0);
  });

  it("rental zeroes the install and recovers it per application", () => {
    const own = calculateEstimate(termiteInput());
    const rent = calculateEstimate(termiteInput({ termiteOwnership: "rent" }));

    expect(rent.results.tmBait.ownership).toBe("rent");
    expect(rent.results.tmBait.stationsOwnedBy).toBe("waves");
    expect(rent.results.tmBait.rented).toBe(true);

    // The install charge is gone...
    expect(rent.oneTime.total).toBeLessThan(own.oneTime.total);
    // ...and shows up as a recurring recovery line instead.
    const row = rentalRow(rent);
    expect(row).toMatchObject({
      name: "Termite Station Rental",
      visitsPerYear: 4,
      discountable: false,
      waveGuardDiscountEligible: false,
      countsTowardWaveGuardTier: false,
    });
    // Whole-dollar uplift = install price / horizon (20 quarters default).
    expect(row.perTreatment).toBe(Math.round(own.results.tmBait.ai / 20));
    expect(row.annual).toBe(row.perTreatment * 4);
    expect(row.retailValue).toBe(own.results.tmBait.ai);
  });

  it("amortizes the Trelona price when Trelona is the selected system", () => {
    const own = calculateEstimate(termiteInput({ termiteBaitSystem: "trelona" }));
    const rent = calculateEstimate(
      termiteInput({ termiteBaitSystem: "trelona", termiteOwnership: "rent" }),
    );
    // ti, not ai — renting the premium system recovers the premium price.
    expect(rentalRow(rent).perTreatment).toBe(Math.round(own.results.tmBait.ti / 20));
    expect(own.results.tmBait.ti).toBeGreaterThan(own.results.tmBait.ai);
  });

  it("honors a server-supplied horizon and resets to the default when absent", () => {
    const own = calculateEstimate(termiteInput());

    applyServerTermiteRentalPricingConfig({ recovery_quarters: 10 });
    expect(rentalRow(calculateEstimate(termiteInput({ termiteOwnership: "rent" }))).perTreatment)
      .toBe(Math.round(own.results.tmBait.ai / 10));

    // Kill-value pattern: invalid or absent restores the in-code default.
    for (const bad of [null, undefined, {}, { recovery_quarters: 0 }, { recovery_quarters: -4 }]) {
      applyServerTermiteRentalPricingConfig(bad);
      expect(rentalRow(calculateEstimate(termiteInput({ termiteOwnership: "rent" }))).perTreatment)
        .toBe(Math.round(own.results.tmBait.ai / 20));
    }
  });

  it("only the exact 'rent' token opts in", () => {
    for (const v of ["own", "lease", "", null, undefined, "rental"]) {
      const E = calculateEstimate(termiteInput({ termiteOwnership: v }));
      expect(E.results.tmBait.ownership).toBe("own");
      expect(rentalRow(E)).toBeUndefined();
    }
    expect(calculateEstimate(termiteInput({ termiteOwnership: "RENT" })).results.tmBait.ownership)
      .toBe("rent");
  });
});
