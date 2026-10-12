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

async function requestToolsFor(token, context) {
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
    return mockMessagesCreate.mock.calls[0][0].tools;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function toolsSentFor(token, context) {
  return (await requestToolsFor(token, context)).map(t => t.name);
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

// The 178 KB shared list is cached once, not once per page: one 1h breakpoint
// on the last tool (tools + system + messages = 3 breakpoints, 1h before 5 min).
test('the owner request puts one 1h cache breakpoint on the last tool; another admin gets none', async () => {
  const owner = await requestToolsFor('owner', 'dashboard');
  const ownerCustomers = await requestToolsFor('owner', 'customers');
  const marked = tools => tools.map((t, i) => (t.cache_control ? i : -1)).filter(i => i >= 0);
  expect(marked(owner)).toEqual([owner.length - 1]);
  expect(owner[owner.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  expect(marked(ownerCustomers)).toEqual([ownerCustomers.length - 1]);
  // Same bytes on every page, so the prefix hash is the same.
  expect(JSON.stringify(ownerCustomers)).toBe(JSON.stringify(owner));
  const other = await requestToolsFor('otheradmin', 'dashboard');
  expect(marked(other)).toEqual([]);
  const request = mockMessagesCreate.mock.calls[0][0];
  expect(request.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  // The registry's own definitions never carry the breakpoint.
  expect(registry.initialTools('dashboard', { role: 'admin', context: 'dashboard', fullAccess: true }).some(t => t.cache_control)).toBe(false);
});

describe('withToolsCacheBreakpoint', () => {
  const { withToolsCacheBreakpoint } = intelligenceRouter;
  const sample = () => [{ name: 'a', input_schema: {} }, { name: 'b', input_schema: {} }, { name: 'c', input_schema: {} }];

  test('marks only the last tool and does not change its input', () => {
    const input = sample();
    const out = withToolsCacheBreakpoint(input, true);
    expect(out.map(t => t.cache_control)).toEqual([undefined, undefined, { type: 'ephemeral', ttl: '1h' }]);
    expect(out).not.toBe(input);
    expect(input).toEqual(sample());
  });

  test('disabled returns the same array, and an empty list stays empty', () => {
    const input = sample();
    expect(withToolsCacheBreakpoint(input, false)).toBe(input);
    expect(withToolsCacheBreakpoint([], true)).toEqual([]);
  });

  test('a tool appended after a first call carries the only breakpoint', () => {
    const first = withToolsCacheBreakpoint(sample(), true);
    const next = withToolsCacheBreakpoint([...sample(), { name: 'd', input_schema: {} }], true);
    expect(first[2].cache_control).toBeTruthy();
    expect(next.filter(t => t.cache_control).map(t => t.name)).toEqual(['d']);
  });
});
