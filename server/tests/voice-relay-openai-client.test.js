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
  readSSEEvents,
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
  test('a bare string user message becomes an input_text item; an assistant message a plain-string item', () => {
    const items = toResponsesInput([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'hello!' },
    ]);
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi there' }] },
      { role: 'assistant', content: 'hello!' },
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

  test('consecutive assistant text blocks replay as ONE plain-string item (never output_text parts)', () => {
    const items = toResponsesInput([
      { role: 'assistant', content: [{ type: 'text', text: 'One moment.' }, { type: 'text', text: 'Checking now.' }] },
    ]);
    expect(items).toEqual([{ role: 'assistant', content: 'One moment.\nChecking now.' }]);
  });

  test('an assistant tool_use block becomes its own top-level function_call item, arguments JSON-stringified', () => {
    const items = toResponsesInput([
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'call_1', name: 'lookup_customer', input: { phone: '+19415551234' } }] },
    ]);
    expect(items).toEqual([
      { role: 'assistant', content: 'Let me check.' },
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
    // The GPT-6 line has no 'none' effort (services/llm/call.js) — 'low' is its floor.
    expect(reasoningEffortFor('gpt-6-sol')).toBe('low');
    expect(reasoningEffortFor('gpt-6-luna')).toBe('low');
    expect(reasoningEffortFor('gpt-5.6-luna')).toBe('none');
    expect(reasoningEffortFor('gpt-5.6-terra')).toBe('none');
    // gpt-5.6-sol / gpt-6-astra carry no `voice` entry — never offered to the
    // voice relay at all, so the adapter sends no reasoning object for them.
    expect(reasoningEffortFor('gpt-5.6-sol')).toBeNull();
    expect(reasoningEffortFor('claude-sonnet-5')).toBeNull();
    expect(reasoningEffortFor('not-a-real-model')).toBeNull();

    const body = buildOpenAIRequest({ model: 'gpt-6-sol', messages: [] });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(buildOpenAIRequest({ model: 'gpt-5.6-luna', messages: [] }).reasoning).toEqual({ effort: 'none' });
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

  test('a missing usage block stays absent', () => {
    expect(mapUsage(null)).toBeUndefined();
    expect(mapUsage(undefined)).toBeUndefined();
  });

  test.each([
    ['empty', {}],
    ['renamed counters', { prompt_tokens: 100, completion_tokens: 10 }],
    ['invalid required counter', { input_tokens: '100', output_tokens: 10 }],
    ['invalid cache counter', { input_tokens: 100, input_tokens_details: { cached_tokens: '20' }, output_tokens: 10 }],
    ['cache exceeds total input', { input_tokens: 10, input_tokens_details: { cached_tokens: 20 }, output_tokens: 2 }],
  ])('a present %s usage block keeps unknown counters for incomplete telemetry', (_label, usage) => {
    expect(mapUsage(usage)).toEqual({
      input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: null,
    });
  });

  test('genuine zero counters remain a valid measured round', () => {
    expect(mapUsage({ input_tokens: 0, output_tokens: 0 })).toEqual({
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
    });
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

  // Codex r4 P2: a COMPLETED response with nothing the caller can hear is a
  // failure too, not a silent clean end_turn.
  test.each([
    ['an empty output', []],
    ['reasoning only', [{ type: 'reasoning', summary: [] }]],
    ['blank output_text', [{ type: 'message', content: [{ type: 'output_text', text: '   ' }] }]],
  ])('a completed response with %s rejects', (_label, output) => {
    expect(() => mapResponseToMessage({ status: 'completed', output }, 'gpt-6-sol'))
      .toThrow(/no usable output/);
  });

  // Codex r4 P2: a refusal is a failed leg (services/llm/call.js), never speech.
  test('a refusal part rejects without quoting the refusal text, even beside output_text', () => {
    const refusalOnly = () => mapResponseToMessage({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with Pat Sample.' }] }],
    }, 'gpt-6-sol');
    expect(refusalOnly).toThrow('OpenAI Responses API returned a refusal.');
    expect(() => mapResponseToMessage({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Sure.' }, { type: 'refusal', refusal: 'no' }] }],
    }, 'gpt-6-sol')).toThrow(/refusal/);
  });

  test('an unfinished function_call (token exhaustion mid-arguments) rejects instead of running as a tool', () => {
    expect(() => mapResponseToMessage({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'function_call', status: 'incomplete', call_id: 'c1', name: 'capture_lead', arguments: '' }],
    }, 'gpt-6-sol')).toThrow(/did not complete \(incomplete\)/);
    expect(() => mapResponseToMessage({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'function_call', call_id: 'c1', name: 'capture_lead', arguments: '' }],
    }, 'gpt-6-sol')).toThrow(/incomplete response with no completion status/);
  });

  test('a max_output_tokens response with only reasoning (no text, no tool call) rejects', () => {
    expect(() => mapResponseToMessage({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', summary: [] }],
    }, 'gpt-6-sol')).toThrow(/exhausted max_output_tokens before any usable output/);
    expect(() => mapResponseToMessage({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '  ' }] }],
    }, 'gpt-6-sol')).toThrow(/exhausted max_output_tokens/);
  });

  // Codex r2 P1: an incomplete response for any reason OTHER than
  // max_output_tokens (content_filter, or anything else) is a genuine
  // failure, not a silent end_turn — see mapResponseToMessage's own comment.
  // A silent end_turn here would end the caller's turn with nothing spoken,
  // reset the relay's failure streak, and count as a clean completed round
  // in benchmark telemetry.
  test('an incomplete response for content_filter rejects rather than mapping to end_turn', () => {
    expect(() => mapResponseToMessage({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }, 'gpt-6-sol'))
      .toThrow(/incomplete response \(content_filter\)/);
  });

  test('an incomplete response with no incomplete_details at all still rejects, never silently end_turn', () => {
    expect(() => mapResponseToMessage({ status: 'incomplete', output: [] }, 'gpt-6-sol'))
      .toThrow(/incomplete response \(unknown\)/);
  });
});

