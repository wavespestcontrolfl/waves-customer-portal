process.env.JWT_SECRET = 'synthetic-ib-test';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ToolSearch = require('../services/intelligence-bar/tool-search');
const { gapReportPromptLine } = require('../services/agent-gap-reports');

const owner = { role: 'admin', context: 'dashboard', fullAccess: true };
const searchBlocks = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'x' } },
  { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [] } },
];
const resumed = content => ({ ibResumedTask: { checkpoint: [{ role: 'assistant', content }] } });

describe('toolSearchWanted', () => {
  afterEach(() => { delete process.env.GATE_IB_TOOL_SEARCH; });

  test('follows the gate for a fresh full-access request on the platform path', () => {
    expect(ToolSearch.toolSearchWanted({}, true, owner)).toBe(false);
    process.env.GATE_IB_TOOL_SEARCH = 'true';
    expect(ToolSearch.toolSearchWanted({}, true, owner)).toBe(true);
    expect(ToolSearch.toolSearchWanted({}, false, owner)).toBe(false);
    expect(ToolSearch.toolSearchWanted({}, true, { ...owner, fullAccess: false })).toBe(false);
  });

  test('a resumed task whose history holds tool-search blocks keeps tool search even if the gate is off now', () => {
    expect(ToolSearch.toolSearchWanted(resumed(searchBlocks), true, owner)).toBe(true);
    // Still never for a login without full access.
    expect(ToolSearch.toolSearchWanted(resumed(searchBlocks), true, { ...owner, fullAccess: false })).toBe(false);
  });

  test('a resumed task that already used discover_capabilities stays on that list even with the gate on', () => {
    process.env.GATE_IB_TOOL_SEARCH = 'true';
    const discovered = [{ type: 'tool_use', id: 'tu_1', name: 'discover_capabilities', input: { query: 'x' } }];
    expect(ToolSearch.toolSearchWanted(resumed(discovered), true, owner)).toBe(false);
    // A history with neither follows the gate.
    expect(ToolSearch.toolSearchWanted(resumed([{ type: 'text', text: 'hi' }]), true, owner)).toBe(true);
  });
});

