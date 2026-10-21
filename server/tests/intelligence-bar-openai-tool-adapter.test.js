/**
 * openai-tool-adapter.js (GATE_IB_OPENAI_BACKUP): Anthropic tools / messages in,
 * Responses API function tools / input items out, and the reply back into
 * Anthropic blocks. Ids must survive the round trip.
 */
process.env.OPENAI_API_KEY = 'test-openai-key';

const mockLedgerCall = jest.fn((provider, model, fn) => fn());
const mockLedgerRejected = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => ({
  ledgerCall: (...args) => mockLedgerCall(...args),
  ledgerCallRejected: (...args) => mockLedgerRejected(...args),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Adapter = require('../services/intelligence-bar/openai-tool-adapter');

const tool = (name, extra = {}) => ({
  name,
  description: `${name} tool`,
  input_schema: { type: 'object', properties: { search: { type: 'string' } }, required: ['search'] },
  ...extra,
});

describe('toOpenAITools', () => {
  test('keeps name, description and a JSON schema; strips Anthropic-only keys; skips server tools', () => {
    const tools = Adapter.toOpenAITools([
      tool('query_customers', {
        defer_loading: true,
        cache_control: { type: 'ephemeral' },
        input_schema: {
          $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', oneOf: [{ required: ['a'] }],
          properties: { examples: { type: 'string' }, nested: { type: 'object', examples: [1], properties: { a: { type: 'number', $comment: 'x' } } } },
        },
      }),
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      { type: 'web_search_20250305', name: 'web_search' },
      tool('query_customers'), // duplicate name
      { name: 'no_schema' },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'function', name: 'query_customers', description: 'query_customers tool', strict: false });
    expect(tools[0].parameters).toEqual({
      type: 'object',
      properties: { examples: { type: 'string' }, nested: { type: 'object', properties: { a: { type: 'number' } } } },
    });
    expect(JSON.stringify(tools)).not.toMatch(/defer_loading|cache_control|\$schema|oneOf/);
  });

  test('a tool with an empty schema still gets an object with properties', () => {
    const [t] = Adapter.toOpenAITools([{ name: 'ping', input_schema: { type: 'object' } }]);
    expect(t.parameters).toEqual({ type: 'object', properties: {} });
    expect(t.description).toBe('');
  });
});

describe('toInputItems', () => {
  const messages = [
    { role: 'user', content: 'plain first turn' },
    { role: 'assistant', content: 'plain reply' },
    { role: 'user', content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'what is it', cache_control: { type: 'ephemeral' } },
    ] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'hmm', signature: 's' },
      { type: 'redacted_thinking', data: 'x' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: {} },
      { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: {} },
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'toolu_A', name: 'query_customers', input: { search: 'Jeff' } },
      { type: 'tool_use', id: 'toolu_B', name: 'get_invoice', input: { id: 7 } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_A', content: '{"total":1}' },
      { type: 'tool_result', tool_use_id: 'toolu_B', content: '{"error":"nope"}', is_error: true },
      { type: 'text', text: '[Step limit reached.]' },
    ] },
  ];

  test('converts text, images, tool_use and tool_result in order, dropping thinking and search blocks', () => {
    expect(Adapter.toInputItems(messages)).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'plain first turn' }] },
      { role: 'assistant', content: 'plain reply' },
      { role: 'user', content: [
        { type: 'input_text', text: 'look at this' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        { type: 'input_text', text: 'what is it' },
      ] },
      { role: 'assistant', content: 'checking' },
      { type: 'function_call', call_id: 'toolu_A', name: 'query_customers', arguments: '{"search":"Jeff"}' },
      { type: 'function_call', call_id: 'toolu_B', name: 'get_invoice', arguments: '{"id":7}' },
      { type: 'function_call_output', call_id: 'toolu_A', output: '{"total":1}' },
      { type: 'function_call_output', call_id: 'toolu_B', output: 'ERROR: {"error":"nope"}' },
      { role: 'user', content: [{ type: 'input_text', text: '[Step limit reached.]' }] },
    ]);
  });

  test('every function_call has exactly one output and no output is orphaned', () => {
    const items = Adapter.toInputItems([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'a', input: {} }, { type: 'tool_use', id: 'c2', name: 'b', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'ok' }, { type: 'tool_result', tool_use_id: 'gone', content: 'stray' }] },
    ]);
    const calls = items.filter(i => i.type === 'function_call').map(i => i.call_id);
    const outputs = items.filter(i => i.type === 'function_call_output').map(i => i.call_id);
    expect(calls).toEqual(['c1', 'c2']);
    expect(outputs.sort()).toEqual(['c1', 'c2']);
    expect(items.find(i => i.call_id === 'c1' && i.type === 'function_call_output').output).toMatch(/No result was recorded/);
  });

  test('a tool-search form of discover_capabilities (tool_reference blocks) becomes the plain capability JSON', () => {
    const [, output] = Adapter.toInputItems([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'd1', name: 'discover_capabilities', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd1', content: [{ type: 'tool_reference', tool_name: 'get_invoice' }] }] },
    ]);
    expect(JSON.parse(output.output)).toEqual({ status: 'capabilities_found', capabilities: [{ id: 'get_invoice', availability: 'loaded' }] });
  });

  test('empty assistant turns and unusable images add nothing', () => {
    expect(Adapter.toInputItems([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'f' } }] },
    ])).toEqual([]);
  });
});

