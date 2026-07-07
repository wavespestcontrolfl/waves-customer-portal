/**
 * DEEP-tier Anthropic calls (MODELS.DEEP → claude-fable-5).
 *
 * fable-5 differs from the Opus line in two ways every caller must handle,
 * so the handling lives in one place:
 *
 * 1. Thinking blocks. fable-5 thinks on every request (always-on adaptive
 *    thinking — there is no way to disable it, and thinking spends from
 *    max_tokens). Responses put `thinking` blocks ahead of the `text`
 *    block, so legacy `response.content[0].text` parsing reads the wrong
 *    block. This wrapper strips thinking blocks before returning; call
 *    sites were also given larger max_tokens so thinking can't starve the
 *    visible answer.
 *
 * 2. Refusals. fable-5 runs safety classifiers that return HTTP 200 with
 *    stop_reason 'refusal' (empty or partial content). Pesticide /
 *    termiticide reasoning is a benign-adjacent domain where false
 *    positives are possible, so a refusal retries the identical request
 *    once on MODELS.FLAGSHIP (Opus) — the lane degrades to Opus, it never
 *    gaps. response.model reports which model actually answered.
 *
 * The caller passes its own Anthropic client so per-site timeout / retry
 * config and test mocks keep working. API errors throw exactly like
 * client.messages.create — callers keep their existing catch / fallback
 * paths. If params.model is omitted it defaults to MODELS.DEEP; per-feature
 * env overrides (e.g. MODEL_FACTCHECK) pass their resolved model through.
 */

const logger = require('../logger');
const MODELS = require('../../config/models');

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
  const response = await client.messages.create({ ...params, model });

  if (response && response.stop_reason === 'max_tokens') {
    logger.warn(`[llm-deep] ${model} hit max_tokens (${params.max_tokens}) — output may be truncated`);
  }
  if (!response || response.stop_reason !== 'refusal') {
    return stripThinkingBlocks(response);
  }

  const category = response.stop_details?.category || 'uncategorized';
  const budgetMs = Number.isFinite(client.timeout) ? client.timeout : null;
  if (budgetMs !== null) {
    const remainingMs = budgetMs - (Date.now() - startedAt);
    if (remainingMs < FALLBACK_MIN_MS) {
      logger.warn(`[llm-deep] ${model} refused (${category}) — skipping ${MODELS.FLAGSHIP} fallback, only ${Math.max(0, remainingMs)}ms left of the client's ${budgetMs}ms timeout`);
      return stripThinkingBlocks(response);
    }
    logger.warn(`[llm-deep] ${model} refused (${category}) — retrying on ${MODELS.FLAGSHIP} with ${remainingMs}ms of the timeout remaining`);
    const retry = await client.messages.create({ ...params, model: MODELS.FLAGSHIP }, { timeout: remainingMs });
    return stripThinkingBlocks(retry);
  }

  logger.warn(`[llm-deep] ${model} refused (${category}) — retrying on ${MODELS.FLAGSHIP}`);
  const retry = await client.messages.create({ ...params, model: MODELS.FLAGSHIP });
  return stripThinkingBlocks(retry);
}

module.exports = { createDeepMessage, stripThinkingBlocks };
