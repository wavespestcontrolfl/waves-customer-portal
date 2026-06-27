const { generateEstimate } = require('../services/pricing-engine');
const { priceCommercialPestPilot } = require('../services/pricing-engine/service-pricing');
const { COMMERCIAL_PEST_PILOT } = require('../services/pricing-engine/constants');
const { normalizeProposal } = require('../services/estimate-proposal');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

function commercialInput(overrides = {}) {
  return {
    propertyType: 'commercial',
    isCommercial: true,
    homeSqFt: 5000,
    buildingSqFt: 5000,
    stories: 1,
    lotSqFt: 20000,
    features: {},
    paymentMethod: 'card',
    services: {
      pest: { frequency: 'quarterly', commercialPricingMode: 'small_commercial_pilot' },
    },
    ...overrides,
  };
}

describe('priceCommercialPestPilot (unit)', () => {
  test('is a manual-review line carrying a SUGGESTED price (never a committed plan)', () => {
    const result = priceCommercialPestPilot({ buildingSqFt: 5000 }, { frequency: 'quarterly' });
    expect(result).toMatchObject({
      service: 'commercial_pest',
      isCommercial: true,
      commercialPricingMode: 'small_commercial_pilot',
      // Blocking flags set so the existing commercial plumbing refuses self-serve
      // accept and skips the residential membership fee.
      quoteRequired: true,
      requiresManualReview: true,
      autoQuoteRequiresAdminApproval: true,
      taxable: true,
      taxCategory: 'nonresidential_pest_control',
      visitsPerYear: 4,
    });
    // Committed money fields stay null (kept out of engine recurring/one-time totals).
    expect(result.price).toBeNull();
    expect(result.annual).toBeNull();
    expect(result.monthly).toBeNull();
    // Suggested price rides along for the operator + proposal.
    expect(result.suggestedQuarterlyPerVisit).toBe(165);
    expect(result.suggestedPerApp).toBe(165);
    expect(result.suggestedAnnual).toBe(660); // 165 × 4
    expect(result.manualReviewReasons).toContain('commercial_pilot_pricing_requires_admin_approval');
  });

  test('floors below the first bracket', () => {
    const result = priceCommercialPestPilot({ buildingSqFt: 1200 }, { frequency: 'quarterly' });
    expect(result.suggestedQuarterlyPerVisit).toBe(95);
    expect(result.suggestedAnnual).toBe(380);
  });

  test('interpolates between brackets', () => {
    // 7,500 sqft midway between 5,000 ($165) and 10,000 ($245) → $205.
    const result = priceCommercialPestPilot({ buildingSqFt: 7500 }, { frequency: 'quarterly' });
    expect(result.suggestedQuarterlyPerVisit).toBe(205);
    expect(result.suggestedAnnual).toBe(820);
  });

  test('applies bi-monthly and monthly multipliers to the suggested per-visit', () => {
    const bimonthly = priceCommercialPestPilot({ buildingSqFt: 5000 }, { frequency: 'bimonthly' });
    expect(bimonthly.suggestedPerApp).toBeCloseTo(151.8, 2); // 165 × 0.92
    expect(bimonthly.visitsPerYear).toBe(6);

    const monthly = priceCommercialPestPilot({ buildingSqFt: 5000 }, { frequency: 'monthly' });
    expect(monthly.suggestedPerApp).toBeCloseTo(140.25, 2); // 165 × 0.85
    expect(monthly.visitsPerYear).toBe(12);
  });

  test('stories multiply the base for resident callbacks/access', () => {
    const result = priceCommercialPestPilot({ buildingSqFt: 5000, stories: 2 }, {});
    // 165 × (1 + 0.12 × 1) = 184.8
    expect(result.suggestedQuarterlyPerVisit).toBeCloseTo(184.8, 2);
    expect(result.buildings[0].storiesMultiplier).toBeCloseTo(1.12, 3);
  });

  test('units add a per-unit callback reserve', () => {
    const result = priceCommercialPestPilot({ buildingSqFt: 5000, units: 10 }, {});
    // 165 + 5 × 10 = 215
    expect(result.suggestedQuarterlyPerVisit).toBe(215);
    expect(result.totalUnits).toBe(10);
  });

  test('sums per-building prices for a mixed complex (2-story + 1-story)', () => {
    const result = priceCommercialPestPilot({}, {
      buildings: [
        { sqft: 12000, stories: 2, units: 16 },
        { sqft: 6000, stories: 1, units: 8 },
      ],
    });
    // B1: interp(12000)=277 ×1.12 + 16×5 = 390.24 ; B2: interp(6000)=181 ×1.0 + 8×5 = 221
    expect(result.buildingCount).toBe(2);
    expect(result.totalUnits).toBe(24);
    expect(result.buildings[0].quarterlyPerVisit).toBeCloseTo(390.24, 2);
    expect(result.buildings[1].quarterlyPerVisit).toBeCloseTo(221, 2);
    expect(result.suggestedQuarterlyPerVisit).toBeCloseTo(611.24, 2);
    expect(result.suggestedAnnual).toBeCloseTo(2444.96, 2);
  });

  test('declines (null) when any building exceeds the pilot ceiling', () => {
    expect(priceCommercialPestPilot({ buildingSqFt: COMMERCIAL_PEST_PILOT.ceilingSqFt + 1 }, {})).toBeNull();
    expect(priceCommercialPestPilot({}, {
      buildings: [{ sqft: 5000 }, { sqft: 99999 }],
    })).toBeNull();
  });

  test('prices off GROSS area, not derived per-floor footprint (Codex P2)', () => {
    // A 20,000-sf two-story building: gross 20,000 is over the 15,000 ceiling, so
    // the pilot must decline even though homeSqFt/stories = 10,000 footprint.
    expect(priceCommercialPestPilot({ homeSqFt: 20000, footprint: 10000, stories: 2 }, {})).toBeNull();
  });

  test('declines (null) when no usable building sqft', () => {
    expect(priceCommercialPestPilot({}, {})).toBeNull();
    expect(priceCommercialPestPilot({ buildingSqFt: 0 }, {})).toBeNull();
  });

  test('falls back to the profile unitCount when no explicit units given', () => {
    const result = priceCommercialPestPilot({ buildingSqFt: 5000, unitCount: 10 }, {});
    expect(result.totalUnits).toBe(10);
    expect(result.suggestedQuarterlyPerVisit).toBe(215); // 165 + 5×10
  });
});

