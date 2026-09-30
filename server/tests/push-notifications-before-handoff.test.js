// sendToAdminUsers' beforeHandoff: a staleness check at EVERY device's final
// provider boundary — right before each web-push/APNs leg, and inside FCM
// after its OAuth fetch (fcm.js shouldContinue). A false answer skips that
// device and every later one (codex #5421 r2/r3: a status change that commits
// mid-send must not be followed by a stale lock-screen alert).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockApnsSend = jest.fn();
const mockFcmSend = jest.fn();
jest.mock('../services/apns', () => ({ send: (...a) => mockApnsSend(...a), status: () => ({ configured: true }) }));
jest.mock('../services/fcm', () => ({ send: (...a) => mockFcmSend(...a), status: () => ({ configured: true }) }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false) }));

const db = require('../models/db');
const Push = require('../services/push-notifications');

function primeSubs(subs) {
  db.mockImplementation((table) => {
    if (table === 'push_subscriptions as ps') {
      const q = {};
      for (const m of ['join', 'whereIn', 'where', 'whereRaw']) q[m] = jest.fn(() => q);
      q.select = jest.fn(async () => subs);
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const IOS = (id) => ({ id, admin_user_id: 'tech-1', platform: 'ios', device_token: `t-${id}` });
const ANDROID = (id) => ({ id, admin_user_id: 'tech-1', platform: 'android', device_token: `t-${id}` });

beforeEach(() => {
  jest.clearAllMocks();
  mockApnsSend.mockResolvedValue({ ok: true });
  mockFcmSend.mockResolvedValue({ ok: true });
});

test('runs before every iOS/web leg; a stale answer skips that device and every later one', async () => {
  primeSubs([IOS('a'), IOS('b'), IOS('c')]);
  const answers = [true, false];
  const beforeHandoff = jest.fn(async () => answers.shift());
  const out = await Push.sendToAdminUser('tech-1', { title: 'x', body: '' }, { beforeHandoff });
  expect(mockApnsSend).toHaveBeenCalledTimes(1);
  // Once stale, later devices are skipped without asking again.
  expect(beforeHandoff).toHaveBeenCalledTimes(2);
  expect(out).toMatchObject({ sent: 1, skipped: 2, superseded: true });
});

test('Android gets it as FCM\'s post-OAuth shouldContinue, not a pre-OAuth check', async () => {
  primeSubs([ANDROID('a')]);
  const beforeHandoff = jest.fn(async () => false);
  mockFcmSend.mockImplementation(async (_token, _n, { shouldContinue }) => (
    (await shouldContinue()) ? { ok: true } : { ok: false, skipped: true, reason: 'pre_send_check_blocked' }));
  const out = await Push.sendToAdminUser('tech-1', { title: 'x', body: '' }, { beforeHandoff });
  expect(beforeHandoff).toHaveBeenCalledTimes(1);
  expect(out).toMatchObject({ sent: 0, skipped: 1, superseded: true });
});

test('a throw mid-fan-out stops the rest but keeps earlier devices\' results', async () => {
  primeSubs([IOS('a'), IOS('b')]);
  const beforeHandoff = jest.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('db down'));
  const out = await Push.sendToAdminUsers(['tech-1'], { title: 'x', body: '' }, { beforeHandoff, deliveredSubscriptionIds: [] });
  expect(out).toMatchObject({ sent: 1, skipped: 1, deliveredSubscriptionIds: ['a'] });
});

test('without it, behaviour is unchanged (every device, no shouldContinue)', async () => {
  primeSubs([IOS('a'), ANDROID('b')]);
  const out = await Push.sendToAdminUser('tech-1', { title: 'x', body: '' });
  expect(out).toMatchObject({ sent: 2 });
  expect(mockFcmSend.mock.calls[0][2]).toEqual({ shouldContinue: undefined });
});
