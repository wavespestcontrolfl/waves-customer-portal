/**
 * Stripe payment-path audit tests — pure-function regression coverage
 * for the highest-blast-radius helpers exposed by the audit pass.
 *
 * No DB, no Stripe network calls. The audit fixes that need DB or HTTP
 * coverage (webhook idempotency claim, PI-to-invoice metadata bind,
 * `payment_method` derivation for ACH) live in route-level integration
 * tests; this file pins the pure invariants that those flows depend on.
 *
 * Scope:
 *   - computeChargeAmount / isCardMethodType: 2.9% surcharge math.
 *     A regression here either over-collects (silent customer
 *     complaint) or under-collects (lost margin on every card-family
 *     transaction).
 *   - isBillingDayMatch: encodes the daily-cron contract that fixes
 *     "billing_day != 1 → never billed". A regression silently stops
 *     charging a slice of the customer base.
 *   - INVOICE_UPDATE_ALLOWED_FIELDS: ensures `status` never re-enters
 *     the allowlist (mark-paid bypass via PUT /admin/invoices/:id).
 *   - assertInvoiceVoidable: paid / processing invoices stay non-
 *     voidable so we can't accidentally erase revenue.
 */

// Helpers under test are pure — no DB, no Stripe SDK, no Twilio. Each
// lives in its own *-helpers / *-pricing module to keep the test
// runtime fast and free of side-effect imports.
const { computeChargeAmount, isCardMethodType, CARD_SURCHARGE_RATE, shouldSurcharge, computeRefundSurcharge, buildSurchargeAmountDetails, SURCHARGE_POLICY_VERSION } = require('../services/stripe-pricing');
const { isBillingDayMatch } = require('../services/billing-helpers');
const {
  INVOICE_UPDATE_ALLOWED_FIELDS,
  INVOICE_UNCOLLECTIBLE_STATUSES,
  assertInvoiceCollectible,
  assertInvoiceVoidable,
  isInvoiceCollectibleStatus,
} = require('../services/invoice-helpers');
const {
  classifyExistingWebhookEvent,
  STALE_CLAIM_WINDOW_MS,
} = require('../routes/stripe-webhook-helpers');
const {
  assertInvoicePaymentIntentTenderMatches,
  invoicePaymentStatusForIntent,
  isTerminalInvoicePaymentIntent,
  nextInvoiceStatusAfterFailedPayment,
} = require('../services/stripe-invoice-state');

describe('stripe computeChargeAmount', () => {
  test('ACH (us_bank_account) pays the quoted amount with no surcharge', () => {
    const r = computeChargeAmount(100, 'us_bank_account');
    expect(r.surcharge).toBe(0);
    expect(r.total).toBe(100);
    expect(r.surchargeCents).toBe(0);
    expect(r.totalCents).toBe(10000);
  });

  test('ach alias also bypasses surcharge', () => {
    for (const m of ['ach', 'bank', 'bank_account']) {
      const r = computeChargeAmount(100, m);
      expect(r.surcharge).toBe(0);
      expect(r.total).toBe(100);
    }
  });

  test('card with funding=credit adds 2.9% (floor-rounded)', () => {
    const r = computeChargeAmount(100, 'card', { funding: 'credit' });
    expect(r.surchargeCents).toBe(290);
    expect(r.totalCents).toBe(10290);
    expect(r.surcharge).toBe(2.9);
    expect(r.total).toBe(102.9);
    expect(r.rateBps).toBe(290);
    expect(r.policyVersion).toBe(SURCHARGE_POLICY_VERSION);
  });

  test('card with funding=debit → no surcharge', () => {
    const r = computeChargeAmount(100, 'card', { funding: 'debit' });
    expect(r.surchargeCents).toBe(0);
    expect(r.total).toBe(100);
  });

  test('card with funding=prepaid → no surcharge', () => {
    const r = computeChargeAmount(100, 'card', { funding: 'prepaid' });
    expect(r.surchargeCents).toBe(0);
    expect(r.total).toBe(100);
  });

  test('card with funding=null (unknown) → no surcharge', () => {
    const r = computeChargeAmount(100, 'card', { funding: null });
    expect(r.surchargeCents).toBe(0);
    expect(r.total).toBe(100);
  });

  test('card with no funding option → no surcharge (safe default)', () => {
    const r = computeChargeAmount(100, 'card');
    expect(r.surchargeCents).toBe(0);
    expect(r.total).toBe(100);
  });

  test('floor rounding never exceeds 2.9% cap', () => {
    const r = computeChargeAmount(33.33, 'card', { funding: 'credit' });
    expect(r.surchargeCents).toBe(96);
    expect(r.totalCents).toBe(3429);
    expect(r.surchargeCents / r.baseCents).toBeLessThanOrEqual(0.029);
  });

  test('stripeMaxCents caps the surcharge', () => {
    const r = computeChargeAmount(1000, 'card', { funding: 'credit', stripeMaxCents: 20 });
    expect(r.surchargeCents).toBe(20);
    expect(r.totalCents).toBe(100020);
  });

  test('apple_pay / google_pay / link need funding=credit to surcharge', () => {
    for (const m of ['apple_pay', 'google_pay', 'link']) {
      expect(computeChargeAmount(100, m).surchargeCents).toBe(0);
      expect(computeChargeAmount(100, m, { funding: 'credit' }).surchargeCents).toBe(290);
    }
  });

  test('null / unknown method types: isCardMethodType behavior', () => {
    expect(isCardMethodType(null)).toBe(false);
    expect(isCardMethodType('cashapp')).toBe(true);
    expect(isCardMethodType('klarna')).toBe(true);
  });

  test('CARD_SURCHARGE_RATE is 2.9% (legacy compat)', () => {
    expect(CARD_SURCHARGE_RATE).toBeCloseTo(0.029, 4);
  });
});

