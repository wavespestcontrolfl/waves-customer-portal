/**
 * GATE_PORTAL_INBOX mark-handled hooks on the two EXISTING update routes:
 *   PUT   /api/ai/admin/escalations/:id  (chat hand-off)
 *   PATCH /api/admin/requests/:id        (service request)
 * Gate on: finishing the item also closes its open admin bell alerts.
 * Gate off: the routes behave as before (no alert lookup, no close).
 * Also pins the escalation route's hardening: 404 for a missing row and 400 for
 * an unknown status (both gate on or off).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn().mockResolvedValue(true) };
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/ai-assistant/assistant', () => ({ processMessage: jest.fn() }));
jest.mock('../services/ai-assistant/portal-turn', () => ({
  portalConversationIdentifier: (identifier) => identifier,
  runPortalTurn: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/call-route-decisions', () => ({ preferredRouteDecisionForFeedback: jest.fn() }));
jest.mock('../services/heic-to-jpeg', () => ({ convertHeicToJpeg: jest.fn(), MAX_HEIC_BYTES: 5 * 1024 * 1024 }));
jest.mock('../services/account-membership-email', () => ({
  sendRequestUpdated: jest.fn(() => Promise.resolve({ ok: true })),
}));
const mockMarkAdminDone = jest.fn(async (ids) => [].concat(ids).length);
jest.mock('../services/notification-service', () => ({
  markAdminDone: (...args) => mockMarkAdminDone(...args),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.technicianId = 'tech-admin-1';
    req.techRole = 'admin';
    next();
  },
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const AccountMembershipEmail = require('../services/account-membership-email');
const aiRouter = require('../routes/ai-assistant');
const requestsRouter = require('../routes/admin-requests');

const ESC_ID = '22222222-2222-4222-8222-222222222222';
const REQ_ID = '33333333-3333-4333-8333-333333333333';

function chain(result = {}) {
  const c = {};
  ['where', 'whereNull', 'whereIn', 'update', 'orderBy'].forEach((m) => { c[m] = jest.fn(() => c); });
  c.first = jest.fn(async () => result.first);
  c.returning = jest.fn(async () => result.returning || []);
  c.pluck = jest.fn(async () => result.pluck || []);
  c.then = (resolve, reject) => Promise.resolve(result.rows || 1).then(resolve, reject);
  return c;
}

function setDb(tables) {
  const map = new Map(Object.entries(tables));
  db.mockImplementation((table) => {
    const queue = map.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/ai', aiRouter);
  app.use('/requests', requestsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const send = (baseUrl, method, path, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('PUT /ai/admin/escalations/:id', () => {
  beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_PORTAL_INBOX; });
  afterAll(() => { delete process.env.GATE_PORTAL_INBOX; });

  test('answers 400 for a status the table does not use, before any write', async () => {
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PUT', `/ai/admin/escalations/${ESC_ID}`, { status: 'archived' });
      expect(res.status).toBe(400);
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('answers 404 when the escalation is missing', async () => {
    setDb({ ai_escalations: [chain({ returning: [] })] });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PUT', `/ai/admin/escalations/${ESC_ID}`, { status: 'resolved' });
      expect(res.status).toBe(404);
    });
    expect(mockMarkAdminDone).not.toHaveBeenCalled();
  });

  test('gate off: resolving closes the session as before and touches no alert', async () => {
    setDb({
      ai_escalations: [chain({ returning: [{ id: ESC_ID, conversation_id: 'conv-1', status: 'resolved' }] })],
      agent_sessions: [chain()],
    });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PUT', `/ai/admin/escalations/${ESC_ID}`, { status: 'resolved', resolution_notes: 'done' });
      expect(res.status).toBe(200);
      expect((await res.json()).escalation.id).toBe(ESC_ID);
    });
    expect(db.mock.calls.map(([t]) => t)).toEqual(['ai_escalations', 'agent_sessions']);
    expect(mockMarkAdminDone).not.toHaveBeenCalled();
  });

  test.each(['resolved', 'dismissed'])('gate on: %s closes the escalation\'s open admin alerts', async (status) => {
    process.env.GATE_PORTAL_INBOX = 'true';
    const alerts = chain({ pluck: ['alert-1', 'alert-2'] });
    setDb({
      ai_escalations: [chain({ returning: [{ id: ESC_ID, conversation_id: 'conv-1', status }] })],
      agent_sessions: [chain()],
      notifications: [alerts],
    });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PUT', `/ai/admin/escalations/${ESC_ID}`, { status });
      expect(res.status).toBe(200);
    });
    expect(alerts.whereIn).toHaveBeenCalledWith("metadata->>'escalationId'", [ESC_ID]);
    expect(mockMarkAdminDone).toHaveBeenCalledWith(
      ['alert-1', 'alert-2'],
      expect.objectContaining({ by: 'tech-admin-1', resolution: expect.stringContaining('Communications'), role: 'admin' }),
      db,
    );
  });

  test('gate on: claiming (not finishing) closes no alert', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    setDb({ ai_escalations: [chain({ returning: [{ id: ESC_ID, conversation_id: 'conv-1', status: 'claimed' }] })] });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PUT', `/ai/admin/escalations/${ESC_ID}`, { status: 'claimed', claimed_by: 'tech-admin-1' });
      expect(res.status).toBe(200);
    });
    expect(mockMarkAdminDone).not.toHaveBeenCalled();
  });
});

describe('PATCH /requests/:id', () => {
  beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_PORTAL_INBOX; delete process.env.GATE_PORTAL_ITEM_CLOSE; });
  afterAll(() => { delete process.env.GATE_PORTAL_INBOX; delete process.env.GATE_PORTAL_ITEM_CLOSE; });

  const existing = { id: REQ_ID, status: 'new', customer_id: 'cust-1', category: 'general', resolved_at: null };
  const resolved = { ...existing, status: 'resolved' };

  test('gate off: resolving still emails the customer and closes no alert', async () => {
    setDb({ service_requests: [chain({ first: existing }), chain({ returning: [resolved] })] });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, { status: 'resolved' });
      expect(res.status).toBe(200);
    });
    expect(AccountMembershipEmail.sendRequestUpdated).toHaveBeenCalledTimes(1);
    expect(mockMarkAdminDone).not.toHaveBeenCalled();
    expect(db.mock.calls.map(([t]) => t)).toEqual(['service_requests', 'service_requests']);
  });

  test('gate on: the writer that won the move to resolved closes the request\'s alerts and the email still goes', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    const alerts = chain({ pluck: ['alert-9'] });
    setDb({ service_requests: [chain({ first: existing }), chain({ returning: [resolved] })], notifications: [alerts] });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, { status: 'resolved' });
      expect(res.status).toBe(200);
    });
    expect(alerts.whereIn).toHaveBeenCalledWith("metadata->>'requestId'", [REQ_ID]);
    expect(mockMarkAdminDone).toHaveBeenCalledWith(['alert-9'], expect.objectContaining({ by: 'tech-admin-1', role: 'admin' }), db);
    expect(AccountMembershipEmail.sendRequestUpdated).toHaveBeenCalledTimes(1);
  });

  test('gate on: the loser of a concurrent transition closes nothing', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    setDb({ service_requests: [chain({ first: existing }), chain({ returning: [] }), chain({ first: resolved })] });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, { status: 'resolved' });
      expect((await res.json()).statusChanged).toBe(false);
    });
    expect(mockMarkAdminDone).not.toHaveBeenCalled();
    expect(AccountMembershipEmail.sendRequestUpdated).not.toHaveBeenCalled();
  });

  test('gate on: a move that is not to resolved closes nothing', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    setDb({ service_requests: [chain({ first: existing }), chain({ returning: [{ ...existing, status: 'acknowledged' }] })] });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, { status: 'acknowledged' });
      expect(res.status).toBe(200);
    });
    expect(mockMarkAdminDone).not.toHaveBeenCalled();
  });

  test('gate on: a failed alert close never fails the staff action', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    mockMarkAdminDone.mockRejectedValueOnce(new Error('boom'));
    setDb({ service_requests: [chain({ first: existing }), chain({ returning: [resolved] })], notifications: [chain({ pluck: ['alert-9'] })] });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, { status: 'resolved' });
      expect(res.status).toBe(200);
    });
  });

  // GATE_PORTAL_ITEM_CLOSE: the Portal tab's Mark handled says `quiet: true` and the customer gets no
  // "Your Waves request was updated" email. Customer 360 sends no `quiet`, so its email is unchanged.
  test('GATE_PORTAL_ITEM_CLOSE on + quiet: the request resolves, its alerts still close, and no customer email goes', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    process.env.GATE_PORTAL_ITEM_CLOSE = 'true';
    const alerts = chain({ pluck: ['alert-9'] });
    setDb({ service_requests: [chain({ first: existing }), chain({ returning: [resolved] })], notifications: [alerts] });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, { status: 'resolved', quiet: true });
      expect(res.status).toBe(200);
      expect((await res.json()).request.status).toBe('resolved');
    });
    expect(mockMarkAdminDone).toHaveBeenCalledWith(['alert-9'], expect.objectContaining({ by: 'tech-admin-1' }), db);
    expect(AccountMembershipEmail.sendRequestUpdated).not.toHaveBeenCalled();
  });

  test('GATE_PORTAL_ITEM_CLOSE on, no quiet (Customer 360) or quiet:false: the email still goes', async () => {
    process.env.GATE_PORTAL_ITEM_CLOSE = 'true';
    for (const body of [{ status: 'resolved' }, { status: 'resolved', quiet: false }]) {
      setDb({ service_requests: [chain({ first: existing }), chain({ returning: [resolved] })] });
      await withServer(async (baseUrl) => {
        expect((await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, body)).status).toBe(200);
      });
    }
    expect(AccountMembershipEmail.sendRequestUpdated).toHaveBeenCalledTimes(2);
  });

  test('gate off: quiet is ignored and the email goes exactly as before', async () => {
    setDb({ service_requests: [chain({ first: existing }), chain({ returning: [resolved] })] });
    await withServer(async (baseUrl) => {
      expect((await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, { status: 'resolved', quiet: true })).status).toBe(200);
    });
    expect(AccountMembershipEmail.sendRequestUpdated).toHaveBeenCalledTimes(1);
  });

  test('quiet only changes nothing: the answer an empty body always got (400), gate on or off', async () => {
    for (const gateOn of [false, true]) {
      if (gateOn) process.env.GATE_PORTAL_ITEM_CLOSE = 'true';
      await withServer(async (baseUrl) => {
        expect((await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, { quiet: true })).status).toBe(400);
        expect((await send(baseUrl, 'PATCH', `/requests/${REQ_ID}`, {})).status).toBe(400);
      });
    }
    expect(db).not.toHaveBeenCalled();
  });
});
