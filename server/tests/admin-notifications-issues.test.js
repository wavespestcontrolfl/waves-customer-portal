const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/notification-service', () => ({
  getAdminNotifications: jest.fn(async () => []),
  getAdminUnreadCount: jest.fn(async () => 0),
  markAllReadAdmin: jest.fn(async () => true),
  markRead: jest.fn(async () => true),
}));
jest.mock('../services/push-notifications', () => ({
  status: jest.fn(() => ({ available: true, configured: true })),
}));
jest.mock('../services/dashboard-alerts', () => ({
  computeDashboardAlerts: jest.fn(async () => ({ alerts: [] })),
  toNotifications: jest.fn((alerts) => alerts),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[token];
    if (!user) {
      return res.status(401).json({ error: 'Admin authentication required' });
    }
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const db = require('../models/db');
const adminNotificationsRouter = require('../routes/admin-notifications');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/notifications', adminNotificationsRouter);
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

function queryChain(result = []) {
  const query = {};
  ['where', 'orderBy', 'limit', 'select'].forEach((method) => {
    query[method] = jest.fn(() => query);
  });
  query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  query.catch = (reject) => Promise.resolve(result).catch(reject);
  return query;
}

describe('admin notification issues route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn(async () => true) };
  });

  test('requires admin authentication', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/notifications/issues`);

      expect(res.status).toBe(401);
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('requires an admin role', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/notifications/issues`, {
        headers: { Authorization: 'Bearer tech' },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Admin access required' });
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('lists recent internal admin alert delivery issues', async () => {
    const auditRows = [
      {
        id: 'audit-1',
        created_at: '2026-05-26T02:40:00.000Z',
        metadata: {
          outcome: 'undelivered',
          message_type: 'internal_alert',
          to_masked: '***3489',
          body_length: 22,
          title: 'New lead fallback path',
          link: '/admin/leads',
          reason: 'notification_redirect_undelivered',
          stats: { bellWritten: false, push: { sent: 0 } },
          body: 'should not be returned',
        },
      },
    ];
    const auditQuery = queryChain(auditRows);
    db.mockImplementation((table) => {
      if (table === 'audit_log') return auditQuery;
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/notifications/issues?limit=10`, {
        headers: { Authorization: 'Bearer admin' },
      });

      expect(res.status).toBe(200);
      expect(db.schema.hasTable).toHaveBeenCalledWith('audit_log');
      expect(db).toHaveBeenCalledWith('audit_log');
      expect(auditQuery.where).toHaveBeenCalledWith({
        action: 'notification.internal_admin_alert.delivery_issue',
      });
      expect(auditQuery.orderBy).toHaveBeenCalledWith('created_at', 'desc');
      expect(auditQuery.limit).toHaveBeenCalledWith(10);
      expect(auditQuery.select).toHaveBeenCalledWith('id', 'metadata', 'created_at');
      expect(await res.json()).toEqual({
        issues: [
          {
            id: 'audit-1',
            created_at: '2026-05-26T02:40:00.000Z',
            outcome: 'undelivered',
            message_type: 'internal_alert',
            to_masked: '***3489',
            body_length: 22,
            title: 'New lead fallback path',
            link: '/admin/leads',
            reason: 'notification_redirect_undelivered',
            stats: { bellWritten: false, push: { sent: 0 } },
          },
        ],
      });
    });
  });

  test('parses string metadata and clamps issue limit to a positive integer', async () => {
    const auditQuery = queryChain([
      {
        id: 'audit-2',
        created_at: '2026-05-26T03:00:00.000Z',
        metadata: JSON.stringify({ outcome: 'error', reason: 'db_failed' }),
      },
    ]);
    db.mockReturnValue(auditQuery);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/notifications/issues?limit=-5`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(auditQuery.limit).toHaveBeenCalledWith(1);
      expect(body.issues).toEqual([
        {
          id: 'audit-2',
          created_at: '2026-05-26T03:00:00.000Z',
          outcome: 'error',
          message_type: null,
          to_masked: null,
          body_length: null,
          title: null,
          link: null,
          reason: 'db_failed',
          stats: null,
        },
      ]);
    });
  });

  test('returns no issues when audit log table is missing', async () => {
    db.schema.hasTable.mockResolvedValue(false);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/notifications/issues`, {
        headers: { Authorization: 'Bearer admin' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ issues: [] });
      expect(db).not.toHaveBeenCalled();
    });
  });
});
