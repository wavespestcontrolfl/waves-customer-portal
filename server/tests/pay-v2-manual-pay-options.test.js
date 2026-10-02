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
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => {}),
  withInvoiceDepositSettlement: jest.fn(async (_id, callback) => {
    const database = require('../models/db');
    await require('../services/estimate-deposits').assertInvoiceDepositSettlementReady(database, {});
    return callback(database);
  }),
}));
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
// Codex round-65 P1: payPageZelleVisibility re-reads the invoice row just before answering. Unless a test routes 'invoices' itself,
// that read returns the invoice under test (the GET's refreshed row, or the row handed to a direct visibility call) - unchanged.
let liveInvoice = null;
const setDbImpl = db.mockImplementation.bind(db);
db.mockImplementation = (fn) => setDbImpl((table, ...rest) => {
  const q = fn(table, ...rest);
  if (table === 'invoices' && liveInvoice && q && typeof q.first === 'function' && q.__liveInvoice !== false) q.first = jest.fn(async () => liveInvoice);
  return q;
});
const visibilityOf = payRouter.payPageZelleVisibility;
payRouter.payPageZelleVisibility = (args = {}) => { if (args.invoice) liveInvoice = args.invoice; return visibilityOf(args); };
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

async function getPayPage(data, { customerRow, refreshedData = data, dbImpl = null } = {}) {
  liveInvoice = refreshedData;
  InvoiceService.getByToken.mockReset()
    .mockResolvedValueOnce(data)
    .mockResolvedValueOnce(refreshedData);
  db.mockImplementation(dbImpl || ((table) => {
    if (table === 'customers') return chain({ first: customerRow || { billing_mode: null, monthly_rate: null } });
    return chain({ first: null });
  }));
  const layer = payRouter.stack.find((l) => l.route?.path === '/:token' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { token: data.token } };
  let body = null;
  let status = 200;
  const res = { json: (payload) => { body = payload; }, status: (code) => { status = code; return res; } };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return { body, status };
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
  test('uses the reconciled invoice for the displayed balance and Zelle amount', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const before = invoiceData({
      updated_at: '2026-09-13T12:00:00Z',
      line_items: [{ type: 'service', amount: 150 }],
    });
    const after = invoiceData({
      updated_at: '2026-09-13T12:01:00Z',
      total: '101.00',
      line_items: [
        { type: 'service', amount: 150 },
        { type: 'deposit_credit', amount: -49 },
      ],
    });
    const { body, status } = await getPayPage(before, { refreshedData: after });
    expect(status).toBe(200);
    expect(InvoiceService.getByToken).toHaveBeenNthCalledWith(1, before.token);
    expect(InvoiceService.getByToken).toHaveBeenNthCalledWith(2, before.token, { recordView: false, database: db });
    expect(body.invoice).toMatchObject({ total: 101, amountDue: 101, lineItems: after.line_items });
    expect(body.invoice.version).toBe(new Date(after.updated_at).getTime());
    expect(body.manualPayOptions).toMatchObject({ amountDue: 101, version: new Date(after.updated_at).getTime() });
  });

  test('keeps the missing-invoice response when the follow-up read is gone', async () => {
    const { body, status } = await getPayPage(invoiceData(), { refreshedData: null });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Invoice not found' });
  });

  test('env unset ⇒ key absent (not null) on a collectible invoice', async () => {
    const { body } = await getPayPage(invoiceData());
    expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
  });

  // Independent-review P1 (round 3, PR #5331): with ZELLE_RECIPIENT unset the
  // route must never even reach isZelleTransferEligible's async probes — an
  // unrelated reconciliation-check failure must not 500 this public,
  // unauthenticated pay page just because Zelle isn't configured at all.
  test('env unset ⇒ the page still succeeds even when the reconciliation check would throw — eligibility probes never run without a configured recipient', async () => {
    const StripeService = require('../services/stripe');
    StripeService.assertNoInvoiceChargeReconciliationPending.mockClear();
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValueOnce(new Error('db down'));
    const { body, status } = await getPayPage(invoiceData({ status: 'overdue' }));
    expect(status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
    expect(StripeService.assertNoInvoiceChargeReconciliationPending).not.toHaveBeenCalled();
    // The queued rejection must not leak into a later test either.
    StripeService.assertNoInvoiceChargeReconciliationPending.mockReset();
    StripeService.assertNoInvoiceChargeReconciliationPending.mockResolvedValue(undefined);
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

  // A Zelle transfer happens entirely off-platform, so this block is the one
  // collection rail the guarded POST routes cannot refuse afterwards. A
  // withdrawn packet invoice keeps a collectible STATUS, so the status-only
  // read advertised an amount for debt that now belongs to AP (codex r25 P1).
  test('env set ⇒ key absent on a withdrawn packet invoice', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    for (const status of ['sent', 'viewed', 'overdue']) {
      const { body } = await getPayPage(invoiceData({ status, scheduled_send_error: 'payer_billed:5:hold' }));
      expect(body).not.toHaveProperty('manualPayOptions');
    }
    // An ordinary delivery failure is not a withdrawal.
    const { body } = await getPayPage(invoiceData({ status: 'overdue', scheduled_send_error: 'smtp 550 mailbox unavailable' }));
    expect(body.manualPayOptions).toEqual(expect.objectContaining({ zelle: { recipient: 'pay@example.com' } }));
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
    // (both reads: the eligibility pass and the final pass's closing PaymentIntent guard - Codex round-68 P0)
    StripeService.retrievePaymentIntent.mockResolvedValue({ id: 'pi_fresh', status: 'requires_payment_method' });
    try {
      const { body } = await getPayPage(invoiceData({ status: 'overdue', stripe_payment_intent_id: 'pi_fresh' }));
      expect(body.manualPayOptions).toMatchObject({ zelle: { recipient: 'pay@example.com' }, amountDue: 150 });
      expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    } finally {
      StripeService.retrievePaymentIntent.mockResolvedValue(null);
    }
  });

  // Pre-push audit P1 (supersedes "still propagates"): the public page fails CLOSED, not 500.
  test('env set ⇒ a non-fence error from the reconciliation check withholds Zelle and the page still serves', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const StripeService = require('../services/stripe');
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValueOnce(new Error('db down'));
    const { body, status } = await getPayPage(invoiceData({ status: 'overdue' }));
    expect(status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
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

  // Independent-review P1 (round 5, finding 3): a payer assigned via the
  // scheduled service or the customer default AFTER this invoice was
  // created leaves invoices.payer_id null — only the LIVE resolution
  // combinedEligibleSiblings runs finds it. That must deny Zelle, not read
  // as "no previous balance, continue" the way a bare null return used to.
  test('env set ⇒ key absent when the anchor LIVE-resolves to a payer (round 5 finding 3)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const { isEnabled } = require('../config/feature-gates');
    const PayerService = require('../services/payer');
    isEnabled.mockImplementation((k) => k === 'payIncludeBalance');
    require('../config/feature-gates').gates.payIncludeBalance = true;
    PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1' });
    try {
      const { body } = await getPayPage(invoiceData());
      expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(body, 'previousBalance')).toBe(false);
    } finally {
      isEnabled.mockImplementation(() => false);
      delete require('../config/feature-gates').gates.payIncludeBalance;
      PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
    }
  });
});

