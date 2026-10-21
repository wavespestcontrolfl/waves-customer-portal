/**
 * ib-openai-backup.js (GATE_IB_OPENAI_BACKUP): which errors switch the request,
 * what the request runs on after the switch, and the saved-task mark.
 */
const mockUpdate = jest.fn(async () => 1);
const mockRaw = jest.fn((sql, bindings) => ({ sql, bindings }));
const mockWhere = jest.fn(() => ({ update: mockUpdate }));
jest.mock('../models/db', () => Object.assign(jest.fn(() => ({ where: mockWhere })), { raw: (...a) => mockRaw(...a), fn: { now: jest.fn() } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Backup = require('../services/intelligence-bar/ib-openai-backup');
const ActionRegistry = require('../services/intelligence-bar/action-registry');
const ToolSearch = require('../services/intelligence-bar/tool-search');
const IbTasks = require('../services/intelligence-bar/tasks');
const Adapter = require('../services/intelligence-bar/openai-tool-adapter');

describe('isProviderError', () => {
  const err = (status, message = '', extra = {}) => Object.assign(new Error(message), { status }, extra);

  test.each([
    ['limit 400 (10-19 case)', err(400, '400 {"message":"You have reached your specified API usage limits. You will regain access on 2026-11-01"}')],
    ['credit balance 400', err(400, 'Your credit balance is too low to access the Anthropic API')],
    ['auth', err(401)], ['payment', err(402)], ['forbidden', err(403)], ['model gone', err(404)],
    ['request timeout', err(408)], ['rate limit', err(429)], ['server', err(500)], ['overloaded', err(529)], ['gateway', err(502)],
    ['SDK connection error', Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })],
    ['SDK timeout', Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })],
    ['socket code', Object.assign(new Error('x'), { code: 'ECONNRESET' })],
  ])('%s is a provider error', (_label, error) => {
    expect(Backup.isProviderError(error)).toBe(true);
  });

  test.each([
    ['invalid request 400', err(400, 'tools.3.custom.input_schema: input_schema does not support oneOf')],
    ['too large', err(413, 'request_too_large')],
    ['unprocessable', err(422, 'bad')],
    ['plain TypeError', new TypeError('x is not a function')],
    ['tool error with no status', new Error('relation "foo" does not exist')],
    ['null', null],
  ])('%s is not', (_label, error) => {
    expect(Backup.isProviderError(error)).toBe(false);
  });
});

describe('backupRequestState', () => {
  const actionScope = { role: 'admin', context: 'customers', fullAccess: true };
  const searchTools = () => ActionRegistry.initialTools('customers', { ...actionScope, toolSearch: true }).map(t => ({ ...t }));

  test('a request on tool search gets the ordinary list plus discover_capabilities, keeps tools it already loaded, loses the server blocks', () => {
    const tools = searchTools();
    expect(tools.some(t => t.defer_loading === true)).toBe(true);
    expect(tools.some(t => t.type && t.type !== 'custom')).toBe(true);
    const deferred = tools.find(t => t.defer_loading === true).name;
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      { role: 'assistant', content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'x' } },
        { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: deferred }] } },
        { type: 'tool_use', id: 'toolu_1', name: deferred, input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }] },
    ];
    const next = Backup.backupRequestState({ tools, messages, context: 'customers', actionScope });
    expect(next.toolSearch).toBe(false);
    expect(next.tools.some(t => t.defer_loading === true || (t.type && t.type !== 'custom'))).toBe(false);
    expect(next.tools.map(t => t.name)).toContain(ActionRegistry.DISCOVERY_TOOL.name);
    expect(next.tools.map(t => t.name)).toContain(deferred); // loaded earlier in this request
    expect(new Set(next.tools.map(t => t.name)).size).toBe(next.tools.length);
    expect(JSON.stringify(next.messages)).not.toMatch(/srvtoolu_|server_tool_use|tool_search_tool_result/);
    expect(next.messages.flatMap(m => m.content).filter(b => b.type === 'tool_use' || b.type === 'tool_result').map(b => b.tool_use_id || b.id)).toEqual(['toolu_1', 'toolu_1']);
  });

  test('a request already on the ordinary list keeps its tools', () => {
    const tools = ActionRegistry.initialTools('customers', { ...actionScope, toolSearch: false }).map(t => ({ ...t }));
    const next = Backup.backupRequestState({ tools, messages: [{ role: 'user', content: 'hi' }], context: 'customers', actionScope });
    expect(next.tools).toBe(tools);
  });
});

