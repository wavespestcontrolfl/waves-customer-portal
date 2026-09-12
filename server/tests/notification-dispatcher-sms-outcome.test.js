// The dispatcher's SMS outcome is what lets a caller with a durable send-once
// claim tell "never sent" from "may already be on the wire".
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const rows = { customers: { id: 'c-1', phone: '+15615550123', first_name: 'Pat' }, customer_notification_prefs: null };
  const table = (name) => ({ where: () => ({ first: async () => rows[name] ?? null }) });
  table.raw = async () => ({ rows: [] });
  return table;
});
const mockSend = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...args) => mockSend(...args) }));

const NotificationDispatcher = require('../services/notification-dispatcher');

describe('notify surfaces the canonical SMS outcome', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an accepted-but-unaudited send reports accepted, not a failure to send', async () => {
    const err = Object.assign(new Error('audit write failed'), { providerOutcome: { sent: true, deliveryOutcome: 'accepted' } });
    mockSend.mockRejectedValueOnce(err);
    const result = await NotificationDispatcher.notify('c-1', 'service_complete', { smsMessage: 'hi' });
    expect(result).toMatchObject({ sent: false, deliveryOutcome: 'accepted' });
  });

  test('a throw with no provider outcome is uncertain, never not_sent', async () => {
    mockSend.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await NotificationDispatcher.notify('c-1', 'service_complete', { smsMessage: 'hi' });
    expect(result).toMatchObject({ sent: false, deliveryOutcome: 'uncertain' });
  });

  test('a blocked send reports the provider outcome verbatim', async () => {
    mockSend.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent', code: 'OPTED_OUT' });
    const result = await NotificationDispatcher.notify('c-1', 'service_complete', { smsMessage: 'hi' });
    expect(result).toMatchObject({ sent: false, deliveryOutcome: 'not_sent' });
  });
});
