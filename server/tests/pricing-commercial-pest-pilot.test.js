const { generateEstimate } = require('../services/pricing-engine');
const { priceCommercialPestPilot } = require('../services/pricing-engine/service-pricing');
const { COMMERCIAL_PEST_PILOT } = require('../services/pricing-engine/constants');
const {
  normalizeProposal,
  computeProposalTotals,
} = require('../services/estimate-proposal');

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
  test('prices the floor at/below the first bracket', () => {
    const result = priceCommercialPestPilot({ buildingSqFt: 1200 }, { frequency: 'quarterly' });
    expect(result).toMatchObject({
      service: 'commercial_pest',
      isCommercial: true,
      commercialPricingMode: 'small_commercial_pilot',
      quoteRequired: false,
      autoQuoteRequiresAdminApproval: true,
      taxable: true,
      taxCategory: 'nonresidential_pest_control',
      visitsPerYear: 4,
    });
    // 1,200 sqft is below the first bracket (2,000 → $95), so the floor applies.
    expect(result.quarterlyPerVisit).toBe(95);
    expect(result.perApp).toBe(95);
    expect(result.annual).toBe(380); // 95 × 4
  });

  test('interpolates between brackets at quarterly cadence', () => {
    // Midpoint between 5,000 ($165) and 10,000 ($245) → 7,500 → $205.
    const result = priceCommercialPestPilot({ buildingSqFt: 7500 }, { frequency: 'quarterly' });
    expect(result.quarterlyPerVisit).toBe(205);
    expect(result.perApp).toBe(205);
    expect(result.visitsPerYear).toBe(4);
    expect(result.annual).toBe(820);
  });

  test('applies the bi-monthly and monthly frequency multipliers', () => {
    const bimonthly = priceCommercialPestPilot({ buildingSqFt: 5000 }, { frequency: 'bimonthly' });
    // 165 × 0.92 = 151.80 per visit, 6 visits/yr.
    expect(bimonthly.perApp).toBeCloseTo(151.8, 2);
    expect(bimonthly.visitsPerYear).toBe(6);

    const monthly = priceCommercialPestPilot({ buildingSqFt: 5000 }, { frequency: 'monthly' });
    // 165 × 0.85 = 140.25 per visit, 12 visits/yr.
    expect(monthly.perApp).toBeCloseTo(140.25, 2);
    expect(monthly.visitsPerYear).toBe(12);
  });

  test('declines (returns null) above the pilot ceiling', () => {
    expect(priceCommercialPestPilot({ buildingSqFt: COMMERCIAL_PEST_PILOT.ceilingSqFt + 1 }, {})).toBeNull();
  });

  test('declines (returns null) when no usable building sqft', () => {
    expect(priceCommercialPestPilot({}, {})).toBeNull();
    expect(priceCommercialPestPilot({ buildingSqFt: 0 }, {})).toBeNull();
  });
});

describe('priceCommercialPestPilot through generateEstimate', () => {
  test('a flagged commercial pest estimate produces a priced recurring line', () => {
    const estimate = generateEstimate(commercialInput());
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest).toBeTruthy();
    expect(pest.quoteRequired).toBe(false);
    expect(pest.annual).toBe(660); // 165 × 4
    // The priced commercial line flows into the recurring summary totals.
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(660);
    // No WaveGuard tier credit for the commercial pilot line.
    expect(estimate.waveGuard.activeServices).not.toContain('commercial_pest');
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
  });

  test('without the pilot flag a commercial pest estimate stays a manual quote', () => {
    const estimate = generateEstimate(commercialInput({
      services: { pest: { frequency: 'quarterly' } },
    }));
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');
    expect(pest).toMatchObject({ commercialPricingMode: 'manual_quote', quoteRequired: true });
  });
});

describe('customer-facing proposal applies FL commercial tax to the priced pilot line', () => {
  test('synthesized proposal marks the commercial line taxable and defaults the FL rate', () => {
    const estimate = generateEstimate(commercialInput());
    const pest = estimate.lineItems.find((l) => l.service === 'commercial_pest');

    // Persisted estimate_data carries the engine line items; the proposal layer
    // synthesizes a fallback proposal from them when none is hand-authored.
    const proposal = normalizeProposal({
      address: '123 Commerce Way',
      estimate_data: JSON.stringify({ lineItems: [pest] }),
    });
    expect(proposal.taxRate).toBeCloseTo(0.07, 4);

    const totals = computeProposalTotals(proposal);
    expect(totals.hasTax).toBe(true);
    // Annual recurring 660 × 7% = 46.20 tax.
    expect(totals.taxableAnnualRecurring).toBe(660);
    expect(totals.totalTax).toBeCloseTo(46.2, 2);
    expect(totals.firstYearTotal).toBeCloseTo(706.2, 2);
  });
});
