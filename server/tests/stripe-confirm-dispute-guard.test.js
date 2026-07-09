/**
 * confirmInvoicePayment — dispute guard (money-path audit 2026-07-06 P1).
 *
 * After a chargeback the dispute handlers set the payments row to 'disputed',
 * reopen the invoice as 'overdue', and clear its PI — but the customer still
 * holds the invoice token and PI id. Replaying /pay/:token/confirm passed
 * every guard (the PI still retrieves 'succeeded' at Stripe, the invoice PI
 * is null), re-marked the charged-back invoice paid, killed dunning, and
 * overwrote the disputed row wholesale (erasing dispute_id/dispute_final).
 * The webhook succeeded-handler has had this guard all along — the confirm
 * path simply never got it. Contract:
 *   - a 'disputed' payments row on the PI refuses settlement inside the
 *     money transaction (race-safe vs a dispute webhook landing mid-flight)
 *   - terminal payments rows (paid/refunded/disputed) are never clobbered
 *     by the existing-row update (webhook parity)
 *   - a clean PI still settles exactly as before
 */

describe('StripeService.confirmInvoicePayment dispute guard', () => {
  let invoiceRow;
  let lockedInvoiceRow;
  let stripeClient;
  let dbMock;
  let disputedRow;
  let existingPaymentRow;
  let invoiceUpdate;
  let paymentsInsert;
  let paymentsUpdate;
  let paymentsUpdateResult;

  const PI_ID = 'pi_disputed_replay';

  function makePi() {
    return {
      id: PI_ID,
      status: 'succeeded',
      amount: 11011,
      amount_received: 11011,
      latest_charge: null,
      payment_method: null,
      payment_method_types: ['card'],
      metadata: {
        waves_invoice_id: 'inv_123',
        base_amount: '107',
        card_surcharge: '3.11',
        surcharge_policy_version: 'v8',
        selected_method_category: 'card',
      },
    };
  }

  beforeEach(() => {
    jest.resetModules();

    invoiceRow = {
      id: 'inv_123',
      invoice_number: 'WPC-2026-0107',
      status: 'overdue',
      total: '107.00',
      credit_applied: null,
      customer_id: 'cust_123',
      stripe_payment_intent_id: null,
      payer_statement_id: null,
    };
    lockedInvoiceRow = { ...invoiceRow };
    disputedRow = null;
    existingPaymentRow = null;
    invoiceUpdate = jest.fn().mockResolvedValue(1);
    paymentsInsert = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'pay_new', status: 'paid' }]) }));
    paymentsUpdateResult = [{ id: 'pay_existing', status: 'paid' }];
    paymentsUpdate = jest.fn(() => ({ returning: jest.fn(async () => paymentsUpdateResult) }));

    stripeClient = {
      paymentIntents: { retrieve: jest.fn(async () => makePi()) },
      charges: { retrieve: jest.fn() },
      paymentMethods: { retrieve: jest.fn() },
    };

    const rootInvoiceQuery = {
      where: jest.fn(() => rootInvoiceQuery),
      first: jest.fn(async () => invoiceRow),
    };
    dbMock = jest.fn((table) => {
      if (table === 'invoices') return rootInvoiceQuery;
      if (table === 'customer_health_alerts') return { insert: jest.fn(async () => [1]) };
      throw new Error(`Unexpected db table: ${table}`);
    });
    dbMock.transaction = jest.fn(async (cb) => {
      const trxInvoiceQuery = {
        where: jest.fn(() => trxInvoiceQuery),
        forUpdate: jest.fn(() => trxInvoiceQuery),
        whereNotIn: jest.fn(() => trxInvoiceQuery),
        first: jest.fn(async () => lockedInvoiceRow),
        update: invoiceUpdate,
      };
      const trx = jest.fn((table) => {
        if (table === 'invoices') return trxInvoiceQuery;
        if (table === 'payments') {
          const ctx = { disputedCheck: false };
          const q = {
            where: jest.fn((cond) => {
              if (cond && cond.status === 'disputed') ctx.disputedCheck = true;
              return q;
            }),
            whereNotIn: jest.fn(() => q),
            orderBy: jest.fn(() => q),
            first: jest.fn(async () => (ctx.disputedCheck ? disputedRow : existingPaymentRow)),
            update: paymentsUpdate,
            insert: paymentsInsert,
          };
          return q;
        }
        throw new Error(`Unexpected trx table: ${table}`);
      });
      trx.raw = jest.fn(async () => undefined);
      return cb(trx);
    });

    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({
      secretKey: 'sk_test_mock',
      publishableKey: 'pk_test_mock',
    }));
    jest.doMock('../services/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/invoice-followups', () => ({
      stopOnPayment: jest.fn(async () => undefined),
    }));
    jest.doMock('../services/annual-prepay-renewals', () => ({
      syncTermForInvoicePayment: jest.fn(async () => undefined),
    }));
  });

  test('refuses to settle when the payments row is disputed (chargeback replay)', async () => {
    disputedRow = { id: 'pay_disputed' };
    const StripeService = require('../services/stripe');

    await expect(StripeService.confirmInvoicePayment('inv_123', PI_ID))
      .rejects.toThrow(/could not process your payment/i);

    expect(invoiceUpdate).not.toHaveBeenCalled();
    expect(paymentsInsert).not.toHaveBeenCalled();
    expect(paymentsUpdate).not.toHaveBeenCalled();
  });

  test('a clean succeeded PI still settles the invoice (guard does not break the happy path)', async () => {
    const StripeService = require('../services/stripe');
    const record = await StripeService.confirmInvoicePayment('inv_123', PI_ID);

    expect(record).toEqual({ id: 'pay_new', status: 'paid' });
    expect(invoiceUpdate).toHaveBeenCalledTimes(1);
    expect(invoiceUpdate.mock.calls[0][0]).toMatchObject({ status: 'paid' });
    expect(paymentsInsert).toHaveBeenCalledTimes(1);
  });

  test('an existing non-terminal row is updated through the terminal-status filter', async () => {
    existingPaymentRow = { id: 'pay_existing', status: 'processing' };
    const StripeService = require('../services/stripe');
    const record = await StripeService.confirmInvoicePayment('inv_123', PI_ID);

    expect(record).toEqual({ id: 'pay_existing', status: 'paid' });
    expect(paymentsUpdate).toHaveBeenCalledTimes(1);
    expect(paymentsInsert).not.toHaveBeenCalled();
  });

  test('a row that flipped to refunded mid-flight aborts the settle (transaction rolls back)', async () => {
    existingPaymentRow = { id: 'pay_existing', status: 'refunded', refund_amount: '110.11' };
    paymentsUpdateResult = []; // whereNotIn filtered the money-left row out
    const StripeService = require('../services/stripe');

    // The throw rolls back the trx — the invoice update above it never
    // commits, so /confirm cannot settle the invoice beside a money-left row.
    await expect(StripeService.confirmInvoicePayment('inv_123', PI_ID))
      .rejects.toThrow(/could not process your payment/i);
    expect(paymentsInsert).not.toHaveBeenCalled();
  });

  test('a paid row beside a still-open invoice lets /confirm repair the invoice', async () => {
    // The webhook writes the payments row before it settles the invoice — if
    // /confirm races (or repairs after) that half-applied state, the money
    // genuinely arrived and the open invoice must still flip to paid (Codex
    // P2: a paid-row abort here would leave collected money showing as due).
    existingPaymentRow = { id: 'pay_existing', status: 'paid' };
    const StripeService = require('../services/stripe');
    const record = await StripeService.confirmInvoicePayment('inv_123', PI_ID);

    expect(record).toEqual({ id: 'pay_existing', status: 'paid' });
    expect(invoiceUpdate).toHaveBeenCalledTimes(1);
    expect(invoiceUpdate.mock.calls[0][0]).toMatchObject({ status: 'paid' });
    expect(paymentsInsert).not.toHaveBeenCalled();
  });
});
