process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Existing-customer estimate page behavior:
//   - WaveGuard setup fee waived (struck through) and annual prepay removed —
//     pay-per-application is the only payment option.
//   - Member-card "This estimate" savings shown per application.
//   - Cross-sell never offers a service already on the account (termite bait
//     stations → seasonal mosquito ladder instead of "Add Pest Control").
// Leads (no membership snapshot) keep the original page untouched.

const { renderPage, buildPricingBundle, clampLawnLadderEntry } = require('../routes/estimate-public');
const { shouldIncludeWaveGuardSetupFeeForRecurring } = require('../services/estimate-converter');
const { publicMembershipView } = require('../services/estimate-membership-context');
const { LAWN_PRICING_V2 } = require('../services/pricing-engine/constants');

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
    discountAppliesTo: 'new_services_only',
    existingServices: [],
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

// The ladder's margin-floor clamp is enforcement-gated on the cost-floor arm
// switch (owner ruling 2026-07-17: floors report, never enforce) — these pins
// re-arm lawn_pricing_v2.useLawnCostFloor to prove the #2795 clamp machinery
// stays intact; the disarmed pin below proves the field alone never clamps.
describe('re-armed margin-floor ladder clamp', () => {
  let priorUseFloor;
  beforeAll(() => {
    priorUseFloor = LAWN_PRICING_V2.useLawnCostFloor;
    LAWN_PRICING_V2.useLawnCostFloor = true;
  });
  afterAll(() => {
    LAWN_PRICING_V2.useLawnCostFloor = priorUseFloor;
  });

test('a monthly lawn floor re-anchors annual billing to the rounded monthly charge', () => {
  const result = clampLawnLadderEntry({
    monthlyBase: 50,
    monthly: 50,
    annual: 600,
    perTreatment: 66.67,
    visits: 9,
    manualDiscount: null,
    marginFloorAnnual: 640,
  });

  expect(result.monthly).toBe(53.34);
  expect(result.annual).toBe(640.08);
});

test('an annual-only lawn floor rounds its derived monthly charge upward', () => {
  const result = clampLawnLadderEntry({
    monthlyBase: null,
    monthly: null,
    annual: 600,
    perTreatment: 66.67,
    visits: 9,
    manualDiscount: null,
    marginFloorAnnual: 630.85,
  });

  expect(result.monthly).toBe(52.58);
  expect(result.annual).toBe(630.85);
  expect(result.monthly * 12).toBeGreaterThanOrEqual(result.annual);
});

test('a manual lawn discount cannot lower the accepted price below its cost-derived margin floor', () => {
  const result = clampLawnLadderEntry({
    monthlyBase: 60,
    monthly: 45,
    annual: 540,
    perTreatment: 60,
    visits: 9,
    manualDiscount: { type: 'FIXED', amount: 180, monthlyAmount: 15 },
    marginFloorAnnual: 640,
  });

  expect(result.monthly).toBe(53.34);
  expect(result.annual).toBe(640.08);
  expect(result.perTreatment).toBe(71.12);
  expect(result.manualDiscount).toEqual(expect.objectContaining({
    amount: 79.92,
    capped: true,
    capReason: 'lawn_margin_floor',
  }));
});
});

test('marginFloorAnnual alone never clamps the ladder while disarmed (owner 2026-07-17)', () => {
  // Every stored/engine row carries the floor fields for margin REPORTING —
  // with useLawnCostFloor false (the default) the clamp must pass prices
  // through untouched.
  const result = clampLawnLadderEntry({
    monthlyBase: 50,
    monthly: 50,
    annual: 600,
    perTreatment: 66.67,
    visits: 9,
    manualDiscount: null,
    marginFloorAnnual: 640,
  });

  expect(result.monthly).toBe(50);
  expect(result.annual).toBe(600);
});

