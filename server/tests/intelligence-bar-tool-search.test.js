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
