'use strict';

/**
 * OpenAI tool-calling backup for the Intelligence Bar's /query loop
 * (GATE_IB_OPENAI_BACKUP). When the Anthropic call throws a provider error,
 * the route finishes the request here (ib-openai-backup.js decides when).
 *
 * The loop keeps ONE message format, Anthropic's: `tool_use` / `tool_result`
 * blocks in `messages`, a reply with `content` blocks and a `stop_reason`.
 * This module is the only place that knows OpenAI's shape. It converts
 *   - Anthropic tool definitions -> Responses API function tools,
 *   - Anthropic messages         -> Responses `input` items,
 *   - the Responses reply        -> an Anthropic-shaped message,
 * so the loop, the tool executors, the confirmation cards and the saved task
 * checkpoint run unchanged. Ids are kept: an OpenAI `call_id` becomes the
 * `tool_use.id` and comes back as the `function_call_output.call_id`.
 *
 * What does NOT cross providers (dropped on the way in, never invented):
 *   - `thinking` / `redacted_thinking` blocks (signed for Anthropic only),
 *   - server tool search (`server_tool_use`, `tool_search_tool_result`) and
 *     `tool_reference` results (a reference becomes the plain capability list),
 *   - `cache_control` and `defer_loading` (Anthropic prompt-cache / tool-search),
 *   - server tool definitions (any tool carrying a `type` other than 'custom').
 * Reasoning: a reasoning model's reply carries `reasoning` items that the
 * Responses API wants back, next to the item that followed them, on the next
 * round (store:false keeps nothing server-side, so the request asks for
 * `reasoning.encrypted_content`). The loop's history is Anthropic-shaped, so each
 * reply's raw items ride in a side table keyed by that reply's `content` array
 * (the loop appends that very array to the history); toInputItems replays them in
 * their original order for the rounds of THIS request. A history rebuilt from a
 * checkpoint has no side table and is converted without reasoning.
 *
 * The request carries `store: false`: Intelligence Bar prompts carry customer
 * detail, the same rule llm/call.js applies to every OpenAI request.
 */
const logger = require('../logger');
const MODELS = require('../../config/models');
const { ledgerCall, ledgerCallRejected } = require('../llm-dispatch-metrics');

const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';
const BACKUP_LANE_ID = 'ib_admin_backup';
const TIMEOUT_MS = 150 * 1000;
const MAX_OUTPUT_TOKENS = 16000; // reasoning tokens are billed against this cap
const TECH_MAX_OUTPUT_TOKENS = 4096;

// The strongest OpenAI model the repo already uses for tool-free text
// reasoning: the OpenAI leg of the highStakes policy (OPENAI_REPORT_WRITER),
// the backup of the flagship Claude model on every high-stakes lane. An env pin
// moves this lane alone.
function backupModel() {
  return process.env.INTELLIGENCE_BAR_BACKUP_MODEL || MODELS.TEXT_POLICIES.highStakes.fallback.model;
}

// ── tools ────────────────────────────────────────────────────────────────

// Schema keys the Responses function-tool schema does not take (or that only
// mean something to Anthropic's validator). Everything else is kept as is.
const DROPPED_SCHEMA_KEYS = new Set(['$schema', '$id', '$comment', 'examples', 'cache_control', 'defer_loading', 'input_examples']);
// A top-level combinator is refused by the Responses API as well as by
// Anthropic's; tool-definition.js already removed it from the wire copy.
const TOP_LEVEL_COMBINATORS = new Set(['oneOf', 'anyOf', 'allOf', 'not']);

function cleanSchema(node, top = false) {
  if (Array.isArray(node)) return node.map(item => cleanSchema(item));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_SCHEMA_KEYS.has(key) || (top && TOP_LEVEL_COMBINATORS.has(key))) continue;
    // `properties` maps property NAMES to schemas: a property that happens to be
    // called `examples` is a name, not a keyword.
    out[key] = key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, cleanSchema(schema)]))
      : cleanSchema(value);
  }
  return out;
}

function isClientTool(tool) {
  return Boolean(tool && typeof tool.name === 'string' && tool.input_schema && (!tool.type || tool.type === 'custom'));
}

function toOpenAITools(tools) {
  const seen = new Set();
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isClientTool(tool) || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const parameters = cleanSchema(tool.input_schema, true);
    out.push({
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: { ...parameters, type: 'object', properties: parameters.properties || {} },
      strict: false, // the registry validates input itself; strict mode demands every key required
    });
  }
  return out;
}

// ── messages ─────────────────────────────────────────────────────────────

const DROPPED_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'server_tool_use', 'tool_search_tool_result']);

