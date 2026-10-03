/**
 * charge.refunded (full, generic single-invoice branch) — the refunded payment
 * must still OWN the invoice before the invoice is terminalized, applied
 * credit is returned, or annual-prepay coverage is clawed back (B03).
 *
 * Scenario the guard exists for: customer pays INV with PI1 -> disputes -> the
 * dispute-created reopen clears INV's PaymentIntent -> customer re-pays INV
 * with PI2 -> the office fully refunds the reinstated ORIGINAL charge. The
 * original ledger row still carries metadata.invoice_id (a reopen never
 * clears it), so resolveRefundedInvoiceId finds INV and used to flip a
 * replacement-paid invoice to refunded, hand back credit PI2 consumed, and
 * (via syncTermForRefundedPayment) cancel prepay coverage PI2 pays for. The
 * combined-charge path fixed the same hole in codex r36 P1; this pins the
 * single-invoice twin.
 *
 * The DB is an in-memory fake (payments + invoices are real rows; every other
 * table is an empty read). annual_prepay_terms access is logged: the real
 * syncTermForRefundedPayment runs, so "term untouched" means that table is
 * never queried, and the claw-back control cases prove it is reachable.
 * Synthetic data only.
 */

const mockStripeClient = {
  paymentIntents: { retrieve: jest.fn(async (id) => ({ id, metadata: {} })) },
  refunds: { list: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripeClient));
jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.transaction = jest.fn();
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('../routes/stripe-webhook-helpers', () => ({
  classifyExistingWebhookEvent: jest.fn(),
  invoicePaymentIntentBlocksFallback: jest.fn(() => false),
  lateSavedCardPaymentNeedsOrphan: jest.fn(() => false),
  savedCardAttemptMatchesPaymentIntent: jest.fn(() => false),
  savedCardCreditAdjustment: jest.fn(() => null),
  STALE_CLAIM_WINDOW_MS: 60000,
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/stripe-invoice-state', () => ({
  isInvoiceCollectibleStatus: jest.fn(() => true),
  invoiceStatusForSuccessfulPayment: jest.fn(),
  invoiceStatusForFailedPayment: jest.fn(),
  INVOICE_COLLECTIBLE_STATUSES: [],
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn(() => Promise.resolve({ ok: true })) }));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));
jest.mock('../services/customer-credit', () => ({
  ...jest.requireActual('../services/customer-credit'),
  returnAppliedCreditOnRefund: jest.fn(),
}));
// The REAL syncTermForRefundedPayment is under test; only the renewal gate
// (its own invoice/term reads) is stubbed.
jest.mock('../services/annual-prepay-renewals', () => ({
  ...jest.requireActual('../services/annual-prepay-renewals'),
  acquireTermiteGateForCharge: jest.fn(async () => []),
}));
jest.mock('../services/stripe', () => ({
  ...jest.requireActual('../services/stripe'),
  retrievePaymentIntent: jest.fn(async (piId) => ({ id: piId, metadata: {} })),
}));

const db = require('../models/db');
const CustomerCredit = require('../services/customer-credit');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const { triggerNotification } = require('../services/notification-triggers');
const AnnualPrepay = require('../services/annual-prepay-renewals');
const { refundedPaymentOwnsInvoice } = require('../services/invoice-helpers');
const { _handleChargeRefunded: handleChargeRefunded } = require('../routes/stripe-webhook');

let payments;
let invoices;
let tableAccess;
let nextId;

const clone = (row) => (row ? { ...row } : row);

// Rows for the two tables the generic branch reads and writes; everything
// else answers like an empty table and is logged by name.
function ledgerTable(rows) {
  const filters = [];
  const matching = () => rows.filter((row) => filters.every((f) => f(row)));
  const q = {
    where(cond) {
      filters.push((row) => Object.entries(cond).every(([k, v]) => row[k] === v));
      return q;
    },
    forUpdate: () => q,
    select: () => q,
    orderBy: () => q,
    first: async () => clone(matching()[0]),
    update: async (patch) => {
      const hits = matching();
      hits.forEach((row) => Object.assign(row, patch));
      return hits.length;
    },
    insert: (row) => {
      const stored = { id: `new-${nextId++}`, ...row };
      rows.push(stored);
      const inserted = Promise.resolve([stored]);
      inserted.returning = async () => [clone(stored)];
      return inserted;
    },
    then: (resolve, reject) => Promise.resolve(matching().map(clone)).then(resolve, reject),
  };
  return q;
}