describe('existing-customer public estimate page', () => {
  test('existing-customer lawn estimate has no setup fee and no prepay option', () => {
    const html = renderPage('existing-token', lawnEstimate(), lawnEstimateData(), donMembership());

    // Lawn carries no WaveGuard setup fee under the unified model — nothing to
    // charge, nothing to strike through as waived.
    expect(html).not.toContain('WaveGuard Membership Setup');
    expect(html).not.toContain('<s>$99.00</s> $0.00');
    // Existing members stay pay-per-application only — no prepay column/button.
    // (The static page JS still carries prepay strings for other estimates, so
    // assert on the rendered elements, not the raw copy.)
    expect(html).not.toContain('<h3>Pay the 12-month plan in full</h3>');
    expect(html).not.toContain('data-payment-setup="prepay_annual"');
    expect(html).not.toContain('data-pay-pref="prepay_annual" data-pay-pref-prepay');
    expect(html).toContain('Choose pay per application');
  });

  test('member card shows per-application savings for the new service', () => {
    const html = renderPage('existing-token-2', lawnEstimate(), lawnEstimateData(), donMembership());

    expect(html).toContain('save $9.30 per application');
    expect(html).not.toContain('save $6.98/mo');
  });

  test('member card says the combined tier discounts additions without repricing current service', () => {
    const html = renderPage('existing-token-copy', lawnEstimate(), lawnEstimateData(), donMembership());

    expect(html).toContain('Welcome back, Don');
    expect(html).toContain('what your WaveGuard membership saves you on this estimate');
    expect(html).toContain('bumps your membership from <strong>Bronze</strong>');
    expect(html).toContain('up to <strong>Silver</strong>');
    expect(html).toContain('discounts the new services by up to 10%');
    expect(html).toContain('your current service prices stay unchanged');
    expect(html).not.toContain('including the ones you already have');
    expect(html).not.toContain('Your existing services');
  });

  test('no-benefit membership (combined Bronze, 0% discount) renders no member card', () => {
    const membership = {
      isExistingCustomer: true,
      firstName: 'Dan',
      tier: 'bronze',
      tierLabel: 'Bronze',
      tierDiscountPct: 0,
      upgrade: null,
      existingServiceKeys: [],
      existingServices: [],
      newServices: [{
        key: 'lawn_care',
        label: 'Lawn Care',
        discountPct: 0,
        monthlySavings: 0,
        perApplicationSavings: 0,
      }],
    };
    const html = renderPage('bronze-token', lawnEstimate({ tier: 'Bronze' }), lawnEstimateData(), membership);

    // No card (the class still appears in the static stylesheet) — and never
    // a "$0.00 off" / "Member pricing" row.
    expect(html).not.toContain('<section class="card wg-member-card">');
    expect(html).not.toContain('Welcome back');
    expect(html).not.toContain('Member pricing');
    expect(html).not.toContain('save $0.00');
    // Lawn carries no setup fee, so there is no waived-setup billing treatment.
    expect(html).not.toContain('<s>$99.00</s> $0.00');
    expect(html).not.toContain('WaveGuard Membership Setup');
  });

  test('Silver re-quote with no upgrade and no rows renders no member card', () => {
    const membership = donMembership({
      upgrade: null,
      existingServices: [],
      newServices: [],
    });
    const html = renderPage('silver-requote-token', lawnEstimate(), lawnEstimateData(), membership);

    expect(html).not.toContain('<section class="card wg-member-card">');
    expect(html).not.toContain('Welcome back');
    // Lawn has no setup fee; existing members get no prepay option either.
    expect(html).not.toContain('data-payment-setup="prepay_annual"');
  });

  test('Silver+ with the applied discount margin-guarded to 0 renders no member card', () => {
    // combinedTier says Silver but the engine applied 0% — the snapshot rows
    // carry no real benefit, so no card (Codex P2 on PR #1675).
    const membership = donMembership({
      upgrade: null,
      existingServices: [],
      newServices: [{
        key: 'lawn_care',
        label: 'Lawn Care',
        discountPct: 0,
        monthlySavings: 0,
        perApplicationSavings: 0,
      }],
    });
    const html = renderPage('margin-guard-token', lawnEstimate(), lawnEstimateData(), membership);

    expect(html).not.toContain('<section class="card wg-member-card">');
    expect(html).not.toContain('Member pricing');
  });

  test('legacy snapshot without tierDiscountPct keeps its card when rows carry benefit', () => {
    const membership = donMembership({
      existingServices: [{
        key: 'pest_control', label: 'Pest Control', extraDiscountPct: 10,
        perVisitSavings: 11.70, remainingVisits: 3, totalRemainingSavings: 35.10, prepaid: false,
      }],
    });
    delete membership.tierDiscountPct;
    delete membership.discountAppliesTo;
    const html = renderPage('legacy-snapshot-token', lawnEstimate(), lawnEstimateData(), membership);

    expect(html).toContain('<section class="card wg-member-card">');
    expect(html).toContain('Welcome back, Don');
    expect(html).toContain('save $9.30 per application');
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

  test('leads on a lawn estimate: no setup fee, full 5% prepay discount, pest-control cross-sell', () => {
    const html = renderPage('lead-token', lawnEstimate(), lawnEstimateData(), null);

    // New customers still get the annual prepay option — now a prepay
    // discount in place of the setup waiver, since lawn carries no $99.00
    // setup. Owner ruling 2026-07-17 ("forget all pricing floors") set the
    // lawn program minimum to 0, so no slice of the base is floor-protected —
    // the full configured 5% applies to the whole $753.36 base.
    expect(html).toContain('<h3>Pay the 12-month plan in full</h3>');
    expect(html).toContain('data-payment-setup="prepay_annual"');
    expect(html).toContain('Prepay discount (5%)');
    expect(html).toContain('data-prepay-protected-floor="0" data-prepay-configured-rate="0.05">$715.69');
    expect(html).not.toContain('<span>WaveGuard Membership Setup</span><strong>$99.00</strong>');
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
    const recurringServices = [{ service: 'pest_control', name: 'Pest Control', mo: 69.75 }];

    // Existing pest members never pay the setup again.
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices,
      estimateData: { membershipSnapshot: { isExistingCustomer: true }, result: { oneTime: { items: [] } } },
    })).toBe(false);

    // New pest customers do.
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices,
      estimateData: { result: { oneTime: { items: [] } } },
    })).toBe(true);
  });
});

