/**
 * payment_intent.canceled — invoice revert for BOTH lanes.
 *
 * The processing handler stamps invoices.stripe_payment_intent_id and moves
 * the invoice to 'processing' for single-invoice ACH PIs exactly as it does
 * for combined PIs. The canceled handler reverted only the combined lane,
 * so a single-invoice ACH PI canceled after entering processing left the
 * invoice 'processing' forever (excluded from dunning, blocked from a
 * replacement payment). Contract:
 *  - payments row flips to canceled (unchanged);
 *  - every 'processing' invoice stamped with the PI reopens to the
 *    failure-path status (nextInvoiceStatusAfterFailedPayment), with the
 *    dead PI binding and the ACH-ack claim cleared — combined or not;
 *  - the combined-only stamp/residual cleanup still runs only for combined
 *    PIs; no customer notification is sent either way.
 */
jest.mock('stripe', () => jest.fn(() => ({ paymentIntents: { retrieve: jest.fn() } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('../services/autopay-eligibility', () => ({ isBankMethodType: jest.fn(() => true) }));
jest.mock('../routes/stripe-webhook-helpers', () => ({
  classifyExistingWebhookEvent: jest.fn(),
  invoicePaymentIntentBlocksFallback: jest.fn(() => false),
  lateSavedCardPaymentNeedsOrphan: jest.fn(() => false),
  savedCardAttemptMatchesPaymentIntent: jest.fn(() => false),
  savedCardCreditAdjustment: jest.fn(() => null),
  STALE_CLAIM_WINDOW_MS: 60000,
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'msg') }));
jest.mock('../services/stripe-invoice-state', () => ({
  assertInvoicePaymentIntentTenderMatches: jest.fn(),
  isAchPaymentIntent: jest.fn(() => true),
  isTerminalInvoicePaymentIntent: jest.fn(() => false),
  nextInvoiceStatusAfterFailedPayment: jest.fn(() => 'sent'),
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+15550009999') }));
jest.mock('../services/stripe', () => ({
  resolveFailedInvoiceSavedCardChargeAttempt: jest.fn(async () => true),
}));
jest.mock('../services/pay-combined', () => ({
  isCombinedPiMetadata: jest.fn(() => false),
  clearPaymentIntentStamps: jest.fn(async () => 0),
}));
jest.mock('../services/retry-collectibility', () => ({
  findCollectedMonthlyPayment: jest.fn(async () => undefined),
  monthKeyOf: jest.requireActual('../services/retry-collectibility').monthKeyOf,
}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}) }));
// The real composer validates the alert (headline, why, area, link, subject, done-when, who; it
// throws on a violation under NODE_ENV=test); only the notification write is replaced.
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return {
    ...actual,
    raiseAdminAlert: jest.fn(async (_category, spec) => {
      actual.composeAdminAlert(spec);
      return { id: 'alert-1' };
    }),
  };
});

const mockState = {};
function resetMockState() {
  Object.assign(mockState, {
    stampedInvoices: [],
    attemptRow: null, // stripe_invoice_charge_attempts candidate (saved-card lane)
    processingRow: null, // payments row still 'processing' on the PI (read before the flip)
    linkedInvoice: null, // invoices row bound to the PI
    customer: { first_name: 'Pat', last_name: 'Doe' },
    updates: [], // { table, wheres, patch }
  });
}

function mockMakeBuilder(table) {
  const b = { _wheres: [] };
  ['where', 'andWhere', 'whereIn', 'whereNotIn', 'whereNot', 'whereRaw', 'orderBy', 'select'].forEach((name) => {
    b[name] = (...args) => {
      if (args.length && typeof args[0] === 'object') b._wheres.push(args[0]);
      else if (args.length) b._wheres.push({ [name]: args });
      return b;
    };
  });
  b.whereNull = (col) => { b._wheres.push({ whereNull: col }); return b; };
  b.whereNotNull = (col) => { b._wheres.push({ whereNotNull: col }); return b; };
  b.first = async () => {
    if (table === 'stripe_invoice_charge_attempts') return mockState.attemptRow;
    if (table === 'payments') return mockState.processingRow;
    if (table === 'invoices') return mockState.linkedInvoice;
    if (table === 'customers') return mockState.customer;
    return null;
  };
  b.update = async (patch) => {
    mockState.updates.push({ table, wheres: b._wheres, patch });
    return 1;
  };
  // Awaiting the builder directly (the stamped-invoice read).
  b.then = (ok, err) => Promise.resolve(table === 'invoices' ? mockState.stampedInvoices : []).then(ok, err);
  return b;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => mockMakeBuilder(table));
  db.raw = jest.fn(async () => ({ rowCount: 0 }));
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction = jest.fn(async (fn) => fn(db));
  return db;
});