describe('round helpers', () => {
  test('a paused turn with no client tool call is not finished; a plain one is', () => {
    expect(ToolSearch.finishesTurn({ stop_reason: 'pause_turn' }, [])).toBe(false);
    expect(ToolSearch.finishesTurn({ stop_reason: 'end_turn' }, [])).toBe(true);
    expect(ToolSearch.finishesTurn({ stop_reason: 'tool_use' }, [{}])).toBe(false);
  });

  test('assistant content is carried unchanged; no empty user message for a paused turn', () => {
    const response = { content: searchBlocks };
    expect(ToolSearch.appendRoundMessages([], response, [])).toEqual([{ role: 'assistant', content: searchBlocks }]);
    const results = [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{}' }];
    expect(ToolSearch.appendRoundMessages([{ role: 'user', content: 'q' }], response, results)).toEqual([
      { role: 'user', content: 'q' }, { role: 'assistant', content: searchBlocks }, { role: 'user', content: results },
    ]);
  });

  test('the prompt line names the areas for tool search and the gap line stops naming discover_capabilities', () => {
    expect(ToolSearch.capabilitySearchLine(true)).toBe(ToolSearch.SEARCH_LINE);
    expect(ToolSearch.capabilitySearchLine(false)).toBe(ToolSearch.DISCOVER_LINE);
    expect(ToolSearch.SEARCH_LINE).not.toContain('discover_capabilities');
    expect(gapReportPromptLine()).toContain('discover_capabilities');
    expect(gapReportPromptLine({ toolSearch: true })).not.toContain('discover_capabilities');
    expect(gapReportPromptLine({ toolSearch: true })).toContain('tool search');
  });
});

describe('observeServerToolSearches feeds the gap collector', () => {
  const found = (id, names) => ({ type: 'tool_search_tool_result', tool_use_id: id,
    content: { type: 'tool_search_tool_search_result', tool_references: names.map(tool_name => ({ type: 'tool_reference', tool_name })) } });
  const query = (id, text) => ({ type: 'server_tool_use', id, name: 'tool_search_tool_bm25', input: { query: text } });

  test('found = the referenced registered tools with their domains; nothing found = capability_unimplemented', () => {
    const collector = { discovery: jest.fn() };
    ToolSearch.observeServerToolSearches([query('s1', 'review numbers'), found('s1', ['get_review_stats', 'not_a_tool']),
      query('s2', 'frobnicate'), found('s2', [])], collector);
    expect(collector.discovery).toHaveBeenNthCalledWith(1, { query: 'review numbers' },
      { status: 'capabilities_found', capabilities: [{ id: 'get_review_stats', domain: 'review' }] });
    expect(collector.discovery).toHaveBeenNthCalledWith(2, { query: 'frobnicate' }, { status: 'capability_unimplemented', capabilities: [] });
  });

  test('an error result, plain text and a missing collector record nothing and do not throw', () => {
    const collector = { discovery: jest.fn() };
    ToolSearch.observeServerToolSearches([query('s3', 'x'), { type: 'tool_search_tool_result', tool_use_id: 's3',
      content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' } }, { type: 'text', text: 'hi' }], collector);
    expect(collector.discovery).not.toHaveBeenCalled();
    expect(() => ToolSearch.observeServerToolSearches(searchBlocks, null)).not.toThrow();
  });
});

describe('wire shape', () => {
  const registry = require('../services/intelligence-bar/action-registry');
  const apiToolDefinition = require('../services/intelligence-bar/tool-definition');

  test('defer_loading and strict survive, the typed search tool passes through, local metadata never leaves', () => {
    const list = registry.initialTools('dashboard', { ...owner, toolSearch: true }).map(apiToolDefinition);
    expect(list.find(t => t.type === 'tool_search_tool_bm25_20251119')).toEqual({ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' });
    const deferred = list.filter(t => t.defer_loading === true);
    expect(deferred.length).toBeGreaterThan(100);
    for (const tool of list) {
      expect(Object.keys(tool).some(key => key.startsWith('_'))).toBe(false);
      if (tool.defer_loading) expect(tool.cache_control).toBeUndefined();
    }
    // At least one tool is not deferred, or the API answers 400.
    expect(list.some(t => !t.defer_loading)).toBe(true);
    expect(deferred.some(t => t.strict === true)).toBe(registry.initialTools('dashboard', { ...owner, toolSearch: true })
      .filter(t => t.defer_loading).some(t => t.strict === true));
  });
});

describe('dropMissingToolReferences', () => {
  const ref = tool_name => ({ type: 'tool_reference', tool_name });
  const result = (id, names) => ({ type: 'tool_search_tool_result', tool_use_id: id, content: { type: 'tool_search_tool_search_result', tool_references: names.map(ref) } });
  const use = id => ({ type: 'server_tool_use', id, name: 'tool_search_tool_bm25', input: { query: 'q' } });
  const tools = names => names.map(name => ({ name }));
  const history = (...blocks) => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: blocks }];

  test('nothing missing: the same array identity comes back', () => {
    const messages = history(use('s1'), result('s1', ['a', 'b']));
    expect(ToolSearch.dropMissingToolReferences(messages, tools(['a', 'b', 'c']))).toBe(messages);
    const plain = [{ role: 'user', content: 'hi' }];
    expect(ToolSearch.dropMissingToolReferences(plain, tools(['a']))).toBe(plain);
  });

  test('one missing reference is removed, the others kept, the server_tool_use stays', () => {
    const messages = history(use('s1'), result('s1', ['a', 'gone', 'b']), { type: 'text', text: 'ok' });
    const out = ToolSearch.dropMissingToolReferences(messages, tools(['a', 'b']));
    expect(out).not.toBe(messages);
    expect(out[0]).toBe(messages[0]);
    expect(out[1].content[0]).toBe(messages[1].content[0]);
    expect(out[1].content[1].content.tool_references).toEqual([ref('a'), ref('b')]);
    expect(out[1].content[2]).toBe(messages[1].content[2]);
  });

  test('all missing: the block stays with an empty list', () => {
    const out = ToolSearch.dropMissingToolReferences(history(use('s1'), result('s1', ['x', 'y'])), tools(['a']));
    expect(out[1].content[1]).toEqual({ type: 'tool_search_tool_result', tool_use_id: 's1',
      content: { type: 'tool_search_tool_search_result', tool_references: [] } });
    expect(out[1].content[0].type).toBe('server_tool_use');
  });

  test('error results and other blocks are untouched, and the input is not mutated', () => {
    const error = { type: 'tool_search_tool_result', tool_use_id: 's2', content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' } };
    const messages = history(use('s1'), result('s1', ['a', 'gone']), error, { type: 'tool_use', id: 'toolu_1', name: 'gone', input: {} });
    const before = JSON.stringify(messages);
    const out = ToolSearch.dropMissingToolReferences(messages, tools(['a']));
    expect(JSON.stringify(messages)).toBe(before);
    expect(out[1].content[2]).toBe(error);
    expect(out[1].content[3]).toBe(messages[1].content[3]);
  });
});

describe('round 5 helpers', () => {
  const use = (id, query = 'q') => ({ type: 'server_tool_use', id, name: 'tool_search_tool_bm25', input: { query } });
  const res = (id, names = []) => ({ type: 'tool_search_tool_result', tool_use_id: id,
    content: { type: 'tool_search_tool_search_result', tool_references: names.map(tool_name => ({ type: 'tool_reference', tool_name })) } });

  test('pendingServerToolIds: a call stays open until a result with its id appears, in any later message', () => {
    const messages = [{ role: 'assistant', content: [use('s1'), use('s2'), res('s2')] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: '{}' }] }];
    expect([...ToolSearch.pendingServerToolIds(messages)]).toEqual(['s1']);
    expect(ToolSearch.pendingServerToolIds([...messages, { role: 'assistant', content: [res('s1')] }]).size).toBe(0);
  });

  test('1: a terminal response that resolves an open search is kept; any other terminal response is not', () => {
    const history = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('s1'), { type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] }];
    const closing = { content: [res('s1'), { type: 'text', text: 'ok' }] };
    expect(ToolSearch.withTerminalResponse(history, closing, true)).toEqual([...history, { role: 'assistant', content: closing.content }]);
    expect(ToolSearch.withTerminalResponse(history, closing, false)).toBe(history);
    expect(ToolSearch.withTerminalResponse(history, { content: [{ type: 'text', text: 'ok' }] }, true)).toBe(history);
    expect(ToolSearch.withTerminalResponse([{ role: 'user', content: 'q' }], closing, true).length).toBe(1);
  });

  test('2: queries live across responses: a result in a later response reports the right query, an empty one too', () => {
    const collector = { discovery: jest.fn() };
    const queries = new Map();
    ToolSearch.observeServerToolSearches([use('s1', 'timesheets for the crew'), { type: 'tool_use', id: 't1', name: 'x', input: {} }], collector, queries);
    expect(collector.discovery).not.toHaveBeenCalled();
    ToolSearch.observeServerToolSearches([res('s1'), { type: 'text', text: 'none' }], collector, queries);
    expect(collector.discovery).toHaveBeenCalledWith({ query: 'timesheets for the crew' }, { status: 'capability_unimplemented', capabilities: [] });
  });

  test('2: the queries are seeded from a saved history on resume', () => {
    const task = { checkpoint: [{ role: 'assistant', content: [use('s9', 'old question')] }] };
    expect(ToolSearch.seedSearchQueries(task).get('s9')).toBe('old question');
    expect(ToolSearch.seedSearchQueries(undefined).size).toBe(0);
  });

  test('3: on the search path the restored tools never replace the array', () => {
    const tools = [{ name: 'a' }, { name: 'b', defer_loading: true }];
    expect(ToolSearch.mergeRestoredTools(tools, [{ name: 'b' }], true)).toBe(tools);
    expect(ToolSearch.mergeRestoredTools(tools, [{ name: 'b' }], false)).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  test('4: a saved search task is refused for a login without full access, and only then', () => {
    const task = { checkpoint: [{ role: 'assistant', content: [use('s1'), res('s1')] }] };
    expect(ToolSearch.resumeAccessRefusal(task, false)).toMatchObject({ code: 'access_changed' });
    expect(ToolSearch.resumeAccessRefusal(task, true)).toBeNull();
    expect(ToolSearch.resumeAccessRefusal({ checkpoint: [{ role: 'user', content: 'hi' }] }, false)).toBeNull();
    expect(ToolSearch.resumeAccessRefusal(null, false)).toBeNull();
  });

  test('6: a paused history is kept as is and the turn held; other histories get the turn', () => {
    const paused = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('s1')] }];
    const held = { turn: null };
    expect(ToolSearch.withResumeTurn(paused, 'CONTINUE', true, held)).toBe(paused);
    expect(held.turn).toBe('CONTINUE');
    const other = { turn: null };
    expect(ToolSearch.withResumeTurn(paused, 'CONTINUE', false, other)).toEqual([...paused, { role: 'user', content: 'CONTINUE' }]);
    const done = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('s1'), res('s1')] }];
    expect(ToolSearch.withResumeTurn(done, 'CONTINUE', true, other)).toEqual([...done, { role: 'user', content: 'CONTINUE' }]);
    expect(other.turn).toBeNull();
  });

  test('6: a held turn is released behind the tool results once nothing is unresolved, not before', () => {
    const paused = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('s1')] }];
    const held = { turn: 'CONTINUE' };
    const results = [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }];
    // Still unresolved (another call in the response): results only.
    const stillOpen = { content: [use('s2'), { type: 'tool_use', id: 't1', name: 'x', input: {} }] };
    expect(ToolSearch.appendRoundMessages(paused, stillOpen, results, held).slice(-1)[0].content).toEqual(results);
    expect(held.turn).toBe('CONTINUE');
    // A paused response with no results keeps holding.
    expect(ToolSearch.appendRoundMessages(paused, { content: [res('s1')] }, [], held).length).toBe(3);
    expect(held.turn).toBe('CONTINUE');
    // Resolved with results: the turn rides behind them as text, once.
    const resolved = { content: [res('s1'), { type: 'tool_use', id: 't1', name: 'x', input: {} }] };
    const out = ToolSearch.appendRoundMessages(paused, resolved, results, held);
    expect(out[out.length - 1].content).toEqual([...results, { type: 'text', text: 'CONTINUE' }]);
    expect(held.turn).toBeNull();
  });
});
