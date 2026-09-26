/**
 * relay-openai-client — request/response translation units.
 *
 * No live API calls: every test supplies its own `fetchImpl` (a plain async
 * function matching fetch's own (url, opts) -> Response shape, with `body`
 * an async-iterable of SSE-formatted strings — see `sse()` below). This
 * mirrors the surface relay-conversation.js's tool-use loop actually reads
 * off the Anthropic SDK's own MessageStream: `.on('streamEvent', …)`,
 * `.on('text', …)`, and `await stream.finalMessage()`.
 */

const {
  OpenAIRelayClient,
  buildOpenAIRequest,
  toResponsesInput,
  toOpenAITool,
  mapResponseToMessage,
  mapUsage,
  reasoningEffortFor,
  RESPONSES_URL,
} = require('../services/voice-agent/relay-openai-client');

/** events (plain objects) -> one SSE-formatted string (data: JSON\n\n per event). */
function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** A fetchImpl stub that always returns one SSE payload as a single chunk. */
function fetchStub(events, { status = 200, ok = true } = {}) {
  return async () => ({
    ok,
    status,
    text: async () => '',
    body: (async function* gen() { yield sse(events); }()),
  });
}

describe('toResponsesInput — Anthropic-shaped message history -> Responses input items', () => {
  test('a bare string user/assistant message becomes one input_text/output_text item', () => {
    const items = toResponsesInput([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'hello!' },
    ]);
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi there' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hello!' }] },
    ]);
  });

  test('consecutive text blocks in one message collapse into ONE item with multiple content parts', () => {
    const items = toResponsesInput([
      { role: 'user', content: [{ type: 'text', text: 'clock block' }, { type: 'text', text: 'caller said hi' }] },
    ]);
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'clock block' }, { type: 'input_text', text: 'caller said hi' }] },
    ]);
  });

  test('an assistant tool_use block becomes its own top-level function_call item, arguments JSON-stringified', () => {
    const items = toResponsesInput([
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'call_1', name: 'lookup_customer', input: { phone: '+19415551234' } }] },
    ]);
    expect(items).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup_customer', arguments: '{"phone":"+19415551234"}' },
    ]);
  });

  test('a user tool_result block becomes a function_call_output item keyed by tool_use_id', () => {
    const items = toResponsesInput([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Found: Pat' }] },
    ]);
    expect(items).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: 'Found: Pat' }]);
  });

  test('a full tool round trips in order: assistant tool_use, then user tool_result', () => {
    const items = toResponsesInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_9', name: 'find_slots', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_9', content: 'Open Tue 2pm' }] },
    ]);
    expect(items.map((i) => i.type || `message:${i.role}`)).toEqual(['message:user', 'function_call', 'function_call_output']);
    expect(items[1]).toEqual({ type: 'function_call', call_id: 'call_9', name: 'find_slots', arguments: '{}' });
    expect(items[2]).toEqual({ type: 'function_call_output', call_id: 'call_9', output: 'Open Tue 2pm' });
  });

  test('a non-string tool_result content is JSON-stringified rather than dropped', () => {
    const items = toResponsesInput([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: { ok: true } }] },
    ]);
    expect(items[0].output).toBe('{"ok":true}');
  });
});

describe('toOpenAITool — Anthropic tool def -> Responses function tool', () => {
  test('maps name/description/input_schema and sets strict:false', () => {
    const tool = toOpenAITool({ name: 'lookup_customer', description: 'Look up a customer', input_schema: { type: 'object' } });
    expect(tool).toEqual({ type: 'function', name: 'lookup_customer', description: 'Look up a customer', parameters: { type: 'object' }, strict: false });
  });
});

