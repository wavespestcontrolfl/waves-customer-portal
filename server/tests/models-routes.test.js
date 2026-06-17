// Guards the cross-provider routing additions in server/config/models.js:
// legacy tier exports stay backward-compatible bare strings, ROUTES resolve to
// { provider, model }, and env overrides flow through. No network.

describe('models registry — cross-provider routing', () => {
  test('legacy tier exports are still bare claude- strings (81 importers untouched)', () => {
    const M = require('../config/models');
    for (const tier of ['FLAGSHIP', 'WORKHORSE', 'FAST', 'VOICE', 'VISION', 'LAWN_CHALLENGE', 'DEFAULT']) {
      expect(typeof M[tier]).toBe('string');
      expect(M[tier]).toMatch(/^claude-/);
    }
  });

  test('PROVIDER ids and ROUTES resolve to { provider, model }', () => {
    const M = require('../config/models');
    expect(M.PROVIDER).toMatchObject({ ANTHROPIC: 'anthropic', OPENAI: 'openai', GEMINI: 'gemini' });
    expect(M.ROUTES.leadClassify).toEqual({ provider: M.PROVIDER.OPENAI, model: M.OPENAI_BEST });
    expect(M.ROUTES.knowledgeAnswer).toEqual({ provider: M.PROVIDER.OPENAI, model: M.OPENAI_BEST });
  });

  test('cross-provider defaults (env or fallback)', () => {
    const M = require('../config/models');
    expect(M.OPENAI_BEST).toBe(process.env.MODEL_OPENAI_BEST || 'gpt-5.5');
    expect(M.GEMINI_VISION_BEST).toBe(process.env.MODEL_GEMINI_VISION || 'gemini-3.5-flash');
  });

  test('MODEL_OPENAI_BEST env override flows into OPENAI_BEST + ROUTES', () => {
    const saved = process.env.MODEL_OPENAI_BEST;
    jest.resetModules();
    process.env.MODEL_OPENAI_BEST = 'gpt-5.5-canary';
    try {
      const M = require('../config/models');
      expect(M.OPENAI_BEST).toBe('gpt-5.5-canary');
      expect(M.ROUTES.leadClassify.model).toBe('gpt-5.5-canary');
    } finally {
      if (saved === undefined) delete process.env.MODEL_OPENAI_BEST;
      else process.env.MODEL_OPENAI_BEST = saved;
      jest.resetModules();
    }
  });
});
