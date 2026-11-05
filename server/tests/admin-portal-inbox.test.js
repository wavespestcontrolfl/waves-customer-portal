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
  markMessageHandled: jest.fn(),
};
jest.mock('../services/portal-inbox', () => ({
  ...jest.requireActual('../services/portal-inbox'),
  summary: (...a) => mockService.summary(...a),
  list: (...a) => mockService.list(...a),
  closeOlder: (...a) => mockService.closeOlder(...a),
  markMessageHandled: (...a) => mockService.markMessageHandled(...a),
}));
const mockStaffReply = jest.fn();
jest.mock('../services/portal-messages', () => ({
  ...jest.requireActual('../services/portal-messages'),
  staffReply: (...a) => mockStaffReply(...a),
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
  beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_PORTAL_INBOX; delete process.env.GATE_PORTAL_MESSAGES; });
  afterAll(() => { delete process.env.GATE_PORTAL_INBOX; delete process.env.GATE_PORTAL_MESSAGES; });

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
    const olderItems = [{ kind: 'chat', id: 'esc-old', createdAt: daysAgo(20) }];
    mockService.list.mockResolvedValue({ cutoff: daysAgo(14), items: [], olderItems, older: { chats: 2, requests: 3 } });
    await withServer(async (base) => {
      expect(await (await fetch(`${base}/summary`, { headers: auth('admin') })).json()).toEqual({ enabled: true, replies: false, count: 5 });
      const body = await (await fetch(base, { headers: auth('admin') })).json();
      expect(body).toMatchObject({ enabled: true, replies: false, items: [], olderItems, older: { chats: 2, requests: 3 } });
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

  // GATE_PORTAL_MESSAGES: Reply in portal. The service is stubbed; its rules are pinned in portal-messages-postgres.test.js.
  describe('POST /reply', () => {
    const ITEM = '44444444-4444-4444-8444-444444444444';
    const REQ = '55555555-5555-4555-8555-555555555555';
    const post = (base, who, body) => fetch(`${base}/reply`, { method: 'POST', headers: auth(who), body: JSON.stringify(body) });

    test('answers 404 while either gate is off, refuses a technician, and calls nothing', async () => {
      process.env.GATE_PORTAL_INBOX = 'true';
      await withServer(async (base) => {
        const off = await post(base, 'admin', { kind: 'chat', id: ITEM, body: 'Hi' });
        expect(off.status).toBe(404);
        expect(await off.json()).toEqual({ enabled: false });
        process.env.GATE_PORTAL_MESSAGES = 'true';
        expect((await post(base, 'tech', { kind: 'chat', id: ITEM, body: 'Hi' })).status).toBe(403);
        delete process.env.GATE_PORTAL_INBOX;
        expect((await post(base, 'admin', { kind: 'chat', id: ITEM, body: 'Hi' })).status).toBe(404);
      });
      expect(mockStaffReply).not.toHaveBeenCalled();
    });

    test('refuses an unknown kind, a bad id or a missing body', async () => {
      process.env.GATE_PORTAL_INBOX = 'true';
      process.env.GATE_PORTAL_MESSAGES = 'true';
      await withServer(async (base) => {
        for (const body of [{ kind: 'booking', id: ITEM, body: 'Hi' }, { kind: 'chat', id: 'nope', body: 'Hi' }, { kind: 'chat', id: ITEM }, { kind: 'chat', id: ITEM, body: 'Hi', requestId: 'x' }]) {
          expect((await post(base, 'admin', body)).status).toBe(400);
        }
      });
      expect(mockStaffReply).not.toHaveBeenCalled();
    });

    test('passes the item, the words, the retry id and the actor, and answers the result; a service refusal keeps its status', async () => {
      process.env.GATE_PORTAL_INBOX = 'true';
      process.env.GATE_PORTAL_MESSAGES = 'true';
      const { PortalMessageError } = jest.requireActual('../services/portal-messages');
      mockStaffReply.mockResolvedValueOnce({ message: { id: 'm-1' }, closed: true, notice: { bell: true, pushAccepted: 0, email: 'sent' } });
      mockStaffReply.mockRejectedValueOnce(new PortalMessageError('not_found', 404, 'This item is gone.'));
      await withServer(async (base) => {
        const ok = await post(base, 'admin', { kind: 'request', id: ITEM, body: 'We can come Monday.', requestId: REQ });
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ message: { id: 'm-1' }, closed: true, notice: { bell: true, pushAccepted: 0, email: 'sent' } });
        const gone = await post(base, 'admin', { kind: 'chat', id: ITEM, body: 'Hi' });
        expect(gone.status).toBe(404);
        expect(await gone.json()).toEqual({ error: 'This item is gone.', code: 'not_found' });
      });
      expect(mockStaffReply.mock.calls[0][0]).toEqual({
        kind: 'request', id: ITEM, body: 'We can come Monday.', clientRequestId: REQ, actor: { technicianId: 'admin-1', role: 'admin' },
      });
    });
  });

  describe('POST /messages/:id/handled', () => {
    const THREAD = '66666666-6666-4666-8666-666666666666';
    const post = (base, who, id) => fetch(`${base}/messages/${id}/handled`, { method: 'POST', headers: auth(who), body: '{}' });

    test('404 while GATE_PORTAL_MESSAGES is off, 403 for a technician, 400 for a bad id', async () => {
      process.env.GATE_PORTAL_INBOX = 'true';
      await withServer(async (base) => {
        expect((await post(base, 'admin', THREAD)).status).toBe(404);
        process.env.GATE_PORTAL_MESSAGES = 'true';
        expect((await post(base, 'tech', THREAD)).status).toBe(403);
        expect((await post(base, 'admin', 'not-a-uuid')).status).toBe(400);
      });
      expect(mockService.markMessageHandled).not.toHaveBeenCalled();
    });

    test('passes the thread and the actor and answers whether it closed it', async () => {
      process.env.GATE_PORTAL_INBOX = 'true';
      process.env.GATE_PORTAL_MESSAGES = 'true';
      mockService.markMessageHandled.mockResolvedValueOnce({ handled: false });
      await withServer(async (base) => {
        const res = await post(base, 'admin', THREAD);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ handled: false });
      });
      expect(mockService.markMessageHandled).toHaveBeenCalledWith(THREAD, { technicianId: 'admin-1', role: 'admin' });
    });
  });
});