describe('priceCommercialPestPilot through generateEstimate', () => {
  test('a flagged commercial pest estimate is a manual-review line, not a recurring plan', () => {
    const estimate = generateEstimate(commercialInput());
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest).toBeTruthy();
    expect(pest.quoteRequired).toBe(true);
    expect(pest.requiresManualReview).toBe(true);
    expect(pest.suggestedAnnual).toBe(660);
    // Kept out of the recurring totals (no auto self-serve plan / membership fee).
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(0);
    expect(estimate.waveGuard.activeServices).not.toContain('commercial_pest');
  });

  test('ignores a stale residential pest cadence — the commercial pilot defaults to quarterly', () => {
    // The admin commercial UI hides the pest-frequency selector; a leftover
    // residential `pest.frequency` must not drive the commercial pilot cadence.
    const estimate = generateEstimate(commercialInput({
      services: { pest: { frequency: 'monthly', commercialPricingMode: 'small_commercial_pilot' } },
    }));
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest.frequency).toBe('quarterly');
    expect(pest.visitsPerYear).toBe(4);
    expect(pest.suggestedAnnual).toBe(660);
  });

  test('an estimate above the ceiling falls back to a manual quote', () => {
    const estimate = generateEstimate(commercialInput({ buildingSqFt: 50000, homeSqFt: 50000 }));
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest).toMatchObject({
      commercialPricingMode: 'manual_quote',
      quoteRequired: true,
      requiresManualReview: true,
    });
    expect(pest.price).toBeNull();
    expect(pest.suggestedAnnual).toBeUndefined();
  });

  test('a pilot GPC estimate bundled with another pest-family service downgrades to a manual quote', () => {
    const estimate = generateEstimate(commercialInput({
      services: {
        pest: { frequency: 'quarterly', commercialPricingMode: 'small_commercial_pilot' },
        mosquito: { tier: 'monthly12' },
      },
    }));
    const pestLines = estimate.lineItems.filter((l) => l.service === 'commercial_pest');
    // The pilot only knows GPC; with an extra pest-family service the whole
    // commercial pest bundle becomes one manual quote (nothing suppressed).
    expect(pestLines).toHaveLength(1);
    expect(pestLines[0].commercialPricingMode).toBe('manual_quote');
    expect(pestLines[0].quoteRequired).toBe(true);
    expect(pestLines[0].suggestedAnnual).toBeUndefined();
  });

  test('without the pilot flag a commercial pest estimate stays a manual quote', () => {
    const estimate = generateEstimate(commercialInput({
      services: { pest: { frequency: 'quarterly' } },
    }));
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest).toMatchObject({ commercialPricingMode: 'manual_quote', quoteRequired: true });
    expect(pest.suggestedAnnual).toBeUndefined();
  });

  test('prices off gross area supplied only as livingAreaSqFt (no homeSqFt/buildingSqFt)', () => {
    const estimate = generateEstimate({
      propertyType: 'commercial', isCommercial: true,
      livingAreaSqFt: 5000, stories: 1, lotSqFt: 20000, features: {},
      services: { pest: { frequency: 'quarterly', commercialPricingMode: 'small_commercial_pilot' } },
    });
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest.commercialPricingMode).toBe('small_commercial_pilot');
    expect(pest.suggestedAnnual).toBe(660);
  });

  test('a zero earlier sqft alias does not mask a positive later one', () => {
    // The admin adapter returns homeSqFt: 0 when the form lacks it; the gross-area
    // pick must skip it and use the positive livingAreaSqFt.
    const estimate = generateEstimate({
      propertyType: 'commercial', isCommercial: true,
      homeSqFt: 0, livingAreaSqFt: 5000, stories: 1, lotSqFt: 20000, features: {},
      services: { pest: { frequency: 'quarterly', commercialPricingMode: 'small_commercial_pilot' } },
    });
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest.commercialPricingMode).toBe('small_commercial_pilot');
    expect(pest.suggestedAnnual).toBe(660);
  });

  test('the suggested price is surfaced in the line reason (operator-visible)', () => {
    const estimate = generateEstimate(commercialInput());
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest.reason).toMatch(/suggested \$660/);
  });
});

describe('the pilot suggestion is advisory — it never auto-authors a billable proposal', () => {
  // Commercial pilot estimates are quote-required, so their saved numbers skip
  // the server-authoritative recompute that priced estimates get. To avoid
  // promoting an unverified/stale number into a billable proposal, the synthesized
  // fallback proposal must NOT pull the pilot's suggested price; the operator
  // authors the commercial proposal with a verified price + tax (matching every
  // other commercial proposal). The suggestion stays operator-facing on the
  // estimate card (see the line-reason test above).
  test('the synthesized fallback proposal omits the quote-required pilot price', () => {
    const result = mapV1ToLegacyShape(generateEstimate(commercialInput()));
    const proposal = normalizeProposal({
      address: '9 Plaza Dr',
      estimate_data: JSON.stringify({ result }),
    });
    const descriptions = proposal.buildings.flatMap((b) => b.lineItems.map((li) => li.description));
    expect(descriptions.some((d) => /commercial pest/i.test(d))).toBe(false);
    // No auto-defaulted commercial tax rate either — the operator/CPA sets it.
    expect(proposal.taxRate).toBe(0);
  });
});
