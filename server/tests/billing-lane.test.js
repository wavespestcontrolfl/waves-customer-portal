const {
  BILLING_MODES,
  resolveBillingLane,
  membershipDuesCoverVisit,
  predictCompletionBilling,
} = require('../services/billing-lane');

describe('resolveBillingLane', () => {
  test('explicit billing_mode always wins, whatever the legacy fields say', () => {
    for (const mode of BILLING_MODES) {
      expect(resolveBillingLane({ billing_mode: mode, waveguard_tier: 'Bronze', monthly_rate: 33.33 }))
        .toEqual({ mode, source: 'explicit' });
    }
  });

  test('NULL infers membership from tier + positive monthly rate', () => {
    expect(resolveBillingLane({ billing_mode: null, waveguard_tier: 'Bronze', monthly_rate: 33.33 }))
      .toEqual({ mode: 'monthly_membership', source: 'inferred' });
  });

  test('NULL without tier or without a rate infers per-visit', () => {
    expect(resolveBillingLane({ billing_mode: null, waveguard_tier: null, monthly_rate: 46 }).mode).toBe('per_visit');
    expect(resolveBillingLane({ billing_mode: null, waveguard_tier: 'Silver', monthly_rate: 0 }).mode).toBe('per_visit');
    expect(resolveBillingLane({}).mode).toBe('per_visit');
  });

  test('an unknown mode string falls back to inference instead of being trusted', () => {
    expect(resolveBillingLane({ billing_mode: 'subscription', waveguard_tier: 'Bronze', monthly_rate: 30 }))
      .toEqual({ mode: 'monthly_membership', source: 'inferred' });
  });
});

describe('membershipDuesCoverVisit — explicit lane authority', () => {
  const member = {
    visitIsPayerBilled: false,
    perApplicationBilling: false,
    annualPrepayBilling: false,
    customerAutopayActive: true,
    hasVisitPrice: true,
    isRecurring: true,
    waveguardTier: 'Bronze',
    monthlyRate: 33.33,
  };

  test('an explicit NON-membership lane always defeats coverage — the two-lanes bug can never recur', () => {
    for (const mode of ['per_visit', 'per_application', 'annual_prepay', 'one_time']) {
      expect(membershipDuesCoverVisit({ ...member, billingMode: mode })).toBe(false);
    }
  });

  test('explicit monthly_membership covers even without a tier on file', () => {
    expect(membershipDuesCoverVisit({ ...member, billingMode: 'monthly_membership', waveguardTier: null })).toBe(true);
  });

  test('explicit membership still requires collected dues (rate) and active autopay', () => {
    expect(membershipDuesCoverVisit({ ...member, billingMode: 'monthly_membership', monthlyRate: 0 })).toBe(false);
    expect(membershipDuesCoverVisit({ ...member, billingMode: 'monthly_membership', customerAutopayActive: false })).toBe(false);
  });

  test('NULL mode keeps the legacy inference exactly (tier required)', () => {
    expect(membershipDuesCoverVisit({ ...member, billingMode: null })).toBe(true);
    expect(membershipDuesCoverVisit({ ...member, billingMode: null, waveguardTier: null })).toBe(false);
    expect(membershipDuesCoverVisit({ ...member, billingMode: undefined })).toBe(true);
  });

  test('a priced one-off visit still bills its price in every membership shape', () => {
    expect(membershipDuesCoverVisit({ ...member, isRecurring: false })).toBe(false);
    expect(membershipDuesCoverVisit({ ...member, billingMode: 'monthly_membership', isRecurring: false })).toBe(false);
  });
});

