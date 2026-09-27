/**
 * relay-openai-client — a minimal OpenAI Responses-API client exposing the
 * SAME surface relay-conversation.js's tool-use loop actually touches on the
 * Anthropic SDK's `Messages.prototype.stream` result:
 *
 *   const stream = client.messages.stream(params, { signal });
 *   stream.on('streamEvent', (ev) => …);   // ev.type === 'content_block_start'
 *   stream.on('text', (delta) => …);       // incremental text chunks
 *   const msg = await stream.finalMessage(); // { content, stop_reason, usage }
 *
 * Built for GATE_VOICE_RELAY_OPENAI (server/services/voice-agent/
 * relay-conversation.js) — Sandy's benchmark/sandbox lane running on an
 * OpenAI model, never production inbound by default. Production callers stay
 * on Anthropic; this file is never imported by anything that isn't provider
 * === 'openai' for the pinned session model.
 *
 * NO SILENT FALLBACK: this client never substitutes Claude on any failure —
 * an OpenAI error, a bad response shape, or an aborted stream all reject
 * `finalMessage()` with a descriptive Error (or one named 'AbortError'), the
 * exact shape relay-conversation.js's existing model-round catch block
 * already handles (increments `_modelFailures`, runs the provider-failure
 * handoff policy). A benchmark candidate that hits an OpenAI outage must
 * fail visibly, never quietly re-run on Sonnet.
 *
 * Request mapping (Anthropic-shaped params → OpenAI Responses body):
 *   system (array of {type:'text', text, cache_control?})  → instructions
 *     (joined; cache_control has no Responses equivalent and is dropped)
 *   messages (Anthropic content-block shape, since relay-conversation.js
 *     pushes msg.content straight back into history) → input items:
 *       user text                → {role:'user', content:[{type:'input_text'}]}
 *       assistant text           → {role:'assistant', content:'<text>'} (a plain-string
 *                                  easy input message — valid for every role)
 *       assistant tool_use       → {type:'function_call', call_id, name, arguments}
 *       user tool_result         → {type:'function_call_output', call_id, output}
 *   tools (Anthropic {name, description, input_schema}) → Responses
 *     {type:'function', name, description, parameters, strict:false}
 *   max_tokens → max_output_tokens
 *   thinking / output_config (Anthropic-only effort control) → dropped;
 *     reasoning effort for THIS request is read from the model's own
 *     MODEL_CATALOG entry (config/models.js `voice.reasoning`) — never
 *     hardcoded here, and omitted entirely for a model with none set, same
 *     as voiceEffortFor's `output_config` omission on the Anthropic leg.
 *
 * Response mapping (OpenAI Responses `response.completed`/`response.
 * incomplete` body → Anthropic Message shape):
 *   output[] message item's output_text parts → {type:'text', text}
 *   output[] function_call item               → {type:'tool_use',
 *     id: call_id, name, input: JSON.parse(arguments)} — invalid JSON, or a
 *     call that did not complete, rejects finalMessage with a descriptive
 *     Error, never a swallowed input or an unfinished tool run.
 *   A refusal part, a response with no non-blank text and no tool call, and
 *     an incomplete response for any reason but max_output_tokens all reject
 *     too — each would otherwise end the turn in silence (or speak a safety
 *     refusal) as if it were a clean round.
 *   stop_reason: 'tool_use' when any function_call is present, 'max_tokens'
 *     when the response is incomplete for max_output_tokens, else 'end_turn'.
 *   Error messages carry only an HTTP status and a bounded provider code /
 *     request id — never a provider message, which can quote caller input.
 *   usage (response.completed only) → Anthropic shape:
 *     input_tokens = usage.input_tokens - cached_tokens
 *     cache_read_input_tokens = usage.input_tokens_details.cached_tokens
 *     cache_creation_input_tokens = 0 (Responses has no separate write count)
 *     output_tokens = usage.output_tokens
 *   — this is exactly the shape services/llm-dispatch-metrics.js#extractUsage
 *   reads as `extractUsage('anthropic', msg)`, so ledger/telemetry code that
 *   already knows the Anthropic usage shape needs no OpenAI-specific case.
 *
 * Streaming events fired (best-effort — a listener throwing never breaks the
 * stream): a synthetic `content_block_start` the moment each output item
 * begins (mirrors the Anthropic SDK's own event, which relay-conversation.js
 * reads for first-token latency AND to stop progressive-text flushing the
 * instant a tool call starts), and `text` deltas as
 * `response.output_text.delta` events arrive.
 */

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** system (Anthropic text-block array, or a bare string) → Responses instructions. */
function systemToInstructions(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n\n');
  }
  return '';
}

/** Anthropic tool def {name, description, input_schema} → Responses function tool. */
function toOpenAITool(tool) {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  };
}

