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
  function fakeDb(paymentsRows, orphanRows = []) {
    return (table) => {
      expect(['payments', 'stripe_orphan_charges']).toContain(table);
      const state = { customerId: null, monthKey: null, resolvedFalse: false, notesLike: null };
      const builder = {
        where(arg, op, val) {
          if (typeof arg === 'function') arg.call(builder);
          else if (arg === 'resolved') state.resolvedFalse = op === false;
          else if (arg === 'resolution_notes') state.notesLike = val;
          else state.customerId = arg.customer_id;
          return builder;
        },
        whereIn() { return builder; },
        whereRaw(sql, bindings) {
          if (sql.includes('billed_month') && bindings) state.monthKey = bindings[0];
          return builder;
        },
        orWhere(arg, op, val) {
          if (typeof arg === 'function') arg.call(builder);
          else if (arg === 'resolution_notes') state.notesLike = val;
          return builder;
        },
        andWhereRaw() { return builder; },
        andWhere() { return builder; },
        async first() {
          if (table === 'stripe_orphan_charges') {
            expect(state.resolvedFalse).toBe(true);
            expect(state.notesLike).toBe('%reconciled%');
            return orphanRows.find((r) => r.customer_id === state.customerId
              && r.metadata?.billed_month === state.monthKey
              && (r.resolved === false || /reconciled/i.test(r.resolution_notes || ''))) || undefined;
          }
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

  // Stripe took the dues but the payments insert failed (orphan ledger only):
  // the customer WAS billed, so the month still counts as collected.
  test('orphaned dues charge (no payments row) counts as collected for its billed month', async () => {
    const visitMonth = new Date('2026-08-19T12:00:00Z');
    const unresolved = [{ id: 'o1', customer_id: 42, resolved: false, metadata: { billed_month: '2026-08' } }];
    await expect(monthlyDuesCollected(fakeDb([], unresolved), 42, visitMonth)).resolves.toBe(true);
    const reconciled = [{ id: 'o2', customer_id: 42, resolved: true, resolution_notes: 'Automatically reconciled by succeeded webhook after local invoice/payment settlement', metadata: { billed_month: '2026-08' } }];
    await expect(monthlyDuesCollected(fakeDb([], reconciled), 42, visitMonth)).resolves.toBe(true);
  });

  test('orphan for a different month, or resolved as failed/refunded, does not count', async () => {
    const visitMonth = new Date('2026-08-19T12:00:00Z');
    const otherMonth = [{ id: 'o3', customer_id: 42, resolved: false, metadata: { billed_month: '2026-07' } }];
    await expect(monthlyDuesCollected(fakeDb([], otherMonth), 42, visitMonth)).resolves.toBe(false);
    const failed = [{ id: 'o4', customer_id: 42, resolved: true, resolution_notes: 'Stripe reported final payment failure; no funds collected', metadata: { billed_month: '2026-08' } }];
    await expect(monthlyDuesCollected(fakeDb([], failed), 42, visitMonth)).resolves.toBe(false);
    const refunded = [{ id: 'o5', customer_id: 42, resolved: true, resolution_notes: 'Automatically resolved: the combined charge was fully refunded (re_x) — the unmatched cash was returned to the customer', metadata: { billed_month: '2026-08' } }];
    await expect(monthlyDuesCollected(fakeDb([], refunded), 42, visitMonth)).resolves.toBe(false);
    // Unstamped legacy orphan: never matches a month.
    const unstamped = [{ id: 'o6', customer_id: 42, resolved: false, metadata: null }];
    await expect(monthlyDuesCollected(fakeDb([], unstamped), 42, visitMonth)).resolves.toBe(false);
  });
});
