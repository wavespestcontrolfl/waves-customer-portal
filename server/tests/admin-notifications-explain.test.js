// The bell's "What to do" on the route (GATE_ALERT_EXPLAINER): the list passes its rows through withExplainerFields
// with the caller's role, and POST /:id/explain reaches the explainer only for an admin, with a well-formed id, while
// the gate is on (off answers 404 like an unknown route). The explainer itself is admin-alert-explainer.test.js.
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  getAdminNotifications: jest.fn(async () => [{ id: '00000000-0000-4000-8000-0000000000a1', title: 'Accepted recurring plan needs schedule review', created_at: '2026-11-02T12:00:00Z' }]),
}));
jest.mock('../services/push-notifications', () => ({ status: jest.fn(() => ({ available: true, configured: true })) }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn(async () => ({ alerts: [] })) }));
jest.mock('../services/notification-bell-policy', () => ({ isBellPolicyEnabled: () => true }));
jest.mock('../services/admin-unread', () => ({
  liveAlertNotifications: jest.fn(async () => ({ live: [], liveKeys: new Set() })),
  isLiveDuplicate: () => false,
  getUnreadCountForAdmin: jest.fn(),
}));
jest.mock('../services/admin-alert-buttons', () => ({
  withAlertButtons: jest.fn(async (rows) => rows),
  runAlertButton: jest.fn(),
}));
jest.mock('../services/admin-alert-explainer', () => ({
  explainerLive: jest.fn(() => true),
  withExplainerFields: jest.fn(async (rows) => rows.map((row) => ({ ...row, explainable: true, customer: { id: null, name: 'Jane Doe' } }))),
  explainAdminAlert: jest.fn(async () => ({ status: 200, body: { explainer: { happened: 'It happened.', steps: ['Open it.'], fixer: 'you' }, customer: null } })),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
    const user = users[String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));

const { explainerLive, withExplainerFields, explainAdminAlert } = require('../services/admin-alert-explainer');
const router = require('../routes/admin-notifications');

const ID = '00000000-0000-4000-8000-0000000000a1';

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/notifications', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const explain = (base, { who = 'admin', id = ID } = {}) => fetch(`${base}/admin/notifications/${id}/explain`, {
  method: 'POST', headers: { Authorization: `Bearer ${who}` },
});

beforeEach(() => {
  jest.clearAllMocks();
  explainerLive.mockReturnValue(true);
});

test('the bell list passes its rows through withExplainerFields with the caller\'s role', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/admin/notifications?limit=30`, { headers: { Authorization: 'Bearer admin' } });
    expect(res.status).toBe(200);
    expect((await res.json()).notifications[0]).toEqual(expect.objectContaining({ id: ID, explainable: true, customer: { id: null, name: 'Jane Doe' } }));
  });
  expect(withExplainerFields).toHaveBeenCalledWith([expect.objectContaining({ id: ID })], { role: 'admin' });
});

test('an admin open reaches the explainer with the row and the caller\'s scope, and gets its answer back', async () => {
  await withServer(async (base) => {
    const res = await explain(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ explainer: { happened: 'It happened.', steps: ['Open it.'], fixer: 'you' }, customer: null });
  });
  expect(explainAdminAlert).toHaveBeenCalledWith(ID, { role: 'admin', technicianId: 'admin-1' });
});

test('the explainer\'s own status comes back as it is', async () => {
  explainAdminAlert.mockResolvedValueOnce({ status: 404, body: { error: 'not_found' } });
  await withServer(async (base) => {
    const res = await explain(base);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

test('gate off: 404 and no explain', async () => {
  explainerLive.mockReturnValue(false);
  await withServer(async (base) => {
    expect((await explain(base)).status).toBe(404);
  });
  expect(explainAdminAlert).not.toHaveBeenCalled();
});

test('a technician is refused and a malformed id is a 400; neither reaches the explainer', async () => {
  await withServer(async (base) => {
    expect((await explain(base, { who: 'tech' })).status).toBe(403);
    expect((await explain(base, { id: 'live:overdue-invoices' })).status).toBe(400);
  });
  expect(explainAdminAlert).not.toHaveBeenCalled();
});
