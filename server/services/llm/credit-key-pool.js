'use strict';

/**
 * AI credit key pool (GATE_AI_CREDIT_KEYS, dark by default).
 *
 * The owner's Claude Max / ChatGPT Pro plans each grant a monthly API credit
 * that lands in its OWN API organization, so there is one credit-only key per
 * organization. With the gate on, Anthropic and OpenAI calls that carry the
 * MAIN key are tried on the credit keys first (env order) and fall back to
 * the main key when the credits run out.
 *
 *   ANTHROPIC_CREDIT_KEYS=sk-ant-...,sk-ant-...   (comma separated)
 *   OPENAI_CREDIT_KEYS=sk-...,sk-...
 *
 * One wrapper around globalThis.fetch, installed once at process start
 * (server/index.js, right after instrument.js), covers every caller: the
 * @anthropic-ai/sdk captures globalThis.fetch when a client is built, and
 * every OpenAI call is a raw fetch.
 *
 * A call is touched only when ALL hold; anything else gets the original
 * fetch with the original arguments, untouched:
 *   - input is a string or URL (a Request passes through), method POST,
 *     host exactly api.anthropic.com or api.openai.com;
 *   - the path is allowlisted (stateless endpoints only; /v1/responses only
 *     with "store":false so no stored state is left in a credit organization);
 *   - the request carries the MAIN key (a call with any other key passes);
 *   - the body can be sent twice (no streams);
 *   - Anthropic bodies that name a file_id or container pass (those
 *     resources live in the main organization).
 *
 * Pauses are in memory, per process, per provider + key. Key numbers in logs
 * and in the status are 1-based env positions. Key values are never logged or
 * returned.
 */

const MARKER = Symbol.for('waves.creditKeyPool');

const HOUR_MS = 60 * 60 * 1000;
const CREDIT_PAUSE_MS = 6 * HOUR_MS;
const AUTH_PAUSE_MS = 1 * HOUR_MS;
const MODEL_PAUSE_MS = 1 * HOUR_MS;
const RATE_DEFAULT_MS = 60 * 1000;
const RATE_CAP_MS = 300 * 1000;

const INSPECT_STATUSES = new Set([400, 401, 403, 404, 429]);

const PROVIDERS = {
  anthropic: {
    host: 'api.anthropic.com',
    paths: new Set(['/v1/messages', '/v1/messages/count_tokens']),
    keysEnv: 'ANTHROPIC_CREDIT_KEYS',
    mainEnv: 'ANTHROPIC_API_KEY',
  },
  openai: {
    host: 'api.openai.com',
    paths: new Set([
      '/v1/chat/completions',
      '/v1/embeddings',
      '/v1/moderations',
      '/v1/images/generations',
      '/v1/images/edits',
      '/v1/audio/transcriptions',
      '/v1/audio/speech',
      '/v1/responses',
    ]),
    keysEnv: 'OPENAI_CREDIT_KEYS',
    mainEnv: 'OPENAI_API_KEY',
  },
};

let installedPool = null;

function parseKeys(raw, mainKey) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const key = part.trim();
    if (!key || key === mainKey || out.includes(key)) continue;
    out.push(key);
  }
  return out;
}

function lazyLogger() {
  // Required on first use so installing the pool at the top of index.js does
  // not load winston/config before the rest of the boot.
  try { return require('../logger'); } catch { return null; }
}

function bodyCanReplay(body) {
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  return false;
}

function resolveTarget(input, init) {
  // Returns { provider, pathname } when this call may be swapped, else null.
  let url;
  if (typeof input === 'string') {
    try { url = new URL(input); } catch { return null; }
  } else if (typeof URL !== 'undefined' && input instanceof URL) {
    url = input;
  } else {
    return null; // Request object or anything else
  }
  if (url.protocol !== 'https:') return null;
  const method = init && typeof init.method === 'string' ? init.method.toUpperCase() : 'GET';
  if (method !== 'POST') return null;
  for (const [provider, def] of Object.entries(PROVIDERS)) {
    if (url.hostname === def.host && def.paths.has(url.pathname)) {
      return { provider, pathname: url.pathname };
    }
  }
  return null;
}