// The extracted contract itself (independent-review P1, round 5, findings 3
// & 4): payPageZelleVisibility({ invoice }) → { visible, reason }, the ONE
// function GET /:token and zelleInvoiceStillEligible (liveZelleFacts: draft
// time and send time) all now call.
describe('payPageZelleVisibility (round 5, findings 3 & 4)', () => {
  const { payPageZelleVisibility } = payRouter;

  afterEach(() => {
    const { isEnabled } = require('../config/feature-gates');
    isEnabled.mockImplementation(() => false);
    delete require('../config/feature-gates').gates.payIncludeBalance;
    require('../config/feature-gates').gates.autoApplyAccountCredit = false;
    require('../services/payer').resolveForInvoice.mockResolvedValue({ payerId: null });
  });

  test('not configured ⇒ { visible: false, reason: "not_configured" }, no lookup at all', async () => {
    delete process.env.ZELLE_RECIPIENT;
    const dbFn = require('../models/db');
    dbFn.mockReset();
    const result = await payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue' }) });
    expect(result).toEqual({ visible: false, reason: 'not_configured' });
    expect(dbFn).not.toHaveBeenCalled();
  });

  test('eligible, no pending credit ⇒ visible true', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    db.mockImplementation(() => chain({ first: { billing_mode: null, monthly_rate: null } }));
    const result = await payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue' }) });
    expect(result).toEqual({ visible: true, reason: null, projectedCredit: 0 });
  });

  // Finding 4: the client-side "hides Zelle while creditPending" rule
  // (PayPageV2.jsx), now expressed here so the SMS side asks the same
  // question. This reason is what lets GET /:token keep populating
  // manualPayOptions (creditPending: true) while every OTHER caller reads
  // this exact case as not-visible.
  test('a pending partial account credit withholds visibility with its own reason (round 5 finding 4)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const gates = require('../config/feature-gates').gates;
    gates.autoApplyAccountCredit = true;
    db.mockImplementation((table) => {
      if (table === 'customers') return chain({ first: { billing_mode: null, monthly_rate: null, account_credits: 20, auto_apply_account_credit: true } });
      return chain({ first: null });
    });
    const result = await payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue' }) });
    expect(result).toEqual({ visible: false, reason: 'credit_pending', projectedCredit: 20 });
  });

  test('a LIVE-resolved payer denies visibility (round 5 finding 3)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    const { isEnabled } = require('../config/feature-gates');
    isEnabled.mockImplementation((k) => k === 'payIncludeBalance');
    require('../config/feature-gates').gates.payIncludeBalance = true;
    require('../services/payer').resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1' });
    db.mockImplementation(() => chain({ first: { billing_mode: null, monthly_rate: null } }));
    const result = await payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue' }) });
    expect(result).toEqual({ visible: false, reason: 'payer_owned' });
  });

  // Codex round-6 pre-push audit P1: ONE always-run ownership step serves the
  // pay page, the draft-time fetch and the send-time recheck, independent of
  // payIncludeBalance (combinedEligibleSiblings returns null before resolving
  // a payer when that flag is off, and on resolver errors).
  describe('live payer ownership is checked for every caller, independent of payIncludeBalance', () => {
    const PayerService = require('../services/payer');
    beforeEach(() => {
      PayerService.resolveForInvoice.mockClear();
      process.env.ZELLE_RECIPIENT = 'pay@example.com';
      db.mockImplementation(() => chain({ first: { billing_mode: null, monthly_rate: null } }));
    });
    const unstamped = () => invoiceData({ status: 'overdue' });

    test('a payer_id- or payer_statement_id-stamped invoice is payer_owned', async () => {
      for (const stamp of [{ payer_id: 'payer-1' }, { payer_statement_id: 'stmt-1' }]) {
        await expect(payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue', ...stamp }) })).resolves.toEqual({ visible: false, reason: 'payer_owned' });
      }
    });

    test('payIncludeBalance OFF + an UNSTAMPED invoice that live-resolves to a payer ⇒ payer_owned', async () => {
      PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1' });
      await expect(payPageZelleVisibility({ invoice: unstamped() })).resolves.toEqual({ visible: false, reason: 'payer_owned' });
      expect(PayerService.resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ throwOnError: true }));
    });

    test('resolver throws ⇒ payer_unverifiable (fail closed, never read as self-pay)', async () => {
      PayerService.resolveForInvoice.mockRejectedValueOnce(new Error('lookup down'));
      await expect(payPageZelleVisibility({ invoice: unstamped() })).resolves.toEqual({ visible: false, reason: 'payer_unverifiable' });
    });

    // Codex round-63 P0: the live resolver runs AGAIN after the credit / reconciliation / Stripe awaits
    test('a Bill-To assignment that lands during the eligibility probes ⇒ payer_owned (ownership re-read last)', async () => {
      PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: null }).mockResolvedValue({ payerId: 'payer-1' });
      try {
        await expect(payPageZelleVisibility({ invoice: unstamped() })).resolves.toEqual({ visible: false, reason: 'payer_owned' });
        expect(PayerService.resolveForInvoice.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
      }
    });

    test('an invoice with no customer_id cannot be verified ⇒ payer_unverifiable', async () => {
      await expect(payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue', customer_id: null }) })).resolves.toEqual({ visible: false, reason: 'payer_unverifiable' });
    });

    test('no live payer ⇒ still eligible', async () => {
      PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: null });
      await expect(payPageZelleVisibility({ invoice: unstamped() })).resolves.toEqual({ visible: true, reason: null, projectedCredit: 0 });
    });
  });
});

