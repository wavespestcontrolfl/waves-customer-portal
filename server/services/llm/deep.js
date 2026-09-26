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

// The raw path used to hand params to the SDK untouched, so the largest
// prompts in the system (editorial review 12k, wiki compiler 12k, agronomic
// wiki 8k, the fact-check and compliance gates 6k) ran with NO cache
// breakpoint while the adapter (call.js) cached every system prompt. This
// mirrors the adapter: the system prompt becomes one text block with an
// ephemeral breakpoint. A caller that already placed its own cache_control
// on any system block is left alone. Prompts under the model's cacheable
// minimum are silently not cached — harmless.
// Same two TTLs the adapter accepts (call.js cacheControl); kept local so
// tests that mock ./call partially keep working.
function cacheControl(cacheTtl) {
  return cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

function withSystemCache(params) {
  const { system } = params;
  if (typeof system === 'string' && system) {
    return { ...params, system: [{ type: 'text', text: system, cache_control: cacheControl(params.cacheTtl) }] };
  }
  if (Array.isArray(system) && system.length && !system.some((b) => b?.cache_control)) {
    const last = system.length - 1;
    return { ...params, system: system.map((b, i) => (i === last && b?.type === 'text' ? { ...b, cache_control: cacheControl(params.cacheTtl) } : b)) };
  }
  return params;
}

// `cacheTtl` is a helper option, never a wire field; `output_config.effort`
// follows the same registry selector the adapter honors, so an Opus 5.5 flip
// (default effort 'medium') keeps DEEP lanes at the pinned depth unless a
// caller set its own.
function wireParams(params, model) {
  const { cacheTtl: _cacheTtl, ...rest } = withSystemCache(params);
  const req = { ...rest, model };
  // The env pin is a DEFAULT: a caller that chose its own effort keeps it,
  // and models that reject the field (Haiku, older Sonnets) never see it.
  const effort = MODELS.anthropicEffortFor?.(model);
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
