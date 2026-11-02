// "Send to Claude" on the route (GATE_ALERT_SEND_TO_CLAUDE): POST /:id/send-to-claude reaches the sender only for an
// admin, with a well-formed id and version, while both gates are on (off answers 404 like an unknown route). The sender
// itself is admin-alert-send-to-claude.test.js.
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/notification-service', () => ({ getAdminNotifications: jest.fn(async () => []) }));
jest.mock('../services/push-notifications', () => ({ status: jest.fn(() => ({ available: true, configured: true })) }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn(async () => ({ alerts: [] })) }));
jest.mock('../services/notification-bell-policy', () => ({ isBellPolicyEnabled: () => true }));
jest.mock('../services/admin-unread', () => ({
  liveAlertNotifications: jest.fn(async () => ({ live: [], liveKeys: new Set() })),
  isLiveDuplicate: () => false,
  getUnreadCountForAdmin: jest.fn(),
}));
jest.mock('../services/admin-alert-buttons', () => ({ withAlertButtons: jest.fn(async (rows) => rows), runAlertButton: jest.fn() }));
jest.mock('../services/admin-alert-explainer', () => ({
  explainerLive: jest.fn(() => true),
  withExplainerFields: jest.fn(async (rows) => rows),
  explainAdminAlert: jest.fn(),
}));
jest.mock('../services/admin-alert-send-to-claude', () => ({
  sendToClaudeLive: jest.fn(() => true),
  sendAdminAlertToClaude: jest.fn(async () => ({ status: 200, body: { sent: true, message: 'Sent to Claude.' } })),
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

const { explainerLive } = require('../services/admin-alert-explainer');
const { sendToClaudeLive, sendAdminAlertToClaude } = require('../services/admin-alert-send-to-claude');
const router = require('../routes/admin-notifications');

const ID = '00000000-0000-4000-8000-0000000000f1';
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

const send = (base, { who = 'admin', id = ID, body = { version: VERSION } } = {}) => fetch(`${base}/admin/notifications/${id}/send-to-claude`, {
  method: 'POST', headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  jest.clearAllMocks();
  explainerLive.mockReturnValue(true);
  sendToClaudeLive.mockReturnValue(true);
});

test('an admin send reaches the sender with the version (lower case), the sender and the caller\'s scope', async () => {
  await withServer(async (base) => {
    const res = await send(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, message: 'Sent to Claude.' });
  });
  expect(sendAdminAlertToClaude).toHaveBeenCalledWith(ID, { version: 'a'.repeat(32), by: 'admin-1', role: 'admin', technicianId: 'admin-1' });
});

test('the sender\'s own status comes back as it is', async () => {
  sendAdminAlertToClaude.mockResolvedValueOnce({ status: 422, body: { error: 'customer_contact' } });
  await withServer(async (base) => {
    const res = await send(base);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'customer_contact' });
  });
});

test.each([['the send gate', sendToClaudeLive], ['the explainer gate', explainerLive]])('%s off: 404 and no send', async (_label, reader) => {
  reader.mockReturnValue(false);
  await withServer(async (base) => {
    expect((await send(base)).status).toBe(404);
  });
  expect(sendAdminAlertToClaude).not.toHaveBeenCalled();
});

test('a technician is refused; a malformed id or a missing version is a 400; none reaches the sender', async () => {
  await withServer(async (base) => {
    expect((await send(base, { who: 'tech' })).status).toBe(403);
    expect((await send(base, { id: 'live:overdue-invoices' })).status).toBe(400);
    expect((await send(base, { body: {} })).status).toBe(400);
    expect((await send(base, { body: { version: 'not-a-version' } })).status).toBe(400);
  });
  expect(sendAdminAlertToClaude).not.toHaveBeenCalled();
});