// Codex round-10 P1: a credit lookup that ERRORS is unknown, never zero.
describe('payPageZelleVisibility + GET: an erroring credit lookup fails closed', () => {
  const { payPageZelleVisibility } = payRouter;
  const PayerService = require('../services/payer');
  const gates = require('../config/feature-gates').gates;
  beforeEach(() => {
    PayerService.resolveForInvoice.mockReset();
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    gates.autoApplyAccountCredit = true;
  });
  afterEach(() => { gates.autoApplyAccountCredit = false; delete process.env.ZELLE_RECIPIENT; });
  const failingCustomers = () => db.mockImplementation((table) => {
    if (table === 'customers') { const q = chain(); q.first = jest.fn(async () => { throw new Error('db down'); }); return q; }
    return chain({ first: null });
  });

  test('visibility: credit lookup error ⇒ { visible: false, reason: "credit_unverifiable" }', async () => {
    failingCustomers();
    await expect(payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue' }) })).resolves.toEqual({ visible: false, reason: 'credit_unverifiable' });
  });

  test('visibility: credit lookup error in the PROJECTED-credit probe alone also fails closed', async () => {
    let n = 0;
    db.mockImplementation((table) => {
      if (table === 'customers') {
        n += 1;
        const q = chain();
        q.first = jest.fn(async () => {
          if (n >= 2) throw new Error('db down');
          return { billing_mode: null, monthly_rate: null, account_credits: 5, auto_apply_account_credit: true };
        });
        return q;
      }
      return chain({ first: null });
    });
    // (owner ruling 2026-10-02: the final full pass reads customers too, so the failing read may land there - closed either way)
    const verdict = await payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue' }), creditWillCoverAnchor: false });
    expect(verdict.visible).toBe(false);
    expect(['credit_unverifiable', 'eligibility_unverifiable']).toContain(verdict.reason);
  });

  test('GET /:token withholds manualPayOptions (key absent, page still served) when the credit lookup errors', async () => {
    const dbImpl = (table) => {
      if (table === 'customers') {
        const q = chain({ first: { billing_mode: null, monthly_rate: null } });
        q.first = jest.fn(async (...cols) => {
          if (cols.includes('account_credits')) throw new Error('db down');
          return { billing_mode: null, monthly_rate: null };
        });
        return q;
      }
      return chain({ first: null });
    };
    const { body, status } = await getPayPage(invoiceData(), { dbImpl });
    expect(status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
  });
});

// Pre-push audit P1: a THROWING eligibility probe fails closed (Zelle withheld) and never 500s the public page.
describe('a throwing Zelle eligibility probe never fails the public pay page', () => {
  const StripeService = require('../services/stripe');
  const { warn } = require('../services/logger');
  const { payPageZelleVisibility } = payRouter;
  afterEach(() => {
    delete process.env.ZELLE_RECIPIENT;
    StripeService.assertNoInvoiceChargeReconciliationPending.mockReset();
    StripeService.assertNoInvoiceChargeReconciliationPending.mockResolvedValue(undefined);
  });

  test('reconciliation check throws a non-suppression error => 200, manualPayOptions absent, only the invoice id logged', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValue(Object.assign(new Error('secret db detail'), { code: 'ECONNRESET' }));
    warn.mockClear();
    const { body, status } = await getPayPage(invoiceData({ status: 'overdue' }));
    expect(status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(body, 'manualPayOptions')).toBe(false);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/inv-1/);
    expect(logged).not.toMatch(/secret db detail/);
  });

  test('payPageZelleVisibility resolves { visible: false, reason: eligibility_unverifiable } instead of throwing', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValue(new Error('db down'));
    db.mockImplementation(() => chain({ first: { billing_mode: null, monthly_rate: null } }));
    await expect(payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue' }), creditWillCoverAnchor: false }))
      .resolves.toEqual({ visible: false, reason: 'eligibility_unverifiable' });
  });

  test('a HUNG probe is bounded: resolves not-visible instead of stalling the page', async () => {
    jest.useFakeTimers();
    try {
      process.env.ZELLE_RECIPIENT = 'pay@example.com';
      StripeService.assertNoInvoiceChargeReconciliationPending.mockImplementation(() => new Promise(() => {}));
      db.mockImplementation(() => chain({ first: { billing_mode: null, monthly_rate: null } }));
      const p = payPageZelleVisibility({ invoice: invoiceData({ status: 'overdue' }), creditWillCoverAnchor: false });
      await jest.advanceTimersByTimeAsync(9000);
      await expect(p).resolves.toEqual({ visible: false, reason: 'eligibility_unverifiable' });
    } finally {
      jest.useRealTimers();
    }
  });
});