function imagePart(block) {
  const source = block.source || {};
  if (source.type === 'base64' && source.data) return { type: 'input_image', image_url: `data:${source.media_type || 'image/jpeg'};base64,${source.data}` };
  if (source.type === 'url' && source.url) return { type: 'input_image', image_url: source.url };
  return null;
}

// A tool_result body as the plain string function_call_output takes. A
// tool_reference (the tool-search form of a discover_capabilities result)
// becomes the same JSON a plain result carries.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  const references = content.filter(part => part?.type === 'tool_reference').map(part => part.tool_name).filter(Boolean);
  const text = content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  if (text) return text;
  if (references.length) return JSON.stringify({ status: 'capabilities_found', capabilities: references.map(id => ({ id, availability: 'loaded' })) });
  return 'The saved result had no text.';
}

const argumentsText = input => {
  try { return JSON.stringify(input && typeof input === 'object' ? input : {}); } catch { return '{}'; }
};

const blocksOf = message => (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (Array.isArray(message.content) ? message.content : []));
const isText = block => block.type === 'text' && typeof block.text === 'string';

// reply.content (the array itself) -> the round's raw output items, replayable.
const rawRounds = new WeakMap();

// The round's output items in their original order, as far as they can be passed
// back statelessly: every item with an id, every reasoning item with encrypted
// content, and no reasoning run at the end (nothing follows it to pair with).
// Null when the round has no reasoning to keep or an item lacks what a replay needs.
function replayableRound(output) {
  const items = (Array.isArray(output) ? output : []).filter(item => item && ['reasoning', 'message', 'function_call'].includes(item.type));
  let end = items.length;
  while (end > 0 && items[end - 1].type === 'reasoning') end -= 1;
  const kept = items.slice(0, end);
  if (!kept.some(item => item.type === 'reasoning')) return null;
  const usable = kept.every(item => typeof item.id === 'string' && item.id
    && (item.type !== 'reasoning' || (typeof item.encrypted_content === 'string' && item.encrypted_content))
    && (item.type !== 'function_call' || (typeof item.call_id === 'string' && item.call_id)));
  return usable ? kept.map(replayItem) : null;
}

function replayItem(item) {
  if (item.type === 'reasoning') return { type: 'reasoning', id: item.id, summary: item.summary || [], encrypted_content: item.encrypted_content };
  if (item.type === 'function_call') return { type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments || '{}' };
  return {
    type: 'message', id: item.id, role: 'assistant', status: item.status || 'completed',
    content: (Array.isArray(item.content) ? item.content : []).map(part => (part?.type === 'output_text' ? { type: 'output_text', text: part.text || '', annotations: [] } : part)),
  };
}

function assistantItems(blocks) {
  const items = [];
  let text = [];
  const flush = () => { if (text.length) items.push({ role: 'assistant', content: text.join('\n') }); text = []; };
  for (const block of blocks.filter(b => b && !DROPPED_BLOCK_TYPES.has(b.type))) {
    if (isText(block) && block.text.trim()) text.push(block.text);
    else if (block.type === 'tool_use' && block.id && block.name) {
      flush();
      items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: argumentsText(block.input) });
    }
  }
  flush();
  return items;
}

// Results first (each answers a call above), then the turn's text and images as one user item.
function userItems(blocks) {
  const items = [];
  let parts = [];
  const flush = () => { if (parts.length) items.push({ role: 'user', content: parts }); parts = []; };
  for (const block of blocks.filter(Boolean)) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      flush();
      items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: (block.is_error ? 'ERROR: ' : '') + resultText(block.content) });
    } else if (isText(block) && block.text !== '') parts.push({ type: 'input_text', text: block.text });
    else if (block.type === 'image') parts.push(imagePart(block));
  }
  flush();
  return items.map(item => (item.content ? { ...item, content: item.content.filter(Boolean) } : item)).filter(item => !item.content || item.content.length);
}

function toInputItems(messages) {
  const items = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const replay = message.role === 'assistant' ? rawRounds.get(message.content) : null;
    items.push(...(replay || (message.role === 'assistant' ? assistantItems(blocksOf(message)) : userItems(blocksOf(message)))));
  }
  return pairCalls(items);
}

// The Responses API answers 400 for a function_call with no output, or an
// output with no call. A saved history can hold either (an interrupted round);
// keep every pair whole: an unanswered call gets an explicit "no result" output
// and an orphan output is dropped.
function pairCalls(items) {
  const called = new Set(items.filter(item => item.type === 'function_call').map(item => item.call_id));
  const answered = new Set(items.filter(item => item.type === 'function_call_output').map(item => item.call_id));
  const out = [];
  for (const item of items) {
    if (item.type === 'function_call_output' && !called.has(item.call_id)) continue;
    out.push(item);
    if (item.type === 'function_call' && !answered.has(item.call_id)) {
      out.push({ type: 'function_call_output', call_id: item.call_id, output: 'No result was recorded for this call.' });
    }
  }
  return out;
}

