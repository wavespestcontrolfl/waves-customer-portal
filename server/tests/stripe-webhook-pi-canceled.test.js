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
jest.mock('../services/pay-combined', () => ({
  isCombinedPiMetadata: jest.fn(() => false),
  clearPaymentIntentStamps: jest.fn(async () => 0),
}));

const mockState = {};
function resetMockState() {
  Object.assign(mockState, {
    stampedInvoices: [],
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
  b.first = async () => null;
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
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

const STAMPED = { id: 'inv-1', status: 'processing', stripe_payment_intent_id: 'pi_ach_1', ach_processing_notified_at: new Date() };

const invoiceReverts = () => mockState.updates.filter((u) => u.table === 'invoices' && u.patch.stripe_payment_intent_id === null);
const paymentUpdates = () => mockState.updates.filter((u) => u.table === 'payments');

beforeEach(() => {
  jest.clearAllMocks();
  resetMockState();
  isCombinedPiMetadata.mockReturnValue(false);
});

test('single-invoice ACH PI canceled after processing: payment canceled, invoice reopened and unstamped', async () => {
  mockState.stampedInvoices = [{ ...STAMPED }];
  await handleCanceled({ id: 'pi_ach_1', metadata: {} });

  expect(paymentUpdates()).toHaveLength(1);
  expect(paymentUpdates()[0].patch).toEqual({ status: 'canceled' });

  const reverts = invoiceReverts();
  expect(reverts).toHaveLength(1);
  expect(reverts[0].wheres).toContainEqual({ id: 'inv-1', status: 'processing' });
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
