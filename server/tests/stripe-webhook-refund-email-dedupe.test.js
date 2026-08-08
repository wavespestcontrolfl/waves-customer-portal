/**
 * charge.refunded must reach sendRefundIssued with the REFUND id.
 *
 * Prod incident 2026-08-08 (first refund ever taken through this path): a
 * customer received the "Your Waves refund has been issued" email TWICE.
 * StripeService.refund() emails first keyed on the refund id
 * (`payment.refund_issued:re_…:<cust>`); the charge.refunded webhook then
 * emailed again keyed on `refundId || chargeId`. On the pinned API version
 * the event's `charge.refunds` is a NON-expanded list and `latest_refund`
 * was absent, so refundId was null and the key became
 * `payment.refund_issued:ch_…:<cust>` — a different key, so the template
 * library's dedupe never fired. Two `email_messages` rows, both delivered.
 *
 * The same null also wrote `payments.stripe_refund_id = NULL`, degrading the
 * failed-refund fence and the stamped-refund record.
 *
 * Contract:
 *  - when the event carries no refund id, resolve it from Stripe, pinning the
 *    refund the event's cumulative snapshot describes (not merely the newest);
 *  - the id handed to sendRefundIssued is the refund id, never the charge id;
 *  - an unresolvable id FAILS CLOSED — throw so Stripe retries rather than
 *    stamp a null and re-send the duplicate;
 *  - a refund that has since bounced still resolves, so the existing
 *    failed-refund fences get to acknowledge it instead of retrying forever;
 *  - when the event DOES carry the id, don't spend an extra API call.
 */

// The resolver paginates: stripe.refunds.list(...).autoPagingToArray(...).
// Tests set the full history via mockRefundHistory / mockRefundsFail.
const mockRefundsList = jest.fn();

jest.mock('stripe', () => jest.fn(() => ({ refunds: { list: mockRefundsList } })));
jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.transaction = jest.fn();
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
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
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
// Returns a promise: the handler attaches .catch() to the send.
jest.mock('../services/payment-lifecycle-email', () => ({
  sendRefundIssued: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));
jest.mock('../services/stripe', () => ({
  ...jest.requireActual('../services/stripe'),
  retrievePaymentIntent: jest.fn(async (piId) => ({ id: piId, metadata: {} })),
}));

const db = require('../models/db');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const {
  _handleChargeRefunded: handleChargeRefunded,
  _resolveRefundIdForCharge: resolveRefundIdForCharge,
} = require('../routes/stripe-webhook');

// stripe.refunds.list() returns an ApiListPromise carrying autoPagingToArray;
// `data` is newest-first and pagination preserves that order.
function mockRefundHistory(newestFirst) {
  mockRefundsList.mockReturnValueOnce({
    autoPagingToArray: jest.fn(async () => newestFirst),
  });
}

function mockRefundsFail(err) {
  mockRefundsList.mockReturnValueOnce({
    autoPagingToArray: jest.fn(async () => { throw err; }),
  });
}

// A plain partial refund: no deposit, no appointment fee, no bounce fence.
function chargeEvent(over = {}) {
  return {
    id: 'ch_1',
    payment_intent: 'pi_1',
    amount: 31600,
    amount_refunded: 23700,
    refunded: false,
    metadata: {},
    ...over,
  };
}

// Reaches the email tail without exercising the stamping transaction: the
// handler's refundedPayment IS the transaction's return value.
function mockDbReachingEmailTail() {
  db.schema = { hasTable: jest.fn(async () => false) };
  db.mockImplementation((table) => {
    if (table === 'payments') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
      return q;
    }
    if (table === 'appointment_card_requests') return { where: () => ({ first: async () => undefined }) };
    const q = { where: jest.fn(() => q), first: jest.fn(async () => null), update: jest.fn(async () => 0) };
    return q;
  });
  db.transaction = jest.fn(async () => ({ id: 'pay-1', customer_id: 'cust-1' }));
}

