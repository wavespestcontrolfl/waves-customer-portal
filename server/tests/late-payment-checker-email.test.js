jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
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

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const BalanceReminder = require('../services/workflows/balance-reminder');
const InvoiceFollowUps = require('../services/invoice-followups');
const LatePaymentChecker = require('../services/late-payment-checker');

function chain({ result = [], first } = {}) {
  const q = {};
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q);
    return q;
  });
  q.whereIn = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.andWhere = jest.fn(() => q);
  q.orWhere = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q);
    return q;
  });
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

describe('late-payment checker email sidecar', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('sends the matching late-payment email after the legacy fallback SMS path succeeds', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = {
      id: 'cust-1',
      first_name: 'Taylor',
      phone: '+19415550101',
    };

    setDbQueues({
      invoices: [chain({ result: [invoice] })],
      activity_log: [chain({ first: null }), chain()],
      customers: [chain({ first: customer })],
    });

    await LatePaymentChecker.checkAndNotify();

    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'late_payment_14d',
      expect.objectContaining({
        first_name: 'Taylor',
        invoice_title: 'Quarterly Pest Control',
        pay_url: 'https://portal.wavespestcontrol.com/l/pay123',
      }),
      expect.objectContaining({
        workflow: 'late_payment_reminder',
        entity_type: 'invoice',
        entity_id: 'inv-1',
      }),
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      body: 'sms body for late_payment_14d',
      entryPoint: 'late_payment_checker',
      metadata: { original_message_type: 'late_payment' },
    }));
    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenCalledWith(expect.objectContaining({
      customer,
      invoice,
      smsTemplateKey: 'late_payment_14d',
      invoiceTitle: 'Quarterly Pest Control',
      payUrl: 'https://portal.wavespestcontrol.com/l/pay123',
    }));
  });

  test('falls back to the email reminder when the SMS is permanently undeliverable (landline suppression)', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+18777175476' };

    // The number bounced as a landline on a prior run → now hard-suppressed.
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, code: 'SUPPRESSED_NON_MOBILE', retryable: false,
    });

    setDbQueues({
      invoices: [chain({ result: [invoice] })],
      activity_log: [chain({ first: null }), chain()],
      customers: [chain({ first: customer })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    // Email still goes out even though the SMS was blocked.
    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenCalledWith(expect.objectContaining({
      customer,
      invoice,
      smsTemplateKey: 'late_payment_14d',
    }));
    expect(result.notified).toBe(0);
    expect(result.emailedFallback).toBe(1);
  });

  test('defers (no email) when the SMS is only transiently held so a later run can retry', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };

    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', retryable: true, deferred: true,
    });

    setDbQueues({
      invoices: [chain({ result: [invoice] })],
      activity_log: [chain({ first: null })],
      customers: [chain({ first: customer })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(result.notified).toBe(0);
    expect(result.emailedFallback).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('does not send a late-payment reminder when the per-invoice follow-up sequence was stopped by an admin', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };

    // Admin clicked "stop" on the AUTOMATED FOLLOW-UPS card — dunning is off for this invoice.
    InvoiceFollowUps.hasActiveSequence.mockResolvedValueOnce(false);
    InvoiceFollowUps.isDunningStopped.mockResolvedValueOnce(true);

    setDbQueues({
      invoices: [chain({ result: [invoice] })],
    });

    await LatePaymentChecker.checkAndNotify();

    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
  });
});
