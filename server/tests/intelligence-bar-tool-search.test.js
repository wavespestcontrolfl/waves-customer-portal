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

  test('a model that thinks by default never uses tool search; the current flagship does', () => {
    process.env.GATE_IB_TOOL_SEARCH = 'true';
    expect(ToolSearch.toolSearchWanted({}, true, owner, 'claude-opus-4-8')).toBe(true);
    expect(ToolSearch.toolSearchWanted({}, true, owner, 'claude-opus-5-5')).toBe(false);
    // Haiku 5.5 thinks by default too, and so does any later family numbered 5+.
    for (const model of ['claude-haiku-5-5', 'claude-haiku-5-5-20270101', 'claude-opus-6', 'claude-sonnet-7-1']) expect(ToolSearch.toolSearchWanted({}, true, owner, model)).toBe(false);
    for (const model of ['claude-haiku-4-5-20251001', 'claude-opus-4-8', 'claude-opus-4-10']) expect(ToolSearch.toolSearchWanted({}, true, owner, model)).toBe(true);
    expect(ToolSearch.toolSearchWanted({}, true, owner, 'claude-sonnet-5')).toBe(false);
    expect(ToolSearch.toolSearchWanted({}, true, owner, 'claude-fable-5-1')).toBe(false);
    expect(ToolSearch.toolSearchWanted({}, true, owner, 'claude-sonnet-4-6')).toBe(true);
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

describe('mergeDiscoveredTools (off the search path only)', () => {
  test('appends the names not present, once each; the search path never changes the array', () => {
    const tools = [{ name: 'a' }, { name: 'b' }];
    expect(ToolSearch.mergeDiscoveredTools(tools, [{ name: 'b' }, { name: 'c' }, { name: 'c' }], false)).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    expect(tools).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(ToolSearch.mergeDiscoveredTools(tools, [{ name: 'a' }], false)).toBe(tools);
    expect(ToolSearch.mergeDiscoveredTools(tools, [{ name: 'c' }], true)).toBe(tools);
  });
});

// A history never holds search blocks AND thinking blocks (toolSearchWanted is off for a
// model that thinks by default); if one does, it is not rewritten and the resume is refused.
describe('search blocks and thinking blocks', () => {
  const search = [
    { type: 'server_tool_use', id: 'srvtoolu_t1', name: 'tool_search_tool_bm25', input: { query: 'x' } },
    { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_t1', content: { type: 'tool_search_tool_search_result', tool_references: [] } },
  ];
  const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig' };
  const call = { type: 'tool_use', id: 'toolu_c1', name: 'block_sender', input: {} };

  test('hasSearchAndThinking: only an assistant turn holding both', () => {
    expect(ToolSearch.hasSearchAndThinking([{ role: 'user', content: 'q' }, { role: 'assistant', content: [thinking, ...search] }])).toBe(true);
    expect(ToolSearch.hasSearchAndThinking([{ role: 'user', content: 'q' }, { role: 'assistant', content: [...search, call] }])).toBe(false);
    expect(ToolSearch.hasSearchAndThinking([{ role: 'assistant', content: [thinking, call] }])).toBe(false);
    expect(ToolSearch.hasSearchAndThinking(undefined)).toBe(false);
  });

  test('the strip does not rewrite a history that holds both: the same array comes back', () => {
    const messages = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [thinking, ...search, { type: 'text', text: 'a' }] }];
    expect(ToolSearch.stripServerSearchBlocks(messages)).toBe(messages);
  });

  test('a thinking-only history (no search blocks) resumes untouched: same array identity', () => {
    const messages = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [thinking, call] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1', content: '{}' }] }];
    expect(ToolSearch.stripServerSearchBlocks(messages)).toBe(messages);
  });

  test('a turn with search blocks and no thinking keeps its tool blocks and their results', () => {
    const answer = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1', content: '{}' }] };
    const out = ToolSearch.stripServerSearchBlocks([{ role: 'user', content: 'q' }, { role: 'assistant', content: [...search, call] }, answer]);
    expect(out[1].content).toEqual([call]);
    expect(out[2]).toBe(answer);
  });

  test('the resume is refused with the not_resumable shape, before any claim', () => {
    const { continuationError } = require('../services/intelligence-bar/tasks');
    const task = { state: 'awaiting_approval', request: {}, checkpoint: [{ role: 'assistant', content: [thinking, ...search] }] };
    expect(continuationError(task, [{ outcome: 'completed' }])).toEqual({
      error: 'This saved request cannot be continued after a model change. Start the request again.', code: 'not_resumable' });
    const fine = { ...task, checkpoint: [{ role: 'assistant', content: search }] };
    expect(continuationError(fine, [{ outcome: 'completed' }])).toBeNull();
  });
});

describe('hasPendingServerSearch', () => {
  const use = id => ({ type: 'server_tool_use', id, name: 'tool_search_tool_bm25', input: { query: 'q' } });
  const res = id => ({ type: 'tool_search_tool_result', tool_use_id: id, content: { type: 'tool_search_tool_search_result', tool_references: [] } });
  const msgs = (...blocks) => [{ role: 'user', content: 'q' }, { role: 'assistant', content: blocks }];

  test('a call without a result is pending until a result with its id appears, even in a later message', () => {
    expect(ToolSearch.hasPendingServerSearch(msgs(use('s1')))).toBe(true);
    expect(ToolSearch.hasPendingServerSearch(msgs(use('s1'), res('s1')))).toBe(false);
    expect(ToolSearch.hasPendingServerSearch([...msgs(use('s1')), { role: 'assistant', content: [res('s1')] }])).toBe(false);
    expect(ToolSearch.hasPendingServerSearch([...msgs(use('s1'), res('s1'), use('s2'))])).toBe(true);
    expect(ToolSearch.hasPendingServerSearch([{ role: 'user', content: 'q' }])).toBe(false);
  });
});

// Pre-push audit: the step-limit note must not end a turn whose server search is unresolved.
describe('withTurnEndingText', () => {
  const pendingUse = { type: 'server_tool_use', id: 'srvtoolu_p1', name: 'tool_search_tool_bm25', input: { query: 'x' } };
  const result = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' };
  const call = { type: 'tool_use', id: 'toolu_1', name: 'a', input: {} };

  test('adds the text after the client tool results', () => {
    const messages = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [call] }, { role: 'user', content: [result] }];
    const out = ToolSearch.withTurnEndingText(messages, 'NOTE');
    expect(out[2].content).toEqual([result, { type: 'text', text: 'NOTE' }]);
    expect(messages[2].content).toEqual([result]);
  });

  test('adds nothing while a server search of the turn is unresolved', () => {
    const messages = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [pendingUse, call] }, { role: 'user', content: [result] }];
    expect(ToolSearch.withTurnEndingText(messages, 'NOTE')).toBe(messages);
  });

  test('a string or assistant tail is left alone', () => {
    const a = [{ role: 'user', content: 'q' }];
    const b = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [call] }];
    expect(ToolSearch.withTurnEndingText(a, 'NOTE')).toBe(a);
    expect(ToolSearch.withTurnEndingText(b, 'NOTE')).toBe(b);
  });
});

