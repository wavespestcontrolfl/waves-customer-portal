// Guards the shared cross-provider LLM dispatch (server/services/llm/call.js):
// the extracted parsers + the fail-closed (no-network) behavior when a key is
// missing, and that dispatch routes by provider. No live API calls.
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const {
  callOpenAI,
  callGemini,
  callAnthropic,
  dispatch,
  dispatchWithFallback,
  extractOpenAIText,
  parseLooseJson,
  providerErrorReason,
} = require('../services/llm/call');
const { PROVIDER, ROUTES, FLAGSHIP, OPENAI_BEST, GEMINI_VISION_BEST } = require('../config/models');

describe('llm/call parsers', () => {
  test('extractOpenAIText reads output_text and the output[].content walk', () => {
    expect(extractOpenAIText({ output_text: '{"ok":true}' })).toBe('{"ok":true}');
    expect(extractOpenAIText({ output: [{ content: [{ type: 'output_text', text: 'a' }, { type: 'text', text: 'b' }] }] })).toBe('ab');
    expect(extractOpenAIText({})).toBe('');
  });

  test('parseLooseJson tolerates fenced / preamble JSON, rejects non-JSON', () => {
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJson('sure: {"b":2} done')).toEqual({ b: 2 });
    expect(parseLooseJson('ideas: [{"title":"one"}] done')).toEqual([{ title: 'one' }]);
    expect(parseLooseJson('not json')).toBeNull();
    expect(parseLooseJson('')).toBeNull();
  });

  test('providerErrorReason preserves a provider HTTP status without response text', () => {
    expect(providerErrorReason('anthropic', { status: 529 })).toBe('anthropic_529');
    expect(providerErrorReason('anthropic', { message: '529 overloaded' })).toBe('anthropic_529');
    expect(providerErrorReason('anthropic', new Error('socket closed'))).toBe('error');
  });
});

describe('llm/call fails closed with no key and makes NO network call', () => {
  const saved = {};
  beforeEach(() => {
    saved.g = process.env.GEMINI_API_KEY; saved.go = process.env.GOOGLE_API_KEY;
    saved.a = process.env.ANTHROPIC_API_KEY; saved.o = process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    if (saved.g) process.env.GEMINI_API_KEY = saved.g;
    if (saved.go) process.env.GOOGLE_API_KEY = saved.go;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.o) process.env.OPENAI_API_KEY = saved.o;
  });

  test('callOpenAI → no_key, no fetch', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      expect(await callOpenAI({ model: OPENAI_BEST, text: 'hi' })).toEqual({ ok: false, reason: 'no_key' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  test('callGemini → no_key, no fetch', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      expect(await callGemini({ model: GEMINI_VISION_BEST, text: 'hi' })).toEqual({ ok: false, reason: 'no_key' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  test('callAnthropic → no_key', async () => {
    expect(await callAnthropic({ model: FLAGSHIP, text: 'hi' })).toEqual({ ok: false, reason: 'no_key' });
  });

  test('dispatch routes by provider and fails closed (OpenAI route, no key)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      expect(ROUTES.leadClassify.provider).toBe(PROVIDER.OPENAI);
      expect(await dispatch(ROUTES.leadClassify, { text: 'hi' })).toEqual({ ok: false, reason: 'no_key' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  test('dispatch rejects a missing/invalid route', async () => {
    expect(await dispatch(null)).toEqual({ ok: false, reason: 'no_route' });
    expect(await dispatch({ provider: 'nope', model: 'x' })).toEqual({ ok: false, reason: 'unknown_provider_nope' });
  });
});

// Prompt caching: callAnthropic sends system as a single text block carrying
// an ephemeral cache_control breakpoint (tools render before system, so the
// one marker caches both for every dispatch() caller).
describe('callAnthropic prompt caching', () => {
  let saved;
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  });

  test('system goes out as one text block with an ephemeral breakpoint', async () => {
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    const r = await callAnthropic({ model: FLAGSHIP, system: 'You are a test.', text: 'hi' });
    expect(r.ok).toBe(true);
    expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({
      system: [{ type: 'text', text: 'You are a test.', cache_control: { type: 'ephemeral' } }],
    }));
  });

  test('no system → no system field on the request', async () => {
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    await callAnthropic({ model: FLAGSHIP, text: 'hi' });
    expect(mockAnthropicCreate.mock.calls.at(-1)[0].system).toBeUndefined();
  });

  test('forwards temperature for repeatable vision scoring', async () => {
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    await callAnthropic({ model: FLAGSHIP, text: 'inspect', temperature: 0.2 });
    expect(mockAnthropicCreate.mock.calls.at(-1)[0].temperature).toBe(0.2);
  });

  // The SDK's per-request timeout applies to EACH attempt and its default
  // retry policy is 2 retries, so without maxRetries:0 a stalled provider can
  // hold a budgeted caller (fact-check publish lock: 60s ceiling) for ~3x its
  // timeout. A timeoutMs budget must be a true wall-clock ceiling.
  test('a timeoutMs budget disables SDK retries (maxRetries: 0)', async () => {
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    await callAnthropic({ model: FLAGSHIP, text: 'hi', timeoutMs: 60000 });
    expect(mockAnthropicCreate.mock.calls.at(-1)[1]).toEqual({ timeout: 60000, maxRetries: 0 });
  });

  test('no timeoutMs → no per-request options (SDK default timeout + retries apply)', async () => {
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    await callAnthropic({ model: FLAGSHIP, text: 'hi' });
    expect(mockAnthropicCreate.mock.calls.at(-1)[1]).toBeUndefined();
  });

  test('handled Anthropic overload returns a classified fallback result', async () => {
    const err = new Error('529 {"type":"overloaded_error"}');
    err.status = 529;
    mockAnthropicCreate.mockRejectedValue(err);

    await expect(callAnthropic({ model: FLAGSHIP, text: 'hi' }))
      .resolves.toEqual({ ok: false, reason: 'anthropic_529' });
  });
});

// jsonMode is the mechanism the knowledge-bridge fallback relies on: invalid JSON
// must surface as { ok:false } so the caller falls back to Claude instead of
// returning text its strict JSON.parse can't handle.
describe('callOpenAI jsonMode parsing', () => {
  let saved;
  beforeEach(() => { saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-key'; });
  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
  });

  test('valid JSON → ok with parsed json', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ output_text: '{"summary":"ok"}' }) });
    const r = await callOpenAI({ model: OPENAI_BEST, text: 'hi', jsonMode: true });
    expect(r.ok).toBe(true);
    expect(r.json).toEqual({ summary: 'ok' });
  });

  test('non-JSON output → empty_json so the caller can fall back', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ output_text: 'no json here' }) });
    expect(await callOpenAI({ model: OPENAI_BEST, text: 'hi', jsonMode: true })).toEqual({ ok: false, reason: 'empty_json' });
  });

  test('incomplete response → fallback signal instead of partial output', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'partial' }),
    });
    expect(await callOpenAI({ model: OPENAI_BEST, text: 'hi', jsonMode: false })).toEqual({ ok: false, reason: 'openai_incomplete' });
    const body = JSON.parse(global.fetch.mock.calls.at(-1)[1].body);
    expect(body.reasoning).toEqual({ effort: 'low' });
  });

  // These lanes route customer PII (inbound email sender/subject/body, call
  // transcripts, names/addresses) through OpenAI — the Responses API retains
  // application state unless storage is explicitly disabled, so EVERY request
  // built by the shared adapter must carry store:false.
  test('every Responses request disables storage (store: false)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ output_text: '{"ok":true}' }) });
    await callOpenAI({ model: OPENAI_BEST, text: 'customer email body', jsonMode: true });
    const body = JSON.parse(global.fetch.mock.calls.at(-1)[1].body);
    expect(body.store).toBe(false);
  });

  // Without a bounded default, an OpenAI primary that accepts the connection
  // and stalls would hang forever and the Anthropic fallback would never run.
  // The default mirrors the Anthropic SDK's built-in 10-minute request timeout
  // that bounded these lanes before the failover PR.
  test('applies a 10-minute default abort timeout when the caller passes none', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ output_text: '{"ok":true}' }) });
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    await callOpenAI({ model: OPENAI_BEST, text: 'hi' });
    expect(timeoutSpy).toHaveBeenCalledWith(10 * 60 * 1000);
    expect(global.fetch.mock.calls.at(-1)[1].signal).toBeInstanceOf(AbortSignal);
  });

  test('an explicit timeoutMs overrides the default abort timeout', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ output_text: '{"ok":true}' }) });
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    await callOpenAI({ model: OPENAI_BEST, text: 'hi', timeoutMs: 1234 });
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
  });
});

