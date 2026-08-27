const {
  BILLING_MODES,
  resolveBillingLane,
  impliedMonthlyStampForWrite,
  membershipDuesCoverVisit,
  predictCompletionBilling,
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
      .toEqual({ kind: 'covered_membership', amount: null, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...memberBase, autopayActive: false, duesCollectedThisMonth: false }))
      .toEqual({ kind: 'invoice', amount: 33.33, conflictStampedPrice: false });
  });

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

  test('per-visit lane: a PRICED callback or always-free visit predicts no charge — the completion gate will not bill it (Codex r7)', () => {
    const perVisit = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: null };
    expect(predictCompletionBilling({ ...perVisit, estimatedPrice: 129, isCallback: true }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perVisit, estimatedPrice: 129, serviceType: 'Pest Control Re-Service' }))
      .toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
    expect(predictCompletionBilling({
      ...perVisit, billingMode: 'one_time', lane: 'one_time', estimatedPrice: 129, isCallback: true,
    })).toEqual({ kind: 'no_charge', amount: 0, conflictStampedPrice: false });
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
      .toEqual({ kind: 'invoice', amount: 100, conflictStampedPrice: false });
    // Out-of-band prepay (cash/Zelle) still covers by amount.
    expect(predictCompletionBilling({ ...staleStamp, prepaidMethod: 'cash' }))
      .toEqual({ kind: 'prepaid', amount: 500, conflictStampedPrice: false });
  });

  test('inferred membership (NULL mode, tier+rate) predicts coverage like the completion path', () => {
    expect(predictCompletionBilling({ ...memberBase, billingMode: null, estimatedPrice: 100 }))
      .toEqual({ kind: 'covered_membership', amount: null, conflictStampedPrice: true });
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
    })).toEqual({ kind: 'auto_charge', amount: 90.55, conflictStampedPrice: false });
  });
  test('gate off keeps the historical invoice prediction byte-identical', () => {
    expect(predictCompletionBilling({ ...memberBase, isRecurring: false, estimatedPrice: 90.55 }))
      .toEqual({ kind: 'invoice', amount: 90.55, conflictStampedPrice: false });
  });
  test('autopay inactive keeps invoice even with the gate on', () => {
    expect(predictCompletionBilling({
      ...memberBase, autopayActive: false, isRecurring: false, estimatedPrice: 90.55, completionAutopayChargeEnabled: true,
    }).kind).toBe('invoice');
  });
  test('annual-prepay uncovered priced add-on predicts auto_charge under the gate', () => {
    expect(predictCompletionBilling({
      ...memberBase, lane: 'annual_prepay', billingMode: 'annual_prepay', estimatedPrice: 150, completionAutopayChargeEnabled: true,
    })).toEqual({ kind: 'auto_charge', amount: 150, conflictStampedPrice: false });
  });
  test('per-visit lane priced invoice predicts auto_charge under the gate; partial prepay still nets', () => {
    const perVisit = { ...memberBase, lane: 'per_visit', billingMode: 'per_visit', monthlyRate: null, estimatedPrice: 100, completionAutopayChargeEnabled: true };
    expect(predictCompletionBilling(perVisit))
      .toEqual({ kind: 'auto_charge', amount: 100, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perVisit, prepaidAmount: 50 }))
      .toEqual({ kind: 'auto_charge', amount: 50, conflictStampedPrice: false });
    expect(predictCompletionBilling({ ...perVisit, prepaidAmount: 120 }).kind).toBe('prepaid');
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
      whereRaw() { return chain; },
      orWhere() { return chain; },
      andWhereRaw() { return chain; },
      andWhere() { return chain; },
      // scheduled_services = the verdict's full-row re-read for annual
      // coverage validation; payments = the dues-collected probe.
      first: async () => (table === 'scheduled_services'
        ? { id: 's1', customer_id: 'c1' }
        : (collected ? { id: 'p1' } : null)),
    };
    return chain;
  };
  const member = { id: 'c1', billing_mode: 'monthly_membership', monthly_rate: 33.33, waveguard_tier: 'Silver' };
  const visit = { id: 's1', customer_id: 'c1', status: 'completed', is_recurring: false, estimated_price: 90.55, is_callback: false, prepaid_method: null };
  const invoiceAt = (subtotal) => ({ subtotal, total: subtotal, discount_amount: 0 });

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