function emptyTable() {
  const q = new Proxy(() => q, {
    get(_target, prop) {
      if (prop === 'then') return (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      if (prop === 'first') return async () => undefined;
      if (prop === 'update' || prop === 'del' || prop === 'delete') return async () => 0;
      return () => q;
    },
    apply: () => q,
  });
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  AnnualPrepay.resetCachesForTests?.();
  payments = [];
  invoices = [];
  tableAccess = [];
  nextId = 1;

  db.mockImplementation((table) => {
    tableAccess.push(table);
    if (table === 'payments') return ledgerTable(payments);
    if (table === 'invoices') return ledgerTable(invoices);
    return emptyTable();
  });
  db.schema = { hasTable: jest.fn(async (name) => name !== 'stripe_failed_refunds') };
  db.raw = jest.fn(async () => ({}));
  db.fn = { now: () => 'NOW()' };
  db.transaction.mockImplementation(async (cb) => cb(db));
  db.isTransaction = true;

  // The real helper terminalizes + returns credit; model that on the fake rows.
  CustomerCredit.returnAppliedCreditOnRefund.mockImplementation(async ({ invoiceId }) => {
    const inv = invoices.find((row) => row.id === invoiceId);
    const restored = Number(inv.credit_applied) || 0;
    if (!['refunded', 'void'].includes(inv.status)) inv.status = 'refunded';
    inv.credit_applied = 0;
    return { restored };
  });
});

const termsTouched = () => tableAccess.includes('annual_prepay_terms');

function invoiceRow(over = {}) {
  return {
    id: 'inv-1',
    customer_id: 'cust-1',
    invoice_number: 'INV-1001',
    status: 'paid',
    credit_applied: 20,
    stripe_payment_intent_id: null,
    stripe_charge_id: null,
    ...over,
  };
}

function paymentRow(over = {}) {
  return {
    id: 'pay-1',
    customer_id: 'cust-1',
    processor: 'stripe',
    stripe_payment_intent_id: 'pi_1',
    stripe_charge_id: 'ch_1',
    amount: '100.00',
    status: 'paid',
    refund_amount: null,
    refund_status: null,
    metadata: JSON.stringify({ invoice_id: 'inv-1' }),
    ...over,
  };
}

function fullRefundOf(chargeId, paymentIntentId) {
  return {
    id: chargeId,
    payment_intent: paymentIntentId,
    amount: 10000,
    amount_refunded: 10000,
    refunded: true,
    metadata: {},
    refunds: { data: [{ id: 're_1', amount: 10000, created: 1751000000 }] },
  };
}

describe('refundedPaymentOwnsInvoice', () => {
  const inv = (over) => ({ stripe_payment_intent_id: null, stripe_charge_id: null, ...over });

  test('owned by PaymentIntent, owned by charge, and never by a replacement or a cleared invoice', () => {
    expect(refundedPaymentOwnsInvoice(inv({ stripe_payment_intent_id: 'pi_1' }), { paymentIntentId: 'pi_1', chargeId: 'ch_1' })).toBe(true);
    // Charge-only reconciled payment: no PI on the payment, a stale PI on the invoice.
    expect(refundedPaymentOwnsInvoice(inv({ stripe_payment_intent_id: 'pi_stale', stripe_charge_id: 'ch_1' }), { paymentIntentId: null, chargeId: 'ch_1' })).toBe(true);
    expect(refundedPaymentOwnsInvoice(inv({ stripe_payment_intent_id: 'pi_2', stripe_charge_id: 'ch_2' }), { paymentIntentId: 'pi_1', chargeId: 'ch_1' })).toBe(false);
    expect(refundedPaymentOwnsInvoice(inv(), { paymentIntentId: 'pi_1', chargeId: 'ch_1' })).toBe(false);
    expect(refundedPaymentOwnsInvoice(null, { paymentIntentId: 'pi_1', chargeId: 'ch_1' })).toBe(false);
    // Nothing to compare: legacy answer.
    expect(refundedPaymentOwnsInvoice(inv({ stripe_payment_intent_id: 'pi_2' }), {})).toBe(true);
  });
});

