/**
 * Regression guards for APNs/FCM awareness in:
 *   - POST /api/admin/push/test (must not 503 when APNs or FCM is configured without VAPID)
 *   - GET /api/admin/push/diagnostics (surfaces apns_configured & fcm_configured)
 *   - GET /api/admin/notifications/diagnose (reports APNs/FCM transport health + per-platform subs)
 */
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/push-notifications', () => ({
  status: jest.fn(),
  sendToAdminUser: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 1;
    req.techRole = 'admin';
    req.technician = { id: 1, email: 'contact@wavespestcontrol.com' };
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  staffTokenVersionMatches: () => true,
}));

const db = require('../models/db');
const PushService = require('../services/push-notifications');
const adminPushRouter = require('../routes/admin-push');
const adminNotificationsRouter = require('../routes/admin-notifications');

function chain(result) {
  const c = {};
  for (const m of ['where', 'whereNull', 'whereNotNull', 'whereRaw', 'whereIn', 'orderBy', 'limit', 'select', 'count']) {
    c[m] = jest.fn(() => c);
  }
  c.first = jest.fn(async () => (Array.isArray(result) ? result[0] : result));
  c.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return c;
}

async function withApp(router, mountPath, fn) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql) => sql);
});

describe('POST /api/admin/push/test transport gating', () => {
  test('allows test push when APNs is configured even if Web Push VAPID is not', async () => {
    PushService.status.mockReturnValue({
      available: true,
      configured: false,
      error: null,
      apns: { configured: true, production: true },
      fcm: { configured: false },
    });
    PushService.sendToAdminUser.mockResolvedValue({ sent: 1, subscriptions: 1 });

    await withApp(adminPushRouter, '/api/admin/push', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/push/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.sent).toBe(1);
    });
  });

  test('returns 503 only when Web Push, APNs, and FCM are all unconfigured', async () => {
    PushService.status.mockReturnValue({
      available: false,
      configured: false,
      error: null,
      apns: { configured: false },
      fcm: { configured: false },
    });

    await withApp(adminPushRouter, '/api/admin/push', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/push/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      expect(res.status).toBe(503);
      expect(json.ok).toBe(false);
    });
    expect(PushService.sendToAdminUser).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/notifications/diagnose APNs/FCM reporting', () => {
  test('reports APNs/FCM checks, per-platform subscription counts, and healthy summary when APNs is live without VAPID', async () => {
    PushService.status.mockReturnValue({
      available: true,
      configured: false,
      error: null,
      apns: { configured: true, production: true },
      fcm: { configured: false },
    });
    db.mockImplementation((table) => {
      if (table === 'technicians') return chain([{ id: 1, active: true, name: 'Synthetic Admin' }]);
      if (table === 'push_subscriptions') {
        return chain([
          { id: 's1', active: true, platform: 'ios' },
          { id: 's2', active: true, platform: 'web' },
          { id: 's3', active: false, platform: 'android' },
        ]);
      }
      if (table === 'notification_preferences') return chain([]);
      if (table === 'notifications') return chain([{ c: '5' }]);
      return chain([]);
    });

    await withApp(adminNotificationsRouter, '/api/admin/notifications', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/notifications/diagnose`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.checks.apns).toMatchObject({ ok: true, configured: true });
      expect(json.checks.fcm).toMatchObject({ ok: false, configured: false });
      expect(json.checks.pushTransport).toEqual({ ok: true, vapid: false, apns: true, fcm: false });
      expect(json.checks.pushSubscriptions).toMatchObject({
        ok: true,
        total: 3,
        active: 2,
        inactive: 1,
        byPlatform: { web: 1, ios: 1, android: 0 },
      });
      expect(json.summary).toEqual([]);
    });
  });

  test('flags pushTransport in summary when no transport is configured', async () => {
    PushService.status.mockReturnValue({
      available: false,
      configured: false,
      error: null,
      apns: { configured: false },
      fcm: { configured: false },
    });
    db.mockImplementation((table) => {
      if (table === 'technicians') return chain([{ id: 1, active: true, name: 'Synthetic Admin' }]);
      if (table === 'push_subscriptions') return chain([{ id: 's1', active: true, platform: 'ios' }]);
      if (table === 'notification_preferences') return chain([]);
      if (table === 'notifications') return chain([{ c: '2' }]);
      return chain([]);
    });

    await withApp(adminNotificationsRouter, '/api/admin/notifications', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/notifications/diagnose`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.checks.pushTransport.ok).toBe(false);
      expect(json.summary).toContain('pushTransport');
    });
  });
});
