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

  test('a resumed task never uses tool search, whatever its history holds and the gate reads', () => {
    process.env.GATE_IB_TOOL_SEARCH = 'true';
    expect(ToolSearch.toolSearchWanted(resumed([]), true, owner)).toBe(false);
    expect(ToolSearch.toolSearchWanted(resumed(searchBlocks), true, owner)).toBe(false);
    delete process.env.GATE_IB_TOOL_SEARCH;
    expect(ToolSearch.toolSearchWanted(resumed(searchBlocks), true, owner)).toBe(false);
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
    expect(ToolSearch.SEARCH_LINE).toContain('call discover_capabilities once');
    expect(ToolSearch.SEARCH_LINE).not.toContain(ToolSearch.DISCOVER_LINE);
    expect(gapReportPromptLine()).toContain('discover_capabilities');
    expect(gapReportPromptLine({ toolSearch: true })).toContain('tool search');
    expect(gapReportPromptLine({ toolSearch: true })).toContain('discover_capabilities once');
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
      { status: 'capabilities_found', capabilities: [{ id: 'get_review_stats', domain: 'review' }] }, { fromToolSearch: true });
    expect(collector.discovery).toHaveBeenNthCalledWith(2, { query: 'frobnicate' }, { status: 'capability_unimplemented', capabilities: [] }, { fromToolSearch: true });
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

describe('stripServerSearchBlocks', () => {
  const use = id => ({ type: 'server_tool_use', id, name: 'tool_search_tool_bm25', input: { query: 'q' } });
  const res = id => ({ type: 'tool_search_tool_result', tool_use_id: id, content: { type: 'tool_search_tool_search_result', tool_references: [] } });
  const strip = ToolSearch.stripServerSearchBlocks;

  test('nothing to strip: the same array identity comes back', () => {
    const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }];
    expect(strip(messages)).toBe(messages);
    expect(strip([])).toEqual([]);
  });

  test('a resolved pair is removed and the other blocks are kept in order', () => {
    const tool = { type: 'tool_use', id: 't1', name: 'x', input: {} };
    const out = strip([{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }, use('s1'), res('s1'), tool] }]);
    expect(out).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }, tool] }]);
  });

  test('an unresolved call is removed too', () => {
    const out = strip([{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }, use('s1')] }]);
    expect(out[1].content).toEqual([{ type: 'text', text: 'a' }]);
  });

  test('a search-only assistant message is dropped and the neighbours of the same role are merged', () => {
    const out = strip([{ role: 'user', content: 'first' }, { role: 'assistant', content: [use('s1'), res('s1')] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] }]);
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }]);
    // A paused search-only tail leaves the history ending on the user turn.
    expect(strip([{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('s2')] }])).toEqual([{ role: 'user', content: 'q' }]);
  });

  test('a trailing assistant tool_use with no result is left alone, no result is invented', () => {
    const tool = { type: 'tool_use', id: 't1', name: 'x', input: {} };
    const out = strip([{ role: 'user', content: 'q' }, { role: 'assistant', content: [use('s1'), tool] }]);
    expect(out).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: [tool] }]);
  });

  test('the input is not mutated, and unchanged messages keep their identity', () => {
    const plain = { role: 'user', content: 'q' };
    const messages = [plain, { role: 'assistant', content: [use('s1'), res('s1'), { type: 'text', text: 'a' }] }];
    const before = JSON.stringify(messages);
    const out = strip(messages);
    expect(JSON.stringify(messages)).toBe(before);
    expect(out[0]).toBe(plain);
    expect(out).not.toBe(messages);
  });
});

describe('mergeDiscoveredTools', () => {
  test('a found deferred tool is loaded in place; a new one is appended; names stay unique', () => {
    const tools = [{ name: 'a' }, { name: 'b', defer_loading: true }, { name: 'd', defer_loading: true }];
    const out = ToolSearch.mergeDiscoveredTools(tools, [{ name: 'b' }, { name: 'c' }, { name: 'c' }]);
    expect(out).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'd', defer_loading: true }, { name: 'c' }]);
    expect(tools).toEqual([{ name: 'a' }, { name: 'b', defer_loading: true }, { name: 'd', defer_loading: true }]);
  });

  test('nothing to load: the same array comes back', () => {
    const tools = [{ name: 'a' }, { name: 'b', defer_loading: true }];
    expect(ToolSearch.mergeDiscoveredTools(tools, [{ name: 'a' }])).toBe(tools);
    expect(ToolSearch.mergeDiscoveredTools(tools, [])).toBe(tools);
  });
});

// Codex round 8: a signed thinking block inside a rewritten assistant turn is rejected.
describe('stripServerSearchBlocks and thinking blocks', () => {
  const search = [
    { type: 'server_tool_use', id: 'srvtoolu_t1', name: 'tool_search_tool_bm25', input: { query: 'x' } },
    { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_t1', content: { type: 'tool_search_tool_search_result', tool_references: [] } },
  ];
  const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig' };
  const redacted = { type: 'redacted_thinking', data: 'opaque' };

  test('a rewritten assistant message loses its thinking blocks', () => {
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [thinking, redacted, ...search, { type: 'text', text: 'answer' }] },
    ];
    const out = ToolSearch.stripServerSearchBlocks(messages);
    expect(out[1].content).toEqual([{ type: 'text', text: 'answer' }]);
    expect(messages[1].content).toHaveLength(5);
  });

  test('an untouched assistant message keeps its thinking blocks, by identity', () => {
    const untouched = { role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'a', input: {} }] };
    const messages = [
      { role: 'user', content: 'q' }, untouched,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      { role: 'assistant', content: [...search, { type: 'text', text: 'done' }] },
    ];
    expect(ToolSearch.stripServerSearchBlocks(messages)[1]).toBe(untouched);
  });

  test('a message that held only thinking and search blocks is dropped', () => {
    const messages = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [thinking, ...search] }, { role: 'user', content: 'more' }];
    const out = ToolSearch.stripServerSearchBlocks(messages);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });
});
