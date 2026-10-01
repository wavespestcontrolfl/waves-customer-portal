const {
  BILLING_MODES,
  resolveBillingLane,
  impliedMonthlyStampForWrite,
  membershipDuesCoverVisit,
  predictCompletionBilling,
  hasAuthoritativeZeroPrice,
  completionInvoiceAmount,
} = require('../services/billing-lane');

// #3140 resolution: admin/IB writes that TRANSITION a row into the
// inferred-monthly shape (NULL lane + real tier + positive rate) stamp the
// inference explicitly, so no new invisible NULL-mode member rows are minted.
describe('impliedMonthlyStampForWrite', () => {
  const inferred = { billing_mode: null, waveguard_tier: 'Bronze', monthly_rate: 36.33 };

  test('stamps monthly_membership when a write creates the inferred-monthly shape', () => {
    expect(impliedMonthlyStampForWrite({ billing_mode: null, waveguard_tier: null, monthly_rate: 0 }, inferred))
      .toBe('monthly_membership');
    // Create path: no before-state at all.
    expect(impliedMonthlyStampForWrite({}, inferred)).toBe('monthly_membership');
  });

  test('never stamps when the resulting row carries an explicit lane', () => {
    expect(impliedMonthlyStampForWrite({}, { ...inferred, billing_mode: 'per_application' })).toBeNull();
    expect(impliedMonthlyStampForWrite({}, { ...inferred, billing_mode: 'monthly_membership' })).toBeNull();
  });

  test('never stamps a row that was ALREADY inferred-monthly (no restamp on unrelated edits)', () => {
    expect(impliedMonthlyStampForWrite(inferred, { ...inferred, phone: '941-555-0100' })).toBeNull();
  });

  test('sentinel tiers and rate-less rows never stamp (same taxonomy as the resolver)', () => {
    expect(impliedMonthlyStampForWrite({}, { ...inferred, waveguard_tier: 'Commercial' })).toBeNull();
    expect(impliedMonthlyStampForWrite({}, { ...inferred, waveguard_tier: 'One-Time' })).toBeNull();
    expect(impliedMonthlyStampForWrite({}, { ...inferred, waveguard_tier: null })).toBeNull();
    expect(impliedMonthlyStampForWrite({}, { ...inferred, monthly_rate: 0 })).toBeNull();
  });

  test('the stamp equals what the resolver already inferred — zero billing change', () => {
    const stamped = impliedMonthlyStampForWrite({}, inferred);
    expect(stamped).toBe(resolveBillingLane(inferred).mode);
  });
});

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

  test('NULL with a non-membership tier sentinel infers per-visit even with a rate (Codex r5)', () => {
    for (const tier of ['Commercial', 'One-Time', 'None', 'N/A', 'Not Set', 'no']) {
      expect(resolveBillingLane({ billing_mode: null, waveguard_tier: tier, monthly_rate: 150 }).mode)
        .toBe('per_visit');
    }
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

  test('a sentinel tier never dues-covers — one classifier with the lane resolver (Codex r6)', () => {
    for (const tier of ['Commercial', 'One-Time', 'None', 'N/A', 'Not Set']) {
      expect(membershipDuesCoverVisit({ ...member, billingMode: null, waveguardTier: tier })).toBe(false);
    }
    // Explicit membership still overrides whatever sits in the tier column.
    expect(membershipDuesCoverVisit({ ...member, billingMode: 'monthly_membership', waveguardTier: 'Commercial' })).toBe(true);
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

  test('autopay lapsed but dues already collected this month → still predicted covered (matches completion)', () => {
    expect(predictCompletionBilling({ ...memberBase, autopayActive: false, duesCollectedThisMonth: true }))
      .toEqual({ kind: 'covered_membership', amount: null, grossAmount: 33.33, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...memberBase, autopayActive: false, duesCollectedThisMonth: false }))
      .toEqual({ kind: 'invoice', amount: 33.33, grossAmount: 33.33, conflictStampedPrice: false });
  });

  test('membership recurring visit → covered, and a stamped price flags the conflict', () => {
    expect(predictCompletionBilling(memberBase))
      .toEqual({ kind: 'covered_membership', amount: null, grossAmount: 33.33, conflictStampedPrice: false });
    // grossAmount is completionInvoiceAmount's OWN precedence — an explicit
    // estimatedPrice wins over the monthly rate there too, matching Charge
    // Now's resolver (which reads estimatedPrice first, same as every
    // other consumer of that function).
    expect(predictCompletionBilling({ ...memberBase, estimatedPrice: 100 }))
      .toEqual({ kind: 'covered_membership', amount: null, grossAmount: 100, conflictStampedPrice: true });
  });

  test('membership one-off priced visit → invoices the price', () => {
    expect(predictCompletionBilling({ ...memberBase, isRecurring: false, estimatedPrice: 150 }))
      .toEqual({ kind: 'invoice', amount: 150, grossAmount: 150, conflictStampedPrice: false });
  });

  test('membership with dead autopay falls through to an invoice (monthly-rate fallback)', () => {
    expect(predictCompletionBilling({ ...memberBase, autopayActive: false }))
      .toEqual({ kind: 'invoice', amount: 33.33, grossAmount: 33.33, conflictStampedPrice: false });
  });

  test('per-application: auto-charge with a live saved method, invoice without one', () => {
    const perApp = { ...memberBase, lane: 'per_application', billingMode: 'per_application', perApplicationFee: 98, monthlyRate: null };
    expect(predictCompletionBilling(perApp)).toEqual({ kind: 'auto_charge', amount: 98, grossAmount: 98, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perApp, autopayActive: false }))
      .toEqual({ kind: 'invoice', amount: 98, grossAmount: 98, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perApp, isCallback: true }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'callback' });
    expect(predictCompletionBilling({ ...perApp, perApplicationFee: null }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'no_amount_on_file' });
  });

  // Codex pre-push P1 (client-side finding, verified against the server):
  // a stamped estimatedPrice of 0 must resolve exactly like null — hasVisitPrice
  // gates on `estimatedPrice != null && Number(estimatedPrice) > 0`, the SAME
  // precedence completionInvoiceAmount and resolveScheduledServiceCharge
  // (admin-schedule.js) both use — never a bare != null, which reads 0 as an
  // authoritative "$0 visit" and skips the acceptance-fee fallback.
  test('a zero estimatedPrice falls through to the per-application fee, same as null', () => {
    const perApp = { ...memberBase, lane: 'per_application', billingMode: 'per_application', perApplicationFee: 98, monthlyRate: null };
    expect(predictCompletionBilling({ ...perApp, estimatedPrice: 0 }))
      .toEqual({ kind: 'auto_charge', amount: 98, grossAmount: 98, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perApp, estimatedPrice: null }))
      .toEqual({ kind: 'auto_charge', amount: 98, grossAmount: 98, conflictStampedPrice: false });
  });

  test('per-application honors always-free service types (Codex r1)', () => {
    const perApp = { ...memberBase, lane: 'per_application', billingMode: 'per_application', perApplicationFee: 98, monthlyRate: null };
    expect(predictCompletionBilling({ ...perApp, serviceType: 'Pest Control Re-Service' }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'always_free_service_type' });
    expect(predictCompletionBilling({ ...perApp, serviceType: 'Quarterly Pest Control Service' }).kind)
      .toBe('auto_charge');
  });

  test('payer-billed visits short-circuit every lane', () => {
    expect(predictCompletionBilling({ ...memberBase, payerBilled: true }).kind).toBe('payer');
  });

  test('prepaid suppresses only when it covers the WHOLE amount; a partial nets the invoice (Codex r1)', () => {
    const perVisit = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: null, estimatedPrice: 100 };
    expect(predictCompletionBilling({ ...perVisit, prepaidAmount: 120 }))
      .toEqual({ kind: 'prepaid', amount: 120, grossAmount: 100, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perVisit, prepaidAmount: 50 }))
      .toEqual({ kind: 'invoice', amount: 50, grossAmount: 100, conflictStampedPrice: false });
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
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'annual_renewal_owned' });
    // Uncovered + priced add-on bills normally. grossAmount rides along
    // (codex round-9 P2) — the same field the per_application/self-pay
    // lanes already carry, so a checkout sheet that stacks extras on top
    // never misreads this prediction as a stale/legacy payload.
    expect(predictCompletionBilling({ ...annual, estimatedPrice: 150 }))
      .toEqual({ kind: 'invoice', amount: 150, grossAmount: 150, conflictStampedPrice: false });
    // A term-validated verdict beats the raw stamp: stale stamp + dead term
    // must not read as covered (Codex r3)...
    expect(predictCompletionBilling({ ...annual, prepaidMethod: 'annual_prepay_invoice', annualCoverageValidated: false, estimatedPrice: 150 }))
      .toEqual({ kind: 'invoice', amount: 150, grossAmount: 150, conflictStampedPrice: false });
    // ...and a validated-true verdict covers even mid-refresh oddities.
    expect(predictCompletionBilling({ ...annual, prepaidMethod: 'annual_prepay_invoice', annualCoverageValidated: true }).kind)
      .toBe('covered_annual');
  });

  test('explicit non-monthly lanes never invoice the lingering monthly rate (Codex r4)', () => {
    const exMember = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: 33.33, estimatedPrice: null };
    expect(predictCompletionBilling(exMember))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'no_amount_on_file' });
    expect(predictCompletionBilling({ ...exMember, billingMode: 'one_time', lane: 'one_time' }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'no_amount_on_file' });
    // NULL (legacy) keeps the historical monthly-rate fallback.
    expect(predictCompletionBilling({ ...memberBase, billingMode: null, autopayActive: false }))
      .toEqual({ kind: 'invoice', amount: 33.33, grossAmount: 33.33, conflictStampedPrice: false });
  });

  test('per-visit lane invoices the stamped price, callback bills nothing', () => {
    const perVisit = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: null };
    expect(predictCompletionBilling({ ...perVisit, estimatedPrice: 129 }))
      .toEqual({ kind: 'invoice', amount: 129, grossAmount: 129, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perVisit, isCallback: true }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'callback' });
  });

  test('per-visit lane: a PRICED callback or always-free visit predicts no charge — the completion gate will not bill it (Codex r7)', () => {
    const perVisit = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: null };
    expect(predictCompletionBilling({ ...perVisit, estimatedPrice: 129, isCallback: true }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'callback' });
    expect(predictCompletionBilling({ ...perVisit, estimatedPrice: 129, serviceType: 'Pest Control Re-Service' }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'always_free_service_type' });
    expect(predictCompletionBilling({
      ...perVisit, billingMode: 'one_time', lane: 'one_time', estimatedPrice: 129, isCallback: true,
    })).toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'callback' });
  });

  test('a stale annual-prepay stamp amount never reads as prepaid — completion excludes it from the numeric fallback (Codex r7)', () => {
    const staleStamp = {
      ...memberBase,
      lane: 'annual_prepay',
      billingMode: 'annual_prepay',
      estimatedPrice: 100,
      prepaidAmount: 500,
      prepaidMethod: 'annual_prepay_invoice',
      annualCoverageValidated: false,
    };
    expect(predictCompletionBilling(staleStamp))
      .toEqual({ kind: 'invoice', amount: 100, grossAmount: 100, conflictStampedPrice: false });
    // Out-of-band prepay (cash/Zelle) still covers by amount.
    expect(predictCompletionBilling({ ...staleStamp, prepaidMethod: 'cash' }))
      .toEqual({ kind: 'prepaid', amount: 500, grossAmount: 100, conflictStampedPrice: false });
  });

  test('inferred membership (NULL mode, tier+rate) predicts coverage like the completion path', () => {
    expect(predictCompletionBilling({ ...memberBase, billingMode: null, estimatedPrice: 100 }))
      .toEqual({ kind: 'covered_membership', amount: null, grossAmount: 100, conflictStampedPrice: true });
  });

  // Codex pre-push P1 (round 3): completion-pricing's discount engine
  // freezes a fully-discounted application at a genuine $0 net by stamping
  // BOTH primary_line_price (the pre-discount gross base) and
  // estimated_price (the post-discount net) together — pinned for real by
  // completion-pricing.postgres.test.js's "fully discounted application
  // stays zero" case. A bare estimatedPrice: 0 with NO primaryLinePrice is
  // the DIFFERENT, indistinguishable-from-null shape (the sibling-covered
  // same-trip PROMOTED row leaves both columns null) and must keep
  // deferring to the fee fallback exactly as before — this predicate is
  // the ONE thing that tells the two apart.
  describe('a provenance-backed $0 (primaryLinePrice on the row) stays free — never the fee/rate fallback', () => {
    test('per_application: a fully-discounted application predicts no charge, never the acceptance fee', () => {
      const perApp = {
        ...memberBase, lane: 'per_application', billingMode: 'per_application',
        estimatedPrice: 0, primaryLinePrice: 100, perApplicationFee: 97.2, monthlyRate: null,
      };
      expect(predictCompletionBilling(perApp))
        .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'fully_discounted' });
      // Without primaryLinePrice (the parity fixture's own shape — a bare
      // stamped 0, no provenance), the SAME estimatedPrice: 0 still defers
      // to the acceptance fee exactly as before this change.
      expect(predictCompletionBilling({ ...perApp, primaryLinePrice: null }))
        .toEqual({ kind: 'auto_charge', amount: 97.2, grossAmount: 97.2, conflictStampedPrice: false });
    });

    test('self-pay/membership lane: a fully-discounted visit predicts no charge, never the monthly rate', () => {
      const selfPay = {
        ...memberBase, lane: null, billingMode: 'per_visit', autopayActive: false,
        estimatedPrice: 0, primaryLinePrice: 62.5, monthlyRate: 74.7, isRecurring: false,
      };
      expect(predictCompletionBilling(selfPay))
        .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'fully_discounted' });
    });

    test('a primaryLinePrice of 0 (or missing) is NOT provenance — a bare stamped 0 defers to the fallback', () => {
      const perApp = {
        ...memberBase, lane: 'per_application', billingMode: 'per_application',
        estimatedPrice: 0, perApplicationFee: 97.2, monthlyRate: null,
      };
      expect(predictCompletionBilling({ ...perApp, primaryLinePrice: 0 }))
        .toEqual({ kind: 'auto_charge', amount: 97.2, grossAmount: 97.2, conflictStampedPrice: false });
      expect(predictCompletionBilling(perApp))
        .toEqual({ kind: 'auto_charge', amount: 97.2, grossAmount: 97.2, conflictStampedPrice: false });
    });

    test('a POSITIVE estimatedPrice always wins, provenance or not', () => {
      const perApp = {
        ...memberBase, lane: 'per_application', billingMode: 'per_application',
        estimatedPrice: 40, primaryLinePrice: 100, perApplicationFee: 97.2, monthlyRate: null,
      };
      expect(predictCompletionBilling(perApp))
        .toEqual({ kind: 'auto_charge', amount: 40, grossAmount: 40, conflictStampedPrice: false });
    });

    // Codex round 4 P1: Number(null) === 0 and Number('') === 0 — a row that
    // was simply NEVER PRICED (estimatedPrice null/'') must not be read as a
    // deliberately-frozen $0 just because a positive primary_line_price
    // happens to be on file. hasAuthoritativeZeroPrice requires an ACTUAL
    // stamped zero; without this the acceptance-fee fallback silently
    // vanished for every unpriced per-application row that also carries a
    // base price (pre-fix this test asserted 'no_charge'/'fully_discounted').
    test('null/empty estimatedPrice with a positive primaryLinePrice is NOT an authoritative zero — the fee fallback still applies', () => {
      expect(hasAuthoritativeZeroPrice(null, 100)).toBe(false);
      expect(hasAuthoritativeZeroPrice('', 100)).toBe(false);
      expect(hasAuthoritativeZeroPrice(undefined, 100)).toBe(false);
      // A genuine stamped 0 is unaffected by this guard.
      expect(hasAuthoritativeZeroPrice(0, 100)).toBe(true);

      const perApp = {
        ...memberBase, lane: 'per_application', billingMode: 'per_application',
        estimatedPrice: null, primaryLinePrice: 100, perApplicationFee: 97.2, monthlyRate: null,
      };
      expect(predictCompletionBilling(perApp))
        .toEqual({ kind: 'auto_charge', amount: 97.2, grossAmount: 97.2, conflictStampedPrice: false });
      expect(completionInvoiceAmount({
        estimatedPrice: null, isCallback: false, perApplicationBilling: true,
        perApplicationFee: 97.2, monthlyRate: null, billingMode: 'per_application', primaryLinePrice: 100,
      })).toBe(97.2);
    });
  });
});

// GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28, waves-billing skill
// invariant #8): "Unpriced = NULL, never $0. $0 means charge nothing." Off
// (default, exercised by every test above and below this block — none of
// them set the gate) is byte-identical to today: a bare stamped 0 with no
// primaryLinePrice still defers to the fee/rate fallback. On, ANY stamped 0
// is authoritative in every lane, no primaryLinePrice needed.
describe('GATE_STAMPED_ZERO_FREE — a bare stamped $0 bills nothing, every lane', () => {
  afterEach(() => { delete process.env.GATE_STAMPED_ZERO_FREE; });

  const memberBase = {
    lane: 'monthly_membership',
    billingMode: 'monthly_membership',
    autopayActive: true,
    estimatedPrice: 0,
    monthlyRate: 33.33,
    perApplicationFee: null,
    isRecurring: false,
    isCallback: false,
    payerBilled: false,
    prepaidAmount: null,
  };

  test('hasAuthoritativeZeroPrice: off requires primaryLinePrice, on does not', () => {
    expect(hasAuthoritativeZeroPrice(0, null)).toBe(false);
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    expect(hasAuthoritativeZeroPrice(0, null)).toBe(true);
    // A genuinely blank row is unaffected either way — gate or no gate,
    // NULL/'' is never a stamped zero.
    expect(hasAuthoritativeZeroPrice(null, null)).toBe(false);
    expect(hasAuthoritativeZeroPrice('', null)).toBe(false);
    // A non-'true' value keeps the gate off (strict opt-in convention).
    process.env.GATE_STAMPED_ZERO_FREE = '1';
    expect(hasAuthoritativeZeroPrice(0, null)).toBe(false);
  });

  test('completionInvoiceAmount: monthly_membership — a bare stamped 0 bills nothing on, monthly_rate off', () => {
    const args = {
      estimatedPrice: 0, isCallback: false, perApplicationBilling: false,
      perApplicationFee: null, monthlyRate: 33.33, billingMode: 'monthly_membership',
    };
    expect(completionInvoiceAmount(args)).toBe(33.33);
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    expect(completionInvoiceAmount(args)).toBe(0);
  });

  test('completionInvoiceAmount: per_application — a bare stamped 0 bills nothing on, the fee off', () => {
    const args = {
      estimatedPrice: 0, isCallback: false, perApplicationBilling: true,
      perApplicationFee: 97.2, monthlyRate: null, billingMode: 'per_application',
    };
    expect(completionInvoiceAmount(args)).toBe(97.2);
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    expect(completionInvoiceAmount(args)).toBe(0);
  });

  test('completionInvoiceAmount: legacy null lane (no billing_mode) — a bare stamped 0 bills nothing on, monthly_rate off', () => {
    const args = {
      estimatedPrice: 0, isCallback: false, perApplicationBilling: false,
      perApplicationFee: null, monthlyRate: 50, billingMode: null,
    };
    expect(completionInvoiceAmount(args)).toBe(50);
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    expect(completionInvoiceAmount(args)).toBe(0);
  });

  test('completionInvoiceAmount: a genuinely NULL/blank row still falls to the fallback on either setting', () => {
    const args = {
      estimatedPrice: null, isCallback: false, perApplicationBilling: false,
      perApplicationFee: null, monthlyRate: 50, billingMode: null,
    };
    expect(completionInvoiceAmount(args)).toBe(50);
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    expect(completionInvoiceAmount(args)).toBe(50);
  });

  test('predictCompletionBilling: monthly_membership one-off stamped $0 reads fully_discounted only with the gate on', () => {
    // Off: a bare stamped 0 (no primaryLinePrice) reads as "no price on
    // file" — dues cover it exactly like a genuinely blank row would
    // (today's behavior, byte-identical).
    expect(predictCompletionBilling(memberBase))
      .toEqual({ kind: 'covered_membership', amount: null, grossAmount: 33.33, conflictStampedPrice: false });
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    // On: the stamp is now this ONE-OFF visit's own deliberate price —
    // dues do not "cover" a visit that is already free on its own terms.
    expect(predictCompletionBilling(memberBase))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'fully_discounted' });
  });

  test('predictCompletionBilling: per_application stamped $0 reads fully_discounted only with the gate on', () => {
    const perApp = { ...memberBase, lane: 'per_application', billingMode: 'per_application', perApplicationFee: 97.2, monthlyRate: null };
    expect(predictCompletionBilling(perApp))
      .toEqual({ kind: 'auto_charge', amount: 97.2, grossAmount: 97.2, conflictStampedPrice: false });
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    expect(predictCompletionBilling(perApp))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'fully_discounted' });
  });

  test('predictCompletionBilling: a callback stamped $0 is unaffected by the gate (still plain "callback", never fully_discounted)', () => {
    // autopayActive: false so dues coverage never masks the callback
    // exclusion this test actually targets.
    const callback = { ...memberBase, isCallback: true, isRecurring: false, autopayActive: false };
    const offResult = predictCompletionBilling(callback);
    expect(offResult).toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'callback' });
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    expect(predictCompletionBilling(callback)).toEqual(offResult);
  });

  test('predictCompletionBilling: a RECURRING member stamped $0 stays dues-covered on either setting, but the gate surfaces the stamp as a conflict (like any other stamped price already does)', () => {
    const recurring = { ...memberBase, isRecurring: true };
    expect(predictCompletionBilling(recurring))
      .toEqual({ kind: 'covered_membership', amount: null, grossAmount: 33.33, conflictStampedPrice: false });
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    // Coverage itself is unchanged (isRecurring alone satisfies it) — but
    // the widened hasVisitPrice now recognizes the $0 as the visit's own
    // stamped price, so grossAmount follows completionInvoiceAmount's own
    // (now-widened) reading of it, and conflictStampedPrice flags it the
    // SAME way a stamped $100 already does two tests above — a real
    // stamped price beside dues coverage, worth a heads-up either way.
    expect(predictCompletionBilling(recurring))
      .toEqual({ kind: 'covered_membership', amount: null, grossAmount: 0, conflictStampedPrice: true });
  });

  test('attachedInvoiceAutoChargeLikely: per_application stamped $0 anchors at $0 (no charge) only with the gate on', () => {
    const { attachedInvoiceAutoChargeLikely } = require('../services/billing-lane');
    const base = {
      invoice: { subtotal: 0, total: 0, discount_amount: 0 },
      autopayActive: true,
      estimatedPrice: 0,
      isRecurring: false,
      isCallback: false,
      serviceType: 'Pest Control',
      billingMode: 'per_application',
      perApplicationFee: 97.2,
    };
    // Off: the bare stamped 0 still defers to the fee anchor, so a $0
    // invoice is well under it — no assertion needed beyond "does not
    // throw"; the gate-on case below is the one this PR changes.
    expect(() => attachedInvoiceAutoChargeLikely(base)).not.toThrow();
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    // A $0 subtotal invoice is still <= a $0 anchor, so this alone doesn't
    // distinguish the two settings; assert the anchor logic directly via a
    // subtotal that WOULD pass the old fee anchor but must now be refused.
    expect(attachedInvoiceAutoChargeLikely({ ...base, invoice: { subtotal: 40, total: 40, discount_amount: 0 } }))
      .toBe(false);
    delete process.env.GATE_STAMPED_ZERO_FREE;
    expect(attachedInvoiceAutoChargeLikely({ ...base, invoice: { subtotal: 40, total: 40, discount_amount: 0 } }))
      .toBe(true);
  });
});