describe('dispatchWithFallback', () => {
  let savedOpenAI;
  let savedAnthropic;
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    savedOpenAI = process.env.OPENAI_API_KEY;
    savedAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'openai-test';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (savedOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOpenAI;
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAnthropic;
  });

  test('uses the other provider when primary is unavailable', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 529 });
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'backup copy' }] });
    const result = await dispatchWithFallback({
      primary: { provider: PROVIDER.OPENAI, model: 'openai-primary' },
      fallback: { provider: PROVIDER.ANTHROPIC, model: 'claude-backup' },
    }, { text: 'write', jsonMode: false });
    expect(result).toMatchObject({ ok: true, provider: PROVIDER.ANTHROPIC, fallbackUsed: true, text: 'backup copy' });
    expect(result.failures[0]).toMatchObject({ provider: PROVIDER.OPENAI, reason: 'openai_529' });
  });

  test('uses the other provider when primary returns blank text', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ output_text: '   ' }) });
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'backup copy' }] });
    const result = await dispatchWithFallback({
      primary: { provider: PROVIDER.OPENAI, model: 'openai-primary' },
      fallback: { provider: PROVIDER.ANTHROPIC, model: 'claude-backup' },
    }, { text: 'write', jsonMode: false });
    expect(result).toMatchObject({ ok: true, provider: PROVIDER.ANTHROPIC, fallbackUsed: true, text: 'backup copy' });
    expect(result.failures[0]).toMatchObject({ provider: PROVIDER.OPENAI, reason: 'empty_text' });
  });

  test('shares one timeout budget across primary and fallback', async () => {
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1300);
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 529 });
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'backup copy' }] });
    const result = await dispatchWithFallback({
      primary: { provider: PROVIDER.OPENAI, model: 'openai-primary' },
      fallback: { provider: PROVIDER.ANTHROPIC, model: 'claude-backup' },
    }, { text: 'write', jsonMode: false, timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    // The remaining budget rides to the fallback with SDK retries disabled, so
    // the shared deadline is a true ceiling (retries would run ~3x past it).
    expect(mockAnthropicCreate.mock.calls.at(-1)[1]).toEqual({ timeout: 700, maxRetries: 0 });
  });

  test('rejects a same-provider fallback policy', async () => {
    const result = await dispatchWithFallback({
      primary: { provider: PROVIDER.OPENAI, model: 'a' },
      fallback: { provider: PROVIDER.OPENAI, model: 'b' },
    }, { text: 'write' });
    expect(result).toEqual({ ok: false, reason: 'same_provider_fallback', failures: [] });
  });
});
