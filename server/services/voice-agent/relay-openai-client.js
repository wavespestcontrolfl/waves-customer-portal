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
 * OpenAI model — and, separately, GATE_VOICE_RELAY_OPENAI_INBOUND for
 * production inbound (dark by default). This file is never imported by
 * anything that isn't provider === 'openai' for the pinned session model.
 *
 * This client never substitutes Claude itself on any failure — an OpenAI
 * error, a bad response shape, or an aborted stream all reject
 * `finalMessage()` with a descriptive Error (or one named 'AbortError'), the
 * exact shape relay-conversation.js's model-round catch block handles. That
 * caller decides what happens next: a live call switches to Claude for the
 * rest of the call (_runModelRound); an eval-harness session counts it as an
 * ordinary model failure, so a benchmark candidate that hits an OpenAI
 * outage fails visibly, never quietly re-run on Sonnet.
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
 *       a tool round with reasoning → its original item order
 *                                  (reasoning / message / function_call, ids kept; below)
 *       user tool_result         → {type:'function_call_output', call_id, output}
 *   tools (Anthropic {name, description, input_schema}) → Responses
 *     {type:'function', name, description, parameters, strict:false}
 *   Reasoning (store:false, so `include: ['reasoning.encrypted_content']`
 *     whenever the model reasons): a tool round's original item order —
 *     reasoning, message and function_call items, with ids — rides on its
 *     first tool_use block (`_openai`, adapter-private) and is replayed in
 *     that order in every later request (the API ignores reasoning it no
 *     longer needs), so each reasoning item stays immediately before the
 *     item that followed it (the pairing the Responses API validates); only
 *     a terminal reasoning run, which has no following item, is dropped.
 *     Message items carry only the text the relay kept in history, possibly
 *     empty. A round missing an id or encrypted content is not replayed.
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
  // Every tool round that carries its reasoning (`_openai.order`) is replayed
  // in its original order, whatever turn it belongs to — OpenAI's documented
  // simplest path ("pass in all reasoning items … the system will smartly
  // ignore any reasoning items that aren't relevant"). No turn cutoff: a
  // barge-in stores a round's tool results with no model round after them,
  // so the caller's next message can arrive before that output is consumed.
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text', text: String(m.content ?? '') }];
    const replayed = role === 'assistant' ? replayRound(blocks) : null;
    if (replayed) {
      items.push(...replayed);
      continue;
    }
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
        items.push(functionCallItem(b));
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

/** A tool_use block → a function_call input item (`id` only when replaying a paired round). */
function functionCallItem(block, id) {
  return {
    type: 'function_call',
    ...(id ? { id } : {}),
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input ?? {}),
  };
}

/**
 * The text each message item of a replayed round carries, in order. The
 * relay's history holds a round's text blocks exactly as the model produced
 * them (one per output_text part) unless it withheld them (a write-tool
 * turn), cut them to a sent prefix, or rewrote them after a barge-in — each
 * of which leaves a different block count. Unchanged ⇒ every message gets
 * its own parts back; changed ⇒ the kept text (possibly none) goes on the
 * first message and the rest stay empty, so the model never believes the
 * caller heard more than they did.
 */
function messageTexts(order, textBlocks) {
  const messages = order.filter((entry) => entry.type === 'message');
  const total = messages.reduce((n, entry) => n + (Number(entry.parts) || 0), 0);
  if (total > 0 && textBlocks.length === total) {
    let at = 0;
    return messages.map((entry) => {
      const parts = textBlocks.slice(at, at + entry.parts);
      at += entry.parts;
      return parts;
    });
  }
  const kept = textBlocks.join('\n').trim();
  return messages.map((_entry, i) => (i === 0 && kept ? [kept] : []));
}

/**
 * One assistant history message (one model round) rebuilt in the round's
 * ORIGINAL item order (`_openai.order`, set by mapResponseToMessage), or null
 * to fall back to the plain rebuild. Each reasoning item stays immediately
 * before the item that followed it, and every item keeps its own id — the
 * pairing the Responses API validates. Message items carry only the text the
 * relay kept for this round (messageTexts).
 */
function replayRound(blocks) {
  const anchor = blocks.find((b) => b && b.type === 'tool_use' && b._openai && Array.isArray(b._openai.order));
  if (!anchor) return null;
  const order = anchor._openai.order;
  const toolUses = new Map(blocks.filter((b) => b && b.type === 'tool_use').map((b) => [b.id, b]));
  const textBlocks = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? ''));
  const texts = messageTexts(order, textBlocks);
  const out = [];
  const emitted = new Set();
  let messageIndex = 0;
  for (const entry of order) {
    if (entry.type === 'reasoning') {
      out.push({ type: 'reasoning', id: entry.id, summary: entry.summary || [], encrypted_content: entry.encrypted_content });
    } else if (entry.type === 'message') {
      const parts = texts[messageIndex] || [];
      messageIndex += 1;
      out.push({
        type: 'message',
        id: entry.id,
        role: 'assistant',
        status: entry.status || 'completed',
        content: (parts.length ? parts : ['']).map((text) => ({ type: 'output_text', text, annotations: [] })),
      });
    } else if (entry.type === 'function_call') {
      const block = toolUses.get(entry.call_id);
      if (!block) return null; // history no longer holds this call — never replay half a round
      out.push(functionCallItem(block, entry.id));
      emitted.add(entry.call_id);
    }
  }
  // Text with no message item to carry it (should not happen) still goes
  // back, ahead of the round; so does any call the order does not name.
  const orphanText = messageIndex === 0 ? textBlocks.join('\n').trim() : '';
  if (orphanText) out.unshift({ role: 'assistant', content: orphanText });
  for (const [id, block] of toolUses) if (!emitted.has(id)) out.push(functionCallItem(block));
  return out;
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
  // store:false keeps nothing server-side, so a reasoning item can only be
  // passed back (toResponsesInput) with its encrypted content. An effort of
  // 'none' produces no reasoning items to keep.
  if (effort && effort !== 'none') body.include = ['reasoning.encrypted_content'];
  return body;
}

