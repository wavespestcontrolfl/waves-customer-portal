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
    for (const name of ['leftJoin', 'select', 'clearSelect', 'orderBy', 'where', 'whereNull', 'whereNotNull', 'orWhereIn', 'whereIn', 'groupBy', 'sum', 'max']) q[name] = () => q;
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

// sendToAdminUsers builds each device's banner just before its provider send, so a throw before the first build (its
// subscription lookup) reached no provider, and a throw after it may have.
const throwAfterFirstBuild = async (ids, build) => { build(ids[0], {}); throw new Error('provider down'); };

test('the dispatcher marks where its push failed: recipient lookup, before any handoff, or after a send began', async () => {
  admins = async () => { throw new Error('connection reset'); };
  await expect(triggerNotification('estimate_call_today', { count: 1, day: '2026-11-19' }, { pushOnly: true }))
    .resolves.toMatchObject({ push: null, pushFailed: 'recipient_lookup' });
  admins = async () => [{ id: 'admin-1', role: 'admin' }];
  PushService.sendToAdminUsers.mockRejectedValueOnce(new Error('push_subscriptions query failed'));
  await expect(triggerNotification('estimate_call_today', { count: 1, day: '2026-11-19' }, { pushOnly: true }))
    .resolves.toMatchObject({ push: null, pushFailed: 'before_handoff' });
  PushService.sendToAdminUsers.mockImplementationOnce(throwAfterFirstBuild);
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

test('a failed recipient lookup is an error with nothing handed off: the claim is released, and a rerun after the database recovers sends', async () => {
  admins = async () => { throw new Error('connection reset'); };
  await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'push_failed_before_handoff' });
  expect([...claimed]).toEqual([]);
  expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: push failed before any handoff (recipient_lookup); claim released');
  admins = async () => [{ id: 'admin-1', role: 'admin' }];
  await expect(run()).resolves.toMatchObject({ count: 1, sent: true });
  expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
});

test('a failed subscription lookup reached no provider: the claim is released, and a rerun sends', async () => {
  PushService.sendToAdminUsers.mockRejectedValueOnce(new Error('push_subscriptions query failed'));
  await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'push_failed_before_handoff' });
  expect([...claimed]).toEqual([]);
  await expect(run()).resolves.toMatchObject({ count: 1, sent: true });
});

test('a push dispatch that threw after a device send began is an error with the claim kept', async () => {
  PushService.sendToAdminUsers.mockImplementation(throwAfterFirstBuild);
  await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'push_dispatch_failed' });
  expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
});

test('the count reads only the columns the rule and the call lookup use', () => {
  const { CALL_TODAY_COLUMNS } = require('../services/estimate-call-today-push');
  const { callTodayFields } = require('../services/estimate-call-list');
  const full = { ...viewedRow, estimate_data: { big: true }, customer_name: 'Synthetic Name' };
  const picked = Object.fromEntries(CALL_TODAY_COLUMNS.map((c) => c.replace('estimates.', '')).map((c) => [c, full[c]]));
  expect(callTodayFields(picked)).toEqual(callTodayFields(full));
  expect(CALL_TODAY_COLUMNS).not.toContain('estimates.estimate_data');
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

// Web Push keeps an undelivered push for weeks by default: a phone that reconnects days later must not show an old count.
test('the outgoing push expires at the end of its ET day', async () => {
  let built = null;
  PushService.sendToAdminUsers.mockImplementation(async (ids, build) => {
    built = build(ids[0], {});
    return { subscriptions: 1, sent: 1, expired: 0, failed: 0, skipped: 0, results: [] };
  });
  await expect(run()).resolves.toMatchObject({ count: 1, sent: true });
  expect(built).toMatchObject({ tag: 'waves-estimate_call_today-2026-11-19', expiresAt: '2026-11-20T05:00:00.000Z' });
});