/**
 * Anthropic-shaped `messages` (the relay's own history — content is either a
 * bare string or an array of {type:'text'|'tool_use'|'tool_result', …}
 * blocks) → a flat Responses `input` array. Consecutive text blocks in one
 * message become ONE message item (multiple content parts); a tool_use or
 * tool_result block is always its own top-level item, in the order it
 * appeared, so a message that mixes text and tool calls round-trips in the
 * same sequence the model produced it.
 */
function toResponsesInput(messages) {
  const items = [];
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text', text: String(m.content ?? '') }];
    let textRun = [];
    const flushText = () => {
      if (!textRun.length) return;
      // An assistant turn replays as a plain-string easy input message — valid
      // for every role, with no output-item metadata to reconstruct. A user
      // turn keeps one input_text part per block.
      items.push(role === 'assistant'
        ? { role, content: textRun.join('\n') }
        : { role, content: textRun.map((text) => ({ type: 'input_text', text })) });
      textRun = [];
    };
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        textRun.push(String(b.text ?? ''));
      } else if (b.type === 'tool_use') {
        flushText();
        items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      } else if (b.type === 'tool_result') {
        flushText();
        const output = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        items.push({ type: 'function_call_output', call_id: b.tool_use_id, output });
      }
      // Any other block type never appears in this relay's own history and is skipped.
    }
    flushText();
  }
  return items;
}

/** The model's own MODEL_CATALOG `voice.reasoning` effort, or null if unset. */
function reasoningEffortFor(model) {
  try {
    const { MODEL_CATALOG } = require('../../config/models');
    const meta = MODEL_CATALOG[model];
    const effort = meta && meta.voice && meta.voice.reasoning;
    return typeof effort === 'string' && effort ? effort : null;
  } catch {
    return null;
  }
}

/** Anthropic-shaped `messages.stream(params, …)` params → an OpenAI Responses request body. */
function buildOpenAIRequest(params = {}) {
  const body = {
    model: params.model,
    input: toResponsesInput(params.messages),
    stream: true,
    store: false,
  };
  const instructions = systemToInstructions(params.system);
  if (instructions) body.instructions = instructions;
  if (Array.isArray(params.tools) && params.tools.length) body.tools = params.tools.map(toOpenAITool);
  if (params.max_tokens) body.max_output_tokens = params.max_tokens;
  const effort = reasoningEffortFor(params.model);
  if (effort) body.reasoning = { effort };
  return body;
}

/** Anthropic-shape usage from a Responses `usage` block (see file header). */
function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const cached = Number(usage.input_tokens_details?.cached_tokens) || 0;
  const totalInput = Number(usage.input_tokens) || 0;
  return {
    input_tokens: Math.max(0, totalInput - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: Number(usage.output_tokens) || 0,
  };
}

/**
 * A bounded provider code / type / id token, or null. Provider error
 * MESSAGES can quote the rejected input (caller name, phone, address) and
 * relay-conversation.js logs `err.message`, so only a token like this ever
 * reaches an Error from this file — services/llm/call.js's rule.
 */
function safeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : null;
}

/** The safe code of a provider error object ({ code, type, message }), or null. */
function safeErrorCode(err) {
  if (!err || typeof err !== 'object') return null;
  return safeToken(err.code) || safeToken(err.type);
}

