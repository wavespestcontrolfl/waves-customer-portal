/**
 * NotificationDispatcher — the unimplemented email channel must not report
 * success.
 *
 * The email leg was a stub: it logged "Email would be sent", set sent=true,
 * and sent nothing. Live callers (lawn health report) then stamped their
 * notification_sent flags — email-preferring customers silently got nothing
 * while the record said notified.
 *
 * Contract: channel='email' → sent:false with an explicit
 * results.email='unavailable…'; channel='both' → sent reflects the SMS leg
 * only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const NotificationDispatcher = require('../services/notification-dispatcher');

const CUSTOMER = { id: 'cust-1', phone: '+19415550101', email: 'pat@example.com' };

function firstChain(row) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => row);
  return q;
}

function mockTables({ prefs }) {
  db.mockImplementation((table) => {
    if (table === 'customers') return firstChain(CUSTOMER);
    if (table === 'notification_prefs') return firstChain(prefs);
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

describe('NotificationDispatcher email channel honesty', () => {
  test("channel='email' reports sent:false — nothing was delivered", async () => {
    mockTables({ prefs: { service_complete_channel: 'email' } });

    const result = await NotificationDispatcher.notify('cust-1', 'service_complete', {
      smsMessage: 'sms body',
      emailSubject: 'Subject',
      emailBody: 'Body',
    });

    expect(result.sent).toBe(false);
    expect(result.results.email).toMatch(/unavailable/);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test("channel='both': sent reflects the SMS leg, email still honest", async () => {
    mockTables({ prefs: { service_complete_channel: 'both' } });

    const result = await NotificationDispatcher.notify('cust-1', 'service_complete', {
      smsMessage: 'sms body',
      emailSubject: 'Subject',
      emailBody: 'Body',
    });

    expect(result.sent).toBe(true); // SMS delivered
    expect(result.results.sms).toBe('sent');
    expect(result.results.email).toMatch(/unavailable/);
  });

  test("channel='both' with a blocked SMS reports sent:false overall", async () => {
    mockTables({ prefs: { service_complete_channel: 'both' } });
    sendCustomerMessage.mockResolvedValue({ sent: false, code: 'suppressed' });

    const result = await NotificationDispatcher.notify('cust-1', 'service_complete', {
      smsMessage: 'sms body',
      emailSubject: 'Subject',
      emailBody: 'Body',
    });

    expect(result.sent).toBe(false);
    expect(result.results.sms).toMatch(/blocked/);
    expect(result.results.email).toMatch(/unavailable/);
  });
});