describe('fromOpenAIResponse', () => {
  test('function calls become tool_use blocks that keep the call_id, text becomes text blocks', () => {
    const reply = Adapter.fromOpenAIResponse({
      id: 'resp_9', model: 'gpt-test', status: 'completed', usage: { input_tokens: 4, output_tokens: 2 },
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'Let me check.' }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_77', name: 'query_customers', arguments: '{"search":"Jeff"}' },
      ],
    });
    expect(reply).toMatchObject({
      id: 'resp_9', model: 'gpt-test', role: 'assistant', stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: 2 },
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'call_77', name: 'query_customers', input: { search: 'Jeff' } },
      ],
    });
  });

  test('round trip: a reply\'s tool_use sent back as history keeps its id on the call and the output', () => {
    const reply = Adapter.fromOpenAIResponse({ output: [{ type: 'function_call', call_id: 'call_rt', name: 'q', arguments: '{"a":1}' }] });
    const items = Adapter.toInputItems([
      { role: 'assistant', content: reply.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: reply.content[0].id, content: '{}' }] },
    ]);
    expect(items).toEqual([
      { type: 'function_call', call_id: 'call_rt', name: 'q', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'call_rt', output: '{}' },
    ]);
  });

  test('stop reasons: end_turn for text, max_tokens when cut off, refusal for a refusal; bad arguments become {}', () => {
    expect(Adapter.fromOpenAIResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }).stop_reason).toBe('end_turn');
    expect(Adapter.fromOpenAIResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }).stop_reason).toBe('max_tokens');
    expect(Adapter.fromOpenAIResponse({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }).stop_reason).toBe('refusal');
    // Unparseable or non-object arguments fail the round: no tool runs on an empty input (Codex r3).
    for (const bad of ['{"a":', '[1,2]', '"text"', 'null', '7']) {
      expect(() => Adapter.fromOpenAIResponse({ output: [{ type: 'function_call', call_id: 'c', name: 'q', arguments: bad }] }))
        .toThrow(expect.objectContaining({ code: 'function_arguments_invalid' }));
    }
    expect(Adapter.fromOpenAIResponse({ output: [{ type: 'function_call', call_id: 'c', name: 'q', arguments: '' }] }).content[0].input).toEqual({});
    expect(Adapter.fromOpenAIResponse({ output: [{ type: 'function_call', call_id: 'c', name: 'q', arguments: '{}' }] }).content[0].input).toEqual({});
    expect(Adapter.fromOpenAIResponse({}).content).toEqual([]);
  });
});

