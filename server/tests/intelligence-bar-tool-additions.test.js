/**
 * GATE_IB_TOOL_ADDITIONS helpers (tool-additions.js) and the OpenAI backup's
 * fold of them (ib-openai-backup.js backupRequestState). The route-level
 * request shapes are in admin-intelligence-bar-tool-additions.test.js.
 */
const ToolAdditions = require('../services/intelligence-bar/tool-additions');
const { backupRequestState } = require('../services/intelligence-bar/ib-openai-backup');

const tool = (name, description = `${name} tool`) => ({ name, description, input_schema: { type: 'object', properties: {} } });
const results = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{}' }] };
const call = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'discover_capabilities', input: { query: 'x' } }] };
const question = { role: 'user', content: [{ type: 'text', text: 'q' }] };

describe('toolAdditionsWanted', () => {
  afterEach(() => { delete process.env.GATE_IB_TOOL_ADDITIONS; });

  test('needs the gate, the platform path, no tool search and a model that takes additions', () => {
    const base = { platformEnabled: true, toolSearch: false, model: 'claude-opus-5-5' };
    expect(ToolAdditions.toolAdditionsWanted(base)).toBe(false);
    process.env.GATE_IB_TOOL_ADDITIONS = 'true';
    expect(ToolAdditions.toolAdditionsWanted(base)).toBe(true);
    expect(ToolAdditions.toolAdditionsWanted({ ...base, platformEnabled: false })).toBe(false);
    expect(ToolAdditions.toolAdditionsWanted({ ...base, toolSearch: true })).toBe(false);
    // Claude Sonnet 5 is not on the docs' list; an unknown or dated id fails closed.
    for (const model of ['claude-sonnet-5', 'claude-mythos-preview', 'test-model', 'claude-opus-5-5-20260101', undefined]) {
      expect(ToolAdditions.toolAdditionsWanted({ ...base, model })).toBe(false);
    }
    process.env.GATE_IB_TOOL_ADDITIONS = 'TRUE';
    expect(ToolAdditions.toolAdditionsWanted(base)).toBe(false);
  });

  test('a resume whose saved history holds an addition keeps the path with the gate off, on a model that takes it', () => {
    const saved = [question, call, results, ToolAdditions.additionMessage([tool('cancel_plan')])];
    const base = { platformEnabled: true, toolSearch: false, model: 'claude-opus-5-5' };
    expect(ToolAdditions.toolAdditionsWanted({ ...base, saved })).toBe(true);
    expect(ToolAdditions.toolAdditionsWanted({ ...base, saved: [question, call, results] })).toBe(false);
    expect(ToolAdditions.toolAdditionsWanted({ ...base, saved, model: 'claude-sonnet-5' })).toBe(false);
  });
});

describe('createRequestState', () => {
  test('queue keeps only names neither `tools` nor an earlier addition holds; offers() sees them at once', () => {
    const state = ToolAdditions.createRequestState({ enabled: true, messages: [question] });
    expect(state.queue([tool('get_customer_detail'), tool('cancel_plan')], [tool('get_customer_detail')])).toBe(true);
    expect(state.queue([tool('cancel_plan'), tool('get_review_stats')], [])).toBe(true);
    expect(state.pending().map(d => d.name)).toEqual(['cancel_plan', 'get_review_stats']);
    expect(state.offers('cancel_plan')).toBe(true);
    expect(state.offers('get_customer_detail')).toBe(false); // in `tools`: the route's own check covers it
  });

  test('off: queue refuses, so the caller merges into `tools`; nothing is ever appended', () => {
    const state = ToolAdditions.createRequestState({ enabled: false, messages: [question] });
    expect(state.queue([tool('cancel_plan')], [])).toBe(false);
    const history = [question, call, results];
    expect(state.beforeCall(history, false)).toBe(history);
  });

  test('beforeCall appends ONE addition message after the tool results, then nothing until a new find', () => {
    const state = ToolAdditions.createRequestState({ enabled: true, messages: [question] });
    state.queue([tool('cancel_plan'), tool('get_review_stats')], []);
    const history = [question, call, results];
    const next = state.beforeCall(history, false);
    expect(next.slice(0, 3)).toEqual(history);
    expect(next[3]).toEqual(ToolAdditions.additionMessage([tool('cancel_plan'), tool('get_review_stats')]));
    expect(next[3].content.map(b => [b.type, b.tool.type, b.tool.definition.name])).toEqual([
      ['tool_addition', 'tool_definition', 'cancel_plan'], ['tool_addition', 'tool_definition', 'get_review_stats'],
    ]);
    expect(state.pending()).toEqual([]);
    expect(state.beforeCall(next, false)).toBe(next);
  });

  test('the final round and a paused assistant turn get no addition; the find still waits', () => {
    const state = ToolAdditions.createRequestState({ enabled: true, messages: [question] });
    state.queue([tool('cancel_plan')], []);
    const history = [question, call, results];
    expect(state.beforeCall(history, true)).toBe(history);
    const paused = [question, { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} }] }];
    expect(state.beforeCall(paused, false)).toBe(paused);
    expect(state.pending().map(d => d.name)).toEqual(['cancel_plan']);
  });

  test('a resumed history: its added names count as offered and are not queued again', () => {
    const saved = [question, call, results, ToolAdditions.additionMessage([tool('cancel_plan')])];
    const state = ToolAdditions.createRequestState({ enabled: true, messages: saved });
    expect(state.offers('cancel_plan')).toBe(true);
    state.queue([tool('cancel_plan')], []);
    expect(state.pending()).toEqual([]);
  });

  test('restore, on: the tools to restore wait for the next call and `tools` comes back as the same array', () => {
    const saved = [question, call, results, ToolAdditions.additionMessage([tool('cancel_plan')])];
    const state = ToolAdditions.createRequestState({ enabled: true, messages: saved });
    const tools = [tool('discover_capabilities')];
    expect(state.restore([tool('discover_capabilities'), tool('cancel_plan'), tool('get_review_stats')], tools)).toBe(tools);
    expect(state.pending().map(d => d.name)).toEqual(['get_review_stats']);
  });

  test('restore, off: the tools join `tools` once each, as before', () => {
    const state = ToolAdditions.createRequestState({ enabled: false, messages: [question, call, results] });
    const restored = state.restore([tool('discover_capabilities'), tool('get_review_stats')], [tool('discover_capabilities')]);
    expect(restored.map(t => t.name)).toEqual(['discover_capabilities', 'get_review_stats']);
    expect(state.pending()).toEqual([]);
  });

  test('stop() drops what waits and turns later finds back into merges', () => {
    const state = ToolAdditions.createRequestState({ enabled: true, messages: [question] });
    state.queue([tool('cancel_plan')], []);
    state.stop();
    expect(state.pending()).toEqual([]);
    expect(state.queue([tool('get_review_stats')], [])).toBe(false);
  });
});

