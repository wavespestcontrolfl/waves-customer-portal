// Regression for Codex R9: the flat commercial price must not be discounted or
// used to unlock discounts by classifiers that normalize any "lawn"/"tree"
// service to a residential key. Covers the annual-prepay floor (converter), the
// existing-WaveGuard-qualifier scan, and the render-category derivation.
const {
  resolveAnnualPrepayInvoiceTotal,
  determineTier,
  recurringServicesFromEstimateData,
} = require('../services/estimate-converter');
const { toQualifyingKey, isMembershipCustomerRow } = require('../services/waveguard-existing-services');
const { deriveServiceCategory, withSupplementedRecurringServices, recurringServiceReceivesTierDiscount } = require('../routes/estimate-public');

describe('commercial lines EARN the 5% annual-prepay discount but never the WaveGuard tier % (owner directive 2026-06-29)', () => {
  test('a priced commercial lawn line takes the 5% annual-prepay discount', () => {
    const data = {
      engineResult: {
        lineItems: [
          { service: 'commercial_lawn', annual: 4689, monthly: 390.75, discountable: false, excludeFromPctDiscount: true },
        ],
      },
    };
    const r = resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 4689,
      recurringServices: [{ service: 'commercial_lawn' }],
      estimateData: data,
    });
    // 5% off the recurring annual — commercial carries no WaveGuard setup fee.
    expect(r.rate).toBeCloseTo(0.05, 4);
    expect(r.amount).toBe(4454.55);
    expect(r.discount).toBe(234.45);
  });

  test('commercial tree/shrub also takes the 5% prepay discount (structural — ignores dropped flags)', () => {
    const data = { engineResult: { lineItems: [{ service: 'commercial_tree_shrub', annual: 2412, monthly: 201 }] } };
    const r = resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 2412,
      recurringServices: [{ service: 'commercial_tree_shrub' }],
      estimateData: data,
    });
    expect(r.amount).toBe(2291.40);
    expect(r.discount).toBe(120.60);
  });

  test('commercial pest also takes the 5% prepay discount but is FL-taxed', () => {
    const data = { engineResult: { lineItems: [{ service: 'commercial_pest', annual: 2280, monthly: 190 }] } };
    const r = resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 2280,
      recurringServices: [{ service: 'commercial_pest' }],
      estimateData: data,
    });
    expect(r.rate).toBeCloseTo(0.05, 4);
    expect(r.amount).toBe(2166.00);
    expect(r.discount).toBe(114.00);
  });

  test('commercial lines are STILL excluded from the WaveGuard tier % (non-members)', () => {
    // The prepay 5% is a cash discount; the WaveGuard membership tier % is a
    // separate path (excludeFromPctDiscount) the commercial line never receives.
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_lawn', excludeFromPctDiscount: true })).toBe(false);
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_tree_shrub', excludeFromPctDiscount: true })).toBe(false);
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_pest', excludeFromPctDiscount: true })).toBe(false);
  });

  test('residential lawn still receives the annual-prepay discount (unchanged)', () => {
    const data = { engineResult: { lineItems: [{ service: 'lawn_care', annual: 1000, monthly: 83.33 }] } };
    const r = resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 1000,
      recurringServices: [{ service: 'lawn_care' }],
      estimateData: data,
    });
    expect(r.discount).toBeGreaterThan(0);
  });
});

describe('commercial plans do not count as WaveGuard qualifiers (existing-services scan)', () => {
  test('commercial labels/keys are non-qualifying', () => {
    expect(toQualifyingKey('Commercial Lawn Treatment')).toBeNull();
    expect(toQualifyingKey('Commercial Tree & Shrub')).toBeNull();
    expect(toQualifyingKey('commercial_lawn')).toBeNull();
  });

  test('residential lawn/tree still qualify (unchanged)', () => {
    expect(toQualifyingKey('Lawn Care')).toBe('lawn_care');
    expect(toQualifyingKey('Tree & Shrub')).toBe('tree_shrub');
  });
});

describe('commercial recurring lines render with their own (non-pest) section copy', () => {
  test('deriveServiceCategory maps commercial lawn/tree to lawn/tree categories, not pest', () => {
    expect(deriveServiceCategory({}, [{ service: 'commercial_lawn' }], [])).toBe('lawn_care');
    expect(deriveServiceCategory({}, [{ service: 'commercial_tree_shrub' }], [])).toBe('tree_shrub');
  });
});

