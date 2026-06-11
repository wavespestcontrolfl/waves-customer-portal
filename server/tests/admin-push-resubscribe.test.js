/**
 * POST /admin/push/resubscribe — endpoint rotation called by the service
 * worker's pushsubscriptionchange handler (client/public/sw.js).
 *
 * The SW context has no admin JWT, so the route sits above the auth gate
 * and authenticates by possession of the OLD subscription endpoint (an
 * unguessable per-device URL). Contract under test:
 *   1. Rotates the matching row in place (new subscription_data, active).
 *   2. Matches by exact jsonb endpoint equality — never LIKE, so wildcard
 *      payloads can't match arbitrary rows.
 *   3. Returns the same { ok: true } whether or not a row matched (no
 *      existence oracle), and can never INSERT a row.
 *   4. Rejects malformed payloads (missing fields, old === new endpoint).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ listTriggers: jest.fn(() => []) }));
jest.mock('../services/push-notifications', () => ({
  status: jest.fn(() => ({ available: true, configured: true })),
  sendToAdminUser: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, res) => res.status(401).json({ error: 'Admin authentication required' }),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const adminPushRouter = require('../routes/admin-push');

const OLD_ENDPOINT = 'https://web.push.apple.com/old-device-token';
const NEW_SUBSCRIPTION = {
  endpoint: 'https://web.push.apple.com/new-device-token',
  keys: { p256dh: 'new-p256dh', auth: 'new-auth' },
};

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/push', adminPushRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockPushSubscriptionsTable({ rows = [] } = {}) {
  const calls = { whereRawArgs: null, update: null, insert: null };
  db.mockImplementation((table) => {
    if (table !== 'push_subscriptions') throw new Error(`Unexpected db table ${table}`);
    const q = {
      whereRaw: jest.fn((sql, bindings) => {
        calls.whereRawArgs = { sql, bindings };
        return q;
      }),
      select: jest.fn(() => Promise.resolve(rows)),
      whereIn: jest.fn(() => q),
      update: jest.fn((patch) => {
        calls.update = patch;
        return Promise.resolve(rows.length);
      }),
      insert: jest.fn(() => {
        calls.insert = true;
        return Promise.resolve([]);
      }),
    };
    return q;
  });
  return calls;
}

describe('POST /admin/push/resubscribe', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rotates a matching row in place and reactivates it', async () => {
    const calls = mockPushSubscriptionsTable({ rows: [{ id: 'sub-1' }] });

    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/push/resubscribe', {
        oldEndpoint: OLD_ENDPOINT,
        subscription: NEW_SUBSCRIPTION,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    // Exact jsonb equality on the endpoint — a LIKE here would let a
    // %-wildcard oldEndpoint match (and overwrite) arbitrary rows.
    expect(calls.whereRawArgs.sql).toContain("->>'endpoint' = ?");
    expect(calls.whereRawArgs.bindings).toEqual([OLD_ENDPOINT]);
    expect(calls.update).toEqual({
      subscription_data: JSON.stringify(NEW_SUBSCRIPTION),
      active: true,
    });
    expect(calls.insert).toBeNull();
  });

  test('unknown old endpoint: same ok response, no write, no insert', async () => {
    const calls = mockPushSubscriptionsTable({ rows: [] });

    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/push/resubscribe', {
        oldEndpoint: OLD_ENDPOINT,
        subscription: NEW_SUBSCRIPTION,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    expect(calls.update).toBeNull();
    expect(calls.insert).toBeNull();
  });

  test.each([
    ['missing oldEndpoint', { subscription: NEW_SUBSCRIPTION }],
    ['missing subscription', { oldEndpoint: OLD_ENDPOINT }],
    ['subscription without endpoint', { oldEndpoint: OLD_ENDPOINT, subscription: { keys: {} } }],
    ['old endpoint equals new endpoint', { oldEndpoint: NEW_SUBSCRIPTION.endpoint, subscription: NEW_SUBSCRIPTION }],
  ])('rejects %s with 400 before touching the db', async (_label, body) => {
    const calls = mockPushSubscriptionsTable({ rows: [{ id: 'sub-1' }] });

    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/push/resubscribe', body);
      expect(res.status).toBe(400);
    });

    expect(calls.whereRawArgs).toBeNull();
    expect(calls.update).toBeNull();
  });

  test('subscribe remains behind the auth gate', async () => {
    mockPushSubscriptionsTable({ rows: [] });

    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/push/subscribe', { subscription: NEW_SUBSCRIPTION });
      expect(res.status).toBe(401);
    });
  });
});
