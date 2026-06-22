// Verify sendSubscription routes by platform: iOS rows go to APNs (never
// web-push), and an APNs-expired token deactivates the row.
const mockUpdate = jest.fn().mockResolvedValue(1);
const mockWhere = jest.fn(() => ({ update: mockUpdate }));
jest.mock('../models/db', () => jest.fn(() => ({ where: mockWhere })));

jest.mock('../services/apns', () => ({
  send: jest.fn(),
  status: () => ({ configured: false }),
}));

const apns = require('../services/apns');
const pushService = require('../services/push-notifications');
const sendSubscription = pushService._sendSubscription;

beforeEach(() => {
  jest.clearAllMocks();
});

test('iOS subscription is delivered via APNs', async () => {
  apns.send.mockResolvedValue({ ok: true });
  const sub = { id: 'sub-1', platform: 'ios', device_token: 'tok-abc' };

  const result = await sendSubscription(sub, { title: 'Hi', body: 'There' });

  expect(apns.send).toHaveBeenCalledWith('tok-abc', { title: 'Hi', body: 'There' });
  expect(result).toEqual({ sent: true });
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('an APNs-expired iOS token deactivates the subscription', async () => {
  apns.send.mockResolvedValue({ ok: false, expired: true, reason: 'Unregistered' });
  const sub = { id: 'sub-2', platform: 'ios', device_token: 'dead-tok' };

  const result = await sendSubscription(sub, { title: 'Hi' });

  expect(result.expired).toBe(true);
  expect(mockWhere).toHaveBeenCalledWith({ id: 'sub-2' });
  expect(mockUpdate).toHaveBeenCalledWith({ active: false });
});

test('APNs not configured → skipped (no row change)', async () => {
  apns.send.mockResolvedValue({ ok: false, skipped: true, reason: 'apns_not_configured' });
  const result = await sendSubscription({ id: 'sub-3', platform: 'ios', device_token: 't' }, {});

  expect(result).toEqual({ sent: false, skipped: true, reason: 'apns_not_configured' });
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('web subscriptions never call APNs', async () => {
  // No VAPID env in test → web path returns skipped, but crucially apns.send
  // must not be touched for a web row.
  const result = await sendSubscription(
    { id: 'sub-4', platform: 'web', subscription_data: '{}' },
    { title: 'Hi' },
  );
  expect(apns.send).not.toHaveBeenCalled();
  expect(result.skipped).toBe(true);
});
