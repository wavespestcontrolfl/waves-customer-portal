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

  it("the rental rides the recurring totals at its EXACT annual (codex P2 round 4)", () => {
    const own = calculateEstimate(termiteInput());
    const rent = calculateEstimate(termiteInput({ termiteOwnership: "rent" }));
    const row = rentalRow(rent);

    // The rider is IN the totals (it used to be omitted entirely)...
    expect(rent.recurring.annualAfterDiscount).toBe(
      Math.round((own.recurring.annualAfterDiscount + row.annual) * 100) / 100,
    );
    // ...and the exact aggregate survives for persistence: annualTotal must
    // equal totals.year2 and must NOT be the rounded-monthly reconstruction
    // ($8.33/mo × 12 = $99.96 would decay a $100 rider).
    expect(rent.recurring.annualTotal).toBe(rent.totals.year2);
    expect(rent.recurring.annualTotal).toBe(
      Math.round((own.totals.year2 + row.annual) * 100) / 100,
    );
    expect(rent.recurring.annualTotal).not.toBe(
      Math.round(rent.recurring.monthlyTotal * 12 * 100) / 100,
    );
  });

  it("amortizes the Trelona price when Trelona is the selected system", () => {
    const own = calculateEstimate(termiteInput({ termiteBaitSystem: "trelona" }));
    const rent = calculateEstimate(
      termiteInput({ termiteBaitSystem: "trelona", termiteOwnership: "rent" }),
    );
    // ti, not ai — renting recovers the Trelona install.
    expect(rentalRow(rent).perTreatment).toBe(Math.round(own.results.tmBait.ti / 20));
    // Per-system spacing (owner 2026-07-28): Trelona installs FEWER stations
    // (label 15-ft vs Advance 10-ft), so despite the pricier per-station
    // hardware ($22.05 vs $13.16) its install can undercut Advance. Pin the
    // structure — each system priced off its OWN station count — instead of
    // the retired "Trelona always costs more" ordering.
    const perim = own.results.tmBait.perim;
    const staTre = Math.max(8, Math.ceil(perim / 15));
    const staAdv = Math.max(8, Math.ceil(perim / 10));
    expect(own.results.tmBait.sta).toBe(staTre);
    expect(own.results.tmBait.ti).toBe(Math.round(staTre * (22.05 + 5.25 + 0.75) * 1.45));
    expect(own.results.tmBait.ai).toBe(Math.round(staAdv * (13.16 + 5.25 + 0.75) * 1.45));
  });

  it("station-check monthly follows the 5-station brackets and the server config applier", async () => {
    const { applyServerTermiteMonitoringPricingConfig } = await import("./estimateEngine");
    // Bracket formula: $19 base (≤10 stations) + $5 per further 5-station
    // bracket — mirrors the server exactly. Station counts follow each
    // system's label spacing (Trelona 15 ft, Advance 10 ft).
    const bracketMonthly = (sta, base = 19, step = 5) =>
      Math.round((base + Math.max(0, Math.ceil(sta / 5) - 2) * step) * 100) / 100;
    const tre = calculateEstimate(termiteInput({ termiteBaitSystem: "trelona" }));
    const perim = tre.results.tmBait.perim;
    expect(tre.results.tmBait.sta).toBe(Math.max(8, Math.ceil(perim / 15)));
    expect(tre.results.tmBait.monMonthly).toBe(bracketMonthly(tre.results.tmBait.sta));
    const adv = calculateEstimate(termiteInput({ termiteBaitSystem: "advance" }));
    expect(adv.results.tmBait.sta).toBe(Math.max(8, Math.ceil(perim / 10)));
    expect(adv.results.tmBait.monMonthly).toBe(bracketMonthly(adv.results.tmBait.sta));
    // More stations, same-or-higher bracket price — never cheaper.
    expect(adv.results.tmBait.monMonthly).toBeGreaterThanOrEqual(tre.results.tmBait.monMonthly);
    // An ABSENT system resolves Trelona (menu is Trelona-only).
    expect(calculateEstimate(termiteInput({ termiteBaitSystem: undefined })).results.tmBait.sta)
      .toBe(tre.results.tmBait.sta);
    // The persisted service ROW bills the same bracket amounts the
    // aggregates use (codex pre-push P0: a flat 35/65 row beside a
    // bracketed monthlyTotal would display one total and bill another —
    // acceptance/conversion consume these rows).
    const treRow = (tre.recurring?.services || []).find((s) => s.service === "termite_bait");
    expect(treRow.name).toBe("Termite Bait");
    expect(treRow.mo).toBe(tre.results.tmBait.monMonthly);
    expect(treRow.perTreatment).toBe(Math.round(tre.results.tmBait.monMonthly * 3 * 100) / 100);
    // Server-tuned brackets apply and reset (kill-value pattern).
    applyServerTermiteMonitoringPricingConfig({ base_monthly: 25, step_monthly: 10, bracket_stations: 5 });
    expect(calculateEstimate(termiteInput({ termiteBaitSystem: "trelona" })).results.tmBait.monMonthly)
      .toBe(bracketMonthly(tre.results.tmBait.sta, 25, 10));
    applyServerTermiteMonitoringPricingConfig(null);
    expect(calculateEstimate(termiteInput({ termiteBaitSystem: "trelona" })).results.tmBait.monMonthly)
      .toBe(bracketMonthly(tre.results.tmBait.sta));
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