function parseRetryAfterMs(response) {
  let raw;
  try { raw = response.headers.get('retry-after'); } catch { raw = null; }
  const seconds = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return RATE_DEFAULT_MS;
  return Math.min(Math.max(seconds * 1000, 1000), RATE_CAP_MS);
}

function errorFields(json) {
  const err = json && typeof json === 'object' ? json.error : null;
  if (!err || typeof err !== 'object') return { message: '', code: '', type: '' };
  return {
    message: typeof err.message === 'string' ? err.message : '',
    code: typeof err.code === 'string' ? err.code : '',
    type: typeof err.type === 'string' ? err.type : '',
  };
}

// Decides whether a CREDIT key's answer means "try the next key".
// Returns { pauseMs, reason, level } or null (hand the response to the caller).
async function failoverDecision(provider, response) {
  if (!INSPECT_STATUSES.has(response.status)) return null;
  let json;
  try {
    json = await response.clone().json();
  } catch {
    return null;
  }
  const { message, code, type } = errorFields(json);
  const status = response.status;

  if (status === 401 || status === 403) {
    return { pauseMs: AUTH_PAUSE_MS, reason: `credit key rejected (HTTP ${status})`, level: 'error' };
  }
  if (provider === 'anthropic' && status === 400) {
    if (/credit balance is too low/i.test(message) || /reached your specified API usage limits/i.test(message)) {
      return { pauseMs: CREDIT_PAUSE_MS, reason: 'credit balance too low', level: 'warn' };
    }
    return null;
  }
  if (provider === 'openai' && status === 429 && (code === 'insufficient_quota' || type === 'insufficient_quota')) {
    return { pauseMs: CREDIT_PAUSE_MS, reason: 'insufficient quota', level: 'warn' };
  }
  if (provider === 'openai' && status === 404 && code === 'model_not_found') {
    return { pauseMs: MODEL_PAUSE_MS, reason: 'model not found for this key', level: 'warn' };
  }
  if (status === 429) {
    const pauseMs = parseRetryAfterMs(response);
    return { pauseMs, reason: `rate limited, retry in ${Math.round(pauseMs / 1000)}s`, level: 'warn' };
  }
  return null;
}