describe('reasoning replay', () => {
  const reasoning = (id, enc = `enc_${id}`) => ({ type: 'reasoning', id, summary: [], ...(enc ? { encrypted_content: enc } : {}) });
  const fc = (id, call_id) => ({ type: 'function_call', id, call_id, name: 'q', arguments: '{"a":1}', status: 'completed' });

  test('a reply with reasoning is replayed in its original order, with ids, instead of the plain conversion', () => {
    const reply = Adapter.fromOpenAIResponse({ output: [
      reasoning('rs_1'), { type: 'message', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text: 'Checking.' }] }, fc('fc_1', 'call_1'),
    ] });
    const items = Adapter.toInputItems([
      { role: 'assistant', content: reply.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{}' }] },
    ]);
    expect(items.map(i => i.id || `out:${i.call_id}`)).toEqual(['rs_1', 'msg_1', 'fc_1', 'out:call_1']);
    expect(items[0]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc_rs_1' });
    expect(items[2]).toMatchObject({ type: 'function_call', call_id: 'call_1', arguments: '{"a":1}' });
  });

  test('a trailing reasoning item is dropped; a round missing encrypted content falls back to the plain conversion', () => {
    const trailing = Adapter.fromOpenAIResponse({ output: [reasoning('rs_1'), fc('fc_1', 'c1'), reasoning('rs_2')] });
    expect(Adapter.toInputItems([{ role: 'assistant', content: trailing.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }] }]).map(i => i.id || `out:${i.call_id}`))
      .toEqual(['rs_1', 'fc_1', 'out:c1']);
    const bare = Adapter.fromOpenAIResponse({ output: [reasoning('rs_1', null), fc('fc_1', 'c1')] });
    const plain = Adapter.toInputItems([{ role: 'assistant', content: bare.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }] }]);
    expect(plain.map(i => i.type)).toEqual(['function_call', 'function_call_output']);
    expect(plain[0].id).toBeUndefined();
  });

  test('the saved round survives a checkpoint (JSON) round trip and is replayed on a resume', () => {
    const reply = Adapter.fromOpenAIResponse({ output: [reasoning('rs_1'), fc('fc_1', 'c1')] });
    const saved = JSON.parse(JSON.stringify([{ role: 'assistant', content: reply.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }] }]));
    expect(Adapter.toInputItems(saved).map(i => i.id || `out:${i.call_id}`)).toEqual(['rs_1', 'fc_1', 'out:c1']);
  });

  test('a saved round that no longer matches its blocks, or has lost the private field, converts without reasoning', () => {
    const reply = Adapter.fromOpenAIResponse({ output: [reasoning('rs_1'), fc('fc_1', 'c1')] });
    const results = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }] }];
    const stripped = reply.content.map(({ _openai, ...block }) => block);
    expect(Adapter.toInputItems([{ role: 'assistant', content: stripped }, ...results]).map(i => i.type)).toEqual(['function_call', 'function_call_output']);
    const mismatched = reply.content.map(block => ({ ...block, id: 'other' }));
    expect(Adapter.toInputItems([{ role: 'assistant', content: mismatched }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'other', content: 'x' }] }]).map(i => i.type))
      .toEqual(['function_call', 'function_call_output']);
  });

  test('reasoning that cannot be replayed on a round with calls is flagged; a round with no reasoning is not', () => {
    const flagged = Adapter.fromOpenAIResponse({ output: [reasoning('rs_1', null), fc('fc_1', 'c1')] });
    expect(flagged.content[0]._openai).toEqual({ unreplayable: true });
    expect(Adapter.fromOpenAIResponse({ output: [fc('fc_1', 'c1')] }).content[0]._openai).toBeUndefined();
  });
});

describe('only completed function calls run', () => {
  test.each([
    ['an in_progress call', { output: [{ type: 'function_call', call_id: 'c', name: 'q', arguments: '{}', status: 'in_progress' }] }],
    ['an incomplete call', { status: 'incomplete', output: [{ type: 'function_call', call_id: 'c', name: 'q', arguments: '{"a"', status: 'incomplete' }] }],
    ['a call with no status in an incomplete response', { status: 'incomplete', output: [{ type: 'function_call', call_id: 'c', name: 'q', arguments: '{}' }] }],
  ])('%s fails the round (no tool_use)', (_label, data) => {
    expect(() => Adapter.fromOpenAIResponse(data)).toThrow(expect.objectContaining({ code: 'openai_incomplete' }));
  });

  test('completed calls, and a call with no status in a completed response, become tool_use', () => {
    expect(Adapter.fromOpenAIResponse({ status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'q', arguments: '{}', status: 'completed' }] }).stop_reason).toBe('tool_use');
    expect(Adapter.fromOpenAIResponse({ status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'q', arguments: '{}' }] }).stop_reason).toBe('tool_use');
  });
});