describe('buildOpenAIRequest — system/messages/tools/max_tokens/reasoning', () => {
  test('system text blocks join into instructions; cache_control is dropped', () => {
    const body = buildOpenAIRequest({
      model: 'gpt-6-sol',
      system: [{ type: 'text', text: 'You are Sandy.', cache_control: { type: 'ephemeral' } }],
      messages: [],
    });
    expect(body.instructions).toBe('You are Sandy.');
    expect(body).not.toHaveProperty('cache_control');
  });

  test('max_tokens -> max_output_tokens; stream:true and store:false always set', () => {
    const body = buildOpenAIRequest({ model: 'gpt-6-sol', max_tokens: 512, messages: [] });
    expect(body.max_output_tokens).toBe(512);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });

  test('tools are mapped through toOpenAITool; no tools key when tools is empty/absent', () => {
    const withTools = buildOpenAIRequest({ model: 'gpt-6-sol', messages: [], tools: [{ name: 'a', description: 'd', input_schema: {} }] });
    expect(withTools.tools).toEqual([{ type: 'function', name: 'a', description: 'd', parameters: {}, strict: false }]);
    const withoutTools = buildOpenAIRequest({ model: 'gpt-6-sol', messages: [], tools: [] });
    expect(withoutTools).not.toHaveProperty('tools');
  });

  test('thinking / output_config on the Anthropic-shaped params are silently dropped, never forwarded', () => {
    const body = buildOpenAIRequest({
      model: 'gpt-6-sol', messages: [], thinking: { type: 'disabled' }, output_config: { effort: 'low' },
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
  });

  test('reasoning effort is read from MODEL_CATALOG, never hardcoded per model id here', () => {
    expect(reasoningEffortFor('gpt-6-sol')).toBe('none');
    expect(reasoningEffortFor('gpt-6-luna')).toBe('none');
    expect(reasoningEffortFor('gpt-5.6-luna')).toBe('none');
    expect(reasoningEffortFor('gpt-5.6-terra')).toBe('none');
    // gpt-5.6-sol / gpt-6-astra carry no `voice` entry — never offered to the
    // voice relay at all, so the adapter sends no reasoning object for them.
    expect(reasoningEffortFor('gpt-5.6-sol')).toBeNull();
    expect(reasoningEffortFor('claude-sonnet-5')).toBeNull();
    expect(reasoningEffortFor('not-a-real-model')).toBeNull();

    const body = buildOpenAIRequest({ model: 'gpt-6-sol', messages: [] });
    expect(body.reasoning).toEqual({ effort: 'none' });
    const bodyNoReasoning = buildOpenAIRequest({ model: 'gpt-5.6-sol', messages: [] });
    expect(bodyNoReasoning).not.toHaveProperty('reasoning');
  });
});

describe('mapUsage — Responses usage -> Anthropic shape', () => {
  test('input_tokens excludes cached; cache_creation_input_tokens is always 0', () => {
    expect(mapUsage({ input_tokens: 500, input_tokens_details: { cached_tokens: 200 }, output_tokens: 40 })).toEqual({
      input_tokens: 300, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 40,
    });
  });

  test('no cached_tokens field -> cache_read_input_tokens 0, input_tokens unchanged', () => {
    expect(mapUsage({ input_tokens: 100, output_tokens: 10 })).toEqual({
      input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10,
    });
  });

  test('a missing/malformed usage block returns undefined, never throws', () => {
    expect(mapUsage(null)).toBeUndefined();
    expect(mapUsage(undefined)).toBeUndefined();
  });
});

describe('mapResponseToMessage — Responses response -> Anthropic Message shape', () => {
  test('a text-only completed response maps to one text block and stop_reason end_turn', () => {
    const msg = mapResponseToMessage({
      id: 'r1', model: 'gpt-6-sol', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi there.' }] }],
    }, 'gpt-6-sol');
    expect(msg.content).toEqual([{ type: 'text', text: 'Hi there.' }]);
    expect(msg.stop_reason).toBe('end_turn');
  });

  test('a function_call item maps to a tool_use block and stop_reason tool_use', () => {
    const msg = mapResponseToMessage({
      id: 'r2', status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup_customer', arguments: '{"phone":"+19415551234"}' }],
    }, 'gpt-6-sol');
    expect(msg.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'lookup_customer', input: { phone: '+19415551234' } }]);
    expect(msg.stop_reason).toBe('tool_use');
  });

  test('invalid JSON arguments throws a descriptive Error rather than swallowing bad input', () => {
    expect(() => mapResponseToMessage({
      status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'foo', arguments: '{not json' }],
    }, 'gpt-6-sol')).toThrow(/invalid JSON arguments/);
  });

  // Codex r1 P1: the raw (malformed) arguments string is caller-supplied
  // tool-call input — a phone number, name, or address on a lookup/booking
  // tool — and this error is logged verbatim by relay-conversation.js's
  // model-round catch block. Neither the raw arguments text nor JSON.parse's
  // own error message (which can echo a slice of it) may ever appear in the
  // thrown message.
  test('invalid JSON arguments never leaks the raw (possibly PII-carrying) argument text into the error', () => {
    const phone = '+19415559999';
    let thrown;
    try {
      mapResponseToMessage({
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'c1', name: 'lookup_customer', arguments: `{"phone":"${phone}"` }], // truncated — invalid JSON
      }, 'gpt-6-sol');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).not.toContain(phone);
    expect(thrown.message).toMatch(/invalid JSON arguments/);
  });

  test('an incomplete response for max_output_tokens maps to stop_reason max_tokens', () => {
    const msg = mapResponseToMessage({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial…' }] }],
    }, 'gpt-6-sol');
    expect(msg.stop_reason).toBe('max_tokens');
  });

  test('an incomplete response for a different reason does NOT map to max_tokens', () => {
    const msg = mapResponseToMessage({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }, 'gpt-6-sol');
    expect(msg.stop_reason).toBe('end_turn');
  });
});

