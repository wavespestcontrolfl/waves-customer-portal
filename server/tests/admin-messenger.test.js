/**
 * Admin Messenger routes (GATE_MESSENGER_INBOX): staff roles, dark by default.
 * The store, poll and bell rules run against Postgres in
 * messenger-inbox-postgres.test.js; here the route contract is pinned with the
 * service stubbed, and the poll's two no-op exits are pinned with fetch spied.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockService = {
  summary: jest.fn(),
  listThreads: jest.fn(),
  getThread: jest.fn(),
  markThreadRead: jest.fn(),
  sendReply: jest.fn(),
};
jest.mock('../services/messenger-inbox', () => ({
  ...jest.requireActual('../services/messenger-inbox'),
  summary: (...a) => mockService.summary(...a),
  listThreads: (...a) => mockService.listThreads(...a),
  getThread: (...a) => mockService.getThread(...a),
  markThreadRead: (...a) => mockService.markThreadRead(...a),
  sendReply: (...a) => mockService.sendReply(...a),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
      other: { id: 'other-1', role: 'customer' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })),
}));

const express = require('express');
const router = require('../routes/admin-messenger');
const messenger = require('../services/messenger-inbox');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/messenger', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/messenger`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const auth = (who) => ({ Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' });
const ID = '3f1c2a9e-5b7d-4c8e-9a10-0123456789ab';
const reply = (base, body, who = 'admin') => fetch(`${base}/threads/${ID}/reply`, { method: 'POST', headers: auth(who), body: JSON.stringify(body) });

describe('admin messenger routes', () => {
  beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_MESSENGER_INBOX; });
  afterAll(() => { delete process.env.GATE_MESSENGER_INBOX; });

  test('refuse a signed-out caller and a non-staff login; a technician login is staff', async () => {
    process.env.GATE_MESSENGER_INBOX = 'true';
    mockService.summary.mockResolvedValue({ unanswered: 0 });
    await withServer(async (base) => {
      expect((await fetch(`${base}/summary`)).status).toBe(401);
      expect((await fetch(`${base}/summary`, { headers: auth('other') })).status).toBe(403);
      expect((await fetch(`${base}/summary`, { headers: auth('tech') })).status).toBe(200);
    });
  });

  test('gate off: summary says enabled:false; every other endpoint is 404 enabled:false and reads nothing', async () => {
    await withServer(async (base) => {
      const summary = await fetch(`${base}/summary`, { headers: auth('admin') });
      expect(summary.status).toBe(200);
      expect(await summary.json()).toEqual({ enabled: false });
      for (const [path, method] of [['/threads', 'GET'], [`/threads/${ID}`, 'GET'], [`/threads/${ID}/read`, 'POST'], [`/threads/${ID}/reply`, 'POST']]) {
        const res = await fetch(`${base}${path}`, { method, headers: auth('admin'), ...(method === 'POST' ? { body: JSON.stringify({ text: 'hi' }) } : {}) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ enabled: false });
      }
    });
    for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
  });

  test('gate on: summary, list and thread answer the service shapes; an unknown thread is 404', async () => {
    process.env.GATE_MESSENGER_INBOX = 'true';
    const thread = { id: ID, name: 'Pat Synthetic', lastMessageAt: '2026-10-31T15:00:00.000Z', lastInboundAt: '2026-10-31T15:00:00.000Z', snippet: 'Hello', unread: 1, answered: false, canReply: true };
    mockService.summary.mockResolvedValue({ unanswered: 2 });
    mockService.listThreads.mockResolvedValue({ threads: [thread], hasMore: true, unanswered: 7 });
    mockService.getThread.mockResolvedValueOnce({ thread, messages: [{ id: 'm1', direction: 'inbound', body: 'Hello', createdAt: thread.lastMessageAt, author: { type: 'customer', name: 'Pat Synthetic' } }] });
    mockService.getThread.mockResolvedValueOnce(null);
    await withServer(async (base) => {
      expect(await (await fetch(`${base}/summary`, { headers: auth('admin') })).json()).toEqual({ enabled: true, unanswered: 2 });
      expect(await (await fetch(`${base}/threads`, { headers: auth('admin') })).json()).toEqual({ enabled: true, threads: [thread], hasMore: true, unanswered: 7 });
      const one = await (await fetch(`${base}/threads/${ID}`, { headers: auth('admin') })).json();
      expect(one).toMatchObject({ enabled: true, thread: { id: ID, canReply: true }, messages: [{ id: 'm1', direction: 'inbound', body: 'Hello' }] });
      expect((await fetch(`${base}/threads/${ID}`, { headers: auth('admin') })).status).toBe(404);
    });
  });

  test('list passes the keyset to the service and refuses a bad one', async () => {
    process.env.GATE_MESSENGER_INBOX = 'true';
    mockService.listThreads.mockResolvedValue({ threads: [], hasMore: false, unanswered: 0 });
    await withServer(async (base) => {
      const before = '2026-10-31T15:00:00.000Z';
      expect((await fetch(`${base}/threads?before=${encodeURIComponent(before)}&beforeId=${ID}`, { headers: auth('admin') })).status).toBe(200);
      expect(mockService.listThreads.mock.calls[0][2]).toEqual({ before, beforeId: ID });
      expect((await fetch(`${base}/threads?before=yesterday`, { headers: auth('admin') })).status).toBe(400);
      expect((await fetch(`${base}/threads?before=${encodeURIComponent(before)}&beforeId=nope`, { headers: auth('admin') })).status).toBe(400);
    });
    expect(mockService.listThreads).toHaveBeenCalledTimes(1);
  });

  test('reply refuses an empty or over-long text before calling Facebook', async () => {
    process.env.GATE_MESSENGER_INBOX = 'true';
    await withServer(async (base) => {
      for (const body of [{}, { text: '   ' }, { text: 7 }, { text: 'x'.repeat(2001) }]) expect((await reply(base, body)).status).toBe(400);
    });
    expect(mockService.sendReply).not.toHaveBeenCalled();
  });

  test('reply maps the service answer: 409 outside_window, 502 send_failed, 404, and 200 with the actor passed on', async () => {
    process.env.GATE_MESSENGER_INBOX = 'true';
    mockService.sendReply
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'outside_window' })
      .mockResolvedValueOnce({ ok: false, status: 502, error: 'send_failed' })
      .mockResolvedValueOnce({ ok: false, status: 404, error: 'not_found' })
      .mockResolvedValueOnce({ ok: true, message: { id: 'm9', createdAt: '2026-10-31T16:00:00.000Z' } });
    await withServer(async (base) => {
      const late = await reply(base, { text: 'Thanks' });
      expect(late.status).toBe(409);
      expect(await late.json()).toEqual({ error: 'outside_window' });
      const refused = await reply(base, { text: 'Thanks' });
      expect(refused.status).toBe(502);
      expect(await refused.json()).toEqual({ error: 'send_failed' });
      expect((await reply(base, { text: 'Thanks' })).status).toBe(404);
      const ok = await reply(base, { text: '  Thanks  ' }, 'tech');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ sent: true, message: { id: 'm9', createdAt: '2026-10-31T16:00:00.000Z' } });
    });
    const [req, id, text] = mockService.sendReply.mock.calls[3];
    expect(req.technicianId).toBe('tech-1');
    expect(id).toBe(ID);
    expect(text).toBe('Thanks');
  });
});

describe('pollMessenger exits', () => {
  const saved = { token: process.env.FACEBOOK_ACCESS_TOKEN, page: process.env.FACEBOOK_PAGE_ID };
  beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_MESSENGER_INBOX; global.fetch = jest.fn(); });
  afterEach(() => {
    delete process.env.GATE_MESSENGER_INBOX;
    for (const [key, value] of [['FACEBOOK_ACCESS_TOKEN', saved.token], ['FACEBOOK_PAGE_ID', saved.page]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  test('gate off: no Facebook call and no store read', async () => {
    process.env.FACEBOOK_ACCESS_TOKEN = 'synthetic-token';
    process.env.FACEBOOK_PAGE_ID = '1000';
    expect(await messenger.pollMessenger()).toEqual({ skipped: 'gate_off' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test('gate on but no token or page: does nothing', async () => {
    process.env.GATE_MESSENGER_INBOX = 'true';
    delete process.env.FACEBOOK_ACCESS_TOKEN;
    process.env.FACEBOOK_PAGE_ID = '1000';
    expect(await messenger.pollMessenger()).toEqual({ skipped: 'not_configured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
