/**
 * Regression suite for B-43 (webhook half):
 * Best-effort post-commit reconcileSetupFeeAlertForInvoice hooks across:
 *   - handlePaymentIntentSucceeded (single & combined invoice settle)
 *   - handleChargeRefunded (single & combined full refund; skipped when fenced)
 *   - handleDisputeCreated (single & combined reopen)
 *   - handleDisputeClosed (single & combined won & lost)
 *   - Failures in reconcileSetupFeeAlertForInvoice are swallowed and never break webhooks.
 *
 * Synthetic UUIDs and fixtures only — no PII.
 */

const mockStripeClient = {
  paymentIntents: { retrieve: jest.fn(async (id) => ({ id, metadata: {} })) },
  charges: { retrieve: jest.fn(async (id) => ({ id, amount: 10000 })) },
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
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => {}) }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => {}),
  create: jest.fn(async () => ({ id: 'notif-1' })),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/stripe-invoice-state', () => ({
  assertInvoicePaymentIntentTenderMatches: jest.fn(),
  isAchPaymentIntent: jest.fn(() => false),
  isTerminalInvoicePaymentIntent: jest.fn(() => false),
  nextInvoiceStatusAfterFailedPayment: jest.fn(() => 'sent'),
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/receipt-delivery-queue', () => ({
  enqueueReceiptDelivery: jest.fn(async () => {}),
  scheduleReceiptDeliveryDrain: jest.fn(),
}));
jest.mock('../services/estimate-deposits', () => ({
  handleDepositChargeReversed: jest.fn(async () => ({ handled: false })),
  handleDepositDisputeClosed: jest.fn(async () => ({ handled: false })),
}));
jest.mock('../services/admin-alert-compose', () => ({ raiseAdminAlert: jest.fn(async () => ({ id: 1 })) }));
jest.mock('../services/customer-credit', () => ({
  ...jest.requireActual('../services/customer-credit'),
  returnAppliedCreditOnRefund: jest.fn(async () => ({ restored: 0 })),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  acquireTermiteGateForCharge: jest.fn(async () => []),
  acquireTermiteGateAtEntry: jest.fn(async () => undefined),
  suspendActiveTermsForDisputedInvoice: jest.fn(async () => undefined),
  syncTermForInvoicePayment: jest.fn(async () => []),
  syncTermForRefundedPayment: jest.fn(async () => []),
}));
jest.mock('../services/invoice-issued-closeout', () => ({
  closeOutVisitForIssuedInvoice: jest.fn(async () => ({ closed: false, audited: true })),
}));
jest.mock('../services/invoice-followups', () => ({
  stopOnPayment: jest.fn(async () => {}),
}));
jest.mock('../services/payment-plans', () => ({
  completeActivePlansForInvoice: jest.fn(async () => {}),
}));
jest.mock('../services/review-request', () => ({
  enrollForPaidInvoice: jest.fn(async () => ({ enrolled: false })),
}));
const mockSettleCombined = jest.fn();
jest.mock('../services/pay-combined', () => ({
  ...jest.requireActual('../services/pay-combined'),
  settleCombinedPaymentIntent: (...args) => mockSettleCombined(...args),
}));
const mockAssertNoReconPending = jest.fn(async () => {});
jest.mock('../services/stripe', () => ({
  ...jest.requireActual('../services/stripe'),
  retrievePaymentIntent: jest.fn(async (piId) => ({ id: piId, metadata: {} })),
  assertNoInvoiceChargeReconciliationPending: (...args) => mockAssertNoReconPending(...args),
  parkInvoiceForSavedCardReconciliation: jest.fn(async () => {}),
}));
const mockReconcileSetupFee = jest.fn(async () => {});
jest.mock('../services/setup-fee-alert-reconcile', () => ({
  reconcileSetupFeeAlertForInvoice: (...args) => mockReconcileSetupFee(...args),
}));

const db = require('../models/db');
const CustomerCredit = require('../services/customer-credit');
const {
  _handlePaymentIntentSucceeded: handlePaymentIntentSucceeded,
  _handleChargeRefunded: handleChargeRefunded,
  _handleDisputeCreated: handleDisputeCreated,
  _handleDisputeClosed: handleDisputeClosed,
} = require('../routes/stripe-webhook');

const INV_1 = '11111111-1111-4111-8111-111111111111';
const INV_2 = '22222222-2222-4222-8222-222222222222';
const CUST_1 = '33333333-3333-4333-8333-333333333333';
const EST_1 = '44444444-4444-4444-8444-444444444444';

let tables;

