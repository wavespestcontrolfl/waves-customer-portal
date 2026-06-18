jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-123', status: 'sent', sent_at: '2026-05-20T12:00:00.000Z' },
  })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'billing@example.com', name: 'Taylor Morgan', role: 'primary' }]),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'where',
    'whereIn',
    'whereNotNull',
    'whereNotIn',
    'whereNull',
    'select',
    'orderBy',
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

function customer(overrides = {}) {
  return {
    id: 'cust-1',
    first_name: 'Taylor',
    last_name: 'Morgan',
    company_name: null,
    email: 'taylor@example.com',
    phone: '+19415550101',
    ...overrides,
  };
}

function paymentMethod(overrides = {}) {
  return {
    id: 'pm-1',
    customer_id: 'cust-1',
    method_type: 'card',
    card_brand: 'Visa',
    last_four: '4242',
    exp_month: '08',
    exp_year: '2026',
    ...overrides,
  };
}

function payment(overrides = {}) {
  return {
    id: 'pay-1',
    customer_id: 'cust-1',
    payment_method_id: 'pm-1',
    amount: '129.00',
    payment_date: '2026-05-20',
    next_retry_at: '2026-05-23',
    description: 'Quarterly Pest Control — FAILED',
    stripe_payment_intent_id: 'pi_sensitive',
    stripe_refund_id: null,
    ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    customer_id: 'cust-1',
    invoice_number: 'INV-1001',
    title: 'Quarterly Pest Control',
    token: 'pay-token',
    total: '129.00',
    ...overrides,
  };
}

function lifecycleQueues(extra = {}) {
  return {
    customers: [chain({ first: customer(extra.customer) })],
    notification_prefs: [chain({ first: { email_enabled: true, ...(extra.prefs || {}) } })],
    customer_interactions: [extra.interaction || chain()],
  };
}