describe('handleChargeRefunded full refund — invoice ownership (B03)', () => {
  test('(a) dispute-reopened invoice re-paid by a second PI: refunding the ORIGINAL charge leaves the invoice, credit and prepay term alone', async () => {
    payments.push(
      paymentRow(), // P1: the reinstated original charge, metadata still names inv-1
      paymentRow({ id: 'pay-2', stripe_payment_intent_id: 'pi_2', stripe_charge_id: 'ch_2' }),
    );
    invoices.push(invoiceRow({ stripe_payment_intent_id: 'pi_2', stripe_charge_id: 'ch_2' }));

    await handleChargeRefunded(fullRefundOf('ch_1', 'pi_1'));

    // The ledger row for the refunded charge is stamped, the replacement's is not.
    expect(payments.find((p) => p.id === 'pay-1')).toEqual(expect.objectContaining({ status: 'refunded', refund_status: 'full', refund_amount: 100, stripe_refund_id: 're_1' }));
    expect(payments.find((p) => p.id === 'pay-2')).toEqual(expect.objectContaining({ status: 'paid', refund_amount: null }));
    // The replacement-paid invoice stays paid and keeps the credit PI2 consumed.
    expect(invoices[0]).toEqual(expect.objectContaining({ status: 'paid', credit_applied: 20, stripe_payment_intent_id: 'pi_2' }));
    expect(CustomerCredit.returnAppliedCreditOnRefund).not.toHaveBeenCalled();
    // The prepay claw-back never reaches the term table.
    expect(termsTouched()).toBe(false);
    // Refund comms are unchanged: email + admin notification still fire.
    expect(PaymentLifecycleEmail.sendRefundIssued).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', refundId: 're_1', refundAmount: 100 }));
    expect(triggerNotification).toHaveBeenCalledWith('payment_refunded', expect.objectContaining({ isFullRefund: true }));
  });

  test('(b) the PI still owns the invoice: terminalized, credit returned, prepay claw-back runs (unchanged)', async () => {
    payments.push(paymentRow());
    invoices.push(invoiceRow({ stripe_payment_intent_id: 'pi_1', stripe_charge_id: 'ch_1' }));

    await handleChargeRefunded(fullRefundOf('ch_1', 'pi_1'));

    expect(CustomerCredit.returnAppliedCreditOnRefund).toHaveBeenCalledWith({ invoiceId: 'inv-1', createdBy: 'system:refund_webhook' }, db);
    expect(invoices[0]).toEqual(expect.objectContaining({ status: 'refunded', credit_applied: 0 }));
    expect(payments[0]).toEqual(expect.objectContaining({ status: 'refunded', refund_status: 'full' }));
    expect(termsTouched()).toBe(true);
    expect(PaymentLifecycleEmail.sendRefundIssued).toHaveBeenCalledTimes(1);
  });

  test('(c) charge-only reconciled payment (no PI; invoice linked by stripe_charge_id, stale PI ignored): unchanged', async () => {
    payments.push(paymentRow({ stripe_payment_intent_id: null }));
    invoices.push(invoiceRow({ stripe_payment_intent_id: 'pi_abandoned_attempt', stripe_charge_id: 'ch_1' }));

    await handleChargeRefunded(fullRefundOf('ch_1', null));

    expect(CustomerCredit.returnAppliedCreditOnRefund).toHaveBeenCalledWith({ invoiceId: 'inv-1', createdBy: 'system:refund_webhook' }, db);
    expect(invoices[0]).toEqual(expect.objectContaining({ status: 'refunded', credit_applied: 0 }));
    expect(termsTouched()).toBe(true);
  });

  test('(c2) charge-only reconciled payment whose invoice now points at a replacement charge: left alone', async () => {
    payments.push(paymentRow({ stripe_payment_intent_id: null }));
    invoices.push(invoiceRow({ stripe_payment_intent_id: null, stripe_charge_id: 'ch_2' }));

    await handleChargeRefunded(fullRefundOf('ch_1', null));

    expect(payments[0]).toEqual(expect.objectContaining({ status: 'refunded' }));
    expect(invoices[0]).toEqual(expect.objectContaining({ status: 'paid', credit_applied: 20 }));
    expect(CustomerCredit.returnAppliedCreditOnRefund).not.toHaveBeenCalled();
    expect(termsTouched()).toBe(false);
  });

  test('(d) pre-settlement refund (no payments row yet): invoice resolved by the PI is terminalized and the durable marker is written (unchanged)', async () => {
    invoices.push(invoiceRow({ status: 'processing', credit_applied: 0, stripe_payment_intent_id: 'pi_1', stripe_charge_id: null }));

    await handleChargeRefunded(fullRefundOf('ch_1', 'pi_1'));

    expect(CustomerCredit.returnAppliedCreditOnRefund).toHaveBeenCalledWith({ invoiceId: 'inv-1', createdBy: 'system:refund_webhook' }, db);
    expect(invoices[0].status).toBe('refunded');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toEqual(expect.objectContaining({
      status: 'refunded',
      refund_status: 'full',
      stripe_payment_intent_id: 'pi_1',
      stripe_charge_id: 'ch_1',
      customer_id: 'cust-1',
    }));
    expect(JSON.parse(payments[0].metadata)).toEqual(expect.objectContaining({ invoice_id: 'inv-1', source: 'invoice_refund' }));
    expect(PaymentLifecycleEmail.sendRefundIssued).toHaveBeenCalledTimes(1);
  });
});
