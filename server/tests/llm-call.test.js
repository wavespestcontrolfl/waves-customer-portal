// Guards the shared cross-provider LLM dispatch (server/services/llm/call.js):
// the extracted parsers + the fail-closed (no-network) behavior when a key is
// missing, and that dispatch routes by provider. No live API calls.
const {
  callOpenAI,
  callGemini,
  callAnthropic,
  dispatch,
  extractOpenAIText,
  parseLooseJson,
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
    expect(parseLooseJson('not json')).toBeNull();
    expect(parseLooseJson('')).toBeNull();
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