describe('predictCompletionBilling', () => {
  const memberBase = {
    lane: 'monthly_membership',
    billingMode: 'monthly_membership',
    autopayActive: true,
    estimatedPrice: null,
    monthlyRate: 33.33,
    perApplicationFee: null,
    isRecurring: true,
    isCallback: false,
    payerBilled: false,
    prepaidAmount: null,
  };

  test('membership recurring visit → covered, and a stamped price flags the conflict', () => {
    expect(predictCompletionBilling(memberBase)).toEqual({ kind: 'covered_membership', amount: null, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...memberBase, estimatedPrice: 100 }))
      .toEqual({ kind: 'covered_membership', amount: null, conflictStampedPrice: true });
  });

  test('membership one-off priced visit → invoices the price', () => {
    expect(predictCompletionBilling({ ...memberBase, isRecurring: false, estimatedPrice: 150 }))
      .toEqual({ kind: 'invoice', amount: 150, conflictStampedPrice: false });
  });

  test('membership with dead autopay falls through to an invoice (monthly-rate fallback)', () => {
    expect(predictCompletionBilling({ ...memberBase, autopayActive: false }))
      .toEqual({ kind: 'invoice', amount: 33.33, conflictStampedPrice: false });
  });

  test('per-application: auto-charge with a live saved method, invoice without one', () => {
    const perApp = { ...memberBase, lane: 'per_application', billingMode: 'per_application', perApplicationFee: 98, monthlyRate: null };
    expect(predictCompletionBilling(perApp)).toEqual({ kind: 'auto_charge', amount: 98, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perApp, autopayActive: false }))
      .toEqual({ kind: 'invoice', amount: 98, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perApp, isCallback: true }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perApp, perApplicationFee: null }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
  });

  test('per-application honors always-free service types (Codex r1)', () => {
    const perApp = { ...memberBase, lane: 'per_application', billingMode: 'per_application', perApplicationFee: 98, monthlyRate: null };
    expect(predictCompletionBilling({ ...perApp, serviceType: 'Pest Control Re-Service' }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perApp, serviceType: 'Quarterly Pest Control Service' }).kind)
      .toBe('auto_charge');
  });

  test('payer-billed visits short-circuit every lane', () => {
    expect(predictCompletionBilling({ ...memberBase, payerBilled: true }).kind).toBe('payer');
  });

  test('prepaid suppresses only when it covers the WHOLE amount; a partial nets the invoice (Codex r1)', () => {
    const perVisit = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: null, estimatedPrice: 100 };
    expect(predictCompletionBilling({ ...perVisit, prepaidAmount: 120 }))
      .toEqual({ kind: 'prepaid', amount: 120, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perVisit, prepaidAmount: 50 }))
      .toEqual({ kind: 'invoice', amount: 50, conflictStampedPrice: false });
  });

  test('annual prepay: covered ONLY by the term-validated stamp; uncovered priced visits invoice (Codex r2)', () => {
    const annual = { ...memberBase, lane: 'annual_prepay', billingMode: 'annual_prepay' };
    expect(predictCompletionBilling({ ...annual, prepaidMethod: 'annual_prepay_invoice' }).kind)
      .toBe('covered_annual');
    // Stamped below list price still reads covered — the term, not the amount.
    expect(predictCompletionBilling({ ...annual, prepaidMethod: 'annual_prepay_invoice', estimatedPrice: 100, prepaidAmount: 80 }).kind)
      .toBe('covered_annual');
    // Uncovered + unpriced = renewal flow's problem, nothing bills here.
    expect(predictCompletionBilling(annual))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
    // Uncovered + priced add-on bills normally.
    expect(predictCompletionBilling({ ...annual, estimatedPrice: 150 }))
      .toEqual({ kind: 'invoice', amount: 150, conflictStampedPrice: false });
    // A term-validated verdict beats the raw stamp: stale stamp + dead term
    // must not read as covered (Codex r3)...
    expect(predictCompletionBilling({ ...annual, prepaidMethod: 'annual_prepay_invoice', annualCoverageValidated: false, estimatedPrice: 150 }))
      .toEqual({ kind: 'invoice', amount: 150, conflictStampedPrice: false });
    // ...and a validated-true verdict covers even mid-refresh oddities.
    expect(predictCompletionBilling({ ...annual, prepaidMethod: 'annual_prepay_invoice', annualCoverageValidated: true }).kind)
      .toBe('covered_annual');
  });

  test('explicit non-monthly lanes never invoice the lingering monthly rate (Codex r4)', () => {
    const exMember = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: 33.33, estimatedPrice: null };
    expect(predictCompletionBilling(exMember))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...exMember, billingMode: 'one_time', lane: 'one_time' }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
    // NULL (legacy) keeps the historical monthly-rate fallback.
    expect(predictCompletionBilling({ ...memberBase, billingMode: null, autopayActive: false }))
      .toEqual({ kind: 'invoice', amount: 33.33, conflictStampedPrice: false });
  });

  test('per-visit lane invoices the stamped price, callback bills nothing', () => {
    const perVisit = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: null };
    expect(predictCompletionBilling({ ...perVisit, estimatedPrice: 129 }))
      .toEqual({ kind: 'invoice', amount: 129, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perVisit, isCallback: true }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
  });

  test('inferred membership (NULL mode, tier+rate) predicts coverage like the completion path', () => {
    expect(predictCompletionBilling({ ...memberBase, billingMode: null, estimatedPrice: 100 }))
      .toEqual({ kind: 'covered_membership', amount: null, conflictStampedPrice: true });
  });
});
