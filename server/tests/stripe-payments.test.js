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
 *   - computeChargeAmount / isCardMethodType: 3.99% surcharge math.
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
const { computeChargeAmount, isCardMethodType, CARD_SURCHARGE_RATE } = require('../services/stripe-pricing');
const { isBillingDayMatch } = require('../services/billing-helpers');
const {
  INVOICE_UPDATE_ALLOWED_FIELDS,
  assertInvoiceVoidable,
} = require('../services/invoice-helpers');

describe('stripe computeChargeAmount', () => {
  test('ACH (us_bank_account) pays the quoted amount with no surcharge', () => {
    const r = computeChargeAmount(100, 'us_bank_account');
    expect(r).toEqual({ base: 100, surcharge: 0, total: 100 });
  });

  test('ach alias also bypasses surcharge', () => {
    expect(computeChargeAmount(100, 'ach')).toEqual({ base: 100, surcharge: 0, total: 100 });
    expect(computeChargeAmount(100, 'bank')).toEqual({ base: 100, surcharge: 0, total: 100 });
    expect(computeChargeAmount(100, 'bank_account')).toEqual({ base: 100, surcharge: 0, total: 100 });
  });

  test('card adds 3.99% rounded to cents', () => {
    const r = computeChargeAmount(100, 'card');
    // 100 * 0.0399 = 3.99 exactly
    expect(r).toEqual({ base: 100, surcharge: 3.99, total: 103.99 });
  });

  test('apple_pay / google_pay / link are card-family (surcharged)', () => {
    for (const m of ['apple_pay', 'google_pay', 'link']) {
      const r = computeChargeAmount(100, m);
      expect(r.surcharge).toBeCloseTo(3.99, 2);
      expect(r.total).toBeCloseTo(103.99, 2);
    }
  });

  test('rounding is two-step: round(base × rate) added to base', () => {
    // 33.33 × 0.0399 = 1.329867 → round to 1.33 → 33.33 + 1.33 = 34.66
    const r = computeChargeAmount(33.33, 'card');
    expect(r).toEqual({ base: 33.33, surcharge: 1.33, total: 34.66 });
  });

  test('null / unknown method types default to card-family (fail closed)', () => {
    // Defaulting to "no surcharge" on an unknown method would silently
    // lose 3.99% on every Klarna / Cash App / Affirm transaction Stripe
    // ever ships into automatic_payment_methods. Default the other way.
    expect(isCardMethodType(null)).toBe(false); // null returns early
    expect(isCardMethodType('cashapp')).toBe(true);
    expect(isCardMethodType('klarna')).toBe(true);
    expect(isCardMethodType('affirm')).toBe(true);
  });

  test('CARD_SURCHARGE_RATE is the canonical 3.99% the consent text references', () => {
    // The "save card" consent copy embeds "3.99% processing fee" verbatim
    // (server/services/payment-method-consent-text.js). If that constant
    // ever moves, the consent_text_version MUST bump in lockstep.
    expect(CARD_SURCHARGE_RATE).toBeCloseTo(0.0399, 4);
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
