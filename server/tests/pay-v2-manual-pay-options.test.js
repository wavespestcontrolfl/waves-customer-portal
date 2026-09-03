/**
 * GET /api/pay/:token — off-Stripe "other ways to pay" block (Zelle only —
 * Venmo and PayPal were dropped 2026-09-02 over their fees).
 *
 * Contract:
 *   1. ZELLE_RECIPIENT unset ⇒ NO manualPayOptions key (payload byte-identical
 *      to before the feature — the kill switch is "unset the var").
 *   2. Set ⇒ the block rides only on a COLLECTIBLE invoice; a settled invoice
 *      never advertises somewhere to send money.
 *   3. The helper is pure: trims and returns null when nothing is configured.
 *      Venmo/PayPal env vars are ignored — they must never resurrect a tender.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.raw = (sql) => sql;
  return dbFn;
});
jest.mock('../services/invoice', () => ({ getByToken: jest.fn() }));
jest.mock('../services/invoice-attachments', () => ({ list: jest.fn(async () => []) }));
jest.mock('../services/stripe', () => ({
  isAvailable: () => true,
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: (err) => err?.code === 'STRIPE_CHARGE_IN_PROGRESS' || err?.code === 'STRIPE_CHARGE_RECONCILIATION_REQUIRED',
}));
jest.mock('../config/stripe-config', () => ({ publishableKey: 'pk_test_1' }));
jest.mock('../services/pdf/invoice-pdf', () => ({ generateInvoicePDF: jest.fn() }));
jest.mock('../services/payment-method-consents', () => ({}));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/bill-payment-error-alerts', () => ({ alertBillPaymentError: jest.fn(async () => {}) }));
jest.mock('../services/payer', () => ({
  attachToInvoice: jest.fn(async () => null),
  resolveForInvoice: jest.fn(async () => ({ payerId: null })),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: { autoApplyAccountCredit: false },
}));
jest.mock('../services/open-balance', () => ({
  openBalanceInvoices: jest.fn(async () => []),
  openBalanceSummary: jest.fn(async () => ({ total: 0, count: 0, moreCount: 0, invoices: [] })),
}));
jest.mock('../services/completion-balance-sweep', () => ({
  dunningStoppedInvoiceIds: jest.fn(async () => new Set()),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const payRouter = require('../routes/pay-v2');
const { manualPayOptionsFromEnv } = require('../routes/pay-v2-helpers');

function chain({ first } = {}) {
  const q = {};
  ['where', 'whereIn', 'select', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  return q;
}

function invoiceData(overrides = {}) {
  return {
    id: 'inv-1',
    customer_id: 'cust-1',
    invoice_number: 'WPC-2026-0123',
    status: 'sent',
    token: 'a'.repeat(64),
    subtotal: '150.00',
    discount_amount: '0',
    tax_rate: '0',
    tax_amount: '0',
    total: '150.00',
    credit_applied: 0,
    line_items: [],
    customer: { id: 'cust-1', first_name: 'Pat', last_name: 'Doe' },
    ...overrides,
  };
}

async function getPayPage(data, { customerRow } = {}) {
  InvoiceService.getByToken.mockResolvedValue(data);
  db.mockImplementation((table) => {
    if (table === 'customers') return chain({ first: customerRow || { billing_mode: null, monthly_rate: null } });
    return chain({ first: null });
  });
  const layer = payRouter.stack.find((l) => l.route?.path === '/:token' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { token: data.token } };
  let body = null;
  const res = { json: (payload) => { body = payload; }, status: () => res };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { body };
}

const ENV_KEYS = ['ZELLE_RECIPIENT', 'VENMO_HANDLE', 'PAYPAL_ME_HANDLE']; // legacy keys cleared so a stale Railway var can't leak in
const saved = {};
beforeEach(() => {
  ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
});
afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
});

describe('manualPayOptionsFromEnv', () => {
  test('returns null when nothing is configured (kill switch)', () => {
    expect(manualPayOptionsFromEnv({})).toBeNull();
    expect(manualPayOptionsFromEnv({ ZELLE_RECIPIENT: '   ' })).toBeNull();
  });

  test('trims the Zelle recipient (email or phone)', () => {
    expect(manualPayOptionsFromEnv({ ZELLE_RECIPIENT: ' pay@example.com ' }))
      .toEqual({ zelle: { recipient: 'pay@example.com' } });
    expect(manualPayOptionsFromEnv({ ZELLE_RECIPIENT: '9415551234' }))
      .toEqual({ zelle: { recipient: '9415551234' } });
  });

  test('ignores the retired Venmo / PayPal vars', () => {
    expect(manualPayOptionsFromEnv({ VENMO_HANDLE: '@WavesPest', PAYPAL_ME_HANDLE: 'WavesPest' })).toBeNull();
    expect(manualPayOptionsFromEnv({ ZELLE_RECIPIENT: 'pay@example.com', VENMO_HANDLE: '@WavesPest', PAYPAL_ME_HANDLE: 'WavesPest' }))
      .toEqual({ zelle: { recipient: 'pay@example.com' } });
  });
});

describe('GET /pay/:token manualPayOptions', () => {
  test('env unset ⇒ key absent (not null) on a collectible invoice', async () => {
    const { body } = await getPayPage(invoiceData());
    expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
  });

  test('env set ⇒ block rides on a collectible invoice', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const { body } = await getPayPage(invoiceData({ status: 'overdue' }));
    expect(body.manualPayOptions).toEqual({
      zelle: { recipient: 'pay@example.com' },
      amountDue: 150,
      version: null,
    });
  });

  test('env set ⇒ key absent while a saved-card attempt is in flight (codex r5 P1 cross-rail fence)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const StripeService = require('../services/stripe');
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValueOnce(
      Object.assign(new Error('charge in progress'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }),
    );
    const { body } = await getPayPage(invoiceData({ status: 'overdue' }));
    expect(body).not.toHaveProperty('manualPayOptions');
    expect(StripeService.assertNoInvoiceChargeReconciliationPending).toHaveBeenCalledWith('inv-1');
  });

  test('env set ⇒ key absent when the attached PaymentIntent already collected (codex r6 P1)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const StripeService = require('../services/stripe');
    for (const status of ['succeeded', 'processing', 'requires_capture']) {
      StripeService.retrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_live', status });
      const { body } = await getPayPage(invoiceData({ status: 'overdue', stripe_payment_intent_id: 'pi_live' }));
      expect(body).not.toHaveProperty('manualPayOptions');
    }
    // Any intent the customer has already advanced is an active attempt too
    // (pre-push P0): 3DS pending, method attached awaiting confirm, ACH
    // micro-deposit verification.
    for (const pi of [
      { id: 'pi_live', status: 'requires_action', next_action: { type: 'use_stripe_sdk' } },
      { id: 'pi_live', status: 'requires_confirmation', payment_method: 'pm_1' },
      { id: 'pi_live', status: 'requires_action', next_action: { type: 'verify_with_microdeposits' } },
    ]) {
      StripeService.retrievePaymentIntent.mockResolvedValueOnce(pi);
      const { body } = await getPayPage(invoiceData({ status: 'overdue', stripe_payment_intent_id: 'pi_live' }));
      expect(body).not.toHaveProperty('manualPayOptions');
    }
    // Inspect-only: the GET never cancels the page's own intent.
    expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  test('env set ⇒ key absent when the attached PaymentIntent cannot be verified (fail closed)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const StripeService = require('../services/stripe');
    StripeService.retrievePaymentIntent.mockResolvedValueOnce(null);
    let r = await getPayPage(invoiceData({ status: 'overdue', stripe_payment_intent_id: 'pi_x' }));
    expect(r.body).not.toHaveProperty('manualPayOptions');
    StripeService.retrievePaymentIntent.mockRejectedValueOnce(new Error('stripe down'));
    r = await getPayPage(invoiceData({ status: 'overdue', stripe_payment_intent_id: 'pi_x' }));
    expect(r.body).not.toHaveProperty('manualPayOptions');
  });

  test('env set ⇒ block rides beside the page\'s own still-cancelable PaymentIntent', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const StripeService = require('../services/stripe');
    StripeService.retrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_fresh', status: 'requires_payment_method' });
    const { body } = await getPayPage(invoiceData({ status: 'overdue', stripe_payment_intent_id: 'pi_fresh' }));
    expect(body.manualPayOptions).toMatchObject({ zelle: { recipient: 'pay@example.com' }, amountDue: 150 });
    expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  test('env set ⇒ a non-fence error from the reconciliation check still propagates', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const StripeService = require('../services/stripe');
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValueOnce(new Error('db down'));
    await expect(getPayPage(invoiceData({ status: 'overdue' }))).rejects.toThrow('db down');
  });

  test('env set ⇒ key absent on a combined-balance session (codex r2 P1)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const { isEnabled } = require('../config/feature-gates');
    const openBalance = require('../services/open-balance');
    isEnabled.mockImplementation((k) => k === 'payIncludeBalance');
    require('../config/feature-gates').gates.payIncludeBalance = true;
    openBalance.openBalanceInvoices.mockResolvedValue([{
      id: 'inv-old-1', invoice_number: 'INV-OLD', status: 'overdue', service_date: '2026-08-01', due_date: '2026-08-15',
      total: '44.55', credit_applied: 0, stripe_payment_intent_id: null,
    }]);
    try {
      const { body } = await getPayPage(invoiceData());
      // Either the siblings previewed (then no transfer block), or the
      // combined selection declined — in both cases a transfer never rides
      // beside an itemized combined total.
      if (body.previousBalance) {
        expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
      } else {
        expect(body.manualPayOptions).toEqual({ zelle: { recipient: 'pay@example.com' }, amountDue: 150, version: null });
      }
    } finally {
      isEnabled.mockImplementation(() => false);
      delete require('../config/feature-gates').gates.payIncludeBalance;
      openBalance.openBalanceInvoices.mockResolvedValue([]);
    }
  });

  test('env set ⇒ key absent when the invoice must capture a saved method (codex P1)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    // per_application billing ⇒ invoiceRequiresSavedMethod() is true.
    const { body } = await getPayPage(invoiceData(), { customerRow: { billing_mode: 'per_application', monthly_rate: null } });
    expect(body.invoice.saveRequired).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
  });

  test('env set ⇒ key absent when account credit will settle the whole invoice (codex P1)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const gates = require('../config/feature-gates').gates;
    gates.autoApplyAccountCredit = true;
    try {
      const { body } = await getPayPage(invoiceData(), {
        customerRow: { billing_mode: null, monthly_rate: null, account_credits: 500, auto_apply_account_credit: true },
      });
      expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
      // Partial credit (balance < amount due) still offers the transfer —
      // for the PROJECTED post-credit amount, not the pre-credit amountDue
      // (codex r2 P1: /setup applies the credit asynchronously).
      const partial = await getPayPage(invoiceData(), {
        customerRow: { billing_mode: null, monthly_rate: null, account_credits: 20, auto_apply_account_credit: true },
      });
      // Gross amount + creditPending: the client withholds the transfer
      // links until /setup actually applies the credit (a projection is not
      // a reservation — codex r3 P1).
      expect(partial.body.manualPayOptions).toEqual({ zelle: { recipient: 'pay@example.com' }, amountDue: 150, creditPending: true, version: null });
    } finally {
      gates.autoApplyAccountCredit = false;
    }
  });

  test('env set ⇒ key absent on a settled invoice', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    for (const status of ['paid', 'prepaid', 'processing', 'void']) {
      const { body } = await getPayPage(invoiceData({ status }));
      expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
    }
  });
});

// GATE_PAY_PAGE_FAQ — the FAQ accordion flag rides the same GET payload.
// Off ⇒ key ABSENT (byte-identical payload); on ⇒ `payFaq: true`, nothing
// else changes (no new data, no money).
describe('GET /pay/:token payFaq (GATE_PAY_PAGE_FAQ)', () => {
  const gates = require('../config/feature-gates').gates;
  afterEach(() => { delete gates.payPageFaq; });

  test('gate off ⇒ key absent', async () => {
    const { body } = await getPayPage(invoiceData());
    expect(Object.prototype.hasOwnProperty.call(body, 'payFaq')).toBe(false);
  });

  test('gate on ⇒ payFaq: true and the rest of the payload is unchanged', async () => {
    const { body: off } = await getPayPage(invoiceData());
    gates.payPageFaq = true;
    const { body: on } = await getPayPage(invoiceData());
    expect(on.payFaq).toBe(true);
    const { payFaq, ...rest } = on;
    expect(rest).toEqual(off);
  });
});
