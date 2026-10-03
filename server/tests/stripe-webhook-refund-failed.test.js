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
// virtual is correct here and ONLY here: tests/stripe-webhook-helpers.js does
// not exist (the real module is ../routes/stripe-webhook-helpers, mocked
// below), so there is no real resolution for this name to bypass to.
jest.mock('./stripe-webhook-helpers', () => ({ classifyExistingWebhookEvent: jest.fn(), STALE_CLAIM_WINDOW_MS: 60000 }), { virtual: true });
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
jest.mock('../services/invoice-helpers', () => ({ ...jest.requireActual('../services/invoice-helpers'), INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn() }));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(), acquireTermiteGateForCharge: jest.fn(async () => []), withTermiteGateForCharge: jest.fn(async (_keys, fn) => fn()), acquireTermiteGateAtEntry: jest.fn(async () => undefined), suspendActiveTermsForDisputedInvoice: jest.fn(async () => undefined) }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })), handleDepositDisputeClosed: jest.fn(async () => ({ handled: false })) }));
// Fee-lane detection's guarded fallback retrieves the PI when no local
// pointer row exists; model Stripe answering "not a fee PI" so the
// unlocked fence path stays exercisable (detection failures now throw).
jest.mock('../services/stripe', () => ({
  ...jest.requireActual('../services/stripe'),
  retrievePaymentIntent: jest.fn(async (piId) => ({ id: piId, metadata: {} })),
}));

const db = require('../models/db');
const AnnualPrepay = require('../services/annual-prepay-renewals');
const {
  _handleRefundFailed: handleRefundFailed,
  _handleChargeRefunded: handleChargeRefunded,
  _resolveOrphanSucceededPaymentIntentIfSettled: resolveOrphanSucceededPaymentIntentIfSettled,
  _withDisputeRenewalGate: withDisputeRenewalGate,
  _handleDisputeCreated: handleDisputeCreated,
  _handleDisputeClosed: handleDisputeClosed,
} = require('../routes/stripe-webhook');

// The admin brevity guard keeps a long notification's whole text in `detail`.
const fullText = (row) => row.detail || row.body;

