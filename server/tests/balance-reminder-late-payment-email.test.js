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
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'sms-1' })),
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
// The always-on contact ledger records-then-sends; the bare db mock here
// can't serve its insert, and an unavailable ledger correctly SKIPS the
// send — so the ledger is mocked healthy for these delivery-path tests.
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
}));
// Consulted by the real rail-guard only when GATE_COLLECTIONS_POLICY==='true'.
jest.mock('../services/collections/contact-policy', () => ({
  evaluate: jest.fn(async () => ({ allowed: true, eligibleInvoiceIds: ['inv-1'], denialReasons: [] })),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const EmailTemplates = require('../services/email-template-library');
const BalanceReminder = require('../services/workflows/balance-reminder');
const ContactLedger = require('../services/collections/contact-ledger');
const ContactPolicy = require('../services/collections/contact-policy');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'where',
    'whereIn',
    'whereNotNull',
    'whereNotIn',
    'whereNull',
    'leftJoin',
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
      metadata: expect.objectContaining({ original_message_type: 'late_payment' }),
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

  test('renders a real date when service_date is a Date object (pg date column), never "Invalid Date"', async () => {
    // Regression: pg returns `date` columns as JS Date objects; the old
    // string-concat render produced "Invalid Date" and the SMS guard
    // blocked the send (prod incident 2026-07-10).
    const activeCustomer = customer();
    const openInvoice = invoice({ service_date: new Date('2026-05-12T00:00:00Z') });

    setDbQueues({
      customers: [chain({ result: [activeCustomer] })],
      payments: [chain({ result: [overduePayment(8)] })],
      invoices: [
        chain({ result: [] }),
        chain({ first: { id: openInvoice.id, token: openInvoice.token } }),
        chain({ first: openInvoice }),
        chain({ first: openInvoice }),
      ],
      sms_log: [
        chain({ first: { count: '0' } }),
        chain({ first: null }),
      ],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
    });

    await BalanceReminder.latePaymentCheck();

    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'late_payment_7d',
      expect.objectContaining({
        service_date_clause: ' completed on May 12, 2026',
      }),
      expect.anything(),
    );
    const vars = renderSmsTemplate.mock.calls[0][1];
    expect(JSON.stringify(vars)).not.toContain('Invalid Date');
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

  test.each(['EMAIL_TEMPLATE_DISABLED', 'EMAIL_TEMPLATE_UNAVAILABLE'])(
    'reports %s as a definite template refusal', async (code) => {
      EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('template unavailable'), { code }));
      setDbQueues({
        invoices: [chain({ first: invoice() })],
        notification_prefs: [chain({ first: { email_enabled: true } })],
        customer_interactions: [chain()],
      });
      const result = await BalanceReminder.sendLatePaymentEmail({
        customer: customer(), invoice: invoice(),
        balance: { totalBalance: 129, oldestDueDate: '2026-05-19' },
        smsTemplateKey: 'late_payment_14d',
        invoiceTitle: 'Quarterly Pest Control',
        serviceDateClause: '',
        payUrl: 'https://portal.wavespestcontrol.com/pay/token-1',
      });
      expect(result).toEqual({ ok: false, skipped: true, reason: 'template_unavailable' });
    },
  );

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

// Collections policy on the workflow's own late-payment legs (rail-guard is
// REAL here; the mocked contact-policy stands in for the verdict). Gate-off
// byte-identical behavior is what every test above runs under — these pin
// the gate-ON consult, the per-channel independence of the email sidecar,
// and the record-then-send ledger discipline.
describe('collections policy + ledger on latePaymentCheck', () => {
  function armHappyPath(prefs = { email_enabled: true }, customerOverrides = {}) {
    const interactions = [chain(), chain(), chain()];
    setDbQueues({
      customers: [chain({ result: [customer(customerOverrides)] })],
      payments: [chain({ result: [overduePayment(8)] })],
      invoices: [
        chain({ result: [] }),
        chain({ first: { id: 'inv-1', token: 'token-1' } }),
        chain({ first: invoice() }),
        chain({ first: invoice() }),
      ],
      // The explicit branch reads the legacy seven-day cooldown once; the
      // legacy branch reads its 90-day count and the same cooldown.
      sms_log: Array.isArray(prefs.billing_channels)
        ? [chain({ first: null })]
        : [chain({ first: { count: '0' } }), chain({ first: null })],
      notification_prefs: [chain({ first: prefs })],
      collections_contact_ledger: [chain({ result: [] }), chain({ result: [] })],
      customer_interactions: [...interactions],
    });
    return { interactions };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async () => ({ allowed: true, eligibleInvoiceIds: ['inv-1'], denialReasons: [] }));
  });
  afterEach(() => {
    delete process.env.GATE_COLLECTIONS_POLICY;
  });

  test('a policy-denied SMS channel skips the customer entirely — no SMS, no email sidecar, no ledger row', async () => {
    armHappyPath();
    ContactPolicy.evaluate.mockImplementation(async (customerId, { channel }) => ({
      allowed: channel !== 'sms', eligibleInvoiceIds: ['inv-1'], denialReasons: channel === 'sms' ? ['contact_within_24h'] : [],
    }));
    await BalanceReminder.latePaymentCheck();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  });

  test('the email sidecar gets its OWN consult — email denied still sends the SMS, never the email', async () => {
    armHappyPath();
    ContactPolicy.evaluate.mockImplementation(async (customerId, { channel }) => ({
      allowed: channel !== 'email', eligibleInvoiceIds: ['inv-1'], denialReasons: channel === 'email' ? ['flag_do_not_email'] : [],
    }));
    await BalanceReminder.latePaymentCheck();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    // The SMS leg still recorded before sending; no email row was minted.
    const channels = ContactLedger.recordContact.mock.calls.map(([args]) => args.channel);
    expect(channels).toEqual(['sms']);
  });

  test('selected Email and Text share a reminder without the first delivery blocking its sibling', async () => {
    const { interactions } = armHappyPath({ email_enabled: true, billing_channels: ['email', 'sms'] });
    ContactPolicy.evaluate.mockImplementation(async () => ({
      allowed: ContactLedger.recordContact.mock.calls.length === 0,
      eligibleInvoiceIds: ['inv-1'],
      denialReasons: ['contact_within_24h'],
    }));
    await BalanceReminder.latePaymentCheck();
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(ContactLedger.recordContact.mock.calls.map(([args]) => args.channel)).toEqual(['email', 'sms']);
    expect(ContactLedger.recordContact.mock.calls.map(([args]) => args.metadata.notificationEventKey))
      .toEqual(['balance-late-payment:inv-1:late_payment_7d', 'balance-late-payment:inv-1:late_payment_7d']);
    expect(ContactLedger.recordContact.mock.calls.map(([args]) => args.metadata.template_key))
      .toEqual(['late_payment_7d', 'late_payment_7d']);
    expect(interactions.flatMap((query) => query.insert.mock.calls.map(([row]) => row.interaction_type)))
      .toEqual(['email_outbound', 'sms_outbound']);
  });

  test('a selected App reaches the canonical sender even without a phone', async () => {
    armHappyPath({ billing_channels: ['push'] }, { phone: null });
    await BalanceReminder.latePaymentCheck();
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', to: null, channel: 'push', metadata: expect.objectContaining({
        billingDeliveryCategory: 'billing', billingDeliveryLeg: 'push', appOnly: true,
      }),
    }));
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('a selected App previsit reminder reaches the canonical sender as push without a phone', async () => {
    const service = customer({ cust_id: 'cust-1', phone: null, scheduled_date: '2026-05-25', service_type: 'Pest Control' });
    const balance = { oldestInvoiceId: 'inv-1', oldestInvoiceUrl: 'https://portal/pay/token-1', totalBalance: 129, daysOverdue: 8 };
    setDbQueues({
      notification_prefs: [chain({ first: { billing_channels: ['push'] } })],
      collections_contact_ledger: [chain({ result: [] })],
      customer_interactions: [chain()],
    });

    await expect(BalanceReminder.sendReminder(service, balance, 'gentle', 5)).resolves.toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: null, channel: 'push', metadata: expect.objectContaining({ billingDeliveryLeg: 'push', appOnly: true }),
    }));
  });

  test.each(['direct', 'daily', 'late payment'])('%s reminder holds when channel preferences cannot be read', async (entry) => {
    const failedPrefs = chain();
    failedPrefs.first.mockRejectedValue(new Error('preferences temporarily unavailable'));
    const service = customer({ cust_id: 'cust-1', scheduled_date: new Date(Date.now() + 5 * 86400000) });
    const balance = { oldestInvoiceId: 'inv-1', totalBalance: 129, daysOverdue: 8 };
    const balanceRead = jest.spyOn(BalanceReminder, 'getCustomerBalance').mockResolvedValue(balance);
    try {
      setDbQueues({
        notification_prefs: [failedPrefs],
        scheduled_services: [chain({ result: [service] })],
        customers: [chain({ result: [customer()] })],
      });
      if (entry === 'direct') await expect(BalanceReminder.sendReminder(service, balance, 'gentle', 5)).resolves.toBe(false);
      else if (entry === 'daily') await BalanceReminder.dailyCheck();
      else await BalanceReminder.latePaymentCheck();
      expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
      expect(ContactLedger.recordContact).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    } finally { balanceRead.mockRestore(); }
  });

  test('completed reminders from the prior visit cycle do not consume the current 14-day allowance', async () => {
    const service = customer({ cust_id: 'cust-1', scheduled_date: new Date(Date.now() + 6 * 86400000) });
    const balance = { oldestInvoiceId: 'inv-1', totalBalance: 129, daysOverdue: 8 };
    const oldProgress = [1, 2, 3].map((tier) => ({
      id: `old-${tier}`, channel: 'email', occurred_at: new Date(Date.now() - 20 * 86400000),
      metadata: { delivered: true, notificationEventKey: `prior-cycle:${tier}` },
    }));
    const balanceRead = jest.spyOn(BalanceReminder, 'getCustomerBalance').mockResolvedValue(balance);
    const send = jest.spyOn(BalanceReminder, 'sendReminder').mockResolvedValue(true);
    try {
      setDbQueues({
        scheduled_services: [chain({ result: [service] })],
        notification_prefs: [chain({ first: { billing_channels: ['email'] } })],
        collections_contact_ledger: [chain({ result: oldProgress })],
        sms_log: [chain({ result: [] })],
      });
      await BalanceReminder.dailyCheck();
      expect(send).toHaveBeenCalledWith(service, balance, 'gentle', expect.any(Number));
    } finally { balanceRead.mockRestore(); send.mockRestore(); }
  });

  test('legacy reminders texted before the first explicit channel save still consume the 14-day allowance', async () => {
    const service = customer({ cust_id: 'cust-1', scheduled_date: new Date(Date.now() + 6 * 86400000) });
    const balance = { oldestInvoiceId: 'inv-1', totalBalance: 129, daysOverdue: 8 };
    const dayAgo = (days) => new Date(Date.now() - days * 86400000);
    // One keyed episode (already counted through its ledger event) plus two
    // legacy rows with no event key: three reminders in the window.
    const keyed = { id: 'led-1', channel: 'sms', occurred_at: dayAgo(2),
      metadata: { delivered: true, notificationEventKey: 'balance-reminder:inv-1:gentle:May 25, 2026' } };
    const smsHistory = [
      { id: 'sms-keyed', created_at: dayAgo(2), metadata: { notificationEventKey: 'balance-reminder:inv-1:gentle:May 25, 2026' } },
      { id: 'sms-legacy-1', created_at: dayAgo(5), metadata: null },
      { id: 'sms-legacy-2', created_at: dayAgo(9), metadata: '{}' },
    ];
    const balanceRead = jest.spyOn(BalanceReminder, 'getCustomerBalance').mockResolvedValue(balance);
    const send = jest.spyOn(BalanceReminder, 'sendReminder').mockResolvedValue(true);
    try {
      setDbQueues({
        scheduled_services: [chain({ result: [service] })],
        notification_prefs: [chain({ first: { billing_channels: ['sms'] } })],
        collections_contact_ledger: [chain({ result: [keyed] })],
        sms_log: [chain({ result: smsHistory })],
      });
      await BalanceReminder.dailyCheck();
      expect(send).not.toHaveBeenCalled();
    } finally { balanceRead.mockRestore(); send.mockRestore(); }
  });

  test('an App reminder is counted once: its push proof row carries the episode key and is not legacy history', async () => {
    const service = customer({ cust_id: 'cust-1', phone: null, scheduled_date: new Date(Date.now() + 3.5 * 86400000) });
    const balance = { oldestInvoiceId: 'inv-1', totalBalance: 129, daysOverdue: 8 };
    const dayAgo = (days) => new Date(Date.now() - days * 86400000);
    const key = 'balance-reminder:inv-1:gentle:May 25, 2026';
    const delivered = { id: 'led-push', channel: 'push', occurred_at: dayAgo(4),
      metadata: { delivered: true, notificationEventKey: key, invoiceId: 'inv-1', scheduledDate: 'May 25, 2026' } };
    // The proof row push-channel-routing writes for an accepted push.
    const proof = { id: 'sms-proof', from_phone: 'push', created_at: dayAgo(4),
      metadata: JSON.stringify({ channel: 'push', providerAccepted: true, notificationEventKey: key }) };
    const balanceRead = jest.spyOn(BalanceReminder, 'getCustomerBalance').mockResolvedValue(balance);
    const send = jest.spyOn(BalanceReminder, 'sendReminder').mockResolvedValue(true);
    try {
      setDbQueues({
        scheduled_services: [chain({ result: [service] })],
        notification_prefs: [chain({ first: { billing_channels: ['push'] } })],
        collections_contact_ledger: [chain({ result: [delivered] })],
        sms_log: [chain({ result: [proof] })],
      });
      await BalanceReminder.dailyCheck();
      // Exactly one prior reminder → the firm tier is still allowed.
      expect(send).toHaveBeenCalledWith(service, balance, 'firm', expect.any(Number));
    } finally { balanceRead.mockRestore(); send.mockRestore(); }
  });

  test('a partially delivered episode for a superseded invoice or date still counts toward the allowance', async () => {
    // Text accepted, Email still pending, then the visit was rescheduled:
    // the episode is incomplete and no longer `pending` for this date, but
    // the customer was reached and must not get another gentle reminder.
    const service = customer({ cust_id: 'cust-1', scheduled_date: new Date(Date.now() + 6 * 86400000) });
    const balance = { oldestInvoiceId: 'inv-1', totalBalance: 129, daysOverdue: 8 };
    const dayAgo = (days) => new Date(Date.now() - days * 86400000);
    const key = 'balance-reminder:inv-1:gentle:May 20, 2026';
    const partial = [
      { id: 'led-sms', channel: 'sms', occurred_at: dayAgo(3),
        metadata: { delivered: true, notificationEventKey: key, invoiceId: 'inv-1', scheduledDate: 'May 20, 2026' } },
      { id: 'led-email', channel: 'email', occurred_at: dayAgo(3),
        metadata: { notificationEventKey: key, invoiceId: 'inv-1', scheduledDate: 'May 20, 2026' } },
    ];
    const balanceRead = jest.spyOn(BalanceReminder, 'getCustomerBalance').mockResolvedValue(balance);
    const send = jest.spyOn(BalanceReminder, 'sendReminder').mockResolvedValue(true);
    try {
      setDbQueues({
        scheduled_services: [chain({ result: [service] })],
        notification_prefs: [chain({ first: { billing_channels: ['sms', 'email'] } })],
        collections_contact_ledger: [chain({ result: partial })],
        sms_log: [chain({ result: [{ id: 'sms-keyed', created_at: dayAgo(3), metadata: { notificationEventKey: key } }] })],
      });
      await BalanceReminder.dailyCheck();
      expect(send).not.toHaveBeenCalled();
    } finally { balanceRead.mockRestore(); send.mockRestore(); }
  });

  test.each([
    ['an unknown failure after the provider handoff', {}, 'uncertain'],
    ['a definite provider refusal after the handoff', { status: 429 }, 'not_sent'],
  ])('the late-payment email reports %s so only a definite refusal reopens its reservation', async (_label, errProps, expected) => {
    setDbQueues({
      invoices: [chain({ first: invoice() }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      notification_prefs: [chain({ first: { billing_channels: ['email'] } })],
      customers: [chain({ first: customer() })],
      customer_interactions: [chain()],
    });
    EmailTemplates.sendTemplate.mockImplementationOnce(async (input) => {
      await input.withProviderHandoff(async () => { throw Object.assign(new Error('SendGrid failed'), errProps); });
    });
    const result = await BalanceReminder.sendLatePaymentEmail({
      customer: customer(), invoice: invoice(), balance: { totalBalance: 129, daysOverdue: 8 },
      smsTemplateKey: 'late_payment_7d', invoiceTitle: 'Quarterly Pest Control', serviceDateClause: '',
      payUrl: 'https://portal/pay/token-1', initialPrefs: { billing_channels: ['email'] },
    });
    expect(result).toMatchObject({ ok: false, deliveryOutcome: expected });
  });

  test('a keyed Text is counted once, through its ledger episode, never again through its sms_log row', async () => {
    const service = customer({ cust_id: 'cust-1', scheduled_date: new Date(Date.now() + 3.5 * 86400000) });
    const balance = { oldestInvoiceId: 'inv-1', totalBalance: 129, daysOverdue: 8 };
    const dayAgo = (days) => new Date(Date.now() - days * 86400000);
    const keyed = { id: 'led-1', channel: 'sms', occurred_at: dayAgo(4),
      metadata: { delivered: true, notificationEventKey: 'balance-reminder:inv-1:gentle:May 25, 2026' } };
    const balanceRead = jest.spyOn(BalanceReminder, 'getCustomerBalance').mockResolvedValue(balance);
    const send = jest.spyOn(BalanceReminder, 'sendReminder').mockResolvedValue(true);
    try {
      setDbQueues({
        scheduled_services: [chain({ result: [service] })],
        notification_prefs: [chain({ first: { billing_channels: ['sms'] } })],
        collections_contact_ledger: [chain({ result: [keyed] })],
        sms_log: [chain({ result: [{ id: 'sms-keyed', created_at: dayAgo(4),
          metadata: { notificationEventKey: 'balance-reminder:inv-1:gentle:May 25, 2026' } }] })],
      });
      await BalanceReminder.dailyCheck();
      // One prior reminder → the firm tier is still allowed (<= 1).
      expect(send).toHaveBeenCalledWith(service, balance, 'firm', expect.any(Number));
    } finally { balanceRead.mockRestore(); send.mockRestore(); }
  });

  test('an explicit late-payment reminder respects the legacy seven-day sms_log cooldown', async () => {
    // The explicit branch's single cooldown read returns a legacy row.
    const queues = setDbQueues({
      customers: [chain({ result: [customer()] })],
      payments: [chain({ result: [overduePayment(8)] })],
      invoices: [chain({ result: [] }), chain({ first: { id: 'inv-1', token: 'token-1' } }), chain({ first: invoice() })],
      notification_prefs: [chain({ first: { billing_channels: ['sms'] } })],
      collections_contact_ledger: [chain({ result: [] })],
      sms_log: [chain({ first: { id: 'sms-legacy', created_at: new Date(Date.now() - 3 * 86400000) } })],
    });
    await BalanceReminder.latePaymentCheck();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(queues.get('sms_log')).toHaveLength(0);
  });

  test('a no-phone Email delivery is durable progress and the next run emits no duplicate audit or ledger row', async () => {
    const delivered = {
      id: 'led-email', customer_id: 'cust-1', channel: 'email', source: 'balance_reminder_workflow',
      occurred_at: new Date(), metadata: {
        delivered: true, notificationEventKey: 'balance-reminder:inv-1:gentle:May 25, 2026',
        selectedChannels: ['email'],
      },
    };
    const interaction = chain();
    setDbQueues({
      notification_prefs: [
        chain({ first: { billing_channels: ['email'] } }),
        chain({ first: { billing_channels: ['email'] } }),
      ],
      collections_contact_ledger: [chain({ result: [] }), chain({ result: [delivered] })],
      customer_interactions: [interaction],
    });
    const service = customer({ cust_id: 'cust-1', phone: null, scheduled_date: '2026-05-25', service_type: 'Pest Control' });
    const balance = { oldestInvoiceId: 'inv-1', oldestInvoiceUrl: 'https://portal/pay/token-1', totalBalance: 129, daysOverdue: 8 };

    await expect(BalanceReminder.sendReminder(service, balance, 'gentle', 5)).resolves.toBe(true);
    await expect(BalanceReminder.sendReminder(service, balance, 'gentle', 5)).resolves.toBe(true);

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email', to: null,
      metadata: expect.objectContaining({
        billingDeliveryLeg: 'email', collections_ledger_id: 'led-1', collections_sibling_ledger_ids: [],
      }),
    }));
    expect(ContactLedger.recordContact).toHaveBeenCalledTimes(1);
    expect(interaction.insert).toHaveBeenCalledTimes(1);
    expect(interaction.insert).toHaveBeenCalledWith(expect.objectContaining({ interaction_type: 'email_outbound' }));
  });

  test('allowed path records BEFORE each send and both channels get their own ledger rows', async () => {
    armHappyPath();
    await BalanceReminder.latePaymentCheck();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const smsRecordAt = ContactLedger.recordContact.mock.invocationCallOrder[0];
    const smsSendAt = sendCustomerMessage.mock.invocationCallOrder[0];
    expect(smsRecordAt).toBeLessThan(smsSendAt);
    const channels = ContactLedger.recordContact.mock.calls.map(([args]) => args.channel);
    expect(channels).toEqual(['sms', 'email']);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
    // gh-r2: both delivered legs get the positive delivered stamp — the
    // dunning-touch floor counts only confirmed deliveries.
    expect(ContactLedger.markDelivered).toHaveBeenCalledTimes(2);
  });

  test('a blocked SMS stamps its ledger row send_failed and skips the email sidecar', async () => {
    armHappyPath();
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'quiet_hours' });
    await BalanceReminder.latePaymentCheck();
    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'led-1' }),
      expect.objectContaining({ code: 'quiet_hours' }),
    );
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('an unavailable ledger SKIPS the send — no unledgered customer contact, ever (gate state irrelevant)', async () => {
    delete process.env.GATE_COLLECTIONS_POLICY;
    armHappyPath();
    ContactLedger.recordContact.mockRejectedValueOnce(new Error('ledger down'));
    await BalanceReminder.latePaymentCheck();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });
});