describe('resolveRefundIdForCharge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRefundsList.mockReset();
  });

  test('uses the expanded refund from the event when present (no extra API call)', async () => {
    const { refundId } = await resolveRefundIdForCharge(
      chargeEvent({ refunds: { data: [{ id: 're_event', amount: 23700 }] } }),
    );
    expect(refundId).toBe('re_event');
    expect(mockRefundsList).not.toHaveBeenCalled();
  });

  test('falls back to charge.latest_refund before calling Stripe', async () => {
    const { refundId } = await resolveRefundIdForCharge(chargeEvent({ latest_refund: 're_latest' }));
    expect(refundId).toBe('re_latest');
    expect(mockRefundsList).not.toHaveBeenCalled();
  });

  test('resolves from Stripe when the event carries no refund id at all', async () => {
    mockRefundHistory([{ id: 're_resolved', amount: 23700, created: 10 }]);
    const { refundId } = await resolveRefundIdForCharge(chargeEvent());
    expect(refundId).toBe('re_resolved');
    expect(mockRefundsList).toHaveBeenCalledWith({ charge: 'ch_1', limit: 100 });
  });

  // codex P0: taking the NEWEST refund collapses two out-of-order events onto
  // one id — the first refund never gets stamped and the second can be stamped
  // against the first event's cumulative amount.
  test('two partial refunds map each event to ITS OWN refund, not the newest', async () => {
    // Stripe returns newest-first; the resolver reverses that to walk oldest-first.
    const both = [
      { id: 're_second', amount: 13700, created: 200, status: 'succeeded' },
      { id: 're_first', amount: 10000, created: 100, status: 'succeeded' },
    ];

    // The older event's snapshot: only the first refund had landed.
    mockRefundHistory(both);
    const older = await resolveRefundIdForCharge(chargeEvent({ amount_refunded: 10000 }));
    expect(older.refundId).toBe('re_first');

    // The newer event's snapshot: both had landed.
    mockRefundHistory(both);
    const newer = await resolveRefundIdForCharge(chargeEvent({ amount_refunded: 23700 }));
    expect(newer.refundId).toBe('re_second');
  });

  test('ignores failed/canceled refunds, which Stripe excludes from amount_refunded', async () => {
    mockRefundHistory([
        // newest-first, as Stripe returns them
        { id: 're_good', amount: 23700, created: 100, status: 'succeeded' },
        { id: 're_bounced', amount: 5000, created: 50, status: 'failed' },
      ]);
    const { refundId } = await resolveRefundIdForCharge(chargeEvent({ amount_refunded: 23700 }));
    expect(refundId).toBe('re_good');
  });

  // codex P0: `created` is second-precision and refund ids are opaque, so a
  // comparator tie-break reorders same-second refunds arbitrarily. Stripe's
  // list order is authoritative — reversing newest-first is the only safe
  // oldest-first walk. Both refunds share `created` here and are returned
  // newest-first, so a sort-based implementation can mis-attribute.
  test('same-second refunds keep Stripe list order, not a comparator guess', async () => {
    // Stripe returns newest first: re_second was created after re_first.
    const newestFirst = [
      { id: 're_second', amount: 13700, created: 100, status: 'succeeded' },
      { id: 're_first', amount: 10000, created: 100, status: 'succeeded' },
    ];

    mockRefundHistory(newestFirst);
    expect((await resolveRefundIdForCharge(chargeEvent({ amount_refunded: 10000 }))).refundId).toBe('re_first');

    mockRefundHistory(newestFirst);
    expect((await resolveRefundIdForCharge(chargeEvent({ amount_refunded: 23700 }))).refundId).toBe('re_second');
  });

  // codex P0: fail closed. Continuing would stamp a null id and re-send the
  // duplicate; a retry (or a visible failed event) is the safer outcome.
  test('an unmatchable snapshot THROWS rather than guessing or degrading', async () => {
    mockRefundHistory([{ id: 're_x', amount: 999, created: 10, status: 'succeeded' }]);
    await expect(resolveRefundIdForCharge(chargeEvent({ amount_refunded: 23700 })))
      .rejects.toThrow(/no refund matches the snapshot/);
  });

  test('an empty refund list THROWS (stale/eventually-consistent read)', async () => {
    mockRefundHistory([]);
    await expect(resolveRefundIdForCharge(chargeEvent())).rejects.toThrow(/refusing to process an unattributable refund/);
  });

  // codex P1: a delayed id-less charge.refunded can be handled AFTER its own
  // refund bounced. Stripe has dropped that amount from amount_refunded, so the
  // live-only walk can never match the snapshot. Throwing there would retry
  // until Stripe gives up and the existing failed-refund fences would never
  // run — so the bounced refund still has to resolve.
  test('a refund that bounced after the event still resolves, so the fences can own it', async () => {
    mockRefundHistory([{ id: 're_bounced', amount: 23700, created: 100, status: 'failed' }]);

    const { refundId, refund } = await resolveRefundIdForCharge(chargeEvent({ amount_refunded: 23700 }));

    expect(refundId).toBe('re_bounced');
    expect(refund.status).toBe('failed');
  });

  // codex P0: the snapshot is old, the history is current — when the two
  // readings name different refunds the event is genuinely ambiguous.
  test('conflicting live vs full-history candidates fail closed', async () => {
    mockRefundHistory([
      { id: 're_live', amount: 23700, created: 200, status: 'succeeded' },
      { id: 're_bounced', amount: 23700, created: 100, status: 'failed' },
    ]);

    await expect(resolveRefundIdForCharge(chargeEvent({ amount_refunded: 23700 })))
      .rejects.toThrow(/ambiguous/);
  });

  // The concrete case codex raised: A=$100 + B=$50 gives B's event a $150
  // snapshot; A then fails and C=$100 is created. The live walk (B+C) lands on
  // C, the full walk (A+B) lands on B — accepting either would stamp the wrong
  // refund against B's event.
  test('a refund that failed after the event, plus a replacement, is refused rather than misattributed', async () => {
    mockRefundHistory([
      { id: 're_C', amount: 10000, created: 400, status: 'succeeded' },
      { id: 're_B', amount: 5000, created: 200, status: 'succeeded' },
      { id: 're_A', amount: 10000, created: 100, status: 'failed' },
    ]);

    await expect(resolveRefundIdForCharge(chargeEvent({ amount_refunded: 15000 })))
      .rejects.toThrow(/ambiguous/);
  });

  test('pages through the full refund history rather than one page', async () => {
    const autoPaging = jest.fn(async () => [{ id: 're_paged', amount: 23700, created: 10, status: 'succeeded' }]);
    mockRefundsList.mockReturnValueOnce({ autoPagingToArray: autoPaging });

    const { refundId } = await resolveRefundIdForCharge(chargeEvent());

    expect(refundId).toBe('re_paged');
    expect(autoPaging).toHaveBeenCalledWith({ limit: 1000 });
  });

  // codex P0: acking on a transient lookup failure would stamp
  // stripe_refund_id=null over an id the admin path already recorded AND still
  // send the duplicate. The dispatcher turns a throw into 500 "Stripe will
  // retry" without marking the event processed.
  test('a Stripe lookup failure THROWS so the webhook retries instead of degrading', async () => {
    mockRefundsFail(new Error('stripe down'));
    await expect(resolveRefundIdForCharge(chargeEvent())).rejects.toThrow('stripe down');
  });
});

