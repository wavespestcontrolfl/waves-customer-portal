/**
 * charge.refunded routing for the opt-in settled, one-payment card ledger.
 *
 * These are deliberately webhook-level unit tests. The shared ledger module
 * owns provider-history arithmetic; this file pins the route boundaries:
 * provider I/O precedes row locks, the locked row is re-checked, current
 * provider totals drive the payment/full-refund effects, and the event's own
 * refund id/amount remain the receipt identity.
 */

const mockRefundsList = jest.fn();
const mockReadSinglePaymentRefunds = jest.fn();
const mockProjectSinglePaymentRefund = jest.fn();
const mockProjectAmbiguousCardRefund = jest.fn();
const mockSettledCardRefundsLive = jest.fn();
const mockUsesSettledCardRefundLedger = jest.fn();
const mockForUpdate = jest.fn();
const mockPaymentUpdate = jest.fn();
const mockWhereIn = jest.fn();

jest.mock('stripe', () => jest.fn(() => ({ refunds: { list: mockRefundsList } })));
jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.transaction = jest.fn();
  return dbMock;
});
jest.mock('../services/settled-card-refunds', () => ({
  projectAmbiguousCardRefund: (...args) => mockProjectAmbiguousCardRefund(...args),
  readSinglePaymentRefunds: (...args) => mockReadSinglePaymentRefunds(...args),
  projectSinglePaymentRefund: (...args) => mockProjectSinglePaymentRefund(...args),
  settledCardRefundsLive: () => mockSettledCardRefundsLive(),
  usesSettledCardRefundLedger: (...args) => mockUsesSettledCardRefundLedger(...args),
}));
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
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => undefined) }));
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
jest.mock('../services/invoice-helpers', () => ({
  INVOICE_UNCOLLECTIBLE_STATUSES: ['void'],
  invoiceAmountDue: jest.fn(),
  refundedPaymentOwnsInvoice: jest.fn(() => false),
}));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendRefundIssued: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({
  acquireTermiteGateForCharge: jest.fn(async () => []),
  syncTermForInvoicePayment: jest.fn(),
  syncTermForRefundedPayment: jest.fn(async () => []),
}));
jest.mock('../services/estimate-deposits', () => ({
  handleDepositChargeReversed: jest.fn(async () => ({ handled: false })),
}));
jest.mock('../services/customer-health', () => ({ scoreCustomer: jest.fn(async () => undefined) }));
jest.mock('../services/stripe', () => ({
  ...jest.requireActual('../services/stripe'),
  retrievePaymentIntent: jest.fn(async (piId) => ({ id: piId, metadata: {} })),
}));

const db = require('../models/db');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const { triggerNotification } = require('../services/notification-triggers');
const { _handleChargeRefunded: handleChargeRefunded } = require('../routes/stripe-webhook');

function chargeEvent(overrides = {}) {
  return {
    id: 'ch_settled_card_1',
    object: 'charge',
    payment_intent: 'pi_settled_card_1',
    paid: true,
    status: 'succeeded',
    captured: true,
    payment_method_details: { type: 'card' },
    amount: 10000,
    amount_captured: 10000,
    amount_refunded: 10000,
    refunded: true,
    metadata: {},
    refunds: {
      data: [{
        id: 're_event',
        amount: 9000,
        created: 1780000000,
        status: 'succeeded',
        charge: 'ch_settled_card_1',
        payment_intent: 'pi_settled_card_1',
      }],
    },
    ...overrides,
  };
}

