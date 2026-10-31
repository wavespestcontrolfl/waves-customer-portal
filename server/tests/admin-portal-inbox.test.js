/**
 * Admin portal inbox routes (GATE_PORTAL_INBOX): owner-only, dark by default.
 * The list rules and close-older SQL are pinned against Postgres in
 * portal-inbox-postgres.test.js; here the route contract is pinned with the
 * service stubbed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockService = {
  summary: jest.fn(),
  list: jest.fn(),
  closeOlder: jest.fn(),
};
jest.mock('../services/portal-inbox', () => ({
  ...jest.requireActual('../services/portal-inbox'),
  summary: (...a) => mockService.summary(...a),
  list: (...a) => mockService.list(...a),
  closeOlder: (...a) => mockService.closeOlder(...a),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin only' })),
}));

const express = require('express');
const router = require('../routes/admin-portal-inbox');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/portal-inbox', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/portal-inbox`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const auth = (who) => ({ Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' });
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe('admin portal inbox routes', () => {
  beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_PORTAL_INBOX; });
  afterAll(() => { delete process.env.GATE_PORTAL_INBOX; });

  test('refuse a signed-out caller and a technician login', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    await withServer(async (base) => {
      expect((await fetch(`${base}/summary`)).status).toBe(401);
      expect((await fetch(`${base}/summary`, { headers: auth('tech') })).status).toBe(403);
      expect((await fetch(base, { headers: auth('tech') })).status).toBe(403);
      expect((await fetch(`${base}/close-older`, { method: 'POST', headers: auth('tech'), body: '{}' })).status).toBe(403);
    });
    expect(mockService.summary).not.toHaveBeenCalled();
  });

  test('gate off: summary says enabled:false; every other endpoint is 404 enabled:false and reads nothing', async () => {
    await withServer(async (base) => {
      const summary = await fetch(`${base}/summary`, { headers: auth('admin') });
      expect(summary.status).toBe(200);
      expect(await summary.json()).toEqual({ enabled: false });
      const list = await fetch(base, { headers: auth('admin') });
      expect(list.status).toBe(404);
      expect(await list.json()).toEqual({ enabled: false });
      const close = await fetch(`${base}/close-older`, { method: 'POST', headers: auth('admin'), body: JSON.stringify({ cutoff: daysAgo(20) }) });
      expect(close.status).toBe(404);
      expect(await close.json()).toEqual({ enabled: false });
    });
    expect(mockService.summary).not.toHaveBeenCalled();
    expect(mockService.list).not.toHaveBeenCalled();
    expect(mockService.closeOlder).not.toHaveBeenCalled();
  });

  test('gate on: summary and list return the service answer', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    mockService.summary.mockResolvedValue({ count: 5 });
    mockService.list.mockResolvedValue({ cutoff: daysAgo(14), items: [], older: { chats: 2, requests: 3 } });
    await withServer(async (base) => {
      expect(await (await fetch(`${base}/summary`, { headers: auth('admin') })).json()).toEqual({ enabled: true, count: 5 });
      const body = await (await fetch(base, { headers: auth('admin') })).json();
      expect(body).toMatchObject({ enabled: true, items: [], older: { chats: 2, requests: 3 } });
    });
  });

  test('gate on: close-older refuses a missing, bad or too recent cutoff and closes nothing', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    await withServer(async (base) => {
      for (const cutoff of [undefined, 'not a date', daysAgo(13), new Date().toISOString()]) {
        const res = await fetch(`${base}/close-older`, { method: 'POST', headers: auth('admin'), body: JSON.stringify({ cutoff }) });
        expect(res.status).toBe(400);
      }
    });
    expect(mockService.closeOlder).not.toHaveBeenCalled();
  });

  test('gate on: close-older passes the cutoff and the actor and answers the counts', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    mockService.closeOlder.mockResolvedValue({ chats: 4, requests: 2 });
    const cutoff = daysAgo(14.5);
    await withServer(async (base) => {
      const res = await fetch(`${base}/close-older`, { method: 'POST', headers: auth('admin'), body: JSON.stringify({ cutoff }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ closed: { chats: 4, requests: 2 } });
    });
    const [when, actor] = mockService.closeOlder.mock.calls[0];
    expect(when.toISOString()).toBe(cutoff);
    expect(actor).toEqual({ technicianId: 'admin-1', role: 'admin' });
  });
});