// Mid-month autopay lapse after the cron already collected the month's dues:
// coverage must follow the COLLECTED dues, not the autopay flag, or every
// remaining plan visit that month mints a full monthly_rate invoice on top
// of the dues already paid (2-3x double-billing).
describe('membershipDuesCoverVisit — dues already collected this month', () => {
  const { monthlyDuesCollected } = require('../services/billing-lane');
  const lapsedMember = {
    visitIsPayerBilled: false,
    perApplicationBilling: false,
    annualPrepayBilling: false,
    customerAutopayActive: false,
    hasVisitPrice: false,
    isRecurring: true,
    waveguardTier: 'Bronze',
    monthlyRate: 33.33,
    billingMode: 'monthly_membership',
  };

  test('autopay inactive + dues collected for the month → covered (no invoice)', () => {
    expect(membershipDuesCoverVisit({ ...lapsedMember, duesCollectedThisMonth: true })).toBe(true);
    // A stamped per-visit price on a recurring plan row stays covered too.
    expect(membershipDuesCoverVisit({ ...lapsedMember, duesCollectedThisMonth: true, hasVisitPrice: true })).toBe(true);
  });

  test('autopay inactive + no dues collected → NOT covered (existing behaviour)', () => {
    expect(membershipDuesCoverVisit({ ...lapsedMember, duesCollectedThisMonth: false })).toBe(false);
    expect(membershipDuesCoverVisit(lapsedMember)).toBe(false);
  });

  test('collected dues never widen coverage past the other exclusions', () => {
    const paid = { ...lapsedMember, duesCollectedThisMonth: true };
    expect(membershipDuesCoverVisit({ ...paid, visitIsPayerBilled: true })).toBe(false);
    expect(membershipDuesCoverVisit({ ...paid, perApplicationBilling: true })).toBe(false);
    expect(membershipDuesCoverVisit({ ...paid, annualPrepayBilling: true })).toBe(false);
    expect(membershipDuesCoverVisit({ ...paid, billingMode: 'per_visit' })).toBe(false);
    expect(membershipDuesCoverVisit({ ...paid, billingMode: 'one_time' })).toBe(false);
    expect(membershipDuesCoverVisit({ ...paid, hasVisitPrice: true, isRecurring: false })).toBe(false);
    expect(membershipDuesCoverVisit({ ...paid, monthlyRate: 0 })).toBe(false);
  });

  // monthlyDuesCollected against a fake knex: the visit-month key drives the
  // billed_month match, so the "dues payment present" scenario is exercised
  // end to end through the same helper the completion route now calls.
  function fakeDb(paymentsRows) {
    return (table) => {
      expect(table).toBe('payments');
      const state = { customerId: null, monthKey: null };
      const builder = {
        where(arg) {
          if (typeof arg === 'function') arg.call(builder);
          else state.customerId = arg.customer_id;
          return builder;
        },
        whereIn() { return builder; },
        whereRaw(sql, bindings) {
          if (sql.includes('billed_month') && bindings) state.monthKey = bindings[0];
          return builder;
        },
        orWhere(fn) { fn.call(builder); return builder; },
        andWhereRaw() { return builder; },
        andWhere() { return builder; },
        async first() {
          return paymentsRows.find((r) => r.customer_id === state.customerId
            && ['paid', 'processing'].includes(r.status)
            && r.metadata?.billed_month === state.monthKey) || undefined;
        },
      };
      return builder;
    };
  }

  test('dues payment stamped for the visit month → collected; none → not collected', async () => {
    const rows = [{ id: 1, customer_id: 42, status: 'paid', metadata: { billed_month: '2026-08' } }];
    const visitMonth = new Date('2026-08-19T12:00:00Z');
    await expect(monthlyDuesCollected(fakeDb(rows), 42, visitMonth)).resolves.toBe(true);
    await expect(monthlyDuesCollected(fakeDb([]), 42, visitMonth)).resolves.toBe(false);
    // A different month's dues do not cover this visit.
    await expect(monthlyDuesCollected(fakeDb(rows), 42, new Date('2026-09-03T12:00:00Z'))).resolves.toBe(false);
  });
});

