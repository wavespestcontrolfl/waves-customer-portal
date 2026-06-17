// Guards the pre-merge model READINESS check (server/scripts/check-lawn-model-readiness.js):
// the pure helpers + failure classifiers, the resolved-model export, and the fail-closed
// (no-network) behavior when a key is missing. No live API calls.
const {
  looseJson,
  extractOpenAIText,
  classifyGemini,
  classifyAnthropic,
  classifyOpenAI,
  classifyNetworkError,
  checkGemini,
  checkAnthropic,
  checkOpenAI,
} = require('../scripts/check-lawn-model-readiness');
const { LAWN_PIPELINE_MODELS } = require('../services/lawn-diagnostic-prompt');
const { LAWN_CHALLENGE } = require('../config/models'); // registry = single source of truth for the Anthropic id

describe('lawn model readiness check', () => {
  test('exports the RESOLVED pipeline models (env override or default)', () => {
    expect(LAWN_PIPELINE_MODELS.vision).toBe(process.env.LAWN_VISION_MODEL || 'gemini-3.5-flash');
    // Challenge id is derived from the central registry — never spelled here.
    expect(LAWN_PIPELINE_MODELS.challenge).toBe(LAWN_CHALLENGE);
    // Writer is decoupled from the global OPENAI_MODEL on purpose.
    expect(LAWN_PIPELINE_MODELS.writer).toBe(process.env.LAWN_WRITER_MODEL || 'gpt-5.5');
  });

  test('looseJson tolerates fenced / preamble JSON, rejects non-JSON', () => {
    expect(looseJson('```json\n{"ok":true,"provider":"gemini"}\n```')).toEqual({ ok: true, provider: 'gemini' });
    expect(looseJson('sure: {"ok":true}')).toEqual({ ok: true });
    expect(looseJson('not json')).toBeNull();
    expect(looseJson('')).toBeNull();
  });

  test('extractOpenAIText reads output_text and the output[].content walk', () => {
    expect(extractOpenAIText({ output_text: '{"ok":true}' })).toBe('{"ok":true}');
    expect(extractOpenAIText({ output: [{ content: [{ type: 'output_text', text: 'a' }, { type: 'text', text: 'b' }] }] })).toBe('ab');
    expect(extractOpenAIText({})).toBe('');
  });

  test('classifiers map entitlement/access errors to the documented labels', () => {
    // Anthropic 400/404/403 → the Opus-4.8 entitlement risk.
    expect(classifyAnthropic(400)).toBe('anthropic_model_unavailable_or_not_entitled');
    expect(classifyAnthropic(404)).toBe('anthropic_model_unavailable_or_not_entitled');
    expect(classifyAnthropic(401)).toBe('anthropic_auth_failed');
    // Gemini 404/403 → model unavailable / project not entitled.
    expect(classifyGemini(404)).toBe('gemini_model_unavailable_or_project_not_entitled');
    expect(classifyGemini(403)).toBe('gemini_model_unavailable_or_project_not_entitled');
    // OpenAI: body-driven model_not_found / insufficient_quota, else status.
    expect(classifyOpenAI(404, 'The model `gpt-5.5` does not exist or you do not have access')).toBe('openai_model_not_found_or_no_access');
    expect(classifyOpenAI(400, 'model_not_found')).toBe('openai_model_not_found_or_no_access');
    expect(classifyOpenAI(429, 'insufficient_quota: exceeded your current quota')).toBe('openai_insufficient_quota');
    expect(classifyOpenAI(401, 'bad key')).toBe('openai_auth_failed');
    expect(classifyNetworkError(new Error('fetch failed'))).toBe('network_or_timeout');
    expect(classifyNetworkError(new Error('weird'))).toBe('unexpected_error');
  });

  test('each provider check fails closed with missing_key and makes NO network call', async () => {
    const saved = {
      g: process.env.GEMINI_API_KEY, go: process.env.GOOGLE_API_KEY,
      a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY,
    };
    delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      expect(await checkGemini('x')).toMatchObject({ ok: false, failureType: 'missing_key' });
      expect(await checkAnthropic('x')).toMatchObject({ ok: false, failureType: 'missing_key' });
      expect(await checkOpenAI('x')).toMatchObject({ ok: false, failureType: 'missing_key' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (saved.g) process.env.GEMINI_API_KEY = saved.g;
      if (saved.go) process.env.GOOGLE_API_KEY = saved.go;
      if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
      if (saved.o) process.env.OPENAI_API_KEY = saved.o;
    }
  });
});
