/**
 * Shared cross-provider LLM dispatch.
 *
 * One fail-closed place to call OpenAI (Responses API), Gemini (generateContent),
 * or Anthropic (SDK) — factored from the hand-rolled, duplicated patterns in the
 * #1834 lawn-diagnostic pipeline (server/services/lawn-diagnostic-prompt.js) and
 * satellite-analyzer / call-recording-processor. Every function NEVER throws and
 * returns a uniform shape:
 *
 *   { ok: true,  text, json, model }
 *   { ok: false, reason: 'no_key' | '<provider>_<status>' | 'empty_json' | 'error' }
 *
 * Callers route via dispatch(route, payload) where `route` is a models.ROUTES
 * entry ({ provider, model }). On { ok: false } the caller falls back to its
 * existing path — these helpers add a provider option, they don't replace the
 * caller's safety ladder.
 *
 * NOT for managed agents — the Managed Agents API (SSE sessions, server-side tool
 * loop) is a different surface and stays in the agent files.
 */

const logger = require('../logger');
const { PROVIDER } = require('../../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';

// Default per-request ceiling when a caller supplies no timeoutMs. Mirrors the
// Anthropic SDK's built-in 10-minute default (which bounded these lanes before
// the cross-provider failover), so a fetch-based primary that accepts the
// connection and then stalls can never hang forever — it aborts and the
// dispatcher moves to the backup provider.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const geminiUrl = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

// Minimal OpenAI Responses-API text extractor (from lawn-diagnostic-prompt.js).
function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && content.text) parts.push(content.text);
    }
  }
  return parts.join('');
}

// Fence/preamble-tolerant JSON parse (from lawn-diagnostic-prompt.js). Returns null on failure.
function parseLooseJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch { /* tolerate a short preamble */ }
  const objectStart = clean.indexOf('{');
  const arrayStart = clean.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = clean[start] === '[' ? clean.lastIndexOf(']') : clean.lastIndexOf('}');
  if (end <= start) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch { return null; }
}

// Per-provider image block shapes (normalized input: { data: base64, mimeType }).
const toOpenAIImage = (img) => ({ type: 'input_image', image_url: `data:${img.mimeType || 'image/jpeg'};base64,${img.data}` });
const toGeminiImage = (img) => ({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.data } });
const toAnthropicImage = (img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.data } });

/**
 * OpenAI Responses API. System is prepended into the user text (the proven #1834
 * pattern — no separate system role). jsonMode parses the reply via parseLooseJson.
 */