describe('charge.refunded → sendRefundIssued idempotency key source', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRefundsList.mockReset();
    mockDbReachingEmailTail();
  });

  test('emails with the RESOLVED refund id when the event omitted it (the duplicate-email fix)', async () => {
    mockRefundHistory([{ id: 're_resolved', amount: 23700, created: 1780000000, status: 'succeeded' }]);

    await handleChargeRefunded(chargeEvent());

    expect(PaymentLifecycleEmail.sendRefundIssued).toHaveBeenCalledTimes(1);
    const arg = PaymentLifecycleEmail.sendRefundIssued.mock.calls[0][0];
    // This is the whole bug: StripeService.refund() keys on the refund id,
    // so the webhook must too or the customer is emailed twice.
    expect(arg.refundId).toBe('re_resolved');
    expect(arg.refundId).not.toBe('ch_1');
  });

  test('a lookup failure retries the event instead of emailing on a degraded id', async () => {
    mockRefundsFail(new Error('stripe down'));

    await expect(handleChargeRefunded(chargeEvent())).rejects.toThrow('stripe down');

    // Nothing sent: the retry will resolve the real id and send once.
    expect(PaymentLifecycleEmail.sendRefundIssued).not.toHaveBeenCalled();
  });

  test('an unattributable refund never reaches the email at all', async () => {
    mockRefundHistory([{ id: 're_x', amount: 111, created: 10, status: 'succeeded' }]);

    await expect(handleChargeRefunded(chargeEvent())).rejects.toThrow(/no refund matches the snapshot/);

    // Fail closed: no stamp, no send. The retry resolves it or the event
    // surfaces as failed in Stripe — either beats a null id + duplicate email.
    expect(PaymentLifecycleEmail.sendRefundIssued).not.toHaveBeenCalled();
  });

  test('passes the event-supplied refund id straight through', async () => {
    await handleChargeRefunded(chargeEvent({ refunds: { data: [{ id: 're_event', amount: 23700, created: 1780000000 }] } }));

    expect(PaymentLifecycleEmail.sendRefundIssued).toHaveBeenCalledTimes(1);
    expect(PaymentLifecycleEmail.sendRefundIssued.mock.calls[0][0].refundId).toBe('re_event');
    expect(mockRefundsList).not.toHaveBeenCalled();
  });
});