// Codex round-13 P1: the projected-credit read happens ONCE per public GET (it rides the visibility verdict). Owner ruling 2026-10-02:
// the final full pass re-reads coverage once more after the Stripe awaits - three reads, never more.
describe('GET /pay/:token reads account credit no more than three times (coverage + one projection + the final pass)', () => {
  const gates = require('../config/feature-gates').gates;
  const PayerService = require('../services/payer');
  beforeEach(() => {
    PayerService.resolveForInvoice.mockReset();
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    gates.autoApplyAccountCredit = true;
  });
  afterEach(() => { gates.autoApplyAccountCredit = false; delete process.env.ZELLE_RECIPIENT; });

  test('credit lookups on customers.account_credits: no fourth read; creditPending still flagged from the shared projection', async () => {
    let creditReads = 0;
    const dbImpl = (table) => {
      const q = chain({ first: { billing_mode: null, monthly_rate: null } });
      if (table === 'customers') {
        q.first = jest.fn(async (...cols) => {
          if (cols.includes('account_credits')) { creditReads += 1; return { account_credits: 20, auto_apply_account_credit: true }; }
          return { billing_mode: null, monthly_rate: null };
        });
      }
      return q;
    };
    const { body } = await getPayPage(invoiceData(), { dbImpl });
    expect(creditReads).toBeLessThanOrEqual(3);
    expect(body.manualPayOptions).toMatchObject({ creditPending: true });
  });
});