async function callOpenAI({ model, system, text, images = [], jsonMode = true, maxTokens, timeoutMs = DEFAULT_TIMEOUT_MS, reasoningEffort = 'low' } = {}) {
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'no_key' };
  try {
    const promptText = system ? `${system}\n\n${text || ''}` : (text || '');
    const content = [{ type: 'input_text', text: promptText }, ...images.map(toOpenAIImage)];
    // store:false on EVERY request through this adapter — the Responses API
    // retains application state by default, and these lanes carry customer PII
    // (inbound email sender/subject/body, call transcripts, names/addresses).
    const body = { model, input: [{ role: 'user', content }], store: false };
    if (maxTokens) body.max_output_tokens = maxTokens;
    if (/^gpt-5(?:\.|-|$)/i.test(String(model || ''))) body.reasoning = { effort: reasoningEffort };
    const resp = await fetch(OPENAI_RESPONSES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
      ...(timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!resp.ok) { logger.warn(`[llm] OpenAI ${resp.status}`); return { ok: false, reason: `openai_${resp.status}` }; }
    const data = await resp.json();
    if (data?.status && data.status !== 'completed') {
      logger.warn(`[llm] OpenAI response ${data.status}${data.incomplete_details?.reason ? ` (${data.incomplete_details.reason})` : ''}`);
      return { ok: false, reason: 'openai_incomplete' };
    }
    const out = extractOpenAIText(data);
    const json = jsonMode ? parseLooseJson(out) : null;
    if (jsonMode && !json) return { ok: false, reason: 'empty_json' };
    return { ok: true, text: out, json, model };
  } catch (err) {
    logger.error(`[llm] callOpenAI failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Gemini generateContent. jsonMode sets response_mime_type and joins ALL text
 * parts (a thinking model can emit a thought part before the answer part).
 */
async function callGemini({ model, system, text, images = [], jsonMode = true, maxTokens = 2048, temperature = 0.2, timeoutMs } = {}) {
  const key = geminiKey();
  if (!key) return { ok: false, reason: 'no_key' };
  try {
    const promptText = system ? `${system}\n\n${text || ''}` : (text || '');
    const parts = [...images.map(toGeminiImage), { text: promptText }];
    const generationConfig = { temperature, maxOutputTokens: maxTokens };
    if (jsonMode) generationConfig.response_mime_type = 'application/json';
    const resp = await fetch(geminiUrl(model, key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      ...(timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!resp.ok) { logger.warn(`[llm] Gemini ${resp.status}`); return { ok: false, reason: `gemini_${resp.status}` }; }
    const data = await resp.json();
    const out = (data?.candidates?.[0]?.content?.parts || []).map((p) => p && p.text).filter(Boolean).join('');
    const json = jsonMode ? parseLooseJson(out) : null;
    if (jsonMode && !json) return { ok: false, reason: 'empty_json' };
    return { ok: true, text: out, json, model };
  } catch (err) {
    logger.error(`[llm] callGemini failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Anthropic SDK messages.create. Uses a real system param; passes tools through
 * (e.g. server web_search) for callers that need them.
 */
async function callAnthropic({ model, system, text, images = [], tools, jsonMode = true, maxTokens = 1024, timeoutMs, temperature, anthropicClient } = {}) {
  if (!anthropicClient && (!Anthropic || !process.env.ANTHROPIC_API_KEY)) return { ok: false, reason: 'no_key' };
  try {
    const client = anthropicClient || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const content = [...images.map(toAnthropicImage)];
    if (text) content.push({ type: 'text', text });
    const req = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    // Ephemeral cache breakpoint on the system prompt (tools render before
    // system, so this caches both). Repeat callers with the same prompt reuse
    // it at ~0.1x input price; prompts under the model's cacheable minimum
    // are silently not cached — harmless.
    if (system) req.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (tools) req.tools = tools;
    if (Number.isFinite(temperature)) req.temperature = temperature;
    // maxRetries:0 whenever a budget is supplied — the SDK's per-request
    // timeout applies to EACH attempt, so its default retry policy (2 retries)
    // could hold a caller for ~3x its ceiling. Callers with a timeoutMs budget
    // (e.g. the fact-check publish lock, dispatchWithFallback's shared
    // deadline) need it to be a true wall-clock ceiling; the pre-failover
    // fact-check client was constructed with maxRetries:0 for the same reason.
    const resp = timeoutMs
      ? await client.messages.create(req, { timeout: timeoutMs, maxRetries: 0 })
      : await client.messages.create(req);
    // Older SDK/test adapters may omit the explicit block type while still
    // returning a valid text field; accept both shapes.
    const out = (resp?.content || []).find((b) => b?.type === 'text' || (b?.type == null && typeof b?.text === 'string'))?.text || '';
    const json = jsonMode ? parseLooseJson(out) : null;
    if (jsonMode && !json) return { ok: false, reason: 'empty_json' };
    return { ok: true, text: out, json, model, response: resp };
  } catch (err) {
    logger.error(`[llm] callAnthropic failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Dispatch a models.ROUTES entry ({ provider, model }) to the matching provider.
 * payload: { system, text, images, jsonMode, maxTokens, tools, temperature,
 *            anthropicClient } (`anthropicClient` supports existing injected
 *            clients and deterministic tests without bypassing the router).
 */
async function dispatch(route, payload = {}) {
  if (!route || !route.provider || !route.model) return { ok: false, reason: 'no_route' };
  const args = { model: route.model, ...payload };
  switch (route.provider) {
    case PROVIDER.OPENAI: return callOpenAI(args);
    case PROVIDER.GEMINI: return callGemini(args);
    case PROVIDER.ANTHROPIC: return callAnthropic(args);
    default: return { ok: false, reason: `unknown_provider_${route.provider}` };
  }
}

/**
 * Walk a named cross-provider policy ({ primary, fallback }). Unlike provider
 * SDK retries, this protects against provider-wide outages, missing keys,
 * malformed output, and caller-defined copy validation failures.
 *
 * validate(result, route) may return null/false for success or a short reason
 * string for rejection. Rejected output is never returned as a success.
 */
async function dispatchWithFallback(policy, payload = {}, { validate } = {}) {
  const routes = [policy?.primary, policy?.fallback].filter(Boolean);
  if (!routes.length) return { ok: false, reason: 'no_route', failures: [] };
  if (routes.length > 1 && routes[0].provider === routes[1].provider) {
    logger.error(`[llm] invalid fallback policy: both routes use ${routes[0].provider}`);
    return { ok: false, reason: 'same_provider_fallback', failures: [] };
  }

  const failures = [];
  const timeoutBudgetMs = Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0
    ? payload.timeoutMs
    : null;
  const deadline = timeoutBudgetMs === null ? null : Date.now() + timeoutBudgetMs;
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    let routePayload = payload;
    if (deadline !== null) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        failures.push({ provider: route.provider, model: route.model, reason: 'timeout_budget_exhausted' });
        break;
      }
      routePayload = { ...payload, timeoutMs: remainingMs };
    }
    let result;
    try {
      result = await dispatch(route, routePayload);
    } catch (err) {
      logger.error(`[llm] ${route.provider} dispatch threw: ${err.message}`);
      result = { ok: false, reason: 'error' };
    }

    if (!result?.ok) {
      failures.push({ provider: route.provider, model: route.model, reason: result?.reason || 'error' });
      continue;
    }

    let rejection = payload.jsonMode === false && !String(result.text || '').trim()
      ? 'empty_text'
      : null;
    if (typeof validate === 'function') {
      try {
        rejection = validate(result, route) || null;
      } catch (err) {
        rejection = `validator_error:${err.message}`;
      }
    }
    if (rejection) {
      failures.push({ provider: route.provider, model: route.model, reason: String(rejection) });
      continue;
    }

    return {
      ...result,
      provider: route.provider,
      model: result.model || route.model,
      fallbackUsed: index > 0,
      failures,
    };
  }

  return { ok: false, reason: 'all_providers_failed', failures };
}

module.exports = {
  callOpenAI,
  callGemini,
  callAnthropic,
  dispatch,
  dispatchWithFallback,
  extractOpenAIText,
  parseLooseJson,
  OPENAI_RESPONSES_API,
  geminiUrl,
};
