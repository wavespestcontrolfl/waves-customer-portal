const mockApnsSend = jest.fn();
const mockFcmSend = jest.fn();
let mockSubscriptions;
let mockOwnershipGate;
let mockOwnershipStarted;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/apns', () => ({
  send: (...args) => mockApnsSend(...args),
  status: () => ({ configured: true }),
}));
jest.mock('../services/fcm', () => ({
  send: (...args) => mockFcmSend(...args),
  status: () => ({ configured: true }),
}));
jest.mock('../services/account-properties', () => ({
  accountPropertyIds: jest.fn(async (req) => [req.customerId]),
  resolvePrimaryProfileId: jest.fn(async (req) => req.customerId),
  appPropertyScopeEnabled: jest.fn(() => false),
}));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false) }));
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const query = {
      where: jest.fn(() => query),
      whereIn: jest.fn(() => query),
      whereRaw: jest.fn(() => query),
      first: jest.fn(async (column) => {
        if (table === 'customers') return { id: 'cust-1', account_id: null, active: true, deleted_at: null };
        if (table === 'notification_prefs') return { push_enabled: true };
        if (table === 'notifications' && column === 'metadata') return { metadata: {} };
        if (table === 'notifications' && column === 'id') {
          mockOwnershipStarted?.resolve();
          return mockOwnershipGate ? mockOwnershipGate.promise : {
            id: 'bell-1', metadata: { pushLeaseUntil: new Date(Date.now() + 120000).toISOString() },
          };
        }
        return null;
      }),
      update: jest.fn(async () => 1),
      then: (resolve, reject) => Promise.resolve(table === 'push_subscriptions' ? mockSubscriptions : [])
        .then(resolve, reject),
    };
    return query;
  });
  db.raw = jest.fn(() => 'RAW');
  return db;
});

const Push = require('../services/push-notifications');
const { windowGuardFrom } = require('../services/messaging/push-channel-routing')._test;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const notification = { title: 'Visit update', body: 'Your technician is on the way' };

beforeEach(() => {
  jest.clearAllMocks();
  mockSubscriptions = [{ id: 'ios-1', platform: 'ios', device_token: 'ios-token' }];
  mockOwnershipGate = null;
  mockOwnershipStarted = null;
  mockApnsSend.mockResolvedValue({ ok: true });
  mockFcmSend.mockResolvedValue({ ok: true });
});
afterEach(() => jest.useRealTimers());

test('a window closing during the notification ownership lookup blocks provider handoff', async () => {
  mockOwnershipGate = deferred();
  mockOwnershipStarted = deferred();
  let allowed = true;
  const shouldContinue = jest.fn(async () => allowed);
  shouldContinue.isStillValid = () => allowed;

  const sending = Push.sendToCustomer('cust-1', notification, {
    notificationId: 'bell-1', shouldContinue,
  });
  await mockOwnershipStarted.promise;
  expect(shouldContinue).toHaveBeenCalledTimes(1);
  allowed = false;
  mockOwnershipGate.resolve({
    id: 'bell-1', metadata: { pushLeaseUntil: new Date(Date.now() + 120000).toISOString() },
  });

  const result = await sending;
  expect(result).toMatchObject({ subscriptions: 1, sent: 0, skipped: 1 });
  expect(result.results).toEqual([
    { sent: false, skipped: true, reason: 'send_window_closed' },
  ]);
  expect(mockApnsSend).not.toHaveBeenCalled();
});

test('a deadline crossed during the ownership lookup blocks provider handoff', async () => {
  jest.useFakeTimers({ now: new Date('2026-09-12T23:59:00Z') });
  mockOwnershipGate = deferred();
  mockOwnershipStarted = deferred();
  const shouldContinue = jest.fn(async () => ({ ok: true, validUntil: Date.now() + 1000 }));

  const sending = Push.sendToCustomer('cust-1', notification, {
    notificationId: 'bell-1', shouldContinue,
  });
  await mockOwnershipStarted.promise;
  jest.advanceTimersByTime(1001);
  mockOwnershipGate.resolve({
    id: 'bell-1', metadata: { pushLeaseUntil: new Date(Date.now() + 120000).toISOString() },
  });

  await expect(sending).resolves.toMatchObject({ subscriptions: 1, sent: 0, skipped: 1 });
  expect(mockApnsSend).not.toHaveBeenCalled();
});