function projectColumns(row, columns) {
  if (!row || !columns.length) return row || null;
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

function installDb({ visibleOutside = true, paymentOverrides = {} } = {}) {
  let inTransaction = false;
  const payment = {
    id: 'pay-1',
    customer_id: 'cust-1',
    invoice_id: null,
    processor: 'stripe',
    status: 'paid',
    amount: '100.00',
    refund_amount: '20.00',
    refund_status: 'partial',
    stripe_charge_id: 'ch_settled_card_1',
    stripe_payment_intent_id: 'pi_settled_card_1',
    payment_method_type: 'card',
    surcharge_amount_cents: 0,
    metadata: JSON.stringify({ stamped_refund_ids: ['re_earlier'] }),
    ...paymentOverrides,
  };

  function rowsFor(table, filters, ids) {
    if (table !== 'payments' || (!visibleOutside && !inTransaction)) return [];
    const rows = [payment].filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
    return ids ? rows.filter((row) => ids.includes(row.id)) : rows;
  }

  function query(table) {
    const filters = {};
    let ids = null;
    const q = {
      where(arg, value) {
        if (arg && typeof arg === 'object') Object.assign(filters, arg);
        else if (typeof arg === 'string' && arguments.length > 1) filters[arg] = value;
        return q;
      },
      whereIn(column, values) {
        mockWhereIn(column, values);
        if (column === 'id') ids = values;
        return q;
      },
      forUpdate() {
        mockForUpdate();
        return q;
      },
      first(...columns) {
        return Promise.resolve(projectColumns(rowsFor(table, filters, ids)[0], columns));
      },
      update(patch) {
        const rows = rowsFor(table, filters, ids);
        for (const row of rows) Object.assign(row, patch);
        if (table === 'payments') mockPaymentUpdate(patch);
        return Promise.resolve(rows.length);
      },
      then(resolve, reject) {
        return Promise.resolve(rowsFor(table, filters, ids).map((row) => ({ ...row }))).then(resolve, reject);
      },
    };
    return q;
  }

  db.mockImplementation(query);
  db.schema = { hasTable: jest.fn(async () => false) };
  db.fn = { now: jest.fn(() => new Date('2026-11-20T12:00:00Z')) };
  db.raw = jest.fn(async () => undefined);
  db.transaction = jest.fn(async (callback) => {
    inTransaction = true;
    try {
      return await callback(db);
    } finally {
      inTransaction = false;
    }
  });
  return payment;
}

describe('charge.refunded settled-card ledger routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettledCardRefundsLive.mockReturnValue(true);
    mockUsesSettledCardRefundLedger.mockResolvedValue(true);
    mockReadSinglePaymentRefunds.mockResolvedValue({ snapshot: 'current-provider-ledger' });
    mockProjectSinglePaymentRefund.mockReturnValue({
      bounced: false,
      totalCents: 3000,
      isFull: false,
      latestRefundId: 're_event',
      refundCents: 1000,
      metadata: {
        settled_card_refund_ledger: 1,
        stamped_refund_ids: ['re_earlier', 're_event'],
      },
    });
    mockProjectAmbiguousCardRefund.mockReset();
  });

  test('reads Stripe before locking, then stamps verified current total/full while the receipt keeps this refund amount', async () => {
    const payment = installDb();

    await handleChargeRefunded(chargeEvent());

    expect(mockReadSinglePaymentRefunds).toHaveBeenCalledWith(expect.anything(), {
      chargeId: 'ch_settled_card_1',
      paymentIntentId: 'pi_settled_card_1',
    });
    expect(mockReadSinglePaymentRefunds.mock.invocationCallOrder[0]).toBeLessThan(mockForUpdate.mock.invocationCallOrder[0]);
    expect(mockUsesSettledCardRefundLedger).toHaveBeenCalledTimes(2);
    expect(mockProjectSinglePaymentRefund).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pay-1' }),
      { snapshot: 'current-provider-ledger' },
      're_event',
    );
    expect(payment).toEqual(expect.objectContaining({
      status: 'paid',
      refund_amount: 30,
      refund_status: 'partial',
      stripe_refund_id: 're_event',
    }));
    expect(JSON.parse(payment.metadata)).toEqual({
      settled_card_refund_ledger: 1,
      stamped_refund_ids: ['re_earlier', 're_event'],
    });
    expect(PaymentLifecycleEmail.sendRefundIssued).toHaveBeenCalledWith(expect.objectContaining({
      refundId: 're_event',
      refundAmount: 10,
    }));
    expect(triggerNotification).toHaveBeenCalledWith('payment_refunded', expect.objectContaining({
      amount: 10,
      isFullRefund: false,
    }));
  });

  test('a failed/canceled or fenced subject changes no row and emits no receipt or notification', async () => {
    installDb();
    mockProjectSinglePaymentRefund.mockReturnValue({ bounced: true, fenced: true });

    await handleChargeRefunded(chargeEvent());

    expect(mockPaymentUpdate).not.toHaveBeenCalled();
    expect(PaymentLifecycleEmail.sendRefundIssued).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a normally unexpanded event resolves its one active refund before canonical reconciliation', async () => {
    installDb();
    mockRefundsList.mockReturnValueOnce({
      autoPagingToArray: jest.fn(async () => [{
        id: 're_event',
        amount: 9000,
        created: 1780000000,
        status: 'succeeded',
        charge: 'ch_settled_card_1',
        payment_intent: 'pi_settled_card_1',
      }]),
    });

    await handleChargeRefunded(chargeEvent({ refunds: { data: [] }, amount_refunded: 9000, refunded: false }));

    expect(mockProjectSinglePaymentRefund).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pay-1' }),
      { snapshot: 'current-provider-ledger' },
      're_event',
    );
    expect(PaymentLifecycleEmail.sendRefundIssued).toHaveBeenCalledWith(expect.objectContaining({
      refundId: 're_event',
      refundAmount: 10,
    }));
  });

  test('an ambiguous id-less event reconciles the verified active replacement only after the historical failure fence', async () => {
    const payment = installDb({
      paymentOverrides: {
        refund_amount: '0.00',
        stripe_refund_id: null,
        metadata: JSON.stringify({ failed_refund_ids: ['re_failed_a'] }),
      },
    });
    const failedA = {
      id: 're_failed_a', amount: 4000, created: 1780000000, status: 'failed',
      charge: 'ch_settled_card_1', payment_intent: 'pi_settled_card_1',
    };
    const activeB = {
      id: 're_active_b', amount: 4000, created: 1780000100, status: 'succeeded', reason: 'duplicate',
      charge: 'ch_settled_card_1', payment_intent: 'pi_settled_card_1',
    };
    mockRefundsList.mockReturnValueOnce({
      autoPagingToArray: jest.fn(async () => [activeB, failedA]),
    });
    const snapshot = {
      refunds: new Map([[activeB.id, activeB], [failedA.id, failedA]]),
      activeIds: [activeB.id],
      totalCents: 4000,
    };
    mockReadSinglePaymentRefunds.mockResolvedValueOnce(snapshot);
    mockProjectAmbiguousCardRefund.mockReturnValueOnce({
      bounced: false,
      totalCents: 4000,
      isFull: false,
      latestRefundId: activeB.id,
      refundCents: activeB.amount,
      receiptRefund: activeB,
      metadata: {
        failed_refund_ids: [failedA.id],
        settled_card_refund_ledger: 1,
        stamped_refund_ids: [activeB.id],
      },
    });

    await handleChargeRefunded(chargeEvent({
      refunds: { data: [] },
      amount_refunded: 4000,
      refunded: false,
    }));

    expect(mockProjectAmbiguousCardRefund).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pay-1' }),
      snapshot,
      { liveRefundId: activeB.id, historicalRefundId: failedA.id },
    );
    expect(mockProjectSinglePaymentRefund).not.toHaveBeenCalled();
    expect(payment).toEqual(expect.objectContaining({
      status: 'paid',
      refund_amount: 40,
      stripe_refund_id: activeB.id,
    }));
    expect(PaymentLifecycleEmail.sendRefundIssued).toHaveBeenCalledWith(expect.objectContaining({
      refundId: activeB.id,
      refundAmount: 40,
      refundDate: new Date(activeB.created * 1000),
      refundReason: 'duplicate',
    }));
    // The ambiguous delivery is not a trustworthy event-scoped office notice.
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('an ambiguous replacement retries without writes or receipts until the historical failure is durably fenced', async () => {
    installDb({ paymentOverrides: { refund_amount: '0.00', stripe_refund_id: null, metadata: '{}' } });
    const failedA = {
      id: 're_failed_a', amount: 4000, created: 1780000000, status: 'failed',
      charge: 'ch_settled_card_1', payment_intent: 'pi_settled_card_1',
    };
    const activeB = {
      id: 're_active_b', amount: 4000, created: 1780000100, status: 'succeeded',
      charge: 'ch_settled_card_1', payment_intent: 'pi_settled_card_1',
    };
    mockRefundsList.mockReturnValueOnce({
      autoPagingToArray: jest.fn(async () => [activeB, failedA]),
    });
    mockReadSinglePaymentRefunds.mockResolvedValueOnce({
      refunds: new Map([[activeB.id, activeB], [failedA.id, failedA]]),
      activeIds: [activeB.id],
      totalCents: 4000,
    });
    mockProjectAmbiguousCardRefund.mockImplementationOnce(() => {
      throw new Error('The ambiguous refund needs the original bank failure and a verified active replacement');
    });

    await expect(handleChargeRefunded(chargeEvent({
      refunds: { data: [] },
      amount_refunded: 4000,
      refunded: false,
    }))).rejects.toThrow(/needs the original bank failure/);

    expect(mockPaymentUpdate).not.toHaveBeenCalled();
    expect(PaymentLifecycleEmail.sendRefundIssued).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('an eligible row that settles after the outer read retries before any legacy update', async () => {
    installDb({ visibleOutside: false });
    mockUsesSettledCardRefundLedger.mockResolvedValue(true);

    await expect(handleChargeRefunded(chargeEvent())).rejects.toThrow(/retry with a canonical snapshot/);

    expect(mockReadSinglePaymentRefunds).not.toHaveBeenCalled();
    expect(mockForUpdate).toHaveBeenCalledTimes(1);
    expect(mockPaymentUpdate).not.toHaveBeenCalled();
  });

  test('gate-off excluded rows keep the legacy writer without a new row lock or id-scoped update', async () => {
    installDb();
    mockSettledCardRefundsLive.mockReturnValue(false);
    mockUsesSettledCardRefundLedger.mockResolvedValue(false);

    await handleChargeRefunded(chargeEvent({ refunded: false, amount_refunded: 9000 }));

    expect(mockReadSinglePaymentRefunds).not.toHaveBeenCalled();
    expect(mockForUpdate).not.toHaveBeenCalled();
    expect(mockWhereIn).not.toHaveBeenCalled();
    expect(mockPaymentUpdate).toHaveBeenCalled();
  });
});