describe('predictCompletionBilling — GATE_COMPLETION_AUTOPAY_CHARGE extension (owner ruling 2026-08-26/27)', () => {
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
  test('an uncovered member invoice predicts auto_charge with the gate on + autopay active', () => {
    // one-off (non-recurring) priced visit — dues never cover it
    expect(predictCompletionBilling({
      ...memberBase, isRecurring: false, estimatedPrice: 90.55, completionAutopayChargeEnabled: true,
    })).toEqual({ kind: 'auto_charge', amount: 90.55, grossAmount: 90.55, conflictStampedPrice: false });
  });
  test('gate off keeps the historical invoice prediction byte-identical', () => {
    expect(predictCompletionBilling({ ...memberBase, isRecurring: false, estimatedPrice: 90.55 }))
      .toEqual({ kind: 'invoice', amount: 90.55, grossAmount: 90.55, conflictStampedPrice: false });
  });
  test('autopay inactive keeps invoice even with the gate on', () => {
    expect(predictCompletionBilling({
      ...memberBase, autopayActive: false, isRecurring: false, estimatedPrice: 90.55, completionAutopayChargeEnabled: true,
    }).kind).toBe('invoice');
  });
  test('annual-prepay uncovered priced add-on predicts auto_charge under the gate', () => {
    expect(predictCompletionBilling({
      ...memberBase, lane: 'annual_prepay', billingMode: 'annual_prepay', estimatedPrice: 150, completionAutopayChargeEnabled: true,
    })).toEqual({ kind: 'auto_charge', amount: 150, grossAmount: 150, conflictStampedPrice: false });
  });
  test('per-visit lane priced invoice predicts auto_charge under the gate; partial prepay still nets', () => {
    const perVisit = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: null, estimatedPrice: 100, completionAutopayChargeEnabled: true };
    expect(predictCompletionBilling(perVisit))
      .toEqual({ kind: 'auto_charge', amount: 100, grossAmount: 100, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perVisit, prepaidAmount: 50 }))
      .toEqual({ kind: 'auto_charge', amount: 50, grossAmount: 100, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perVisit, prepaidAmount: 120 }).kind).toBe('prepaid');
  });
  test('no-cost visits never predict auto_charge even under the gate (mirror of the charge lane)', () => {
    expect(predictCompletionBilling({
      ...memberBase, isRecurring: false, estimatedPrice: 90.55, isCallback: true, completionAutopayChargeEnabled: true,
    }).kind).not.toBe('auto_charge');
    expect(predictCompletionBilling({
      ...memberBase, isRecurring: false, estimatedPrice: 90.55, serviceType: 'Pest Control Re-Service', completionAutopayChargeEnabled: true,
    }).kind).not.toBe('auto_charge');
    expect(predictCompletionBilling({
      ...memberBase, lane: 'annual_prepay', billingMode: 'annual_prepay', estimatedPrice: 150, isCallback: true, completionAutopayChargeEnabled: true,
    }).kind).not.toBe('auto_charge');
  });
  test('dues-covered visits stay covered_membership regardless of the gate', () => {
    expect(predictCompletionBilling({ ...memberBase, completionAutopayChargeEnabled: true }).kind)
      .toBe('covered_membership');
  });
  test('the gate never revives an amount the lane refused (explicit non-monthly lingering rate)', () => {
    expect(predictCompletionBilling({
      ...memberBase, lane: 'per_visit', billingMode: 'per_visit', estimatedPrice: null, completionAutopayChargeEnabled: true,
    }).kind).toBe('no_charge');
  });
});

