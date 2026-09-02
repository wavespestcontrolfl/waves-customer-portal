/**
 * services/invoice-manual-payment.js — recordManualPayment is the ONE manual
 * settlement path (extracted 1:1 from POST /admin/invoices/:id/record-payment
 * on 2026-09-02 so the Zelle notice reconciler can settle through it). Pins
 * the refusal contract a non-route caller depends on:
 *   - every refusal throws with statusCode (400 / 404 / 409) + isOperational;
 *   - the lost-race 409 carries currentStatus (the route echoes it as
 *     current_status — the pre-extraction body);
 *   - the PI guard verdict is thrown with its own message BEFORE any
 *     transaction opens;
 *   - errors without a statusCode (a sentinel from inside the transaction)
 *     are rethrown untouched, never wrapped;
 *   - the happy path returns { invoice, receipt } and only fires the receipt
 *     legs it was asked for.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(async () => ({ status: 'canceled' })),
}));
jest.mock('../services/pay-combined', () => ({
  clearPaymentIntentStamps: jest.fn(async () => undefined),
  releaseCombinedSessionBeforeCollection: jest.fn(async () => undefined),
}));
jest.mock('../services/invoice', () => ({ sendReceipt: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/invoice-followups', () => ({ stopOnPayment: jest.fn(async () => undefined) }));
jest.mock('../services/billing-pause', () => ({ maybeResumeBillingPauseOnPayment: jest.fn(async () => undefined) }));
jest.mock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn(async () => undefined) }));
jest.mock('../services/project-report-hold', () => ({ scheduleHoldReleaseSweep: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(async () => undefined) }));
jest.mock('../services/payment-plans', () => ({ completeActivePlansForInvoice: jest.fn(async () => undefined) }));

const db = require('../models/db');
const StripeService = require('../services/stripe');
const InvoiceService = require('../services/invoice');
const { sendReceiptEmail } = require('../services/invoice-email');
const { recordManualPayment, VALID_PAYMENT_METHODS } = require('../services/invoice-manual-payment');

function recorder({ first = null, returning = [] } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNotIn', 'andWhere', 'orderBy', 'limit', 'forUpdate'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.update = jest.fn(() => q);
  q.insert = jest.fn(async () => undefined);
  q.returning = jest.fn(async () => returning);
  return q;
}

const openInvoice = (over = {}) => ({
  id: 'inv-1', invoice_number: 'WPC-2026-0400', customer_id: 'cust-1', status: 'sent',
  total: '117.00', credit_applied: 0, stripe_payment_intent_id: null, payer_id: null, payer_statement_id: null, notes: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => { throw new Error(`unexpected table ${table}`); });
  db.transaction.mockReset();
});

async function refusalOf(promise) {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected a refusal');
}

describe('recordManualPayment — refusal contract', () => {
  test('unknown tender → 400 listing every accepted method, before any DB read', async () => {
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'bitcoin' }));
    expect(err.statusCode).toBe(400);
    expect(err.isOperational).toBe(true);
    expect(err.message).toBe(`method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`);
    expect(db).not.toHaveBeenCalled();
  });

  test('bad receipt channel → 400 (only when a receipt is requested)', async () => {
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', via: 'fax' }));
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("via must be 'email', 'sms', or 'both'");
    expect(db).not.toHaveBeenCalled();
  });

  test('unknown invoice → 404 "Invoice not found"', async () => {
    db.mockImplementation(() => recorder({ first: null }));
    const err = await refusalOf(recordManualPayment('nope', { method: 'zelle' }));
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Invoice not found');
    expect(err.currentStatus).toBeUndefined();
  });

  test('statement-billed invoice → 400; processing → 409; other uncollectible → 400; $0 → 400', async () => {
    const cases = [
      [openInvoice({ payer_statement_id: 'stmt-1' }), 400, /monthly statement/],
      [openInvoice({ status: 'processing' }), 409, /processing/i],
      [openInvoice({ status: 'paid' }), 400, /paid/i],
      [openInvoice({ total: '0.00' }), 400, 'Invoice has no amount to collect (total is $0)'],
    ];
    for (const [row, status, msg] of cases) {
      db.mockImplementation(() => recorder({ first: row }));
      const err = await refusalOf(recordManualPayment('inv-1', { method: 'cash' }));
      expect(err.statusCode).toBe(status);
      if (msg instanceof RegExp) expect(err.message).toMatch(msg); else expect(err.message).toBe(msg);
      expect(db.transaction).not.toHaveBeenCalled();
    }
  });

  test('open PaymentIntent in flight → 409 with the guard message, before the transaction', async () => {
    db.mockImplementation(() => recorder({ first: openInvoice({ stripe_payment_intent_id: 'pi_live' }) }));
    StripeService.retrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_live', status: 'processing' });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle' }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/already in flight \(processing\).*recording a manual payment/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('lost race → 409 carrying the invoice\'s current status', async () => {
    const reads = [openInvoice(), openInvoice({ status: 'paid' })];
    db.mockImplementation(() => recorder({ first: reads.shift() }));
    db.transaction.mockImplementation(async () => null);
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'check' }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Invoice status changed before payment could be recorded');
    expect(err.currentStatus).toBe('paid');
  });

  test('a new standalone PI minted under the lock → 409 retry message', async () => {
    db.mockImplementation(() => recorder({ first: openInvoice() }));
    db.transaction.mockImplementation(async () => ({ racedNewPaymentIntent: 'pi_new' }));
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'check' }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/new payment session started/);
  });

  test('a non-refusal error from inside the transaction is rethrown untouched', async () => {
    db.mockImplementation(() => recorder({ first: openInvoice() }));
    const sentinel = new Error('db exploded');
    db.transaction.mockImplementation(async () => { throw sentinel; });
    await expect(recordManualPayment('inv-1', { method: 'cash' })).rejects.toBe(sentinel);
    expect(sentinel.statusCode).toBeUndefined();
  });
});

describe('recordManualPayment — settlement', () => {
  function settle(row) {
    const paid = { ...row, status: 'paid', payment_method: 'zelle' };
    const invoices = recorder({ first: row });
    const activity = recorder();
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoices;
      if (table === 'activity_log') return activity;
      throw new Error(`unexpected table ${table}`);
    });
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => {
        if (table === 'invoices') return recorder({ first: row, returning: [paid] });
        if (table === 'payments') return recorder();
        throw new Error(`unexpected trx table ${table}`);
      });
      trx.fn = { now: () => 'NOW()' };
      return fn(trx);
    });
    return { invoices, activity, paid };
  }

  test('happy path returns { invoice, receipt } and fires both receipt legs by default', async () => {
    const { activity } = settle(openInvoice());
    const out = await recordManualPayment('inv-1', { method: 'zelle', reference: 'Pat Doe', recordedBy: 'zelle-notice-reconciler' });
    expect(out.invoice).toBeTruthy();
    expect(out.receipt).toEqual({ email: { ok: true }, sms: { ok: true } });
    expect(sendReceiptEmail).toHaveBeenCalledWith('inv-1');
    expect(InvoiceService.sendReceipt).toHaveBeenCalledWith('inv-1', expect.objectContaining({ force: true, hasEmailLeg: true, operatorInitiated: true }));
    const descriptions = activity.insert.mock.calls.map(([r]) => r.description);
    expect(descriptions[0]).toMatch(/Manual payment recorded for WPC-2026-0400 \(\$117\.00 via zelle · ref Pat Doe\) — zelle-notice-reconciler/);
    expect(descriptions[1]).toMatch(/Receipt sent for invoice WPC-2026-0400 \(email \+ sms\)/);
  });

  test('sendReceipt:false records the payment and sends nothing', async () => {
    settle(openInvoice());
    const out = await recordManualPayment('inv-1', { method: 'cash', sendReceipt: false });
    expect(out.receipt).toBeNull();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
    expect(InvoiceService.sendReceipt).not.toHaveBeenCalled();
  });

  test("via:'email' skips the SMS leg", async () => {
    settle(openInvoice());
    const out = await recordManualPayment('inv-1', { method: 'cash', via: 'email' });
    expect(out.receipt).toEqual({ email: { ok: true }, sms: null });
    expect(InvoiceService.sendReceipt).not.toHaveBeenCalled();
  });
});
