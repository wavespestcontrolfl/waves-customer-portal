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
 *       assistant text           → {role:'assistant', content:[{type:'output_text'}]}
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
 *   output[] message item's output_text/refusal parts → {type:'text', text}
 *   output[] function_call item                        → {type:'tool_use',
 *     id: call_id, name, input: JSON.parse(arguments)} — invalid JSON
 *     rejects finalMessage with a descriptive Error, never a swallowed input.
 *   stop_reason: 'tool_use' when any function_call is present, 'max_tokens'
 *     when the response is incomplete for max_output_tokens, else 'end_turn'.
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
      const partType = role === 'assistant' ? 'output_text' : 'input_text';
      items.push({ role, content: textRun.map((text) => ({ type: partType, text })) });
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

/** A completed/incomplete Responses `response` object → an Anthropic-shaped Message. */
function mapResponseToMessage(response, requestedModel) {
  const content = [];
  let hasFunctionCall = false;
  for (const item of response.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text });
        else if (part.type === 'refusal' && typeof part.refusal === 'string') content.push({ type: 'text', text: part.refusal });
      }
    } else if (item.type === 'function_call') {
      hasFunctionCall = true;
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
        throw new Error(`OpenAI function_call "${item.name || item.call_id}" returned invalid JSON arguments (unparseable).`);
      }
      content.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name, input });
    }
  }
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
    throw new Error(`OpenAI Responses API returned an incomplete response (${incompleteReason}).`);
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
 * Decode an SSE byte/string stream into parsed `data:` JSON payloads. Accepts
 * either a real fetch Response body (async-iterable of Uint8Array) or a plain
 * async-iterable of strings (test convenience) — chunks of either kind may be
 * interleaved. A malformed individual event is skipped rather than failing
 * the whole stream; a genuinely truncated/garbage stream simply yields fewer
 * events, which surfaces as "stream ended without a completed response".
 */
async function* readSSEEvents(bodyStream, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of bodyStream) {
    if (signal && signal.aborted) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = rawEvent
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (!dataLines.length) continue;
      const dataStr = dataLines.join('\n');
      if (dataStr === '[DONE]') continue;
      try {
        yield JSON.parse(dataStr);
      } catch {
        // A malformed individual SSE frame is skipped, not fatal.
      }
    }
  }
  if (signal && signal.aborted) {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    throw err;
  }
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
      let detail = '';
      try { detail = await resp.text(); } catch { /* no body to read */ }
      throw new Error(`OpenAI Responses API HTTP ${resp.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }
    let finalResponse = null;
    let failure = null;
    try {
      for await (const evt of readSSEEvents(resp.body, signal)) {
        switch (evt.type) {
          case 'response.output_item.added': {
            const item = evt.item || {};
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
          case 'response.failed':
            failure = ((evt.response || {}).error || {}).message || 'OpenAI response failed';
            break;
          case 'error':
            failure = evt.message || (evt.error || {}).message || 'OpenAI stream error';
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