/** Anthropic-shape usage from a Responses `usage` block (see file header). */
function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const validCount = (value) => Number.isInteger(value) && value >= 0;
  const details = usage.input_tokens_details;
  const detailsValid = details == null || (typeof details === 'object' && !Array.isArray(details));
  const cachedPresent = detailsValid && details != null && Object.prototype.hasOwnProperty.call(details, 'cached_tokens');
  const cached = cachedPresent ? details.cached_tokens : 0;
  const valid = validCount(usage.input_tokens)
    && validCount(usage.output_tokens)
    && detailsValid
    && validCount(cached)
    && cached <= usage.input_tokens;
  // Preserve the distinction between no usage block (undefined above) and a
  // provider block whose required counters are missing or malformed. The
  // replay sees this object, extracts null counters and marks the model round
  // incomplete instead of silently recording a free zero-token round.
  if (!valid) {
    return {
      input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: null,
    };
  }
  return {
    input_tokens: usage.input_tokens - cached,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: usage.output_tokens,
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

const MESSAGE_STATUSES = new Set(['completed', 'incomplete', 'in_progress']);

/**
 * A tool round's output items, in their original order, as far as they can
 * be passed back: every item except a terminal run of reasoning (a reasoning
 * item with nothing after it has no following item to pair with), or null
 * when there is no reasoning to keep or any item lacks what a stateless
 * replay needs — an id on every item, and encrypted content on every
 * reasoning item (store:false keeps nothing server-side). A reasoning item
 * the API cannot pair, or cannot read back, is a 400.
 */
function replayableOrder(order) {
  let end = order.length;
  while (end > 0 && order[end - 1].type === 'reasoning') end -= 1;
  const kept = order.slice(0, end);
  if (!kept.some((entry) => entry.type === 'reasoning')) return null;
  const usable = kept.every((entry) => typeof entry.id === 'string' && entry.id
    && (entry.type !== 'reasoning' || (typeof entry.encrypted_content === 'string' && entry.encrypted_content))
    && (entry.type !== 'function_call' || (typeof entry.call_id === 'string' && entry.call_id)));
  return usable ? kept : null;
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
  const order = [];
  for (const item of response.output || []) {
    if (item.type === 'reasoning') {
      order.push({ type: 'reasoning', id: item.id, summary: Array.isArray(item.summary) ? item.summary : [], encrypted_content: item.encrypted_content });
    } else if (item.type === 'message') {
      const blocks = messageTextBlocks(item);
      content.push(...blocks);
      order.push({ type: 'message', id: item.id, status: MESSAGE_STATUSES.has(item.status) ? item.status : 'completed', parts: blocks.length });
    } else if (item.type === 'function_call') {
      hasFunctionCall = true;
      content.push(functionCallBlock(item, response));
      order.push({ type: 'function_call', id: item.id, call_id: item.call_id || item.id });
    }
  }
  // A tool round's reasoning rides on its first tool_use block (the one
  // block type every relay history path keeps) as the round's original item
  // order, so toResponsesInput can pass it back in every later request —
  // see replayRound.
  const replayOrder = hasFunctionCall ? replayableOrder(order) : null;
  if (replayOrder) content.find((b) => b.type === 'tool_use')._openai = { order: replayOrder };
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

/** `response` with any reasoning item missing its encrypted content filled from its output_item.done form. */
function withDoneReasoning(response, doneItems) {
  if (!doneItems.size || !Array.isArray(response.output)) return response;
  const output = response.output.map((item) => {
    if (!item || item.type !== 'reasoning' || item.encrypted_content) return item;
    const done = doneItems.get(item.id);
    return done && done.encrypted_content ? { ...item, encrypted_content: done.encrypted_content } : item;
  });
  return { ...response, output };
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
    // Each item's final form (response.output_item.done) — the source of a
    // reasoning item's encrypted content should the terminal body omit it.
    const doneItems = new Map();
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
          case 'response.output_item.done':
            if (evt.item && typeof evt.item.id === 'string') doneItems.set(evt.item.id, evt.item);
            break;
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
    return mapResponseToMessage(withDoneReasoning(finalResponse, doneItems), params.model);
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
