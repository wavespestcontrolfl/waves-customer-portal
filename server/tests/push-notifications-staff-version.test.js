const mockQuery = {};
for (const method of ['join', 'where', 'whereIn', 'whereRaw']) {
  mockQuery[method] = jest.fn(() => mockQuery);
}
mockQuery.select = jest.fn(async () => []);

jest.mock('../models/db', () => jest.fn(() => mockQuery));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/apns', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
jest.mock('../services/fcm', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

const pushService = require('../services/push-notifications');

describe('staff push credential-version filtering', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['broadcast', () => pushService.sendToAdmins({ title: 'Update' })],
    ['targeted', () => pushService.sendToAdminUsers(['tech-1'], { title: 'Update' })],
  ])('%s sends require the subscription version to match the current staff version', async (
    _label,
    send,
  ) => {
    await expect(send()).resolves.toMatchObject({ subscriptions: 0, sent: 0 });
    expect(mockQuery.whereRaw).toHaveBeenCalledWith(
      'ps.staff_token_version = t.auth_token_version',
    );
  });

  test('beforeDispatch runs after the subscription lookup and can withhold every send', async () => {
    const order = [];
    mockQuery.select.mockImplementationOnce(async () => { order.push('lookup'); return [{ id: 'sub-1', platform: 'web', subscription_data: '{}' }]; });
    const beforeDispatch = jest.fn(async () => { order.push('claim'); return false; });
    await expect(pushService.sendToAdminUsers(['tech-1'], { title: 'Update' }, { beforeDispatch }))
      .resolves.toMatchObject({ subscriptions: 1, sent: 0, superseded: true });
    expect(order).toEqual(['lookup', 'claim']);
    expect(require('web-push').sendNotification).not.toHaveBeenCalled();
  });

  test('beforeDispatch is not consulted when the lookup finds no subscription', async () => {
    const beforeDispatch = jest.fn(async () => true);
    await expect(pushService.sendToAdminUsers(['tech-1'], { title: 'Update' }, { beforeDispatch }))
      .resolves.toMatchObject({ subscriptions: 0, sent: 0 });
    expect(beforeDispatch).not.toHaveBeenCalled();
  });
});

test('queued retries send only to subscriptions that have not accepted delivery', async () => {
  const apns = require('../services/apns');
  const subs = [
    { id: 'sub-accepted', platform: 'ios', device_token: 'token-accepted', admin_user_id: 'admin-1' },
    { id: 'sub-retry', platform: 'ios', device_token: 'token-retry', admin_user_id: 'admin-1' },
  ];
  mockQuery.select.mockResolvedValue(subs);
  apns.send.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
  const first = await pushService.sendToAdminUsers(['admin-1'], { title: 'Synthetic' }, { deliveredSubscriptionIds: [] });
  expect(first).toMatchObject({ sent: 1, failed: 1, deliveredSubscriptionIds: ['sub-accepted'] });
  apns.send.mockClear().mockResolvedValue({ ok: true });
  const second = await pushService.sendToAdminUsers(['admin-1'], { title: 'Synthetic' }, {
    deliveredSubscriptionIds: first.deliveredSubscriptionIds,
  });
  expect(apns.send).toHaveBeenCalledTimes(1);
  expect(apns.send).toHaveBeenCalledWith('token-retry', expect.any(Object));
  expect(second).toMatchObject({ sent: 2, failed: 0, deliveredSubscriptionIds: ['sub-accepted', 'sub-retry'] });
});