/** A message item's output_text parts → text blocks. A refusal part rejects. */
function messageTextBlocks(item) {
  const blocks = [];
  for (const part of item.content || []) {
    if (part.type === 'refusal') {
      // A refusal is a failed leg, as an Anthropic stop_reason 'refusal' is
      // (services/llm/call.js openAIVerdict) — never speech for the caller.
      // Its text can echo customer detail, so it is not quoted here.
      throw new Error('OpenAI Responses API returned a refusal.');
    }
    if (part.type === 'output_text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
  }
  return blocks;
}

/** A function_call item → a tool_use block. An unfinished call or bad JSON rejects. */
function functionCallBlock(item, response) {
  const label = safeToken(item.name) || safeToken(item.call_id) || 'unknown';
  // A call cut off mid-arguments (token exhaustion) must never run as a
  // tool — an empty/partial argument string would default to {} below.
  if (item.status && item.status !== 'completed') {
    throw new Error(`OpenAI function_call "${label}" did not complete (${safeToken(item.status) || 'unknown'}).`);
  }
  if (response.status === 'incomplete' && !item.status) {
    throw new Error(`OpenAI function_call "${label}" arrived in an incomplete response with no completion status.`);
  }
  let input;
  try {
    input = item.arguments ? JSON.parse(item.arguments) : {};
  } catch {
    // Neither the parse error's own message nor the raw arguments string
    // is included: `item.arguments` is caller-supplied tool-call input
    // (phone, name, address on a lookup/booking tool) and JSON.parse's
    // error message can echo a slice of the malformed text verbatim —
    // this error is logged (relay-conversation.js's model-round catch),
    // so a fixed, content-free message is the only PII-safe choice here.
    throw new Error(`OpenAI function_call "${label}" returned invalid JSON arguments (unparseable).`);
  }
  return { type: 'tool_use', id: item.call_id || item.id, name: item.name, input };
}

/** A completed/incomplete Responses `response` object → an Anthropic-shaped Message. */
function mapResponseToMessage(response, requestedModel) {
  // `incomplete` for max_output_tokens is a legitimate, non-error stop (the
  // Anthropic 'max_tokens' equivalent — the relay already knows what that
  // means). Any OTHER incomplete reason (content_filter, or anything else
  // OpenAI ever adds here) is a genuine failure: the model did not actually
  // finish, and letting it fall through as a silent 'end_turn' with
  // whatever partial content happened to exist (often none at all) would
  // reset the relay's failure streak and end the turn without speaking,
  // while the benchmark counts it as a clean completed round. Reject here so
  // finalMessage() surfaces it through the SAME model-failure/telemetry path
  // a real provider error already takes.
  const incompleteReason = response.status === 'incomplete' ? (response.incomplete_details || {}).reason || 'unknown' : null;
  if (incompleteReason && incompleteReason !== 'max_output_tokens') {
    throw new Error(`OpenAI Responses API returned an incomplete response (${safeToken(incompleteReason) || 'unknown'}).`);
  }
  const content = [];
  let hasFunctionCall = false;
  for (const item of response.output || []) {
    if (item.type === 'message') {
      content.push(...messageTextBlocks(item));
    } else if (item.type === 'function_call') {
      hasFunctionCall = true;
      content.push(functionCallBlock(item, response));
    }
    // Reasoning (and any other) items carry nothing the caller hears.
  }
  // No non-blank text and no tool call — an empty output, reasoning only, or
  // blank text, whether completed or cut off by max_output_tokens (reasoning
  // can spend the whole budget before any visible output). Accepting it would
  // speak nothing while resetting the relay's failure streak and count a
  // clean benchmark round, so it takes the failure path instead.
  if (!hasFunctionCall && !content.some((b) => b.type === 'text' && b.text.trim())) {
    throw new Error(incompleteReason === 'max_output_tokens'
      ? 'OpenAI Responses API exhausted max_output_tokens before any usable output.'
      : 'OpenAI Responses API returned no usable output (no text, no tool call).');
  }
  const stop_reason = hasFunctionCall ? 'tool_use' : (incompleteReason === 'max_output_tokens' ? 'max_tokens' : 'end_turn');
  return {
    id: response.id || null,
    model: response.model || requestedModel,
    role: 'assistant',
    content,
    stop_reason,
    usage: mapUsage(response.usage),
  };
}

/** err normalized to name 'AbortError' whenever `signal` says this call was aborted. */
function normalizeAbort(err, signal) {
  if (signal && signal.aborted) {
    const abortErr = new Error((err && err.message) || 'The operation was aborted.');
    abortErr.name = 'AbortError';
    return abortErr;
  }
  return err;
}

/**
 * Split every complete SSE event off the front of an LF-normalized buffer.
 * Returns the parsed `data:` payloads and the unconsumed remainder. A
 * malformed individual event is skipped rather than failing the stream.
 */
function takeSSEEvents(buffer) {
  const events = [];
  let rest = buffer;
  let idx;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const rawEvent = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const dataLines = rawEvent
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (!dataLines.length) continue;
    const dataStr = dataLines.join('\n');
    if (dataStr === '[DONE]') continue;
    try {
      events.push(JSON.parse(dataStr));
    } catch {
      // A malformed individual SSE frame is skipped, not fatal.
    }
  }
  return { events, rest };
}

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Decode an SSE byte/string stream into parsed `data:` JSON payloads. Accepts
 * either a real fetch Response body (async-iterable of Uint8Array) or a plain
 * async-iterable of strings (test convenience) — chunks of either kind may be
 * interleaved. SSE lines may end in CRLF, LF or a lone CR; all three are
 * normalized to LF before events are split. A chunk's trailing CR is held
 * back until the next chunk, since it may be the first half of a CRLF split
 * across chunks. A genuinely truncated/garbage stream simply yields fewer
 * events, which surfaces as "stream ended without a completed response".
 */
