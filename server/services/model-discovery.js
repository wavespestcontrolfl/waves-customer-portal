// Model discovery — search the providers' live model lists so the Models tab
// can offer an id the day it ships (Fable 5.1 yesterday, Astra tomorrow)
// without a deploy, and without dumping OpenAI's fine-tune/snapshot noise
// into a picker. Every provider exposes a list endpoint and a retrieve
// endpoint; both are read-only and spend no tokens:
//
//   Anthropic  GET https://api.anthropic.com/v1/models[/{id}]
//   OpenAI     GET https://api.openai.com/v1/models[/{id}]
//   Gemini     GET https://generativelanguage.googleapis.com/v1beta/models[/{id}]
//
// Lists are cached in-process for LIST_TTL_MS; a provider whose key is missing
// or whose call fails is reported as unavailable rather than failing the
// search. `probe(provider, id)` is the entitlement check the composer runs
// before it offers an env line for a searched id — a listed model is not
// necessarily enabled on this account, and the retrieve endpoint is what
// proves it (that is how gemini-3.8-flash was verified on the prod key).

const logger = require('./logger');

const LIST_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 25;

const PROVIDERS = ['anthropic', 'openai', 'gemini'];

const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

// Per-provider request shape + normaliser to { id, label, createdAt }.
const ADAPTERS = {
  anthropic: {
    hasKey: () => !!process.env.ANTHROPIC_API_KEY,
    listUrl: () => 'https://api.anthropic.com/v1/models?limit=100',
    retrieveUrl: (id) => `https://api.anthropic.com/v1/models/${encodeURIComponent(id)}`,
    headers: () => ({ 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }),
    items: (body) => (body.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id, createdAt: m.created_at || null })),
  },
  openai: {
    hasKey: () => !!process.env.OPENAI_API_KEY,
    listUrl: () => 'https://api.openai.com/v1/models',
    retrieveUrl: (id) => `https://api.openai.com/v1/models/${encodeURIComponent(id)}`,
    headers: () => ({ Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }),
    items: (body) => (body.data || [])
      // Fine-tunes (ft:…), org snapshots and non-chat families are noise for a
      // text/vision picker; the search still matches anything left.
      .filter((m) => !/^ft:|^(dall-e|tts|whisper|text-embedding|omni-moderation|davinci|babbage)/.test(m.id))
      .map((m) => ({ id: m.id, label: m.id, createdAt: m.created ? new Date(m.created * 1000).toISOString() : null })),
  },
  gemini: {
    hasKey: () => !!geminiKey(),
    // Key travels in the x-goog-api-key header, never the URL — URLs end up
    // in proxy logs and error tooling.
    listUrl: () => 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    retrieveUrl: (id) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}`,
    headers: () => ({ 'x-goog-api-key': geminiKey() }),
    items: (body) => (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name, createdAt: null })),
  },
};

// "fable 5.1" should find claude-fable-5-1; "Astra" should find whatever id
// OpenAI ships. Compare on lower-case alphanumerics only, token by token.
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function tokens(q) {
  return String(q || '').toLowerCase().split(/[\s,]+/).map(normalize).filter(Boolean);
}
function matches(item, queryTokens) {
  const hay = normalize(item.id) + ' ' + normalize(item.label);
  return queryTokens.every((t) => hay.includes(t));
}

// ── cache ──────────────────────────────────────────────────────────────
const cache = new Map(); // provider → { at, items }

async function fetchJson(url, headers, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

async function listProvider(provider, { fetchImpl = fetch, force = false } = {}) {
  const adapter = ADAPTERS[provider];
  if (!adapter) return { provider, available: false, reason: 'unknown_provider', items: [] };
  if (!adapter.hasKey()) return { provider, available: false, reason: 'no_key', items: [] };
  const hit = cache.get(provider);
  if (!force && hit && Date.now() - hit.at < LIST_TTL_MS) return { provider, available: true, items: hit.items, cached: true };
  try {
    const { status, body } = await fetchJson(adapter.listUrl(), adapter.headers(), fetchImpl);
    if (status !== 200 || !body) {
      logger.warn(`[model-discovery] ${provider} list HTTP ${status}`);
      return { provider, available: false, reason: `http_${status}`, items: hit?.items || [] };
    }
    const items = adapter.items(body).filter((m) => m.id);
    cache.set(provider, { at: Date.now(), items });
    return { provider, available: true, items, cached: false };
  } catch (err) {
    logger.warn(`[model-discovery] ${provider} list failed: ${err.message}`);
    return { provider, available: false, reason: err.name === 'AbortError' ? 'timeout' : 'fetch_failed', items: hit?.items || [] };
  }
}

// Modalities the live search can serve. The list endpoints describe text
// generation only — none of the three says whether a model accepts images —
// so `vision` results are returned flagged `capUnverified` and the client
// says so; image / video / embedding selectors are locked and never search.
const SEARCHABLE_CAPS = new Set(['text', 'vision']);

/**
 * search('fable 5.1', { providers: ['anthropic'], cap: 'vision' }) →
 *   { query, cap, capUnverified, results: [{ provider, id, label, createdAt }], unavailable: [{ provider, reason }] }
 * Results newest-first, capped at MAX_RESULTS. Empty query → empty results
 * (the picker is the browse surface for the catalog; search is for the new).
 * An unsearchable cap → no results and reason 'cap_not_searchable'.
 */
async function search(query, { providers = PROVIDERS, cap = 'text', fetchImpl = fetch } = {}) {
  const q = tokens(query);
  if (!SEARCHABLE_CAPS.has(cap)) {
    return { query: query || '', cap, capUnverified: false, results: [], unavailable: [{ provider: 'all', reason: 'cap_not_searchable' }] };
  }
  const wanted = providers.filter((p) => PROVIDERS.includes(p));
  const lists = await Promise.all(wanted.map((p) => listProvider(p, { fetchImpl })));
  const unavailable = lists.filter((l) => !l.available).map((l) => ({ provider: l.provider, reason: l.reason }));
  const capUnverified = cap === 'vision';
  if (!q.length) return { query: query || '', cap, capUnverified, results: [], unavailable };
  const results = lists
    .flatMap((l) => l.items.filter((m) => matches(m, q)).map((m) => ({ provider: l.provider, ...m })))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || a.id.localeCompare(b.id))
    .slice(0, MAX_RESULTS);
  return { query, cap, capUnverified, results, unavailable };
}

/**
 * probe(provider, id) → { ok, status, reason }. ok=true means the account can
 * see the model on that provider's retrieve endpoint; 404/403 → not entitled.
 */
async function probe(provider, id, { fetchImpl = fetch } = {}) {
  const adapter = ADAPTERS[provider];
  if (!adapter) return { ok: false, reason: 'unknown_provider' };
  if (!adapter.hasKey()) return { ok: false, reason: 'no_key' };
  if (!/^[\w.:@/-]{2,120}$/.test(id || '')) return { ok: false, reason: 'bad_id' };
  try {
    const { status } = await fetchJson(adapter.retrieveUrl(id), adapter.headers(), fetchImpl);
    if (status === 200) return { ok: true, status };
    return { ok: false, status, reason: status === 404 ? 'not_found' : status === 403 ? 'not_entitled' : `http_${status}` };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'fetch_failed' };
  }
}

function clearCache() {
  cache.clear();
}

module.exports = { search, probe, listProvider, clearCache, normalize, matches, tokens, PROVIDERS, SEARCHABLE_CAPS, LIST_TTL_MS };
