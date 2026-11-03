// "Send to Claude" on the route (GATE_ALERT_SEND_TO_CLAUDE alone, no explainer gate): POST /:id/send-to-claude reaches the
// sender only for an admin, with a well-formed id, version and note, and POST /:id/unsend-from-claude reaches the undo
// with a well-formed id and `at` (gate off answers 404 like an unknown route). The list marks sendable rows. The sender
// itself is admin-alert-send-to-claude.test.js.
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/notification-service', () => ({ getAdminNotifications: jest.fn(async () => []) }));
jest.mock('../services/sms-operational-actions', () => ({ withTextNoteSources: jest.fn(async (rows) => rows) }));
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
  cleanNote: jest.requireActual('../services/admin-alert-send-to-claude').cleanNote,
  withSendToClaudeFields: jest.fn((rows) => rows),
  sendAdminAlertToClaude: jest.fn(async () => ({ status: 200, body: { sent: true, at: '2026-11-03T15:00:00.000Z', message: 'Sent to Claude.' } })),
  unsendAdminAlertFromClaude: jest.fn(async () => ({ status: 200, body: { unsent: true } })),
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
const {
  sendToClaudeLive, sendAdminAlertToClaude, unsendAdminAlertFromClaude, withSendToClaudeFields,
} = require('../services/admin-alert-send-to-claude');
const NotificationService = require('../services/notification-service');
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

const AT = '2026-11-03T15:00:00.000Z';
const unsend = (base, { who = 'admin', id = ID, body = { at: AT } } = {}) => fetch(`${base}/admin/notifications/${id}/unsend-from-claude`, {
  method: 'POST', headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  jest.clearAllMocks();
  explainerLive.mockReturnValue(false);
  sendToClaudeLive.mockReturnValue(true);
});

test('an admin send reaches the sender with the version (lower case), the sender and the caller\'s scope; the answer carries the send\'s time', async () => {
  await withServer(async (base) => {
    const res = await send(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, at: AT, message: 'Sent to Claude.' });
  });
  expect(sendAdminAlertToClaude).toHaveBeenCalledWith(ID, { version: 'a'.repeat(32), by: 'admin-1', role: 'admin', technicianId: 'admin-1', note: null });
});

test('the send gate alone opens the route: the explainer gate is not needed', async () => {
  explainerLive.mockReturnValue(false);
  await withServer(async (base) => {
    expect((await send(base)).status).toBe(200);
  });
  expect(sendAdminAlertToClaude).toHaveBeenCalledTimes(1);
});

test('a note is cleaned and passed on; an empty one is no note', async () => {
  await withServer(async (base) => {
    await send(base, { body: { version: VERSION, note: '  Seen twice\u200B today\n\n\n\nPlease check.  ' } });
    await send(base, { body: { version: VERSION, note: '   ' } });
    await send(base, { body: { version: VERSION, note: 'x'.repeat(500) } });
  });
  expect(sendAdminAlertToClaude.mock.calls.map(([, o]) => o.note)).toEqual(['Seen twice today\n\nPlease check.', null, 'x'.repeat(500)]);
});

test('a note that is not text or is over 500 characters is a 400 that says why; none reaches the sender', async () => {
  await withServer(async (base) => {
    const long = await send(base, { body: { version: VERSION, note: 'x'.repeat(501) } });
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: 'note_too_long' });
    const bad = await send(base, { body: { version: VERSION, note: 42 } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_note' });
  });
  expect(sendAdminAlertToClaude).not.toHaveBeenCalled();
});

test('the sender\'s own status comes back as it is', async () => {
  sendAdminAlertToClaude.mockResolvedValueOnce({ status: 422, body: { error: 'customer_contact' } });
  await withServer(async (base) => {
    const res = await send(base);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'customer_contact' });
  });
});

test('send gate off: 404 and no send', async () => {
  sendToClaudeLive.mockReturnValue(false);
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

describe('unsend-from-claude', () => {
  test('an admin undo reaches the undo with the send\'s time and the caller\'s scope', async () => {
    await withServer(async (base) => {
      const res = await unsend(base);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ unsent: true });
    });
    expect(unsendAdminAlertFromClaude).toHaveBeenCalledWith(ID, { at: AT, by: 'admin-1', role: 'admin', technicianId: 'admin-1' });
  });

  test('the undo\'s own status comes back as it is', async () => {
    unsendAdminAlertFromClaude.mockResolvedValueOnce({ status: 409, body: { error: 'started' } });
    await withServer(async (base) => {
      const res = await unsend(base);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'started' });
    });
  });

  test('send gate off: 404 and no undo', async () => {
    sendToClaudeLive.mockReturnValue(false);
    await withServer(async (base) => {
      expect((await unsend(base)).status).toBe(404);
    });
    expect(unsendAdminAlertFromClaude).not.toHaveBeenCalled();
  });

  test('a technician is refused; a malformed id, a missing or odd `at` is a 400; none reaches the undo', async () => {
    await withServer(async (base) => {
      expect((await unsend(base, { who: 'tech' })).status).toBe(403);
      expect((await unsend(base, { id: 'live:overdue-invoices' })).status).toBe(400);
      expect((await unsend(base, { body: {} })).status).toBe(400);
      expect((await unsend(base, { body: { at: 5 } })).status).toBe(400);
      expect((await unsend(base, { body: { at: 'yesterday' } })).status).toBe(400);
    });
    expect(unsendAdminAlertFromClaude).not.toHaveBeenCalled();
  });
});

test('the bell list passes its rows through withSendToClaudeFields with the caller\'s role, whether or not the explainer is on', async () => {
  NotificationService.getAdminNotifications.mockResolvedValue([{ id: ID, version: VERSION, category: 'system', title: 't', created_at: '2026-11-03T15:00:00.000Z' }]);
  withSendToClaudeFields.mockImplementation((rows) => rows.map((r) => ({ ...r, sendToClaude: true })));
  await withServer(async (base) => {
    const res = await fetch(`${base}/admin/notifications`, { headers: { Authorization: 'Bearer admin' } });
    expect(res.status).toBe(200);
    expect((await res.json()).notifications).toEqual([expect.objectContaining({ id: ID, sendToClaude: true })]);
  });
  expect(withSendToClaudeFields).toHaveBeenCalledWith([expect.objectContaining({ id: ID })], { role: 'admin' });
});
