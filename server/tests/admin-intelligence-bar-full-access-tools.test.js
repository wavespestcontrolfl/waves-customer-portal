/**
 * POST /admin/intelligence-bar/query on the platform path with
 * GATE_IB_TOOL_SEARCH (owner ruling 2026-10-12): a full-access login keeps its
 * page's tools up front and reaches every other allowed tool, deferred, through
 * the API's tool search. Other admins keep the page list plus discover_capabilities.
 * Real tool modules load here (only the SDK, db, auth and bookkeeping are
 * stubbed) so the lists are the real ones.
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
  prepareReadInput: jest.fn(async (input) => ({ input })),
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
const ToolSearch = require('../services/intelligence-bar/tool-search');
const apiToolDefinition = require('../services/intelligence-bar/tool-definition');

const IbTasks = require('../services/intelligence-bar/tasks');
const names = list => list.map(t => t.name);
// The platform path stores the reply payload on the task.
const repliedText = () => IbTasks.checkpoint.mock.calls.map(call => call[2].response?.response).filter(Boolean).pop();

async function ask(token, context, turns = [{ content: [{ type: 'text', text: 'ok' }], usage: {} }]) {
  const app = express();
  app.use(express.json());
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, stack: err.stack }));
  const server = app.listen(0);
  try {
    mockMessagesCreate.mockReset();
    IbTasks.checkpoint.mockClear();
    for (const turn of turns) mockMessagesCreate.mockResolvedValueOnce(turn);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/intelligence-bar/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'anything', context }),
    });
    const body = await res.json();
    expect({ status: res.status, error: body.error, stack: body.stack }).toEqual({ status: 200, error: undefined, stack: undefined });
    return { body, reply: repliedText(), requests: mockMessagesCreate.mock.calls.map(([request]) => request) };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const systemText = request => request.system.map(block => block.text).join('\n');
const pageToolNames = context => names(registry.initialTools(context, { role: 'admin', context })).filter(name => name !== 'discover_capabilities');

describe('GATE_IB_TOOL_SEARCH on', () => {
  beforeEach(() => { process.env.GATE_IB_TOOL_SEARCH = 'true'; });
  afterEach(() => { delete process.env.GATE_IB_TOOL_SEARCH; });

  test('the owner request carries the page tools, the search tool and every other tool deferred', async () => {
    for (const context of ['dashboard', 'customers', 'comms']) {
      const { requests: [request] } = await ask('owner', context);
      const tools = request.tools;
      const expected = registry.initialTools(context, { role: 'admin', context, fullAccess: true, toolSearch: true }).map(apiToolDefinition);
      expect(tools).toEqual(expected);
      expect(names(tools.filter(t => !t.defer_loading))).toEqual([...pageToolNames(context), 'tool_search_tool_bm25']);
      expect(tools.filter(t => t.type === 'tool_search_tool_bm25_20251119')).toHaveLength(1);
      expect(new Set(names(tools)).size).toBe(tools.length);
      expect(tools.some(t => t.cache_control)).toBe(false);
      expect(tools.filter(t => t.defer_loading).length).toBeGreaterThan(150);
      expect(names(tools)).not.toContain('discover_capabilities');
    }
  });

  test('the system prompt names the searchable areas, not discover_capabilities, and is the same on repeat', async () => {
    const first = (await ask('owner', 'dashboard')).requests[0];
    const again = (await ask('owner', 'dashboard')).requests[0];
    expect(systemText(first)).toBe(systemText(again));
    expect(systemText(first)).toContain(ToolSearch.SEARCH_LINE);
    expect(systemText(first)).toContain('banking and tax, and outside services');
    expect(systemText(first)).not.toContain('discover_capabilities');
    expect(first.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('another admin keeps the page list, discover_capabilities and the old prompt line', async () => {
    const { requests: [request] } = await ask('otheradmin', 'dashboard');
    expect(names(request.tools)).toEqual(['discover_capabilities', ...pageToolNames('dashboard')]);
    expect(request.tools.some(t => t.defer_loading || t.type)).toBe(false);
    expect(systemText(request)).toContain(ToolSearch.DISCOVER_LINE);
  });

  test('a response with server search blocks and a deferred tool call runs only the client call', async () => {
    const content = [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'review stats' } },
      { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1',
        content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'get_review_stats' }] } },
      { type: 'tool_use', id: 'toolu_1', name: 'get_review_stats', input: {} },
    ];
    const { requests } = await ask('owner', 'dashboard', [{ content, usage: {}, stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'done' }], usage: {} }]);
    expect(requests).toHaveLength(2);
    const messages = requests[1].messages;
    const assistant = messages[messages.length - 2];
    expect(assistant).toEqual({ role: 'assistant', content });
    const results = messages[messages.length - 1].content.filter(b => b.type === 'tool_result');
    expect(results.map(b => b.tool_use_id)).toEqual(['toolu_1']);
    expect(JSON.stringify(messages)).not.toContain('"tool_use_id":"srvtoolu_1","content":"');
    // Deferred tools are in tools, so the call is not "not loaded".
    expect(results[0].content).not.toContain('capability_not_loaded');
    expect(results[0].content).not.toContain('permission_denied');
    // Same tools array on the next request.
    expect(requests[1].tools).toEqual(requests[0].tools);
  });

  test('a search error block does not crash the request', async () => {
    const content = [
      { type: 'server_tool_use', id: 'srvtoolu_2', name: 'tool_search_tool_bm25', input: { query: 'anything' } },
      { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' } },
      { type: 'text', text: 'I could not search just now.' },
    ];
    const { reply, requests } = await ask('owner', 'dashboard', [{ content, usage: {}, stop_reason: 'end_turn' }]);
    expect(requests).toHaveLength(1);
    expect(reply).toContain('I could not search just now.');
  });

  test('an empty search result is a normal answer', async () => {
    const content = [
      { type: 'server_tool_use', id: 'srvtoolu_3', name: 'tool_search_tool_bm25', input: { query: 'nothing like this' } },
      { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_3', content: { type: 'tool_search_tool_search_result', tool_references: [] } },
      { type: 'text', text: 'Nothing matches.' },
    ];
    const { reply } = await ask('owner', 'dashboard', [{ content, usage: {}, stop_reason: 'end_turn' }]);
    expect(reply).toContain('Nothing matches.');
  });

  test('pause_turn with only a server search continues with the assistant content as is', async () => {
    const paused = [
      { type: 'server_tool_use', id: 'srvtoolu_4', name: 'tool_search_tool_bm25', input: { query: 'timesheets' } },
      { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_4',
        content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'get_review_stats' }] } },
    ];
    const { reply, requests } = await ask('owner', 'dashboard', [{ content: paused, usage: {}, stop_reason: 'pause_turn' }, { content: [{ type: 'text', text: 'It is get_review_stats.' }], usage: {} }]);
    expect(requests).toHaveLength(2);
    const messages = requests[1].messages;
    expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: paused });
    expect(reply).toContain('It is get_review_stats.');
  });
});

describe('GATE_IB_TOOL_SEARCH off', () => {
  beforeEach(() => { delete process.env.GATE_IB_TOOL_SEARCH; });

  test('the owner gets today\'s page list with discover_capabilities, same as another admin', async () => {
    const owner = (await ask('owner', 'dashboard')).requests[0];
    const other = (await ask('otheradmin', 'dashboard')).requests[0];
    expect(names(owner.tools)).toEqual(['discover_capabilities', ...pageToolNames('dashboard')]);
    expect(owner.tools).toEqual(other.tools);
    expect(systemText(owner)).toContain(ToolSearch.DISCOVER_LINE);
    expect(owner.tools.some(t => t.defer_loading || t.cache_control)).toBe(false);
  });

  test('a discovery round still loads nothing twice', async () => {
    const turns = [
      { content: [{ type: 'tool_use', id: 'tu_1', name: 'discover_capabilities', input: { query: 'review stats' } }], usage: {} },
      { content: [{ type: 'text', text: 'ok' }], usage: {} },
    ];
    const { requests } = await ask('owner', 'dashboard', turns);
    expect(new Set(names(requests[1].tools)).size).toBe(requests[1].tools.length);
  });
});
