// sendToAdminUsers' `connection` and `deadlineAt` options, used by
// utils/tech-visit-push-lock.js: a lock holder must run its subscription
// lookup and expired-device cleanup on the one connection it already holds
// (no extra pool checkout inside runExclusive at DB_POOL_MAX=2), and must
// start no device leg past its deadline so the lock is released in bounded
// time (codex #5421 P1s).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockApnsSend = jest.fn();
jest.mock('../services/apns', () => ({ send: (...a) => mockApnsSend(...a), status: () => ({ configured: true }) }));
jest.mock('../services/fcm', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false) }));

const db = require('../models/db');
const Push = require('../services/push-notifications');

const SUBS = [
  { id: 'sub-1', admin_user_id: 'tech-1', platform: 'ios', device_token: 't1' },
  { id: 'sub-2', admin_user_id: 'tech-1', platform: 'ios', device_token: 't2' },
];

function connection(subs = SUBS) {
  const updates = [];
  const conn = jest.fn((table) => {
    if (table === 'push_subscriptions as ps') {
      const q = {};
      for (const m of ['join', 'whereIn', 'where', 'whereRaw']) q[m] = jest.fn(() => q);
      q.select = jest.fn(async () => subs);
      return q;
    }
    if (table === 'push_subscriptions') {
      return { where: jest.fn((w) => ({ update: jest.fn((u) => { updates.push([w, u]); return Promise.resolve(1); }) })) };
    }
    throw new Error(`unexpected table ${table}`);
  });
  conn.updates = updates;
  return conn;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => { throw new Error(`pool used for ${table}`); });
});

test('with a connection, the lookup and the expired-device cleanup never touch the pool', async () => {
  mockApnsSend.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ expired: true, reason: 'Unregistered' });
  const conn = connection();
  const out = await Push.sendToAdminUser('tech-1', { title: 'x', body: '' }, { connection: conn });
  expect(out).toMatchObject({ subscriptions: 2, sent: 1, expired: 1 });
  expect(conn.updates).toEqual([[{ id: 'sub-2' }, { active: false }]]);
  expect(db).not.toHaveBeenCalled();
});

test('no device leg starts past deadlineAt; legs already started finish', async () => {
  let now = 1000;
  const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    mockApnsSend.mockImplementationOnce(async () => { now = 5000; return { ok: true }; });
    const out = await Push.sendToAdminUsers(['tech-1'], { title: 'x', body: '' }, { connection: connection(), deadlineAt: 4000 });
    expect(mockApnsSend).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ sent: 1, skipped: 1 });
    expect(out.results[1]).toEqual({ sent: false, skipped: true, reason: 'send_budget_spent' });
  } finally {
    spy.mockRestore();
  }
});

test('without options it behaves as before (pool lookup, every device)', async () => {
  mockApnsSend.mockResolvedValue({ ok: true });
  const conn = connection();
  db.mockImplementation((table) => conn(table));
  const out = await Push.sendToAdminUser('tech-1', { title: 'x', body: '' });
  expect(out).toMatchObject({ subscriptions: 2, sent: 2 });
});
