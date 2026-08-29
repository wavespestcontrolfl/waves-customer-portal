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
  applyServerRodentWaveguardPricingConfig,
  calculateEstimate,
  rodentBaitBracketForFootprint,
  rodentBaitPolicyNote,
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
  applyServerRodentWaveguardPricingConfig(null);
});

describe("rodent bait — live WaveGuard flags drive tier count and bundle % (codex #3591 r12 P1)", () => {
  const pestPlusRodent = () => rodentInput({ svcPest: true, pestFrequency: "quarterly" });

  it("defaults: rodent counts toward the tier (pest + rodent = Silver) and takes the bundle %", () => {
    const E = calculateEstimate(pestPlusRodent());
    expect(E.recurring.waveGuardTier).toBe("Silver");
    expect(rodentRow(E)).not.toMatchObject({ discountable: false });
  });

  it("tier_qualifier=false: rodent no longer counts (pest + rodent = Bronze) and the standalone setup still fires", () => {
    applyServerRodentWaveguardPricingConfig({ tier_qualifier: false, exclude_from_pct_discount: false });
    const E = calculateEstimate(pestPlusRodent());
    expect(E.recurring.waveGuardTier).toBe("Bronze");
    expect(rodentRow(E)).toMatchObject({ countsTowardWaveGuardTier: false });
    // Pest is another qualifier → setup still waived; rodent alone → owed.
    expect(setupRow(E)).toBeUndefined();
    expect(setupRow(calculateEstimate(rodentInput()))).toMatchObject({ price: 99 });
  });

  it("exclude_from_pct_discount=true: the rodent row is carved out of the bundle %", () => {
    applyServerRodentWaveguardPricingConfig({ tier_qualifier: true, exclude_from_pct_discount: true });
    const E = calculateEstimate(pestPlusRodent());
    expect(rodentRow(E)).toMatchObject({ discountable: false, excludeFromPctDiscount: true });
  });
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

  it("an OTHER qualifying family on the matched account waives it (canonical evidence, not tier/rate)", () => {
    expect(setupRow(calculateEstimate(rodentInput({ existingOtherQualifyingService: true })))).toBeUndefined();
    // The old account-level signal is no evidence on its own (rodent-only Bronze).
    expect(setupRow(calculateEstimate(rodentInput({ existingWaveGuardMember: true })))).toMatchObject({ price: 99 });
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

describe("rodent bait — estimator policy note derives from the emitted result (codex #3591 r13 P2)", () => {
  it("standalone non-member: qualifying + discountable + setup applies", () => {
    expect(rodentBaitPolicyNote(calculateEstimate(rodentInput())))
      .toBe("WaveGuard qualifying service — tier discount applies; $99 setup applies (no other qualifying service)");
  });
  it("with another qualifier the setup reads waived; live flags and fee flow through", () => {
    expect(rodentBaitPolicyNote(calculateEstimate(rodentInput({ svcPest: true, pestFrequency: "quarterly" }))))
      .toMatch(/\$99 setup waived/);
    applyServerRodentWaveguardPricingConfig({ tier_qualifier: false, exclude_from_pct_discount: true });
    applyServerRodentSetupFeePricingConfig({ value: 0 });
    expect(rodentBaitPolicyNote(calculateEstimate(rodentInput())))
      .toBe("Not counted toward the WaveGuard tier — excluded from the tier %; no setup fee");
  });
  it("no rodent row → the priced-separately note", () => {
    expect(rodentBaitPolicyNote({})).toMatch(/priced separately/);
  });
});
