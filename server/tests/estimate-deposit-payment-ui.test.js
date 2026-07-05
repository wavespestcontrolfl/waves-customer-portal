/**
 * Deposit payment UI — server-rendered estimate page injection.
 *
 * The accept-flow deposit step (flat $49 recurring / $99 one-time, PR #1660)
 * is driven by the DEPOSIT_POLICY const interpolated into the page script.
 * These tests pin the contract: a required policy ships the amounts and the
 * collection machinery wiring; absent/dark policy ships an inert
 * {enforced:false} object so the page behaves exactly as before the flag.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { renderPage } = require('../routes/estimate-public');

const BASE_EST_DATA = {
  result: {
    recurring: { services: [{ name: 'Pest Control', mo: 95 }] },
    oneTime: { items: [] },
    results: { pestTiers: [{ label: 'Quarterly', mo: 95, pa: 285, apps: 4 }] },
  },
};

function baseEstimate(overrides = {}) {
  return {
    id: 'estimate-deposit-ui',
    status: 'sent',
    customerName: 'Pat Customer',
    address: '123 Main St',
    monthlyTotal: 95,
    annualTotal: 1140,
    onetimeTotal: 0,
    tier: 'Silver',
    ...overrides,
  };
}

describe('server-rendered estimate page deposit injection', () => {
  test('required policy interpolates DEPOSIT_POLICY with both class amounts', () => {
    const html = renderPage('deposit-token', baseEstimate({
      depositPolicy: {
        enforced: true,
        required: true,
        slotRequired: false,
        exemptReason: null,
        recurringAmount: 49,
        oneTimeAmount: 99,
      },
    }), BASE_EST_DATA);

    expect(html).toContain('"enforced":true');
    expect(html).toContain('"required":true');
    expect(html).toContain('"recurringAmount":49');
    expect(html).toContain('"oneTimeAmount":99');
  });

  test('page ships the deposit collection machinery wired into confirmBooking', () => {
    const html = renderPage('deposit-token', baseEstimate({
      depositPolicy: { enforced: true, required: true, slotRequired: false, exemptReason: null, recurringAmount: 49, oneTimeAmount: 99 },
    }), BASE_EST_DATA);

    // Collection runs BEFORE the accept call and gates it.
    expect(html).toContain('const deposit = await collectDepositIfNeeded();');
    // The paid PI rides into accept.
    expect(html).toContain('payload.depositPaymentIntentId = bookingState.depositPaymentIntentId;');
    // The 402 ledger-mismatch fallback clears the cached PI.
    expect(html).toContain("if (r.status === 402 && data.code === 'DEPOSIT_REQUIRED') {");
    // Stripe Elements overlay + intent endpoint.
    expect(html).toContain("'/api/public/estimates/' + TOKEN + '/deposit-intent'");
    expect(html).toContain('deposit-payment-element');
    expect(html).toContain('js.stripe.com/v3/');
    // Customer-visible copy stays flat-amount (no percentage language).
    // Overlay copy is preference-aware: prepay-annual deposits credit the
    // annual invoice, everything else the first invoice.
    expect(html).toContain("deposit holds your spot. It is applied to ' + depositCreditTarget + '.");
    expect(html).toContain("? 'your annual prepay invoice'");
    expect(html).not.toMatch(/25%|percent/i);
    // Review-area note element exists for the due-today line.
    expect(html).toContain('id="deposit-due-note"');
  });

  test('absent policy (dark flag) interpolates an inert DEPOSIT_POLICY', () => {
    const html = renderPage('deposit-token', baseEstimate(), BASE_EST_DATA);
    expect(html).toContain('const DEPOSIT_POLICY = {"enforced":false,"required":false};');
  });

  test('exempt plan-customer policy interpolates required:false (no charge path)', () => {
    const html = renderPage('deposit-token', baseEstimate({
      depositPolicy: {
        enforced: true,
        required: false,
        slotRequired: true,
        exemptReason: 'existing_plan_customer',
        recurringAmount: 49,
        oneTimeAmount: 99,
      },
    }), BASE_EST_DATA);
    expect(html).toContain('"required":false');
    expect(html).toContain('"exemptReason":"existing_plan_customer"');
  });

  test('prepay-annual preference does NOT short-circuit collection client-side (owner decision 2026-07-05)', () => {
    const html = renderPage('deposit-token', baseEstimate({
      depositPolicy: { enforced: true, required: true, slotRequired: false, exemptReason: null, recurringAmount: 49, oneTimeAmount: 99 },
    }), BASE_EST_DATA);
    expect(html).not.toContain("if (bookingState.pickedPref === 'prepay_annual') return { ok: true };");
    // The deposit note stays visible for prepay and names the annual invoice
    // as the credit target.
    expect(html).toContain('your annual prepay invoice');
  });
});
