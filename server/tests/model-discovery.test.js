// Model discovery: provider lists are fetched through an injected fetch so the
// suite needs no network or keys. Covers the tolerant match ("fable 5.1" →
// claude-fable-5-1), the OpenAI noise filter, the per-provider cache, missing
// keys, and the entitlement probe's status mapping.

jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const discovery = require('../services/model-discovery');

const jsonResponse = (status, body) => ({ status, text: async () => JSON.stringify(body) });

function fakeFetch(routes) {
  const calls = [];
  const impl = jest.fn(async (url) => {
    calls.push(url);
    for (const [pattern, response] of routes) {
      if (url.includes(pattern)) return typeof response === 'function' ? response(url) : response;
    }
    return jsonResponse(404, {});
  });
  impl.calls = calls;
  return impl;
}

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ANTHROPIC_API_KEY = 'a';
  process.env.OPENAI_API_KEY = 'o';
  process.env.GEMINI_API_KEY = 'g';
  discovery.clearCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const ANTHROPIC = jsonResponse(200, {
  data: [
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', created_at: '2026-09-01T00:00:00Z' },
    { id: 'claude-fable-5', display_name: 'Claude Fable 5', created_at: '2026-05-01T00:00:00Z' },
    { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-08-01T00:00:00Z' },
  ],
});
const OPENAI = jsonResponse(200, {
  data: [
    { id: 'gpt-5.7-astra', created: 1788480000 },
    { id: 'ft:gpt-5-mini:waves:abc', created: 1780000000 },
    { id: 'whisper-1', created: 1700000000 },
    { id: 'gpt-5.6-sol', created: 1770000000 },
  ],
});
const GEMINI = jsonResponse(200, {
  models: [
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embedding-001', displayName: 'Embedding 001', supportedGenerationMethods: ['embedContent'] },
  ],
});

describe('normalize / matches', () => {
  it('matches punctuation-insensitively, every token required', () => {
    expect(discovery.normalize('Claude Fable 5.1')).toBe('claudefable51');
    const item = { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' };
    expect(discovery.matches(item, discovery.tokens('fable 5.1'))).toBe(true);
    expect(discovery.matches(item, discovery.tokens('FABLE-5-1'))).toBe(true);
    expect(discovery.matches(item, discovery.tokens('fable 5.2'))).toBe(false);
    expect(discovery.matches(item, discovery.tokens('opus'))).toBe(false);
  });
});

describe('search', () => {
  it('finds a freshly released id across providers and drops OpenAI noise', async () => {
    const fetchImpl = fakeFetch([['api.anthropic.com/v1/models', ANTHROPIC], ['api.openai.com/v1/models', OPENAI], ['generativelanguage', GEMINI]]);
    const fable = await discovery.search('fable 5.1', { fetchImpl });
    expect(fable.results.map((r) => r.id)).toEqual(['claude-fable-5-1']);
    expect(fable.results[0]).toMatchObject({ provider: 'anthropic', label: 'Claude Fable 5.1' });

    const astra = await discovery.search('astra', { fetchImpl });
    expect(astra.results.map((r) => r.id)).toEqual(['gpt-5.7-astra']);

    const gpt = await discovery.search('gpt', { fetchImpl });
    expect(gpt.results.map((r) => r.id)).toEqual(['gpt-5.7-astra', 'gpt-5.6-sol']); // ft:* and whisper filtered

    const gem = await discovery.search('flash', { providers: ['gemini'], fetchImpl });
    expect(gem.results.map((r) => r.id)).toEqual(['gemini-3.8-flash']); // embedding-only model excluded
  });

  it('caches each provider list and reports providers without a key or with a failing call', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const fetchImpl = fakeFetch([['api.anthropic.com/v1/models', ANTHROPIC], ['api.openai.com/v1/models', jsonResponse(500, {})]]);
    const first = await discovery.search('claude', { fetchImpl });
    expect(first.results.map((r) => r.id)).toEqual(['claude-fable-5-1', 'claude-opus-5', 'claude-fable-5']);
    expect(first.unavailable).toEqual(expect.arrayContaining([
      { provider: 'gemini', reason: 'no_key' },
      { provider: 'openai', reason: 'http_500' },
    ]));
    const anthropicCalls = () => fetchImpl.calls.filter((u) => u.includes('api.anthropic.com')).length;
    expect(anthropicCalls()).toBe(1);
    await discovery.search('opus', { fetchImpl });
    expect(anthropicCalls()).toBe(1); // served from cache
  });

  it('returns no results for an empty query but still reports availability', async () => {
    const fetchImpl = fakeFetch([['api.anthropic.com', ANTHROPIC], ['api.openai.com', OPENAI], ['generativelanguage', GEMINI]]);
    const out = await discovery.search('', { fetchImpl });
    expect(out.results).toEqual([]);
    expect(out.unavailable).toEqual([]);
  });
});

describe('probe', () => {
  it('maps the retrieve endpoint status to an entitlement verdict', async () => {
    const fetchImpl = fakeFetch([
      ['/v1/models/claude-fable-5-1', jsonResponse(200, { id: 'claude-fable-5-1' })],
      ['/v1/models/claude-nope', jsonResponse(404, { error: {} })],
      ['/v1/models/gpt-5.7-astra', jsonResponse(403, { error: {} })],
    ]);
    expect(await discovery.probe('anthropic', 'claude-fable-5-1', { fetchImpl })).toMatchObject({ ok: true });
    expect(await discovery.probe('anthropic', 'claude-nope', { fetchImpl })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await discovery.probe('openai', 'gpt-5.7-astra', { fetchImpl })).toMatchObject({ ok: false, reason: 'not_entitled' });
    expect(await discovery.probe('openai', 'bad id with spaces', { fetchImpl })).toMatchObject({ ok: false, reason: 'bad_id' });
    delete process.env.OPENAI_API_KEY;
    expect(await discovery.probe('openai', 'gpt-5.7-astra', { fetchImpl })).toMatchObject({ ok: false, reason: 'no_key' });
  });
});