describe('shouldSurcharge', () => {
  test('only credit cards get surcharged', () => {
    expect(shouldSurcharge('card', 'credit')).toBe(true);
    expect(shouldSurcharge('card', 'debit')).toBe(false);
    expect(shouldSurcharge('card', 'prepaid')).toBe(false);
    expect(shouldSurcharge('card', null)).toBe(false);
    expect(shouldSurcharge('card', undefined)).toBe(false);
    expect(shouldSurcharge('us_bank_account', 'credit')).toBe(false);
    expect(shouldSurcharge('ach', 'credit')).toBe(false);
  });
});

describe('buildSurchargeAmountDetails', () => {
  test('uses Stripe preview enum enforce_validation for positive surcharges', () => {
    expect(buildSurchargeAmountDetails(300)).toEqual({
      surcharge: {
        amount: 300,
        enforce_validation: 'enabled',
      },
    });
  });

  test('omits amount_details when no surcharge applies', () => {
    expect(buildSurchargeAmountDetails(0)).toBeNull();
    expect(buildSurchargeAmountDetails(null)).toBeNull();
  });
});

describe('computeRefundSurcharge', () => {
  test('full refund returns all surcharge', () => {
    expect(computeRefundSurcharge({
      refundBaseCents: 10000, originalBaseCents: 10000,
      originalSurchargeCents: 300, totalRefundedBaseCents: 0, alreadyRefundedSurchargeCents: 0,
    })).toBe(300);
  });

  test('partial refund prorates surcharge', () => {
    expect(computeRefundSurcharge({
      refundBaseCents: 5000, originalBaseCents: 10000,
      originalSurchargeCents: 300, totalRefundedBaseCents: 0, alreadyRefundedSurchargeCents: 0,
    })).toBe(150);
  });

  test('cumulative partial refunds do not over-refund', () => {
    const first = computeRefundSurcharge({
      refundBaseCents: 5000, originalBaseCents: 10000,
      originalSurchargeCents: 300, totalRefundedBaseCents: 0, alreadyRefundedSurchargeCents: 0,
    });
    const second = computeRefundSurcharge({
      refundBaseCents: 5000, originalBaseCents: 10000,
      originalSurchargeCents: 300, totalRefundedBaseCents: 5000, alreadyRefundedSurchargeCents: first,
    });
    expect(first + second).toBe(300);
  });

  test('no surcharge to refund → 0', () => {
    expect(computeRefundSurcharge({
      refundBaseCents: 5000, originalBaseCents: 10000, originalSurchargeCents: 0,
    })).toBe(0);
  });
});

describe('billing-cron isBillingDayMatch', () => {
  test('billing_day matches today → true', () => {
    expect(isBillingDayMatch(15, 15)).toBe(true);
  });

  test('billing_day mismatches today → false (the daily-cron skip path)', () => {
    expect(isBillingDayMatch(15, 1)).toBe(false);
    expect(isBillingDayMatch(28, 27)).toBe(false);
  });

  test('NULL billing_day defaults to 1 — legacy rows keep 1st-of-month cadence', () => {
    expect(isBillingDayMatch(null, 1)).toBe(true);
    expect(isBillingDayMatch(undefined, 1)).toBe(true);
    expect(isBillingDayMatch(null, 2)).toBe(false);
  });

  test('billing_day=0 also defaults to 1 (defensive — DB enum is 1–28)', () => {
    expect(isBillingDayMatch(0, 1)).toBe(true);
  });
});

