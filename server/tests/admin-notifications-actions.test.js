// The bell's row buttons on the route (docs/admin-notifications.md section 2, part 9): the list serves them
// through withAlertButtons with the caller's role, and a tap reaches runAlertButton only from an admin, with
// a well-formed id and the row's version. The runner itself is admin-alert-buttons.test.js.
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  getAdminNotifications: jest.fn(async () => [{ id: '00000000-0000-4000-8000-0000000000a1', title: 'Customers — confirm Ames Fenn\'s referrer', created_at: '2026-10-29T12:00:00Z' }]),
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
  withAlertButtons: jest.fn((rows) => rows.map((row) => ({ ...row, actions: [{ id: 'dismiss', label: 'Not a referral' }] }))),
  runAlertButton: jest.fn(async () => ({ status: 200, body: { success: true, message: 'Ames Fenn is marked not a referral.' } })),
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

const { withAlertButtons, runAlertButton } = require('../services/admin-alert-buttons');
const router = require('../routes/admin-notifications');

const ID = '00000000-0000-4000-8000-0000000000a1';
const VERSION = 'A'.repeat(32);

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

const tap = (base, { who = 'admin', id = ID, action = 'dismiss', body = { version: VERSION } } = {}) => fetch(`${base}/admin/notifications/${id}/actions/${action}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => jest.clearAllMocks());

test('the bell list passes its rows through withAlertButtons with the caller\'s role', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/admin/notifications?limit=30`, { headers: { Authorization: 'Bearer tech' } });
    expect(res.status).toBe(200);
    expect((await res.json()).notifications[0].actions).toEqual([{ id: 'dismiss', label: 'Not a referral' }]);
  });
  expect(withAlertButtons).toHaveBeenCalledWith([expect.objectContaining({ id: ID })], { role: 'technician' });
});

test('an admin tap reaches the runner with the row, the button, the lower-cased version and the tapper', async () => {
  await withServer(async (base) => {
    const res = await tap(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: 'Ames Fenn is marked not a referral.' });
  });
  expect(runAlertButton).toHaveBeenCalledWith({ notificationId: ID, actionId: 'dismiss', version: 'a'.repeat(32), technicianId: 'admin-1', role: 'admin' });
});

test('the runner\'s refusal comes back with its own status and words', async () => {
  runAlertButton.mockResolvedValueOnce({ status: 409, body: { error: 'first_visit_done', message: 'Confirm the referrer in Referrals → Queue.' } });
  await withServer(async (base) => {
    const res = await tap(base, { action: 'confirm' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'first_visit_done', message: 'Confirm the referrer in Referrals → Queue.' });
  });
});

test.each([
  ['a technician', { who: 'tech' }, 403],
  ['no login', { who: 'nobody' }, 401],
  ['an id that is not a uuid', { id: 'live:ar_overdue_60' }, 400],
  ['no version', { body: {} }, 400],
  ['a version that is not the served hash', { body: { version: 'abc' } }, 400],
])('%s runs nothing', async (_name, opts, status) => {
  await withServer(async (base) => {
    expect((await tap(base, opts)).status).toBe(status);
  });
  expect(runAlertButton).not.toHaveBeenCalled();
});
