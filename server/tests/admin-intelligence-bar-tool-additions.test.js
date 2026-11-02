/**
 * POST /admin/intelligence-bar/query with GATE_IB_TOOL_ADDITIONS on the
 * production model (MODEL_FLAGSHIP=claude-opus-5-5, which thinks by default,
 * so the bar has no tool search and loads tools with discover_capabilities).
 * A found tool must not change `tools` (rendered first, the start of the
 * cached prefix): it comes in a role:"system" message of tool_addition blocks
 * after the tool results, with the inline-tools beta header. Real tool modules
 * load; only the SDK, db, auth and bookkeeping are stubbed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GATE_IB_PLATFORM = 'true';
process.env.GATE_IB_TOOL_SEARCH = 'true';
process.env.MODEL_FLAGSHIP = 'claude-opus-5-5';

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
    req.technician = { id: 'admin-1', role: 'admin', email: 'contact@wavespestcontrol.com' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');
const registry = require('../services/intelligence-bar/action-registry');
const apiToolDefinition = require('../services/intelligence-bar/tool-definition');
const IbTasks = require('../services/intelligence-bar/tasks');
const ToolAdditions = require('../services/intelligence-bar/tool-additions');

// The same route on a model that takes no mid-conversation tool changes.
let sonnetRouter;
jest.isolateModules(() => {
  process.env.MODEL_FLAGSHIP = 'claude-sonnet-5';
  sonnetRouter = require('../routes/admin-intelligence-bar');
});
process.env.MODEL_FLAGSHIP = 'claude-opus-5-5';

const BETA = { headers: { 'anthropic-beta': 'inline-tools-2026-09-15' } };
const names = list => list.map(t => t.name);
const withoutMarkers = value => JSON.parse(JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v)));

async function ask(turns, router = intelligenceRouter, { path = '/query', body: requestBody } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/admin/intelligence-bar', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    mockMessagesCreate.mockReset();
    IbTasks.checkpoint.mockClear();
    for (const turn of turns) mockMessagesCreate.mockResolvedValueOnce(turn);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/intelligence-bar${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody || { prompt: 'anything', context: 'dashboard' }),
    });
    const body = await res.json();
    expect({ status: res.status, error: body.error }).toEqual({ status: 200, error: undefined });
    return mockMessagesCreate.mock.calls.map(([request, options]) => ({ request, options }));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const discover = { content: [{ type: 'tool_use', id: 'toolu_disc', name: 'discover_capabilities', input: { query: 'review stats' } }], usage: {}, stop_reason: 'tool_use' };
const callFound = { content: [{ type: 'tool_use', id: 'toolu_found', name: 'get_review_stats', input: {} }], usage: {}, stop_reason: 'tool_use' };
const answer = { content: [{ type: 'text', text: 'ok' }], usage: {} };
const found = () => apiToolDefinition(registry.actions.get('get_review_stats').definition);

describe('GATE_IB_TOOL_ADDITIONS on', () => {
  beforeEach(() => { process.env.GATE_IB_TOOL_ADDITIONS = 'true'; });
  afterEach(() => { delete process.env.GATE_IB_TOOL_ADDITIONS; });

  test('a found tool comes in a system message after the results; tools, system and the earlier turns stay as sent', async () => {
    const [first, second] = await ask([discover, answer]);
    expect(names(first.request.tools)).not.toContain('get_review_stats');
    expect(second.request.tools).toEqual(first.request.tools);
    expect(second.request.system).toEqual(first.request.system);
    expect(withoutMarkers(second.request.messages[0])).toEqual(withoutMarkers(first.request.messages[0]));

    const messages = second.request.messages;
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'system']);
    expect(messages[2].content.find(b => b.type === 'tool_result').tool_use_id).toBe('toolu_disc');
    const additions = messages[3].content;
    expect(additions.every(b => b.type === 'tool_addition' && b.tool.type === 'tool_definition')).toBe(true);
    expect(additions.find(b => b.tool.definition.name === 'get_review_stats').tool.definition).toEqual(found());
    // No added name is already in `tools`; the moving cache marker sits on the last block only.
    for (const block of additions) expect(names(first.request.tools)).not.toContain(block.tool.definition.name);
    expect(additions.filter(b => b.cache_control).length).toBe(1);
    expect(additions[additions.length - 1].cache_control).toEqual({ type: 'ephemeral' });

    expect(first.options).toBeUndefined();
    expect(second.options).toEqual(BETA);
  });

  test('the model can call the found tool next round; the addition stays in place, unchanged, and is not sent twice', async () => {
    const [first, second, third] = await ask([discover, callFound, answer]);
    const results = third.request.messages[third.request.messages.length - 1].content.filter(b => b.type === 'tool_result');
    expect(results.map(b => b.tool_use_id)).toEqual(['toolu_found']);
    expect(results[0].content).not.toContain('capability_not_loaded');
    expect(third.request.tools).toEqual(first.request.tools);
    expect(withoutMarkers(third.request.messages.slice(0, 4))).toEqual(withoutMarkers(second.request.messages));
    expect(third.request.messages.filter(m => m.role === 'system')).toHaveLength(1);
    expect(third.options).toEqual(BETA);
  });
});

describe('without GATE_IB_TOOL_ADDITIONS, or on a model that takes no additions', () => {
  afterEach(() => { delete process.env.GATE_IB_TOOL_ADDITIONS; });

  test('gate off: the found definition is merged into tools, as before, with no system message or header', async () => {
    const [first, second] = await ask([discover, answer]);
    expect(names(first.request.tools)).not.toContain('get_review_stats');
    expect(second.request.tools.find(t => t.name === 'get_review_stats')).toEqual(found());
    expect(second.request.messages.some(m => m.role === 'system')).toBe(false);
    expect(second.options).toBeUndefined();
  });

  test('gate on with Claude Sonnet 5: the merge stays', async () => {
    process.env.GATE_IB_TOOL_ADDITIONS = 'true';
    const [first, second] = await ask([discover, answer], sonnetRouter);
    expect(first.request.model).toBe('claude-sonnet-5');
    expect(names(second.request.tools)).toContain('get_review_stats');
    expect(second.request.messages.some(m => m.role === 'system')).toBe(false);
    expect(second.options).toBeUndefined();
  });
});

// A saved task resumes with a continuation user turn after its checkpoint. On
// Opus 5.5 every saved thinking block was checked against the `tools` the
// original request sent, so a resume must send that same list.
describe('a resumed task with saved additions', () => {
  const TASK_ID = '7e1c2f7a-1111-2222-3333-deadbeef0019';
  const SESSION = '7e1c2f7a-1111-2222-3333-deadbeef0018';
  const scope = { role: 'admin', context: 'dashboard', fullAccess: true };
  const discoverResult = () => registry.discover({ query: 'review stats' }, scope);
  let pageTools;
  beforeAll(async () => { [{ request: { tools: pageTools } }] = await ask([answer]); });
  // What the original request offered by message: every found tool its page list lacked.
  const addedByOriginal = () => discoverResult().definitions.map(apiToolDefinition).filter(d => !names(pageTools).includes(d.name));
  const savedRound = () => [
    { role: 'user', content: 'review stats, then block that sender' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_disc', name: 'discover_capabilities', input: { query: 'review stats' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_disc', content: JSON.stringify(discoverResult().result) }] },
    ToolAdditions.additionMessage(addedByOriginal()),
  ];
  const calledFound = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_found', name: 'get_review_stats', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_found', content: '{}' }] },
  ];
  const resumeWith = (checkpoint, router) => {
    const task = {
      id: TASK_ID, state: 'awaiting_approval', session_id: SESSION, request_key: 'resume-key-0019',
      runner_token: '7e1c2f7a-1111-2222-3333-deadbeef0017',
      request: { prompt: 'review stats', context: 'dashboard', pageData: {} },
      checkpoint: JSON.parse(JSON.stringify(checkpoint)), target: null, response: null,
    };
    IbTasks.claimResume.mockReset();
    IbTasks.claimResume.mockResolvedValue({ task, receipts: [{ tool: 'block_sender', outcome: 'completed' }] });
    IbTasks.get.mockReset();
    IbTasks.get.mockResolvedValue(task);
    return ask([answer], router, { path: `/tasks/${TASK_ID}/resume`, body: { session_id: SESSION } });
  };
  const isContinuation = message => message.role === 'user' && JSON.stringify(message).includes('Continue the original request');

  afterEach(() => { delete process.env.GATE_IB_TOOL_ADDITIONS; });

  test('ends on an addition: it is dropped, `tools` is the page list as sent, and the found tools come back after the continuation', async () => {
    process.env.GATE_IB_TOOL_ADDITIONS = 'true';
    const [resumed] = await resumeWith(savedRound());
    expect(resumed.request.tools).toEqual(pageTools);
    const messages = resumed.request.messages;
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'system']);
    expect(isContinuation(messages[3])).toBe(true);
    expect(withoutMarkers(messages[4])).toEqual(ToolAdditions.additionMessage(addedByOriginal()));
    expect(resumed.options).toEqual(BETA);
  });

  test('an addition inside the history stays where it is, unchanged; `tools` is the page list as sent; nothing is offered twice', async () => {
    process.env.GATE_IB_TOOL_ADDITIONS = 'true';
    const history = [...savedRound(), ...calledFound];
    const [resumed] = await resumeWith(history);
    expect(resumed.request.tools).toEqual(pageTools);
    expect(withoutMarkers(resumed.request.messages.slice(0, history.length))).toEqual(history);
    expect(resumed.request.messages.filter(m => m.role === 'system')).toHaveLength(1);
    expect(isContinuation(resumed.request.messages[resumed.request.messages.length - 1])).toBe(true);
    expect(resumed.options).toEqual(BETA);
  });

  test('gate off: the saved additions still offer their tools; `tools` gains none of them', async () => {
    const history = [...savedRound(), ...calledFound];
    const [resumed] = await resumeWith(history);
    expect(resumed.request.tools).toEqual(pageTools);
    expect(withoutMarkers(resumed.request.messages[3])).toEqual(history[3]);
    expect(resumed.options).toEqual(BETA);
  });

  test('on a model that cannot read additions, the saved ones are folded into tools', async () => {
    process.env.GATE_IB_TOOL_ADDITIONS = 'true';
    const [resumed] = await resumeWith([...savedRound(), ...calledFound], sonnetRouter);
    expect(resumed.request.messages.some(m => m.role === 'system')).toBe(false);
    expect(resumed.request.tools.filter(t => t.name === 'get_review_stats')).toHaveLength(1);
    expect(resumed.options).toBeUndefined();
  });
});