describe('verifyExtendedCompletionAnchor (shared in-lock cap authority)', () => {
  const { verifyExtendedCompletionAnchor } = require('../services/billing-lane');
  // Chainable stub for the monthlyDuesCollected read inside the verdict.
  const duesConn = (collected) => (table) => {
    const chain = {
      where() { return chain; },
      whereIn() { return chain; },
      whereNotIn() { return chain; },
      whereRaw() { return chain; },
      orWhere() { return chain; },
      andWhereRaw() { return chain; },
      andWhere() { return chain; },
      // scheduled_services = the verdict's full-row re-read for annual
      // coverage validation; payments = the dues-collected probe.
      first: async () => (table === 'scheduled_services'
        ? { id: 's1', customer_id: 'c1' }
        : (table === 'payments' && collected ? { id: 'p1' } : null)),
    };
    return chain;
  };
  const member = { id: 'c1', billing_mode: 'monthly_membership', monthly_rate: 33.33, waveguard_tier: 'Silver' };
  const visit = { id: 's1', customer_id: 'c1', status: 'completed', is_recurring: false, estimated_price: 90.55, is_callback: false, prepaid_method: null };
  const invoiceAt = (subtotal) => ({ subtotal, total: subtotal, discount_amount: 0, scheduled_service_id: 's1' });

  test('priced one-off member invoice at the visit price verifies with that anchor', async () => {
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false), lockedCustomer: member, lockedSvc: visit, lockedInvoice: invoiceAt(90.55),
    })).resolves.toEqual({ ok: true, anchor: 90.55 });
  });
  test('an invoice above the anchor refuses (anchor_exceeded)', async () => {
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false), lockedCustomer: member, lockedSvc: visit, lockedInvoice: invoiceAt(120),
    })).resolves.toEqual({ ok: false, reason: 'anchor_exceeded' });
  });
  test('a per-application flip refuses before any anchor math', async () => {
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false),
      lockedCustomer: { ...member, billing_mode: 'per_application' },
      lockedSvc: visit,
      lockedInvoice: invoiceAt(90.55),
    })).resolves.toEqual({ ok: false, reason: 'per_application_lane' });
  });
  test('LIVE annual coverage refuses; a validated-STALE stamp and the annual LANE alone do not (priced add-on charges)', async () => {
    const renewals = require('../services/annual-prepay-renewals');
    const coversSpy = jest.spyOn(renewals, 'annualPrepayCoversVisit');
    try {
      coversSpy.mockResolvedValue(true);
      await expect(verifyExtendedCompletionAnchor({
        dbConn: duesConn(false),
        lockedCustomer: member,
        lockedSvc: { ...visit, prepaid_method: 'annual_prepay_invoice' },
        lockedInvoice: invoiceAt(90.55),
      })).resolves.toEqual({ ok: false, reason: 'annual_prepay_coverage' });
      // Validated-stale stamp: the coverage authority says NOT covered —
      // the priced add-on keeps its charge at the visit price.
      coversSpy.mockResolvedValue(false);
      await expect(verifyExtendedCompletionAnchor({
        dbConn: duesConn(false),
        lockedCustomer: member,
        lockedSvc: { ...visit, prepaid_method: 'annual_prepay_invoice' },
        lockedInvoice: invoiceAt(90.55),
      })).resolves.toEqual({ ok: true, anchor: 90.55 });
    } finally {
      coversSpy.mockRestore();
    }
    // Annual LANE with no stamp: never consults coverage, charges the add-on.
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false),
      lockedCustomer: { ...member, billing_mode: 'annual_prepay' },
      lockedSvc: { ...visit, estimated_price: 150 },
      lockedInvoice: invoiceAt(150),
    })).resolves.toEqual({ ok: true, anchor: 150 });
  });
  test('callbacks and always-free service types refuse under the lock (no_cost_visit)', async () => {
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false), lockedCustomer: member, lockedSvc: { ...visit, is_callback: true }, lockedInvoice: invoiceAt(90.55),
    })).resolves.toEqual({ ok: false, reason: 'no_cost_visit' });
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false), lockedCustomer: member, lockedSvc: { ...visit, service_type: 'Pest Control Re-Service' }, lockedInvoice: invoiceAt(90.55),
    })).resolves.toEqual({ ok: false, reason: 'no_cost_visit' });
  });
  test('an out-of-band prepayment on the locked visit refuses (out_of_band_prepayment)', async () => {
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false), lockedCustomer: member,
      lockedSvc: { ...visit, prepaid_method: 'cash', prepaid_amount: 50 },
      lockedInvoice: invoiceAt(90.55),
    })).resolves.toEqual({ ok: false, reason: 'out_of_band_prepayment' });
  });
  test('an ALREADY-APPLIED prepayment (netting marker present) charges the residual', async () => {
    const markerConn = (table) => {
      const chain = {
        where() { return chain; },
        whereIn() { return chain; },
        whereNotIn() { return chain; },
        whereRaw() { return chain; },
        orWhere() { return chain; },
        andWhereRaw() { return chain; },
        andWhere() { return chain; },
        first: async () => (table === 'payments' ? { id: 'prepaid-marker' }
          : (table === 'scheduled_services' ? { id: 's1', customer_id: 'c1' } : null)),
      };
      return chain;
    };
    await expect(verifyExtendedCompletionAnchor({
      dbConn: markerConn, lockedCustomer: member,
      lockedSvc: { ...visit, prepaid_method: 'cash', prepaid_amount: 50 },
      lockedInvoice: invoiceAt(40.55),
    })).resolves.toEqual({ ok: true, anchor: 90.55 });
  });
  test('a live estimate card hold owns the booking (estimate_card_hold)', async () => {
    const holdConn = (table) => {
      const chain = {
        where() { return chain; },
        whereIn() { return chain; },
        whereNotIn() { return chain; },
        whereRaw() { return chain; },
        orWhere() { return chain; },
        andWhereRaw() { return chain; },
        andWhere() { return chain; },
        first: async () => (table === 'estimate_card_holds' ? { id: 'hold1' }
          : (table === 'scheduled_services' ? { id: 's1', customer_id: 'c1' } : null)),
      };
      return chain;
    };
    await expect(verifyExtendedCompletionAnchor({
      dbConn: holdConn, lockedCustomer: member, lockedSvc: visit, lockedInvoice: invoiceAt(90.55),
    })).resolves.toEqual({ ok: false, reason: 'estimate_card_hold' });
  });
  test('an ACTIVE payment plan on the invoice refuses the charge (active_payment_plan)', async () => {
    const planConn = (table) => {
      const chain = {
        where() { return chain; },
        whereIn() { return chain; },
        whereNotIn() { return chain; },
        whereRaw() { return chain; },
        orWhere() { return chain; },
        andWhereRaw() { return chain; },
        andWhere() { return chain; },
        first: async () => (table === 'payment_plans' ? { id: 'plan1' }
          : (table === 'scheduled_services' ? { id: 's1', customer_id: 'c1' } : null)),
      };
      return chain;
    };
    await expect(verifyExtendedCompletionAnchor({
      dbConn: planConn, lockedCustomer: member, lockedSvc: visit, lockedInvoice: invoiceAt(90.55),
    })).resolves.toEqual({ ok: false, reason: 'active_payment_plan' });
  });
  test('an invoice rebound to another visit refuses under the lock (invoice_unbound)', async () => {
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false), lockedCustomer: member, lockedSvc: visit,
      lockedInvoice: { subtotal: 90.55, total: 90.55, discount_amount: 0, scheduled_service_id: 'OTHER' },
    })).resolves.toEqual({ ok: false, reason: 'invoice_unbound' });
  });
  test('a visit that is no longer completed refuses under the lock (cancel/reschedule race)', async () => {
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false), lockedCustomer: member, lockedSvc: { ...visit, status: 'cancelled' }, lockedInvoice: invoiceAt(90.55),
    })).resolves.toEqual({ ok: false, reason: 'visit_not_completed' });
  });
  test('an UNVERIFIABLE annual-coverage authority refuses the charge (never reads as stale)', async () => {
    const throwingConn = () => { throw new Error('db unavailable'); };
    await expect(verifyExtendedCompletionAnchor({
      dbConn: throwingConn,
      lockedCustomer: member,
      lockedSvc: { ...visit, prepaid_method: 'annual_prepay_invoice' },
      lockedInvoice: invoiceAt(90.55),
    })).resolves.toEqual({ ok: false, reason: 'annual_prepay_coverage_unverifiable' });
  });
  test('dues coverage refuses a recurring unpriced member visit (autopay active in-lock by definition)', async () => {
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false),
      lockedCustomer: member,
      lockedSvc: { ...visit, is_recurring: true, estimated_price: null },
      lockedInvoice: invoiceAt(33.33),
    })).resolves.toEqual({ ok: false, reason: 'dues_covered' });
  });
  test('unpriced legacy (null-mode, tier-less) rate customer anchors at the monthly rate; unpriced per_visit has no anchor', async () => {
    // An unpriced MEMBER visit is dues-covered (refuses above); the
    // monthly-rate anchor serves the legacy null-mode customer whose tier
    // is not a membership tier — dues coverage never applies, and the
    // completion mint bills exactly this rate.
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false),
      lockedCustomer: { id: 'c1', billing_mode: null, monthly_rate: 33.33, waveguard_tier: null },
      lockedSvc: { ...visit, estimated_price: null },
      lockedInvoice: invoiceAt(33.33),
    })).resolves.toEqual({ ok: true, anchor: 33.33 });
    await expect(verifyExtendedCompletionAnchor({
      dbConn: duesConn(false),
      lockedCustomer: { ...member, billing_mode: 'per_visit' },
      lockedSvc: { ...visit, estimated_price: null },
      lockedInvoice: invoiceAt(33.33),
    })).resolves.toEqual({ ok: false, reason: 'anchor_exceeded' });
  });
});