describe('toolResultContent (discover_capabilities on the search path)', () => {
  const found = (...ids) => ({ status: 'capabilities_found', capabilities: ids.map(([id, availability]) => ({ id, availability })) });
  const tools = [{ name: 'eager_tool' }, { name: 'deferred_tool', defer_loading: true }, { name: 'other_deferred', defer_loading: true }];
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `deferred_${i}`, defer_loading: true }));

  test('a result made only of tools returns tool_reference blocks ONLY, never mixed with text', () => {
    const content = ToolSearch.toolResultContent('discover_capabilities', found(['deferred_tool', 'loaded']), tools, true);
    expect(content).toEqual([{ type: 'tool_reference', tool_name: 'deferred_tool' }]);
  });

  test('the references keep discover()\'s ranking order and stop at five', () => {
    const result = found(...many.map(tool => [tool.name, 'loaded']));
    const content = ToolSearch.toolResultContent('discover_capabilities', result, many, true);
    expect(content.map(part => part.tool_name)).toEqual(['deferred_0', 'deferred_1', 'deferred_2', 'deferred_3', 'deferred_4']);
    expect(content.every(part => part.type === 'tool_reference')).toBe(true);
    const reversed = found(['other_deferred', 'loaded'], ['deferred_tool', 'loaded']);
    expect(ToolSearch.toolResultContent('discover_capabilities', reversed, tools, true).map(part => part.tool_name)).toEqual(['other_deferred', 'deferred_tool']);
  });

  test('eager tools need no reference: they are skipped, the deferred ones are referenced', () => {
    const content = ToolSearch.toolResultContent('discover_capabilities', found(['eager_tool', 'loaded'], ['deferred_tool', 'loaded']), tools, true);
    expect(content).toEqual([{ type: 'tool_reference', tool_name: 'deferred_tool' }]);
    const result = found(['eager_tool', 'loaded'], ['not_in_tools', 'loaded']);
    expect(ToolSearch.toolResultContent('discover_capabilities', result, tools, true)).toBe(JSON.stringify(result));
  });

  test('a result that also holds an owner-workflow action is the JSON string, with no references', () => {
    const result = found(['deferred_tool', 'loaded'], ['request_instant_payout', 'requires_existing_owner_workflow']);
    const content = ToolSearch.toolResultContent('discover_capabilities', result, tools, true);
    expect(content).toBe(JSON.stringify(result));
    expect(typeof content).toBe('string');
  });

  test('off the search path, for another tool, or for an error result: the plain JSON string', () => {
    const result = found(['deferred_tool', 'loaded']);
    expect(ToolSearch.toolResultContent('discover_capabilities', result, tools, false)).toBe(JSON.stringify(result));
    expect(ToolSearch.toolResultContent('query_customers', result, tools, true)).toBe(JSON.stringify(result));
    expect(ToolSearch.toolResultContent('discover_capabilities', { error: 'x', code: 'invalid_input' }, tools, true)).toBe('{"error":"x","code":"invalid_input"}');
  });
});

