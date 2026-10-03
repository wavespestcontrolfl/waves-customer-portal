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
  let planUpdate;

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
    planUpdate = jest.fn(async () => 0);

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
        // first('status') = completeActivePlansForInvoice's FOR UPDATE
        // settlement recheck — the same trx already flipped the row paid.
        first: jest.fn(async (...args) => (args[0] === 'status' ? { status: 'paid' } : lockedInvoiceRow)),
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
        if (table === 'payment_plans') {
          // A paid confirm completes active plans on the same trx.
          const pq = {
            where: jest.fn(() => pq),
            whereExists: jest.fn(() => pq),
            update: planUpdate,
          };
          return pq;
        }
        if (table === 'invoice_followup_sequences') {
          // Plan completion releases plan-owned dunning stops on the same trx.
          const sq = {
            where: jest.fn(() => sq),
            whereIn: jest.fn(() => sq),
            whereExists: jest.fn(() => sq),
            update: jest.fn(async () => 0),
          };
          return sq;
        }
        throw new Error(`Unexpected trx table: ${table}`);
      });
      // Returns what it was given, so a raw column expression can be inspected.
      trx.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
      trx.isTransaction = true; // completeActivePlansForInvoice reuses a caller trx as-is
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
    // The synchronous settle also completes any active payment plan in-trx.
    expect(planUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  test('the settle write the dispute reopen undoes: total = cash charged + applied credit, surcharge recorded on the payment row (B05)', async () => {
    invoiceRow.credit_applied = 20;
    lockedInvoiceRow.credit_applied = 20;
    stripeClient.paymentIntents.retrieve.mockResolvedValue({ ...makePi(), amount: 9011, amount_received: 9011,
      metadata: { ...makePi().metadata, base_amount: '87', card_surcharge: '3.11' } });
    const StripeService = require('../services/stripe');
    await StripeService.confirmInvoicePayment('inv_123', PI_ID);

    // removeCardSurchargeFromReopenedInvoice (stripe-webhook.js) acts only when
    // total === payments.amount + credit_applied, and takes surcharge_amount_cents off.
    const { total } = invoiceUpdate.mock.calls[0][0];
    const payment = paymentsInsert.mock.calls[0][0];
    expect(payment).toMatchObject({ amount: 90.11, base_amount_cents: 8700, surcharge_amount_cents: 311 });
    expect(total).toBe(payment.amount + 20);
    // ...which lands exactly on the invoice's own $107.00 (amount due 87 + credit 20).
    expect(Math.round(total * 100) - payment.surcharge_amount_cents).toBe(10700);
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

  test('repairing after the webhook merges into the row as it stands at the update, never a stale copy (Codex #4996 r11/r12)', async () => {
    existingPaymentRow = { id: 'pay_existing', status: 'paid',
      metadata: { payment_state: 'processing', settled_event_at: '2026-09-20T14:00:00.000Z', payer_id: '7',
        pending_refund_key: 'refund_pay_existing_rest_0' } };
    const StripeService = require('../services/stripe');
    await StripeService.confirmInvoicePayment('inv_123', PI_ID);

    expect(paymentsUpdate).toHaveBeenCalledTimes(1);
    // The merge is SQL on the live row: a settlement stamp, payer or refund in flight
    // the row carries then stays, and a refund marker cleared since is not written back.
    const { metadata } = paymentsUpdate.mock.calls[0][0];
    expect(metadata.__raw).toContain("(COALESCE(metadata, '{}'::jsonb) || ?::jsonb)");
    // ...and a settlement moment the row already carries outranks the new one (Codex #4996 r13).
    expect(metadata.__raw).toContain("jsonb_strip_nulls(jsonb_build_object('settled_event_at', metadata -> 'settled_event_at'))");
    const merged = JSON.parse(metadata.bindings[0]);
    expect(merged).toMatchObject({ invoice_id: 'inv_123', payment_state: 'paid' });
    for (const key of ['settled_event_at', 'payer_id', 'pending_refund_key']) expect(merged).not.toHaveProperty(key);
  });

  test('a paid charge carries its balance transaction\'s time — when it succeeded — not its creation or the confirm time (Codex #4996 r12/r13)', async () => {
    const createdAt = 1789900000; // the charge was created, then 3DS held it
    const succeededAt = createdAt + 600; // well before this confirm runs
    stripeClient.paymentIntents.retrieve.mockResolvedValue({ ...makePi(), latest_charge: 'ch_card' });
    stripeClient.charges.retrieve.mockResolvedValue({ id: 'ch_card', created: createdAt, receipt_url: null,
      balance_transaction: { id: 'txn_card', created: succeededAt },
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } } });
    const StripeService = require('../services/stripe');
    await StripeService.confirmInvoicePayment('inv_123', PI_ID);

    expect(stripeClient.charges.retrieve).toHaveBeenCalledWith('ch_card', { expand: ['balance_transaction'] });
    expect(paymentsInsert).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(paymentsInsert.mock.calls[0][0].metadata);
    expect(metadata).toMatchObject({ payment_state: 'paid', settled_event_at: new Date(succeededAt * 1000).toISOString() });
  });

  test('a bank payment /confirm sees succeed takes no moment from its balance transaction, which Stripe creates at submission', async () => {
    // The succeeded webhook stamps a bank row's settlement moment; a stamp here would outrank it (pre-push audit).
    existingPaymentRow = { id: 'pay_existing', status: 'processing', metadata: JSON.stringify({ payment_state: 'processing' }) };
    // ACH pays the base amount: no card surcharge.
    stripeClient.paymentIntents.retrieve.mockResolvedValue({ ...makePi(), amount: 10700, amount_received: 10700, latest_charge: 'ch_bank',
      payment_method_types: ['us_bank_account'], metadata: { ...makePi().metadata, card_surcharge: '0', selected_method_category: 'us_bank_account' } });
    stripeClient.charges.retrieve.mockResolvedValue({ id: 'ch_bank', created: 1789900000, receipt_url: null,
      balance_transaction: { id: 'txn_bank', created: 1789900005 },
      payment_method_details: { type: 'us_bank_account', us_bank_account: { last4: '6789' } } });
    const StripeService = require('../services/stripe');
    await StripeService.confirmInvoicePayment('inv_123', PI_ID);

    expect(paymentsUpdate).toHaveBeenCalledTimes(1);
    for (const call of [...paymentsUpdate.mock.calls, ...paymentsInsert.mock.calls]) {
      const { metadata } = call[0];
      const written = typeof metadata === 'string' ? metadata : metadata.bindings[0];
      expect(JSON.parse(written)).not.toHaveProperty('settled_event_at');
    }
  });

  test('a charge with no balance transaction yet (still settling) carries no settlement moment', async () => {
    stripeClient.paymentIntents.retrieve.mockResolvedValue({ ...makePi(), latest_charge: 'ch_card' });
    stripeClient.charges.retrieve.mockResolvedValue({ id: 'ch_card', created: 1789900000, receipt_url: null, balance_transaction: null,
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } } });
    const StripeService = require('../services/stripe');
    await StripeService.confirmInvoicePayment('inv_123', PI_ID);

    expect(JSON.parse(paymentsInsert.mock.calls[0][0].metadata)).not.toHaveProperty('settled_event_at');
  });
});
