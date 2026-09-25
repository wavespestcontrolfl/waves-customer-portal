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
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({
    sent: true,
    provider: 'twilio',
    providerMessageId: 'SM-payment-failed',
    deliveryOutcome: 'accepted',
  })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => 'Taylor, we could not process your payment.'),
}));
jest.mock('../config/twilio-numbers', () => ({
  getOutboundNumber: jest.fn(() => '+19415550199'),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  withCustomerCommsLock: jest.fn(async (database, _customerId, fn) => fn(database)),
}));
let mockChangeEmailsGate = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: (name) => (name === 'paymentMethodChangeEmails' ? mockChangeEmailsGate : false),
  gates: {},
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'where',
    'whereIn',
    'whereNotNull',
    'whereNotIn',
    'whereNull',
    'whereRaw',
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
    sendCustomerMessage.mockResolvedValue({
      sent: true,
      provider: 'twilio',
      providerMessageId: 'SM-payment-failed',
      deliveryOutcome: 'accepted',
    });
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

  test('sends the Auto Pay turned-off notice naming the method that was in charge', async () => {
    setDbQueues({
      payment_methods: [chain({ first: paymentMethod() })],
      customers: [chain({ first: customer() })],
      notification_prefs: [chain({ first: null })],
      customer_interactions: [chain()],
    });

    await PaymentLifecycleEmail.sendAutopayDisabled({
      customerId: 'cust-1',
      paymentMethodId: 'pm-1',
      disabledAt: '2026-08-28T12:00:00.000Z',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.autopay_disabled',
      idempotencyKey: 'payment.autopay_disabled:cust-1:pm-1:2026-08-28T12:00:00.000Z',
      suppressionGroupKey: 'transactional_required',
      payload: expect.objectContaining({
        payment_method_label: 'Visa ending in 4242',
        autopay_disabled_date: expect.stringContaining('2026'),
      }),
    }));
  });

  test('sends the method-removed notice from a row SNAPSHOT (the row is already deleted) with the Auto Pay note only when it went off', async () => {
    setDbQueues({
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      notification_prefs: [chain({ first: null }), chain({ first: null })],
      customer_interactions: [chain(), chain()],
    });

    await PaymentLifecycleEmail.sendPaymentMethodRemoved({
      customerId: 'cust-1',
      method: paymentMethod({ id: 'pm-gone' }),
      autopayDisabled: false,
      removedAt: '2026-08-28T12:00:00.000Z',
    });
    expect(EmailTemplates.sendTemplate).toHaveBeenLastCalledWith(expect.objectContaining({
      templateKey: 'payment.method_removed',
      // Row-keyed, NOT time-keyed: the portal removal and the detached webhook
      // it triggers must dedupe to one notice.
      idempotencyKey: 'payment.method_removed:cust-1:pm-gone',
      payload: expect.objectContaining({ payment_method_label: 'Visa ending in 4242', autopay_removed_note: '' }),
    }));

    await PaymentLifecycleEmail.sendPaymentMethodRemoved({
      customerId: 'cust-1',
      method: paymentMethod({ id: 'pm-gone' }),
      autopayDisabled: true,
      removedAt: '2026-08-28T12:00:00.000Z',
    });
    expect(EmailTemplates.sendTemplate).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ autopay_removed_note: expect.stringMatching(/Auto Pay was turned off/) }),
    }));
  });

  test('both negative notices are no-ops while GATE_PAYMENT_METHOD_CHANGE_EMAILS is off', async () => {
    mockChangeEmailsGate = false;
    try {
      const a = await PaymentLifecycleEmail.sendAutopayDisabled({ customerId: 'cust-1', paymentMethodId: 'pm-1' });
      const b = await PaymentLifecycleEmail.sendPaymentMethodRemoved({ customerId: 'cust-1', method: paymentMethod() });
      expect(a).toEqual({ ok: false, skipped: true, reason: 'gate_off' });
      expect(b).toEqual({ ok: false, skipped: true, reason: 'gate_off' });
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
      expect(db).not.toHaveBeenCalled();
    } finally {
      mockChangeEmailsGate = true;
    }
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

  test.each(['preparation', 'refused guard', 'failed guard', 'aborted guard', 'provider'])('retry notice preserves %s failure evidence for its durable owner', async (failure) => {
    const prefs = { payment_issue_channels: ['email'] };
    setDbQueues({
      payments: [chain({ first: payment() })],
      payment_methods: [chain({ first: paymentMethod() })],
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      notification_prefs: [chain({ first: prefs }), chain({ first: prefs })],
      customer_interactions: [chain()],
    });
    const beforeProviderHandoff = jest.fn(async () => {
      if (failure === 'failed guard' || failure === 'aborted guard') throw new Error('queue write failed');
      return failure !== 'refused guard';
    });
    const provider = jest.fn(async () => { throw new Error('provider response unavailable'); });
    EmailTemplates.sendTemplate.mockImplementationOnce(async (input) => {
      if (failure === 'preparation') throw new Error('template unavailable');
      if (failure === 'aborted guard') {
        // The template library catches a handoff failure before dispatch
        // and returns an ordinary aborted result instead of rethrowing.
        try { await input.withProviderHandoff(provider); } catch { /* before-provider refusal */ }
        return { sent: false, aborted: true, reason: 'provider_handoff_aborted' };
      }
      await input.withProviderHandoff(provider);
    });
    const result = await PaymentLifecycleEmail.sendPaymentRetryNotice({
      customerId: 'cust-1', paymentId: 'pay-1', retryDate: '2026-05-23', beforeProviderHandoff,
    });
    expect(result).toMatchObject({ ok: false,
      deliveryOutcome: failure === 'provider' ? 'uncertain' : 'not_sent',
      retryable: failure !== 'provider',
    });
    expect(provider).toHaveBeenCalledTimes(failure === 'provider' ? 1 : 0);
    expect(beforeProviderHandoff).toHaveBeenCalledTimes(failure === 'preparation' ? 0 : 1);
    if (failure.includes('guard')) expect(result.reason).toBe('pre_provider_handoff_failed');
    if (failure === 'provider') expect(beforeProviderHandoff.mock.invocationCallOrder[0])
      .toBeLessThan(provider.mock.invocationCallOrder[0]);
  });

  test('a retry notice preference lookup failure is explicitly known not sent', async () => {
    const failedPrefs = chain();
    failedPrefs.first.mockRejectedValueOnce(new Error('preferences unavailable'));
    setDbQueues({
      payments: [chain({ first: payment() })],
      payment_methods: [chain({ first: paymentMethod() })],
      customers: [chain({ first: customer() })],
      notification_prefs: [failedPrefs],
    });
    await expect(PaymentLifecycleEmail.sendPaymentRetryNotice({
      customerId: 'cust-1', paymentId: 'pay-1', retryDate: '2026-05-23',
    })).resolves.toMatchObject({ ok: false, retryable: true, deliveryOutcome: 'not_sent' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('retry and failure notices name a removed bank method from the payment snapshot (GH codex r6 P2)', async () => {
    // payment_method_id was nulled by the method's removal; the delete
    // trigger left the tender on the payment itself.
    const removed = payment({
      payment_method_id: null,
      payment_method_type: 'ach',
      bank_name: 'FIFTH THIRD BANK',
      card_last_four: '2017',
      metadata: JSON.stringify({ invoice_id: 'inv-1' }),
    });
    setDbQueues({
      payments: [chain({ first: removed })],
      invoices: [chain({ first: invoice() })],
      ...lifecycleQueues(),
    });
    await PaymentLifecycleEmail.sendPaymentRetryNotice({ customerId: 'cust-1', paymentId: 'pay-1', retryDate: '2026-05-23' });
    expect(EmailTemplates.sendTemplate).toHaveBeenLastCalledWith(expect.objectContaining({
      templateKey: 'payment.retry_notice',
      payload: expect.objectContaining({
        payment_method_type: 'ach',
        payment_method_label: 'FIFTH THIRD BANK ending in 2017',
      }),
    }));

    setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: removed })],
      ...lifecycleQueues(),
      notification_prefs: [
        chain({ first: { email_enabled: true } }),
        chain({ first: { email_enabled: true } }),
      ],
    });
    await PaymentLifecycleEmail.sendPaymentFailed({ customerId: 'cust-1', paymentIntentId: 'pi_test', attemptId: 'ch_attempt2', invoiceId: 'inv-1' });
    expect(EmailTemplates.sendTemplate).toHaveBeenLastCalledWith(expect.objectContaining({
      templateKey: 'payment.failed',
      payload: expect.objectContaining({ payment_method_label: 'FIFTH THIRD BANK ending in 2017' }),
    }));
  });

  test('sends payment failure notice keyed on payment intent + attempt', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: payment() })],
      ...lifecycleQueues(),
      notification_prefs: [
        chain({ first: { email_enabled: true } }),
        chain({ first: { email_enabled: true } }),
      ],
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

  test('keeps an explicit Email-only payment failure on the branded email sidecar', async () => {
    const explicitPrefs = { email_enabled: true, payment_issue_channels: ['email'] };
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: payment() })],
      customers: [chain({ first: customer() })],
      notification_prefs: [chain({ first: explicitPrefs }), chain({ first: explicitPrefs })],
      customer_interactions: [chain()],
    });

    const result = await PaymentLifecycleEmail.sendPaymentFailed({
      customerId: 'cust-1',
      paymentIntentId: 'pi_test',
      attemptId: 'ch_attempt1',
      invoiceId: 'inv-1',
      customerInitiated: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.failed',
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('queues an explicit Text payment failure without duplicating the email sidecar', async () => {
    const explicitPrefs = { email_enabled: true, payment_issue_channels: ['sms'] };
    const queueLookup = chain({ first: null });
    const queueInsert = chain({ returning: [{ id: 'sms-1' }] });
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: payment() })],
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      notification_prefs: [chain({ first: explicitPrefs }), chain({ first: explicitPrefs })],
      sms_log: [queueLookup, queueInsert],
    });

    const result = await PaymentLifecycleEmail.sendPaymentFailed({
      customerId: 'cust-1',
      paymentIntentId: 'pi_test',
      attemptId: 'ch_attempt1',
      invoiceId: 'inv-1',
      customerInitiated: true,
    });

    expect(result).toMatchObject({ ok: true, queueId: 'sms-1', channels: { scheduled: true } });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(queueInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'scheduled',
      message_type: 'payment_failed',
      scheduled_for: expect.any(Date),
      metadata: expect.stringContaining('"hasEmailLeg":true'),
    }));
    expect(JSON.parse(queueInsert.insert.mock.calls[0][0].metadata)).toMatchObject({
        original_message_type: 'payment_failed',
        billingDeliveryCategory: 'payment_issue',
        notificationEventKey: 'payment-failed:pi_test:ch_attempt1',
        customer_initiated: true,
    });
  });

  test('queues an App-only payment failure for a customer without a phone', async () => {
    const explicitPrefs = { email_enabled: true, payment_issue_channels: ['push'] };
    const queueLookup = chain({ first: null });
    const queueInsert = chain({ returning: [{ id: 'app-1' }] });
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: payment() })],
      customers: [chain({ first: customer({ phone: null }) }), chain({ first: customer({ phone: null }) })],
      notification_prefs: [chain({ first: explicitPrefs }), chain({ first: explicitPrefs })],
      sms_log: [queueLookup, queueInsert],
    });

    const result = await PaymentLifecycleEmail.sendPaymentFailed({
      customerId: 'cust-1', paymentIntentId: 'pi_app', attemptId: 'ch_app', invoiceId: 'inv-1',
    });

    expect(result).toMatchObject({ ok: true, queueId: 'app-1', channels: { scheduled: true } });
    expect(queueInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      to_phone: '',
      metadata: expect.stringContaining('"billingDeliveryCategory":"payment_issue"'),
    }));
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('does not queue an App payment failure after the customer is removed', async () => {
    const explicitPrefs = { email_enabled: true, payment_issue_channels: ['push'] };
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: payment() })],
      customers: [chain({ first: customer() }), chain({ first: null })],
      notification_prefs: [chain({ first: explicitPrefs }), chain({ first: explicitPrefs })],
    });

    await expect(PaymentLifecycleEmail.sendPaymentFailed({
      customerId: 'cust-1', paymentIntentId: 'pi_removed', attemptId: 'ch_removed', invoiceId: 'inv-1',
    })).resolves.toMatchObject({ skipped: true });
    expect(db).not.toHaveBeenCalledWith('sms_log');
    expect(require('../services/sms-template-renderer').renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([
    ['off-session', false],
    ['verified customer-initiated', true],
  ])('persists %s provenance on queued Text/App payment failure work', async (_label, customerInitiated) => {
    const explicitPrefs = { email_enabled: true, payment_issue_channels: ['sms'] };
    const queueLookup = chain({ first: null });
    const queueInsert = chain({ returning: [{ id: 'sms-provenance' }] });
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: payment() })],
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      notification_prefs: [chain({ first: explicitPrefs }), chain({ first: explicitPrefs })],
      sms_log: [queueLookup, queueInsert],
    });

    const result = await PaymentLifecycleEmail.sendPaymentFailed({
      customerId: 'cust-1',
      paymentIntentId: 'pi_off_session',
      attemptId: 'ch_machine',
      invoiceId: 'inv-1',
      customerInitiated,
    });

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(queueInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'scheduled',
      message_type: 'payment_failed',
      scheduled_for: expect.any(Date),
      metadata: expect.stringContaining('"hasEmailLeg":true'),
    }));
    expect(JSON.parse(queueInsert.insert.mock.calls[0][0].metadata)).toMatchObject({
      customer_initiated: customerInitiated,
      billingDeliveryCategory: 'payment_issue',
    });
    expect(result).toMatchObject({ channels: { scheduled: true } });
  });

  test('dedupes a repeated payment-failure event against any existing queue status', async () => {
    const explicitPrefs = { email_enabled: true, payment_issue_channels: ['sms'] };
    const firstLookup = chain({ first: null });
    const firstInsert = chain({ returning: [{ id: 'sms-first' }] });
    const repeatedLookup = chain({ first: { id: 'sms-first', status: 'sent' } });
    setDbQueues({
      invoices: [chain({ first: invoice() }), chain({ first: invoice() })],
      payments: [chain({ first: payment() }), chain({ first: payment() })],
      customers: [
        chain({ first: customer() }), chain({ first: customer() }),
        chain({ first: customer() }), chain({ first: customer() }),
      ],
      notification_prefs: [
        chain({ first: explicitPrefs }), chain({ first: explicitPrefs }),
        chain({ first: explicitPrefs }), chain({ first: explicitPrefs }),
      ],
      sms_log: [firstLookup, firstInsert, repeatedLookup],
    });
    const args = {
      customerId: 'cust-1', paymentIntentId: 'pi_same', attemptId: 'ch_same',
      invoiceId: 'inv-1', customerInitiated: true,
    };

    const first = await PaymentLifecycleEmail.sendPaymentFailed(args);
    const repeated = await PaymentLifecycleEmail.sendPaymentFailed(args);

    expect(first).toMatchObject({ channels: { scheduled: true, queueId: 'sms-first' } });
    expect(repeated).toMatchObject({ channels: { scheduled: true, deduped: true, queueId: 'sms-first' } });
    expect(firstInsert.insert).toHaveBeenCalledTimes(1);
  });

  test('propagates a payment-failure enqueue error to the webhook retry owner', async () => {
    const explicitPrefs = { email_enabled: true, payment_issue_channels: ['sms'] };
    const queueLookup = chain({ first: null });
    const queueInsert = chain();
    queueInsert.returning.mockRejectedValueOnce(new Error('database unavailable'));
    setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: payment() })],
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      notification_prefs: [chain({ first: explicitPrefs }), chain({ first: explicitPrefs })],
      sms_log: [queueLookup, queueInsert],
    });

    await expect(PaymentLifecycleEmail.sendPaymentFailed({
      customerId: 'cust-1',
      paymentIntentId: 'pi_off_session',
      attemptId: 'ch_machine',
      invoiceId: 'inv-1',
      customerInitiated: false,
    })).rejects.toMatchObject({ code: 'BILLING_NOTICE_ENQUEUE_FAILED' });
  });

  test('propagates an unavailable preference read instead of acknowledging it as legacy', async () => {
    const firstPrefs = chain();
    const routingPrefs = chain({ first: { email_enabled: true, payment_issue_channels: ['email'] } });
    firstPrefs.first.mockRejectedValueOnce(new Error('database unavailable'));
    const queues = setDbQueues({
      invoices: [chain({ first: invoice() })],
      payments: [chain({ first: payment() })],
      customers: [chain({ first: customer() })],
      notification_prefs: [firstPrefs, routingPrefs],
    });

    await expect(PaymentLifecycleEmail.sendPaymentFailed({
      customerId: 'cust-1',
      paymentIntentId: 'pi_retry_prefs',
      attemptId: 'ch_retry_prefs',
      invoiceId: 'inv-1',
      customerInitiated: true,
    })).rejects.toMatchObject({ code: 'BILLING_PREFS_UNAVAILABLE', retryable: true });
    expect(queues.get('notification_prefs')).toEqual([routingPrefs]);
    expect(db.mock.calls.some(([table]) => table === 'sms_log')).toBe(false);
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

  test('skips refund notice for a payer-billed invoice payment (homeowner must not be emailed)', async () => {
    setDbQueues({
      payments: [chain({ first: payment({ invoice_id: 'inv-1' }) })],
      invoices: [chain({ first: invoice({ payer_id: 7 }) })],
    });

    const result = await PaymentLifecycleEmail.sendRefundIssued({
      customerId: 'cust-1',
      paymentId: 'pay-1',
      refundId: 're_x',
      refundAmount: '10.00',
    });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'payer_billed' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('skips payment plan confirmation for a payer-billed invoice', async () => {
    setDbQueues({
      invoices: [chain({ first: invoice({ payer_id: 7 }) })],
    });

    const result = await PaymentLifecycleEmail.sendPaymentPlanConfirmed({
      customerId: 'cust-1',
      paymentPlanId: 'plan-1',
      plan: { invoice_id: 'inv-1', total_balance: '390.00' },
    });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'payer_billed' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
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

  test('sends the combined cancellation + deposit-refund notice without needing a payments row', async () => {
    setDbQueues(lifecycleQueues());

    await PaymentLifecycleEmail.sendCancellationRefundIssued({
      customerId: 'cust-1',
      refundAmount: 49,
      refundDate: '2026-07-15',
      planLabel: 'WaveGuard Bronze',
      idempotencyKey: 'account.cancellation_refund:cust-1:dep-1',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'account.cancellation_refund',
      idempotencyKey: 'account.cancellation_refund:cust-1:dep-1',
      payload: expect.objectContaining({
        refund_amount: '$49.00',
        plan_label: 'WaveGuard Bronze',
      }),
    }));
    expect(db).not.toHaveBeenCalledWith('payments');
  });

  test('cancellation notice refuses a zero refund amount', async () => {
    const result = await PaymentLifecycleEmail.sendCancellationRefundIssued({
      customerId: 'cust-1',
      refundAmount: 0,
    });
    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'no_refund_amount' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });
});
