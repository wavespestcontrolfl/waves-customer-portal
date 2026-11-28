/**
 * Regression suite for B-01 & B-06:
 *  - B-01: handleChargeRefunded sets a unified `refundFencedInLock` on EVERY
 *    in-lock bounce-fence exit (fee, combined post-settlement, combined
 *    pre-settlement, and single-invoice) so NO refund email, NO annual-prepay
 *    clawback, NO combined-refund alerts, and NO payment_refunded bell fire for
 *    money Stripe kept; cumulative-full multiple-partial combined refunds park
 *    without falling back to untouched 'paid' rows; payment_refunded bell uses
 *    ledgerInvoiceId(refundedPayment) instead of nonexistent .invoice_id; and
 *    syncTermForRefundedPayment refuses non-refunded payment or invoice rows.
 *  - B-06: single-invoice handleChargeRefunded acquires the shared
 *    `combined.refund.fence` advisory lock and `.forUpdate()` row lock before
 *    mutating `payments` or inserting a pre-settlement marker, re-checking
 *    both `stripe_failed_refunds` and `metadata.failed_refund_ids`.
 *
 * Synthetic UUIDs and fixtures only — no PII.
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
jest.mock('../services/admin-alert-compose', () => ({ raiseAdminAlert: jest.fn(async () => ({ id: 1 })) }));
jest.mock('../services/customer-credit', () => ({
  ...jest.requireActual('../services/customer-credit'),
  returnAppliedCreditOnRefund: jest.fn(),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  ...jest.requireActual('../services/annual-prepay-renewals'),
  acquireTermiteGateForCharge: jest.fn(async () => []),
}));
jest.mock('../services/stripe', () => ({
  ...jest.requireActual('../services/stripe'),
  retrievePaymentIntent: jest.fn(async (piId) => ({ id: piId, metadata: {} })),
}));

const db = require('../models/db');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const CustomerCredit = require('../services/customer-credit');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const { triggerNotification } = require('../services/notification-triggers');
const AnnualPrepay = require('../services/annual-prepay-renewals');
const { _handleChargeRefunded: handleChargeRefunded } = require('../routes/stripe-webhook');

const INV_1 = '11111111-1111-4111-8111-111111111111';
const INV_2 = '22222222-2222-4222-8222-222222222222';
const CUST_1 = '33333333-3333-4333-8333-333333333333';

let payments;
let invoices;
let failedRefunds;
let orphanCharges;
let tableAccess;
let lockCalls;
let forUpdateTables;
let onLockAcquired;
let nextId;

const clone = (row) => (row ? { ...row } : row);

function memTable(name, rows) {
  const filters = [];
  const matching = () => rows.filter((row) => filters.every((f) => f(row)));
  const q = {
    where(cond, val) {
      if (typeof cond === 'function') return q;
      if (typeof cond === 'string') filters.push((row) => row[cond] === val);
      else filters.push((row) => Object.entries(cond).every(([k, v]) => row[k] === v));
      return q;
    },
    whereIn(col, vals) {
      filters.push((row) => vals.includes(row[col]));
      return q;
    },
    whereNot: () => q,
    forUpdate() {
      forUpdateTables.push(name);
      return q;
    },
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
      const api = {
        returning: async () => {
          rows.push(stored);
          return [clone(stored)];
        },
        onConflict: () => ({
          ignore: async () => {
            rows.push(stored);
            return [];
          },
        }),
        then: (res, rej) => {
          rows.push(stored);
          return Promise.resolve([stored]).then(res, rej);
        },
      };
      return api;
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
  failedRefunds = [];
  orphanCharges = [];
  tableAccess = [];
  lockCalls = [];
  forUpdateTables = [];
  onLockAcquired = null;
  nextId = 1;

  mockStripeClient.paymentIntents.retrieve.mockImplementation(async (id) => ({ id, metadata: {} }));
  db.mockImplementation((table) => {
    tableAccess.push(table);
    if (table === 'payments') return memTable('payments', payments);
    if (table === 'invoices') return memTable('invoices', invoices);
    if (table === 'stripe_failed_refunds') return memTable('stripe_failed_refunds', failedRefunds);
    if (table === 'stripe_orphan_charges') return memTable('stripe_orphan_charges', orphanCharges);
    return emptyTable();
  });
  db.schema = { hasTable: jest.fn(async () => true) };
  db.raw = jest.fn(async (sql, bindings) => {
    if (String(sql).includes('pg_advisory_xact_lock')) {
      lockCalls.push(bindings);
      if (onLockAcquired) {
        const hook = onLockAcquired;
        onLockAcquired = null;
        await hook(bindings);
      }
    }
    return {};
  });
  db.fn = { now: () => 'NOW()' };
  db.transaction.mockImplementation(async (cb) => cb(db));
  db.isTransaction = true;

  CustomerCredit.returnAppliedCreditOnRefund.mockImplementation(async ({ invoiceId }) => {
    const inv = invoices.find((row) => row.id === invoiceId);
    if (inv && !['refunded', 'void'].includes(inv.status)) inv.status = 'refunded';
    return { restored: 0 };
  });
});

describe('B-01: unified in-lock refund fence, combined park skip, and bell invoiceId', () => {
  test('combined post-settlement refund fenced in lock suppresses email, prepay clawback, alerts, and bell', async () => {
    payments.push(
      {
        id: 'pay-comb-1',
        customer_id: CUST_1,
        stripe_payment_intent_id: 'pi_comb_1',
        stripe_charge_id: 'ch_comb_1',
        amount: '60.00',
        status: 'paid',
        metadata: JSON.stringify({ combined_payment: true, invoice_id: INV_1, combined_anchor_invoice_id: INV_1 }),
      },
      {
        id: 'pay-comb-2',
        customer_id: CUST_1,
        stripe_payment_intent_id: 'pi_comb_1',
        stripe_charge_id: 'ch_comb_1',
        amount: '40.00',
        status: 'paid',
        metadata: JSON.stringify({ combined_payment: true, invoice_id: INV_2, combined_anchor_invoice_id: INV_1 }),
      },
    );
    invoices.push(
      { id: INV_1, customer_id: CUST_1, status: 'paid', stripe_payment_intent_id: 'pi_comb_1', stripe_charge_id: 'ch_comb_1' },
      { id: INV_2, customer_id: CUST_1, status: 'paid', stripe_payment_intent_id: 'pi_comb_1', stripe_charge_id: 'ch_comb_1' },
    );

    // Simulate refund.failed committing its row fence while charge.refunded waits for the lock.
    onLockAcquired = () => {
      payments[0].metadata = JSON.stringify({
        combined_payment: true,
        invoice_id: INV_1,
        combined_anchor_invoice_id: INV_1,
        failed_refund_ids: ['re_fenced_comb'],
      });
    };

    await handleChargeRefunded({
      id: 'ch_comb_1',
      payment_intent: 'pi_comb_1',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_fenced_comb', amount: 10000, created: 1751000000 }] },
    });

    expect(payments.every((p) => p.status === 'paid')).toBe(true);
    expect(invoices.every((i) => i.status === 'paid')).toBe(true);
    expect(PaymentLifecycleEmail.sendRefundIssued).not.toHaveBeenCalled();
    expect(tableAccess.includes('annual_prepay_terms')).toBe(false);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('combined pre-settlement refund fenced in lock suppresses marker insert and payment_refunded bell', async () => {
    mockStripeClient.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_comb_pre',
      metadata: {
        waves_invoice_id: INV_1,
        combined_allocation: `${INV_1}:6000,${INV_2}:4000`,
      },
    });
    // Simulate refund.failed inserting the pre-settlement fence row while waiting on the lock.
    onLockAcquired = () => {
      failedRefunds.push({ stripe_refund_id: 're_pre_fenced' });
    };

    await handleChargeRefunded({
      id: 'ch_comb_pre',
      payment_intent: 'pi_comb_pre',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_pre_fenced', amount: 10000, created: 1751000000 }] },
    });

    expect(payments).toHaveLength(0);
    expect(PaymentLifecycleEmail.sendRefundIssued).not.toHaveBeenCalled();
    expect(tableAccess.includes('annual_prepay_terms')).toBe(false);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('combined cumulative-full multiple-partial refund parks rows paid and NEVER cancels annual-prepay terms', async () => {
    payments.push(
      {
        id: 'pay-cum-1',
        customer_id: CUST_1,
        stripe_payment_intent_id: 'pi_cum_1',
        stripe_charge_id: 'ch_cum_1',
        amount: '60.00',
        status: 'paid',
        metadata: JSON.stringify({ combined_payment: true, invoice_id: INV_1, combined_anchor_invoice_id: INV_1 }),
      },
      {
        id: 'pay-cum-2',
        customer_id: CUST_1,
        stripe_payment_intent_id: 'pi_cum_1',
        stripe_charge_id: 'ch_cum_1',
        amount: '40.00',
        status: 'paid',
        metadata: JSON.stringify({ combined_payment: true, invoice_id: INV_2, combined_anchor_invoice_id: INV_1 }),
      },
    );
    invoices.push(
      { id: INV_1, customer_id: CUST_1, status: 'paid', stripe_payment_intent_id: 'pi_cum_1', stripe_charge_id: 'ch_cum_1' },
    );

    // Second partial of $40 brings cumulative amount_refunded to $100 (charge.refunded = true).
    await handleChargeRefunded({
      id: 'ch_cum_1',
      payment_intent: 'pi_cum_1',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_part_2', amount: 4000, created: 1751000000 }] },
    });

    expect(payments.every((p) => p.status === 'paid')).toBe(true);
    expect(orphanCharges).toHaveLength(1);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    // Annual-prepay table must NEVER be touched for parked cumulative-full combined refunds.
    expect(tableAccess.includes('annual_prepay_terms')).toBe(false);
  });

  test('payment_refunded bell receives ledgerInvoiceId(refundedPayment) instead of nonexistent invoice_id column', async () => {
    payments.push({
      id: 'pay-bell-1',
      customer_id: CUST_1,
      stripe_payment_intent_id: 'pi_bell_1',
      stripe_charge_id: 'ch_bell_1',
      amount: '100.00',
      status: 'paid',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });
    invoices.push({
      id: INV_1,
      customer_id: CUST_1,
      status: 'paid',
      stripe_payment_intent_id: 'pi_bell_1',
      stripe_charge_id: 'ch_bell_1',
    });

    await handleChargeRefunded({
      id: 'ch_bell_1',
      payment_intent: 'pi_bell_1',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_bell_1', amount: 10000, created: 1751000000 }] },
    });

    expect(triggerNotification).toHaveBeenCalledWith(
      'payment_refunded',
      expect.objectContaining({ amount: 100, isFullRefund: true, invoiceId: INV_1 }),
      { dedupeKey: 'payment-refunded:ch_bell_1:re_bell_1' },
    );
  });
});

describe('B-06: single-invoice charge.refunded in-lock bounce fence', () => {
  test('acquires combined.refund.fence + FOR UPDATE and skips pre-settlement marker when fenced in stripe_failed_refunds', async () => {
    invoices.push({
      id: INV_1,
      customer_id: CUST_1,
      invoice_number: 'INV-9001',
      status: 'processing',
      stripe_payment_intent_id: 'pi_single_pre',
      stripe_charge_id: null,
    });
    onLockAcquired = () => {
      failedRefunds.push({ stripe_refund_id: 're_single_pre_fail' });
    };

    await handleChargeRefunded({
      id: 'ch_single_pre',
      payment_intent: 'pi_single_pre',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_single_pre_fail', amount: 10000, created: 1751000000 }] },
    });

    expect(lockCalls).toContainEqual(['combined.refund.fence', 'ch_single_pre']);
    expect(forUpdateTables).toContain('payments');
    expect(payments).toHaveLength(0);
    expect(invoices[0].status).toBe('processing');
    expect(CustomerCredit.returnAppliedCreditOnRefund).not.toHaveBeenCalled();
    expect(PaymentLifecycleEmail.sendRefundIssued).not.toHaveBeenCalled();
    expect(tableAccess.includes('annual_prepay_terms')).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('acquires combined.refund.fence + FOR UPDATE and skips stamp/unwind when fenced in payments.metadata.failed_refund_ids', async () => {
    payments.push({
      id: 'pay-single-1',
      customer_id: CUST_1,
      stripe_payment_intent_id: 'pi_single_1',
      stripe_charge_id: 'ch_single_1',
      amount: '100.00',
      status: 'paid',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });
    invoices.push({
      id: INV_1,
      customer_id: CUST_1,
      status: 'paid',
      stripe_payment_intent_id: 'pi_single_1',
      stripe_charge_id: 'ch_single_1',
    });
    onLockAcquired = () => {
      payments[0].metadata = JSON.stringify({ invoice_id: INV_1, failed_refund_ids: ['re_single_fail'] });
    };

    await handleChargeRefunded({
      id: 'ch_single_1',
      payment_intent: 'pi_single_1',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_single_fail', amount: 10000, created: 1751000000 }] },
    });

    expect(lockCalls).toContainEqual(['combined.refund.fence', 'ch_single_1']);
    expect(forUpdateTables).toContain('payments');
    expect(payments[0].status).toBe('paid');
    expect(payments[0].refund_amount).toBeUndefined();
    expect(invoices[0].status).toBe('paid');
    expect(CustomerCredit.returnAppliedCreditOnRefund).not.toHaveBeenCalled();
    expect(PaymentLifecycleEmail.sendRefundIssued).not.toHaveBeenCalled();
    expect(tableAccess.includes('annual_prepay_terms')).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('fences a processing-stage PI-only ACH payment row whose metadata.failed_refund_ids carries refundId', async () => {
    payments.push({
      id: 'pay-ach-proc',
      customer_id: CUST_1,
      stripe_payment_intent_id: 'pi_ach_proc',
      stripe_charge_id: null,
      amount: '100.00',
      status: 'processing',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });
    invoices.push({
      id: INV_1,
      customer_id: CUST_1,
      status: 'processing',
      stripe_payment_intent_id: 'pi_ach_proc',
      stripe_charge_id: null,
    });
    onLockAcquired = () => {
      payments[0].metadata = JSON.stringify({ invoice_id: INV_1, failed_refund_ids: ['re_ach_fail'] });
    };

    await handleChargeRefunded({
      id: 'ch_ach_proc',
      payment_intent: 'pi_ach_proc',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_ach_fail', amount: 10000, created: 1751000000 }] },
    });

    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('processing');
    expect(invoices[0].status).toBe('processing');
    expect(CustomerCredit.returnAppliedCreditOnRefund).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('unfenced FULL refund on a processing-stage PI-only ACH row stamps that row by id, attaches charge id, and inserts no duplicate', async () => {
    payments.push({
      id: 'pay-ach-full',
      customer_id: CUST_1,
      stripe_payment_intent_id: 'pi_ach_full',
      stripe_charge_id: null,
      amount: '100.00',
      status: 'processing',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });
    invoices.push({
      id: INV_1,
      customer_id: CUST_1,
      status: 'processing',
      stripe_payment_intent_id: 'pi_ach_full',
      stripe_charge_id: null,
    });

    await handleChargeRefunded({
      id: 'ch_ach_full',
      payment_intent: 'pi_ach_full',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_ach_full', amount: 10000, created: 1751000000 }] },
    });

    // No duplicate marker row inserted; original row stamped in place with charge id attached.
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      id: 'pay-ach-full',
      status: 'refunded',
      stripe_charge_id: 'ch_ach_full',
      stripe_refund_id: 're_ach_full',
      refund_amount: 100,
      refund_status: 'full',
    });
    expect(JSON.parse(payments[0].metadata).stamped_refund_ids).toEqual(['re_ach_full']);
    expect(invoices[0].status).toBe('refunded');
    expect(CustomerCredit.returnAppliedCreditOnRefund).toHaveBeenCalledWith({ invoiceId: INV_1, createdBy: 'system:refund_webhook' }, db);
  });

  test('unfenced PARTIAL refund on a processing-stage PI-only ACH row stamps that row by id, attaches charge id, and keeps status processing', async () => {
    payments.push({
      id: 'pay-ach-part',
      customer_id: CUST_1,
      stripe_payment_intent_id: 'pi_ach_part',
      stripe_charge_id: null,
      amount: '100.00',
      status: 'processing',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });
    invoices.push({
      id: INV_1,
      customer_id: CUST_1,
      status: 'processing',
      stripe_payment_intent_id: 'pi_ach_part',
      stripe_charge_id: null,
    });

    await handleChargeRefunded({
      id: 'ch_ach_part',
      payment_intent: 'pi_ach_part',
      amount: 10000,
      amount_refunded: 3500,
      refunded: false,
      metadata: {},
      refunds: { data: [{ id: 're_ach_part', amount: 3500, created: 1751000000 }] },
    });

    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      id: 'pay-ach-part',
      status: 'processing',
      stripe_charge_id: 'ch_ach_part',
      stripe_refund_id: 're_ach_part',
      refund_amount: 35,
      refund_status: 'partial',
    });
    expect(JSON.parse(payments[0].metadata).stamped_refund_ids).toEqual(['re_ach_part']);
    expect(invoices[0].status).toBe('processing');
    expect(CustomerCredit.returnAppliedCreditOnRefund).not.toHaveBeenCalled();
  });

  test('in-lock bounce-fence check uses trx.schema.hasTable (never borrows a second pool connection via db.schema)', async () => {
    payments.push({
      id: 'pay-trx-schema',
      customer_id: CUST_1,
      stripe_payment_intent_id: 'pi_trx_schema',
      stripe_charge_id: 'ch_trx_schema',
      amount: '100.00',
      status: 'paid',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });
    invoices.push({
      id: INV_1,
      customer_id: CUST_1,
      status: 'paid',
      stripe_payment_intent_id: 'pi_trx_schema',
      stripe_charge_id: 'ch_trx_schema',
    });
    const trxHasTable = jest.fn(async () => true);
    let insideTx = false;
    db.schema = {
      hasTable: jest.fn(async () => {
        if (insideTx) throw new Error('db.schema.hasTable must not be called inside a transaction');
        return true;
      }),
    };
    db.transaction.mockImplementation(async (cb) => {
      const trx = (table) => {
        tableAccess.push(table);
        if (table === 'payments') return memTable('payments', payments);
        if (table === 'invoices') return memTable('invoices', invoices);
        if (table === 'stripe_failed_refunds') return memTable('stripe_failed_refunds', failedRefunds);
        return emptyTable();
      };
      trx.raw = db.raw;
      trx.fn = db.fn;
      trx.schema = { hasTable: trxHasTable };
      trx.isTransaction = true;
      insideTx = true;
      try { return await cb(trx); } finally { insideTx = false; }
    });
    onLockAcquired = () => {
      failedRefunds.push({ stripe_refund_id: 're_trx_fenced' });
    };

    await handleChargeRefunded({
      id: 'ch_trx_schema',
      payment_intent: 'pi_trx_schema',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_trx_fenced', amount: 10000, created: 1751000000 }] },
    });

    expect(trxHasTable).toHaveBeenCalledWith('stripe_failed_refunds');
    expect(payments[0].status).toBe('paid');
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('post-commit prepay clawback skips when refund.failed reverts the payment row before the sync lock is acquired', async () => {
    payments.push({
      id: 'pay-post-bounce',
      customer_id: CUST_1,
      stripe_payment_intent_id: 'pi_post_bounce',
      stripe_charge_id: 'ch_post_bounce',
      amount: '100.00',
      status: 'paid',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });
    invoices.push({
      id: INV_1,
      customer_id: CUST_1,
      status: 'paid',
      stripe_payment_intent_id: 'pi_post_bounce',
      stripe_charge_id: 'ch_post_bounce',
    });
    let txCount = 0;
    db.transaction.mockImplementation(async (cb) => {
      txCount += 1;
      if (txCount === 2) {
        // Simulate refund.failed committing its revert before the prepay sync transaction locks the row.
        payments[0].status = 'paid';
        payments[0].metadata = JSON.stringify({ invoice_id: INV_1, failed_refund_ids: ['re_post_bounce'] });
      }
      return cb(db);
    });

    await handleChargeRefunded({
      id: 'ch_post_bounce',
      payment_intent: 'pi_post_bounce',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_post_bounce', amount: 10000, created: 1751000000 }] },
    });

    expect(txCount).toBeGreaterThanOrEqual(2);
    expect(tableAccess.includes('annual_prepay_terms')).toBe(false);
  });
});

describe('B-01: syncTermForRefundedPayment defensive guards', () => {
  test('refuses an active paid payment row and never touches annual_prepay_terms', async () => {
    invoices.push({ id: INV_1, status: 'refunded', stripe_payment_intent_id: 'pi_1', stripe_charge_id: 'ch_1' });

    const out = await AnnualPrepay.syncTermForRefundedPayment({
      id: 'pay-active',
      status: 'paid',
      stripe_payment_intent_id: 'pi_1',
      stripe_charge_id: 'ch_1',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    }, db);

    expect(out).toEqual([]);
    expect(tableAccess.includes('annual_prepay_terms')).toBe(false);
  });

  test('refuses a refunded payment row when its resolved invoice is still paid (not refunded)', async () => {
    invoices.push({ id: INV_1, status: 'paid', stripe_payment_intent_id: 'pi_1', stripe_charge_id: 'ch_1' });

    const out = await AnnualPrepay.syncTermForRefundedPayment({
      id: 'pay-ref',
      status: 'refunded',
      stripe_payment_intent_id: 'pi_1',
      stripe_charge_id: 'ch_1',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    }, db);

    expect(out).toEqual([]);
    expect(tableAccess.includes('annual_prepay_terms')).toBe(false);
  });

  test('proceeds to annual_prepay_terms when both payment and owned invoice are refunded', async () => {
    invoices.push({ id: INV_1, status: 'refunded', stripe_payment_intent_id: 'pi_1', stripe_charge_id: 'ch_1' });

    await AnnualPrepay.syncTermForRefundedPayment({
      id: 'pay-ref',
      status: 'refunded',
      stripe_payment_intent_id: 'pi_1',
      stripe_charge_id: 'ch_1',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    }, db);

    expect(tableAccess.includes('annual_prepay_terms')).toBe(true);
  });
});
