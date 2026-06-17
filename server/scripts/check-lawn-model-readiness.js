#!/usr/bin/env node
/**
 * One-shot model READINESS / entitlement check for the lawn diagnostic v0.5 pipeline.
 *
 *   node server/scripts/check-lawn-model-readiness.js [--strict] [--json]
 *
 * Pings each provider with the smallest harmless JSON prompt to catch — BEFORE merge —
 * bad/stale model IDs, missing entitlement, Responses-API access issues, wrong env var
 * names, missing keys, and Opus sampling-parameter incompatibilities.
 *
 * It is NOT a diagnostic run: no photos, no customer data, no prod DB, tiny max_tokens,
 * and NO temperature/top_p/top_k sent to Claude (Opus 4.x removed sampling controls;
 * passing them is itself an incompatibility we must avoid). It validates the EFFECTIVE
 * RESOLVED models (env override or default), not just the env var names.
 *
 * Exit code: 0 unless --strict (or LAWN_READINESS_STRICT=1) AND a check failed — so
 * local/dev can inspect failures without breaking unrelated workflows; prod-readiness/CI
 * runs it strict only when keys are present.
 */

// Load the repo-root .env BEFORE anything resolves model IDs / provider keys, so a local
// `npm run check:lawn-models` validates the configured lawn models — not defaults/missing
// keys. (Under `railway run` the env is already injected; dotenv is then a harmless no-op.)
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { LAWN_PIPELINE_MODELS } = require('../services/lawn-diagnostic-prompt');

// ── Pure helpers (exported for unit tests; no network) ────────────────────────
function looseJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  try { return JSON.parse(match ? match[0] : clean); } catch { return null; }
}

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

// Provider-specific HTTP → failureType classifiers (the labels the user asked for).
function classifyGemini(status) {
  if (status === 404 || status === 403) return 'gemini_model_unavailable_or_project_not_entitled';
  if (status === 400) return 'gemini_bad_request';
  if (status === 401) return 'gemini_auth_failed';
  if (status === 429) return 'gemini_rate_limited';
  return `gemini_http_${status}`;
}
function classifyAnthropic(status) {
  if (status === 400 || status === 404 || status === 403) return 'anthropic_model_unavailable_or_not_entitled';
  if (status === 401) return 'anthropic_auth_failed';
  if (status === 429) return 'anthropic_rate_limited';
  return `anthropic_http_${status}`;
}
function classifyOpenAI(status, bodyText = '') {
  if (/model_not_found|does not exist|do not have access|model_not_available/i.test(bodyText)) return 'openai_model_not_found_or_no_access';
  if (/insufficient_quota|exceeded your current quota/i.test(bodyText)) return 'openai_insufficient_quota';
  if (status === 401) return 'openai_auth_failed';
  if (status === 404) return 'openai_model_not_found_or_no_access';
  if (status === 429) return 'openai_rate_limited';
  return `openai_http_${status}`;
}
function classifyNetworkError(err) {
  return /abort|timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(err?.message || '') ? 'network_or_timeout' : 'unexpected_error';
}

const PROMPT = (provider) => `Reply with ONLY this JSON, nothing else: {"ok":true,"provider":"${provider}"}`;

// ── Provider pings (network; never throw) ─────────────────────────────────────
async function checkGemini(model) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (!key) return { ok: false, failureType: 'missing_key', detail: 'GEMINI_API_KEY / GOOGLE_API_KEY not set' };
  const started = Date.now();
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT('gemini') }] }],
        // Generous budget so a "thinking" Flash model can reason AND still emit the JSON.
        generationConfig: { temperature: 0, maxOutputTokens: 512 },
      }),
    });
    const latencyMs = Date.now() - started;
    if (!resp.ok) return { ok: false, status: resp.status, latencyMs, failureType: classifyGemini(resp.status), detail: (await resp.text()).slice(0, 200) };
    const data = await resp.json();
    // Join ALL text parts — a thinking model returns a thought part before the answer.
    const text = (data?.candidates?.[0]?.content?.parts || []).map((part) => part && part.text).filter(Boolean).join('');
    const parsed = looseJson(text);
    return parsed?.ok === true
      ? { ok: true, status: 200, latencyMs }
      : { ok: false, status: 200, latencyMs, failureType: 'unexpected_response', detail: 'reachable but did not return the expected JSON' };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, failureType: classifyNetworkError(err), detail: err.message };
  }
}