// GET /api/pay/:token — the same always-run ownership step withholds
// manualPayOptions (key ABSENT, rest of the payload unchanged) whatever
// payIncludeBalance says (owner-approved, PR #5331).
describe('GET /pay/:token manualPayOptions payer ownership (flag off)', () => {
  const PayerService = require('../services/payer');
  const has = (body) => Object.prototype.hasOwnProperty.call(body, 'manualPayOptions');
  beforeEach(() => {
    PayerService.resolveForInvoice.mockReset();
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
  });
  afterEach(() => {
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
    delete process.env.ZELLE_RECIPIENT;
  });

  test('flag off + an unstamped invoice that live-resolves to a payer ⇒ no manualPayOptions', async () => {
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    const { body } = await getPayPage(invoiceData());
    expect(has(body)).toBe(false);
  });

  test('a stamped payer_id ⇒ no manualPayOptions', async () => {
    const { body } = await getPayPage(invoiceData({ payer_id: 'payer-1' }));
    expect(has(body)).toBe(false);
  });

  test('resolver throws ⇒ no manualPayOptions (fail closed), the rest of the payload still served', async () => {
    PayerService.resolveForInvoice.mockRejectedValue(new Error('lookup down'));
    const { body, status } = await getPayPage(invoiceData());
    expect(status).toBe(200);
    expect(has(body)).toBe(false);
    expect(body.invoice_number || body.invoiceNumber || Object.keys(body).length).toBeTruthy();
  });

  test('no payer ⇒ manualPayOptions present', async () => {
    const { body } = await getPayPage(invoiceData());
    expect(has(body)).toBe(true);
    expect(body.manualPayOptions.zelle.recipient).toBe('pay@example.com');
  });

  test('ZELLE_RECIPIENT unset ⇒ the resolver is never called for this (byte-identical payload)', async () => {
    delete process.env.ZELLE_RECIPIENT;
    PayerService.resolveForInvoice.mockClear();
    const { body } = await getPayPage(invoiceData());
    expect(has(body)).toBe(false);
    expect(PayerService.resolveForInvoice).not.toHaveBeenCalled();
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

// Codex round-65 P1: the invoice row is re-read just before visibility answers
describe('payPageZelleVisibility re-reads the invoice row last', () => {
  const { payPageZelleVisibility } = payRouter;
  beforeEach(() => { process.env.ZELLE_RECIPIENT = 'pay@example.com'; require('../services/payer').resolveForInvoice.mockResolvedValue({ payerId: null }); });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; });
  const withLiveRow = (row) => setDbImpl((table) => (table === 'invoices'
    ? (row instanceof Error ? { where: () => ({ first: async () => { throw row; } }) } : chain({ first: row }))
    : chain({ first: { billing_mode: null, monthly_rate: null } })));
  test.each([
    ['paid meanwhile', { status: 'paid' }, 'invoice_changed'],
    ['a new PaymentIntent stamped', { stripe_payment_intent_id: 'pi_new' }, 'invoice_changed'],
    ['re-amounted', { total: '175.00' }, 'invoice_changed'],
  ])('%s => withheld', async (_label, change, reason) => {
    const inv = invoiceData({ status: 'overdue' });
    withLiveRow({ ...inv, ...change });
    await expect(visibilityOf({ invoice: inv, creditWillCoverAnchor: false })).resolves.toEqual({ visible: false, reason });
  });
  test('row gone => invoice_not_found; read throws => eligibility_unverifiable; unchanged => visible', async () => {
    const inv = invoiceData({ status: 'overdue' });
    withLiveRow(undefined);
    await expect(visibilityOf({ invoice: inv, creditWillCoverAnchor: false })).resolves.toEqual({ visible: false, reason: 'invoice_not_found' });
    withLiveRow(new Error('db down'));
    await expect(visibilityOf({ invoice: inv, creditWillCoverAnchor: false })).resolves.toEqual({ visible: false, reason: 'eligibility_unverifiable' });
    withLiveRow({ ...inv });
    await expect(payPageZelleVisibility({ invoice: inv, creditWillCoverAnchor: false })).resolves.toMatchObject({ visible: true });
  });
});

// Codex round-66 P1 / owner ruling 2026-10-02: the final full pass reruns the saved-method requirement with no caller override
test('a saved-method requirement that appears during the probes withholds Zelle (the caller override is not trusted)', async () => {
  process.env.ZELLE_RECIPIENT = 'pay@example.com';
  require('../services/payer').resolveForInvoice.mockResolvedValue({ payerId: null });
  const inv = invoiceData({ status: 'overdue' });
  // the caller's pre-await override says "not required"; the live customer row now says required - the final pass must read it
  setDbImpl((table) => {
    if (table === 'invoices') return chain({ first: inv });
    if (table === 'customers') return chain({ first: { billing_mode: 'per_application', monthly_rate: 50 } });
    return chain({ first: null });
  });
  const verdict = await visibilityOf({ invoice: inv, creditWillCoverAnchor: false, saveRequired: false });
  expect(verdict).toEqual({ visible: false, reason: 'invoice_changed' });
  delete process.env.ZELLE_RECIPIENT;
});

// Codex round-67 P1: the projected (partial) credit is read LAST, from the fresh row - a credit that appears during the probes withholds
test('a partial account credit that appears during the probes => credit_pending (never a stale projectedCredit of 0)', async () => {
  process.env.ZELLE_RECIPIENT = 'pay@example.com';
  require('../services/payer').resolveForInvoice.mockResolvedValue({ payerId: null });
  const gates = require('../config/feature-gates').gates;
  gates.autoApplyAccountCredit = true;
  const inv = invoiceData({ status: 'overdue' });
  let creditReads = 0;
  try {
    setDbImpl((table) => {
      if (table === 'invoices') return chain({ first: inv });
      const q = chain({ first: { billing_mode: null, monthly_rate: null } });
      if (table === 'customers') {
        q.first = jest.fn(async (...cols) => {
          if (!cols.includes('account_credits')) return { billing_mode: null, monthly_rate: null };
          creditReads += 1;
          return { account_credits: creditReads >= 2 ? 20 : 0, auto_apply_account_credit: true };
        });
      }
      return q;
    });
    const verdict = await visibilityOf({ invoice: inv, saveRequired: false });
    expect(verdict).toMatchObject({ visible: false, reason: 'credit_pending' });
    expect(verdict.projectedCredit).toBeGreaterThan(0);
  } finally {
    gates.autoApplyAccountCredit = false;
    delete process.env.ZELLE_RECIPIENT;
  }
});

// Codex round-68 P0s: the final pass closes with the active-collection guards, and a credit that grew to full coverage is never "pending"
describe('the final pass: active collection and full coverage', () => {
  beforeEach(() => { process.env.ZELLE_RECIPIENT = 'pay@example.com'; require('../services/payer').resolveForInvoice.mockResolvedValue({ payerId: null }); });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; });
  test('a saved-card charge claim that starts after the first pass => withheld', async () => {
    const StripeService = require('../services/stripe');
    const inv = invoiceData({ status: 'overdue' });
    setDbImpl((table) => (table === 'invoices' ? chain({ first: inv }) : chain({ first: { billing_mode: null, monthly_rate: null } })));
    StripeService.assertNoInvoiceChargeReconciliationPending
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('charge in progress'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }));
    await expect(visibilityOf({ invoice: inv, creditWillCoverAnchor: false, saveRequired: false })).resolves.toEqual({ visible: false, reason: 'invoice_changed' });
    expect(StripeService.assertNoInvoiceChargeReconciliationPending).toHaveBeenLastCalledWith(inv.id, expect.anything(), { readOnly: true });
  });
  test('the attached PaymentIntent moved to processing after the first pass => withheld', async () => {
    const StripeService = require('../services/stripe');
    const inv = invoiceData({ status: 'overdue', stripe_payment_intent_id: 'pi_1' });
    setDbImpl((table) => (table === 'invoices' ? chain({ first: inv }) : chain({ first: { billing_mode: null, monthly_rate: null } })));
    StripeService.retrievePaymentIntent
      .mockResolvedValueOnce({ id: 'pi_1', status: 'requires_payment_method' })
      .mockResolvedValueOnce({ id: 'pi_1', status: 'processing' });
    await expect(visibilityOf({ invoice: inv, creditWillCoverAnchor: false, saveRequired: false })).resolves.toEqual({ visible: false, reason: 'invoice_changed' });
  });
  test('a credit that grew to cover the whole invoice => credit_covers (never credit_pending)', async () => {
    const gates = require('../config/feature-gates').gates;
    gates.autoApplyAccountCredit = true;
    const inv = invoiceData({ status: 'overdue' });
    let creditReads = 0;
    try {
      setDbImpl((table) => {
        if (table === 'invoices') return chain({ first: inv });
        const q = chain({ first: { billing_mode: null, monthly_rate: null } });
        if (table === 'customers') {
          q.first = jest.fn(async (...cols) => {
            if (!cols.includes('account_credits')) return { billing_mode: null, monthly_rate: null };
            creditReads += 1;
            // reads: first-pass coverage, final-pass coverage, then the projection - the credit grows only at the last one
            return { account_credits: creditReads >= 3 ? 1000 : 0, auto_apply_account_credit: true };
          });
        }
        return q;
      });
      await expect(visibilityOf({ invoice: inv, saveRequired: false })).resolves.toEqual({ visible: false, reason: 'credit_covers' });
      expect(creditReads).toBe(3);
    } finally { gates.autoApplyAccountCredit = false; }
  });
});

