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
});
