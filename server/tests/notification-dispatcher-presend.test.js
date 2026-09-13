jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19415550199') }));

const mockInsert = jest.fn(async () => []);
jest.mock('../models/db', () => jest.fn((table) => {
  if (table === 'customers') return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn(async () => ({ id: 'customer-1', phone: '+19415550123' })),
  };
  if (table === 'notification_prefs') return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn(async () => ({ service_complete_channel: 'sms' })),
  };
  if (table === 'sms_log') return { insert: mockInsert };
  throw new Error(`Unexpected table: ${table}`);
}));

const NotificationDispatcher = require('../services/notification-dispatcher');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

const MESSAGE = {
  smsMessage: 'Your lawn report is ready.',
  emailSubject: 'Lawn report',
  emailBody: 'Your lawn report is ready.',
};

beforeEach(() => {
  jest.clearAllMocks();
  sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
});

test('notify forwards its pre-send guard into the canonical customer-message input', async () => {
  const preSendCheck = jest.fn(async () => ({ ok: true }));
  expect((await NotificationDispatcher.notify('customer-1', 'service_complete', {
    ...MESSAGE,
    preSendCheck,
  })).sent).toBe(true);
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ preSendCheck }));
});

test('a guarded send-window hold stays unqueued so its recovery owner can prepare fresh copy', async () => {
  sendCustomerMessage.mockResolvedValue({
    sent: false,
    blocked: true,
    deliveryOutcome: 'not_sent',
    code: 'QUIET_HOURS_HOLD',
    retryable: true,
    deferred: true,
    nextAllowedAt: '2026-09-13T12:00:00.000Z',
  });

  const result = await NotificationDispatcher.notify('customer-1', 'service_complete', {
    ...MESSAGE,
    preSendCheck: async () => ({ ok: true }),
  });
  expect(result).toMatchObject({ sent: false, results: { sms: 'blocked: QUIET_HOURS_HOLD' } });
  expect(mockInsert).not.toHaveBeenCalled();
});

test('an unguarded send-window hold keeps the existing frozen-body queue behavior', async () => {
  sendCustomerMessage.mockResolvedValue({
    sent: false,
    blocked: true,
    deliveryOutcome: 'not_sent',
    code: 'QUIET_HOURS_HOLD',
    retryable: true,
    deferred: true,
    nextAllowedAt: '2026-09-13T12:00:00.000Z',
  });

  const result = await NotificationDispatcher.notify('customer-1', 'service_complete', MESSAGE);
  expect(result).toMatchObject({ sent: true, results: { sms: 'scheduled' } });
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
    customer_id: 'customer-1',
    message_body: MESSAGE.smsMessage,
    status: 'scheduled',
  }));
});