describe('payment lifecycle email sender', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends autopay setup confirmation with a stable idempotency key', async () => {
    setDbQueues({
      payment_methods: [chain({ first: paymentMethod() })],
      ...lifecycleQueues(),
    });

    await PaymentLifecycleEmail.sendAutopayEnabled({
      customerId: 'cust-1',
      paymentMethodId: 'pm-1',
      enabledDate: '2026-05-20',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.autopay_enabled',
      to: 'billing@example.com',
      idempotencyKey: 'payment.autopay_enabled:cust-1:pm-1:2026-05-20',
      suppressionGroupKey: 'transactional_required',
      payload: expect.objectContaining({
        first_name: 'Taylor',
        payment_method_label: 'Visa ending in 4242',
      }),
    }));
  });

  test('sends payment method update with old and new method labels', async () => {
    setDbQueues({
      payment_methods: [
        chain({ first: paymentMethod({ id: 'pm-old', last_four: '1881' }) }),
        chain({ first: paymentMethod({ id: 'pm-new', last_four: '4242' }) }),
      ],
      ...lifecycleQueues(),
    });

    await PaymentLifecycleEmail.sendPaymentMethodUpdated({
      customerId: 'cust-1',
      oldPaymentMethodId: 'pm-old',
      newPaymentMethodId: 'pm-new',
      updatedAt: '2026-05-20',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.method_updated',
      idempotencyKey: 'payment.method_updated:cust-1:pm-old:pm-new:2026-05-20',
      payload: expect.objectContaining({
        old_payment_method_label: 'Visa ending in 1881',
        new_payment_method_label: 'Visa ending in 4242',
      }),
    }));
  });

  test('sends expiring-card notice with payment-method stage idempotency', async () => {
    setDbQueues({
      payment_methods: [chain({ first: paymentMethod() })],
      ...lifecycleQueues(),
    });

    await PaymentLifecycleEmail.sendPaymentMethodExpiring({
      customerId: 'cust-1',
      paymentMethodId: 'pm-1',
      reminderStage: '30_day',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.method_expiring',
      idempotencyKey: 'payment.method_expiring:cust-1:pm-1:08:2026:30_day',
      payload: expect.objectContaining({
        expiration_month: '08',
        expiration_year: '2026',
        expiration_label: '08/2026',
      }),
    }));
  });

  test('sends retry notice using invoice and payment data', async () => {
    setDbQueues({
      payments: [chain({ first: payment({ metadata: JSON.stringify({ invoice_id: 'inv-1' }) }) })],
      invoices: [chain({ first: invoice() })],
      payment_methods: [chain({ first: paymentMethod() })],
      ...lifecycleQueues(),
    });

    await PaymentLifecycleEmail.sendPaymentRetryNotice({
      customerId: 'cust-1',
      paymentId: 'pay-1',
      retryDate: '2026-05-23',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.retry_notice',
      idempotencyKey: 'payment.retry_notice:inv-1:pay-1:2026-05-23',
      payload: expect.objectContaining({
        invoice_title: 'Quarterly Pest Control',
        invoice_number: 'INV-1001',
        amount_due: '$129.00',
        pay_url: expect.stringContaining('/pay/pay-token'),
      }),
    }));
  });

  test('sends payment failure notice keyed on payment intent + attempt', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: payment() })],
      ...lifecycleQueues(),
    });

    await PaymentLifecycleEmail.sendPaymentFailed({
      customerId: 'cust-1',
      paymentIntentId: 'pi_test',
      attemptId: 'ch_attempt1',
      invoiceId: 'inv-1',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.failed',
      idempotencyKey: 'payment.failed:pi_test:ch_attempt1',
      payload: expect.objectContaining({
        invoice_number: 'INV-1001',
        payment_url: expect.stringContaining('/pay/pay-token'),
      }),
    }));
  });

  test('sends payment plan confirmation through the shared lifecycle sender', async () => {
    setDbQueues({
      payment_methods: [chain({ first: paymentMethod() })],
      ...lifecycleQueues(),
    });

    await PaymentLifecycleEmail.sendPaymentPlanConfirmed({
      customerId: 'cust-1',
      paymentPlanId: 'plan-1',
      paymentMethodId: 'pm-1',
      plan: {
        total_balance: '390.00',
        payment_amount: '130.00',
        payment_frequency: 'monthly',
        next_payment_date: '2026-06-20',
      },
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.plan_confirmed',
      idempotencyKey: 'payment.plan_confirmed:plan-1:cust-1',
      payload: expect.objectContaining({
        total_balance: '$390.00',
        payment_amount: '$130.00',
        payment_frequency: 'monthly',
      }),
    }));
  });

  test('sends refund issued notice without exposing processor identifiers', async () => {
    setDbQueues({
      payments: [chain({ first: payment({ stripe_refund_id: 're_sensitive', refund_amount: '49.00' }) })],
      payment_methods: [chain({ first: paymentMethod() })],
      ...lifecycleQueues(),
    });

    await PaymentLifecycleEmail.sendRefundIssued({
      customerId: 'cust-1',
      paymentId: 'pay-1',
      refundId: 're_sensitive',
      refundAmount: '49.00',
      refundDate: '2026-05-20',
      refundReason: 'Account adjustment',
    });

    const payload = EmailTemplates.sendTemplate.mock.calls[0][0].payload;
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.refund_issued',
      idempotencyKey: 'payment.refund_issued:re_sensitive:cust-1',
      payload: expect.objectContaining({
        refund_amount: '$49.00',
        refund_reason: 'Account adjustment',
      }),
    }));
    expect(JSON.stringify(payload)).not.toMatch(/pi_sensitive|re_sensitive|pm_/);
  });

  test('sends ACH processing acknowledgment with invoice metadata and explicit idempotency key', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      ...lifecycleQueues(),
    });

    const result = await PaymentLifecycleEmail.sendAchProcessing({
      customerId: 'cust-1',
      invoiceId: 'inv-1',
      amountPaid: '117.00',
      initiatedAt: '2026-05-22',
      expectedClearDate: '2026-05-29',
      idempotencyKey: 'payment.ach_processing:inv-1:evt_abc',
    });

    expect(result).toMatchObject({ ok: true });
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.ach_processing',
      idempotencyKey: 'payment.ach_processing:inv-1:evt_abc',
      suppressionGroupKey: 'transactional_required',
      payload: expect.objectContaining({
        first_name: 'Taylor',
        invoice_title: 'Quarterly Pest Control',
        invoice_number: 'INV-1001',
        amount_paid: '$117.00',
        pay_url: expect.stringContaining('/pay/pay-token'),
      }),
    }));
  });

  test('falls back to invoice total and default idempotency key when amountPaid is omitted', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      ...lifecycleQueues(),
    });

    await PaymentLifecycleEmail.sendAchProcessing({
      customerId: 'cust-1',
      invoiceId: 'inv-1',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.ach_processing',
      idempotencyKey: 'payment.ach_processing:inv-1',
      payload: expect.objectContaining({
        amount_paid: '$129.00',
      }),
    }));
  });

  test('skips ACH processing send when invoice cannot be found', async () => {
    setDbQueues({
      invoices: [chain({ first: null })],
    });

    const result = await PaymentLifecycleEmail.sendAchProcessing({
      customerId: 'cust-1',
      invoiceId: 'missing',
    });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'invoice_not_found' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('skips payment failure notice for a payer-billed invoice (homeowner must not be notified)', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice({ payer_id: 7 }) })],
      payments: [chain({ first: payment() })],
    });

    const result = await PaymentLifecycleEmail.sendPaymentFailed({
      customerId: 'cust-1',
      paymentIntentId: 'pi_test',
      attemptId: 'ch_attempt1',
      invoiceId: 'inv-1',
    });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'payer_billed' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('skips ACH processing notice for a payer-billed invoice', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice({ payer_id: 7 }) })],
    });

    const result = await PaymentLifecycleEmail.sendAchProcessing({
      customerId: 'cust-1',
      invoiceId: 'inv-1',
    });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'payer_billed' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('still sends required payment notices when general customer email is disabled', async () => {
    const interaction = chain();
    setDbQueues({
      ...lifecycleQueues({ prefs: { email_enabled: false }, interaction }),
    });

    const result = await PaymentLifecycleEmail.sendPaymentPlanConfirmed({
      customerId: 'cust-1',
      paymentPlanId: 'plan-1',
      plan: {},
    });

    expect(result).toMatchObject({ ok: true, messageId: 'sg-123' });
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.plan_confirmed',
      suppressionGroupKey: 'transactional_required',
    }));
    expect(interaction.insert).toHaveBeenCalledWith(expect.objectContaining({
      interaction_type: 'email_outbound',
      subject: 'payment.plan_confirmed email sent',
    }));
  });

  test('uses email_messages idempotency result without duplicate audit logging', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({
      deduped: true,
      sent: true,
      message: { provider_message_id: 'sg-existing' },
    });
    setDbQueues({
      payment_methods: [chain({ first: paymentMethod() })],
      customers: [chain({ first: customer() })],
      notification_prefs: [chain({ first: { email_enabled: true } })],
    });

    const result = await PaymentLifecycleEmail.sendAutopayEnabled({
      customerId: 'cust-1',
      paymentMethodId: 'pm-1',
      enabledDate: '2026-05-20',
    });

    expect(result).toMatchObject({ deduped: true, messageId: 'sg-existing' });
    expect(db).not.toHaveBeenCalledWith('customer_interactions');
  });
});