const { _handlePaymentIntentCanceled: handleCanceled } = require('../routes/stripe-webhook');
const { isCombinedPiMetadata, clearPaymentIntentStamps } = require('../services/pay-combined');
const { resolveFailedInvoiceSavedCardChargeAttempt } = require('../services/stripe');
const { savedCardAttemptMatchesPaymentIntent } = require('../routes/stripe-webhook-helpers');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

const STAMPED = {
  id: 'inv-1', customer_id: 'cust-1', status: 'processing', stripe_payment_intent_id: 'pi_ach_1', ach_processing_notified_at: new Date(),
};

const invoiceReverts = () => mockState.updates.filter((u) => u.table === 'invoices' && u.patch.stripe_payment_intent_id === null);
const paymentUpdates = () => mockState.updates.filter((u) => u.table === 'payments');

beforeEach(() => {
  jest.clearAllMocks();
  resetMockState();
  isCombinedPiMetadata.mockReturnValue(false);
  savedCardAttemptMatchesPaymentIntent.mockReturnValue(false);
  resolveFailedInvoiceSavedCardChargeAttempt.mockResolvedValue(true);
});

// B16: billing-cron cancels the live intent of an autopay charge parked on card authentication.
// The parked failed row (stripe.js stamps metadata.requires_action) is a debt still owed, so the
// canceled event must leave it 'failed' (failed-payments.js counts only failed rows); every other
// non-terminal row is flipped to 'canceled' exactly as before.
test('B16: the canceled update skips a failed row parked on card authentication and keeps the ordinary flip', async () => {
  await handleCanceled({ id: 'pi_sca_1', metadata: {} });
  expect(paymentUpdates()).toHaveLength(1);
  const update = paymentUpdates()[0];
  expect(update.patch).toEqual({ status: 'canceled' });
  const guard = update.wheres.find((w) => w.whereRaw);
  expect(guard.whereRaw[0]).toMatch(/NOT \(status = 'failed' AND COALESCE\(metadata->>'requires_action', ''\) = 'true'\)/);
  // the existing exclusions and the PI scope are unchanged
  expect(update.wheres).toContainEqual({ whereNotIn: ['status', ['paid', 'refunded', 'disputed']] });
  expect(update.wheres).toContainEqual({ stripe_payment_intent_id: 'pi_sca_1' });
  // an invoice-less autopay row has nothing else to revert
  expect(invoiceReverts()).toHaveLength(0);
});