describe('OpenAIRelayClient.messages.stream — full SSE round trips', () => {
  test('posts to the Responses API with the expected headers/body, and returns a completed text message', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return fetchStub([
        { type: 'response.output_item.added', item: { type: 'message' } },
        { type: 'response.output_text.delta', delta: 'Hi ' },
        { type: 'response.output_text.delta', delta: 'there.' },
        { type: 'response.completed', response: { id: 'r1', model: 'gpt-6-sol', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi there.' }] }], usage: { input_tokens: 50, output_tokens: 5 } } },
      ])();
    };
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const textDeltas = [];
    const blockStarts = [];
    const stream = client.messages.stream({ model: 'gpt-6-sol', max_tokens: 100, system: [], tools: [], messages: [{ role: 'user', content: 'hi' }] }, {});
    stream.on('text', (t) => textDeltas.push(t));
    stream.on('streamEvent', (e) => blockStarts.push(e));
    const msg = await stream.finalMessage();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESPONSES_URL);
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(calls[0].opts.body).model).toBe('gpt-6-sol');

    expect(textDeltas).toEqual(['Hi ', 'there.']);
    expect(blockStarts).toEqual([{ type: 'content_block_start', content_block: { type: 'text' } }]);
    expect(msg.content).toEqual([{ type: 'text', text: 'Hi there.' }]);
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.usage).toEqual({ input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 });
  });

  test('a tool_use round: content_block_start fires with type tool_use, finalMessage resolves the tool_use block', async () => {
    const fetchImpl = fetchStub([
      { type: 'response.output_item.added', item: { type: 'function_call' } },
      { type: 'response.completed', response: { id: 'r2', status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup_customer', arguments: '{}' }] } },
    ]);
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const blockStarts = [];
    const stream = client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {});
    stream.on('streamEvent', (e) => blockStarts.push(e));
    const msg = await stream.finalMessage();
    expect(blockStarts).toEqual([{ type: 'content_block_start', content_block: { type: 'tool_use' } }]);
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'lookup_customer', input: {} });
  });

  test('a non-2xx HTTP response rejects finalMessage with a descriptive Error, before any SSE parsing', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    await expect(client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage())
      .rejects.toThrow(/HTTP 429/);
  });

  test('a response.failed event rejects finalMessage with the provider error message', async () => {
    const fetchImpl = fetchStub([{ type: 'response.failed', response: { error: { message: 'model overloaded' } } }]);
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    await expect(client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage())
      .rejects.toThrow(/model overloaded/);
  });

  test('a top-level error SSE event rejects finalMessage', async () => {
    const fetchImpl = fetchStub([{ type: 'error', message: 'stream error' }]);
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    await expect(client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage())
      .rejects.toThrow(/stream error/);
  });

  test('a stream that ends with no completed/incomplete response rejects rather than resolving with nothing', async () => {
    const fetchImpl = fetchStub([{ type: 'response.output_text.delta', delta: 'partial' }]);
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    await expect(client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage())
      .rejects.toThrow(/ended without a completed response/);
  });

  test('an aborted signal rejects finalMessage with an error named AbortError', async () => {
    const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        reject(err);
      });
    });
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const controller = new AbortController();
    const promise = client.messages.stream({ model: 'gpt-6-sol', messages: [] }, { signal: controller.signal }).finalMessage();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a mid-stream abort (fetch resolves, then the signal fires while reading SSE) still rejects as AbortError', async () => {
    // Real fetch propagates an aborted signal into the body stream's own
    // reader (the in-flight read rejects) — this stub reproduces exactly
    // that instead of hanging the read loop forever on a signal it never
    // proactively polls between chunks.
    const fetchImpl = async (url, opts) => ({
      ok: true,
      status: 200,
      body: (async function* gen() {
        yield 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n';
        await new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }()),
    });
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const controller = new AbortController();
    const promise = client.messages.stream({ model: 'gpt-6-sol', messages: [] }, { signal: controller.signal }).finalMessage();
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
