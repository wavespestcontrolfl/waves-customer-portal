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
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));

const db = require('../models/db');
const AnnualPrepay = require('../services/annual-prepay-renewals');
const { _handleRefundFailed: handleRefundFailed, _handleChargeRefunded: handleChargeRefunded } = require('../routes/stripe-webhook');

describe('handleRefundFailed', () => {
  let paymentRow;
  let trxUpdate;
  let trxInvoices;
  let notificationInsert;
  let paymentsFirst;
  let dbInvoices;
  let dbPrepayTerms;

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
    trxInvoices = {
      where: jest.fn(() => trxInvoices),
      first: jest.fn(async () => null),
      update: jest.fn().mockResolvedValue(1),
    };
    const trxInvoicesQuery = trxInvoices;
    const trx = jest.fn((table) => {
      if (table === 'payments') return trxPaymentsQuery;
      if (table === 'invoices') return trxInvoicesQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      throw new Error(`Unexpected trx table: ${table}`);
    });

    paymentsFirst = jest.fn(async () => paymentRow);
    const paymentsQuery = {
      where: jest.fn(() => paymentsQuery),
      first: paymentsFirst,
    };
    dbInvoices = {
      where: jest.fn(() => dbInvoices),
      first: jest.fn(async () => null),
    };
    dbPrepayTerms = {
      where: jest.fn(() => dbPrepayTerms),
      first: jest.fn(async () => null),
    };
    db.mockImplementation((table) => {
      if (table === 'payments') return paymentsQuery;
      if (table === 'invoices') return dbInvoices;
      if (table === 'annual_prepay_terms') return dbPrepayTerms;
      if (table === 'notifications') return { insert: notificationInsert };
      throw new Error(`Unexpected db table: ${table}`);
    });
    db.transaction.mockImplementation(async (cb) => cb(trx));
    // Pre-migration default: the stripe_failed_refunds fence table is absent.
    db.schema = { hasTable: jest.fn(async () => false) };
  });

  test('full-refund bounce reverts the row to collected and notifies', async () => {
    await handleRefundFailed(failedRefund());

    expect(trxUpdate).toHaveBeenCalledTimes(1);
    const args = trxUpdate.mock.calls[0][0];
    expect(args.refund_amount).toBe(0);
    // Fully-bounced refund = NO refund activity remains: refund_status must
    // clear (consumers treat any non-null value as refund activity — the
    // Refund button hides, prepay reconciliation skips) and the dangling
    // stripe_refund_id goes with it. Metadata keeps the durable record.
    expect(args.refund_status).toBeNull();
    expect(args.stripe_refund_id).toBeNull();
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
    paymentRow.surcharge_amount_cents = 290;
    paymentRow.refund_amount = '102.90';
    paymentRow.refunded_surcharge_cents = 290;
    await handleRefundFailed(failedRefund({ amount: 5145 }));

    const args = trxUpdate.mock.calls[0][0];
    expect(args.refunded_surcharge_cents).toBe(145);
  });

  test('never invents a tracker on legacy rows that had none', async () => {
    paymentRow.surcharge_amount_cents = 290;
    paymentRow.metadata = null;
    await handleRefundFailed(failedRefund({ amount: 5145 }));

    const args = trxUpdate.mock.calls[0][0];
    expect(args.refunded_surcharge_cents).toBeUndefined();
  });

  test('full-refund bounce restores a terminalized invoice back to paid and re-runs the prepay sync', async () => {
    // returnAppliedCreditOnRefund terminalized the invoice to 'refunded' at
    // creation time; Stripe kept the money, so 'refunded' is now false on
    // every surface. Status-only restore; credit stays a human decision.
    dbInvoices.first.mockResolvedValue({ id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'refunded' });
    await handleRefundFailed(failedRefund());

    expect(trxInvoices.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'paid' }));
    expect(notificationInsert.mock.calls[0][0].body).toContain('WPC-2026-0001 was restored to paid');
    // No payment_intent.succeeded ever fires for a bounce — the handler is
    // the only place coverage can re-sync.
    expect(AnnualPrepay.syncTermForInvoicePayment).toHaveBeenCalledWith('inv-1');
  });

  test('restore rides the conditional WHERE, not the stale pre-lock status read', async () => {
    // Race: this handler reads the invoice while charge.refunded is still
    // committing — the pre-lock read says 'paid', but by the time the
    // payments lock is acquired the invoice IS 'refunded'. The conditional
    // update must still restore it.
    dbInvoices.first.mockResolvedValue({ id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'paid' });
    await handleRefundFailed(failedRefund());

    expect(trxInvoices.where).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1', status: 'refunded' }));
    expect(trxInvoices.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'paid' }));
    expect(notificationInsert.mock.calls[0][0].body).toContain('WPC-2026-0001 was restored to paid');
  });

  test('reaches a charge-only linked invoice via invoices.stripe_charge_id', async () => {
    // Legacy reconciled payments have no PI on the invoice — charge.refunded
    // terminalizes through the charge-id fallback, so the bounce restore
    // must resolve the invoice the same way.
    dbInvoices.first
      .mockResolvedValueOnce(null) // PI lookup misses
      .mockResolvedValueOnce({ id: 'inv-2', invoice_number: 'WPC-2026-0002' });
    await handleRefundFailed(failedRefund());

    expect(dbInvoices.where).toHaveBeenCalledWith({ stripe_charge_id: 'ch_1' });
    expect(trxInvoices.where).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-2', status: 'refunded' }));
    expect(notificationInsert.mock.calls[0][0].body).toContain('WPC-2026-0002 was restored to paid');
  });

  test('names a refund-cancelled prepay term in the alert (revival is dispute-marker-gated)', async () => {
    dbInvoices.first.mockResolvedValue({ id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'refunded' });
    dbPrepayTerms.first.mockResolvedValue({ id: 'term-9' });
    await handleRefundFailed(failedRefund());

    const body = notificationInsert.mock.calls[0][0].body;
    expect(body).toContain('term term-9 was CANCELLED');
    expect(body).toContain('reactivate it manually');
  });

  test('rewinds an OLDER stamped partial via stamped_refund_ids after a newer stamp overwrote stripe_refund_id', async () => {
    // $40 (re_1) and $20 (re_2) both cleared and stamped; stripe_refund_id
    // now points at re_2. When re_1 bounces it must still be attributable —
    // and it leaves the stamped record, keeping re_2 rewindable later.
    paymentRow.status = 'paid';
    paymentRow.refund_amount = '60.00';
    paymentRow.stripe_refund_id = 're_2';
    paymentRow.metadata = JSON.stringify({ stamped_refund_ids: ['re_1', 're_2'] });
    await handleRefundFailed(failedRefund({ id: 're_1', amount: 4000 }));

    const args = trxUpdate.mock.calls[0][0];
    expect(args.refund_amount).toBe(20);
    expect(args.refund_status).toBe('partial');
    const meta = JSON.parse(args.metadata);
    expect(meta.failed_refund_ids).toEqual(['re_1']);
    expect(meta.stamped_refund_ids).toEqual(['re_2']);
  });

  test('bounce of the NEWEST partial repoints stripe_refund_id at the surviving stamp', async () => {
    // re_old ($40) cleared, re_fail ($20) stamped last and then bounced.
    // A remainder survives, so the id is not cleared — but it must stop
    // naming money Stripe kept and point at the surviving stamp instead.
    paymentRow.status = 'paid';
    paymentRow.refund_amount = '60.00';
    paymentRow.stripe_refund_id = 're_fail';
    paymentRow.metadata = JSON.stringify({ stamped_refund_ids: ['re_old', 're_fail'] });
    await handleRefundFailed(failedRefund({ amount: 2000 }));

    const args = trxUpdate.mock.calls[0][0];
    expect(args.refund_amount).toBe(40);
    expect(args.refund_status).toBe('partial');
    expect(args.stripe_refund_id).toBe('re_old');
    expect(JSON.parse(args.metadata).stamped_refund_ids).toEqual(['re_old']);
  });

  test('falls back to the PI lookup for ACH rows with no charge/refund id yet', async () => {
    // payment_intent.processing rows are keyed by PI only — the bounce must
    // still find them or it takes the notify-only path and the late
    // charge.refunded stamps the failed refund as successful.
    paymentsFirst
      .mockResolvedValueOnce(undefined) // by stripe_refund_id
      .mockResolvedValueOnce(undefined) // by stripe_charge_id
      .mockResolvedValueOnce(paymentRow); // by stripe_payment_intent_id
    await handleRefundFailed(failedRefund());

    expect(trxUpdate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(trxUpdate.mock.calls[0][0].metadata).failed_refund_ids).toEqual(['re_fail']);
  });

  test('UNSTAMPED bounce (arrived before its creation event) records the id but never rewinds amounts', async () => {
    // $40 already cleared and stamped; a NEW $20 refund bounces before its
    // charge.refunded arrives. refund_amount does not include it yet —
    // subtracting would erase the cleared $40. Only the id is recorded (so
    // the late creation stamp gets skipped) and the operator is told.
    paymentRow.status = 'paid';
    paymentRow.refund_amount = '40.00';
    paymentRow.stripe_refund_id = 're_earlier';
    await handleRefundFailed(failedRefund({ id: 're_new', amount: 2000 }));

    expect(trxUpdate).toHaveBeenCalledTimes(1);
    const args = trxUpdate.mock.calls[0][0];
    expect(args.refund_amount).toBeUndefined();
    expect(args.status).toBeUndefined();
    expect(JSON.parse(args.metadata).failed_refund_ids).toEqual(['re_new']);
    expect(notificationInsert).toHaveBeenCalledTimes(1);
    expect(notificationInsert.mock.calls[0][0].body).toContain('left untouched');
  });

  test('replay (same refund id already recorded) changes nothing and does NOT re-notify', async () => {
    paymentRow.metadata = JSON.stringify({ failed_refund_ids: ['re_fail'] });
    await handleRefundFailed(failedRefund());

    expect(trxUpdate).not.toHaveBeenCalled();
    expect(notificationInsert).not.toHaveBeenCalled();
  });

  test('deposit bounce records a durable fence on estimate_deposits and notifies once', async () => {
    // No payments row, but a deposit row matches the PI: the failed id is
    // written to failed_refund_ids so handleDepositChargeReversed refuses the
    // late creation event; the replay (second bounce event) does not
    // re-notify.
    const depositRow = { id: 'dep-1', status: 'received', failed_refund_ids: [] };
    const depUpdate = jest.fn().mockResolvedValue(1);
    const depQuery = {
      where: jest.fn(() => depQuery),
      forUpdate: jest.fn(() => depQuery),
      first: jest.fn(async () => depositRow),
      update: depUpdate,
      columnInfo: jest.fn(async () => ({ failed_refund_ids: {} })),
    };
    const emptyQuery = {
      where: jest.fn(() => emptyQuery),
      first: jest.fn(async () => undefined),
    };
    db.mockImplementation((table) => {
      if (table === 'payments') return emptyQuery;
      if (table === 'estimate_deposits') return depQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      throw new Error(`Unexpected db table: ${table}`);
    });
    // Fence + notification commit in ONE transaction — the trx routes
    // tables the same way as db.
    db.transaction.mockImplementation(async (cb) => cb(db));

    await handleRefundFailed(failedRefund());
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({
      failed_refund_ids: JSON.stringify(['re_fail']),
    }));
    expect(notificationInsert).toHaveBeenCalledTimes(1);
    expect(notificationInsert.mock.calls[0][0].body).toContain('Deposit dep-1');

    // Replay: fence already contains the id → no transaction, no re-notify.
    depositRow.failed_refund_ids = ['re_fail'];
    depUpdate.mockClear();
    notificationInsert.mockClear();
    db.transaction.mockClear();
    await handleRefundFailed(failedRefund());
    expect(db.transaction).not.toHaveBeenCalled();
    expect(depUpdate).not.toHaveBeenCalled();
    expect(notificationInsert).not.toHaveBeenCalled();
  });

  test('deposit fence appends to the LOCKED list, not the pre-transaction snapshot', async () => {
    // Two bounces for different partial refunds overlap: the pre-read saw
    // an empty list, but by the time this transaction holds the row lock a
    // concurrent handler committed re_other. Writing from the snapshot
    // would erase re_other and un-fence its late charge.refunded.
    const depUpdate = jest.fn().mockResolvedValue(1);
    const depQuery = {
      where: jest.fn(() => depQuery),
      forUpdate: jest.fn(() => depQuery),
      first: jest.fn()
        .mockResolvedValueOnce({ id: 'dep-1', status: 'received', failed_refund_ids: [] }) // pre-read
        .mockResolvedValueOnce({ status: 'received', failed_refund_ids: ['re_other'] }),   // locked re-read
      update: depUpdate,
      columnInfo: jest.fn(async () => ({ failed_refund_ids: {} })),
    };
    const emptyQuery = {
      where: jest.fn(() => emptyQuery),
      first: jest.fn(async () => undefined),
    };
    db.mockImplementation((table) => {
      if (table === 'payments') return emptyQuery;
      if (table === 'estimate_deposits') return depQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      throw new Error(`Unexpected db table: ${table}`);
    });
    db.transaction.mockImplementation(async (cb) => cb(db));

    await handleRefundFailed(failedRefund());
    expect(depUpdate).toHaveBeenCalledWith(expect.objectContaining({
      failed_refund_ids: JSON.stringify(['re_other', 're_fail']),
    }));
  });

  test('a notify failure inside the deposit-fence transaction propagates (Stripe retries the whole event)', async () => {
    // The fence must never commit without its notification — a committed
    // fence with a lost notify would make the retry hit the replay check
    // and ack silently, erasing the only operator signal.
    const depositRow = { id: 'dep-1', status: 'received', failed_refund_ids: [] };
    const depQuery = {
      where: jest.fn(() => depQuery),
      forUpdate: jest.fn(() => depQuery),
      first: jest.fn(async () => depositRow),
      update: jest.fn().mockResolvedValue(1),
      columnInfo: jest.fn(async () => ({ failed_refund_ids: {} })),
    };
    const emptyQuery = {
      where: jest.fn(() => emptyQuery),
      first: jest.fn(async () => undefined),
    };
    notificationInsert.mockRejectedValue(new Error('insert failed'));
    db.mockImplementation((table) => {
      if (table === 'payments') return emptyQuery;
      if (table === 'estimate_deposits') return depQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      throw new Error(`Unexpected db table: ${table}`);
    });
    db.transaction.mockImplementation(async (cb) => cb(db));

    await expect(handleRefundFailed(failedRefund())).rejects.toThrow('insert failed');
  });

  test('no payments row and no deposit: the refund id is fenced in stripe_failed_refunds, atomically with the notification', async () => {
    const fenceInsert = jest.fn().mockResolvedValue([1]);
    const fenceRow = { current: null };
    const fenceQuery = {
      where: jest.fn(() => fenceQuery),
      first: jest.fn(async () => fenceRow.current),
      insert: fenceInsert,
    };
    const emptyQuery = {
      where: jest.fn(() => emptyQuery),
      first: jest.fn(async () => undefined),
    };
    db.mockImplementation((table) => {
      if (table === 'payments') return emptyQuery;
      if (table === 'stripe_failed_refunds') return fenceQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      throw new Error(`Unexpected db table: ${table}`);
    });
    db.schema = { hasTable: jest.fn(async () => true) };
    db.transaction.mockImplementation(async (cb) => cb(db));

    await handleRefundFailed(failedRefund());
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(fenceInsert).toHaveBeenCalledWith(expect.objectContaining({
      stripe_refund_id: 're_fail',
      stripe_charge_id: 'ch_1',
      stripe_payment_intent_id: 'pi_1',
    }));
    expect(notificationInsert).toHaveBeenCalledTimes(1);
    expect(notificationInsert.mock.calls[0][0].body).toContain('fenced');

    // Replay: the fence row exists → no second insert, no re-notify.
    fenceRow.current = { stripe_refund_id: 're_fail' };
    fenceInsert.mockClear();
    notificationInsert.mockClear();
    db.transaction.mockClear();
    await handleRefundFailed(failedRefund());
    expect(db.transaction).not.toHaveBeenCalled();
    expect(fenceInsert).not.toHaveBeenCalled();
    expect(notificationInsert).not.toHaveBeenCalled();
  });

  test('charge.refunded for a pre-settlement-fenced refund is skipped entirely', async () => {
    // The bounce arrived before any payments row existed and was fenced —
    // the late creation event must not stamp, terminalize, or restore
    // credit. Every table except the fence throws: reaching any other
    // lookup means the guard failed.
    const fenceQuery = {
      where: jest.fn(() => fenceQuery),
      first: jest.fn(async () => ({ stripe_refund_id: 're_fail' })),
    };
    db.mockImplementation((table) => {
      if (table === 'stripe_failed_refunds') return fenceQuery;
      throw new Error(`Unexpected db table: ${table}`);
    });
    db.schema = { hasTable: jest.fn(async () => true) };

    await handleChargeRefunded({
      id: 'ch_1',
      payment_intent: 'pi_1',
      amount: 10290,
      amount_refunded: 5145,
      refunded: false,
      refunds: { data: [{ id: 're_fail', amount: 5145, created: 1751000000 }] },
    });
    expect(fenceQuery.where).toHaveBeenCalledWith({ stripe_refund_id: 're_fail' });
    expect(db.transaction).not.toHaveBeenCalled();
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