describe('OpenAIRelayClient.messages.stream — full SSE round trips', () => {
  test('posts to the Responses API with the expected headers/body, and returns a completed text message', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return fetchStub([
        { type: 'response.output_item.added', item: { type: 'reasoning' } },
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

  // Codex r4 P1: a provider error MESSAGE can quote the rejected input and
  // relay-conversation.js logs err.message — only a code / id may surface.
  const LEAKY = 'caller Pat Sample at +19415551234, 12 Example Ln';

  test('a response.failed event rejects with the provider code + response id, never its message', async () => {
    const fetchImpl = fetchStub([{ type: 'response.failed', response: { id: 'resp_1', error: { code: 'server_error', message: LEAKY } } }]);
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const err = await client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage().catch((e) => e);
    expect(err.message).toBe('OpenAI Responses API error: server_error (resp_1)');
    expect(err.message).not.toMatch(/Pat|1941|Example/);
  });

  test('a top-level error SSE event rejects with its code only', async () => {
    const fetchImpl = fetchStub([{ type: 'error', code: 'rate_limit_exceeded', message: LEAKY }]);
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const err = await client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage().catch((e) => e);
    expect(err.message).toBe('OpenAI Responses API error: rate_limit_exceeded');
  });

  test('an error SSE event with no usable code still rejects, with a fixed label', async () => {
    const fetchImpl = fetchStub([{ type: 'error', message: LEAKY }]);
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const err = await client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage().catch((e) => e);
    expect(err.message).toBe('OpenAI Responses API error: stream_error');
  });

  test('an HTTP error rejects with status, error code and request id — never the body message', async () => {
    const body = JSON.stringify({ error: { code: 'invalid_request_error', message: `Invalid input: ${LEAKY}` } });
    const fetchImpl = async () => ({ ok: false, status: 400, headers: { get: (h) => (h === 'x-request-id' ? 'req_abc123' : null) }, text: async () => body });
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const err = await client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage().catch((e) => e);
    expect(err.message).toBe('OpenAI Responses API HTTP 400 (invalid_request_error, request req_abc123)');
  });

  test('an HTTP error with a non-JSON body rejects with the status alone', async () => {
    const fetchImpl = async () => ({ ok: false, status: 502, text: async () => `<html>${LEAKY}</html>` });
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const err = await client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage().catch((e) => e);
    expect(err.message).toBe('OpenAI Responses API HTTP 502');
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

// Codex r4 P2: SSE lines may end in CRLF, LF or a lone CR (the spec allows all
// three); a CRLF stream must parse, including a CRLF split across chunks.
describe('readSSEEvents — line endings', () => {
  async function collect(chunks) {
    const out = [];
    for await (const evt of readSSEEvents((async function* gen() { yield* chunks; }()))) out.push(evt);
    return out;
  }

  test('CRLF-separated events parse', async () => {
    expect(await collect(['data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('a CRLF split across chunks is one line ending, not two', async () => {
    expect(await collect(['data: {"a":1}\r', '\n\r', '\ndata: {"b":2}\r\n', '\r\n'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('lone-CR line endings parse, including a final event completed by a trailing CR', async () => {
    expect(await collect(['data: {"a":1}\r\rdata: {"b":2}\r', '\r'])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(await collect(['data: {"a":1}\r\r', 'data: {"b":2}\r\r'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('Uint8Array chunks with CRLF parse (the real fetch body shape)', async () => {
    const enc = new TextEncoder();
    expect(await collect([enc.encode('data: {"a":1}\r\n'), enc.encode('\r\n')])).toEqual([{ a: 1 }]);
  });

  test('an unterminated final event is still dropped (spec: incomplete events are discarded)', async () => {
    expect(await collect(['data: {"a":1}\r\n\r\ndata: {"b":2}'])).toEqual([{ a: 1 }]);
  });
});

// Codex r5/r6/r12 P1: with store:false, a reasoning model's tool loop needs
// its reasoning items back — encrypted, each immediately before the item that
// followed it (the round's original order, preamble message included), in
// every later request.
describe('reasoning items across tool-call rounds', () => {
  const RS = (id, enc = `enc-${id}`) => ({ type: 'reasoning', id, summary: [], encrypted_content: enc, status: 'completed' });
  const FC = (id, callId, name = 'lookup_customer') => ({ type: 'function_call', id, call_id: callId, name, arguments: '{}', status: 'completed' });
  const MSG = (id, text) => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
  const rsIn = (id, enc = `enc-${id}`) => ({ type: 'reasoning', id, summary: [], encrypted_content: enc });
  const msgIn = (id, ...texts) => ({ type: 'message', id, role: 'assistant', status: 'completed', content: (texts.length ? texts : ['']).map((text) => ({ type: 'output_text', text, annotations: [] })) });
  const fcIn = (id, callId, name = 'lookup_customer') => ({ type: 'function_call', ...(id ? { id } : {}), call_id: callId, name, arguments: '{}' });
  const tr = (callId, text = 'Found.') => ({ type: 'function_call_output', call_id: callId, output: text });

  /** One tool round through the real mapper, then the history the relay would keep. */
  function round(output) {
    return mapResponseToMessage({ status: 'completed', output }, 'gpt-6-sol');
  }

  test('a reasoning model asks for encrypted reasoning; effort none and no-effort models do not', () => {
    expect(buildOpenAIRequest({ model: 'gpt-6-sol', messages: [] }).include).toEqual(['reasoning.encrypted_content']);
    expect(buildOpenAIRequest({ model: 'gpt-5.6-luna', messages: [] })).not.toHaveProperty('include');
    expect(buildOpenAIRequest({ model: 'gpt-5.6-sol', messages: [] })).not.toHaveProperty('include');
  });

  test('a tool round records its original item order on its first tool_use block, trimmed to replay fields', () => {
    const msg = round([RS('rs_1'), MSG('msg_1', 'Let me check.'), RS('rs_2'), FC('fc_1', 'call_1'), FC('fc_2', 'call_2'), MSG('msg_2', 'Found it.'), RS('rs_t1'), RS('rs_t2')]);
    expect(msg.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use', 'text']);
    expect(msg.content[1]._openai.order).toEqual([
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-rs_1' },
      { type: 'message', id: 'msg_1', status: 'completed', parts: 1 },
      { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'enc-rs_2' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_2' },
      { type: 'message', id: 'msg_2', status: 'completed', parts: 1 },
    ]); // only the terminal reasoning run (no following item to pair with) is dropped
    expect(msg.content[2]).not.toHaveProperty('_openai');
  });

  // Codex r7 P2: items after the last call keep their place too.
  test('replay: [reasoning, function_call, message] keeps the trailing message after the call', () => {
    const msg = round([RS('rs_1'), FC('fc_1', 'call_1'), RS('rs_2'), MSG('msg_1', 'Pulling that up now.'), RS('rs_t')]);
    const items = toResponsesInput([{ role: 'user', content: 'hi' }, { role: 'assistant', content: msg.content }]);
    expect(items.slice(1)).toEqual([rsIn('rs_1'), fcIn('fc_1', 'call_1'), rsIn('rs_2'), msgIn('msg_1', 'Pulling that up now.')]);
  });

  test('replay: a message before AND after the call each keep their own text when the relay kept it unchanged', () => {
    const msg = round([MSG('msg_1', 'One sec.'), RS('rs_1'), FC('fc_1', 'call_1'), MSG('msg_2', 'Found you, Pat.')]);
    const items = toResponsesInput([{ role: 'user', content: 'hi' }, { role: 'assistant', content: msg.content }]);
    expect(items.slice(1)).toEqual([msgIn('msg_1', 'One sec.'), rsIn('rs_1'), fcIn('fc_1', 'call_1'), msgIn('msg_2', 'Found you, Pat.')]);
  });

  test('replay: once the relay cut the text to a sent prefix, it goes on the first message and the later one stays empty', () => {
    const msg = round([MSG('msg_1', 'One sec.'), RS('rs_1'), FC('fc_1', 'call_1'), MSG('msg_2', 'Found you, Pat.')]);
    const sentOnly = [{ type: 'text', text: 'One sec.' }, ...msg.content.filter((b) => b.type !== 'text')];
    const items = toResponsesInput([{ role: 'user', content: 'hi' }, { role: 'assistant', content: sentOnly }]);
    expect(items.slice(1)).toEqual([msgIn('msg_1', 'One sec.'), rsIn('rs_1'), fcIn('fc_1', 'call_1'), msgIn('msg_2', '')]);
  });

  test('replay: a message with several output_text parts gets each part back', () => {
    const two = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'One sec.' }, { type: 'output_text', text: 'Checking.' }] };
    const msg = round([RS('rs_1'), two, FC('fc_1', 'call_1')]);
    const items = toResponsesInput([{ role: 'user', content: 'hi' }, { role: 'assistant', content: msg.content }]);
    expect(items.slice(1)).toEqual([rsIn('rs_1'), msgIn('msg_1', 'One sec.', 'Checking.'), fcIn('fc_1', 'call_1')]);
  });

  test.each([
    ['no reasoning at all', [MSG('msg_1', 'One sec.'), FC('fc_1', 'call_1')]],
    ['a reasoning item without encrypted content', [{ type: 'reasoning', id: 'rs_1', summary: [] }, FC('fc_1', 'call_1')]],
    ['a message without an id', [RS('rs_1'), { type: 'message', content: [{ type: 'output_text', text: 'Hi.' }] }, FC('fc_1', 'call_1')]],
    ['a call without an item id', [RS('rs_1'), { type: 'function_call', call_id: 'call_1', name: 'lookup_customer', arguments: '{}', status: 'completed' }]],
  ])('a round with %s records nothing to replay', (_label, output) => {
    expect(round(output).content.find((b) => b.type === 'tool_use')).not.toHaveProperty('_openai');
  });

  test('replay: [reasoning, function_call] goes back paired, the call carrying its item id', () => {
    const msg = round([RS('rs_1'), FC('fc_1', 'call_1')]);
    const items = toResponsesInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: msg.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Found.' }] },
    ]);
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      rsIn('rs_1'),
      fcIn('fc_1', 'call_1'),
      tr('call_1'),
    ]);
  });

  test('replay: [reasoning, message, function_call] keeps its original order — the reasoning stays paired with the message', () => {
    const msg = round([RS('rs_1'), MSG('msg_1', 'Let me check.'), FC('fc_1', 'call_1')]);
    const items = toResponsesInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: msg.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Found.' }] },
    ]);
    expect(items.slice(1)).toEqual([rsIn('rs_1'), msgIn('msg_1', 'Let me check.'), fcIn('fc_1', 'call_1'), tr('call_1')]);
  });

  test('replay: a message the relay withheld (write-tool turn) goes back empty, still paired', () => {
    const msg = round([RS('rs_1'), MSG('msg_1', "That's booked!"), FC('fc_1', 'call_1', 'request_booking')]);
    const kept = msg.content.filter((b) => b.type !== 'text'); // relay-conversation.js _finalizeBlockRound, write turn
    const items = toResponsesInput([{ role: 'user', content: 'book it' }, { role: 'assistant', content: kept }]);
    expect(items.slice(1)).toEqual([rsIn('rs_1'), msgIn('msg_1', ''), fcIn('fc_1', 'call_1', 'request_booking')]);
  });

  test('replay: a message cut to its sent prefix, or rewritten after a barge-in, carries the text the relay kept', () => {
    const msg = round([RS('rs_1'), MSG('msg_1', 'Let me check on that for you.'), FC('fc_1', 'call_1')]);
    const toolUse = msg.content.find((b) => b.type === 'tool_use');
    const items = toResponsesInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check… [interrupted]' }, toolUse] },
    ]);
    expect(items.slice(1)).toEqual([rsIn('rs_1'), msgIn('msg_1', 'Let me check… [interrupted]'), fcIn('fc_1', 'call_1')]);
  });

  test('replay: several message items before the call each keep their own text', () => {
    const msg = round([MSG('msg_1', 'One sec.'), RS('rs_1'), MSG('msg_2', 'Checking.'), FC('fc_1', 'call_1')]);
    const items = toResponsesInput([{ role: 'user', content: 'hi' }, { role: 'assistant', content: msg.content }]);
    expect(items.slice(1)).toEqual([msgIn('msg_1', 'One sec.'), rsIn('rs_1'), msgIn('msg_2', 'Checking.'), fcIn('fc_1', 'call_1')]);
  });

  test('replay: an incomplete message keeps its status', () => {
    const cut = { type: 'message', id: 'msg_1', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'Let me' }] };
    const msg = round([RS('rs_1'), cut, FC('fc_1', 'call_1')]);
    const items = toResponsesInput([{ role: 'user', content: 'hi' }, { role: 'assistant', content: msg.content }]);
    expect(items[2]).toMatchObject({ type: 'message', id: 'msg_1', status: 'incomplete' });
  });

  // Codex r12 P1: no turn cutoff. A barge-in stores a round's tool results
  // with no model round after them (relay-conversation.js
  // _abortStreamToolLoop), so the caller's next message arrives before that
  // output is consumed — the round's reasoning must still go back.
  test('replay: a round interrupted by a barge-in still goes back paired after the caller speaks again', () => {
    const msg = round([RS('rs_1'), MSG('msg_1', 'Let me check.'), FC('fc_1', 'call_1')]);
    const items = toResponsesInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me… [interrupted]' }, msg.content[1]] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Not run — the current turn was interrupted.' }] },
      { role: 'user', content: [{ type: 'text', text: '[clock]' }, { type: 'text', text: 'actually, never mind' }] },
    ]);
    expect(items.slice(1, 5)).toEqual([
      rsIn('rs_1'),
      msgIn('msg_1', 'Let me… [interrupted]'),
      fcIn('fc_1', 'call_1'),
      tr('call_1', 'Not run — the current turn was interrupted.'),
    ]);
  });

  test('replay: a round from an earlier, completed caller turn is still replayed in order (the API ignores what it no longer needs)', () => {
    const msg = round([RS('rs_1'), MSG('msg_1', 'One moment.'), FC('fc_1', 'call_1')]);
    const items = toResponsesInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: msg.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Found.' }] },
      { role: 'assistant', content: 'Hi Pat.' },
      { role: 'user', content: [{ type: 'text', text: '[clock]' }, { type: 'text', text: 'next question' }] },
    ]);
    expect(items.slice(1, 5)).toEqual([rsIn('rs_1'), msgIn('msg_1', 'One moment.'), fcIn('fc_1', 'call_1'), tr('call_1')]);
    expect(items.slice(5)).toEqual([
      { role: 'assistant', content: 'Hi Pat.' },
      { role: 'user', content: [{ type: 'input_text', text: '[clock]' }, { type: 'input_text', text: 'next question' }] },
    ]);
  });

  test('replay: a round whose call is missing from history falls back to the plain rebuild', () => {
    const msg = round([RS('rs_1'), FC('fc_1', 'call_1'), FC('fc_2', 'call_2')]);
    const onlySecond = msg.content.filter((b) => b.id === 'call_2').map((b) => ({ ...b, _openai: msg.content[0]._openai }));
    const items = toResponsesInput([{ role: 'user', content: 'hi' }, { role: 'assistant', content: onlySecond }]);
    expect(items.slice(1)).toEqual([fcIn(null, 'call_2')]);
  });

  test('stream: encrypted content from response.output_item.done fills a terminal body that lacks it', async () => {
    const fetchImpl = fetchStub([
      { type: 'response.output_item.done', item: RS('rs_1', 'enc-from-done') },
      { type: 'response.output_item.done', item: FC('fc_1', 'call_1') },
      { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, FC('fc_1', 'call_1')] } },
    ]);
    const client = new OpenAIRelayClient({ apiKey: 'sk-test', fetchImpl });
    const msg = await client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage();
    expect(msg.content[0]._openai.order[0]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-from-done' });
  });
});
