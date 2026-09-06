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
 *   { ok: false, reason: 'no_key' | '<provider>_<status>' | '<provider>_timeout' | 'empty_json' | 'error' }
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
const agentContext = require('../agent-control/context');
// Top-level (not lazy) so the ledger shares this module's agent-control
// context instance; every use below is wrapped so it can never break a call.
const metrics = require('../llm-dispatch-metrics');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';

// Default per-request ceiling when a caller supplies no timeoutMs. Mirrors the
// Anthropic SDK's built-in 10-minute default (which bounded these lanes before
// the cross-provider failover), so a fetch-based primary that accepts the
// connection and then stalls can never hang forever — it aborts and the
// dispatcher moves to the backup provider.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// Total wall-clock budget for a dispatchWithFallback chain when the caller
// supplies no timeoutMs — bounds user-facing lanes (reports, review replies,
// SMS drafts) well under the single-adapter 10-minute default while leaving
// room for both legs of long generations.
const DEFAULT_FALLBACK_BUDGET_MS = 4 * 60 * 1000;

// Reasoning-safe floor for GPT-5-line Responses requests. OpenAI bills
// reasoning tokens against max_output_tokens, so a tiny caller cap (e.g. the
// 60-token SMS service-intent classifier) can be consumed entirely by
// reasoning: the response returns status:"incomplete" with no visible JSON
// and the whole leg reads as a provider failure. Below this floor the adapter
// requests minimal reasoning AND widens the wire-level cap to the floor so
// the visible JSON always has room; lanes at/above the floor keep the
// caller's cap and effort unchanged.
const OPENAI_REASONING_FLOOR_TOKENS = 1024;
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

// A completed Responses body whose message content is a `refusal` block —
// the model declined; there is no text to extract. Null when it answered.
function extractOpenAIRefusal(data) {
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'refusal') return String(content.refusal || '');
    }
  }
  return null;
}

// Fence/preamble-tolerant JSON parse (from lawn-diagnostic-prompt.js). Returns null on failure.
/**
 * First text block of an Anthropic response. Reasoning-capable models put a
 * thinking block first, so `content[0].text` reads undefined on a valid
 * reply; every direct SDK site reads through this instead. Older SDK/test
 * adapters may omit the block type while still carrying text — accepted.
 */
function anthropicText(response) {
  return (response?.content || []).find((b) => b?.type === 'text' || (b?.type == null && typeof b?.text === 'string'))?.text || '';
}

function parseLooseJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch { /* tolerate a short preamble */ }
  const objectStart = clean.indexOf('{');
  const arrayStart = clean.indexOf('[');
  // Earliest start first (previous behavior), but a bracketed PREAMBLE before
  // the payload ("Note [draft]: {...}") must not eat the real value — when
  // the first candidate fails, the other bracket kind gets its own try.
  const starts = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const end = clean[start] === '[' ? clean.lastIndexOf(']') : clean.lastIndexOf('}');
    if (end <= start) continue;
    const candidate = clean.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch { /* fall through to mechanical repair */ }
    const repaired = parseRepairedJson(candidate);
    if (repaired !== null) return repaired;
  }
  return null;
}

