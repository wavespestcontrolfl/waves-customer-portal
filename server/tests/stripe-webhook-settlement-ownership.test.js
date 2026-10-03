/**
 * Settlement ownership vs a concurrent change of the invoice's owner.
 *
 * payment_intent.succeeded resolves its invoice with a PRE-lock read
 * (findInvoiceForPaymentIntent), then takes FOR UPDATE on that invoice row
 * inside the transaction. A customer merge repoints invoices.customer_id
 * under that SAME row lock, so the two are already serialized — but only if
 * settlement reads the invoice's owner from the row it LOCKED, not from the
 * copy it read before waiting.
 *
 * The insert used `invoice.customer_id` (pre-lock), so an ownership change
 * that committed while this handler waited produced an invoice on one
 * account whose payment row belonged to another — reconciliation sees both
 * a missing payment and an unexplained one. Pinned here with a stub whose
 * FOR UPDATE re-read deliberately returns a DIFFERENT owner than the
 * pre-lock read.
 *
 * No new lock is introduced: settlement must never be blocked into failure.
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
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
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async () => 'msg'),
}));
jest.mock('../services/stripe-invoice-state', () => ({
  assertInvoicePaymentIntentTenderMatches: jest.fn(),
  isAchPaymentIntent: jest.fn(() => false),
  isTerminalInvoicePaymentIntent: jest.fn(() => false),
  nextInvoiceStatusAfterFailedPayment: jest.fn(() => 'sent'),
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({
  INVOICE_UNCOLLECTIBLE_STATUSES: ['void'],
  invoiceAmountDue: jest.fn(() => 100),
  // Pure predicate over the row — the real one, so the withdrawn-invoice
  // quarantine is exercised rather than stubbed away.
  invoiceWithdrawnFromCustomer: jest.requireActual('../services/invoice-helpers').invoiceWithdrawnFromCustomer,
}));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendPaymentFailed: jest.fn(async () => {}) }));
jest.mock('../services/receipt-delivery-queue', () => ({
  enqueueReceiptDelivery: jest.fn(async () => {}),
  scheduleReceiptDeliveryDrain: jest.fn(),
}));
jest.mock('../services/project-report-hold', () => ({ scheduleHoldReleaseSweep: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({
  handleDepositChargeReversed: jest.fn(async () => ({ handled: false })),
  handleDepositIntentSucceeded: jest.fn(async () => {}),
}));
jest.mock('../services/stripe', () => ({
  friendlyStripeError: jest.fn(() => 'Payment could not be completed.'),
  resolveFailedInvoiceSavedCardChargeAttempt: jest.fn(async () => false),
  // No competing saved-card attempt — keeps this suite on the ownership
  // contract rather than the quarantine/fence branches.
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  parkInvoiceForSavedCardReconciliation: jest.fn(async () => {}),
}));
jest.mock('../services/customer-health', () => ({ scoreCustomer: jest.fn(async () => {}) }));
jest.mock('../services/invoice-followups', () => ({
  handleAutopayFailure: jest.fn(async () => {}),
  handleInvoicePaid: jest.fn(async () => {}),
}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}) }));
jest.mock('../services/billing-cron', () => ({ RETRY_DELAYS_DAYS: [2, 2] }));

const WINNER = 'cust-winner';
const LOSER = 'cust-loser';

const mockState = {};
function resetMockState() {
  Object.assign(mockState, {
    // What the PRE-lock read returns (the world before the undo).
    preLockInvoice: { id: 'inv-1', customer_id: WINNER, invoice_number: 'INV-1', status: 'sent', credit_applied: 0 },
    // What the FOR UPDATE re-read returns (the world after the undo
    // committed while this handler waited on the row lock).
    lockedInvoice: { id: 'inv-1', customer_id: LOSER, invoice_number: 'INV-1', status: 'sent', credit_applied: 0 },
    inserts: [],
    // >0 = a payments row was already sitting in `processing` (the ACH rail),
    // which takes the settle path that never reaches the fallback lock.
    processingPaymentsUpdated: 0,
    // What the settle-time re-read sees (null = same as the pre-lock read).
    settleReadInvoice: null,
    settleReadThrows: false,
    // A payments row the fallback's FOR UPDATE read finds (null = none).
    fallbackPayment: null,
    // The paid / processing payment a row was superseded by (null = none).
    replacementPayment: null,
    updates: [],
  });
}

function mockMakeBuilder(table, { inTrx } = {}) {
  const b = { _table: table, _wheres: [], _forUpdate: false, _counted: false };
  for (const m of ['where', 'andWhere', 'orWhere', 'whereNot', 'whereIn', 'whereNotIn',
    'whereNull', 'whereNotNull', 'whereRaw', 'orderBy', 'select', 'limit']) {
    b[m] = (...args) => {
      if (args.length && typeof args[0] === 'object') b._wheres.push(args[0]);
      else if (args.length && typeof args[0] === 'function') args[0].call(b);
      return b;
    };
  }
  b.forUpdate = () => { b._forUpdate = true; return b; };
  b.count = () => { b._counted = true; return b; };
  b.columnInfo = async () => ({ stripe_event_id: {} });
  b.first = async (...cols) => {
    if (table === 'invoices') {
      // The settle-time re-read names its columns explicitly; every other
      // invoice read in this handler takes the whole row. That is how the
      // harness models a withdrawal that commits DURING the payment.
      if (cols.includes('scheduled_send_error')) {
        if (mockState.settleReadThrows) throw new Error('connection reset');
        return mockState.settleReadInvoice ?? mockState.preLockInvoice;
      }
      // Inside the transaction WITH forUpdate = the post-wait re-read.
      return (inTrx && b._forUpdate) ? mockState.lockedInvoice : mockState.preLockInvoice;
    }
    // Outside the transaction, a `processing` row exists exactly when this
    // PI's ACH is still in flight; inside it (the fallback's FOR UPDATE read)
    // there is never a pre-existing row — that is the path under test.
    if (table === 'payments') {
      if (inTrx && b._forUpdate && mockState.fallbackPayment) return mockState.fallbackPayment;
      if (inTrx && !b._forUpdate && mockState.replacementPayment) return mockState.replacementPayment;
      return (!inTrx && mockState.processingPaymentsUpdated > 0) ? { id: 'pay-processing' } : null;
    }
    return null;
  };
  b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  // No pre-existing 'processing' payments row to flip → the handler takes
  // the fallback transaction that LOCKS the invoice and inserts the
  // payment, which is the path under test. The invoice link update must
  // report a row so the handler proceeds to that insert.
  b.update = async (payload) => {
    mockState.updates.push({ table, payload, inTrx: !!inTrx });
    return table === 'payments' ? mockState.processingPaymentsUpdated : 1;
  };
  b.del = async () => 1;
  b.insert = (payload) => {
    mockState.inserts.push({ table, payload, inTrx: !!inTrx });
    // Thenable so `await insert(...)` still yields the row, with the
    // upsert chain the orphan-quarantine recorder uses.
    const result = Promise.resolve([{ id: 'new-row' }]);
    result.onConflict = () => ({ ignore: async () => 1, merge: async () => 1 });
    return result;
  };
  b.returning = async () => [{ id: 'new-row' }];
  return b;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => mockMakeBuilder(table, { inTrx: false }));
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  db.fn = { now: () => 'NOW()' };
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => mockMakeBuilder(table, { inTrx: true }));
    trx.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
    trx.fn = { now: () => 'NOW()' };
    return fn(trx);
  });
  return db;
});

const { _handlePaymentIntentSucceeded: handlePaymentIntentSucceeded } = require('../routes/stripe-webhook');
const { etDateString } = require('../utils/datetime-et');

function succeededPI(overrides = {}) {
  return {
    id: 'pi_test_1',
    amount: 10000,
    amount_received: 10000,
    latest_charge: 'ch_1',
    payment_method_types: ['card'],
    metadata: { base_amount: '100', card_surcharge: '0' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMockState();
});

describe('payment settlement takes ownership from the LOCKED invoice row', () => {
  test('an ownership change that committed while we waited: the payment follows the invoice to its new owner', async () => {
    await handlePaymentIntentSucceeded(succeededPI());

    const paymentInsert = mockState.inserts.find((i) => i.table === 'payments');
    expect(paymentInsert).toBeTruthy();
    // THE PIN: the pre-lock read said PRIOR_OWNER; the row we locked says
    // NEW_OWNER. Using the pre-lock value would leave a paid invoice on one
    // account whose payment sits on another.
    expect(paymentInsert.payload.customer_id).toBe(LOSER);
    expect(paymentInsert.payload.customer_id).not.toBe(WINNER);
  });

  test('happy path (no concurrent repoint): locked owner equals the pre-lock owner, behavior unchanged', async () => {
    mockState.lockedInvoice = { ...mockState.lockedInvoice, customer_id: WINNER };

    await handlePaymentIntentSucceeded(succeededPI());

    const paymentInsert = mockState.inserts.find((i) => i.table === 'payments');
    expect(paymentInsert).toBeTruthy();
    expect(paymentInsert.payload.customer_id).toBe(WINNER);
  });
});

// A PaymentIntent the customer minted BEFORE Bill-To moved is confirmed
// client-side at Stripe and never re-enters our routes, so the route guards
// cannot refuse it — this webhook is the first place the money is visible
// (pre-push P0). Settling it would mark an invoice now owned by third-party
// AP as paid with the homeowner's funds.
describe('a withdrawn invoice never settles from a customer-minted intent', () => {
  test('quarantines the charge instead of recording the payment', async () => {
    mockState.preLockInvoice = { ...mockState.preLockInvoice, scheduled_send_error: 'payer_billed:5:hold' };

    await handlePaymentIntentSucceeded(succeededPI());

    expect(mockState.inserts.find((i) => i.table === 'payments')).toBeFalsy();
    expect(mockState.inserts.find((i) => i.table === 'stripe_orphan_charges')).toBeTruthy();
  });

  test('an ordinary delivery failure still settles normally', async () => {
    mockState.preLockInvoice = { ...mockState.preLockInvoice, scheduled_send_error: 'smtp 550 mailbox unavailable' };

    await handlePaymentIntentSucceeded(succeededPI());

    expect(mockState.inserts.find((i) => i.table === 'payments')).toBeTruthy();
    expect(mockState.inserts.find((i) => i.table === 'stripe_orphan_charges')).toBeFalsy();
  });

  test('a settle-time re-read that fails surfaces to Stripe instead of settling without the alert', async () => {
    // The flip and its withdrawal check share a transaction: a failed re-read
    // rolls the flip back and the handler throws, so the redelivery repeats
    // the check rather than leaving a paid invoice with no alert.
    mockState.processingPaymentsUpdated = 1;
    mockState.settleReadThrows = true;

    await expect(handlePaymentIntentSucceeded(succeededPI())).rejects.toThrow('connection reset');
    expect(mockState.inserts.find((i) => i.table === 'customer_health_alerts')).toBeFalsy();
  });
});

// The pre-lock read can be overtaken: a Bill-To transaction commits while this
// webhook waits on the invoice row, and the fallback branch is the one that
// CREATES the payment row (audit P0).
describe('the withdrawal is re-read under the settlement lock', () => {
  test('a withdrawal that commits during the wait still quarantines', async () => {
    mockState.lockedInvoice = { ...mockState.lockedInvoice, scheduled_send_error: 'payer_billed:5' };

    await handlePaymentIntentSucceeded(succeededPI());

    expect(mockState.inserts.find((i) => i.table === 'payments')).toBeFalsy();
    const orphan = mockState.inserts.find((i) => i.table === 'stripe_orphan_charges');
    expect(orphan).toBeTruthy();
    // Written through the HELD transaction: a root-connection insert would
    // wait on this transaction's own FOR UPDATE lock (the FK takes KEY SHARE
    // on the locked invoice) and the quarantine could never commit.
    expect(orphan.inTrx).toBe(true);
    // …and the WHOLE handler stops: the quarantine's `return` leaves only the
    // transaction callback, so without an explicit outcome the invoice-paid
    // update below would mark a quarantined invoice paid with no payments row.
    expect(mockState.updates.find((u) => u.table === 'invoices' && u.payload?.status === 'paid')).toBeFalsy();
  });

  test('a withdrawal visible on the FIRST read still settles an in-flight ACH', async () => {
    // The early quarantine must not fire when a payments row for this PI is
    // already `processing`: those funds are captured and the row would be
    // stranded (audit P0).
    mockState.processingPaymentsUpdated = 1;
    mockState.preLockInvoice = { ...mockState.preLockInvoice, scheduled_send_error: 'payer_billed:5' };
    mockState.settleReadInvoice = { ...mockState.preLockInvoice };

    await handlePaymentIntentSucceeded(succeededPI());

    expect(mockState.inserts.find((i) => i.table === 'stripe_orphan_charges')).toBeFalsy();
    const alert = mockState.inserts.find((i) => i.table === 'customer_health_alerts');
    expect(alert?.payload.alert_type).toBe('wh_payer_billed_settled');
  });

  test('an ACH row already in `processing` settles but raises an alert', async () => {
    // The money is captured and the payments row exists — refusing here would
    // strand a `processing` row forever. The office is told instead.
    mockState.processingPaymentsUpdated = 1;
    mockState.settleReadInvoice = { ...mockState.preLockInvoice, scheduled_send_error: 'payer_billed:5' };

    await handlePaymentIntentSucceeded(succeededPI());

    const alert = mockState.inserts.find((i) => i.table === 'customer_health_alerts');
    expect(alert).toBeTruthy();
    expect(alert.payload.alert_type).toBe('wh_payer_billed_settled');
    expect(alert.payload.alert_type.length).toBeLessThanOrEqual(30);
    expect(mockState.inserts.find((i) => i.table === 'stripe_orphan_charges')).toBeFalsy();
  });
});

// /confirm can promote a bank (ACH) row from processing to paid when it sees
// the PaymentIntent succeed before this event lands, with no Stripe time to
// stamp (Codex #4996 r10): the settlement moment arrives with this event.
describe('a paid row with no settlement stamp takes this event\'s settlement time', () => {
  const EVENT_CREATED = 1790000000;
  const settlementStamp = (u) => u.table === 'payments' && u.inTrx && u.payload.metadata && !('status' in u.payload);

  test('a bank payment already paid with no settlement stamp is stamped with the event time and touched', async () => {
    mockState.fallbackPayment = { id: 'pay-ach', status: 'paid', metadata: { payment_state: 'paid', payment_method: 'us_bank_account' } };

    await handlePaymentIntentSucceeded(succeededPI({ payment_method_types: ['us_bank_account'] }), EVENT_CREATED);

    // The processing flip also runs (and matches no row); the stamp is the update that sets no status.
    const stamp = mockState.updates.find(settlementStamp);
    expect(stamp).toBeTruthy();
    expect(stamp.payload.updated_at).toBeInstanceOf(Date);
    expect(stamp.payload.metadata.__raw).toContain('{settled_event_at}');
    expect(stamp.payload.metadata.bindings).toEqual([new Date(EVENT_CREATED * 1000).toISOString()]);
    // The cash-basis day moves to the settlement's Eastern date, as the processing flip's does.
    expect(stamp.payload.payment_date).toBe(etDateString(new Date(EVENT_CREATED * 1000)));
    expect(mockState.inserts.find((i) => i.table === 'payments')).toBeFalsy();
  });

  test('a card payment already paid with no settlement stamp (its charge was unreadable at /confirm) is stamped too', async () => {
    mockState.fallbackPayment = { id: 'pay-card', status: 'paid', metadata: { payment_state: 'paid' } };

    await handlePaymentIntentSucceeded(succeededPI(), EVENT_CREATED);

    expect(mockState.updates.find(settlementStamp).payload.metadata.bindings).toEqual([new Date(EVENT_CREATED * 1000).toISOString()]);
  });

  test('a payment already carrying a settlement stamp is left alone', async () => {
    mockState.fallbackPayment = { id: 'pay-card', status: 'paid',
      metadata: JSON.stringify({ payment_state: 'paid', settled_event_at: '2026-09-20T14:00:00.000Z' }) };

    await handlePaymentIntentSucceeded(succeededPI(), EVENT_CREATED);

    expect(mockState.updates.find(settlementStamp)).toBeFalsy();
  });
});

// B16: an autopay charge parked on 3D Secure left its PaymentIntent live; the office then collected a
// replacement (the parked row was superseded by that PAID payment). If the original intent is later
// completed, its succeeded event must NOT silently flip the superseded row to paid (a second
// collection): it is queued on the orphan / duplicate-charge list for a person to refund one.
describe('B16: a late success on a row already superseded by a collected replacement', () => {
  const SUPERSEDED = { id: 'pay-sca-1', customer_id: 'cust-1', status: 'failed', superseded_by_payment_id: 'pay-new', metadata: { requires_action: true } };
  const paymentsUpdates = () => mockState.updates.filter((u) => u.table === 'payments');

  test('superseded by a PAID payment: not flipped to paid, queued as a duplicate collection with the customer id', async () => {
    mockState.fallbackPayment = { ...SUPERSEDED };
    mockState.replacementPayment = { id: 'pay-new', status: 'paid' };
    await handlePaymentIntentSucceeded(succeededPI({ id: 'pi_sca_orig' }));

    expect(paymentsUpdates()).toHaveLength(1); // only the status='processing' flip attempt (matched no row); no fallback flip to paid
    const orphan = mockState.inserts.find((i) => i.table === 'stripe_orphan_charges');
    expect(orphan).toBeTruthy();
    expect(orphan.payload).toMatchObject({ stripe_payment_intent_id: 'pi_sca_orig', customer_id: 'cust-1' });
    expect(orphan.payload.original_db_error).toMatch(/Duplicate collection/);
    // nothing else settles: no invoice paid, no new payments row
    expect(mockState.inserts.find((i) => i.table === 'payments')).toBeFalsy();
  });

  test('superseded by a PROCESSING (ACH in flight) replacement is also a duplicate', async () => {
    mockState.fallbackPayment = { ...SUPERSEDED };
    mockState.replacementPayment = { id: 'pay-new', status: 'processing' };
    await handlePaymentIntentSucceeded(succeededPI({ id: 'pi_sca_orig' }));
    expect(mockState.inserts.find((i) => i.table === 'stripe_orphan_charges')).toBeTruthy();
    expect(paymentsUpdates()).toHaveLength(1);
  });

  test('control: a failed row superseded by nothing paid (a failed attempt) still flips to paid as before', async () => {
    mockState.fallbackPayment = { ...SUPERSEDED };
    mockState.replacementPayment = null; // the superseder is not paid/processing
    await handlePaymentIntentSucceeded(succeededPI({ id: 'pi_sca_orig' }));
    expect(mockState.inserts.find((i) => i.table === 'stripe_orphan_charges')).toBeFalsy();
    expect(paymentsUpdates()).toHaveLength(2); // processing attempt + the fallback flip
  });

  test('control: an unsuperseded failed row still flips to paid (its own PI completing is a normal success)', async () => {
    mockState.fallbackPayment = { ...SUPERSEDED, superseded_by_payment_id: null };
    mockState.replacementPayment = { id: 'pay-new', status: 'paid' };
    await handlePaymentIntentSucceeded(succeededPI({ id: 'pi_sca_orig' }));
    expect(mockState.inserts.find((i) => i.table === 'stripe_orphan_charges')).toBeFalsy();
    expect(paymentsUpdates()).toHaveLength(2);
  });
});