test('single-invoice ACH PI canceled after processing: payment canceled, invoice reopened and unstamped', async () => {
  mockState.stampedInvoices = [{ ...STAMPED }];
  await handleCanceled({ id: 'pi_ach_1', metadata: {} });

  expect(paymentUpdates()).toHaveLength(1);
  expect(paymentUpdates()[0].patch).toEqual({ status: 'canceled' });

  const reverts = invoiceReverts();
  expect(reverts).toHaveLength(1);
  expect(reverts[0].wheres).toContainEqual({ id: 'inv-1', status: 'processing', stripe_payment_intent_id: 'pi_ach_1' });
  expect(reverts[0].patch).toMatchObject({
    status: 'sent',
    paid_at: null,
    stripe_payment_intent_id: null,
    stripe_charge_id: null,
    ach_processing_notified_at: null,
  });
  // Combined-only cleanup stays combined-only; nothing goes to the customer.
  expect(clearPaymentIntentStamps).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('no stamped processing invoice: only the payment row flips, nothing else written', async () => {
  await handleCanceled({ id: 'pi_ach_1', metadata: {} });
  expect(paymentUpdates()).toHaveLength(1);
  expect(invoiceReverts()).toHaveLength(0);
});

test('combined PI keeps its revert AND the stamp/residual cleanup', async () => {
  isCombinedPiMetadata.mockReturnValue(true);
  mockState.stampedInvoices = [{ ...STAMPED }, { ...STAMPED, id: 'inv-2' }];
  await handleCanceled({ id: 'pi_ach_1', metadata: { waves_combined: '1' } });

  expect(invoiceReverts()).toHaveLength(2);
  expect(clearPaymentIntentStamps).toHaveBeenCalledTimes(1);
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('saved-card PI canceled after processing: the attempt claim is released (credit returned) instead of the generic reopen', async () => {
  // chargeInvoiceWithSavedCard leaves a claimed stripe_invoice_charge_attempts
  // row; reopening the invoice around it would leave the claim fencing every
  // later collection and strand any reserved credit. The resolver reopens +
  // unbinds the invoice itself, so the generic revert must not double up.
  mockState.stampedInvoices = [{ ...STAMPED }];
  mockState.attemptRow = { id: 'att-1', invoice_id: 'inv-1', status: 'claimed', resolved_at: null, stripe_payment_intent_id: 'pi_ach_1' };
  savedCardAttemptMatchesPaymentIntent.mockReturnValue(true);

  await handleCanceled({ id: 'pi_ach_1', metadata: { source: 'admin_card_on_file', saved_card_attempt_id: 'att-1' } });

  expect(resolveFailedInvoiceSavedCardChargeAttempt).toHaveBeenCalledWith(expect.objectContaining({
    attemptId: 'att-1', invoiceId: 'inv-1', customerId: 'cust-1', stripePaymentIntentId: 'pi_ach_1',
  }));
  expect(invoiceReverts()).toHaveLength(0);
  expect(paymentUpdates()).toHaveLength(1);
});

test('saved-card PI whose attempt was already resolved falls through to the generic reopen', async () => {
  mockState.stampedInvoices = [{ ...STAMPED }];
  mockState.attemptRow = { id: 'att-1', invoice_id: 'inv-1', status: 'claimed', resolved_at: null, stripe_payment_intent_id: 'pi_ach_1' };
  savedCardAttemptMatchesPaymentIntent.mockReturnValue(true);
  resolveFailedInvoiceSavedCardChargeAttempt.mockResolvedValue(false);

  await handleCanceled({ id: 'pi_ach_1', metadata: { source: 'admin_card_on_file', saved_card_attempt_id: 'att-1' } });

  expect(invoiceReverts()).toHaveLength(1);
});

// Billing audit 2026-10-30, finding 2: monthly dues have no invoice, and the canceled flip takes a
// dues row out of every reader that could recover the month (the retry sweep and the failed-payment
// balances read 'failed'; the already-collected check reads 'paid'/'processing'). A dues charge
// canceled while processing rings the office once to charge or waive the month. It never arms a
// retry (a cancel can be deliberate) and never messages the customer.
describe('monthly autopay dues canceled while processing (billing audit finding 2)', () => {
  const { raiseAdminAlert } = require('../services/admin-alert-compose');
  const { findCollectedMonthlyPayment } = require('../services/retry-collectibility');
  const { logAutopay } = require('../services/autopay-log');
  const DUES_PI = { id: 'pi_dues_1', metadata: { type: 'monthly_autopay', billed_month: '2026-10' } };
  const duesRow = (over = {}) => ({
    id: 'pay-dues-1', customer_id: 'cust-1', status: 'processing', amount: '55.30',
    payment_date: '2026-10-01', superseded_by_payment_id: null,
    metadata: { type: 'monthly_autopay', billed_month: '2026-10' }, ...over,
  });
  const retryArms = () => paymentUpdates().filter((u) => u.patch.next_retry_at !== undefined);

  test('rings the office once, before the flip; no retry, no customer message; the row still flips', async () => {
    mockState.processingRow = duesRow();
    let updatesWhenAlerted = null;
    raiseAdminAlert.mockImplementationOnce(async (_category, spec) => {
      jest.requireActual('../services/admin-alert-compose').composeAdminAlert(spec);
      updatesWhenAlerted = mockState.updates.length;
      return { id: 'alert-1' };
    });

    await handleCanceled(DUES_PI);

    expect(findCollectedMonthlyPayment).toHaveBeenCalledWith('cust-1', {
      monthKey: '2026-10', monthStart: '2026-10-01', monthEnd: '2026-10-31',
    }, { excludePaymentId: 'pay-dues-1' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('billing');
    expect(spec).toMatchObject({
      area: 'Billing',
      action: "charge or waive Pat Doe's canceled dues",
      severity: 'needs-you',
      subject: { type: 'customer', id: 'cust-1' },
      doneWhen: 'collected_and_marked_done',
      who: 'person',
    });
    expect(spec.why).toBe('The October 2026 $55.30 dues payment was canceled at Stripe before it cleared; the month is unpaid.');
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'autopay-canceled:cust-1:pi_dues_1' });
    expect(opts.detail).toMatch(/No message was sent to the customer\./);
    // Charge now (Customer 360) is the one office action that stamps the month as paid, so it is the
    // advice while the month lasts; after it, a hand-made invoice leaves the month open to a re-bill.
    expect(spec.link).toBe('/admin/customers?customerId=cust-1');
    expect(opts.detail).toMatch(/While it is still October 2026, Charge now on the customer's page collects it and records October 2026 as paid\./);
    expect(opts.detail).toMatch(/an invoice made by hand does not mark October 2026 as paid \(a plan visit in October 2026 completed later could bill it again\)/);
    expect(opts.detail).toMatch(/To waive it, mark this done\./);
    expect(updatesWhenAlerted).toBe(0); // raised before the canceled flip
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'charge_canceled', expect.objectContaining({
      paymentId: 'pay-dues-1', amountCents: 5530,
      details: expect.objectContaining({ billed_month: '2026-10', stripe_payment_intent_id: 'pi_dues_1' }),
    }));
    expect(retryArms()).toHaveLength(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(paymentUpdates()).toHaveLength(1);
    expect(paymentUpdates()[0].patch).toEqual({ status: 'canceled' });
  });

  test('a card attempt shows its dues, not its card-fee total (a new charge adds its own fee)', async () => {
    mockState.processingRow = duesRow({ amount: '57.00', base_amount_cents: 5530, surcharge_amount_cents: 170 });
    await handleCanceled(DUES_PI);
    expect(raiseAdminAlert.mock.calls[0][1].why).toMatch(/^The October 2026 \$55\.30 dues payment/);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'charge_canceled', expect.objectContaining({ amountCents: 5530 }));
  });

  test('a legacy row with no base amount subtracts its stored card fee', async () => {
    mockState.processingRow = duesRow({ amount: '57.00', base_amount_cents: null, surcharge_amount_cents: 170 });
    await handleCanceled(DUES_PI);
    expect(raiseAdminAlert.mock.calls[0][1].why).toMatch(/^The October 2026 \$55\.30 dues payment/);
  });

  test('another row already collected the month: no ring', async () => {
    mockState.processingRow = duesRow();
    findCollectedMonthlyPayment.mockResolvedValueOnce({ id: 'pay-charge-now' });
    await handleCanceled(DUES_PI);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(paymentUpdates()).toHaveLength(1);
  });

  test('an invoice-linked PI, a superseded row, a row no longer processing and a non-dues PI never ring', async () => {
    mockState.processingRow = duesRow();
    mockState.linkedInvoice = { id: 'inv-9' };
    await handleCanceled(DUES_PI);
    mockState.linkedInvoice = null;
    mockState.processingRow = duesRow({ superseded_by_payment_id: 'pay-rung-2' });
    await handleCanceled(DUES_PI);
    mockState.processingRow = null; // the read found no 'processing' row on the PI
    await handleCanceled(DUES_PI);
    mockState.processingRow = duesRow();
    await handleCanceled({ id: 'pi_other', metadata: {} });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(retryArms()).toHaveLength(0);
  });

  test('a failed dues row still on its retry ladder (a declined card PI canceled in Stripe) rings with the retry wording', async () => {
    mockState.processingRow = duesRow({ status: 'failed', next_retry_at: '2026-11-02T14:07:00Z', retry_count: 1 });
    await handleCanceled(DUES_PI);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(spec.why).toBe('The October 2026 $55.30 dues payment was canceled at Stripe, so its retries stopped; the month is unpaid.');
    expect(opts.detail).toMatch(/had failed and was waiting for its next automatic retry/);
    expect(opts.metadata).toMatchObject({ payment_status: 'failed', payment_id: 'pay-dues-1' });
    expect(retryArms()).toHaveLength(0);
  });

  test('a failed dues row off its ladder, or parked on card authentication (the flip keeps it failed), never rings', async () => {
    mockState.processingRow = duesRow({ status: 'failed', next_retry_at: null });
    await handleCanceled(DUES_PI);
    mockState.processingRow = duesRow({
      status: 'failed', next_retry_at: '2026-11-02T14:07:00Z',
      metadata: { billed_month: '2026-10', requires_action: true },
    });
    await handleCanceled(DUES_PI);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('the month falls back to the row\'s payment date when neither the row nor the PI carries billed_month', async () => {
    mockState.processingRow = duesRow({ metadata: {}, payment_date: new Date('2026-09-30T04:00:00Z') });
    await handleCanceled({ id: 'pi_dues_legacy', metadata: { type: 'monthly_autopay' } });
    expect(findCollectedMonthlyPayment).toHaveBeenCalledWith('cust-1', expect.objectContaining({ monthKey: '2026-09' }), { excludePaymentId: 'pay-dues-1' });
    expect(raiseAdminAlert.mock.calls[0][1].why).toMatch(/^The September 2026 \$55\.30 dues payment/);
  });

  test('an alert that was not filed (notifyAdmin returns null on a failed insert) fails the webhook before the flip', async () => {
    mockState.processingRow = duesRow();
    raiseAdminAlert.mockResolvedValueOnce(null);
    await expect(handleCanceled(DUES_PI)).rejects.toThrow(/office alert for canceled monthly autopay PI pi_dues_1 was not filed/);
    expect(paymentUpdates()).toHaveLength(0);
    expect(logAutopay).not.toHaveBeenCalled();
  });

  test('an alert that throws fails the webhook before the flip, so the redelivery finds the row still processing', async () => {
    mockState.processingRow = duesRow();
    raiseAdminAlert.mockRejectedValueOnce(new Error('notifications down'));
    await expect(handleCanceled(DUES_PI)).rejects.toThrow('notifications down');
    expect(paymentUpdates()).toHaveLength(0);
  });
});