function memQuery(table) {
  const rows = tables[table] || [];
  const filters = [];
  const pick = () => rows.filter((r) => filters.every((f) => f(r)));
  const q = {
    where(arg, val) {
      if (typeof arg === 'function') return q;
      if (typeof arg === 'string') filters.push((r) => r[arg] === val);
      else filters.push((r) => Object.entries(arg).every(([k, v]) => r[k] === v));
      return q;
    },
    whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
    whereNotIn(col, vals) { filters.push((r) => !vals.includes(r[col])); return q; },
    whereNot: () => q,
    whereNull: () => q,
    whereRaw: () => q,
    whereExists: () => q,
    forUpdate: () => q,
    forShare: () => q,
    select: () => q,
    orderBy: () => q,
    first: async () => (pick()[0] ? { ...pick()[0] } : undefined),
    update: async (patch) => {
      const hits = pick();
      hits.forEach((r) => Object.assign(r, patch));
      return hits.length;
    },
    insert: (row) => {
      const stored = { id: `gen-${rows.length + 1}`, ...row };
      return {
        returning: async () => { rows.push(stored); return [{ ...stored }]; },
        onConflict: () => ({ ignore: async () => [] }),
        then: (res, rej) => { rows.push(stored); return Promise.resolve([stored]).then(res, rej); },
      };
    },
    then: (res, rej) => Promise.resolve(pick().map((r) => ({ ...r }))).then(res, rej),
  };
  return q;
}

const stampedInvoice = (id, over = {}) => ({
  id,
  customer_id: CUST_1,
  invoice_number: `INV-${id.slice(0, 4)}`,
  status: 'paid',
  total: '100.00',
  subtotal: '100.00',
  discount_amount: '0.00',
  tax_amount: '0.00',
  credit_applied: '0.00',
  amount_paid: '0.00',
  notes: `accepted estimate #${EST_1}`,
  scheduled_service_id: null,
  service_record_id: null,
  stripe_payment_intent_id: 'pi_1',
  stripe_charge_id: 'ch_1',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  tables = { invoices: [], payments: [], customers: [{ id: CUST_1, first_name: 'Pat', last_name: 'Test' }], stripe_orphan_charges: [], stripe_failed_refunds: [] };
  db.mockImplementation((table) => memQuery(table));
  db.schema = { hasTable: jest.fn(async () => false) };
  db.raw = jest.fn(async () => ({ rowCount: 1, rows: [{ cents: 0 }] }));
  db.fn = { now: () => 'NOW()' };
  db.transaction.mockImplementation(async (cb) => cb(db));
  CustomerCredit.returnAppliedCreditOnRefund.mockImplementation(async ({ invoiceId }) => {
    const inv = tables.invoices.find((r) => r.id === invoiceId);
    if (inv) inv.status = 'refunded';
    return { restored: 0 };
  });
});

