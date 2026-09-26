/**
 * DEEP-tier calls. Opus is the cost-aware automatic primary; OpenAI Sol is
 * the independent provider fallback for API failures and refusals. The helper
 * preserves the legacy Anthropic-shaped response so existing DEEP callers do
 * not need provider-specific parsing. It also strips thinking blocks when an
 * explicit MODEL_DEEP override selects Fable.
 *
 * The caller passes its own Anthropic client so per-site timeout / retry
 * config and test mocks keep working. API errors throw exactly like
 * client.messages.create — callers keep their existing catch / fallback
 * paths. If params.model is omitted it defaults to MODELS.DEEP; per-feature
 * env overrides (e.g. MODEL_FACTCHECK) pass their resolved model through.
 */

const logger = require('../logger');
const MODELS = require('../../config/models');
const { callOpenAI, dispatchWithFallback } = require('./call');
const { anthropicMaxTokens, anthropicEffortFor } = require('./anthropic-wire');
const agentContext = require('../agent-control/context');
const { ledgerCall } = require('../llm-dispatch-metrics');

// The refusal fallback reuses the caller's client, whose `timeout` applies
// per request — so a refusal + retry could run ~2× the caller's budget (the
// fact-check gate bounds the publish lock at one FACTCHECK_TIMEOUT_MS total).
// Both calls share one deadline: the retry gets only the time left on the
// client's configured timeout, and below this floor it isn't attempted.
const FALLBACK_MIN_MS = 5000;

// Drop thinking blocks so content[0] is the first text block again. Blocks
// without a type (test fixtures) and all other block types pass through.
function stripThinkingBlocks(response) {
  if (response && Array.isArray(response.content)) {
    response.content = response.content.filter(
      (b) => !(b && (b.type === 'thinking' || b.type === 'redacted_thinking')),
    );
  }
  return response;
}

// Both legs (Opus, then the OpenAI backup) share one agent-control chain id
// in the call ledger; the Anthropic leg records through ledgerCall (request
// bodies handed over for a trace, should the lane opt in), the OpenAI leg
// records inside callOpenAI.
// `laneId` labels the call-ledger rows of BOTH legs — the option
// dispatchWithFallback's payload takes — and never reaches the wire.
async function createDeepMessage(client, { laneId, ...params } = {}, options = {}) {
  if (options.jsonSchema) {
    const basePolicy = MODELS.TEXT_POLICIES.deepAnalysis;
    const policy = params.model
      ? { ...basePolicy, primary: { ...basePolicy.primary, model: params.model } }
      : basePolicy;
    const validate = typeof options.validate === 'function'
      ? (result) => options.validate(result.json, result)
      : undefined;
    return dispatchWithFallback(policy, {
      anthropicClient: client,
      laneId,
      system: systemText(params.system),
      text: messageText(params.messages),
      jsonMode: true,
      jsonSchema: options.jsonSchema,
      maxTokens: params.max_tokens,
      timeoutMs: options.timeoutMs ?? client?.timeout,
      promptVersion: options.promptVersion,
      temperature: params.temperature,
    }, { validate });
  }
  const run = () => agentContext.withChain(() => createDeepMessageInChain(client, params));
  return laneId ? agentContext.runInLane(laneId, run) : run();
}

// The raw path used to hand params to the SDK untouched, so raw-path DEEP
// lanes (wiki compiler, agronomic wiki, KB audit, voice profile, call
// self-audit, quarantine arbiter, SMS verifier / judge / pathology, intent
// composer) sent their system prompts with no cache breakpoint, while the
// adapter (call.js) — which the jsonSchema path above uses — cached every
// one. This mirrors the adapter: the system prompt becomes one text block
// with an ephemeral breakpoint; a caller that placed its own cache_control
// is left alone. Prompts under the model's cacheable minimum (1024 tokens on
// Opus 4.8, 512 on Opus 5.5) are silently not cached — harmless. Batch lanes
// that reuse one prompt within five minutes read it back at ~0.1x.
function withSystemCache(params) {
  const { system } = params;
  if (typeof system === 'string' && system) {
    return { ...params, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] };
  }
  if (Array.isArray(system) && system.length && !system.some((b) => b?.cache_control)) {
    const last = system.length - 1;
    return { ...params, system: system.map((b, i) => (i === last && b?.type === 'text' ? { ...b, cache_control: { type: 'ephemeral' } } : b)) };
  }
  return params;
}

