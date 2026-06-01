jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'invoice follow-up sms'),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/inv123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, providerMessageId: 'sms-1' })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-1', sent_at: '2026-05-26T14:00:00.000Z' },
  })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'billing@example.com', name: 'Taylor' }]),
}));

const db = require('../models/db');
const smsTemplates = require('../routes/admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplates = require('../services/email-template-library');
const InvoiceFollowUps = require('../services/invoice-followups');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'join',
    'where',
    'whereIn',
    'whereNotIn',
    'whereNull',
    'whereNotNull',
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

function followupRow(overrides = {}) {
  return {
    id: 'seq-1',
    invoice_id: 'inv-1',
    customer_id: 'cust-1',
    step_index: 0,
    touches_sent: 0,
    token: 'token-1',
    title: 'Quarterly Pest Control',
    total: '129.00',
    status: 'active',
    service_date: '2026-05-12',
    due_date: '2026-05-19',
    invoice_number: 'WPC-2026-1042',
    invoice_created_at: '2026-05-20T12:00:00.000Z',
    ...overrides,
  };
}

function customer(overrides = {}) {
  return {
    id: 'cust-1',
    first_name: 'Taylor',
    last_name: 'Morgan',
    email: 'taylor@example.com',
    phone: '+19415550101',
    ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    customer_id: 'cust-1',
    invoice_number: 'WPC-2026-1042',
    status: 'sent',
    title: 'Quarterly Pest Control',
    total: '129.00',
    due_date: '2026-05-19',
    service_date: '2026-05-12',
    ...overrides,
  };
}

describe('invoice follow-up email sidecar', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('sends the 3-day email sidecar with the invoice follow-up SMS', async () => {
    const emailInteraction = chain();
    const finalInteraction = chain();
    const sequenceUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: customer() })],
      invoices: [chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [emailInteraction, finalInteraction],
      invoice_followup_sequences: [sequenceUpdate],
    });

    await InvoiceFollowUps.runPending();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_3_day',
      to: 'billing@example.com',
      idempotencyKey: 'invoice_followup_email:inv-1:d3_friendly',
      suppressionGroupKey: 'transactional_required',
      payload: expect.objectContaining({
        first_name: 'Taylor',
        invoice_title: 'Quarterly Pest Control',
        invoice_number: 'WPC-2026-1042',
        amount_due: '$129.00',
        pay_url: 'https://portal.wavespestcontrol.com/l/inv123',
      }),
    }));
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith('invoice_followup_3day', expect.objectContaining({
      first_name: 'Taylor',
      pay_url: 'https://portal.wavespestcontrol.com/l/inv123',
    }), expect.objectContaining({
      workflow: 'invoice_followup',
      entity_id: 'inv-1',
    }));
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      body: 'invoice follow-up sms',
      entryPoint: 'invoice_followup_sequence',
      metadata: { original_message_type: 'invoice_followup' },
    }));
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      step_index: 1,
      status: 'active',
    }));
    expect(finalInteraction.insert).toHaveBeenCalledWith(expect.objectContaining({
      interaction_type: 'sms_outbound',
      metadata: expect.stringContaining('"email_sent":true'),
    }));
  });

  test('advances the sequence when email sends but the customer has no phone', async () => {
    const emailInteraction = chain();
    const finalInteraction = chain();
    const sequenceUpdate = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: customer({ phone: null }) })],
      invoices: [chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [emailInteraction, finalInteraction],
      invoice_followup_sequences: [sequenceUpdate],
    });

    await InvoiceFollowUps.runPending();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.followup_3_day',
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      step_index: 1,
      status: 'active',
    }));
  });
});