describe('attachedInvoiceAutoChargeLikely (sheet-side sync approximation)', () => {
  const { attachedInvoiceAutoChargeLikely } = require('../services/billing-lane');
  const base = {
    invoice: { subtotal: 90.55, total: 96.98, discount_amount: 0 },
    autopayActive: true,
    duesCollectedThisMonth: false,
    estimatedPrice: 90.55,
    isRecurring: false,
    isCallback: false,
    serviceType: 'Quarterly Pest Control Service',
    waveguardTier: 'Silver',
    monthlyRate: 33.33,
    billingMode: 'monthly_membership',
  };
  test('a priced one-off member invoice at the visit price is likely', () => {
    expect(attachedInvoiceAutoChargeLikely(base)).toBe(true);
  });
  test('no-cost visits, dues coverage, missing anchor, and over-cap all demote', () => {
    expect(attachedInvoiceAutoChargeLikely({ ...base, isCallback: true })).toBe(false);
    expect(attachedInvoiceAutoChargeLikely({ ...base, serviceType: 'Pest Control Re-Service' })).toBe(false);
    expect(attachedInvoiceAutoChargeLikely({ ...base, isRecurring: true, estimatedPrice: null, invoice: { subtotal: 33.33, total: 33.33 } })).toBe(false);
    expect(attachedInvoiceAutoChargeLikely({ ...base, billingMode: 'per_visit', estimatedPrice: null })).toBe(false);
    expect(attachedInvoiceAutoChargeLikely({ ...base, invoice: { subtotal: 150, total: 160, discount_amount: 0 } })).toBe(false);
  });
  test('a stamped annual visit demotes unless the stamp was VALIDATED stale', () => {
    expect(attachedInvoiceAutoChargeLikely({ ...base, prepaidMethod: 'annual_prepay_invoice' })).toBe(false);
    expect(attachedInvoiceAutoChargeLikely({ ...base, prepaidMethod: 'annual_prepay_invoice', annualCoverageValidated: true })).toBe(false);
    expect(attachedInvoiceAutoChargeLikely({ ...base, prepaidMethod: 'annual_prepay_invoice', annualCoverageValidated: false })).toBe(true);
  });
  test('an UNAPPLIED out-of-band prepayment demotes; the netted residual stays a promise', () => {
    expect(attachedInvoiceAutoChargeLikely({ ...base, prepaidMethod: 'cash', prepaidAmount: 50 })).toBe(false);
    expect(attachedInvoiceAutoChargeLikely({ ...base, prepaidMethod: null, prepaidAmount: 50 })).toBe(false);
    expect(attachedInvoiceAutoChargeLikely({ ...base, prepaidMethod: 'cash', prepaidAmount: 50, prepaidApplied: true })).toBe(true);
  });
  test('per-application attached invoices promise the charge ONLY within the accepted cap (setup-fee line extends it)', () => {
    expect(attachedInvoiceAutoChargeLikely({ ...base, billingMode: 'per_application' })).toBe(true);
    // over-cap → review at completion, never promised
    expect(attachedInvoiceAutoChargeLikely({
      ...base, billingMode: 'per_application', invoice: { subtotal: 150, total: 150, discount_amount: 0 },
    })).toBe(false);
    // setup-fee line extends the cap by the line amount
    expect(attachedInvoiceAutoChargeLikely({
      ...base,
      billingMode: 'per_application',
      invoice: {
        subtotal: 189.55, total: 189.55, discount_amount: 0,
        line_items: JSON.stringify([{ description: 'One-Time Setup Fee', amount: 99 }]),
      },
    })).toBe(true);
    // no anchor at all → never promised
    expect(attachedInvoiceAutoChargeLikely({
      ...base, billingMode: 'per_application', estimatedPrice: null, perApplicationFee: null,
    })).toBe(false);
  });
});

