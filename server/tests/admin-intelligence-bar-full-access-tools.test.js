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

async function ask(token, context, turns = [{ content: [{ type: 'text', text: 'ok' }], usage: {} }], { path = '/query', body: requestBody, status = 200 } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, stack: err.stack }));
  const server = app.listen(0);
  try {
    mockMessagesCreate.mockReset();
    IbTasks.checkpoint.mockClear();
    for (const turn of turns) mockMessagesCreate.mockResolvedValueOnce(turn);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/intelligence-bar${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody || { prompt: 'anything', context }),
    });
    const body = await res.json();
    expect({ status: res.status, error: body.error, stack: body.stack }).toEqual(status === 200 ? { status: 200, error: undefined, stack: undefined } : { status, error: body.error, stack: undefined });
    return { body, reply: repliedText(), requests: mockMessagesCreate.mock.calls.map(([request]) => request) };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const systemText = request => request.system.map(block => block.text).join('\n');
const pageToolNames = context => names(registry.initialTools(context, { role: 'admin', context }));

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
      expect(names(tools).filter(name => name === 'discover_capabilities')).toHaveLength(1);
      expect(tools.filter(t => t.type === 'tool_search_tool_bm25_20251119')).toHaveLength(1);
      expect(new Set(names(tools)).size).toBe(tools.length);
      expect(tools.some(t => t.cache_control)).toBe(false);
      expect(tools.filter(t => t.defer_loading).length).toBeGreaterThan(150);
    }
  });

  test('the system prompt names the searchable areas, keeps discover_capabilities as the fallback, and is the same on repeat', async () => {
    const first = (await ask('owner', 'dashboard')).requests[0];
    const again = (await ask('owner', 'dashboard')).requests[0];
    expect(systemText(first)).toBe(systemText(again));
    expect(systemText(first)).toContain(ToolSearch.SEARCH_LINE);
    expect(systemText(first)).toContain('banking and tax, and outside services');
    expect(systemText(first)).toContain('call discover_capabilities once');
    expect(systemText(first)).not.toContain(ToolSearch.DISCOVER_LINE);
    expect(first.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('another admin keeps the page list, discover_capabilities and the old prompt line', async () => {
    const { requests: [request] } = await ask('otheradmin', 'dashboard');
    expect(names(request.tools)).toEqual(pageToolNames('dashboard'));
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

  const discoverTurns = (query, domain) => [
    { content: [{ type: 'tool_use', id: 'toolu_disc', name: 'discover_capabilities', input: domain ? { query, domain } : { query } }], usage: {}, stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'ok' }], usage: {} },
  ];
  // The JSON result (the plain string form; a references-only result has no JSON).
  const discoverResult = (requests) => JSON.parse(requests[1].messages[requests[1].messages.length - 1].content
    .find(b => b.type === 'tool_result' && b.tool_use_id === 'toolu_disc').content);

  const resultBlock = (requests, index = 1) => requests[index].messages[requests[index].messages.length - 1].content
    .find(b => b.type === 'tool_result' && b.tool_use_id === 'toolu_disc');

  test('discover_capabilities on the search path reports an owner-workflow action with no reference, and the tools never change', async () => {
    const { requests } = await ask('owner', 'dashboard', discoverTurns('request instant payout', 'banking'));
    const payout = discoverResult(requests).capabilities.find(c => c.id === 'request_instant_payout');
    expect(payout).toMatchObject({ approval: 'confirmed_endpoint', availability: 'requires_existing_owner_workflow' });
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(names(requests[1].tools)).not.toContain('request_instant_payout');
    // A result holding an owner-workflow action is the JSON string, with no references.
    expect(typeof resultBlock(requests).content).toBe('string');
  });

  test('a result made of tools comes back as tool_reference blocks only (max 5); request 2 has the same tools', async () => {
    const { requests } = await ask('owner', 'dashboard', discoverTurns('review stats'));
    const content = resultBlock(requests).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.every(part => part.type === 'tool_reference')).toBe(true);
    expect(content.length).toBeLessThanOrEqual(5);
    expect(content.map(part => part.tool_name)).toContain('get_review_stats');
    // Every reference names a deferred tool in `tools`, which did not change.
    expect(requests[1].tools).toEqual(requests[0].tools);
    for (const part of content) expect(requests[1].tools.find(t => t.name === part.tool_name).defer_loading).toBe(true);
  });

  test('mixed rounds: the tools array is identical on every request of the live request', async () => {
    const search = (id) => ({ type: 'server_tool_use', id, name: 'tool_search_tool_bm25', input: { query: 'review stats' } });
    const resolved = (id) => ({ type: 'tool_search_tool_result', tool_use_id: id, content: { type: 'tool_search_tool_search_result', tool_references: [] } });
    const turns = [
      // A server search pending next to a discover call.
      { content: [search('srvtoolu_m'), { type: 'tool_use', id: 'toolu_disc', name: 'discover_capabilities', input: { query: 'review stats' } }], usage: {}, stop_reason: 'tool_use' },
      // The search resolves in the same response as a client call.
      { content: [resolved('srvtoolu_m'), { type: 'tool_use', id: 'toolu_e', name: 'offer_choices', input: { options: ['A', 'B'] } }], usage: {}, stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'ok' }], usage: {} },
    ];
    const { requests } = await ask('owner', 'dashboard', turns);
    expect(requests).toHaveLength(3);
    for (const request of requests.slice(1)) expect(request.tools).toEqual(requests[0].tools);
  });

  test('off the search path the found definition is still merged at once and the result stays a string', async () => {
    delete process.env.GATE_IB_TOOL_SEARCH;
    const { requests } = await ask('owner', 'dashboard', discoverTurns('review stats'));
    expect(typeof resultBlock(requests).content).toBe('string');
    expect(requests[1].tools.filter(t => t.name === 'get_review_stats')).toHaveLength(1);
    expect(requests[1].tools.find(t => t.name === 'get_review_stats').defer_loading).toBeUndefined();
    expect(requests[0].tools.some(t => t.name === 'get_review_stats')).toBe(false);
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
    expect(names(owner.tools)).toEqual(pageToolNames('dashboard'));
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

// A resumed task never uses tool search: the saved search blocks are stripped on
// load and the request runs on the ordinary list with discover_capabilities.
describe('a resumed task runs on the ordinary tool list', () => {
  const RESUME = '/tasks/7e1c2f7a-1111-2222-3333-deadbeef0009/resume';
  const SESSION = '7e1c2f7a-1111-2222-3333-deadbeef0008';
  const taskWith = (checkpoint) => ({
    id: '7e1c2f7a-1111-2222-3333-deadbeef0009', state: 'awaiting_approval', session_id: SESSION,
    request_key: 'resume-key-0002', runner_token: '7e1c2f7a-1111-2222-3333-deadbeef0007',
    request: { prompt: 'look up the numbers', context: 'dashboard', pageData: {} },
    checkpoint: JSON.parse(JSON.stringify(checkpoint)), target: null, response: null,
  });
  const RECEIPTS = [{ tool: 'block_sender', outcome: 'completed' }];
  const resumeWith = (checkpoint) => {
    IbTasks.claimResume.mockReset();
    IbTasks.claimResume.mockResolvedValue({ task: taskWith(checkpoint), receipts: RECEIPTS });
    IbTasks.get.mockReset();
    IbTasks.get.mockResolvedValue(taskWith(checkpoint));
  };
  const searchUse = id => ({ type: 'server_tool_use', id, name: 'tool_search_tool_bm25', input: { query: 'review numbers' } });
  const searchResult = (id, names = []) => ({ type: 'tool_search_tool_result', tool_use_id: id,
    content: { type: 'tool_search_tool_search_result', tool_references: names.map(tool_name => ({ type: 'tool_reference', tool_name })) } });
  const blocksOf = messages => messages.flatMap(m => (Array.isArray(m.content) ? m.content : []));
  const continuationCount = messages => JSON.stringify(messages).split('Continue the original request').length - 1;
  const resume = (token, turns) => ask(token, 'dashboard', turns, { path: RESUME, body: { session_id: SESSION } });

  // The resumed request carries no server blocks, no defer_loading, no search tool; roles never
  // repeat for assistants and nothing is empty; the receipts turn appears exactly once.
  function expectOrdinaryResume(request) {
    expect(blocksOf(request.messages).some(b => b.type === 'server_tool_use' || b.type === 'tool_search_tool_result')).toBe(false);
    expect(request.tools.some(t => t.defer_loading || t.type || t.name === 'tool_search_tool_bm25')).toBe(false);
    expect(names(request.tools)[0]).toBe('discover_capabilities');
    expect(systemText(request)).toContain(ToolSearch.DISCOVER_LINE);
    request.messages.forEach((message, index) => {
      expect(message.content.length).toBeGreaterThan(0);
      if (message.role === 'assistant') expect(request.messages[index - 1]?.role).not.toBe('assistant');
    });
    expect(request.messages[request.messages.length - 1].role).toBe('user');
    expect(continuationCount(request.messages)).toBe(1);
    expect(JSON.stringify(request.messages)).toContain('block_sender');
  }

  beforeEach(() => { process.env.GATE_IB_TOOL_SEARCH = 'true'; delete process.env.GATE_IB_MERGE_CUSTOMERS; });
  afterEach(() => { delete process.env.GATE_IB_TOOL_SEARCH; });

  test('(a) a resolved search, a deferred-tool call and a card: stripped, the used tool is loaded once and not deferred', async () => {
    resumeWith([
      { role: 'user', content: 'review numbers, then block that sender' },
      { role: 'assistant', content: [searchUse('srvtoolu_a'), searchResult('srvtoolu_a', ['get_review_stats']),
        { type: 'tool_use', id: 'toolu_a', name: 'get_review_stats', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: '{}' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'block_sender', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: '{"status":"pending_confirmation"}' }] },
    ]);
    const { requests } = await resume('owner');
    const request = requests[0];
    expectOrdinaryResume(request);
    // The deferred tool the history already called is loaded eagerly, once.
    expect(request.tools.filter(t => t.name === 'get_review_stats')).toHaveLength(1);
    expect(request.tools.find(t => t.name === 'get_review_stats').defer_loading).toBeUndefined();
    expect(request.tools.filter(t => t.name === 'block_sender')).toHaveLength(1);
    // The calls and their results stay paired.
    const kinds = blocksOf(request.messages).map(b => `${b.type}:${b.id || b.tool_use_id || ''}`);
    expect(kinds).toEqual(expect.arrayContaining(['tool_use:toolu_a', 'tool_result:toolu_a', 'tool_use:toolu_b', 'tool_result:toolu_b']));
  });

  test('(b) a paused search-only assistant tail: dropped, the history ends on the user turn with the receipts once', async () => {
    resumeWith([{ role: 'user', content: 'look up the numbers' }, { role: 'assistant', content: [searchUse('srvtoolu_p')] }]);
    const { requests } = await resume('owner');
    expectOrdinaryResume(requests[0]);
    expect(requests[0].messages.some(m => m.role === 'assistant')).toBe(false);
  });

  test('(c) a trailing tool_result turn with an unresolved search: stripped, no search call left', async () => {
    resumeWith([
      { role: 'user', content: 'review numbers' },
      { role: 'assistant', content: [searchUse('srvtoolu_u'), { type: 'tool_use', id: 'toolu_u', name: 'offer_choices', input: { options: ['A', 'B'] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_u', content: '{}' }] },
    ]);
    const { requests } = await resume('owner');
    expectOrdinaryResume(requests[0]);
    expect(blocksOf(requests[0].messages).filter(b => b.type === 'tool_use').map(b => b.id)).toEqual(['toolu_u']);
  });

  test('(d) a saved discover result with tool_reference blocks: references stripped, the called tool loaded once', async () => {
    const found = 'Tools found: get_review_stats.';
    resumeWith([
      { role: 'user', content: 'review numbers please' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_d1', name: 'discover_capabilities', input: { query: 'review stats' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_d1', content: [{ type: 'tool_reference', tool_name: 'get_review_stats' }] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_d2', name: 'get_review_stats', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_d2', content: '{}' }] },
    ]);
    const { requests } = await resume('owner');
    const request = requests[0];
    expectOrdinaryResume(request);
    expect(JSON.stringify(request.messages)).not.toContain('tool_reference');
    const discoverResult = blocksOf(request.messages).find(b => b.type === 'tool_result' && b.tool_use_id === 'toolu_d1');
    expect(discoverResult.content).toBe(found);
    expect(request.tools.filter(t => t.name === 'get_review_stats')).toHaveLength(1);
    expect(request.tools.find(t => t.name === 'get_review_stats').defer_loading).toBeUndefined();
  });

  test('a login that lost full access resumes on the ordinary list, and an owner-only tool call is refused by the existing guard', async () => {
    resumeWith([
      { role: 'user', content: 'resolve that issue' },
      { role: 'assistant', content: [searchUse('srvtoolu_o'), searchResult('srvtoolu_o', ['resolve_sentry_issue']),
        { type: 'tool_use', id: 'toolu_o', name: 'resolve_sentry_issue', input: { issue_short_id: 'WAVES-PORTAL-1A' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_o', content: '{"status":"pending_confirmation"}' }] },
    ]);
    const turns = [
      { content: [{ type: 'tool_use', id: 'toolu_o2', name: 'resolve_sentry_issue', input: { issue_short_id: 'WAVES-PORTAL-1A' } }], usage: {}, stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Cannot do that.' }], usage: {} },
    ];
    const { requests } = await resume('otheradmin', turns);
    expectOrdinaryResume(requests[0]);
    expect(names(requests[0].tools)).not.toContain('resolve_sentry_issue');
    const refusal = requests[1].messages[requests[1].messages.length - 1].content.find(b => b.type === 'tool_result' && b.tool_use_id === 'toolu_o2');
    expect(refusal.is_error).toBe(true);
    expect(refusal.content).toMatch(/permission_denied|capability_not_loaded/);
  });

  test('a fresh request after the same gate still gets tool search (only a resume is ordinary)', async () => {
    const { requests } = await ask('owner', 'dashboard');
    expect(requests[0].tools.some(t => t.name === 'tool_search_tool_bm25')).toBe(true);
  });
});
