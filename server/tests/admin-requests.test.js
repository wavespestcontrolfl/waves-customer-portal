process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({
  sendRequestUpdated: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin', email: 'owner@example.com', name: 'Owner' },
      tech: { id: 'tech-1', role: 'technician', email: 'tech@example.com', name: 'Tech' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Access denied' })
  ),
}));

const express = require('express');
const db = require('../models/db');
const AccountMembershipEmail = require('../services/account-membership-email');
const requestsRouter = require('../routes/admin-requests');

function makeChain(result = {}) {
  const chain = {};
  ['leftJoin', 'select', 'where', 'whereRaw', 'orderBy', 'limit', 'offset', 'update', 'count'].forEach((m) => {
    chain[m] = jest.fn(() => chain);
  });
  chain.first = jest.fn(async () => result.first);
  chain.returning = jest.fn(async () => result.returning || []);
  chain.then = (resolve, reject) => Promise.resolve(result.rows || []).then(resolve, reject);
  chain.catch = (reject) => Promise.resolve(result.rows || []).catch(reject);
  return chain;
}

function setDb(queues) {
  const map = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = map.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/requests', requestsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('admin requests routes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects unauthenticated callers', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/requests`);
      expect(res.status).toBe(401);
    });
  });

  test('lists service requests for a technician', async () => {
    setDb({
      service_requests: [
        makeChain({ rows: [{ id: 'req-1', status: 'new', subject: 'Ants in kitchen' }] }),
        makeChain({ first: { count: '1' } }),
      ],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/requests`, { headers: { Authorization: 'Bearer tech' } });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.requests).toEqual([{ id: 'req-1', status: 'new', subject: 'Ants in kitchen' }]);
      expect(body.total).toBe(1);
    });
  });

  test('status change updates the request and emails the customer', async () => {
    const existing = { id: 'req-1', customer_id: 'cust-1', status: 'new', resolved_at: null };
    const updated = { ...existing, status: 'acknowledged', updated_at: new Date() };
    setDb({
      service_requests: [
        makeChain({ first: existing }),
        makeChain({ returning: [updated] }),
      ],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/requests/req-1`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'acknowledged' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.statusChanged).toBe(true);
      expect(AccountMembershipEmail.sendRequestUpdated).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        request: updated,
        statusLabel: 'Acknowledged',
      }));
    });
  });

  test('no email when the status is unchanged', async () => {
    const existing = { id: 'req-1', customer_id: 'cust-1', status: 'acknowledged', resolved_at: null };
    setDb({
      service_requests: [
        makeChain({ first: existing }),
        makeChain({ returning: [{ ...existing, admin_notes: 'called customer' }] }),
      ],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/requests/req-1`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'acknowledged', adminNotes: 'called customer' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.statusChanged).toBe(false);
      expect(AccountMembershipEmail.sendRequestUpdated).not.toHaveBeenCalled();
    });
  });

  test('resolving stamps resolved_at', async () => {
    const existing = { id: 'req-1', customer_id: 'cust-1', status: 'scheduled', resolved_at: null };
    const updateChain = makeChain({ returning: [{ ...existing, status: 'resolved' }] });
    setDb({ service_requests: [makeChain({ first: existing }), updateChain] });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/requests/req-1`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      });
      expect(res.status).toBe(200);
      const patch = updateChain.update.mock.calls[0][0];
      expect(patch.status).toBe('resolved');
      expect(patch.resolved_at).toBeInstanceOf(Date);
    });
  });

  test('concurrent status change that loses the race does not re-notify', async () => {
    // A second writer reads status "new" but another writer already flipped it,
    // so the conditional update matches zero rows. We re-read and report no
    // change instead of sending a duplicate email.
    const existing = { id: 'req-1', customer_id: 'cust-1', status: 'new', resolved_at: null };
    const current = { ...existing, status: 'acknowledged' };
    setDb({
      service_requests: [
        makeChain({ first: existing }),     // initial read sees 'new'
        makeChain({ returning: [] }),        // conditional update matches nothing
        makeChain({ first: current }),       // re-read shows the winner's row
      ],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/requests/req-1`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'acknowledged' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.statusChanged).toBe(false);
      expect(body.request).toEqual(current);
      expect(AccountMembershipEmail.sendRequestUpdated).not.toHaveBeenCalled();
    });
  });

  test('404 when the request does not exist', async () => {
    setDb({ service_requests: [makeChain({ first: undefined })] });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/requests/missing`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'acknowledged' }),
      });
      expect(res.status).toBe(404);
      expect(AccountMembershipEmail.sendRequestUpdated).not.toHaveBeenCalled();
    });
  });

  test('rejects an invalid status and an empty patch', async () => {
    await withServer(async (baseUrl) => {
      const bad = await fetch(`${baseUrl}/admin/requests/req-1`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'banana' }),
      });
      expect(bad.status).toBe(400);

      const empty = await fetch(`${baseUrl}/admin/requests/req-1`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);
    });
  });
});