function formatPause(ms) {
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function discard(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') {
      const p = response.body.cancel();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch { /* nothing to free */ }
}

function createCreditKeyFetch(baseFetch, opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const getLogger = () => opts.logger || lazyLogger();

  const pools = {};
  for (const [provider, def] of Object.entries(PROVIDERS)) {
    const mainKey = env[def.mainEnv] || '';
    pools[provider] = {
      mainKey,
      keys: parseKeys(env[def.keysEnv], mainKey),
      pauses: new Map(), // index -> { until, reason }
    };
  }

  function log(level, message) {
    try {
      const logger = getLogger();
      if (logger && typeof logger[level] === 'function') logger[level](message);
    } catch { /* logging must never break an AI call */ }
  }

  function mainKeyMatches(provider, init) {
    const pool = pools[provider];
    if (!pool.mainKey || !init || !init.headers) return null;
    let headers;
    try { headers = new Headers(init.headers); } catch { return null; }
    const wanted = provider === 'anthropic' ? pool.mainKey : `Bearer ${pool.mainKey}`;
    const have = headers.get(provider === 'anthropic' ? 'x-api-key' : 'authorization');
    return have === wanted ? headers : null;
  }

  function isPaused(provider, index) {
    const pool = pools[provider];
    const pause = pool.pauses.get(index);
    if (!pause) return false;
    if (pause.until > now()) return true;
    pool.pauses.delete(index);
    log('info', `[credit-keys] ${provider} key ${index + 1} back in use`);
    return false;
  }

  function pause(provider, index, decision) {
    pools[provider].pauses.set(index, { until: now() + decision.pauseMs, reason: decision.reason });
    log(decision.level, `[credit-keys] ${provider} key ${index + 1} paused ${formatPause(decision.pauseMs)}: ${decision.reason}`);
  }

  async function creditFetch(input, init) {
    const target = resolveTarget(input, init);
    if (!target) return baseFetch(input, init);
    const { provider, pathname } = target;
    const pool = pools[provider];
    if (!pool.keys.length) return baseFetch(input, init);

    const body = init.body;
    if (!bodyCanReplay(body)) return baseFetch(input, init);
    if (provider === 'anthropic' && typeof body === 'string' && (body.includes('"file_id"') || body.includes('"container"'))) {
      return baseFetch(input, init);
    }
    if (provider === 'openai' && pathname === '/v1/responses' && !(typeof body === 'string' && /"store"\s*:\s*false/.test(body))) {
      return baseFetch(input, init);
    }
    const original = mainKeyMatches(provider, init);
    if (!original) return baseFetch(input, init);

    for (let index = 0; index < pool.keys.length; index += 1) {
      if (isPaused(provider, index)) continue;
      const headers = new Headers(original);
      if (provider === 'anthropic') headers.set('x-api-key', pool.keys[index]);
      else headers.set('authorization', `Bearer ${pool.keys[index]}`);
      headers.delete('anthropic-workspace-id');
      headers.delete('openai-organization');
      headers.delete('openai-project');

      const response = await baseFetch(input, { ...init, headers }); // a thrown network error propagates
      const decision = await failoverDecision(provider, response);
      if (!decision) return response;
      discard(response);
      pause(provider, index, decision);
    }
    return baseFetch(input, init);
  }

  Object.defineProperty(creditFetch, MARKER, { value: true });
  Object.defineProperty(creditFetch, '__creditKeyPool', {
    value: {
      status() {
        const out = {};
        for (const provider of Object.keys(PROVIDERS)) {
          out[provider] = pools[provider].keys.map((_, index) => {
            const pauseInfo = pools[provider].pauses.get(index);
            const active = pauseInfo && pauseInfo.until > now();
            return {
              index: index + 1,
              pausedUntil: active ? new Date(pauseInfo.until).toISOString() : null,
              reason: active ? pauseInfo.reason : null,
            };
          });
        }
        return out;
      },
      keyCounts() {
        return { anthropic: pools.anthropic.keys.length, openai: pools.openai.keys.length };
      },
    },
  });
  return creditFetch;
}

function installCreditKeyPool({ env = process.env, now = Date.now, logger, target = globalThis } = {}) {
  if (env.GATE_AI_CREDIT_KEYS !== 'true') return { installed: false, reason: 'gate_off' };
  const current = target.fetch;
  if (typeof current !== 'function') return { installed: false, reason: 'no_fetch' };
  if (current[MARKER]) return { installed: true, reason: 'already_installed' };

  const anthropic = parseKeys(env.ANTHROPIC_CREDIT_KEYS, env.ANTHROPIC_API_KEY || '');
  const openai = parseKeys(env.OPENAI_CREDIT_KEYS, env.OPENAI_API_KEY || '');
  if (!anthropic.length && !openai.length) return { installed: false, reason: 'no_keys' };

  const wrapped = createCreditKeyFetch(current.bind(target), { env, now, logger });
  target.fetch = wrapped;
  installedPool = wrapped.__creditKeyPool;

  const message = `[credit-keys] pool installed: ${anthropic.length} anthropic key(s), ${openai.length} openai key(s)`;
  try {
    const log = logger || lazyLogger();
    if (log && typeof log.info === 'function') log.info(message);
  } catch { /* boot must not fail on logging */ }
  return { installed: true, reason: 'installed' };
}

function getCreditKeyPoolStatus() {
  if (!installedPool) return { installed: false, anthropic: [], openai: [] };
  const status = installedPool.status();
  return { installed: true, anthropic: status.anthropic, openai: status.openai };
}

module.exports = {
  installCreditKeyPool,
  createCreditKeyFetch,
  getCreditKeyPoolStatus,
  CREDIT_KEY_POOL_MARKER: MARKER,
};
