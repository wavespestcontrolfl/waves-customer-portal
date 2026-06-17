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
  const match = clean.match(/\{[\s\S]*\}/);
  try { return JSON.parse(match ? match[0] : clean); } catch { return null; }
}

// Per-provider image block shapes (normalized input: { data: base64, mimeType }).
const toOpenAIImage = (img) => ({ type: 'input_image', image_url: `data:${img.mimeType || 'image/jpeg'};base64,${img.data}` });
const toGeminiImage = (img) => ({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.data } });
const toAnthropicImage = (img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.data } });

/**
 * OpenAI Responses API. System is prepended into the user text (the proven #1834
 * pattern — no separate system role). jsonMode parses the reply via parseLooseJson.
 */
async function callOpenAI({ model, system, text, images = [], jsonMode = true, maxTokens } = {}) {
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'no_key' };
  try {
    const promptText = system ? `${system}\n\n${text || ''}` : (text || '');
    const content = [{ type: 'input_text', text: promptText }, ...images.map(toOpenAIImage)];
    const body = { model, input: [{ role: 'user', content }] };
    if (maxTokens) body.max_output_tokens = maxTokens;
    const resp = await fetch(OPENAI_RESPONSES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { logger.warn(`[llm] OpenAI ${resp.status}`); return { ok: false, reason: `openai_${resp.status}` }; }
    const data = await resp.json();
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
async function callGemini({ model, system, text, images = [], jsonMode = true, maxTokens = 2048, temperature = 0.2 } = {}) {
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
async function callAnthropic({ model, system, text, images = [], tools, jsonMode = true, maxTokens = 1024 } = {}) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return { ok: false, reason: 'no_key' };
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const content = [...images.map(toAnthropicImage)];
    if (text) content.push({ type: 'text', text });
    const req = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    if (system) req.system = system;
    if (tools) req.tools = tools;
    const resp = await client.messages.create(req);
    const out = (resp?.content || []).find((b) => b.type === 'text')?.text || '';
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
 * payload: { system, text, images, jsonMode, maxTokens, tools, temperature }.
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

module.exports = {
  callOpenAI,
  callGemini,
  callAnthropic,
  dispatch,
  extractOpenAIText,
  parseLooseJson,
  OPENAI_RESPONSES_API,
  geminiUrl,
};