// Parallel review P2s on #5256: the gate reaches the in-lock extended
// anchor, the sheet's membership/self-pay auto-charge promise, and the
// annual-prepay label. Off stays exactly as before.
describe('GATE_STAMPED_ZERO_FREE — in-lock anchor, sheet promise, annual-prepay label', () => {
  const {
    verifyExtendedCompletionAnchor, attachedInvoiceAutoChargeLikely, predictCompletionBilling,
  } = require('../services/billing-lane');
  afterEach(() => { delete process.env.GATE_STAMPED_ZERO_FREE; });
  const noDuesConn = () => {
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNotIn', 'whereRaw', 'orWhere', 'andWhereRaw', 'andWhere']) chain[m] = () => chain;
    chain.first = async () => null;
    return () => chain;
  };
  const legacyLane = { id: 'c1', billing_mode: null, monthly_rate: 33.33, waveguard_tier: null };
  const zeroVisit = { id: 's1', customer_id: 'c1', status: 'completed', is_recurring: false, estimated_price: 0, is_callback: false, prepaid_method: null };
  const invoice30 = { subtotal: 30, total: 30, discount_amount: 0, scheduled_service_id: 's1' };

  test('in-lock extended anchor: a stamped $0 refuses with the gate on', async () => {
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    await expect(verifyExtendedCompletionAnchor({
      dbConn: noDuesConn(), lockedCustomer: legacyLane, lockedSvc: zeroVisit, lockedInvoice: invoice30,
    })).resolves.toEqual({ ok: false, reason: 'anchor_exceeded' });
  });

  test('sheet promise: a stamped $0 on a legacy lane with a monthly rate never promises auto-charge with the gate on', () => {
    const args = {
      invoice: { subtotal: 30, total: 30, discount_amount: 0 },
      autopayActive: true,
      estimatedPrice: 0,
      primaryLinePrice: null,
      isRecurring: false,
      isCallback: false,
      serviceType: 'Pest Control',
      billingMode: null,
      monthlyRate: 33.33,
      waveguardTier: null,
      duesCollectedThisMonth: false,
    };
    const off = attachedInvoiceAutoChargeLikely(args);
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    expect(attachedInvoiceAutoChargeLikely(args)).toBe(false);
    delete process.env.GATE_STAMPED_ZERO_FREE;
    expect(attachedInvoiceAutoChargeLikely(args)).toBe(off);
  });

  test('annual-prepay lane: an uncovered stamped $0 reads as free, not "prepaid", with the gate on', () => {
    const args = {
      lane: 'annual_prepay', billingMode: 'annual_prepay', autopayActive: true,
      estimatedPrice: 0, primaryLinePrice: null, monthlyRate: 33.33, perApplicationFee: null,
      isRecurring: false, isCallback: false, prepaidMethod: null, prepaidAmount: 0,
    };
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    expect(predictCompletionBilling(args)).toMatchObject({ kind: 'no_charge', amount: 0, reason: 'fully_discounted' });
    delete process.env.GATE_STAMPED_ZERO_FREE;
    expect(predictCompletionBilling(args).kind).not.toBe('prepaid');
  });
});