describe('invoice INVOICE_UPDATE_ALLOWED_FIELDS', () => {
  test('status is NOT in the allowlist (mark-paid bypass guard)', () => {
    expect(INVOICE_UPDATE_ALLOWED_FIELDS).not.toContain('status');
  });

  test('financial state columns are also locked down', () => {
    // total / paid_at / processor / stripe_payment_intent_id are written
    // by the payment flow only — admins MUST go through the explicit
    // route handlers for state transitions.
    for (const forbidden of ['total', 'paid_at', 'processor', 'stripe_payment_intent_id', 'stripe_charge_id', 'subtotal', 'discount_amount', 'tax_amount']) {
      expect(INVOICE_UPDATE_ALLOWED_FIELDS).not.toContain(forbidden);
    }
  });

  test('the editable shape is exactly what the admin UI exposes', () => {
    // Admin invoice detail UI exposes title / notes / due date /
    // line items / tax rate. Anything else is a regression.
    expect([...INVOICE_UPDATE_ALLOWED_FIELDS].sort()).toEqual(
      ['due_date', 'line_items', 'notes', 'tax_rate', 'title'],
    );
  });

  test('allowlist is frozen — accidental mutation throws in strict mode', () => {
    expect(Object.isFrozen(INVOICE_UPDATE_ALLOWED_FIELDS)).toBe(true);
  });
});