describe('an all-commercial recurring plan does not activate a WaveGuard membership (R9 PR P2)', () => {
  test('determineTier returns "none" when there is no non-commercial recurring service', () => {
    // commercial-only: serviceCount 0 qualifying + hasNonCommercialRecurring false.
    expect(determineTier(0, false)).toMatchObject({ tier: 'none', discount: 0 });
    // residential fallback (any non-commercial recurring) still earns Bronze.
    expect(determineTier(0, true)).toMatchObject({ tier: 'Bronze' });
    // genuinely qualifying counts are unchanged.
    expect(determineTier(2, true).tier).toBe('Silver');
  });

  test('the converter sources priced commercial recurring lines from engineResult.lineItems', () => {
    // Quote-wizard / engine-backed saves persist priced recurring lines under
    // engineResult.lineItems with no recurring.services block — the converter
    // must still see them or an accepted commercial estimate converts with zero
    // recurring services (no schedule/invoice/tier). (Regression for the PR P0.)
    const estData = {
      engineResult: {
        lineItems: [
          { service: 'commercial_lawn', name: 'Commercial Lawn Treatment', annual: 4689, monthly: 391 },
          { service: 'commercial_pest', name: 'Commercial Pest Control', quoteRequired: true, annual: null },
        ],
      },
    };
    const rows = recurringServicesFromEstimateData(estData);
    expect(rows.some((r) => r.service === 'commercial_lawn')).toBe(true);
    // Manual (quote-required, no annual) commercial pest is NOT a recurring row.
    expect(rows.some((r) => r.service === 'commercial_pest')).toBe(false);
  });

  test('nameless engine recurring rows get a synthesized display name (not "Service")', () => {
    // Raw pricer lineItems often omit a name; the scheduler falls back to
    // "Service" which breaks dispatch. Synthesize from the service key.
    const rows = recurringServicesFromEstimateData({
      engineResult: {
        lineItems: [
          { service: 'commercial_lawn', annual: 4689, monthly: 391 },
          { service: 'commercial_tree_shrub', annual: 2412, monthly: 201 },
          { service: 'lawn_care', annual: 1000, monthly: 83 },
        ],
      },
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.service, r.name]));
    expect(byKey.commercial_lawn).toBe('Commercial Lawn Treatment');
    expect(byKey.commercial_tree_shrub).toBe('Commercial Tree & Shrub');
    expect(byKey.lawn_care).toBe('Lawn Care');
  });

  test('a recurring line in both recurring.services and engineResult is not double-counted', () => {
    const estData = {
      recurring: { services: [{ service: 'commercial_lawn', annual: 4689, monthly: 391 }] },
      engineResult: { lineItems: [{ service: 'commercial_lawn', annual: 4689, monthly: 391 }] },
    };
    const rows = recurringServicesFromEstimateData(estData);
    expect(rows.filter((r) => r.service === 'commercial_lawn')).toHaveLength(1);
  });

  test('the "Commercial" tier is treated as a non-member, even with a positive monthly_rate', () => {
    // A null tier + monthly_rate would fall through the legacy rate>0 fallback
    // and read as a member, so commercial-only customers store the explicit
    // non-member "Commercial" tier instead. (Regression for the latest PR P2.)
    expect(isMembershipCustomerRow({ waveguard_tier: 'Commercial', monthly_rate: 391 })).toBe(false);
    // legacy null-tier members (rate>0) are unchanged; real tiers still members.
    expect(isMembershipCustomerRow({ waveguard_tier: null, monthly_rate: 50 })).toBe(true);
    expect(isMembershipCustomerRow({ waveguard_tier: 'Bronze', monthly_rate: 50 })).toBe(true);
  });
});

describe('the commercial disclaimer survives into the supplemented recurring rows (R9 PR P2)', () => {
  test('a priced commercial line keeps its disclaimer (and stays non-discountable) through withSupplementedRecurringServices', () => {
    // Public-quote priced-commercial save shape: engineResult only, no result.
    const estData = {
      engineResult: {
        lineItems: [
          {
            service: 'commercial_lawn', name: 'Commercial Lawn Treatment',
            monthly: 391, annual: 4689,
            disclaimer: 'Estimated from property data — final price confirmed on site.',
            estimatedPricing: true, discountable: false, excludeFromPctDiscount: true,
          },
        ],
      },
    };
    const out = withSupplementedRecurringServices(estData);
    const rows = out?.recurring?.services || out?.result?.recurring?.services || [];
    const row = rows.find((r) => r.service === 'commercial_lawn');
    expect(row).toBeTruthy();
    expect(row.disclaimer).toMatch(/confirmed on site/i);
    expect(row.detail).toMatch(/confirmed on site/i);
    // discount exclusion is preserved on the supplemented row.
    expect(row.waveGuardDiscountEligible).toBe(false);
  });
});
