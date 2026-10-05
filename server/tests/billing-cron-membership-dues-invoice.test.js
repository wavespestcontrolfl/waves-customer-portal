/**
 * B08 — the monthly cron must not charge a month a live completion-minted
 * membership-dues invoice already bills. A member whose card expired got the
 * dues invoice minted at a plan visit's completion; paid or still open, that
 * invoice IS the month's bill (an unpaid one is collected by the invoice
 * follow-up ladder). Restoring autopay must not make the cron bill it again.
 *
 * Mirrors the billing-cron-billing-mode.test.js harness; the invoice lookup
 * is the shared findLiveStampedDuesInvoice (billing-lane.js).
 */
let mockCustomers = [];
let mockDuesInvoiceRow = null;

jest.mock('../models/db', () => {
  function thenableFor(resultFn) {
    const b = {};
    for (const m of [
      'where', 'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNull',
      'whereNotNull', 'whereRaw', 'distinct', 'select', 'orderBy', 'update',
      'insert', 'returning', 'count', 'pluck', 'join', 'leftJoin',
    ]) b[m] = () => b;
    b.first = () => Promise.resolve(null);
    b.then = (resolve, reject) => Promise.resolve(resultFn()).then(resolve, reject);
    return b;
  }
  const db = jest.fn((table) => {
    if (table === 'customers') return thenableFor(() => mockCustomers);
    if (table === 'invoices') {
      const b = thenableFor(() => []);
      b.first = () => Promise.resolve(mockDuesInvoiceRow);
      return b;
    }
    return thenableFor(() => []);
  });
  db.schema = { hasTable: jest.fn(() => Promise.resolve(true)) };
  db.fn = { now: () => new Date('2026-09-23T12:00:00Z') };
  return db;
});

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSms: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(() => Promise.resolve({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(() => 'msg') }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(() => Promise.resolve('Hi there')) }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendChargeSuccess: jest.fn(), sendChargeFailed: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({}));
jest.mock('../services/billing-helpers', () => ({ isBillingDayMatch: jest.fn(() => true) }));
jest.mock('../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(),
}));

const StripeService = require('../services/stripe');
const { logAutopay } = require('../services/autopay-log');
const BillingCron = require('../services/billing-cron');

const member = {
  id: 'cust-dues', first_name: 'Synthetic', last_name: 'Member', phone: '+15550004444',
  monthly_rate: 49, waveguard_tier: 'Silver', autopay_enabled: true, autopay_paused_until: null,
  autopay_payment_method_id: 'pm_1', billing_day: 1, billing_mode: 'monthly_membership',
};

beforeEach(() => {
  mockCustomers = [member];
  mockDuesInvoiceRow = null;
  jest.clearAllMocks();
  StripeService.chargeMonthly.mockReset();
});

describe('processMonthlyBilling — a live stamped membership-dues invoice bills the month', () => {
  test.each(['sent', 'paid'])('a %s stamped dues invoice for the month → no charge, logged as already paid', async (status) => {
    mockDuesInvoiceRow = { id: 'inv-dues', status, scheduled_service_id: 'visit-1' };
    await BillingCron.processMonthlyBilling();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(logAutopay).toHaveBeenCalledWith('cust-dues', 'skipped_already_paid', expect.anything());
  });

  test('no live stamped dues invoice → the cron charges as before', async () => {
    StripeService.chargeMonthly.mockResolvedValue({ id: 'pay-1', status: 'paid', amount: 49 });
    await BillingCron.processMonthlyBilling();
    expect(StripeService.chargeMonthly).toHaveBeenCalledTimes(1);
  });
});
