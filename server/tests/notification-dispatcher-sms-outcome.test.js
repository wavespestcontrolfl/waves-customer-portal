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
    expect(result).toMatchObject({
      sent: false,
      deliveryOutcome: 'accepted',
      smsResult: { sent: true, deliveryOutcome: 'accepted' },
    });
    expect(result.smsResult.retryable).toBeUndefined();
  });

  test('an uncertain provider outcome remains uncertain even when its raw metadata says retryable', async () => {
    const err = Object.assign(new Error('provider result audit failed'), {
      providerOutcome: { sent: false, deliveryOutcome: 'uncertain', retryable: true },
    });
    mockSend.mockRejectedValueOnce(err);
    const result = await NotificationDispatcher.notify('c-1', 'service_complete', { smsMessage: 'hi' });
    expect(result).toMatchObject({
      sent: false,
      deliveryOutcome: 'uncertain',
      smsResult: { sent: false, deliveryOutcome: 'uncertain', retryable: true },
    });
  });

  test('a throw with no provider outcome is uncertain, never not_sent', async () => {
    mockSend.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await NotificationDispatcher.notify('c-1', 'service_complete', { smsMessage: 'hi' });
    expect(result).toMatchObject({ sent: false, deliveryOutcome: 'uncertain' });
    expect(result.smsResult).toBeUndefined();
  });

  test('a retryable proven-unsent outcome preserves its complete provider retry evidence', async () => {
    const providerOutcome = {
      sent: false,
      provider: 'twilio',
      deliveryOutcome: 'not_sent',
      code: 'PROVIDER_RETRY',
      retryable: true,
      deferred: true,
      retryAfterMs: 300000,
      nextAllowedAt: '2026-09-13T12:05:00.000Z',
      providerErrorCode: '20429',
      providerHttpStatus: 429,
    };
    mockSend.mockRejectedValueOnce(Object.assign(new Error('audit write failed'), { providerOutcome }));
    const result = await NotificationDispatcher.notify('c-1', 'service_complete', { smsMessage: 'hi' });
    expect(result).toMatchObject({ sent: false, deliveryOutcome: 'not_sent', smsResult: providerOutcome });
  });

  test('an unclassified proven-unsent throw defaults to a retryable deferred result', async () => {
    const err = Object.assign(new Error('pre-provider read failed'), {
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
    });
    mockSend.mockRejectedValueOnce(err);
    const result = await NotificationDispatcher.notify('c-1', 'service_complete', { smsMessage: 'hi' });
    expect(result).toMatchObject({
      sent: false,
      deliveryOutcome: 'not_sent',
      smsResult: { sent: false, deliveryOutcome: 'not_sent', retryable: true, deferred: true },
    });
  });

  test.each([
    ['explicitly nonretryable', { retryable: false }],
    ['terminal', { terminal: true }],
  ])('a %s proven-unsent outcome remains terminal', async (_label, classification) => {
    const err = Object.assign(new Error('terminal refusal audit failed'), {
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent', ...classification },
    });
    mockSend.mockRejectedValueOnce(err);
    const result = await NotificationDispatcher.notify('c-1', 'service_complete', { smsMessage: 'hi' });
    expect(result).toMatchObject({
      sent: false,
      deliveryOutcome: 'not_sent',
      smsResult: { sent: false, deliveryOutcome: 'not_sent', retryable: false, deferred: false },
    });
  });

  test('a blocked send reports the provider outcome verbatim', async () => {
    mockSend.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent', code: 'OPTED_OUT' });
    const result = await NotificationDispatcher.notify('c-1', 'service_complete', { smsMessage: 'hi' });
    expect(result).toMatchObject({ sent: false, deliveryOutcome: 'not_sent' });
  });
});
