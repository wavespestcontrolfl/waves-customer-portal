process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Existing-customer estimate page behavior:
//   - WaveGuard setup fee waived (struck through) and annual prepay removed —
//     pay-per-application is the only payment option.
//   - Member-card "This estimate" savings shown per application.
//   - Cross-sell never offers a service already on the account (termite bait
//     stations → seasonal mosquito ladder instead of "Add Pest Control").
// Leads (no membership snapshot) keep the original page untouched.

const { renderPage, buildPricingBundle } = require('../routes/estimate-public');
const { shouldIncludeWaveGuardSetupFeeForRecurring } = require('../services/estimate-converter');

function lawnEstimate(overrides = {}) {
  return {
    id: `estimate-${Math.random().toString(36).slice(2)}`,
    status: 'sent',
    customerName: 'Don Cichowski',
    address: '5949 Lexington Dr, Parrish, FL 34219',
    monthlyTotal: 62.78,
    annualTotal: 753.36,
    onetimeTotal: 0,
    tier: 'Silver',
    ...overrides,
  };
}

function lawnEstimateData(extra = {}) {
  return {
    result: {
      results: {
        lawn: [{ v: 9, recommended: true }],
      },
      recurring: {
        discount: 0.10,
        annualBeforeDiscount: 837,
        annualAfterDiscount: 753.30,
        services: [{ name: 'Lawn Care', mo: 69.75 }],
      },
      oneTime: { items: [], membershipFee: 99 },
    },
    ...extra,
  };
}

function donMembership(overrides = {}) {
  return {
    isExistingCustomer: true,
    firstName: 'Don',
    tier: 'silver',
    tierLabel: 'Silver',
    tierDiscountPct: 10,
    upgrade: {
      fromLabel: 'Bronze',
      toLabel: 'Silver',
      deltaPct: 10,
      addedServiceLabels: ['Lawn Care'],
    },
    existingServiceKeys: ['pest_control'],
    existingServices: [{
      key: 'pest_control',
      label: 'Pest Control',
      extraDiscountPct: 10,
      perVisitSavings: 11.70,
      remainingVisits: 3,
      totalRemainingSavings: 35.10,
      prepaid: false,
    }],
    newServices: [{
      key: 'lawn_care',
      label: 'Lawn Care',
      discountPct: 10,
      monthlySavings: 6.98,
      perApplicationSavings: 9.30,
    }],
    ...overrides,
  };
}

describe('existing-customer public estimate page', () => {
  test('waives the WaveGuard setup and removes the annual prepay option', () => {
    const html = renderPage('existing-token', lawnEstimate(), lawnEstimateData(), donMembership());

    expect(html).toContain('<s>$99</s> $0');
    expect(html).toContain("you're already a Waves customer");
    // No prepay payment column and no prepay pick button. (The static page
    // JS still carries prepay strings for other estimates, so assert on the
    // rendered elements, not the raw copy.)
    expect(html).not.toContain('<h3>Pay the 12-month plan in full</h3>');
    expect(html).not.toContain('data-payment-setup="prepay_annual"');
    expect(html).not.toContain('data-pay-pref="prepay_annual" data-pay-pref-prepay');
    expect(html).toContain('Choose pay per application');
  });

  test('member card shows per-application savings for the new service', () => {
    const html = renderPage('existing-token-2', lawnEstimate(), lawnEstimateData(), donMembership());

    expect(html).toContain('$9.30/application off');
    expect(html).not.toContain('$6.98/mo off');
  });

  test('cross-sell skips services the customer already has — seasonal mosquito first', () => {
    const html = renderPage('existing-token-3', lawnEstimate(), lawnEstimateData(), donMembership());

    expect(html).not.toContain('Add Pest Control for bundled pricing');
    expect(html).toContain('Add Seasonal Mosquito and save more');
    // Combined services pest + lawn → next tier is Gold (15%).
    expect(html).toContain('Gold tier pricing (15% off qualifying services)');
  });

  test('cross-sell falls back to termite bait stations when mosquito is on the account', () => {
    const membership = donMembership({ existingServiceKeys: ['pest_control', 'mosquito'] });
    const html = renderPage('existing-token-4', lawnEstimate(), lawnEstimateData(), membership);

    expect(html).toContain('Add Termite Bait Stations and save more');
    expect(html).not.toContain('Add Seasonal Mosquito and save more');
  });

  test('leads keep the original page: $99 setup, annual prepay, pest-control cross-sell', () => {
    const html = renderPage('lead-token', lawnEstimate(), lawnEstimateData(), null);

    expect(html).toContain('<h3>Pay the 12-month plan in full</h3>');
    expect(html).toContain('data-payment-setup="prepay_annual"');
    // $99 setup charged (not waived) in the pay-per-application column.
    expect(html).toContain('<span>WaveGuard Membership Setup</span><strong>$99</strong>');
    expect(html).not.toContain("you're already a Waves customer");
    expect(html).toContain('Add Pest Control for bundled pricing');
  });

  test('lawn perks include seasonal rotation, lawn health scoring, and free re-service', () => {
    const html = renderPage('perks-token', lawnEstimate(), lawnEstimateData(), donMembership());

    expect(html).toContain('Seasonal product rotations matched to Southwest Florida turf cycles');
    expect(html).toContain('turf density, weeds, and color tracked over time');
    expect(html).toContain('Re-service between visits at no charge');
  });

  test('pricing bundle drops annual prepay + waivable setup fee for existing customers', async () => {
    const pestEstimateData = (snapshot) => ({
      ...(snapshot ? { membershipSnapshot: snapshot } : {}),
      result: {
        results: { pestTiers: [{ label: 'Quarterly', mo: 95, ann: 1140, pa: 285, apps: 4 }] },
        recurring: { discount: 0, monthlyTotal: 95, annualAfterDiscount: 1140, services: [{ name: 'Pest Control', mo: 95 }] },
        oneTime: { total: 99, membershipFee: 99, items: [] },
      },
    });

    const memberBundle = await buildPricingBundle({
      id: 'bundle-existing-member',
      estimate_data: pestEstimateData({ isExistingCustomer: true }),
    });
    expect(memberBundle.annualPrepayEligible).toBe(false);
    expect((memberBundle.firstVisitFees || []).some((f) => f.service === 'waveguard_setup')).toBe(false);

    const leadBundle = await buildPricingBundle({
      id: 'bundle-lead',
      estimate_data: pestEstimateData(null),
    });
    expect(leadBundle.annualPrepayEligible).toBe(true);
    expect((leadBundle.firstVisitFees || []).some((f) => f.service === 'waveguard_setup')).toBe(true);
  });

  test('estimate-converter never bills the setup fee for existing customers', () => {
    const recurringServices = [{ name: 'Lawn Care', mo: 69.75 }];

    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices,
      estimateData: { membershipSnapshot: { isExistingCustomer: true }, result: { oneTime: { items: [] } } },
    })).toBe(false);

    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices,
      estimateData: { result: { oneTime: { items: [] } } },
    })).toBe(true);
  });
});
