/**
 * AUDIT REPRO r1-timezone-2 — invoice follow-up touches misstate the service
 * date by one day when the invoices.service_date DATE column arrives as a
 * UTC-midnight instant (pg default DATE parser in a TZ=UTC container, or the
 * 'YYYY-MM-DD' string the existing suite's fixture uses).
 *
 * Asserts the CORRECT behaviour (clause names the stored calendar day), so it
 * FAILS on current code if fireTouch's ET-instant formatting is the bug.
 * Mocking pattern copied from server/tests/invoice-followups-email.test.js.
 * Run: cd server && TZ=UTC npx jest --runInBand tests/audit-repro/r1-timezone-2.test.js
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'invoice follow-up sms'),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/inv123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'sms-1' })),
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
const EmailTemplates = require('../services/email-template-library');
const InvoiceFollowUps = require('../services/invoice-followups');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['join', 'where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereNotExists', 'select', 'orderBy', 'forUpdate']
    .forEach((m) => { q[m] = jest.fn(() => q); });
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
}

// What node-postgres hands back for a DATE '2026-05-12' column in a TZ=UTC
// container (default parser: new Date(2026, 4, 12) local == UTC midnight).
const SERVICE_DATE_FROM_PG = new Date(Date.UTC(2026, 4, 12));

function followupRow(overrides = {}) {
  return {
    id: 'seq-1', invoice_id: 'inv-1', customer_id: 'cust-1', step_index: 0,
    next_touch_at: '2026-05-26T13:00:00.000Z', touches_sent: 0, token: 'token-1',
    title: 'Quarterly Pest Control', total: '129.00', status: 'active',
    service_date: SERVICE_DATE_FROM_PG, due_date: '2026-05-19',
    invoice_number: 'WPC-2026-1042', invoice_created_at: '2026-05-20T12:00:00.000Z',
    invoice_payer_id: null, invoice_send_error: null,
    ...overrides,
  };
}
const customer = () => ({ id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', email: 'taylor@example.com', phone: '+19415550101' });
const invoice = () => ({
  id: 'inv-1', customer_id: 'cust-1', invoice_number: 'WPC-2026-1042', status: 'sent',
  title: 'Quarterly Pest Control', total: '129.00', due_date: '2026-05-19',
  service_date: SERVICE_DATE_FROM_PG, token: 'token-1',
});

describe('audit r1-timezone-2: follow-up service date is the stored calendar day', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
    jest.clearAllMocks();
    db.transaction = jest.fn(async (fn) => fn(db));
    db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  });
  afterEach(() => jest.useRealTimers());

  test('SMS + email service_date_clause say "May 12, 2026", not May 11', async () => {
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: customer() })],
      invoices: [chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: true } }), chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
        chain({ result: 1 }),
        chain(),
        chain({ result: 1 }),
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(smsTemplates.getTemplate).toHaveBeenCalled();
    const smsVars = smsTemplates.getTemplate.mock.calls[0][1];
    expect(EmailTemplates.sendTemplate).toHaveBeenCalled();
    const emailPayload = EmailTemplates.sendTemplate.mock.calls[0][0].payload;

    // Decisive assertions (expected behaviour):
    console.log("VALUES", JSON.stringify({ sms_service_date: smsVars.service_date, sms_clause: smsVars.service_date_clause, email_clause: emailPayload.service_date_clause, email_service_date_control: emailPayload.service_date }));
    expect(smsVars.service_date).toBe('May 12, 2026');
    expect(smsVars.service_date_clause).toBe(' completed on May 12, 2026');
    expect(emailPayload.service_date_clause).toBe(' completed on May 12, 2026');
    // Control: the email leg's own service_date field goes through formatDateOnly and is right.
    expect(emailPayload.service_date).toBe('May 12, 2026');
  });
});