// Codex round-70 P0s: the PaymentIntent read comes first; the deposit-settlement and charge-claim fences are the LAST reads
describe('the final pass ends with the DB fences', () => {
  beforeEach(() => { process.env.ZELLE_RECIPIENT = 'pay@example.com'; require('../services/payer').resolveForInvoice.mockResolvedValue({ payerId: null }); });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; });
  const inv = () => invoiceData({ status: 'overdue' });
  const rows = (i) => setDbImpl((table) => (table === 'invoices' ? chain({ first: i }) : chain({ first: { billing_mode: null, monthly_rate: null } })));
  test('a deposit received during the probes => deposit_pending', async () => {
    const deposits = require('../services/estimate-deposits');
    const i = inv(); rows(i);
    deposits.assertInvoiceDepositSettlementReady.mockRejectedValueOnce(Object.assign(new Error('awaiting'), { code: 'DEPOSIT_RECONCILIATION_REQUIRED' }));
    await expect(visibilityOf({ invoice: i, creditWillCoverAnchor: false, saveRequired: false })).resolves.toEqual({ visible: false, reason: 'deposit_pending' });
    expect(deposits.assertInvoiceDepositSettlementReady).toHaveBeenLastCalledWith(expect.anything(), i, { lock: false });
  });
  test('an unexpected deposit-fence error fails closed', async () => {
    const deposits = require('../services/estimate-deposits');
    const i = inv(); rows(i);
    deposits.assertInvoiceDepositSettlementReady.mockRejectedValueOnce(new Error('db down'));
    await expect(visibilityOf({ invoice: i, creditWillCoverAnchor: false, saveRequired: false })).resolves.toEqual({ visible: false, reason: 'eligibility_unverifiable' });
  });
  test('order: PaymentIntent read, then deposit fence, then charge claim (last)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/pay-v2'), 'utf8');
    const body = src.slice(src.indexOf('async function zelleFinalPass'), src.indexOf('const ZELLE_ELIGIBILITY_TIMEOUT_MS'));
    const pi = body.indexOf('zelleDeniedByPaymentIntent(fresh)');
    const dep = body.indexOf('zelleDeniedByDepositSettlement(fresh, dbh)');
    const claim = body.indexOf('zelleDeniedByChargeReconciliation(fresh, true, dbh)');
    expect(pi).toBeGreaterThan(-1);
    expect(dep).toBeGreaterThan(pi);
    expect(claim).toBeGreaterThan(dep);
    expect(body.slice(claim)).not.toMatch(/await (?!zelleDeniedByChargeReconciliation)/);
  });
});

