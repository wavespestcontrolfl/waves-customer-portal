/**
 * refund.failed / charge.refund.updated(status=failed) — post-creation refund
 * bounce correction.
 *
 * charge.refunded fires at refund CREATION, before ACH refunds clear, so the
 * books optimistically show the money returned. A later bounce used to fall
 * to the default log-and-ack branch: payments stayed 'refunded', restored
 * credit stayed spendable, no operator signal. Contract:
 *  - the payments row's refund stamps are reverted by the failed amount
 *    (status back to 'paid' when the bounce erased the whole refund);
 *  - replay-fenced on the refund id (refund.failed + charge.refund.updated
 *    both fire for one bounce) — a replay changes nothing and does NOT
 *    re-notify;
 *  - an admin notification flags the human follow-ups (restored credit,
 *    already-sent refund email, deposit-ledger flips when no payments row).
 */

jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.transaction = jest.fn();
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('./stripe-webhook-helpers', () => ({ classifyExistingWebhookEvent: jest.fn(), STALE_CLAIM_WINDOW_MS: 60000 }), { virtual: true });
jest.mock('../routes/stripe-webhook-helpers', () => ({ classifyExistingWebhookEvent: jest.fn(), STALE_CLAIM_WINDOW_MS: 60000 }));
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
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn() }));
jest.mock('../services/receipt-delivery-queue', () => ({}));

const db = require('../models/db');
const { _handleRefundFailed: handleRefundFailed } = require('../routes/stripe-webhook');

describe('handleRefundFailed', () => {
  let paymentRow;
  let trxUpdate;
  let notificationInsert;

  const failedRefund = (over = {}) => ({
    id: 're_fail',
    charge: 'ch_1',
    payment_intent: 'pi_1',
    amount: 10290,
    status: 'failed',
    failure_reason: 'insufficient_funds',
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    paymentRow = {
      id: 'pay-1',
      status: 'refunded',
      amount: '102.90',
      refund_amount: '102.90',
      stripe_refund_id: 're_fail',
      stripe_charge_id: 'ch_1',
      metadata: null,
    };
    trxUpdate = jest.fn().mockResolvedValue(1);
    notificationInsert = jest.fn().mockResolvedValue([1]);

    const trxPaymentsQuery = {
      where: jest.fn(() => trxPaymentsQuery),
      forUpdate: jest.fn(() => trxPaymentsQuery),
      first: jest.fn(async () => paymentRow),
      update: trxUpdate,
    };
    const trx = jest.fn((table) => {
      if (table === 'payments') return trxPaymentsQuery;
      throw new Error(`Unexpected trx table: ${table}`);
    });

    const paymentsQuery = {
      where: jest.fn(() => paymentsQuery),
      first: jest.fn(async () => paymentRow),
    };
    db.mockImplementation((table) => {
      if (table === 'payments') return paymentsQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      throw new Error(`Unexpected db table: ${table}`);
    });
    db.transaction.mockImplementation(async (cb) => cb(trx));
  });

  test('full-refund bounce reverts the row to collected and notifies', async () => {
    await handleRefundFailed(failedRefund());

    expect(trxUpdate).toHaveBeenCalledTimes(1);
    const args = trxUpdate.mock.calls[0][0];
    expect(args.refund_amount).toBe(0);
    expect(args.refund_status).toBe('failed');
    expect(args.status).toBe('paid');
    expect(JSON.parse(args.metadata).failed_refund_ids).toEqual(['re_fail']);

    expect(notificationInsert).toHaveBeenCalledTimes(1);
    const note = notificationInsert.mock.calls[0][0];
    expect(note.recipient_type).toBe('admin');
    expect(note.title).toContain('102.90');
    expect(note.body).toContain('reverted to collected');
  });

  test('partial bounce keeps the earlier cleared partial (no status flip)', async () => {
    paymentRow.status = 'paid';
    paymentRow.refund_amount = '51.45';
    await handleRefundFailed(failedRefund({ amount: 2500 }));

    const args = trxUpdate.mock.calls[0][0];
    expect(args.refund_amount).toBe(26.45);
    expect(args.refund_status).toBe('partial');
    expect(args.status).toBeUndefined();
  });

  test('bounce of the FINAL partial reverts a refunded row to paid even with a surviving remainder', async () => {
    // Two partials summed to full ($102.90 = refunded); the second ($51.45)
    // bounces. The remainder ($51.45) survives, but the row is no longer
    // fully refunded — leaving status='refunded' would keep it inside the
    // dashboard's full-refund exclusion while half the money is collected.
    paymentRow.status = 'refunded';
    paymentRow.refund_amount = '102.90';
    await handleRefundFailed(failedRefund({ amount: 5145 }));

    const args = trxUpdate.mock.calls[0][0];
    expect(args.refund_amount).toBe(51.45);
    expect(args.refund_status).toBe('partial');
    expect(args.status).toBe('paid');
  });

  test('rewinds the refunded-surcharge tracker so a retry re-sends the full share', async () => {
    // Surcharged payment fully refunded (tracker 290¢), then the grossed
    // $51.45 partial bounces → tracker must shrink to the share of what
    // actually cleared (round(5145×290/10290) = 145¢), or the retry would
    // read the bounced share as already returned and under-refund.
    paymentRow.status = 'refunded';
    paymentRow.card_surcharge = '2.90';
    paymentRow.refund_amount = '102.90';
    paymentRow.metadata = JSON.stringify({ refunded_surcharge_cents: 290 });
    await handleRefundFailed(failedRefund({ amount: 5145 }));

    const args = trxUpdate.mock.calls[0][0];
    expect(JSON.parse(args.metadata).refunded_surcharge_cents).toBe(145);
  });

  test('never invents a tracker on legacy rows that had none', async () => {
    paymentRow.card_surcharge = '2.90';
    paymentRow.metadata = null;
    await handleRefundFailed(failedRefund({ amount: 5145 }));

    const args = trxUpdate.mock.calls[0][0];
    expect(JSON.parse(args.metadata).refunded_surcharge_cents).toBeUndefined();
  });

  test('replay (same refund id already recorded) changes nothing and does NOT re-notify', async () => {
    paymentRow.metadata = JSON.stringify({ failed_refund_ids: ['re_fail'] });
    await handleRefundFailed(failedRefund());

    expect(trxUpdate).not.toHaveBeenCalled();
    expect(notificationInsert).not.toHaveBeenCalled();
  });

  test('no payments row (estimate-deposit refund) still notifies with the deposit hint', async () => {
    const emptyQuery = {
      where: jest.fn(() => emptyQuery),
      first: jest.fn(async () => undefined),
    };
    db.mockImplementation((table) => {
      if (table === 'payments') return emptyQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      throw new Error(`Unexpected db table: ${table}`);
    });

    await handleRefundFailed(failedRefund());

    expect(db.transaction).not.toHaveBeenCalled();
    expect(notificationInsert).toHaveBeenCalledTimes(1);
    expect(notificationInsert.mock.calls[0][0].body).toContain('deposit ledger');
  });
});
