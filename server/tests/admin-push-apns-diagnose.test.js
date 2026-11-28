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
      if (table === 'technicians') return chain([{ id: 1, active: true, role: 'admin', auth_token_version: 2, name: 'Synthetic Admin' }]);
      if (table === 'push_subscriptions') {
        return chain([
          { id: 's1', active: true, platform: 'ios', staff_token_version: 2 },
          { id: 's2', active: true, platform: 'web', staff_token_version: 2 },
          { id: 's3', active: false, platform: 'android', staff_token_version: 2 },
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
      expect(json.checks.pushTransportMatch).toMatchObject({ ok: true, active: 2, eligible: 2, reachable: 1 });
      expect(json.summary).toEqual([]);
    });
  });

  test('excludes stale token-version and non-MFA staff devices from reachable count while preserving raw totals', async () => {
    PushService.status.mockReturnValue({
      available: true,
      configured: false,
      error: null,
      apns: { configured: true, production: true },
      fcm: { configured: false },
    });
    // Stale staff_token_version: raw active=1, eligible=0, reachable=0 -> flagged in summary.
    db.mockImplementation((table) => {
      if (table === 'technicians') return chain([{ id: 1, active: true, role: 'admin', auth_token_version: 3, name: 'Stale Session Admin' }]);
      if (table === 'push_subscriptions') return chain([{ id: 's-ios', active: true, platform: 'ios', staff_token_version: 2 }]);
      if (table === 'notification_preferences') return chain([]);
      if (table === 'notifications') return chain([{ c: '3' }]);
      return chain([]);
    });
    await withApp(adminNotificationsRouter, '/api/admin/notifications', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/notifications/diagnose`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.checks.pushSubscriptions).toMatchObject({ ok: true, active: 1, byPlatform: { ios: 1, web: 0, android: 0 } });
      expect(json.checks.pushTransportMatch).toMatchObject({ ok: false, active: 1, eligible: 0, reachable: 0 });
      expect(json.summary).toContain('pushTransportMatch');
    });

    // Under GATE_ADMIN_MFA=true, an MFA-enrolled admin's non-MFA subscription is ineligible.
    const prevMfa = process.env.GATE_ADMIN_MFA;
    process.env.GATE_ADMIN_MFA = 'true';
    try {
      db.mockImplementation((table) => {
        if (table === 'technicians') {
          return chain([{ id: 1, active: true, role: 'admin', auth_token_version: 3, mfa_enabled_at: '2026-11-01T00:00:00Z', name: 'MFA Admin' }]);
        }
        if (table === 'push_subscriptions') return chain([{ id: 's-ios', active: true, platform: 'ios', staff_token_version: 3, staff_mfa: false }]);
        if (table === 'notification_preferences') return chain([]);
        if (table === 'notifications') return chain([{ c: '3' }]);
        return chain([]);
      });
      await withApp(adminNotificationsRouter, '/api/admin/notifications', async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/notifications/diagnose`);
        const json = await res.json();
        expect(res.status).toBe(200);
        expect(json.checks.pushSubscriptions).toMatchObject({ ok: true, active: 1 });
        expect(json.checks.pushTransportMatch).toMatchObject({ ok: false, active: 1, eligible: 0, reachable: 0 });
        expect(json.summary).toContain('pushTransportMatch');
      });
    } finally {
      if (prevMfa === undefined) delete process.env.GATE_ADMIN_MFA;
      else process.env.GATE_ADMIN_MFA = prevMfa;
    }
  });

  test('flags pushTransportMatch in summary when active subscriptions have no matching configured transport', async () => {
    PushService.status.mockReturnValue({
      available: true,
      configured: false,
      error: null,
      apns: { configured: true, production: true },
      fcm: { configured: false },
    });
    db.mockImplementation((table) => {
      if (table === 'technicians') return chain([{ id: 1, active: true, name: 'Web Only Admin' }]);
      if (table === 'push_subscriptions') return chain([{ id: 's-web', active: true, platform: 'web' }]);
      if (table === 'notification_preferences') return chain([]);
      if (table === 'notifications') return chain([{ c: '3' }]);
      return chain([]);
    });

    await withApp(adminNotificationsRouter, '/api/admin/notifications', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/notifications/diagnose`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.checks.pushTransport.ok).toBe(true);
      expect(json.checks.pushTransportMatch).toMatchObject({ ok: false, active: 1, reachable: 0 });
      expect(json.summary).toContain('pushTransportMatch');
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

  test('excludes category:* bell-policy rows from disabledTriggers while still flagging muted trigger keys', async () => {
    PushService.status.mockReturnValue({
      available: true,
      configured: false,
      error: null,
      apns: { configured: true, production: true },
      fcm: { configured: false },
    });
    db.mockImplementation((table) => {
      if (table === 'technicians') return chain([{ id: 1, active: true, name: 'Admin' }]);
      if (table === 'push_subscriptions') return chain([{ id: 's1', active: true, platform: 'ios' }]);
      if (table === 'notification_preferences') {
        return chain([
          { trigger_key: 'category:billing', bell_enabled: false, push_enabled: true, sound_enabled: true },
          { trigger_key: 'category:marketing', bell_enabled: false, push_enabled: true, sound_enabled: true },
          { trigger_key: 'inbound_sms', bell_enabled: true, push_enabled: true, sound_enabled: true },
        ]);
      }
      if (table === 'notifications') return chain([{ c: '2' }]);
      return chain([]);
    });

    await withApp(adminNotificationsRouter, '/api/admin/notifications', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/notifications/diagnose`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.checks.preferences).toEqual({
        ok: true,
        totalRows: 1,
        disabledTriggers: [],
      });
      expect(json.summary).not.toContain('preferences');
    });

    // Real trigger rows with push/bell disabled are still flagged.
    db.mockImplementation((table) => {
      if (table === 'technicians') return chain([{ id: 1, active: true, name: 'Admin' }]);
      if (table === 'push_subscriptions') return chain([{ id: 's1', active: true, platform: 'ios' }]);
      if (table === 'notification_preferences') {
        return chain([
          { trigger_key: 'category:billing', bell_enabled: false, push_enabled: true, sound_enabled: true },
          { trigger_key: 'inbound_sms', bell_enabled: true, push_enabled: false, sound_enabled: true },
        ]);
      }
      if (table === 'notifications') return chain([{ c: '2' }]);
      return chain([]);
    });

    await withApp(adminNotificationsRouter, '/api/admin/notifications', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/notifications/diagnose`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.checks.preferences.ok).toBe(false);
      expect(json.checks.preferences.disabledTriggers).toEqual([
        { trigger_key: 'inbound_sms', bell_enabled: true, push_enabled: false, sound_enabled: true },
      ]);
      expect(json.summary).toContain('preferences');
    });
  });
});