describe('stripe-webhook classifyExistingWebhookEvent', () => {
  // The atomic claim path inserts ON CONFLICT DO NOTHING. When the claim
  // loses, the route reads the existing row and routes by classification:
  //   processed=true                → duplicate (200, skip handler)
  //   processed=false, error=set    → reclaim  (try to re-run handler)
  //   processed=false, error=null   → inflight (503, ask Stripe to retry)
  //
  // The "reclaim" branch fixes the bug Codex flagged on PR #490: without
  // it, a single transient handler failure leaves the row stuck at
  // processed=false forever and every subsequent Stripe retry returns
  // 503, so payment_intent.succeeded events stay permanently unapplied.

  test('processed row → duplicate (handler must NOT re-run)', () => {
    expect(classifyExistingWebhookEvent({ processed: true, error: null })).toBe('duplicate');
    expect(classifyExistingWebhookEvent({ processed: true, error: 'old' })).toBe('duplicate');
  });

  test('failed previous attempt → reclaim (handler MUST re-run)', () => {
    expect(classifyExistingWebhookEvent({ processed: false, error: 'db blip' })).toBe('reclaim');
  });

  test('truly in-flight (no error yet) → inflight (503, retry later)', () => {
    expect(classifyExistingWebhookEvent({ processed: false, error: null })).toBe('inflight');
  });

  test('missing row defaults to inflight (fail closed, never double-run)', () => {
    expect(classifyExistingWebhookEvent(null)).toBe('inflight');
    expect(classifyExistingWebhookEvent(undefined)).toBe('inflight');
  });

  test('empty-string error is NOT a failure marker (treat as in-flight)', () => {
    // Defensive — guard against a NULL/empty mismatch from a future
    // migration. Only a non-empty error value should trigger reclaim,
    // otherwise we could re-run handlers that haven't actually failed.
    const fresh = new Date().toISOString();
    expect(classifyExistingWebhookEvent({ processed: false, error: '', received_at: fresh })).toBe('inflight');
  });

  // Stale-claim recovery — addresses Codex P1 follow-up: a worker that
  // crashes between claim and (processed=true | error=set) leaves the
  // row stuck at processed=false / error=null. Using received_at as
  // the lease timestamp lets the next Stripe retry past the stale
  // window re-claim cleanly.

  test('STALE_CLAIM_WINDOW_MS is exported and reasonable (1–60 minutes)', () => {
    expect(STALE_CLAIM_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
    expect(STALE_CLAIM_WINDOW_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  test('processed=false / error=null / received_at within window → inflight', () => {
    const now = Date.now();
    const fresh = new Date(now - 30_000).toISOString(); // 30s ago
    expect(
      classifyExistingWebhookEvent({ processed: false, error: null, received_at: fresh }, { now }),
    ).toBe('inflight');
  });

  test('processed=false / error=null / received_at older than window → reclaim (stale)', () => {
    const now = Date.now();
    const stale = new Date(now - (STALE_CLAIM_WINDOW_MS + 60_000)).toISOString();
    expect(
      classifyExistingWebhookEvent({ processed: false, error: null, received_at: stale }, { now }),
    ).toBe('reclaim');
  });

  test('exactly at the stale boundary stays inflight (strict >, not ≥)', () => {
    const now = Date.now();
    const boundary = new Date(now - STALE_CLAIM_WINDOW_MS).toISOString();
    expect(
      classifyExistingWebhookEvent({ processed: false, error: null, received_at: boundary }, { now }),
    ).toBe('inflight');
  });

  test('error trumps stale check — error path is the authoritative reclaim signal', () => {
    const now = Date.now();
    const fresh = new Date(now - 1000).toISOString();
    // A handler that wrote `error` 1 second ago is still a reclaim
    // candidate — we don't gate the failed-attempt path on the lease.
    expect(
      classifyExistingWebhookEvent({ processed: false, error: 'db blip', received_at: fresh }, { now }),
    ).toBe('reclaim');
  });

  test('staleWindowMs override lets callers tune the lease for tests', () => {
    const now = Date.now();
    const tenSecondsAgo = new Date(now - 10_000).toISOString();
    expect(
      classifyExistingWebhookEvent(
        { processed: false, error: null, received_at: tenSecondsAgo },
        { now, staleWindowMs: 5_000 },
      ),
    ).toBe('reclaim');
  });

  test('missing received_at falls back to inflight (can\'t prove staleness)', () => {
    const now = Date.now();
    expect(
      classifyExistingWebhookEvent({ processed: false, error: null, received_at: null }, { now }),
    ).toBe('inflight');
  });
});

describe('invoice assertInvoiceVoidable', () => {
  test('paid invoice — refuse to void (must refund instead)', () => {
    expect(() => assertInvoiceVoidable('paid')).toThrow(/refund/);
  });

  test('processing invoice (ACH in flight) — refuse to void', () => {
    expect(() => assertInvoiceVoidable('processing')).toThrow(/in flight/);
  });

  test('draft / sent / viewed / overdue / void — voidable (no throw)', () => {
    for (const s of ['draft', 'sent', 'viewed', 'overdue', 'void']) {
      expect(() => assertInvoiceVoidable(s)).not.toThrow();
    }
  });
});

describe('invoice assertInvoiceCollectible', () => {
  test('paid / processing / void / refunded / canceled cannot be collected', () => {
    expect([...INVOICE_UNCOLLECTIBLE_STATUSES]).toEqual(
      ['paid', 'processing', 'void', 'refunded', 'canceled', 'cancelled'],
    );
    for (const s of INVOICE_UNCOLLECTIBLE_STATUSES) {
      expect(isInvoiceCollectibleStatus(s)).toBe(false);
      expect(() => assertInvoiceCollectible(s)).toThrow(/paid|processing|void|refunded|canceled/);
    }
  });

  test('open invoice statuses remain collectible', () => {
    for (const s of ['draft', 'scheduled', 'sent', 'viewed', 'overdue', 'sending']) {
      expect(isInvoiceCollectibleStatus(s)).toBe(true);
      expect(() => assertInvoiceCollectible(s)).not.toThrow();
    }
  });
});

describe('stripe invoice ACH state helpers', () => {
  test('card-priced invoice PaymentIntent accepts a real card settlement', () => {
    expect(() => assertInvoicePaymentIntentTenderMatches({
      amount: 7500,
      payment_method_types: ['card', 'us_bank_account'],
      metadata: { selected_method_category: 'card', base_amount: '75' },
    }, 'card', 75)).not.toThrow();
  });

  test('card-priced invoice PaymentIntent rejects a real ACH settlement', () => {
    expect(() => assertInvoicePaymentIntentTenderMatches({
      amount_received: 7500,
      payment_method_types: ['card', 'us_bank_account'],
      metadata: { selected_method_category: 'card', base_amount: '75' },
    }, 'us_bank_account', 75)).toThrow(/Payment method changed/);
  });

  test('mixed-method invoice PaymentIntent without selected_method_category — amounts match so no throw', () => {
    // With no surcharge difference between card and ACH, amount-based
    // mismatch detection can't distinguish them. The method-family check
    // only fires when selected_method_category is present.
    expect(() => assertInvoicePaymentIntentTenderMatches({
      amount_received: 7500,
      payment_method_types: ['card', 'us_bank_account'],
      metadata: { base_amount: '75' },
    }, 'us_bank_account', 75)).not.toThrow();
  });

  test('ACH-priced invoice PaymentIntent rejects a real card settlement', () => {
    expect(() => assertInvoicePaymentIntentTenderMatches({
      amount_received: 7500,
      payment_method_types: ['us_bank_account'],
      metadata: { selected_method_category: 'us_bank_account', base_amount: '75' },
    }, 'card', 75)).toThrow(/Payment method changed|Payment amount does not match/);
  });

  test('ACH-priced invoice PaymentIntent accepts a real ACH settlement', () => {
    expect(() => assertInvoicePaymentIntentTenderMatches({
      amount_received: 7500,
      payment_method_types: ['us_bank_account'],
      metadata: { selected_method_category: 'us_bank_account', base_amount: '75' },
    }, 'us_bank_account', 75)).not.toThrow();
  });

  test('stale PaymentIntent metadata cannot settle after invoice retotal', () => {
    expect(() => assertInvoicePaymentIntentTenderMatches({
      amount_received: 7500,
      payment_method_types: ['us_bank_account'],
      metadata: { selected_method_category: 'us_bank_account', base_amount: '75', card_surcharge: '0' },
    }, 'us_bank_account', 80)).toThrow(/Payment amount does not match/);
  });

  test('current invoice total still allows finalized credit-card surcharge metadata', () => {
    expect(() => assertInvoicePaymentIntentTenderMatches({
      amount_received: 10300,
      payment_method_types: ['card'],
      metadata: { selected_method_category: 'card', base_amount: '100', card_surcharge: '3' },
    }, 'card', 100)).not.toThrow();
  });

  test('Tap to Pay invoice PaymentIntents are identified as terminal-priced', () => {
    expect(isTerminalInvoicePaymentIntent({
      amount_received: 7500,
      payment_method_types: ['card_present'],
      metadata: { source: 'tap_to_pay' },
    }, 'card_present')).toBe(true);

    expect(isTerminalInvoicePaymentIntent({
      amount_received: 7500,
      payment_method_types: ['card', 'us_bank_account'],
      metadata: { selected_method_category: 'card' },
    }, 'card')).toBe(false);
  });

  test('ACH processing PaymentIntent maps to processing, not an error', () => {
    expect(invoicePaymentStatusForIntent({
      status: 'processing',
      payment_method_types: ['us_bank_account'],
      metadata: { selected_method_category: 'us_bank_account' },
    })).toBe('processing');
  });

  test('card processing PaymentIntent is not accepted as settled', () => {
    expect(() => invoicePaymentStatusForIntent({
      status: 'processing',
      payment_method_types: ['card'],
      metadata: { selected_method_category: 'card' },
    })).toThrow(/expected "succeeded"/);
  });

  test('mixed card/ACH PaymentIntent selected as card is not treated as ACH', () => {
    expect(() => invoicePaymentStatusForIntent({
      status: 'processing',
      payment_method_types: ['card', 'us_bank_account'],
      metadata: { selected_method_category: 'card' },
    }, 'card')).toThrow(/expected "succeeded"/);
  });

  test('succeeded PaymentIntent maps to paid regardless of method', () => {
    expect(invoicePaymentStatusForIntent({
      status: 'succeeded',
      payment_method_types: ['card'],
    })).toBe('paid');
  });

  test('failed ACH resets viewed invoice back to viewed', () => {
    expect(nextInvoiceStatusAfterFailedPayment({
      viewed_at: '2026-05-10T12:00:00Z',
      due_date: '2026-05-20',
    }, new Date('2026-05-10T12:00:00Z'))).toBe('viewed');
  });

  test('failed overdue ACH resets invoice to overdue', () => {
    expect(nextInvoiceStatusAfterFailedPayment({
      viewed_at: '2026-05-01T12:00:00Z',
      due_date: '2026-05-01',
    }, new Date('2026-05-10T12:00:00Z'))).toBe('overdue');
  });

  test('failed ACH compares due date against current ET day', () => {
    expect(nextInvoiceStatusAfterFailedPayment({
      viewed_at: '2026-05-10T12:00:00Z',
      due_date: '2026-05-10',
    }, new Date('2026-05-11T03:30:00Z'))).toBe('viewed');
  });
});
