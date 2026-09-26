// Audit repro r1-timezone-1: late-payment reminder renders invoices.service_date
// (a pg DATE column, deserialized as LOCAL-midnight Date = UTC midnight under the
// production TZ=UTC) through toLocaleDateString(..., timeZone 'America/New_York'),
// which lands on the PREVIOUS calendar day. Asserts the CORRECT behaviour (literal
// calendar day), so it FAILS on current code if the bug is real.
// Run: cd server && TZ=UTC npx jest --runInBand tests/audit-repro/r1-timezone-1.test.js
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (templateKey, vars) =>
    `Hello ${vars.first_name}! Your invoice for ${vars.invoice_title}${vars.service_date_clause} is 7 days overdue. Please pay here: ${vars.pay_url}`),
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
const LatePaymentChecker = require('../services/late-payment-checker');

function chain({ result = [], first } = {}) {
  const q = {};
  q.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  q.whereIn = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.orderBy = jest.fn(() => q);
  q.whereNot = jest.fn(() => q);
  q.orWhereNot = jest.fn(() => q);
  q.orWhereNull = jest.fn(() => q);
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
    if (!queue || !queue.length) {
      if (table === 'payment_plans') return chain({ first: undefined });
      // No prefs row = legacy NULL arrays (a read failure is a distinct hold).
      if (table === 'notification_prefs') return chain({ first: undefined });
      if (table === 'collections_contact_ledger') return chain({ result: [] });
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

describe('r1-timezone-1: late-payment reminder service date', () => {
  beforeEach(() => {
    // Weekday 10:00 ET cron on 2026-10-01 (14:00Z) — invoice due 2026-09-22 is 9 days overdue → 7d tier.
    jest.useFakeTimers().setSystemTime(new Date('2026-10-01T14:00:00.000Z'));
    jest.clearAllMocks();
  });
  afterEach(() => { jest.useRealTimers(); });

  test('renders the stored service_date (DATE column 2026-09-22) as Sep 22, not the previous ET day', async () => {
    // Exactly what node-postgres returns for a DATE column when the process TZ is UTC
    // (postgres-date: `new Date(year, month, day)` → local midnight → UTC midnight).
    const serviceDate = new Date(Date.UTC(2026, 8, 22));
    expect(serviceDate.toISOString()).toBe('2026-09-22T00:00:00.000Z');
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-2001',
      status: 'sent', title: 'Quarterly Pest Control', total: '129.00',
      due_date: new Date(Date.UTC(2026, 8, 22)),
      service_date: serviceDate,
      created_at: '2026-09-22T15:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };

    setDbQueues({
      invoices: [
        chain({ result: [invoice] }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null }), chain()],
      customers: [chain({ first: customer })],
    });

    const result = await LatePaymentChecker.checkAndNotify();
    expect(result.notified).toBe(1);
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    const [templateKey, vars] = renderSmsTemplate.mock.calls[0];
    expect(templateKey).toBe('late_payment_7d');
    const sentBody = sendCustomerMessage.mock.calls[0][0].body;
     
    console.log('service_date_clause =', JSON.stringify(vars.service_date_clause), '| SMS body =', sentBody);

    // CORRECT behaviour: the literal calendar day of the DATE column.
    expect(vars.service_date_clause).toBe(' completed on Sep 22, 2026');
    expect(sentBody).toContain('completed on Sep 22, 2026');
  });
});