describe('requestBody', () => {
  const base = { model: 'gpt-5.6-sol', system: 'SYS', tools: [tool('q')], messages: [{ role: 'user', content: 'hi' }] };

  test('never stores, carries instructions and function tools, and forbids tools on the final round', () => {
    const body = Adapter.requestBody({ ...base, finalRound: false });
    expect(body).toMatchObject({ store: false, instructions: 'SYS', tool_choice: 'auto', parallel_tool_calls: true, reasoning: { effort: 'medium' }, include: ['reasoning.encrypted_content'] });
    expect(body.tools).toHaveLength(1);
    expect(Adapter.requestBody({ ...base, finalRound: true }).tool_choice).toBe('none');
    expect(Adapter.requestBody({ ...base, tech: true }).reasoning).toEqual({ effort: 'low' });
  });

  test('no tools means no tool_choice; a non-reasoning model gets no reasoning object', () => {
    const body = Adapter.requestBody({ ...base, model: 'some-other-model', tools: [] });
    expect('tool_choice' in body).toBe(false);
    expect('tools' in body).toBe(false);
    expect('reasoning' in body).toBe(false);
    expect('include' in body).toBe(false);
  });
});

describe('callBackup', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; mockLedgerCall.mockClear(); mockLedgerRejected.mockClear(); process.env.OPENAI_API_KEY = 'test-openai-key'; });

  const args = { system: 'SYS', tools: [tool('q')], messages: [{ role: 'user', content: 'hi' }] };

  test('posts to the Responses API with the key, ledgers provider openai on lane ib_admin_backup, returns Anthropic-shaped content', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'r', model: 'm', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] }) }));
    const reply = await Adapter.callBackup(args);
    expect(reply.content).toEqual([{ type: 'text', text: 'hello' }]);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer test-openai-key');
    expect(JSON.parse(init.body).store).toBe(false);
    expect(mockLedgerCall).toHaveBeenCalledWith('openai', Adapter.backupModel(), expect.any(Function), { laneId: 'ib_admin_backup' });
  });

  test('an incomplete answer or a refusal is filed as a failed ledger row, a clean answer is not', async () => {
    const reply = body => { global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => body })); return Adapter.callBackup(args); };
    await reply({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fine' }] }] });
    expect(mockLedgerRejected).not.toHaveBeenCalled();
    const cut = await reply({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    expect(cut.stop_reason).toBe('max_tokens');
    expect(mockLedgerRejected).toHaveBeenLastCalledWith(cut, 'openai_incomplete');
    const filtered = await reply({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] });
    expect(mockLedgerRejected).toHaveBeenLastCalledWith(filtered, 'openai_incomplete');
    const refused = await reply({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] });
    expect(refused.stop_reason).toBe('refusal');
    expect(mockLedgerRejected).toHaveBeenLastCalledWith(refused, 'openai_refusal');
    expect(mockLedgerRejected).toHaveBeenCalledTimes(3);
  });

  test('an HTTP error rejects with its status (the ledger files it as openai_<status>) and no body text', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'customer text here' } }) }));
    await expect(Adapter.callBackup(args)).rejects.toMatchObject({ status: 429, message: 'OpenAI backup call failed (429)' });
  });

  test('a failed response status rejects; a missing key rejects before any request', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', output: [] }) }));
    await expect(Adapter.callBackup(args)).rejects.toMatchObject({ code: 'openai_failed' });
    global.fetch = jest.fn();
    delete process.env.OPENAI_API_KEY;
    await expect(Adapter.callBackup(args)).rejects.toMatchObject({ code: 'no_key' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