describe('backupSystemPrompt', () => {
  test('swaps the tool-search sentence for discover_capabilities and leaves the rest alone', () => {
    const prompt = `A\n${ToolSearch.SEARCH_LINE}\nB`;
    expect(Backup.backupSystemPrompt(prompt)).toBe(`A\n${ToolSearch.DISCOVER_LINE}\nB`);
    expect(Backup.backupSystemPrompt('no search line here')).toBe('no search line here');
  });
});

describe('saved task provider', () => {
  const task = (request, extra = {}) => ({ id: 't', state: 'failed', request, checkpoint: [], lease_expires_at: new Date(0), ...extra });
  afterEach(() => { delete process.env.GATE_IB_OPENAI_BACKUP; });

  test('taskOnBackup reads the mark', () => {
    expect(Backup.taskOnBackup(task({ model_provider: 'openai_backup' }))).toBe(true);
    expect(Backup.taskOnBackup(task({}))).toBe(false);
    expect(Backup.taskOnBackup(null)).toBe(false);
  });

  test('a backup task resumes only while the gate is on; an unmarked task is unaffected', () => {
    const marked = task({ model_provider: 'openai_backup' });
    expect(IbTasks.continuationError(marked, [])).toMatchObject({ code: 'not_resumable' });
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    expect(IbTasks.continuationError(marked, [])).toBeNull();
    delete process.env.GATE_IB_OPENAI_BACKUP;
    expect(IbTasks.continuationError(task({}), [])).toBeNull();
  });

  test('markModelProvider merges the mark into the task request under the runner token', async () => {
    await IbTasks.markModelProvider('t1', 'actor-1', 'runner-1', Backup.BACKUP_PROVIDER);
    expect(mockWhere).toHaveBeenCalledWith({ id: 't1', actor_id: 'actor-1', runner_token: 'runner-1' });
    expect(mockRaw).toHaveBeenCalledWith('request || ?::jsonb', [JSON.stringify({ model_provider: 'openai_backup' })]);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('resume of a backup task after a tool round', () => {
  const actionScope = { role: 'admin', context: 'customers', fullAccess: false };
  const reasoning = (id, enc = `enc_${id}`) => ({ type: 'reasoning', id, summary: [], ...(enc ? { encrypted_content: enc } : {}) });
  const call = (id, call_id) => ({ type: 'function_call', id, call_id, name: 'query_customers', arguments: '{}', status: 'completed' });
  const history = round => [
    { role: 'user', content: [{ type: 'text', text: 'find' }] },
    { role: 'assistant', content: round.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"ok":1}' }] },
  ];
  const resumed = (messages, extra = {}) => {
    const live = { tools: [], messages: JSON.parse(JSON.stringify(messages)), systemPrompt: 'SYS' };
    const applied = [];
    const caller = Backup.createModelCaller({
      context: 'customers', actionScope, task: { request: { model_provider: 'openai_backup' } }, finalMessages: m => m,
      read: () => live, apply: next => { Object.assign(live, next); applied.push(next); }, markTask: async () => {}, ...extra,
    });
    return { caller, live };
  };

  afterEach(() => { delete process.env.GATE_IB_OPENAI_BACKUP; });

  test('the checkpointed round still carries its reasoning: the resumed request replays it', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    const { caller, live } = resumed(history(Adapter.fromOpenAIResponse({ output: [reasoning('rs_1'), call('fc_1', 'c1')] })));
    await caller.startFromTask();
    expect(Adapter.toInputItems(live.messages).map(i => i.id || i.role || `out:${i.call_id}`)).toEqual(['user', 'rs_1', 'fc_1', 'out:c1']);
    expect(caller.answerSuffix()).toMatch(/answered by the backup model/);
  });

  test('a round whose reasoning cannot be replayed is dropped with its result: no function_call goes out without its reasoning', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    const { caller, live } = resumed(history(Adapter.fromOpenAIResponse({ output: [reasoning('rs_1', null), call('fc_1', 'c1')] })));
    await caller.startFromTask();
    const items = Adapter.toInputItems(live.messages);
    expect(items.map(i => i.type || i.role)).toEqual(['user']);
    expect(JSON.stringify(live.messages)).not.toMatch(/_openai|"c1"/);
  });

  test('with the gate off nothing is switched', async () => {
    const { caller, live } = resumed(history(Adapter.fromOpenAIResponse({ output: [reasoning('rs_1'), call('fc_1', 'c1')] })));
    await caller.startFromTask();
    expect(caller.answerSuffix()).toBe('');
    expect(JSON.stringify(live.messages)).toMatch(/_openai/);
  });
});
