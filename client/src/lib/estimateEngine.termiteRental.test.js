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
    // hardware ($24.00 vs $13.16) its install can undercut Advance. Pin the
    // structure — each system priced off its OWN station count — instead of
    // the retired "Trelona always costs more" ordering.
    const perim = own.results.tmBait.perim;
    const staTre = Math.max(8, Math.ceil(perim / 15));
    const staAdv = Math.max(8, Math.ceil(perim / 10));
    expect(own.results.tmBait.sta).toBe(staTre);
    expect(own.results.tmBait.ti).toBe(Math.round(staTre * (24.00 + 5.25 + 0.75) * 1.45));
    expect(own.results.tmBait.ai).toBe(Math.round(staAdv * (13.16 + 5.25 + 0.75) * 1.45));
    // Quote-time stamp (plan §A1 replay rule): a CLIENT_FALLBACK save
    // carries the station cost it priced under, so the server reader never
    // mistakes a new $24 quote for a pre-A1 $22.05 one.
    expect(own.results.tmBait.pricingKnobs).toEqual({ system: 'trelona', stationCost: 24, stationCostSource: 'config', laborMaterial: 5.25, misc: 0.75, installMultiplier: 1.45, minStations: 8 });
    expect(own.results.tmBait.materialCostSource).toEqual({ station: 'config', cartridge: 'config' });
  });

  it("prices and stamps the server's EFFECTIVE (catalog-linked) station cost when the config applier has it", async () => {
    const { applyServerTermiteInstallPricingConfig } = await import("./estimateEngine");
    try {
      applyServerTermiteInstallPricingConfig(
        { multiplier: 1.45, trelona_bait: 24 },
        { trelona_station_cost: 22.5, trelona_station_cost_source: 'catalog', cartridge_cost_source: 'catalog', labor_material_per_station: 5.25, misc_per_station: 0.75, install_multiplier: 1.45 },
      );
      const own = calculateEstimate(termiteInput({ termiteBaitSystem: "trelona" }));
      const staTre = Math.max(8, Math.ceil(own.results.tmBait.perim / 15));
      expect(own.results.tmBait.ti).toBe(Math.round(staTre * (22.5 + 5.25 + 0.75) * 1.45));
      expect(own.results.tmBait.pricingKnobs).toEqual({ system: 'trelona', stationCost: 22.5, stationCostSource: 'catalog', laborMaterial: 5.25, misc: 0.75, installMultiplier: 1.45, minStations: 8 });
      expect(own.results.tmBait.materialCostSource).toEqual({ station: 'catalog', cartridge: 'catalog' });
      // Row-only (no effective block) reads the row; null resets the default.
      applyServerTermiteInstallPricingConfig({ multiplier: 1.45, trelona_bait: 23 }, null);
      expect(calculateEstimate(termiteInput({ termiteBaitSystem: "trelona" })).results.tmBait.pricingKnobs.stationCost).toBe(23);
    } finally {
      applyServerTermiteInstallPricingConfig(null, null);
    }
    expect(calculateEstimate(termiteInput({ termiteBaitSystem: "trelona" })).results.tmBait.pricingKnobs.stationCost).toBe(24);
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

describe("annual protection plan mirror (ruling A-1 = P1; server gate word via featureAvailable)", () => {
  it("prices setup + annual fee only when the server says the plan is available, and retires bond + rental on it", async () => {
    const { applyServerTermiteAnnualPlanPricingConfig } = await import("./estimateEngine");
    try {
      // Gate off (default): a plan request is ignored — today's program.
      const off = calculateEstimate(termiteInput({ termiteBaitSystem: "trelona", termitePlan: "annual_protection", termiteBondTerm: "5yr" }));
      expect(off.results.tmBait.plan).toBe("quarterly");
      expect(off.results.tmBait.setupFee).toBeUndefined();
      applyServerTermiteAnnualPlanPricingConfig({ setup_per_station: 30, annual_base: 249, annual_step: 50, bracket_stations: 5, bracket_floor: 10 }, true);
      const on = calculateEstimate(termiteInput({ termiteBaitSystem: "trelona", termitePlan: "annual_protection", termiteBondTerm: "5yr", termiteOwnership: "rent" }));
      const sta = on.results.tmBait.sta;
      const brackets = Math.max(0, Math.ceil((sta - 10) / 5));
      expect(on.results.tmBait).toMatchObject({ plan: "annual_protection", setupFee: sta * 30, annualFee: 249 + brackets * 50, visitsPerYear: 1, stationsOwnedBy: "waves" });
      expect(on.results.tmBait.pricingKnobs).toMatchObject({ plan: "annual_protection", setupPerStation: 30, annualBase: 249 });
      expect(on.results.tmBond).toBeUndefined();
      expect(on.results.tmBait.rented).toBeUndefined();
      expect(on.results.tmBait.bondOptions).toBeUndefined();
      const row = on.recurring.services.find((s) => s.service === "termite_bait");
      expect(row).toMatchObject({ perTreatment: 249 + brackets * 50, visitsPerYear: 1 });
      expect(on.oneTime.tmInstall).toBe(sta * 30);
      // Exact annual fee in the aggregates (never the rounded monthly × 12), and Trelona forced on the plan.
      expect(on.recurring.annualBeforeDiscount).toBe(249 + brackets * 50);
      const adv = calculateEstimate(termiteInput({ termiteBaitSystem: "advance", termitePlan: "annual_protection" }));
      expect(adv.results.tmBait.system).toBe("trelona");
      expect(adv.results.tmBait.sta).toBe(sta);
      // camelCase aliases the bridge accepts mirror too.
      applyServerTermiteAnnualPlanPricingConfig({ setupPerStation: 35, annualBase: 259 }, true);
      const alias = calculateEstimate(termiteInput({ termiteBaitSystem: "trelona", termitePlan: "annual_protection" }));
      expect(alias.results.tmBait.setupFee).toBe(alias.results.tmBait.sta * 35);
      expect(alias.results.tmBait.annualFee).toBe(259 + Math.max(0, Math.ceil((alias.results.tmBait.sta - 10) / 5)) * 50);
      // A failed gate lookup fails closed.
      applyServerTermiteAnnualPlanPricingConfig(null, false);
      expect(calculateEstimate(termiteInput({ termiteBaitSystem: "trelona", termitePlan: "annual_protection" })).results.tmBait.plan).toBe("quarterly");
    } finally {
      applyServerTermiteAnnualPlanPricingConfig(null, false);
    }
  });

  it("treats explicit null plan knobs as missing, matching the server defaults", async () => {
    const { applyServerTermiteAnnualPlanPricingConfig } = await import("./estimateEngine");
    try {
      expect(applyServerTermiteAnnualPlanPricingConfig({ annual_step: 0, bracket_floor: 0 }, true))
        .toMatchObject({ annualStep: 0, bracketFloor: 0 });
      // Number(null) is zero in JavaScript, but the server bridge treats null
      // as missing. A client zero here would turn a 15-station $299 plan into
      // $249 when a save falls back to the browser engine.
      const applied = applyServerTermiteAnnualPlanPricingConfig({ annual_step: null, bracket_floor: null }, true);
      expect(applied).toMatchObject({ annualStep: 50, bracketFloor: 10 });
      const estimate = calculateEstimate(termiteInput({ termiteBaitSystem: "trelona", termitePlan: "annual_protection", termitePerimeterLF: 224 }));
      expect(estimate.results.tmBait.sta).toBe(15);
      expect(estimate.results.tmBait.annualFee).toBe(299);
    } finally {
      applyServerTermiteAnnualPlanPricingConfig(null, false);
    }
  });
});