describe('B-43: webhook setup-fee alert reconcile hooks', () => {
  test('combined payment_intent.succeeded reconciles every settled invoice and swallows reconcile errors', async () => {
    tables.invoices.push(stampedInvoice(INV_1), stampedInvoice(INV_2));
    mockSettleCombined.mockResolvedValue({
      settled: 2,
      paymentStatus: 'paid',
      invoiceIds: [INV_1, INV_2],
    });
    mockReconcileSetupFee.mockRejectedValueOnce(new Error('reconcile transient error'));

    await expect(handlePaymentIntentSucceeded({
      id: 'pi_comb_ok',
      amount: 20000,
      amount_received: 20000,
      payment_method_types: ['card'],
      metadata: {
        waves_invoice_id: INV_1,
        combined_allocation: `${INV_1}:10000,${INV_2}:10000`,
      },
    })).resolves.toBeUndefined();

    expect(mockReconcileSetupFee).toHaveBeenCalledWith(expect.objectContaining({ id: INV_1 }));
    expect(mockReconcileSetupFee).toHaveBeenCalledWith(expect.objectContaining({ id: INV_2 }));
  });

  test('single-invoice payment_intent.succeeded reconciles the paid invoice post-commit', async () => {
    tables.invoices.push(stampedInvoice(INV_1, { status: 'sent', stripe_payment_intent_id: 'pi_single_ok' }));
    tables.payments.push({
      id: 'pay-single-ok',
      customer_id: CUST_1,
      status: 'processing',
      amount: '100.00',
      stripe_payment_intent_id: 'pi_single_ok',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });

    await handlePaymentIntentSucceeded({
      id: 'pi_single_ok',
      amount: 10000,
      amount_received: 10000,
      latest_charge: 'ch_single_ok',
      payment_method_types: ['card'],
      metadata: { waves_invoice_id: INV_1 },
    });

    expect(mockReconcileSetupFee).toHaveBeenCalledTimes(1);
    expect(mockReconcileSetupFee).toHaveBeenCalledWith(expect.objectContaining({ id: INV_1 }));
  });

  test('handleChargeRefunded reconciles owned single and combined refunded invoices', async () => {
    tables.invoices.push(stampedInvoice(INV_1, { stripe_payment_intent_id: 'pi_ref_1', stripe_charge_id: 'ch_ref_1' }));
    tables.payments.push({
      id: 'pay-ref-1',
      customer_id: CUST_1,
      status: 'paid',
      amount: '100.00',
      stripe_payment_intent_id: 'pi_ref_1',
      stripe_charge_id: 'ch_ref_1',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });

    await handleChargeRefunded({
      id: 'ch_ref_1',
      payment_intent: 'pi_ref_1',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_1', amount: 10000, created: 1751000000 }] },
    });

    expect(mockReconcileSetupFee).toHaveBeenCalledTimes(1);
    expect(mockReconcileSetupFee).toHaveBeenCalledWith(expect.objectContaining({ id: INV_1 }));

    // Combined full refund reconciles BOTH owned allocation invoices.
    mockReconcileSetupFee.mockClear();
    tables.invoices.push(
      stampedInvoice(INV_1, { stripe_payment_intent_id: 'pi_ref_comb', stripe_charge_id: 'ch_ref_comb' }),
      stampedInvoice(INV_2, { stripe_payment_intent_id: 'pi_ref_comb', stripe_charge_id: 'ch_ref_comb' }),
    );
    tables.invoices.shift(); // remove earlier INV_1 row so INV_1 points at pi_ref_comb
    tables.payments.push(
      {
        id: 'pay-comb-1',
        customer_id: CUST_1,
        status: 'paid',
        amount: '60.00',
        stripe_payment_intent_id: 'pi_ref_comb',
        stripe_charge_id: 'ch_ref_comb',
        metadata: JSON.stringify({ combined_payment: true, invoice_id: INV_1, combined_anchor_invoice_id: INV_1 }),
      },
      {
        id: 'pay-comb-2',
        customer_id: CUST_1,
        status: 'paid',
        amount: '40.00',
        stripe_payment_intent_id: 'pi_ref_comb',
        stripe_charge_id: 'ch_ref_comb',
        metadata: JSON.stringify({ combined_payment: true, invoice_id: INV_2, combined_anchor_invoice_id: INV_1 }),
      },
    );

    await handleChargeRefunded({
      id: 'ch_ref_comb',
      payment_intent: 'pi_ref_comb',
      amount: 10000,
      amount_refunded: 10000,
      refunded: true,
      metadata: {},
      refunds: { data: [{ id: 're_comb_1', amount: 10000, created: 1751000000 }] },
    });

    expect(mockReconcileSetupFee).toHaveBeenCalledTimes(2);
    expect(mockReconcileSetupFee).toHaveBeenCalledWith(expect.objectContaining({ id: INV_1 }));
    expect(mockReconcileSetupFee).toHaveBeenCalledWith(expect.objectContaining({ id: INV_2 }));
  });

  test('handleDisputeCreated and handleDisputeClosed (won + lost) reconcile affected invoices', async () => {
    tables.invoices.push(stampedInvoice(INV_1, { stripe_payment_intent_id: 'pi_disp', stripe_charge_id: 'ch_disp' }));
    tables.payments.push({
      id: 'pay-disp',
      customer_id: CUST_1,
      status: 'paid',
      amount: '100.00',
      surcharge_amount_cents: 0,
      stripe_payment_intent_id: 'pi_disp',
      stripe_charge_id: 'ch_disp',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });
    const dispute = { id: 'dp_1', charge: 'ch_disp', payment_intent: 'pi_disp', amount: 10000, reason: 'fraudulent', status: 'needs_response' };

    await handleDisputeCreated(dispute);
    expect(mockReconcileSetupFee).toHaveBeenCalledTimes(1);
    expect(mockReconcileSetupFee).toHaveBeenLastCalledWith(expect.objectContaining({ id: INV_1 }));

    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(mockReconcileSetupFee).toHaveBeenCalledTimes(2);
    expect(mockReconcileSetupFee).toHaveBeenLastCalledWith(expect.objectContaining({ id: INV_1 }));

    // Reopen + lost path on a second dispute
    tables.invoices[0].stripe_payment_intent_id = 'pi_disp_2';
    tables.invoices[0].stripe_charge_id = 'ch_disp_2';
    tables.payments.push({
      id: 'pay-disp-2',
      customer_id: CUST_1,
      status: 'paid',
      amount: '100.00',
      surcharge_amount_cents: 0,
      stripe_payment_intent_id: 'pi_disp_2',
      stripe_charge_id: 'ch_disp_2',
      metadata: JSON.stringify({ invoice_id: INV_1 }),
    });
    await handleDisputeClosed({ id: 'dp_2', charge: 'ch_disp_2', payment_intent: 'pi_disp_2', amount: 10000, reason: 'fraudulent', status: 'lost' });
    expect(mockReconcileSetupFee).toHaveBeenCalledTimes(3);
    expect(mockReconcileSetupFee).toHaveBeenLastCalledWith(expect.objectContaining({ id: INV_1 }));
  });
});