async function* readSSEEvents(bodyStream, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  let heldCR = false;
  const append = (text) => {
    let t = (heldCR ? '\r' : '') + text;
    heldCR = t.endsWith('\r');
    if (heldCR) t = t.slice(0, -1);
    buffer += t.replace(/\r\n?/g, '\n');
  };
  for await (const chunk of bodyStream) {
    if (signal && signal.aborted) throw abortError();
    append(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    const { events, rest } = takeSSEEvents(buffer);
    buffer = rest;
    yield* events;
  }
  if (signal && signal.aborted) throw abortError();
  // End of stream: flush the decoder, and a CR still held back was a line
  // ending after all (it can complete a final event).
  append(decoder.decode());
  if (heldCR) buffer += '\n';
  yield* takeSSEEvents(buffer).events;
}

/**
 * The object `messages.stream(params, opts)` returns — the ONE surface
 * relay-conversation.js touches (see the file header). Construction kicks off
 * the request immediately; `.on()` listeners registered synchronously right
 * after (as relay-conversation.js does, before its first `await`) are in
 * place before any event can fire, the same guarantee the Anthropic SDK's
 * own MessageStream gives.
 */
class OpenAIRelayStream {
  constructor(client, params, opts = {}) {
    this._listeners = { streamEvent: [], text: [] };
    this._signal = opts.signal || null;
    const run = this._run(client, params, opts);
    // Swallow here so an unawaited construction (finalMessage() called later,
    // or never, on an aborted round) never logs an unhandled rejection —
    // finalMessage() below still returns/rejects with the real outcome.
    run.catch(() => {});
    this._donePromise = run;
  }

  on(event, cb) {
    if (this._listeners[event]) this._listeners[event].push(cb);
    return this;
  }

  _emit(event, payload) {
    for (const cb of this._listeners[event] || []) {
      try { cb(payload); } catch { /* a listener's own error must not break the stream */ }
    }
  }

  async finalMessage() {
    return this._donePromise;
  }

  async _run(client, params, opts) {
    const signal = opts.signal;
    const body = buildOpenAIRequest(params);
    let resp;
    try {
      resp = await client.fetchImpl(RESPONSES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${client.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw normalizeAbort(err, signal);
    }
    if (!resp.ok) {
      // Status, provider error code and request id only — the body's message
      // can quote the rejected input, and this error is logged (safeToken).
      let code = null;
      try { code = safeErrorCode((JSON.parse(await resp.text()) || {}).error); } catch { /* no JSON body */ }
      const requestId = resp.headers && typeof resp.headers.get === 'function' ? safeToken(resp.headers.get('x-request-id')) : null;
      const detail = [code, requestId && `request ${requestId}`].filter(Boolean).join(', ');
      throw new Error(`OpenAI Responses API HTTP ${resp.status}${detail ? ` (${detail})` : ''}`);
    }
    let finalResponse = null;
    let failure = null;
    try {
      for await (const evt of readSSEEvents(resp.body, signal)) {
        switch (evt.type) {
          case 'response.output_item.added': {
            const item = evt.item || {};
            // Only a message or function call is the start of output the caller
            // hears; a reasoning item must not stamp first-token latency.
            if (item.type !== 'message' && item.type !== 'function_call') break;
            this._emit('streamEvent', {
              type: 'content_block_start',
              content_block: { type: item.type === 'function_call' ? 'tool_use' : 'text' },
            });
            break;
          }
          case 'response.output_text.delta':
            if (typeof evt.delta === 'string' && evt.delta) this._emit('text', evt.delta);
            break;
          case 'response.completed':
          case 'response.incomplete':
            finalResponse = evt.response;
            break;
          case 'response.failed': {
            const response = evt.response || {};
            const id = safeToken(response.id);
            failure = `${safeErrorCode(response.error) || 'response_failed'}${id ? ` (${id})` : ''}`;
            break;
          }
          case 'error':
            failure = safeErrorCode(evt.error) || safeToken(evt.code) || 'stream_error';
            break;
          default:
            break;
        }
      }
    } catch (err) {
      throw normalizeAbort(err, signal);
    }
    if (failure) throw new Error(`OpenAI Responses API error: ${failure}`);
    if (!finalResponse) throw new Error('OpenAI Responses API stream ended without a completed response');
    return mapResponseToMessage(finalResponse, params.model);
  }
}

class OpenAIRelayMessages {
  constructor(client) {
    this.client = client;
  }

  stream(params, opts) {
    return new OpenAIRelayStream(this.client, params, opts);
  }
}

class OpenAIRelayClient {
  constructor({ apiKey, fetchImpl } = {}) {
    this.apiKey = apiKey;
    // Resolved at CALL time (not captured here) so a test can set
    // `global.fetch` after this client is constructed and still be read.
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.messages = new OpenAIRelayMessages(this);
  }
}

module.exports = {
  OpenAIRelayClient,
  OpenAIRelayMessages,
  OpenAIRelayStream,
  buildOpenAIRequest,
  toResponsesInput,
  toOpenAITool,
  systemToInstructions,
  mapResponseToMessage,
  mapUsage,
  reasoningEffortFor,
  readSSEEvents,
  RESPONSES_URL,
};