describe('stripServerSearchBlocks and tool_reference blocks in tool_result content', () => {
  const call = { type: 'tool_use', id: 'toolu_d', name: 'discover_capabilities', input: { query: 'q' } };
  const ref = tool_name => ({ type: 'tool_reference', tool_name });
  const messages = content => [{ role: 'user', content: 'q' }, { role: 'assistant', content: [call] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_d', content }] }];

  test('a references-only result becomes the JSON a discover result has; the input is not mutated', () => {
    const input = messages([ref('get_review_stats'), ref('draft_review_reply')]);
    const before = JSON.stringify(input);
    const out = ToolSearch.stripServerSearchBlocks(input);
    const text = out[2].content[0].content;
    expect(JSON.parse(text)).toEqual({ status: 'capabilities_found', capabilities: [
      { id: 'get_review_stats', availability: 'loaded' }, { id: 'draft_review_reply', availability: 'loaded' }] });
    expect(JSON.stringify(input)).toBe(before);
    expect(out[1]).toBe(input[1]);
  });

  test('the resume code that reads discovered names finds them in that JSON', () => {
    const text = ToolSearch.stripServerSearchBlocks(messages([ref('a'), ref('b')]))[2].content[0].content;
    // Same shape as the route: JSON.parse inside a try, 'loaded' capabilities only.
    const names = (() => { try { return JSON.parse(text)?.capabilities || []; } catch { return []; } })()
      .filter(capability => capability?.availability === 'loaded').map(capability => capability.id);
    expect(names).toEqual(['a', 'b']);
  });

  test('a tool_result left with no names and no text gets a short text, never an empty array', () => {
    const content = ToolSearch.stripServerSearchBlocks(messages([{ type: 'tool_reference' }]))[2].content[0].content;
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
  });

  test('a history with a plain string result has nothing to strip: same array', () => {
    const plain = messages('{}');
    expect(ToolSearch.stripServerSearchBlocks(plain)).toBe(plain);
  });
});

// Codex round 16: names the API's search returned are restored on resume.
describe('searchReferencedNames', () => {
  const result = (id, names) => ({ type: 'tool_search_tool_result', tool_use_id: id, content: { type: 'tool_search_tool_search_result', tool_references: names.map(tool_name => ({ type: 'tool_reference', tool_name })) } });
  test('collects each referenced name once, from every saved search result', () => {
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'server_tool_use', id: 's1', name: 'tool_search_tool_bm25', input: { query: 'x' } }, result('s1', ['a', 'b'])] },
      { role: 'assistant', content: [result('s2', ['b', 'c'])] },
    ];
    expect(ToolSearch.searchReferencedNames(messages)).toEqual(['a', 'b', 'c']);
  });
  test('an error result, a string message and a missing checkpoint give no names', () => {
    const error = { type: 'tool_search_tool_result', tool_use_id: 's3', content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' } };
    expect(ToolSearch.searchReferencedNames([{ role: 'user', content: 'q' }, { role: 'assistant', content: [error] }])).toEqual([]);
    expect(ToolSearch.searchReferencedNames(undefined)).toEqual([]);
  });
});
