/**
 * POST /admin/intelligence-bar/query on the platform path — a full-access
 * login (owner ruling 2026-10-12) is sent every allowed tool on every ordinary
 * admin page, in one fixed order so one prompt-cache entry serves all pages.
 * Other admins keep the page-scoped list. Real tool modules load here (only
 * the SDK, db, auth and bookkeeping are stubbed) so the list is the real one.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GATE_IB_PLATFORM = 'true';

const mockMessagesCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));
jest.mock('../models/db', () => jest.fn(() => ({ insert: jest.fn(async () => undefined) })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({
  getBreaker: jest.fn(() => ({
    isTripped: jest.fn(() => false),
    fastFailResult: jest.fn(),
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
  })),
}));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
// The platform path starts a durable task per request; keep it off the database.
jest.mock('../services/intelligence-bar/tasks', () => ({
  begin: jest.fn(async () => ({ task: { id: 'task-1', state: 'running', checkpoint: [] }, created: true })),
  checkpoint: jest.fn(async () => undefined),
  claimResume: jest.fn(), get: jest.fn(), list: jest.fn(), snapshot: jest.fn(async () => ({ state: 'done' })),
  requestStartedAt: jest.fn(() => new Date()),
  purgeExpiredTasks: jest.fn(),
}));
jest.mock('../services/intelligence-bar/task-context', () => ({
  resolve: jest.fn(async () => ({ target: null, targets: [] })),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      owner: { id: 'admin-1', role: 'admin', email: 'contact@wavespestcontrol.com' },
      otheradmin: { id: 'admin-2', role: 'admin', email: 'office@example.test' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (req.techRole ? next() : res.status(403).json({ error: 'Staff access required' })),
  requireAdmin: (req, res, next) => next(),
}));

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');
const registry = require('../services/intelligence-bar/action-registry');
const { FULL_ACCESS_TWO_STEP_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');

async function toolsSentFor(token, context) {
  const app = express();
  app.use(express.json());
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, stack: err.stack }));
  const server = app.listen(0);
  try {
    mockMessagesCreate.mockReset();
    mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], usage: {} });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/intelligence-bar/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'anything', context }),
    });
    const body = await res.json();
    expect({ status: res.status, error: body.error, stack: body.stack }).toEqual({ status: 200, error: undefined, stack: undefined });
    return mockMessagesCreate.mock.calls[0][0].tools.map(t => t.name);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('a full-access login is sent every allowed tool, the same list on every page, with no duplicates', async () => {
  const dashboard = await toolsSentFor('owner', 'dashboard');
  const customers = await toolsSentFor('owner', 'customers');
  const comms = await toolsSentFor('owner', 'comms');
  expect(customers).toEqual(dashboard);
  expect(comms).toEqual(dashboard);
  expect(new Set(dashboard).size).toBe(dashboard.length);
  expect(dashboard[0]).toBe('discover_capabilities');
  expect(dashboard).toEqual(registry.initialTools('dashboard', { role: 'admin', context: 'dashboard', fullAccess: true }).map(t => t.name));
  expect(dashboard).toEqual(expect.arrayContaining(['create_appointment', 'get_call_log', 'resolve_sentry_issue']));
  expect(dashboard.length).toBeGreaterThan(200);
});

test('another admin keeps the page-scoped list', async () => {
  const dashboard = await toolsSentFor('otheradmin', 'dashboard');
  expect(dashboard).toContain('create_appointment');
  expect(dashboard.length).toBeLessThan(60);
  expect(dashboard.some(name => FULL_ACCESS_TWO_STEP_TOOL_NAMES.has(name))).toBe(false);
  expect(dashboard).not.toContain('get_review_stats');
});

test('a discovery round on the full list loads nothing twice', async () => {
  const app = express();
  app.use(express.json());
  app.use('/admin/intelligence-bar', intelligenceRouter);
  const server = app.listen(0);
  try {
    mockMessagesCreate.mockReset();
    mockMessagesCreate
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'tu_1', name: 'discover_capabilities', input: { query: 'book a visit' } }], usage: {} })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], usage: {} });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/intelligence-bar/query`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'anything', context: 'dashboard' }),
    });
    expect(res.status).toBe(200);
    const [first, second] = mockMessagesCreate.mock.calls.map(([request]) => request.tools.map(t => t.name));
    expect(second).toEqual(first);
    expect(new Set(second).size).toBe(second.length);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