// The frozen membershipSnapshot carries the STAFF account context
// (currentServices with per-property addresses, per-contract prices, payment
// and visit dates). The unauthenticated token routes must never hand that to
// whoever holds the link — /data sends publicMembershipView(membership) and
// the SSR page gets the same projection.
describe('public boundary: staff account context never escapes the token link', () => {
  const donMembershipWithStaffContext = () => donMembership({
    currentServices: [{
      key: 'pest_control',
      keys: ['pest_control'],
      label: 'Pest Control',
      qualifiesForWaveGuard: true,
      serviceAddresses: ['999 Secondary Property Ln, Venice, 34285'],
      serviceAddressesComplete: true,
      componentServiceAddresses: { pest_control: ['999 Secondary Property Ln, Venice, 34285'] },
      componentServiceAddressesComplete: { pest_control: true },
      currentPerVisit: 117,
      spendSource: 'last_paid_invoice',
      lastPaidAt: '2026-05-20',
      scheduledPerVisit: 120,
      contracts: [{
        serviceAddress: '999 Secondary Property Ln, Venice, 34285',
        scheduledPerVisit: 120,
        activeScheduledVisits: 3,
      }],
      activeScheduledVisits: 3,
      nextScheduledDate: '2026-08-01',
    }],
    currentSpendPerVisitTotal: 117,
  });

  test('the /data membership payload strips every staff field', () => {
    const view = publicMembershipView(donMembershipWithStaffContext());

    const json = JSON.stringify(view);
    for (const staffMarker of [
      'currentServices', 'currentSpendPerVisitTotal', 'serviceAddress', 'contracts',
      'lastPaidAt', 'currentPerVisit', 'spendSource', 'nextScheduledDate',
      '999 Secondary Property Ln', '2026-05-20', '2026-08-01',
    ]) {
      expect(json).not.toContain(staffMarker);
    }
    // The member card's inputs survive.
    expect(view).toMatchObject({
      isExistingCustomer: true,
      firstName: 'Don',
      tierLabel: 'Silver',
      existingServiceKeys: ['pest_control'],
    });
    expect(view.newServices).toEqual([expect.objectContaining({ key: 'lawn_care', perApplicationSavings: 9.30 })]);
  });

  test('the SSR page renders no staff context (stale full snapshot or projected view) and keeps the member card', () => {
    const full = donMembershipWithStaffContext();
    for (const membership of [full, publicMembershipView(full)]) {
      const html = renderPage('boundary-token', lawnEstimate(), lawnEstimateData(), membership);

      expect(html).not.toContain('999 Secondary Property Ln');
      expect(html).not.toContain('2026-05-20');
      expect(html).not.toContain('2026-08-01');
      // The customer-visible membership card is unchanged by the projection.
      expect(html).toContain('Welcome back, Don');
      expect(html).toContain('save $9.30 per application');
      expect(html).toContain('up to <strong>Silver</strong>');
    }
  });
});
