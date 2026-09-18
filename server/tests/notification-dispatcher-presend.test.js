jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19415550199') }));

const mockInsert = jest.fn(async () => []);
let mockPrefs = { service_complete_channel: 'sms' };
let mockCustomer = { id: 'customer-1', phone: '+19415550123' };
let mockCustomerError;
let mockPrefsError;
jest.mock('../models/db', () => jest.fn((table) => {
  if (table === 'customers') return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn(async () => { if (mockCustomerError) throw mockCustomerError; return mockCustomer; }),
  };
  if (table === 'notification_prefs') return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn(async () => { if (mockPrefsError) throw mockPrefsError; return mockPrefs; }),
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
  mockPrefs = { service_complete_channel: 'sms' };
  mockCustomer = { id: 'customer-1', phone: '+19415550123' };
  mockCustomerError = null;
  mockPrefsError = null;
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

test('a guarded customer quiet-hours hold exposes a proven-unsent retry at the actual quiet end', async () => {
  mockPrefs = {
    service_completed: true,
    service_complete_channel: 'sms',
    quiet_hours_start: '22:00:00',
    quiet_hours_end: '09:00:00',
  };
  jest.useFakeTimers().setSystemTime(new Date('2026-09-12T12:00:00Z')); // 08:00 ET
  try {
    const result = await NotificationDispatcher.notify('customer-1', 'service_complete', {
      ...MESSAGE,
      preSendCheck: async () => ({ ok: true }),
    });
    expect(result).toEqual({
      sent: false,
      channel: 'sms',
      results: { sms: 'blocked: QUIET_HOURS_HOLD' },
      deliveryOutcome: 'not_sent',
      smsResult: {
        sent: false,
        blocked: true,
        deliveryOutcome: 'not_sent',
        code: 'QUIET_HOURS_HOLD',
        reason: 'customer_quiet_hours',
        retryable: true,
        deferred: true,
        nextAllowedAt: '2026-09-12T13:00:00.000Z',
      },
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test.each([
  ['unguarded SMS', 'sms', undefined],
  ['guarded email-only', 'email', async () => ({ ok: true })],
])('%s keeps the existing quiet-hours suppression without an SMS obligation', async (_label, channel, preSendCheck) => {
  mockPrefs = {
    service_complete_channel: channel,
    quiet_hours_start: '22:00:00',
    quiet_hours_end: '09:00:00',
  };
  jest.useFakeTimers().setSystemTime(new Date('2026-09-12T12:00:00Z')); // 08:00 ET
  try {
    await expect(NotificationDispatcher.notify('customer-1', 'service_complete', {
      ...MESSAGE,
      ...(preSendCheck ? { preSendCheck } : {}),
    })).resolves.toEqual({
      sent: false, channel: null, results: { reason: 'quiet_hours' }, deliveryOutcome: 'not_sent',
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('a guarded quiet window covering the global send window is suppressed without an impossible retry', async () => {
  mockPrefs = {
    service_complete_channel: 'sms',
    quiet_hours_start: '08:00:00',
    quiet_hours_end: '21:00:00',
  };
  jest.useFakeTimers().setSystemTime(new Date('2026-09-12T16:00:00Z')); // 12:00 ET
  try {
    await expect(NotificationDispatcher.notify('customer-1', 'service_complete', {
      ...MESSAGE,
      preSendCheck: async () => ({ ok: true }),
    })).resolves.toEqual({
      sent: false, channel: null, results: { reason: 'quiet_hours' }, deliveryOutcome: 'not_sent',
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test.each([
  ['disabled type', 'service_complete', {
    service_completed: false,
    service_complete_channel: 'sms',
  }, { reason: 'type_disabled' }],
  ['missing marketing opt-in', 'marketing', {
    marketing_channel: 'sms',
  }, { reason: 'quiet_hours' }],
])('guarded quiet hours preserve %s suppression without an SMS obligation', async (_label, type, prefs, results) => {
  mockPrefs = {
    ...prefs,
    quiet_hours_start: '22:00:00',
    quiet_hours_end: '09:00:00',
  };
  jest.useFakeTimers().setSystemTime(new Date('2026-09-12T12:00:00Z')); // 08:00 ET
  try {
    await expect(NotificationDispatcher.notify('customer-1', type, {
      ...MESSAGE,
      preSendCheck: async () => ({ ok: true }),
    })).resolves.toEqual({ sent: false, channel: null, results, deliveryOutcome: 'not_sent' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test.each([
  ['email-only preference', { service_complete_channel: 'email' }, { id: 'customer-1', phone: '+19415550123' }],
  ['missing phone', { service_complete_channel: 'sms' }, { id: 'customer-1', phone: null }],
])('%s without a provider attempt is explicit non-delivery', async (_label, prefs, customer) => {
  mockPrefs = prefs;
  mockCustomer = customer;
  await expect(NotificationDispatcher.notify('customer-1', 'service_complete', MESSAGE)).resolves.toMatchObject({
    sent: false, deliveryOutcome: 'not_sent',
  });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test.each(['customer', 'preferences'])('%s read failure carries explicit retryable non-delivery evidence', async (read) => {
  const err = new Error(`${read} read failed`);
  if (read === 'customer') mockCustomerError = err;
  else mockPrefsError = err;
  await expect(NotificationDispatcher.notify('customer-1', 'service_complete', MESSAGE)).rejects.toMatchObject({
    providerOutcome: {
      sent: false,
      deliveryOutcome: 'not_sent',
      code: 'NOTIFICATION_PREPARATION_FAILED',
      retryable: true,
      deferred: true,
    },
  });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
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
