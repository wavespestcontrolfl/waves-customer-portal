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
jest.mock('../services/open-balance', () => ({ rowIsSelfPayDue: jest.fn(async () => true) }));
jest.mock('../services/receipt-delivery-queue', () => ({ enqueueReceiptDelivery: jest.fn(async () => ({ enqueued: true })), scheduleReceiptDeliveryDrain: jest.fn() }));

const db = require('../models/db');
const StripeService = require('../services/stripe');
const InvoiceService = require('../services/invoice');
const { sendReceiptEmail } = require('../services/invoice-email');
const { rowIsSelfPayDue } = require('../services/open-balance');
const ReceiptDeliveryQueue = require('../services/receipt-delivery-queue');
const { recordManualPayment, VALID_PAYMENT_METHODS } = require('../services/invoice-manual-payment');

function recorder({ first = null, returning = [] } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNotIn', 'andWhere', 'orderBy', 'limit', 'forUpdate', 'noWait'].forEach((m) => { q[m] = jest.fn(() => q); });
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

  test.each(['cancelled', 'no_show', 'skipped'])('invoice whose visit is %s under the lock → 409 visitNeverRan, no paid flip, no ledger row (#3878 r2 fence)', async (visitStatus) => {
    db.mockImplementation(() => recorder({ first: openInvoice({ scheduled_service_id: 'svc-1' }) }));
    let invoiceUpdate = null;
    let paymentsInsert = null;
    let visitLocked = false;
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => {
        if (table === 'invoices') { const r = recorder({ first: openInvoice({ scheduled_service_id: 'svc-1' }), returning: [] }); invoiceUpdate = r.update; return r; }
        if (table === 'scheduled_services') { const r = recorder({ first: { id: 'svc-1', status: visitStatus } }); r.forUpdate = jest.fn(() => { visitLocked = true; return r; }); return r; }
        if (table === 'payments') { const r = recorder(); paymentsInsert = r.insert; return r; }
        throw new Error(`unexpected trx table ${table}`);
      });
      trx.fn = { now: () => 'NOW()' };
      return fn(trx);
    });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'cash' }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(new RegExp(`visit is ${visitStatus.replace('_', '-')}`));
    expect(err.visitNeverRan).toBe(visitStatus);
    expect(visitLocked).toBe(true);
    expect(invoiceUpdate).not.toHaveBeenCalled();
    expect(paymentsInsert).toBeNull();
  });

  test('a visit held by a concurrent schedule edit (NOWAIT 55P03) → 409 visit_busy, nothing recorded — the fence never waits on the visit while holding the invoice (Codex #3882 r3 P2)', async () => {
    db.mockImplementation(() => recorder({ first: openInvoice({ scheduled_service_id: 'svc-1' }) }));
    let invoiceUpdate = null;
    let paymentsInsert = null;
    let noWaitUsed = false;
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => {
        if (table === 'invoices') { const r = recorder({ first: openInvoice({ scheduled_service_id: 'svc-1' }), returning: [] }); invoiceUpdate = r.update; return r; }
        if (table === 'scheduled_services') {
          const r = recorder();
          r.noWait = jest.fn(() => { noWaitUsed = true; return r; });
          r.first = jest.fn(async () => { const e = new Error('could not obtain lock on row'); e.code = '55P03'; throw e; });
          return r;
        }
        if (table === 'payments') { const r = recorder(); paymentsInsert = r.insert; return r; }
        throw new Error(`unexpected trx table ${table}`);
      });
      trx.fn = { now: () => 'NOW()' };
      return fn(trx);
    });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'cash' }));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('visit_busy');
    expect(noWaitUsed).toBe(true);
    expect(invoiceUpdate).not.toHaveBeenCalled();
    expect(paymentsInsert).toBeNull();
  });

  test("a 'rescheduled' visit (pending reschedule request parks the same row) still takes the payment", async () => {
    db.mockImplementation(() => recorder({ first: openInvoice({ scheduled_service_id: 'svc-1' }) }));
    let invoiceUpdate = null;
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => {
        if (table === 'invoices') { const r = recorder({ first: openInvoice({ scheduled_service_id: 'svc-1' }), returning: [openInvoice({ scheduled_service_id: 'svc-1', status: 'paid' })] }); invoiceUpdate = r.update; return r; }
        if (table === 'scheduled_services') return recorder({ first: { id: 'svc-1', status: 'rescheduled' } });
        if (table === 'payments') return recorder();
        throw new Error(`unexpected trx table ${table}`);
      });
      trx.fn = { now: () => 'NOW()' };
      return fn(trx);
    });
    await recordManualPayment('inv-1', { method: 'cash' });
    expect(invoiceUpdate).toHaveBeenCalled();
  });

  test('a new standalone PI minted under the lock → 409 retry message', async () => {
    db.mockImplementation(() => recorder({ first: openInvoice() }));
    db.transaction.mockImplementation(async () => ({ racedNewPaymentIntent: 'pi_new' }));
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'check' }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/new payment session started/);
  });

  test('expectedAmountCents is fenced under the invoice lock: a moved amount due → 409 and nothing written', async () => {
    db.mockImplementation(() => recorder({ first: openInvoice() }));
    let paymentsInsert = null;
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => {
        if (table === 'invoices') return recorder({ first: openInvoice({ total: '120.00' }), returning: [] }); // amount moved under the lock
        if (table === 'payments') { const r = recorder(); paymentsInsert = r.insert; return r; }
        throw new Error(`unexpected trx table ${table}`);
      });
      trx.fn = { now: () => 'NOW()' };
      return fn(trx);
    });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', expectedAmountCents: 11700 }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/\$120\.00, not the \$117\.00/);
    expect(err.amountMismatch).toEqual({ expectedCents: 11700, actualCents: 12000 });
    expect(paymentsInsert).toBeNull();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
  });

  test.each([
    ['a payer assigned on the locked row', { payer_id: 'payer-1' }, true],
    ['a statement assigned on the locked row', { payer_statement_id: 'stmt-1' }, true],
    ['the live payer resolution now naming a payer', {}, false],
  ])('requireSelfPay is fenced under the invoice lock: %s → 409 and nothing written', async (_label, lockedOver, resolvesSelfPay) => {
    db.mockImplementation(() => recorder({ first: openInvoice() }));
    // First call = the pre-lock read (passes); second = under the lock (the race fence being tested).
    let resolveCalls = 0;
    rowIsSelfPayDue.mockImplementation(async () => (resolveCalls++ === 0 ? true : resolvesSelfPay));
    let paymentsInsert = null;
    let customerLock = null;
    let payersLock = null;
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => {
        if (table === 'invoices') return recorder({ first: openInvoice(lockedOver), returning: [] });
        if (table === 'customers') { const r = recorder({ first: { id: 'cust-1', payer_id: 'payer-9' } }); customerLock = r.forUpdate; return r; }
        if (table === 'payers') { const r = recorder(); r.select = jest.fn(async () => []); payersLock = r.forUpdate; return r; }
        if (table === 'payments') { const r = recorder(); paymentsInsert = r.insert; return r; }
        throw new Error(`unexpected trx table ${table}`);
      });
      trx.fn = { now: () => 'NOW()' };
      return fn(trx);
    });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', expectedAmountCents: 11700, requireSelfPay: true }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/no longer an open self-pay invoice/);
    // The payer-source row is LOCKED in the payment trx before the resolution, which rides the same trx.
    expect(customerLock).toHaveBeenCalled();
    expect(payersLock).toHaveBeenCalled(); // the (possibly inactive) payer the customer points at is locked too
    if (!resolvesSelfPay) expect(rowIsSelfPayDue).toHaveBeenCalledWith('cust-1', expect.objectContaining({ id: 'inv-1' }), expect.objectContaining({ database: expect.any(Function) }));
    expect(paymentsInsert).toBeNull();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
  });

  test('requireSelfPay: a visit held by a concurrent schedule edit (NOWAIT 55P03) on the payer-source lock → 409 visit_busy before any resolution (Codex #3882 r4 P2)', async () => {
    db.mockImplementation(() => recorder({ first: openInvoice({ scheduled_service_id: 'svc-1' }) }));
    rowIsSelfPayDue.mockResolvedValue(true);
    let paymentsInsert = null;
    let noWaitUsed = false;
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => {
        if (table === 'invoices') return recorder({ first: openInvoice({ scheduled_service_id: 'svc-1' }), returning: [] });
        if (table === 'customers') return recorder({ first: { id: 'cust-1', payer_id: null } });
        if (table === 'scheduled_services') {
          const r = recorder();
          r.noWait = jest.fn(() => { noWaitUsed = true; return r; });
          r.first = jest.fn(async () => { const e = new Error('could not obtain lock on row'); e.code = '55P03'; throw e; });
          return r;
        }
        if (table === 'payments') { const r = recorder(); paymentsInsert = r.insert; return r; }
        throw new Error(`unexpected trx table ${table}`);
      });
      trx.fn = { now: () => 'NOW()' };
      return fn(trx);
    });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', expectedAmountCents: 11700, requireSelfPay: true }));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('visit_busy');
    expect(noWaitUsed).toBe(true);
    expect(paymentsInsert).toBeNull();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
  });

  test('the Zelle predicates refuse on the PRE-LOCK read before the Stripe session is retired (a bad match never cancels a live checkout)', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValue({ id: 'pi_live', status: 'requires_payment_method' });
    // amount moved before the call: 409, no PI retire, no transaction
    db.mockImplementation(() => recorder({ first: openInvoice({ total: '120.00', stripe_payment_intent_id: 'pi_live' }) }));
    let err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', expectedAmountCents: 11700, requireSelfPay: true }));
    expect(err.statusCode).toBe(409);
    expect(err.amountMismatch).toEqual({ expectedCents: 11700, actualCents: 12000 });
    expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    // payer assigned before the call: same
    db.mockImplementation(() => recorder({ first: openInvoice({ payer_id: 'payer-1', stripe_payment_intent_id: 'pi_live' }) }));
    err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', expectedAmountCents: 11700, requireSelfPay: true }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/no longer an open self-pay invoice/);
    expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('expectedAmountCents must be a positive integer', async () => {
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', expectedAmountCents: 117.5 }));
    expect(err.statusCode).toBe(400);
    expect(db).not.toHaveBeenCalled();
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
  function settle(row, { prefs = null, prefsLookupFails = false } = {}) {
    const paid = { ...row, status: 'paid', payment_method: 'zelle' };
    const invoices = recorder({ first: row });
    const activity = recorder();
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoices;
      if (table === 'activity_log') return activity;
      if (table === 'notification_prefs') { const r = recorder({ first: prefs }); if (prefsLookupFails) r.first = jest.fn(async () => { throw new Error('db blip'); }); return r; }
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

  test('automated: the receipt job is inserted IN the settlement transaction (opt-outs, send window, retries live in the queue), nothing sent inline', async () => {
    settle(openInvoice());
    const out = await recordManualPayment('inv-1', { method: 'zelle', automated: true });
    expect(out.receipt).toEqual({ queued: true });
    // Inserted IN the settlement transaction (database = the trx), not after commit.
    expect(ReceiptDeliveryQueue.enqueueReceiptDelivery).toHaveBeenCalledWith({ invoiceId: 'inv-1', source: 'zelle_notice_reconciler', customerInitiated: true, database: expect.any(Function) });
    expect(ReceiptDeliveryQueue.enqueueReceiptDelivery.mock.invocationCallOrder[0]).toBeLessThan(ReceiptDeliveryQueue.scheduleReceiptDeliveryDrain.mock.invocationCallOrder[0]);
    expect(ReceiptDeliveryQueue.scheduleReceiptDeliveryDrain).toHaveBeenCalled();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
    expect(InvoiceService.sendReceipt).not.toHaveBeenCalled();
    // The operator path is unchanged: inline, operator-initiated.
    settle(openInvoice());
    const op = await recordManualPayment('inv-1', { method: 'zelle' });
    expect(op.receipt).toEqual({ email: { ok: true }, sms: { ok: true } });
    expect(ReceiptDeliveryQueue.enqueueReceiptDelivery).toHaveBeenCalledTimes(1);
  });

  test('settlementFence runs under the invoice lock on the payment trx right before the paid flip; false → 409, nothing written', async () => {
    db.mockImplementation(() => recorder({ first: openInvoice() }));
    let paymentsInsert = null;
    let seenTrx = null;
    db.transaction.mockImplementation(async (fn) => {
      const trx = jest.fn((table) => {
        if (table === 'invoices') return recorder({ first: openInvoice(), returning: [] });
        if (table === 'payments') { const r = recorder(); paymentsInsert = r.insert; return r; }
        throw new Error(`unexpected trx table ${table}`);
      });
      trx.fn = { now: () => 'NOW()' };
      return fn(trx);
    });
    // First call = pre-lock (passes), second = under the lock on the payment trx.
    let fenceCalls = 0;
    const fence = jest.fn(async (conn) => { if (fenceCalls++ === 0) return true; seenTrx = conn; return false; });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', settlementFence: fence }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/settlement claim was lost/);
    expect(fence).toHaveBeenCalledTimes(2);
    expect(fence.mock.calls[0][0]).toBe(db); // pre-lock: the plain connection
    expect(typeof seenTrx).toBe('function'); // under the lock: the payment connection, not a third one
    expect(paymentsInsert).toBeNull();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
  });

  test('a lost claim refuses on the PRE-LOCK fence before the Stripe session is retired', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValue({ id: 'pi_live', status: 'requires_payment_method' });
    db.mockImplementation(() => recorder({ first: openInvoice({ stripe_payment_intent_id: 'pi_live' }) }));
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', settlementFence: async () => false }));
    expect(err.statusCode).toBe(409);
    expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
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
