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
const { callOpenAI } = require('./call');

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

async function createDeepMessage(client, params = {}) {
  const model = params.model || MODELS.DEEP;
  const startedAt = Date.now();
  let response;
  try {
    response = await client.messages.create({ ...params, model });
  } catch (err) {
    logger.warn(`[llm-deep] ${model} failed (${err.message}) — trying OpenAI backup`);
    const fallback = await callOpenAIDeepFallback(params, remainingBudget(client, startedAt));
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
  };
}

module.exports = { createDeepMessage, stripThinkingBlocks, _test: { messageText, systemText, remainingBudget } };