test('a notification lease crossed during its ownership read blocks provider handoff', async () => {
  jest.useFakeTimers({ now: new Date('2026-09-12T23:59:00Z') });
  mockOwnershipGate = deferred();
  mockOwnershipStarted = deferred();
  const leaseUntil = Date.now() + 1000;

  const sending = Push.sendToCustomer('cust-1', notification, {
    notificationId: 'bell-1', shouldContinue: async () => true,
  });
  await mockOwnershipStarted.promise;
  jest.advanceTimersByTime(1001);
  mockOwnershipGate.resolve({
    id: 'bell-1', metadata: { pushLeaseUntil: new Date(leaseUntil).toISOString() },
  });

  await expect(sending).resolves.toMatchObject({ sent: 0, reason: 'push_in_flight' });
  expect(mockApnsSend).not.toHaveBeenCalled();
});

test('ownership replaced during the awaited caller guard stops the old worker', async () => {
  const shouldContinue = jest.fn(async () => {
    mockOwnershipGate = { promise: Promise.resolve(null) };
    return true;
  });

  const result = await Push.sendToCustomer('cust-1', notification, {
    notificationId: 'bell-1', shouldContinue,
  });

  expect(result).toMatchObject({ sent: 0, reason: 'push_in_flight' });
  expect(mockApnsSend).not.toHaveBeenCalled();
});

test('a throwing send-window guard skips the provider leg', async () => {
  const shouldContinue = jest.fn(async () => { throw new Error('guard unavailable'); });

  const result = await Push.sendToCustomer('cust-1', notification, { shouldContinue });

  expect(result).toMatchObject({ subscriptions: 1, sent: 0, skipped: 1 });
  expect(mockApnsSend).not.toHaveBeenCalled();
});

test('a later refusal preserves an earlier provider acceptance in the summary', async () => {
  mockSubscriptions = [
    { id: 'ios-1', platform: 'ios', device_token: 'ios-token-1' },
    { id: 'ios-2', platform: 'ios', device_token: 'ios-token-2' },
  ];
  const shouldContinue = jest.fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);

  const result = await Push.sendToCustomer('cust-1', notification, { shouldContinue });

  expect(result).toMatchObject({ subscriptions: 2, sent: 1, skipped: 1 });
  expect(mockApnsSend).toHaveBeenCalledTimes(1);
});

test('Android receives the guard only as provider options', async () => {
  mockSubscriptions = [{ id: 'android-1', platform: 'android', device_token: 'android-token' }];
  const shouldContinue = jest.fn().mockResolvedValue(true);

  const result = await Push.sendToCustomer('cust-1', notification, { shouldContinue });

  expect(result.sent).toBe(1);
  expect(mockFcmSend).toHaveBeenCalledWith('android-token', notification, { shouldContinue: expect.any(Function) });
  expect(mockFcmSend.mock.calls[0][1]).not.toHaveProperty('shouldContinue');
});

test('FCM post-OAuth guard detects a replaced notification claim', async () => {
  mockSubscriptions = [{ id: 'android-1', platform: 'android', device_token: 'android-token' }];
  const shouldContinue = jest.fn().mockResolvedValue(true);
  mockFcmSend.mockImplementation(async (_token, _notification, options) => {
    mockOwnershipGate = { promise: Promise.resolve(null) };
    return (await options.shouldContinue())
      ? { ok: true }
      : { ok: false, skipped: true, reason: 'pre_send_check_blocked' };
  });

  const result = await Push.sendToCustomer('cust-1', notification, {
    notificationId: 'bell-1', shouldContinue,
  });

  expect(result).toMatchObject({ sent: 0, reason: 'push_in_flight' });
  expect(shouldContinue).toHaveBeenCalledTimes(2);
});

test('a caller without a guard still sends normally', async () => {
  const result = await Push.sendToCustomer('cust-1', notification);

  expect(result).toMatchObject({ subscriptions: 1, sent: 1, skipped: 0 });
  expect(mockApnsSend).toHaveBeenCalledTimes(1);
});

test('the routing adapter preserves a structured deadline and its pure window check', async () => {
  const verdict = { ok: true, validUntil: Date.now() + 60000 };
  const preSendCheck = jest.fn(async () => verdict);
  preSendCheck.isStillValid = jest.fn(() => false);
  const guard = windowGuardFrom(preSendCheck);

  await expect(guard()).resolves.toBe(verdict);
  expect(guard.isStillValid()).toBe(false);
  expect(preSendCheck.isStillValid).toHaveBeenCalledTimes(1);
});
