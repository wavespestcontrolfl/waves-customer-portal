/**
 * Rodent bait — client fallback engine (codex #3591 r10).
 *
 * The retained fallback must price from the LIVE ladder + setup fee
 * (pricing_config.rodent_bait_brackets / rodent_setup_fee via the appliers),
 * never a baked literal, and must waive the non-member setup only on real
 * membership evidence (existingWaveGuardMember), never the generic
 * recurring-customer toggle.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  applyServerRodentBaitBracketsPricingConfig,
  applyServerRodentSetupFeePricingConfig,
  calculateEstimate,
  rodentBaitBracketForFootprint,
} from "./estimateEngine";

function rodentInput(overrides = {}) {
  return {
    homeSqFt: 2200,
    stories: "1",
    lotSqFt: 9000,
    propertyType: "Single Family",
    shrubDensity: "MODERATE",
    treeDensity: "MODERATE",
    landscapeComplexity: "MODERATE",
    svcRodentBait: true,
    ...overrides,
  };
}
const rodentRow = (E) => (E.recurring?.services || []).find((s) => s.service === "rodent_bait");
const setupRow = (E) => (E.oneTime?.items || []).find((s) => s.service === "rodent_bait_setup");

afterEach(() => {
  applyServerRodentBaitBracketsPricingConfig(null);
  applyServerRodentSetupFeePricingConfig(null);
});

describe("rodent bait — client fallback prices from the live ladder", () => {
  it("defaults mirror the server ladder (2,200 sf → 5 stations, $89/application)", () => {
    const E = calculateEstimate(rodentInput());
    expect(rodentRow(E)).toMatchObject({ perTreatment: 89, visitsPerYear: 4, perApplicationBilled: true });
    expect(E.results.rodBait).toMatchObject({ stations: 5, perVisit: 89 });
  });

  it("an operator-edited ladder (cents kept) and extension drive the fallback, not the literals", () => {
    applyServerRodentBaitBracketsPricingConfig({
      brackets: [
        { max_sq_ft: 1750, stations: 4, per_visit: 84.5 },
        { max_sq_ft: 2750, stations: 5, per_visit: 94.5 },
      ],
      extension: { per_sq_ft: 500, stations_per_step: 2, per_visit_per_step: 5 },
    });
    expect(rodentRow(calculateEstimate(rodentInput()))).toMatchObject({ perTreatment: 94.5 });
    // Above the top bracket the CONFIGURED extension applies: 3,750 sf is
    // two 500 sf steps past 2,750 → +4 stations, +$10.
    expect(rodentBaitBracketForFootprint(3750)).toEqual({ stations: 9, perVisit: 104.5, extended: true });
  });

  it("a malformed row leaves the defaults in place", () => {
    applyServerRodentBaitBracketsPricingConfig({ brackets: [{ max_sq_ft: "x" }] });
    expect(rodentBaitBracketForFootprint(2200)).toEqual({ stations: 5, perVisit: 89, extended: false });
  });
});

describe("rodent bait — non-member setup waiver uses membership evidence", () => {
  it("standalone rodent with NO membership evidence owes the setup — even with the recurring-customer toggle on", () => {
    expect(setupRow(calculateEstimate(rodentInput()))).toMatchObject({ price: 99 });
    // isRecurringCustomer is loyalty pricing, not membership — a palm/foam-only
    // account or a ticked toggle must not waive the fee (server parity).
    expect(setupRow(calculateEstimate(rodentInput({ isRecurringCustomer: true })))).toMatchObject({ price: 99 });
  });

  it("an active WaveGuard member on the matched account waives it", () => {
    expect(setupRow(calculateEstimate(rodentInput({ existingWaveGuardMember: true })))).toBeUndefined();
  });

  it("another qualifying service on the SAME estimate waives it", () => {
    expect(setupRow(calculateEstimate(rodentInput({ svcPest: true, pestFrequency: "quarterly" })))).toBeUndefined();
  });

  it("the live setup fee flows through; zero disables the line", () => {
    applyServerRodentSetupFeePricingConfig({ value: 79.5 });
    expect(setupRow(calculateEstimate(rodentInput()))).toMatchObject({ price: 79.5 });
    applyServerRodentSetupFeePricingConfig({ value: 0 });
    expect(setupRow(calculateEstimate(rodentInput()))).toBeUndefined();
  });
});
