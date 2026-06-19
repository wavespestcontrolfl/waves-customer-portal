jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/pay123'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, providerMessageId: 'sms-1' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (templateKey) => `sms body for ${templateKey}`),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-1', status: 'sent', sent_at: '2026-05-20T12:00:00.000Z' },
  })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'billing@example.com', name: 'Taylor', role: 'primary' }]),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const EmailTemplates = require('../services/email-template-library');
const BalanceReminder = require('../services/workflows/balance-reminder');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'where',
    'whereIn',
    'whereNotNull',
    'whereNotIn',
    'whereNull',
    'orderBy',
    'orderByRaw',
    'select',
    'count',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
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
  return tableQueues;
}

function overduePayment(daysOverdue = 8) {
  const date = new Date(Date.now() - daysOverdue * 86400000);
  return {
    id: 'pay-1',
    customer_id: 'cust-1',
    amount: '129.00',
    status: 'failed',
    payment_date: date.toISOString().slice(0, 10),
  };
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    customer_id: 'cust-1',
    token: 'token-1',
    invoice_number: 'WPC-2026-1042',
    status: 'sent',
    title: 'Quarterly Pest Control',
    service_type: 'Pest Control',
    service_date: '2026-05-12',
    due_date: '2026-05-19',
    total: '129.00',
    ...overrides,
  };
}

function customer(overrides = {}) {
  return {
    id: 'cust-1',
    first_name: 'Taylor',
    last_name: 'Morgan',
    phone: '+19415550101',
    email: 'taylor@example.com',
    active: true,
    waveguard_tier: 'Gold',
    ...overrides,
  };
}

describe('late-payment email sidecar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('latePaymentCheck keeps SMS send behavior and sends the matching 7-day email template', async () => {
    const activeCustomer = customer();
    const openInvoice = invoice();
    const emailInteraction = chain();
    const smsInteraction = chain();

    setDbQueues({
      customers: [chain({ result: [activeCustomer] })],
      payments: [chain({ result: [overduePayment(8)] })],
      invoices: [
        chain({ result: [] }), // getCustomerBalance payer-billed invoice-id lookup (none)
        chain({ first: { id: openInvoice.id, token: openInvoice.token } }),
        chain({ first: openInvoice }),
        chain({ first: openInvoice }),
      ],
      sms_log: [
        chain({ first: { count: '0' } }),
        chain({ first: null }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [emailInteraction, smsInteraction],
    });

    await BalanceReminder.latePaymentCheck();

    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'late_payment_7d',
      expect.objectContaining({
        first_name: 'Taylor',
        invoice_title: 'Quarterly Pest Control',
        pay_url: 'https://portal.wavespestcontrol.com/l/pay123',
      }),
      expect.objectContaining({
        workflow: 'balance_late_payment_check',
        entity_type: 'invoice',
        entity_id: 'inv-1',
      }),
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      body: 'sms body for late_payment_7d',
      channel: 'sms',
      audience: 'customer',
      purpose: 'payment_link',
      customerId: 'cust-1',
      invoiceId: 'inv-1',
      entryPoint: 'balance_reminder_late_payment_check',
      metadata: { original_message_type: 'late_payment' },
    }));
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'billing_late_payment_7_day',
      to: 'billing@example.com',
      recipientType: 'customer',
      recipientId: 'cust-1',
      triggerEventId: 'late_payment:inv-1:7',
      idempotencyKey: 'late_payment_email:inv-1:7',
      suppressionGroupKey: 'transactional_required',
      payload: expect.objectContaining({
        first_name: 'Taylor',
        invoice_title: 'Quarterly Pest Control',
        service_date_clause: ' completed on May 12, 2026',
        amount_due: '$129.00',
        due_date: 'May 19, 2026',
        invoice_number: 'WPC-2026-1042',
        pay_url: 'https://portal.wavespestcontrol.com/l/pay123',
      }),
    }));
    expect(smsInteraction.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'cust-1',
      interaction_type: 'sms_outbound',
    }));
  });

  test.each([
    ['late_payment_7d', 'billing_late_payment_7_day', 7],
    ['late_payment_14d', 'billing_late_payment_14_day', 14],
    ['late_payment_30d', 'billing_late_payment_30_day', 30],
    ['late_payment_60d', 'billing_late_payment_60_day', 60],
    ['late_payment_90d', 'billing_late_payment_90_day', 90],
  ])('selects %s email template and invoice-stage idempotency', async (smsTemplateKey, emailTemplateKey, stageDays) => {
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain()],
    });

    await BalanceReminder.sendLatePaymentEmail({
      customer: customer(),
      invoice: invoice(),
      balance: { totalBalance: 129, oldestDueDate: '2026-05-19' },
      smsTemplateKey,
      invoiceTitle: 'Quarterly Pest Control',
      serviceDateClause: '',
      payUrl: 'https://portal.wavespestcontrol.com/pay/token-1',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: emailTemplateKey,
      idempotencyKey: `late_payment_email:inv-1:${stageDays}`,
      triggerEventId: `late_payment:inv-1:${stageDays}`,
    }));
  });

  test('does not send a late-payment email when the invoice is paid', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice({ status: 'paid', paid_at: new Date() }) })],
    });

    const result = await BalanceReminder.sendLatePaymentEmail({
      customer: customer(),
      invoice: invoice(),
      balance: { totalBalance: 129, oldestDueDate: '2026-05-19' },
      smsTemplateKey: 'late_payment_30d',
      invoiceTitle: 'Quarterly Pest Control',
      serviceDateClause: '',
      payUrl: 'https://portal.wavespestcontrol.com/pay/token-1',
    });

    expect(result).toMatchObject({ skipped: true, reason: 'invoice_not_eligible' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('still sends required late-payment email when general customer email is disabled', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: false } })],
      customer_interactions: [chain()],
    });

    await BalanceReminder.sendLatePaymentEmail({
      customer: customer(),
      invoice: invoice(),
      balance: { totalBalance: 129, oldestDueDate: '2026-05-19' },
      smsTemplateKey: 'late_payment_30d',
      invoiceTitle: 'Quarterly Pest Control',
      serviceDateClause: '',
      payUrl: 'https://portal.wavespestcontrol.com/pay/token-1',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'billing_late_payment_30_day',
      suppressionGroupKey: 'transactional_required',
    }));
  });

  test('email failure is logged and does not block the late-payment SMS path', async () => {
    EmailTemplates.sendTemplate.mockRejectedValueOnce(new Error('sendgrid down'));
    const emailFailureInteraction = chain();
    const smsInteraction = chain();

    setDbQueues({
      customers: [chain({ result: [customer()] })],
      payments: [chain({ result: [overduePayment(8)] })],
      invoices: [
        chain({ result: [] }), // getCustomerBalance payer-billed invoice-id lookup (none)
        chain({ first: { id: 'inv-1', token: 'token-1' } }),
        chain({ first: invoice() }),
        chain({ first: invoice() }),
      ],
      sms_log: [
        chain({ first: { count: '0' } }),
        chain({ first: null }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [emailFailureInteraction, smsInteraction],
    });

    await expect(BalanceReminder.latePaymentCheck()).resolves.toBeUndefined();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(emailFailureInteraction.insert).toHaveBeenCalledWith(expect.objectContaining({
      interaction_type: 'email_outbound',
      subject: '7-day late payment email failed',
    }));
    expect(smsInteraction.insert).toHaveBeenCalledWith(expect.objectContaining({
      interaction_type: 'sms_outbound',
    }));
  });
});
