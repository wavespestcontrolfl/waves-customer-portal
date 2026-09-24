// Audit repro r1-timezone-2: invoice follow-up sequence touches (fireTouch)
// format the invoices.service_date pg DATE column through an ET instant
// formatter. node-postgres deserializes DATE as local midnight; Railway runs
// TZ=UTC so that is UTC midnight, and America/New_York formatting yields the
// PREVIOUS calendar day. Run: cd server && TZ=UTC NODE_ENV=test npx jest --runInBand tests/audit-repro/r1-timezone-2-invoice-followups-service-date.test.js
if (process.env.TZ !== 'UTC') {
  throw new Error('This repro must run with TZ=UTC (production zone); see header.');
}
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async (key, vars) => `sms ${key}${vars.service_date_clause}`),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/inv123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, providerMessageId: 'sms-1' })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-09-29T14:00:00.000Z' } })),
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

// Exactly what node-postgres returns for DATE '2026-09-22' when process TZ is UTC.
const SERVICE_DATE = new Date(Date.UTC(2026, 8, 22));
const DUE_DATE = new Date(Date.UTC(2026, 8, 29));

function followupRow() {
  return {
    id: 'seq-1', invoice_id: 'inv-1', customer_id: 'cust-1', step_index: 0,
    next_touch_at: '2026-09-29T13:00:00.000Z', touches_sent: 0, token: 'token-1',
    title: 'Quarterly Pest Control', total: '129.00', status: 'active',
    service_date: SERVICE_DATE, due_date: DUE_DATE, invoice_number: 'WPC-2026-1042',
    invoice_created_at: '2026-09-22T18:00:00.000Z', invoice_payer_id: null, invoice_send_error: null,
  };
}
function invoice() {
  return {
    id: 'inv-1', customer_id: 'cust-1', invoice_number: 'WPC-2026-1042', status: 'sent',
    title: 'Quarterly Pest Control', total: '129.00', due_date: DUE_DATE, service_date: SERVICE_DATE, token: 'token-1',
  };
}

describe('audit r1-timezone-2: follow-up touch service date', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-29T14:16:00.000Z')); // Tue 10:16 ET
    jest.clearAllMocks();
    db.transaction = jest.fn(async (fn) => fn(db));
    db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  });
  afterEach(() => jest.useRealTimers());

  test('email + SMS legs carry the stored calendar day (September 22, 2026)', async () => {
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: { id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', email: 'taylor@example.com', phone: '+19415550101' } })],
      invoices: [chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() }), chain({ first: invoice() })],
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: '2026-09-29T13:00:00.000Z', anchor_at: null } }),
        chain({ result: 1 }), chain(), chain({ result: 1 }),
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalled();
    expect(smsTemplates.getTemplate).toHaveBeenCalled();
    const emailPayload = EmailTemplates.sendTemplate.mock.calls[0][0].payload;
    const smsVars = smsTemplates.getTemplate.mock.calls[0][1];
    const smsBody = sendCustomerMessage.mock.calls[0]?.[0]?.body;
     
    console.log('email payload.service_date:', JSON.stringify(emailPayload.service_date),
      '| email payload.service_date_clause:', JSON.stringify(emailPayload.service_date_clause),
      '| sms service_date_clause:', JSON.stringify(smsVars.service_date_clause),
      '| sms body:', JSON.stringify(smsBody));
    expect(emailPayload.service_date).toBe('September 22, 2026'); // formatDateOnly path (line 196) — correct
    expect(smsVars.service_date_clause).toBe(' completed on September 22, 2026');
    expect(emailPayload.service_date_clause).toBe(' completed on September 22, 2026');
  });
});