describe('requestOptions', () => {
  test('the beta header only when the sent messages hold an addition', () => {
    expect(ToolAdditions.requestOptions([question, call, results])).toBeUndefined();
    expect(ToolAdditions.requestOptions([question, call, results, ToolAdditions.additionMessage([tool('a')])]))
      .toEqual({ headers: { 'anthropic-beta': 'inline-tools-2026-09-15' } });
  });
});

describe('foldAdditions and forModel', () => {
  const added = [question, call, results, ToolAdditions.additionMessage([tool('cancel_plan')]),
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] }];

  test('the added and waiting definitions join `tools` (a later definition wins); the messages leave', () => {
    const { tools, messages } = ToolAdditions.foldAdditions({
      tools: [tool('discover_capabilities'), tool('cancel_plan', 'old')], messages: added, pending: [tool('get_review_stats')],
    });
    expect(tools.map(t => [t.name, t.description])).toEqual([
      ['discover_capabilities', 'discover_capabilities tool'], ['cancel_plan', 'cancel_plan tool'], ['get_review_stats', 'get_review_stats tool'],
    ]);
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  test('nothing to fold: the same arrays come back', () => {
    const tools = [tool('discover_capabilities')];
    const messages = [question, call, results];
    const out = ToolAdditions.foldAdditions({ tools, messages });
    expect(out.tools).toBe(tools);
    expect(out.messages).toBe(messages);
  });

  test('forModel folds a saved history only for a model that cannot read additions', () => {
    const tools = [tool('discover_capabilities')];
    expect(ToolAdditions.forModel({ tools, messages: added, model: 'claude-opus-5-5' })).toEqual({ tools, messages: added });
    const folded = ToolAdditions.forModel({ tools, messages: added, model: 'claude-sonnet-5' });
    expect(folded.tools.map(t => t.name)).toEqual(['discover_capabilities', 'cancel_plan']);
    expect(folded.messages.some(ToolAdditions.isAdditionMessage)).toBe(false);
  });
});

describe('withoutTrailingAddition (resume)', () => {
  test('a saved history that ends on an addition loses it, so the resume user turn may follow; any other comes back as is', () => {
    const endsOnAddition = [question, call, results, ToolAdditions.additionMessage([tool('cancel_plan')])];
    expect(ToolAdditions.withoutTrailingAddition(endsOnAddition)).toEqual([question, call, results]);
    const midAddition = [...endsOnAddition, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, question];
    expect(ToolAdditions.withoutTrailingAddition(midAddition)).toBe(midAddition);
    const plain = [question, call, results];
    expect(ToolAdditions.withoutTrailingAddition(plain)).toBe(plain);
  });
});

describe('OpenAI backup switch (backupRequestState)', () => {
  test('the backup gets the added and waiting tools in `tools` and a history without addition messages', () => {
    const next = backupRequestState({
      tools: [tool('discover_capabilities')],
      messages: [question, call, results, ToolAdditions.additionMessage([tool('cancel_plan')])],
      pendingTools: [tool('get_review_stats')],
      context: 'dashboard',
      actionScope: { role: 'admin', context: 'dashboard', fullAccess: true },
    });
    expect(next.tools.map(t => t.name)).toEqual(['discover_capabilities', 'cancel_plan', 'get_review_stats']);
    expect(next.messages.some(m => m.role === 'system')).toBe(false);
    expect(next.toolSearch).toBe(false);
  });
});