// Mechanical repair for the syntax slips models actually produce, ported from
// the pre-failover newsletter drafter (which repaired before failing):
// trailing commas before a closing bracket, and raw control characters inside
// string literals — multiline string fields (newsletter htmlBody/textBody)
// arrive with literal line breaks the model forgot to escape, which strict
// JSON.parse rejects. The walk tracks string boundaries (honoring backslash
// escapes), so control characters INSIDE a string are escaped (\n / \r / \t /
// \uXXXX) while the same characters BETWEEN tokens — legitimate JSON
// formatting — pass through untouched. Returns the parsed value or null;
// never throws. Living here (not in the newsletter) means every
// dispatchWithFallback lane recovers repairable output instead of burning the
// leg as empty_json.
function parseRepairedJson(raw) {
  raw = String(raw);
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (!inString) {
      // Only remove trailing commas between tokens; quoted values and keys
      // can legitimately contain comma/bracket sequences.
      if (ch === ',') {
        let next = i + 1;
        while (next < raw.length && /\s/.test(raw[next])) next += 1;
        if (raw[next] === ']' || raw[next] === '}') {
          i = next - 1;
          continue;
        }
      }
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = false; out += ch; continue; }
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      out += ch === '\n' ? '\\n'
        : ch === '\r' ? '\\r'
          : ch === '\t' ? '\\t'
            : `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  try { return JSON.parse(out); } catch { return null; }
}

// Per-provider image block shapes (normalized input: { data: base64, mimeType }).
const toOpenAIImage = (img) => ({ type: 'input_image', image_url: `data:${img.mimeType || 'image/jpeg'};base64,${img.data}` });
const toGeminiImage = (img) => ({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.data } });
const toAnthropicImage = (img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.data } });

// The adapter's OWN timeout, as each transport reports it: an
// AbortSignal.timeout() fetch rejects with a DOMException named TimeoutError
// (undici); the Anthropic SDK throws APIConnectionTimeoutError (statusless);
// undici connect / headers timeouts surface as a cause code. A caller's
// manual abort (AbortError) is not a timeout and stays 'error'.
function isTimeoutError(err) {
  const name = String(err?.name || '');
  if (name === 'TimeoutError' || name === 'APIConnectionTimeoutError') return true;
  return /TIMEOUT|ETIMEDOUT/.test(String(err?.code || err?.cause?.code || ''));
}

// `<provider>_<status>` from the SDK / message, `<provider>_timeout` for the
// adapter's own deadline (so the failure classifier files it as timeout, not
// as broken plumbing — Codex on PR #3793), else 'error'.
function providerErrorReason(provider, err) {
  const directStatus = Number(err?.status || err?.statusCode);
  if (Number.isInteger(directStatus) && directStatus >= 100 && directStatus <= 599) {
    return `${provider}_${directStatus}`;
  }
  if (isTimeoutError(err)) return `${provider}_timeout`;
  const messageStatus = String(err?.message || '').match(/(?:^|\s)([1-5]\d{2})(?:\s|$)/)?.[1];
  return messageStatus ? `${provider}_${messageStatus}` : 'error';
}

// Call ledger (GATE_LLM_CALL_LEDGER, dark by default): one llm_dispatch_log
// row per provider call, written by the adapters themselves so bare
// `dispatch` and `dispatchWithFallback` legs are recorded alike. Lazy-required
// and fire-and-forget for the same reason recordDispatchOutcome is: the
// ledger can never slow down or break the call it observes. `base` is the
// adapter's identity (provider, requested model, ambient lane/prompt-version
// overrides, the bodies for an opted-in trace); `outcome` is what happened.
// Latency rides a monotonic clock (performance.now), never Date.now: the
// dispatcher's deadline math uses Date.now and tests pin it.
const nowMs = () => performance.now();
const elapsedMs = (t0) => Math.round(performance.now() - t0);
// The ledger row id of an adapter result the chain may still reject (the
// validate hook): keyed by the result object so nothing rides on the value
// callers receive.
const ledgerIdOf = new WeakMap();
function recordLedgerCall(base, outcome) {
  try {
    const callId = metrics.recordCall({
      provider: base.provider,
      requestedModel: base.requestedModel,
      laneId: base.laneId,
      promptVersion: base.promptVersion,
      policyLabel: base.policyLabel,
      servedModel: outcome.servedModel,
      providerRef: outcome.providerRef,
      usage: outcome.usage,
      latencyMs: outcome.latencyMs,
      ok: outcome.ok,
      errorCode: outcome.errorCode,
    });
    metrics.recordTrace(callId, { system: base.system, prompt: base.text, response: outcome.response, laneId: base.laneId });
    return callId;
  } catch (err) {
    logger.debug(`[llm] call ledger skipped: ${err.message}`);
    return null;
  }
}
// An answered call the chain then rejects is a failed leg in the ledger too
// (Codex r13 on #3846): the adapter's ok row flips to the rejection code.
function rejectLedgerCall(result, reason, validator) {
  try {
    metrics.failCall(ledgerIdOf.get(result), reason, { validator });
  } catch (err) {
    logger.debug(`[llm] call ledger rejection skipped: ${err.message}`);
  }
}
function usageOf(provider, data) {
  try { return metrics.extractUsage(provider, data); } catch { return null; }
}

/**
 * OpenAI Responses API. The system prompt rides the Responses `instructions`
 * channel (system/developer priority) — never concatenated into the user
 * message — so on fallback legs carrying user-controlled payloads (inbound
 * customer SMS/email bodies) customer text cannot claim the same instruction
 * priority as voice/safety rules. This mirrors callAnthropic's real `system`
 * field. jsonMode parses the reply via parseLooseJson.
 */
// jsonSchema (optional, JSON-schema object; objects need additionalProperties:
// false and every key in `required`): with jsonMode it turns the provider's
// structured-output mode on — the model is constrained to the schema instead
// of being asked in prose to "return only JSON". Anthropic:
// output_config.format json_schema; OpenAI Responses: text.format json_schema
// (strict); Gemini: generationConfig.response_json_schema alongside the JSON
// mime type. The reply still goes through
// parseLooseJson, so a site converts by adding its schema and deleting its
// JSON-shape prose — nothing else about the site changes.
// laneId / promptVersion / policyLabel are call-ledger correlation only
// (explicit beats the ambient agent-control scope); they never reach the wire.
// ── One outcome contract for every adapter ────────────────────────────
// A leg fails the same way on every provider: the call row and the value the
// caller gets back agree (recorded AND returned — the cross-provider fallback
// runs on the same verdict the ledger files). `served` is what the
// provider told us about the answer (model, id, usage, latency, the text).
function failedLeg(base, served, code, response = served.response) {
  recordLedgerCall(base, { ...served, ok: false, errorCode: code, response });
  return { ok: false, reason: code };
}

// The tail every adapter shares once the provider's own verdict is in: a
// text-mode answer with nothing in it is a failed leg (Codex r15 on #3846 —
// a bare dispatch never reached the chain's check, so its call row said ok
// while the sms canary called the same result an outage); JSON mode parses
// the reply and fails an empty parse. `extras` are the provider-specific
// result fields (usage / raw response) callers already read.
function settleLeg(base, served, out, jsonMode, extras) {
  if (!jsonMode && !String(out || '').trim()) return failedLeg(base, served, 'empty_text');
  const json = jsonMode ? parseLooseJson(out) : null;
  if (jsonMode && !json) return failedLeg(base, served, 'empty_json');
  const result = { ok: true, text: out, json, ...extras };
  ledgerIdOf.set(result, recordLedgerCall(base, { ...served, ok: true }));
  return result;
}

// fetch's abort signal for a budgeted call (both REST adapters).
function abortAfter(timeoutMs) {
  return timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? { signal: AbortSignal.timeout(timeoutMs) }
    : {};
}

// A provider's non-success status as a ledger code: `<provider>_<status>`
// lower-cased, anything outside [a-z_] folded to '_'.
const statusCode = (provider, status) => `${provider}_${String(status).toLowerCase().replace(/[^a-z_]/g, '_')}`;

// ── OpenAI ────────────────────────────────────────────────────────────
// The Responses request. store:false on EVERY request through this adapter
// — the API retains application state by default, and these lanes carry
// customer PII (inbound email sender/subject/body, call transcripts,
// names/addresses).
function openAIRequest({ model, system, text, images, documents, jsonMode, jsonSchema, maxTokens, reasoningEffort }) {
  const content = [{ type: 'input_text', text: text || '' }, ...images.map(toOpenAIImage),
    ...documents.map((doc) => ({ type: 'input_file', filename: doc.filename, file_data: `data:application/pdf;base64,${doc.data}` }))];
  const body = { model, input: [{ role: 'user', content }], store: false };
  if (system) body.instructions = system;
  if (jsonMode && jsonSchema) body.text = { format: { type: 'json_schema', name: 'structured_response', schema: jsonSchema, strict: true } };
  // Gate reasoning by cap — see OPENAI_REASONING_FLOOR_TOKENS. Big lanes
  // keep the caller's cap and the standard effort (default 'low') exactly
  // as before; tiny sub-floor lanes drop to minimal effort. The wire-cap
  // widening is JSON lanes ONLY: free-text routes use the caller cap as
  // their last length guard (/api/review-gate 256-token review body, SMS
  // drafts), so widening there would let the OpenAI leg bypass route-level
  // size limits.
  const isGpt5 = /^gpt-5(?:\.|-|$)/i.test(String(model || ''));
  const tinyCap = isGpt5 && Number.isFinite(maxTokens) && maxTokens > 0 && maxTokens < OPENAI_REASONING_FLOOR_TOKENS;
  if (maxTokens) body.max_output_tokens = tinyCap && jsonMode ? OPENAI_REASONING_FLOOR_TOKENS : maxTokens;
  // 'none' — the GPT-5.6 line's supported efforts are none/low/medium/
  // high/xhigh/max ('minimal' 400s); tiny caps want zero reasoning tokens.
  if (isGpt5) body.reasoning = { effort: tinyCap ? 'none' : reasoningEffort };
  return body;
}

// The provider's own verdict on a 200 body, or null when the answer stands.
// 'incomplete' is the model's output cut off (max_output_tokens); any other
// terminal state (failed, cancelled …) is the provider's failure — its own
// code, filed as provider, never as incomplete output. A refusal block is a
// failed leg in BOTH modes, as an Anthropic stop_reason 'refusal' is.
function openAIVerdict(data, out) {
  const id = data.id || 'no id';
  if (data.status && data.status !== 'completed') {
    // Bounded diagnostics only: a provider error MESSAGE can quote the
    // rejected input, so the reason / error code and response id are
    // logged and the message never is (the redacted trace keeps the body).
    const detail = (data.incomplete_details || {}).reason || (data.error || {}).code;
    logger.warn(`[llm] OpenAI response ${data.status}${detail ? ` (${detail})` : ''} (${id})`);
    return { code: data.status === 'incomplete' ? 'openai_incomplete' : statusCode('openai', data.status) };
  }
  const refusal = extractOpenAIRefusal(data);
  if (refusal !== null && !out) {
    // The refusal body can echo customer detail from the prompt — never
    // logged; the (redacted) trace keeps it for lanes that opt in.
    logger.warn(`[llm] OpenAI refusal (${id})`);
    return { code: 'openai_refusal', response: refusal };
  }
  return null;
}

async function callOpenAI({ model, system, text, images = [], documents = [], jsonMode = true, jsonSchema, maxTokens, timeoutMs = DEFAULT_TIMEOUT_MS, reasoningEffort = 'low', laneId, promptVersion, policyLabel } = {}) {
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'no_key' };
  const base = { provider: 'openai', requestedModel: model, laneId, promptVersion, policyLabel, system, text };
  const t0 = nowMs();
  try {
    const resp = await fetch(OPENAI_RESPONSES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(openAIRequest({ model, system, text, images, documents, jsonMode, jsonSchema, maxTokens, reasoningEffort })),
      ...abortAfter(timeoutMs),
    });
    if (!resp.ok) {
      logger.warn(`[llm] OpenAI ${resp.status}`);
      return failedLeg(base, { latencyMs: elapsedMs(t0) }, `openai_${resp.status}`);
    }
    const data = (await resp.json()) || {};
    // Latency includes the body read; usage is recorded on every billed
    // outcome (incomplete and empty_json cost tokens too). The text is
    // extracted before the verdict: the partial output of a
    // max_output_tokens cut-off is exactly what its trace needs to show.
    const out = extractOpenAIText(data);
    const served = { servedModel: data.model, providerRef: data.id, usage: usageOf('openai', data), latencyMs: elapsedMs(t0), response: out };
    const verdict = openAIVerdict(data, out);
    if (verdict) return failedLeg(base, served, verdict.code, verdict.response);
    return settleLeg(base, served, out, jsonMode, { model, usage: served.usage });
  } catch (err) {
    // fetch / body-read failures carry no HTTP status; only the adapter's own
    // timeout is distinguished (a stray number in a parse error is not one).
    const reason = isTimeoutError(err) ? 'openai_timeout' : 'error';
    logger.error(`[llm] callOpenAI failed (${reason}): ${err.message}`);
    return failedLeg(base, { latencyMs: elapsedMs(t0) }, reason);
  }
}

// ── Gemini ────────────────────────────────────────────────────────────
/**
 * Gemini generateContent. jsonMode sets response_mime_type and joins ALL text
 * parts (a thinking model can emit a thought part before the answer part).
 */
const GEMINI_BLOCK_FINISHES = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

function geminiRequest({ system, text, images, jsonMode, jsonSchema, maxTokens, temperature }) {
  const promptText = system ? `${system}\n\n${text || ''}` : (text || '');
  const parts = [...images.map(toGeminiImage), { text: promptText }];
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (jsonMode) generationConfig.response_mime_type = 'application/json';
  if (jsonMode && jsonSchema) generationConfig.response_json_schema = jsonSchema;
  return { contents: [{ parts }], generationConfig };
}

// The provider's own verdict on a 200 body, or null when the answer stands.
// A MAX_TOKENS finish is an incomplete leg, as OpenAI's `incomplete` status
// and Anthropic's 'max_tokens' stop are. A safety-blocked answer — a blocked
// candidate, or a prompt-level block with no candidate at all — is the model
// declining: `gemini_refusal`, the class the other providers' refusals take.
// Any other non-STOP finish is its own outcome.
function geminiVerdict(data, candidate, maxTokens) {
  const finish = candidate.finishReason;
  if (finish === 'MAX_TOKENS') {
    logger.warn(`[llm] Gemini response finished at MAX_TOKENS (${maxTokens})`);
    return 'gemini_incomplete';
  }
  const blockReason = (data.promptFeedback || {}).blockReason;
  const blocked = GEMINI_BLOCK_FINISHES.has(finish) || (!(data.candidates || []).length && blockReason);
  if (!blocked && (!finish || finish === 'STOP')) return null;
  const code = blocked ? 'gemini_refusal' : statusCode('gemini_finish', finish);
  logger.warn(`[llm] Gemini ${code} (${finish || blockReason})`);
  return code;
}

async function callGemini({ model, system, text, images = [], jsonMode = true, jsonSchema, maxTokens = 2048, temperature = 0.2, timeoutMs, laneId, promptVersion, policyLabel } = {}) {
  const key = geminiKey();
  if (!key) return { ok: false, reason: 'no_key' };
  const base = { provider: 'gemini', requestedModel: model, laneId, promptVersion, policyLabel, system, text };
  const t0 = nowMs();
  try {
    const resp = await fetch(geminiUrl(model, key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiRequest({ system, text, images, jsonMode, jsonSchema, maxTokens, temperature })),
      ...abortAfter(timeoutMs),
    });
    if (!resp.ok) {
      logger.warn(`[llm] Gemini ${resp.status}`);
      return failedLeg(base, { latencyMs: elapsedMs(t0) }, `gemini_${resp.status}`);
    }
    const data = (await resp.json()) || {};
    const candidate = (data.candidates || [])[0] || {};
    const out = ((candidate.content || {}).parts || []).map((p) => p && p.text).filter(Boolean).join('');
    const served = { servedModel: data.modelVersion, providerRef: data.responseId, usage: usageOf('gemini', data), latencyMs: elapsedMs(t0), response: out };
    const code = geminiVerdict(data, candidate, maxTokens);
    if (code) return failedLeg(base, served, code);
    return settleLeg(base, served, out, jsonMode, { model });
  } catch (err) {
    const reason = isTimeoutError(err) ? 'gemini_timeout' : 'error';
    logger.error(`[llm] callGemini failed (${reason}): ${err.message}`);
    return failedLeg(base, { latencyMs: elapsedMs(t0) }, reason);
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────
/**
 * Anthropic SDK messages.create. Uses a real system param; passes tools through
 * (e.g. server web_search) for callers that need them.
 */
// A payload `temperature` is read by the Gemini leg only. Current Anthropic
// models (Opus 4.7+, Sonnet 5, Fable) reject sampling controls with a 400, so
// this leg never forwards it.
function anthropicRequest({ model, system, text, images, documents, tools, jsonMode, jsonSchema, maxTokens }) {
  const content = [...images.map(toAnthropicImage),
    ...documents.map((doc) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.data } }))];
  if (text) content.push({ type: 'text', text });
  const req = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  // Ephemeral cache breakpoint on the system prompt (tools render before
  // system, so this caches both). Repeat callers with the same prompt reuse
  // it at ~0.1x input price; prompts under the model's cacheable minimum
  // are silently not cached — harmless.
  if (system) req.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (tools) req.tools = tools;
  if (jsonMode && jsonSchema) req.output_config = { format: { type: 'json_schema', schema: jsonSchema } };
  return req;
}

// The provider's own verdict on a Message, or null when the answer stands.
// A stop_reason 'refusal' is a failed leg in BOTH modes — a refusal can carry
// partial text: returning it as ok would hand a truncated answer to the
// caller and skip the cross-provider fallback the DEEP helper already takes
// on a refusal. A stop_reason 'max_tokens' is an incomplete leg, exactly as
// an OpenAI `incomplete` status is (Codex r7 on #3846).
function anthropicVerdict(resp, maxTokens) {
  if (resp.stop_reason === 'refusal') return 'anthropic_refusal';
  if (resp.stop_reason !== 'max_tokens') return null;
  logger.warn(`[llm] Anthropic response stopped at max_tokens (${maxTokens})`);
  return 'anthropic_incomplete';
}

async function callAnthropic({ model, system, text, images = [], documents = [], tools, jsonMode = true, jsonSchema, maxTokens = 1024, timeoutMs, anthropicClient, laneId, promptVersion, policyLabel } = {}) {
  if (!anthropicClient && (!Anthropic || !process.env.ANTHROPIC_API_KEY)) return { ok: false, reason: 'no_key' };
  const base = { provider: 'anthropic', requestedModel: model, laneId, promptVersion, policyLabel, system, text };
  // Ledger latency. With no budget the SDK keeps its default retries, so one
  // row can span several attempts — the row is the CALL as the caller saw it.
  const t0 = nowMs();
  try {
    const client = anthropicClient || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const req = anthropicRequest({ model, system, text, images, documents, tools, jsonMode, jsonSchema, maxTokens });
    // maxRetries:0 whenever a budget is supplied — the SDK's per-request
    // timeout applies to EACH attempt, so its default retry policy (2 retries)
    // could hold a caller for ~3x its ceiling. Callers with a timeoutMs budget
    // (e.g. the fact-check publish lock, dispatchWithFallback's shared
    // deadline) need it to be a true wall-clock ceiling; the pre-failover
    // fact-check client was constructed with maxRetries:0 for the same reason.
    const resp = (timeoutMs
      ? await client.messages.create(req, { timeout: timeoutMs, maxRetries: 0 })
      : await client.messages.create(req)) || {};
    const out = anthropicText(resp);
    const served = { servedModel: resp.model, providerRef: resp.id, usage: usageOf('anthropic', resp), latencyMs: elapsedMs(t0), response: out };
    const code = anthropicVerdict(resp, maxTokens);
    if (code) return failedLeg(base, served, code);
    return settleLeg(base, served, out, jsonMode, { model, response: resp });
  } catch (err) {
    const reason = providerErrorReason('anthropic', err);
    const log = reason === 'anthropic_429' || reason === 'anthropic_529'
      ? logger.warn.bind(logger)
      : logger.error.bind(logger);
    log(`[llm] callAnthropic failed (${reason}): ${err.message}`);
    return failedLeg(base, { latencyMs: elapsedMs(t0) }, reason);
  }
}

/**
 * Dispatch a models.ROUTES entry ({ provider, model }) to the matching provider.
 * payload: { system, text, images, documents, jsonMode, jsonSchema, maxTokens, tools, temperature,
 *            anthropicClient, laneId, promptVersion } (`anthropicClient` supports
 *            existing injected clients and deterministic tests without bypassing
 *            the router; laneId / promptVersion only label the call-ledger row).
 */
async function dispatch(route, payload = {}) {
  if (!route || !route.provider || !route.model) return { ok: false, reason: 'no_route' };
  const args = { model: route.model, ...payload };
  switch (route.provider) {
    case PROVIDER.OPENAI: return callOpenAI(args);
    case PROVIDER.GEMINI:
      if (args.documents?.length) return { ok: false, reason: 'unsupported_pdf_provider' };
      return callGemini(args);
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
async function dispatchWithFallback(policy, payload = {}, options = {}) {
  // Every leg of the chain shares one agent-control chain id (the ledger's
  // call rows join to the chain row on it). A caller that knows its lane or
  // prompt version passes them on the payload — laneId scopes the whole
  // chain, promptVersion stamps the chain's own scope only.
  const chain = () => runFallbackChain(policy, payload, options);
  const run = () => agentContext.withChain(() => (payload.promptVersion
    ? agentContext.withPromptVersion(payload.promptVersion, chain)
    : chain()));
  return payload.laneId ? agentContext.runInLane(payload.laneId, run) : run();
}

async function runFallbackChain(policy, payload, { validate } = {}) {
  const routes = [policy?.primary, policy?.fallback].filter(Boolean);
  if (!routes.length) return { ok: false, reason: 'no_route', failures: [] };
  if (routes.length > 1 && routes[0].provider === routes[1].provider) {
    logger.error(`[llm] invalid fallback policy: both routes use ${routes[0].provider}`);
    return { ok: false, reason: 'same_provider_fallback', failures: [] };
  }

  const failures = [];
  // The chain's registry name, so its call rows carry the same policy label
  // as the chain row (labels resolve in one place: policyLabel).
  const chainLabel = metrics.recordedPolicyLabel(policy);
  // Every chain runs under a shared wall-clock deadline. Callers with an
  // explicit timeoutMs keep their original semantics (each leg gets the full
  // remainder — fact-check's hard 60s ceiling). Callers WITHOUT one get
  // DEFAULT_FALLBACK_BUDGET_MS, split evenly across the remaining legs so a
  // stalled primary aborts at its share and cannot starve the fallback —
  // without this, a hung leg sat on the adapter's 10-minute default before
  // failover ever started, far beyond user-facing request windows.
  const explicitBudget = Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0;
  const timeoutBudgetMs = explicitBudget ? payload.timeoutMs : DEFAULT_FALLBACK_BUDGET_MS;
  const deadline = Date.now() + timeoutBudgetMs;
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      failures.push({ provider: route.provider, model: route.model, reason: 'timeout_budget_exhausted' });
      break;
    }
    const legMs = explicitBudget ? remainingMs : Math.ceil(remainingMs / (routes.length - index));
    const routePayload = { ...payload, timeoutMs: legMs, policyLabel: chainLabel };
    let result;
    try {
      result = await dispatch(route, routePayload);
    } catch (err) {
      logger.error(`[llm] ${route.provider} dispatch threw: ${err.message}`);
      result = { ok: false, reason: 'error' };
    }

    if (!result.ok) {
      failures.push({ provider: route.provider, model: route.model, reason: result.reason || 'error' });
      continue;
    }

    // Empty text-mode answers fail in the adapters (`empty_text`), so an ok
    // result here has content. The caller's validate hook owns its codes
    // (`too_long`, `trade_name`, `missing_summary`…): a rejection from it is
    // a model-quality failure, so the failure entry carries that provenance
    // for classifyFailure.
    let rejection = null;
    if (typeof validate === 'function') {
      try {
        rejection = validate(result, route) || null;
      } catch (err) {
        rejection = `validator_error:${err.message}`;
      }
    }
    if (rejection) {
      // A max_tokens-truncated Anthropic answer never reaches the validator:
      // callAnthropic fails that leg as anthropic_incomplete first, so a
      // rejection here is a judgement on a complete answer.
      failures.push({ provider: route.provider, model: route.model, reason: String(rejection), validator: true });
      rejectLedgerCall(result, String(rejection), true);
      continue;
    }

    const outcome = {
      ...result,
      provider: route.provider,
      model: result.model || route.model,
      fallbackUsed: index > 0,
      failures,
    };
    recordDispatchOutcome(policy, outcome);
    return outcome;
  }

  const outcome = { ok: false, reason: 'all_providers_failed', failures };
  recordDispatchOutcome(policy, outcome);
  return outcome;
}

// Passive observability (GATE_LLM_DISPATCH_METRICS, dark by default): one
// llm_dispatch_log row per completed chain, consumed by the daily exception
// digest. Lazy-required and fire-and-forget so the metrics path can never
// slow down or break the dispatch it observes.
function recordDispatchOutcome(policy, outcome) {
  try {
    metrics.recordDispatch(policy, outcome);
  } catch (err) {
    logger.debug(`[llm] dispatch metrics skipped: ${err.message}`);
  }
}

module.exports = {
  anthropicText,
  // Exported so a caller reasoning about how long one pass can run reads the
  // dispatcher's REAL budget instead of mirroring the number (see
  // utils/claim-ceiling.js).
  DEFAULT_FALLBACK_BUDGET_MS,
  callOpenAI,
  callGemini,
  callAnthropic,
  dispatch,
  dispatchWithFallback,
  extractOpenAIText,
  parseLooseJson,
  providerErrorReason,
  OPENAI_RESPONSES_API,
  geminiUrl,
};
