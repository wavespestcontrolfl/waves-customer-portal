// late-payment-checker: a micro-deposit-blocked invoice gets a verification
// re-nudge instead of the misleading "X days overdue" dunning.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (templateKey) => `sms body for ${templateKey}`),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/pay123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/invoice-followups', () => ({
  hasActiveSequence: jest.fn(async () => false),
  isDunningStopped: jest.fn(async () => false),
}));
jest.mock('../services/workflows/balance-reminder', () => ({
  sendLatePaymentEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/stripe', () => ({
  isInvoiceAwaitingMicrodepositVerification: jest.fn(async () => false),
}));
jest.mock('../services/microdeposit-verification-email', () => ({
  sendMicrodepositVerificationEmail: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const BalanceReminder = require('../services/workflows/balance-reminder');
const StripeService = require('../services/stripe');
const { sendMicrodepositVerificationEmail } = require('../services/microdeposit-verification-email');
const LatePaymentChecker = require('../services/late-payment-checker');

function chain({ result = [], first } = {}) {
  const q = {};
  q.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  q.whereIn = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.andWhere = jest.fn(() => q);
  q.orWhere = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  q.limit = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.insert = jest.fn(async () => undefined);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

const invoice = {
  id: 'inv-1',
  customer_id: 'cust-1',
  token: 'token-1',
  invoice_number: 'WPC-2026-1042',
  status: 'viewed',
  title: 'Quarterly Pest Control',
  total: '129.00',
  due_date: '2026-05-10',
  service_date: '2026-05-01',
  created_at: '2026-05-01T12:00:00.000Z',
  stripe_payment_intent_id: 'pi_microdeposit',
};
const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };

describe('late-payment micro-deposit diversion', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
    jest.clearAllMocks();
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(false);
  });
  afterEach(() => jest.useRealTimers());

  test('sends the verification re-nudge (not the overdue dunning) for a micro-deposit-blocked invoice', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    setDbQueues({
      invoices: [chain({ result: [invoice] })],
      activity_log: [chain({ first: null }), chain()], // dedupe miss, then the reminder log insert
      customers: [chain({ first: customer })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(StripeService.isInvoiceAwaitingMicrodepositVerification).toHaveBeenCalled();
    // Verification copy, NOT a late_payment_* template.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'bank_verification_incomplete',
      expect.objectContaining({ first_name: 'Taylor' }),
      expect.objectContaining({ workflow: 'microdeposit_verification_reminder' }),
    );
    expect(renderSmsTemplate).not.toHaveBeenCalledWith(expect.stringMatching(/^late_payment_/), expect.anything(), expect.anything());
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      body: 'sms body for bank_verification_incomplete',
      entryPoint: 'late_payment_checker_microdeposit',
    }));
    // Branded verification EMAIL sidecar fires (keyed to the tier), and the
    // generic "overdue" email never does.
    expect(sendMicrodepositVerificationEmail).toHaveBeenCalledWith(expect.objectContaining({
      invoice: expect.objectContaining({ id: 'inv-1' }),
      touchKey: '14d',
    }));
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(result.notified).toBe(1);
  });

  test('falls through to normal dunning when the invoice has a PI but is NOT micro-deposit-blocked', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(false);
    setDbQueues({
      invoices: [chain({ result: [invoice] })],
      activity_log: [chain({ first: null }), chain()],
      customers: [chain({ first: customer })],
    });

    await LatePaymentChecker.checkAndNotify();

    // Generic late-payment dunning, not the verification copy.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      expect.stringMatching(/^late_payment_/),
      expect.anything(),
      expect.objectContaining({ workflow: 'late_payment_reminder' }),
    );
    expect(renderSmsTemplate).not.toHaveBeenCalledWith('bank_verification_incomplete', expect.anything(), expect.anything());
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ entryPoint: 'late_payment_checker' }));
  });
});