async function checkAnthropic(model) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) return { ok: false, failureType: 'missing_key', detail: 'ANTHROPIC_API_KEY not set' };
  const started = Date.now();
  try {
    // Direct REST + NO sampling controls (temperature/top_p/top_k) — exactly how the
    // challenge stage calls Opus, so this also catches a sampling-param incompatibility.
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 30, messages: [{ role: 'user', content: PROMPT('anthropic') }] }),
    });
    const latencyMs = Date.now() - started;
    if (!resp.ok) return { ok: false, status: resp.status, latencyMs, failureType: classifyAnthropic(resp.status), detail: (await resp.text()).slice(0, 200) };
    const data = await resp.json();
    const parsed = looseJson(data?.content?.[0]?.text);
    return parsed?.ok === true
      ? { ok: true, status: 200, latencyMs }
      : { ok: false, status: 200, latencyMs, failureType: 'unexpected_response', detail: 'reachable but did not return the expected JSON' };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, failureType: classifyNetworkError(err), detail: err.message };
  }
}

async function checkOpenAI(model) {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return { ok: false, failureType: 'missing_key', detail: 'OPENAI_API_KEY not set' };
  const started = Date.now();
  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_output_tokens: 30, input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT('openai') }] }] }),
    });
    const latencyMs = Date.now() - started;
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      return { ok: false, status: resp.status, latencyMs, failureType: classifyOpenAI(resp.status, detail), detail: detail.slice(0, 200) };
    }
    const data = await resp.json();
    const parsed = looseJson(extractOpenAIText(data));
    return parsed?.ok === true
      ? { ok: true, status: 200, latencyMs }
      : { ok: false, status: 200, latencyMs, failureType: 'unexpected_response', detail: 'reachable but did not return the expected JSON' };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, failureType: classifyNetworkError(err), detail: err.message };
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main() {
  const strict = process.argv.includes('--strict') || process.env.LAWN_READINESS_STRICT === '1';
  const asJson = process.argv.includes('--json');
  const m = LAWN_PIPELINE_MODELS;

  const checks = [
    { provider: 'gemini', role: 'perception', env: 'LAWN_VISION_MODEL', model: m.vision, fromEnv: !!process.env.LAWN_VISION_MODEL, run: checkGemini },
    { provider: 'anthropic', role: 'challenge', env: 'LAWN_CHALLENGE_MODEL', model: m.challenge, fromEnv: !!process.env.LAWN_CHALLENGE_MODEL, run: checkAnthropic },
    { provider: 'openai', role: 'writer', env: 'LAWN_WRITER_MODEL', model: m.writer, fromEnv: !!process.env.LAWN_WRITER_MODEL, run: checkOpenAI },
  ];

  const results = await Promise.all(checks.map(async (c) => ({ ...c, run: undefined, ...(await c.run(c.model)) })));

  if (asJson) {
    console.log(JSON.stringify({ models: m, results }, null, 2));
  } else {
    console.log('\nLawn Diagnostic v0.5 — model readiness (entitlement check, not a diagnostic run)');
    console.log('─'.repeat(88));
    for (const r of results) {
      const icon = r.ok ? '✓ OK  ' : '✗ FAIL';
      const src = r.fromEnv ? 'env' : 'default';
      const lat = r.latencyMs != null ? `${r.latencyMs}ms` : '—';
      console.log(`${icon}  ${r.role.padEnd(10)} ${r.provider.padEnd(9)} ${String(r.model).padEnd(20)} [${src}]  ${lat}`);
      if (!r.ok) console.log(`        → ${r.failureType}${r.detail ? `: ${r.detail}` : ''}`);
    }
    console.log('─'.repeat(88));
    const failed = results.filter((r) => !r.ok);
    console.log(failed.length ? `${failed.length}/${results.length} FAILED — set the matching LAWN_*_MODEL env to a known-good id, or grant entitlement.`
      : `All ${results.length} stages reachable and entitled.`);
    if (!strict && failed.length) console.log('(advisory mode — exit 0; rerun with --strict to fail the process)');
  }

  const anyFail = results.some((r) => !r.ok);
  process.exit(strict && anyFail ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => { console.error(`readiness check crashed: ${err.message}`); process.exit(2); });
}

module.exports = { looseJson, extractOpenAIText, classifyGemini, classifyAnthropic, classifyOpenAI, classifyNetworkError, checkGemini, checkAnthropic, checkOpenAI };
