// The 9 AM "Call today" push through the REAL triggerNotification (only the database, the push service and the badge
// count are mocked): a recipient lookup or push dispatch that throws leaves `push: null` in the dispatcher's result,
// the same as a disabled push, so the dispatcher also sets `pushFailed`. The push must read that as a failure (claim
// kept, error reported to cron job health), and a really disabled push must stay a skip. Rows are synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn() }));
jest.mock('../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })) }));
jest.mock('../services/notification-bell-policy', () => ({ isBellPolicyEnabled: () => false }));
const mockLastCalled = jest.fn();
jest.mock('../services/estimate-call-list', () => ({
  ...jest.requireActual('../services/estimate-call-list'),
  lastCalledAtByEstimateId: (...args) => mockLastCalled(...args),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const PushService = require('../services/push-notifications');
const { runEstimateCallTodayPush } = require('../services/estimate-call-today-push');
const { triggerNotification } = require('../services/notification-triggers');

const NOW = new Date('2026-11-19T14:00:00Z');
const viewedRow = {
  id: 'e1', status: 'viewed', customer_phone: '+19415550101', archived_at: null,
  sent_at: '2026-11-18T14:00:00Z', viewed_at: '2026-11-19T09:00:00Z', last_viewed_at: '2026-11-19T09:00:00Z', last_follow_up_at: null,
};

let claimed;
let admins; // () => Promise of recipient rows, or throws
beforeEach(() => {
  jest.clearAllMocks();
  claimed = new Set();
  admins = async () => [{ id: 'admin-1', role: 'admin' }];
  mockLastCalled.mockResolvedValue(new Map());
  PushService.sendToAdminUsers.mockResolvedValue({ subscriptions: 1, sent: 1, expired: 0, failed: 0, skipped: 0, results: [] });
  db.raw = jest.fn(async (_sql, [key]) => {
    if (claimed.has(key)) return { rows: [] };
    claimed.add(key);
    return { rows: [{ id: 1 }] };
  });
  db.mockImplementation((table) => {
    const q = {};
    for (const name of ['leftJoin', 'select', 'orderBy', 'where', 'whereNull', 'whereNotNull', 'orWhereIn', 'whereIn', 'groupBy', 'max']) q[name] = () => q;
    if (table === 'estimates') {
      q.limit = () => Promise.resolve([viewedRow]);
    } else if (table === 'short_codes') {
      q.then = (ok, no) => Promise.resolve([]).then(ok, no);
    } else if (table === 'notification_preferences') {
      q.then = (ok, no) => Promise.resolve([]).then(ok, no);
    } else if (table === 'technicians') {
      q.select = () => admins();
    } else if (table === 'sms_send_claims') {
      return { where: ({ claim_key: key }) => ({ del: async () => { claimed.delete(key); return 1; } }) };
    } else {
      throw new Error(`unexpected table ${table}`);
    }
    return q;
  });
});

const run = () => runEstimateCallTodayPush({ now: NOW });

test('the dispatcher marks a thrown recipient lookup and a thrown push dispatch with pushFailed', async () => {
  admins = async () => { throw new Error('connection reset'); };
  await expect(triggerNotification('estimate_call_today', { count: 1, day: '2026-11-19' }, { pushOnly: true }))
    .resolves.toMatchObject({ push: null, pushFailed: 'recipient_lookup' });
  admins = async () => [{ id: 'admin-1', role: 'admin' }];
  PushService.sendToAdminUsers.mockRejectedValue(new Error('provider down'));
  await expect(triggerNotification('estimate_call_today', { count: 1, day: '2026-11-19' }, { pushOnly: true }))
    .resolves.toMatchObject({ push: null, pushFailed: 'push_dispatch' });
});

test('no pushFailed on a delivered push, a disabled push or a push with no recipient', async () => {
  const delivered = await triggerNotification('estimate_call_today', { count: 1, day: '2026-11-19' }, { pushOnly: true });
  expect(delivered.pushFailed).toBeUndefined();
  admins = async () => [];
  const noOne = await triggerNotification('estimate_call_today', { count: 1, day: '2026-11-19' }, { pushOnly: true });
  expect(noOne).toMatchObject({ push: null });
  expect(noOne.pushFailed).toBeUndefined();
});

test('a failed recipient lookup is an error: the claim stays, cron health sees the failure, a rerun does not dispatch', async () => {
  admins = async () => { throw new Error('connection reset'); };
  await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'push_dispatch_failed' });
  expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
  expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: push dispatch failed (recipient_lookup); claim kept');
  await expect(run()).resolves.toMatchObject({ skipped: 'already_claimed' });
});

test('a thrown push dispatch is an error with the claim kept', async () => {
  PushService.sendToAdminUsers.mockRejectedValue(new Error('provider down'));
  await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'push_dispatch_failed' });
  expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
});

test('a really disabled push (no admin to send to) stays a skip and frees the claim', async () => {
  admins = async () => [];
  await expect(run()).resolves.toEqual({ count: 1, sent: false, skipped: 'no_push_delivered' });
  expect([...claimed]).toEqual([]);
});

test('a delivered push is sent', async () => {
  await expect(run()).resolves.toMatchObject({ count: 1, sent: true });
  expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
});