describe('resolveOrphanSucceededPaymentIntentIfSettled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('resolves a quarantined public PaymentIntent only after that exact intent settled the invoice', async () => {
    const orphanUpdate = jest.fn().mockResolvedValue(1);
    const makeLookup = (row) => {
      const query = {
        where: jest.fn(() => query),
        first: jest.fn(async () => row),
      };
      return query;
    };
    const invoiceQuery = makeLookup({ id: 'inv-1' });
    const paymentQuery = makeLookup({ id: 'pay-1' });
    const orphanQuery = {
      where: jest.fn(() => orphanQuery),
      update: orphanUpdate,
    };
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoiceQuery;
      if (table === 'payments') return paymentQuery;
      if (table === 'stripe_orphan_charges') return orphanQuery;
      if (table === 'appointment_card_requests') return { where: () => ({ first: async () => undefined }) };
      throw new Error(`Unexpected db table: ${table}`);
    });

    await expect(resolveOrphanSucceededPaymentIntentIfSettled('pi_public')).resolves.toBe(true);
    expect(invoiceQuery.where).toHaveBeenCalledWith({ stripe_payment_intent_id: 'pi_public', status: 'paid' });
    expect(paymentQuery.where).toHaveBeenCalledWith({ stripe_payment_intent_id: 'pi_public', status: 'paid' });
    expect(orphanQuery.where).toHaveBeenCalledWith({ stripe_payment_intent_id: 'pi_public', resolved: false });
    expect(orphanUpdate).toHaveBeenCalledWith(expect.objectContaining({ resolved: true }));
  });

  test('leaves quarantine open when a competing saved-card intent settled instead', async () => {
    const invoiceQuery = {
      where: jest.fn(() => invoiceQuery),
      first: jest.fn(async () => null),
    };
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoiceQuery;
      if (table === 'appointment_card_requests') return { where: () => ({ first: async () => undefined }) };
      throw new Error(`Unexpected db table: ${table}`);
    });

    await expect(resolveOrphanSucceededPaymentIntentIfSettled('pi_public')).resolves.toBe(false);
    expect(db).not.toHaveBeenCalledWith('stripe_orphan_charges');
  });
});

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
    // Builder-shaped: the bounce notification now lands via
    // NotificationService.create (bell-policy chokepoint), which chains
    // .insert(row).returning('*').
    notificationInsert = jest.fn((row) => ({ returning: jest.fn(async () => [{ id: 'notif-1', ...row }]) }));

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
      // The reinstatement's office-handoff reconcile (no PAF setup handoffs here).
      if (table === 'dispatch_alerts') {
        const q = { where: () => q, whereRaw: () => q, select: async () => [] };
        return q;
      }
      // ...which first locks the fee's series: no setup-fee claim here.
      if (table === 'setup_fee_claims') {
        const q = { where: () => q, select: async () => [] };
        return q;
      }
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
      if (table === 'appointment_card_requests') return { where: () => ({ first: async () => undefined }) };
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
    expect(fullText(note)).toContain('reverted to collected');
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
    expect(fullText(notificationInsert.mock.calls[0][0])).toContain('WPC-2026-0001 was restored to paid');
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
    expect(fullText(notificationInsert.mock.calls[0][0])).toContain('WPC-2026-0001 was restored to paid');
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
    expect(fullText(notificationInsert.mock.calls[0][0])).toContain('WPC-2026-0002 was restored to paid');
  });

  test('names a refund-cancelled prepay term in the alert (revival is dispute-marker-gated)', async () => {
    dbInvoices.first.mockResolvedValue({ id: 'inv-1', invoice_number: 'WPC-2026-0001', status: 'refunded' });
    dbPrepayTerms.first.mockResolvedValue({ id: 'term-9' });
    await handleRefundFailed(failedRefund());

    const body = fullText(notificationInsert.mock.calls[0][0]);
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
    expect(fullText(notificationInsert.mock.calls[0][0])).toContain('left untouched');
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
      if (table === 'appointment_card_requests') return { where: () => ({ first: async () => undefined }) };
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
    expect(fullText(notificationInsert.mock.calls[0][0])).toContain('Deposit dep-1');

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
      if (table === 'appointment_card_requests') return { where: () => ({ first: async () => undefined }) };
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
    // NotificationService.create swallows the DB error into null; the
    // webhook's wrapper converts that back into a throw so the fence
    // transaction still rolls back and Stripe retries.
    notificationInsert.mockImplementation(() => ({
      returning: jest.fn(async () => { throw new Error('insert failed'); }),
    }));
    db.mockImplementation((table) => {
      if (table === 'payments') return emptyQuery;
      if (table === 'estimate_deposits') return depQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      if (table === 'appointment_card_requests') return { where: () => ({ first: async () => undefined }) };
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
      if (table === 'appointment_card_requests') return emptyQuery;
      if (table === 'stripe_failed_refunds') return fenceQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      throw new Error(`Unexpected db table: ${table}`);
    });
    db.schema = { hasTable: jest.fn(async () => true) };
    // The fence write now serializes with charge.refunded's combined
    // pre-settlement marker on a per-charge advisory lock (codex #3427 r9).
    db.raw = jest.fn(async () => ({}));
    db.transaction.mockImplementation(async (cb) => cb(db));

    await handleRefundFailed(failedRefund());
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.raw).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['combined.refund.fence', 'ch_1'],
    );
    expect(fenceInsert).toHaveBeenCalledWith(expect.objectContaining({
      stripe_refund_id: 're_fail',
      stripe_charge_id: 'ch_1',
      stripe_payment_intent_id: 'pi_1',
    }));
    expect(notificationInsert).toHaveBeenCalledTimes(1);
    expect(fullText(notificationInsert.mock.calls[0][0])).toContain('fenced');

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
      if (table === 'appointment_card_requests') return { where: () => ({ first: async () => undefined }) };
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

  test('fee charge.refunded fenced while waiting for the lock → no stamp, no refund comms (r26)', async () => {
    // The unlocked probes see nothing, refund.failed commits its fence
    // while this handler waits for the fee lock — the in-lock re-read must
    // catch it and skip the stamp + side effects entirely.
    let fenceReads = 0;
    const fenceQuery = {
      where: jest.fn(() => fenceQuery),
      first: jest.fn(async () => (++fenceReads >= 2 ? { stripe_refund_id: 're_fail' } : undefined)),
    };
    const paymentUpdates = [];
    const paymentsQuery = {
      where: jest.fn(() => paymentsQuery),
      first: jest.fn(async () => ({ id: 'pay-1', metadata: null, statement_id: null, customer_id: 'cust-1' })),
      update: jest.fn(async (patch) => { paymentUpdates.push(patch); return 1; }),
    };
    const emptyQuery = { where: jest.fn(() => emptyQuery), first: jest.fn(async () => undefined) };
    db.mockImplementation((table) => {
      if (table === 'stripe_failed_refunds') return fenceQuery;
      if (table === 'payments') return paymentsQuery;
      if (table === 'payer_statements') return emptyQuery;
      if (table === 'appointment_card_requests') return emptyQuery;
      throw new Error(`Unexpected db table: ${table}`);
    });
    db.schema = { hasTable: jest.fn(async () => true) };
    db.raw = jest.fn(async () => ({}));
    db.transaction.mockImplementation(async (cb) => cb(db));

    await handleChargeRefunded({
      id: 'ch_1',
      payment_intent: 'pi_1',
      metadata: { purpose: 'appointment_card_no_show_fee' },
      amount: 4900,
      amount_refunded: 4900,
      refunded: true,
      refunds: { data: [{ id: 're_fail', amount: 4900, created: 1751000000 }] },
    });
    expect(db.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['appointment_card_no_show_fee:pi_1']);
    expect(paymentUpdates).toHaveLength(0);
    expect(notificationInsert).not.toHaveBeenCalled();
    expect(require('../services/payment-lifecycle-email').sendRefundIssued).not.toHaveBeenCalled();
    expect(require('../services/notification-triggers').triggerNotification).not.toHaveBeenCalled();
  });

  test('no payments row (estimate-deposit refund) still notifies with the deposit hint', async () => {
    const emptyQuery = {
      where: jest.fn(() => emptyQuery),
      first: jest.fn(async () => undefined),
    };
    db.mockImplementation((table) => {
      if (table === 'payments') return emptyQuery;
      if (table === 'notifications') return { insert: notificationInsert };
      if (table === 'appointment_card_requests') return { where: () => ({ first: async () => undefined }) };
      throw new Error(`Unexpected db table: ${table}`);
    });

    await handleRefundFailed(failedRefund());

    expect(db.transaction).not.toHaveBeenCalled();
    expect(notificationInsert).toHaveBeenCalledTimes(1);
    expect(fullText(notificationInsert.mock.calls[0][0])).toContain('deposit ledger');
  });
});