// The wire request: the cap clears always-on thinking and the effort pin is
// a default a caller's own effort overrides (both via anthropic-wire.js, so
// an Opus 5.5 flip keeps DEEP lanes sized and at the pinned depth).
function wireParams(params, model) {
  const rest = withSystemCache(params);
  const maxTokens = anthropicMaxTokens(model, rest.max_tokens);
  const req = { ...rest, model, ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }) };
  const effort = anthropicEffortFor(model);
  if (effort) req.output_config = { effort, ...(rest.output_config || {}) };
  return req;
}

async function createDeepMessageInChain(client, params) {
  const model = params.model || MODELS.DEEP;
  const startedAt = Date.now();
  let response;
  try {
    response = await ledgerCall('anthropic', model, () => client.messages.create(wireParams(params, model)), {
      trace: { system: systemText(params.system) || null, prompt: messageText(params.messages) || null },
    });
  } catch (err) {
    // Same remaining-budget guard as the refusal path below. Without it, an
    // Anthropic request that THROWS after consuming its budget (e.g. its own
    // timeout) passes a non-positive remaining number, which
    // callOpenAIDeepFallback maps to undefined — and callOpenAI then applies
    // its 10-minute default, holding 60s-budget callers (contact-quarantine
    // arbiter, call self-audit) ~10 extra minutes.
    const remainingMs = remainingBudget(client, startedAt);
    if (remainingMs !== null && remainingMs < FALLBACK_MIN_MS) {
      logger.warn(`[llm-deep] ${model} failed (${err.message}) — skipping OpenAI backup, only ${Math.max(0, remainingMs)}ms left`);
      throw err;
    }
    logger.warn(`[llm-deep] ${model} failed (${err.message}) — trying OpenAI backup`);
    const fallback = await callOpenAIDeepFallback(params, remainingMs);
    if (fallback) return fallback;
    throw err;
  }

  if (response && response.stop_reason === 'max_tokens') {
    logger.warn(`[llm-deep] ${model} hit max_tokens (${params.max_tokens}) — output may be truncated`);
  }
  if (!response || response.stop_reason !== 'refusal') {
    return stripThinkingBlocks(response);
  }

  const category = response.stop_details?.category || 'uncategorized';
  const remainingMs = remainingBudget(client, startedAt);
  if (remainingMs !== null && remainingMs < FALLBACK_MIN_MS) {
    logger.warn(`[llm-deep] ${model} refused (${category}) — skipping OpenAI backup, only ${Math.max(0, remainingMs)}ms left`);
    return stripThinkingBlocks(response);
  }
  logger.warn(`[llm-deep] ${model} refused (${category}) — trying OpenAI backup`);
  return (await callOpenAIDeepFallback(params, remainingMs)) || stripThinkingBlocks(response);
}

function remainingBudget(client, startedAt) {
  return Number.isFinite(client?.timeout) ? client.timeout - (Date.now() - startedAt) : null;
}

function messageText(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const content = message?.content;
    if (typeof content === 'string') return `${message.role || 'user'}: ${content}`;
    const text = (Array.isArray(content) ? content : [])
      .filter((block) => block?.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n');
    return `${message?.role || 'user'}: ${text}`;
  }).join('\n\n');
}

function systemText(system) {
  if (typeof system === 'string') return system;
  return (Array.isArray(system) ? system : []).map((block) => block?.text || '').filter(Boolean).join('\n');
}

async function callOpenAIDeepFallback(params, timeoutMs) {
  const result = await callOpenAI({
    model: MODELS.TEXT_POLICIES.deepAnalysis.fallback.model,
    system: systemText(params.system),
    text: messageText(params.messages),
    jsonMode: false,
    maxTokens: params.max_tokens || 4096,
    timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
  });
  if (!result.ok || !String(result.text || '').trim()) return null;
  return {
    id: null,
    model: result.model,
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: result.text }],
    // Real numbers for DEEP callers that read response.usage (same
    // input_tokens / output_tokens keys as an Anthropic Message).
    usage: result.usage || null,
  };
}

module.exports = { createDeepMessage, stripThinkingBlocks, _test: { messageText, systemText, remainingBudget, withSystemCache, wireParams } };