// ── reply ────────────────────────────────────────────────────────────────

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // the registry's input validation then refuses the call and the model sees why
  }
}

function outputBlocks(item) {
  if (item?.type === 'function_call' && item.name) {
    return [{ type: 'tool_use', id: item.call_id || item.id, name: item.name, input: parseArguments(item.arguments) }];
  }
  if (item?.type !== 'message') return []; // reasoning items stay behind
  return (Array.isArray(item.content) ? item.content : []).map(part => {
    if (part?.type === 'output_text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part?.type === 'refusal' && typeof part.refusal === 'string') return { type: 'text', text: part.refusal, refusal: true };
    return null;
  }).filter(Boolean);
}

function stopReasonOf(data, content) {
  if (content.some(block => block.type === 'tool_use')) return 'tool_use';
  if (content.some(block => block.refusal)) return 'refusal';
  return data?.status === 'incomplete' && data?.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn';
}

// reply -> the ledger code of an answer that is not a clean success. The ledger
// records a resolved call as ok, so callBackup flips these rows itself, with the
// codes llm/call.js files for the same OpenAI outcomes: any non-completed status
// is openai_incomplete (a cut-off answer is one), a refusal with no text is openai_refusal.
const failures = new WeakMap();
function ledgerFailure(data, blocks) {
  if (data?.status && data.status !== 'completed') return 'openai_incomplete';
  const refused = blocks.some(block => block.refusal);
  return refused && !blocks.some(block => block.type === 'text' && !block.refusal && block.text.trim()) ? 'openai_refusal' : null;
}

function fromOpenAIResponse(data) {
  const raw = (Array.isArray(data?.output) ? data.output : []).flatMap(outputBlocks);
  const stop_reason = stopReasonOf(data, raw);
  const content = raw.map(({ refusal, ...block }) => block);
  const replay = replayableRound(data?.output);
  if (replay) rawRounds.set(content, replay);
  const reply = {
    id: data?.id,
    model: data?.model,
    role: 'assistant',
    content,
    stop_reason,
    // The raw Responses usage, kept so the ledger reads it as provider 'openai'.
    // Its input_tokens / output_tokens names match the loop's usage log line;
    // the Anthropic cache counters read as 0 there.
    usage: data?.usage,
  };
  const failure = ledgerFailure(data, raw);
  if (failure) failures.set(reply, failure);
  return reply;
}

// ── the call ─────────────────────────────────────────────────────────────

function requestBody({ model, system, tools, messages, finalRound, tech }) {
  const functionTools = toOpenAITools(tools);
  const body = {
    model,
    store: false,
    input: toInputItems(messages),
    max_output_tokens: tech ? TECH_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
  };
  if (system) body.instructions = system;
  if (functionTools.length) {
    body.tools = functionTools;
    body.tool_choice = finalRound ? 'none' : 'auto';
    body.parallel_tool_calls = true;
  }
  if (/^gpt-[56](?:\.|-|$)/i.test(String(model))) {
    body.reasoning = { effort: tech ? 'low' : 'medium' };
    body.include = ['reasoning.encrypted_content']; // store:false keeps no reasoning server-side
  }
  return body;
}

async function postResponses(body) {
  const resp = await fetch(OPENAI_RESPONSES_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    // The body can quote the prompt (customer detail): only the status is kept.
    logger.warn(`[intelligence-bar] OpenAI backup ${resp.status}`);
    const err = new Error(`OpenAI backup call failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  const data = (await resp.json()) || {};
  if (data.status && data.status !== 'completed' && data.status !== 'incomplete') {
    const err = new Error(`OpenAI backup response ${data.status}`);
    err.code = `openai_${String(data.status).toLowerCase().replace(/[^a-z_]/g, '_')}`;
    throw err;
  }
  return data;
}

/**
 * One backup round. Resolves an Anthropic-shaped message the loop reads as it
 * reads a Claude reply; rejects with the provider's error (nothing is
 * swallowed here: the caller decides what a failed backup means). Ledgered as
 * provider openai, lane ib_admin_backup.
 */
async function callBackup({ system, tools, messages, finalRound = false, tech = false }) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is not set');
    err.code = 'no_key';
    throw err;
  }
  const model = backupModel();
  const body = requestBody({ model, system, tools, messages, finalRound, tech });
  const reply = await ledgerCall('openai', model, async () => fromOpenAIResponse(await postResponses(body)), { laneId: 'ib_admin_backup' });
  if (failures.has(reply)) ledgerCallRejected(reply, failures.get(reply));
  return reply;
}

module.exports = { callBackup, backupModel, toOpenAITools, toInputItems, fromOpenAIResponse, requestBody, BACKUP_LANE_ID, OPENAI_RESPONSES_API };