// Codex #4971 r11 P1: the dispute handlers run under the renewal gate for the
// disputed money's termite terms (resolved from the charge / PaymentIntent),
// held across their separate ledger and invoice transactions.
describe('dispute handlers hold the renewal gate', () => {
  test('withDisputeRenewalGate resolves the gate from the disputed charge and PaymentIntent and runs the handler inside it', async () => {
    const handler = jest.fn(async () => 'handled');
    await expect(withDisputeRenewalGate({ id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1' }, handler)).resolves.toBe('handled');
    expect(AnnualPrepay.withTermiteGateForCharge).toHaveBeenCalledWith({ chargeId: 'ch_1', paymentIntentId: 'pi_1' }, handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('both charge.dispute.created and charge.dispute.closed dispatch through it (source contract)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'stripe-webhook.js'), 'utf8');
    expect(src).toContain("case 'charge.dispute.created':\n          await withDisputeRenewalGate(event.data.object, () => handleDisputeCreated(event.data.object));");
    expect(src).toContain("case 'charge.dispute.closed':\n          await withDisputeRenewalGate(event.data.object, () => handleDisputeClosed(event.data.object));");
  });
});


// B05: a card settle writes invoices.total = cash charged + credit_applied, so the
// 2.9% surcharge sits in `total` as principal. A chargeback returns the whole charge
// and reopens the invoice — which must ask for the invoice's own amount again, not the
// surcharge, and a won dispute must put the invoice back in the paid state it was in.
describe('dispute reopen takes the card surcharge back out of invoices.total (B05)', () => {
  const NotificationService = require('../services/notification-service');
  const { computeChargeAmount } = jest.requireActual('../services/stripe-pricing');
  const { invoiceAmountDue } = jest.requireActual('../services/invoice-helpers');
  let tables;
  let beforeTransaction;
  let afterPaymentRead;

  // Stateful stand-in for the two tables the dispute handlers touch; every other
  // table reads empty. Enough query surface for handleDisputeCreated/Closed.
  function query(table) {
    const rows = tables[table] || [];
    const filters = [];
    const q = {};
    const pick = () => rows.filter((r) => filters.every((f) => f(r)));
    q.where = (arg, val) => {
      if (typeof arg === 'function') return q;
      if (typeof arg === 'string') filters.push((r) => r[arg] === val);
      else filters.push((r) => Object.entries(arg).every(([k, v]) => r[k] === v));
      return q;
    };
    q.whereNotIn = (col, vals) => { filters.push((r) => !vals.includes(r[col])); return q; };
    q.forUpdate = () => q;
    q.orderBy = () => q;
    q.whereExists = () => q;
    q.whereIn = () => q;
    q.first = async (...cols) => {
      const found = pick()[0];
      const snapshot = found && { ...found }; // a read is a point-in-time copy, like the database
      if (table === 'payments' && !cols.length && afterPaymentRead) {
        const hook = afterPaymentRead;
        afterPaymentRead = null;
        await hook(); // another handler commits between this read and the caller's next step
      }
      return snapshot;
    };
    q.update = async (patch) => { pick().forEach((r) => Object.assign(r, patch)); return pick().length; };
    q.insert = async () => [1];
    q.then = (res, rej) => Promise.resolve(pick()).then(res, rej);
    return q;
  }
  const row = (table, id) => tables[table].find((r) => r.id === id);
  const meta = (p) => JSON.parse(p.metadata);

  // A $1,000 invoice paid by credit card: surcharge $29, settle wrote total = 1029.
  const seed = ({ credit = 0, surchargeCents = 2900, cashCents = 102900, total } = {}) => {
    tables = {
      invoices: [{
        id: 'inv_1', status: 'paid', paid_at: '2026-10-01T00:00:00Z', stripe_payment_intent_id: 'pi_card', stripe_charge_id: 'ch_card',
        subtotal: '1000.00', discount_amount: '0.00', tax_amount: '0.00', credit_applied: String(credit),
        total: String(total ?? ((cashCents / 100) + credit)),
      }],
      payments: [{
        id: 'pay_1', status: 'paid', amount: String(cashCents / 100), surcharge_amount_cents: surchargeCents,
        stripe_payment_intent_id: 'pi_card', stripe_charge_id: 'ch_card', metadata: JSON.stringify({ invoice_id: 'inv_1' }),
      }],
    };
  };
  const dispute = { id: 'dp_1', charge: 'ch_card', payment_intent: 'pi_card', amount: 102900, reason: 'fraudulent', status: 'needs_response' };
  const total = () => Number(row('invoices', 'inv_1').total);
  const nextCardTotal = () => computeChargeAmount(invoiceAmountDue(row('invoices', 'inv_1')), 'card', { funding: 'credit' }).total;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue(undefined);
    db.mockImplementation((table) => query(table));
    beforeTransaction = null;
    afterPaymentRead = null;
    db.transaction.mockImplementation(async (cb) => {
      // Lets a test land a concurrent writer between a handler's unlocked read and its transaction.
      if (beforeTransaction) { const hook = beforeTransaction; beforeTransaction = null; await hook(); }
      const trx = (table) => query(table);
      trx.raw = jest.fn(async () => undefined);
      trx.fn = { now: () => 'NOW' };
      return cb(trx);
    });
    db.fn = { now: () => 'NOW' };
  });

  test('dispute created reopens at the invoice\'s own amount, and the next card quote surcharges that base only', async () => {
    seed();
    expect(nextCardTotal()).toBe(1058.84); // what the bug charged: surcharge on the surcharged 1029

    await handleDisputeCreated(dispute);

    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'overdue', paid_at: null, stripe_payment_intent_id: null });
    expect(total()).toBe(1000);
    expect(nextCardTotal()).toBe(1029);
    expect(meta(row('payments', 'pay_1'))).toMatchObject({ dispute_invoice_id: 'inv_1' });
  });

  test('a replay of the created event, or the lost closure after it, subtracts nothing more', async () => {
    seed();
    await handleDisputeCreated(dispute);
    await handleDisputeCreated(dispute);
    expect(total()).toBe(1000);

    await handleDisputeClosed({ ...dispute, status: 'lost' });
    expect(total()).toBe(1000);
    expect(row('invoices', 'inv_1').status).toBe('overdue');
  });

  test('a lost closure with no created event reopens at the invoice\'s own amount, once', async () => {
    seed();
    await handleDisputeClosed({ ...dispute, status: 'lost' });
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'overdue', stripe_payment_intent_id: null });
    expect(total()).toBe(1000);
    await handleDisputeClosed({ ...dispute, status: 'lost' });
    expect(total()).toBe(1000);
  });

  test('a payment with no surcharge (bank, cash, legacy NULL) reopens with total unchanged', async () => {
    for (const surcharge of [0, null, undefined]) {
      seed({ surchargeCents: surcharge, cashCents: 100000 });
      await handleDisputeCreated(dispute);
      expect(row('invoices', 'inv_1').status).toBe('overdue');
      expect(total()).toBe(1000);
    }
  });

  test('a total that is not the settled shape (edited since the settle) is not reduced', async () => {
    seed({ total: 1000 }); // payments.amount 1029 but the invoice total no longer equals cash + credit
    await handleDisputeCreated(dispute);
    expect(row('invoices', 'inv_1').status).toBe('overdue');
    expect(total()).toBe(1000);
  });

  test('with account credit applied, total and credit stay consistent (amount due = the invoice\'s own balance)', async () => {
    // $1,000 invoice, $200 credit: customer owed $800, paid $800 + $23.20 = $823.20; settle wrote total = 823.20 + 200.
    seed({ credit: 200, surchargeCents: 2320, cashCents: 82320 });
    expect(total()).toBe(1023.2);
    await handleDisputeCreated(dispute);
    expect(total()).toBe(1000);
    expect(Number(row('invoices', 'inv_1').credit_applied)).toBe(200);
    expect(invoiceAmountDue(row('invoices', 'inv_1'))).toBe(800);
    expect(nextCardTotal()).toBe(823.2);
  });

  test('never reduces total below the invoice\'s line items', async () => {
    seed();
    row('invoices', 'inv_1').subtotal = '1029.00'; // the invoice really bills 1029
    await handleDisputeCreated(dispute);
    expect(row('invoices', 'inv_1').status).toBe('overdue');
    expect(total()).toBe(1029);
    // The put-back only restores what the reopen took: a refused removal leaves nothing to add back.
    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(row('invoices', 'inv_1').status).toBe('paid');
    expect(total()).toBe(1029);
  });

  test('won leaves a total that is neither the settled nor the reopened shape alone (edited invoice)', async () => {
    seed();
    await handleDisputeCreated(dispute);
    row('invoices', 'inv_1').total = '1111.00'; // re-totalled by an edit while reopened
    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(row('invoices', 'inv_1').status).toBe('paid');
    expect(total()).toBe(1111);
  });

  test('dispute won afterwards puts the invoice back to its paid state (total = cash + credit) once', async () => {
    seed({ credit: 200, surchargeCents: 2320, cashCents: 82320 });
    await handleDisputeCreated(dispute);
    expect(total()).toBe(1000);

    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_card' });
    expect(total()).toBe(1023.2);
    expect(meta(row('payments', 'pay_1'))).toMatchObject({ dispute_final: 'won' });

    await handleDisputeClosed({ ...dispute, status: 'won' }); // replay
    expect(total()).toBe(1023.2);
  });

  test('a won dispute never touches an invoice a replacement payment now owns', async () => {
    seed();
    await handleDisputeCreated(dispute);
    // Customer re-paid with a new card payment (surcharged on the corrected 1000 base).
    Object.assign(row('invoices', 'inv_1'), { status: 'paid', stripe_payment_intent_id: 'pi_new', total: '1029.00' });
    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_new' });
    expect(total()).toBe(1029);
  });

  // A replacement card payment settles (invoice paid again under a new PI, total 1029 = 1000 + the
  // surcharge on the corrected base) after the handler's unlocked read, before its transaction locks the row.
  const replacementSettles = () => Object.assign(row('invoices', 'inv_1'), {
    status: 'paid', stripe_payment_intent_id: 'pi_new', stripe_charge_id: 'ch_new', total: '1029.00', paid_at: '2026-10-02T00:00:00Z',
  });
  const replacementOwnsInvoice = () => {
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_new', stripe_charge_id: 'ch_new', paid_at: '2026-10-02T00:00:00Z' });
    expect(total()).toBe(1029);
  };

  test('won: a replacement that settles between the read and the transaction keeps its PI and total — no old surcharge added', async () => {
    seed();
    await handleDisputeCreated(dispute);

    beforeTransaction = replacementSettles;
    await handleDisputeClosed({ ...dispute, status: 'won' });
    replacementOwnsInvoice();
    // A replay changes nothing.
    expect(meta(row('payments', 'pay_1'))).toMatchObject({ dispute_final: 'won' });
    await handleDisputeClosed({ ...dispute, status: 'won' });
    replacementOwnsInvoice();
  });

  test('created: an invoice a replacement payment took after the read is not reopened or reduced', async () => {
    seed();
    beforeTransaction = replacementSettles;
    await handleDisputeCreated(dispute);
    replacementOwnsInvoice();
  });

  test('lost: an invoice a replacement payment took after the read is not reopened or reduced', async () => {
    seed();
    beforeTransaction = replacementSettles;
    await handleDisputeClosed({ ...dispute, status: 'lost' });
    replacementOwnsInvoice();
  });

  // created and closed run on separate webhook deliveries with no shared lock around their payment
  // reads, so each order is checked: a paid invoice ends at cash + credit, a reopened one at its own amount.
  test('interleaved: won reads the payment before created commits, then restores the invoice created reopened', async () => {
    seed();
    afterPaymentRead = () => handleDisputeCreated(dispute); // created commits right after won's payment read
    await handleDisputeClosed({ ...dispute, status: 'won' });
    // won wrote its stale view of the payment's metadata over created's; the total never depended on it.
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_card' });
    expect(total()).toBe(1029);
    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(total()).toBe(1029);
  });

  test('interleaved: won commits between created\'s read and its transaction — created finds the final outcome and never reopens', async () => {
    seed();
    afterPaymentRead = () => handleDisputeClosed({ ...dispute, status: 'won' }); // won commits right after created's read
    await handleDisputeCreated(dispute);
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_card' });
    expect(total()).toBe(1029);
    // The payment keeps the won outcome: created's own flip is refused under the payment lock too.
    expect(row('payments', 'pay_1').status).toBe('paid');
    expect(meta(row('payments', 'pay_1'))).toMatchObject({ dispute_final: 'won' });
  });

  test('interleaved: won commits after created\'s unlocked invoice read, before its transaction — still never reopened', async () => {
    seed();
    beforeTransaction = () => handleDisputeClosed({ ...dispute, status: 'won' });
    await handleDisputeCreated(dispute);
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_card' });
    expect(total()).toBe(1029);
    expect(row('payments', 'pay_1').status).toBe('paid');
  });

  test('interleaved: lost commits first — created does not undo the final outcome and the invoice stays at its own amount', async () => {
    seed();
    afterPaymentRead = () => handleDisputeClosed({ ...dispute, status: 'lost' });
    await handleDisputeCreated(dispute);
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'overdue', stripe_payment_intent_id: null });
    expect(total()).toBe(1000);
    expect(meta(row('payments', 'pay_1'))).toMatchObject({ dispute_final: 'lost' });
  });

  test('won before created: the late created event is suppressed and the paid invoice stays at cash + credit', async () => {
    seed();
    await handleDisputeClosed({ ...dispute, status: 'won' });
    await handleDisputeCreated(dispute);
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_card' });
    expect(total()).toBe(1029);
  });

  // Finding: a ledger-backed estimate deposit credit lowers what the invoice bills (subtotal - discount +
  // tax - deposit), so it must lower the removal floor too.
  test('an invoice with a deposit credit line still gets the surcharge removed (floor includes the deposit)', async () => {
    // $1,000 invoice, $200 deposit credit: principal $800; card surcharge 2.9% = $23.20; settle wrote 823.20.
    seed({ surchargeCents: 2320, cashCents: 82320 });
    row('invoices', 'inv_1').line_items = JSON.stringify([
      { description: 'Service', quantity: 1, unit_price: 1000, amount: 1000 },
      { description: 'Deposit credit (paid at acceptance)', quantity: 1, unit_price: -200, amount: -200, category: 'deposit_credit' },
    ]);
    expect(total()).toBe(823.2);
    await handleDisputeCreated(dispute);
    expect(row('invoices', 'inv_1').status).toBe('overdue');
    expect(total()).toBe(800);
    expect(nextCardTotal()).toBe(823.2);
    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(total()).toBe(823.2);
  });

  // Finding: the refund-shaped term clawback must follow the LOCKED ownership, not the pre-lock read.
  test('lost: a replacement that took the invoice before the lock suppresses the term clawback', async () => {
    seed();
    beforeTransaction = replacementSettles;
    await handleDisputeClosed({ ...dispute, status: 'lost' });
    replacementOwnsInvoice();
    expect(AnnualPrepay.syncTermForInvoicePayment).not.toHaveBeenCalled();
  });

  test('lost: the disputed payment still owns the invoice — reopened and the term clawback runs once', async () => {
    seed();
    await handleDisputeClosed({ ...dispute, status: 'lost' });
    expect(row('invoices', 'inv_1').status).toBe('overdue');
    expect(AnnualPrepay.syncTermForInvoicePayment).toHaveBeenCalledTimes(1);
    expect(AnnualPrepay.syncTermForInvoicePayment).toHaveBeenCalledWith({ id: 'inv_1', status: 'refunded', paid_at: null });
    // A Stripe retry after the reopen still finds the invoice through the stored binding.
    await handleDisputeClosed({ ...dispute, status: 'lost' });
    expect(AnnualPrepay.syncTermForInvoicePayment).toHaveBeenCalledTimes(2);
  });

  test('lost after created: a replacement that took the invoice in between suppresses the clawback', async () => {
    seed();
    await handleDisputeCreated(dispute);
    Object.assign(row('invoices', 'inv_1'), { status: 'paid', stripe_payment_intent_id: 'pi_new', total: '1029.00' });
    await handleDisputeClosed({ ...dispute, status: 'lost' });
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_new' });
    expect(AnnualPrepay.syncTermForInvoicePayment).not.toHaveBeenCalled();
  });

  // Finding (round 2): account credit applied while the invoice is reopened raises credit_applied
  // without touching total, so the put-back must not re-derive the reopened total from the credit.
  const applyCreditWhileReopened = (cents) => { row('invoices', 'inv_1').credit_applied = String(cents / 100); };

  test('won after $200 credit was applied during the reopen: the surcharge still goes back, the credit is left as applied', async () => {
    seed(); // $1,000 invoice paid as $1,029
    await handleDisputeCreated(dispute);
    expect(total()).toBe(1000);
    applyCreditWhileReopened(20000); // customer-credit.js: credit_applied up, total unchanged
    expect(total()).toBe(1000);

    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(row('invoices', 'inv_1')).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_card' });
    expect(total()).toBe(1029);
    // Business question, not moved here: the customer is now over-credited by the $200.
    expect(Number(row('invoices', 'inv_1').credit_applied)).toBe(200);
    // Replay: nothing moves.
    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(total()).toBe(1029);
  });

  test('credit applied at settle time, then another $50 during the reopen, then won: total returns to cash + settle credit', async () => {
    seed({ credit: 200, surchargeCents: 2320, cashCents: 82320 });
    await handleDisputeCreated(dispute);
    expect(total()).toBe(1000);
    applyCreditWhileReopened(25000);
    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(total()).toBe(1023.2);
  });

  test('credit applied during the reopen, then LOST: the reopened total stays at the invoice\'s own amount', async () => {
    seed();
    await handleDisputeCreated(dispute);
    applyCreditWhileReopened(20000);
    await handleDisputeClosed({ ...dispute, status: 'lost' });
    expect(row('invoices', 'inv_1').status).toBe('overdue');
    expect(total()).toBe(1000);
    expect(Number(row('invoices', 'inv_1').credit_applied)).toBe(200);
  });

  test('won leaves an invoice re-totalled while reopened alone, credit or not', async () => {
    seed();
    await handleDisputeCreated(dispute);
    applyCreditWhileReopened(20000);
    row('invoices', 'inv_1').total = '950.00';
    await handleDisputeClosed({ ...dispute, status: 'won' });
    expect(row('invoices', 'inv_1').status).toBe('paid');
    expect(total()).toBe(950);
  });
});
