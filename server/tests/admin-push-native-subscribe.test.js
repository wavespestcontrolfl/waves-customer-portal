// Waves Admin (the iOS staff app) registers its APNs token through the
// signed-in staff page: the row binds to the current staff session, names the
// app's bundle and APNs environment, and a stale session registers nothing.

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn();
  db.fn = { now: () => 'NOW()' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ listTriggers: jest.fn(() => []) }));
jest.mock('../services/push-notifications', () => ({
  status: jest.fn(() => ({ available: false, configured: false })),
  sendToAdminUser: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  staffTokenVersionMatches: (token, tech) => (
    token?.type === 'access'
    && Number.isInteger(token.tokenVersion)
    && token.tokenVersion === Number(tech?.auth_token_version)
  ),
}));

const db = require('../models/db');
const { nativeSubscribe, nativeUnsubscribe } = require('../routes/admin-push')._handlers;

const TOKEN = 'a1'.repeat(32);
const TECH = { id: 'tech-1', active: true, role: 'admin', auth_token_version: 7, must_change_password: false };

function installTransaction(technician) {
  const lock = { where: jest.fn(() => lock), forUpdate: jest.fn(() => lock), first: jest.fn(async () => technician) };
  const upsert = {
    insert: jest.fn(() => upsert),
    onConflict: jest.fn(() => upsert),
    merge: jest.fn(() => upsert),
    returning: jest.fn(async () => [{ id: 'sub-9' }]),
  };
  const trx = jest.fn((table) => (table === 'technicians' ? lock : upsert));
  db.transaction.mockImplementation(async (callback) => callback(trx));
  return { trx, upsert };
}

function request(body, tokenVersion = 7) {
  return { body, technicianId: 'tech-1', staffToken: { type: 'access', tokenVersion, mfa: true } };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('POST /api/admin/push/native-subscribe', () => {
  beforeEach(() => jest.clearAllMocks());

  test('binds the token to the current staff session with the app bundle and environment', async () => {
    const { upsert } = installTransaction(TECH);
    const res = response();
    await nativeSubscribe(request({ token: TOKEN, environment: 'sandbox', reg: 'reg-0001' }), res, jest.fn());

    expect(res.body).toEqual({ ok: true, id: 'sub-9' });
    const row = upsert.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      admin_user_id: 'tech-1',
      customer_id: null,
      role: 'admin',
      platform: 'ios',
      device_token: TOKEN,
      active: true,
      staff_token_version: 7,
      staff_mfa: true,
    });
    expect(JSON.parse(row.subscription_data)).toEqual({
      token: TOKEN, topic: 'com.wavespestcontrol.wavespay', environment: 'sandbox', reg: 'reg-0001',
    });
    expect(upsert.onConflict).toHaveBeenCalledWith('device_token');
    expect(upsert.merge).toHaveBeenCalledWith({ ...row, updated_at: 'NOW()' });
  });

  test('a session whose staff version rotated registers nothing', async () => {
    const { upsert } = installTransaction(TECH);
    const res = response();
    await nativeSubscribe(request({ token: TOKEN, environment: 'sandbox', reg: 'reg-0001' }, 6), res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
    expect(upsert.insert).not.toHaveBeenCalled();
  });

  test('refuses a malformed token, an unknown environment or a missing sign-up id before any write', async () => {
    for (const body of [
      { token: 'not-hex', environment: 'sandbox', reg: 'reg-0001' },
      { token: TOKEN, environment: 'staging', reg: 'reg-0001' },
      { token: TOKEN, environment: 'sandbox' },
    ]) {
      const res = response();
      await nativeSubscribe(request(body), res, jest.fn());
      expect(res.statusCode).toBe(400);
    }
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/push/native-unsubscribe', () => {
  beforeEach(() => jest.clearAllMocks());

  test('deactivates only the signed-in staff member\'s row for this sign-up, in one update', async () => {
    const query = { where: jest.fn(() => query), whereRaw: jest.fn(() => query), update: jest.fn(async () => 1) };
    db.mockImplementation(() => query);
    const res = response();
    await nativeUnsubscribe(request({ token: TOKEN, reg: 'reg-0001' }), res, jest.fn());

    expect(db).toHaveBeenCalledWith('push_subscriptions');
    expect(query.where).toHaveBeenCalledWith({ admin_user_id: 'tech-1', device_token: TOKEN, platform: 'ios' });
    // A newer sign-up of the same token carries another id and stays active.
    expect(query.whereRaw).toHaveBeenCalledWith("subscription_data::jsonb->>'reg' = ?", ['reg-0001']);
    expect(query.update).toHaveBeenCalledWith({ active: false });
    expect(res.body).toEqual({ ok: true, deactivated: 1 });
  });

  test('refuses a malformed token or a missing sign-up id before any write', async () => {
    for (const body of [{ token: 'nope', reg: 'reg-0001' }, { token: TOKEN }]) {
      const res = response();
      await nativeUnsubscribe(request(body), res, jest.fn());
      expect(res.statusCode).toBe(400);
    }
    expect(db).not.toHaveBeenCalled();
  });
});
