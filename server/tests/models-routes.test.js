// Guards the cross-provider routing additions in server/config/models.js:
// legacy tier exports stay backward-compatible bare strings, ROUTES resolve to
// { provider, model }, and env overrides flow through. No network.

describe('models registry — cross-provider routing', () => {
  test('legacy tier exports are still bare claude- strings (81 importers untouched)', () => {
    const M = require('../config/models');
    for (const tier of ['DEEP', 'EXTREME', 'FLAGSHIP', 'WORKHORSE', 'FAST', 'VOICE', 'VISION', 'LAWN_CHALLENGE', 'DEFAULT']) {
      expect(typeof M[tier]).toBe('string');
      expect(M[tier]).toMatch(/^claude-/);
    }
  });

  test('PROVIDER ids and ROUTES resolve to { provider, model }', () => {
    const M = require('../config/models');
    expect(M.PROVIDER).toMatchObject({ ANTHROPIC: 'anthropic', OPENAI: 'openai', GEMINI: 'gemini' });
    expect(M.ROUTES.leadClassify).toEqual({ provider: M.PROVIDER.OPENAI, model: M.OPENAI_FAST });
    expect(M.ROUTES.knowledgeAnswer).toEqual({ provider: M.PROVIDER.OPENAI, model: M.OPENAI_BALANCED });
    expect(M.ROUTES.estimateAssistant).toEqual({ provider: M.PROVIDER.OPENAI, model: M.OPENAI_BALANCED });
  });

  test('cross-provider defaults (env or fallback)', () => {
    const M = require('../config/models');
    expect(M.OPENAI_BALANCED).toBe(process.env.MODEL_OPENAI_BALANCED || process.env.MODEL_OPENAI_BEST || 'gpt-5.6-terra');
    expect(M.OPENAI_BEST).toBe(M.OPENAI_BALANCED);
    expect(M.OPENAI_FAST).toBe(process.env.MODEL_OPENAI_FAST || 'gpt-5.6-luna');
    expect(M.OPENAI_REPORT_WRITER).toBe(process.env.MODEL_OPENAI_REPORT_WRITER || 'gpt-5.6-sol');
    expect(M.GEMINI_VISION_BEST).toBe(process.env.MODEL_GEMINI_VISION || 'gemini-3.5-flash');
  });

  test('MODEL_OPENAI_BEST env override flows into OPENAI_BEST + ROUTES', () => {
    const saved = process.env.MODEL_OPENAI_BEST;
    jest.resetModules();
    process.env.MODEL_OPENAI_BEST = 'gpt-5.5-canary';
    try {
      const M = require('../config/models');
      expect(M.OPENAI_BEST).toBe('gpt-5.5-canary');
      expect(M.ROUTES.knowledgeAnswer.model).toBe('gpt-5.5-canary');
    } finally {
      if (saved === undefined) delete process.env.MODEL_OPENAI_BEST;
      else process.env.MODEL_OPENAI_BEST = saved;
      jest.resetModules();
    }
  });

  test('MODEL_OPENAI_REPORT_WRITER overrides the completed-report primary only', () => {
    const saved = process.env.MODEL_OPENAI_REPORT_WRITER;
    jest.resetModules();
    process.env.MODEL_OPENAI_REPORT_WRITER = 'gpt-report-canary';
    try {
      const M = require('../config/models');
      expect(M.OPENAI_REPORT_WRITER).toBe('gpt-report-canary');
      expect(M.TEXT_POLICIES.report.primary.model).toBe('gpt-report-canary');
      expect(M.TEXT_POLICIES.report.fallback.model).toBe(M.FLAGSHIP);
    } finally {
      if (saved === undefined) delete process.env.MODEL_OPENAI_REPORT_WRITER;
      else process.env.MODEL_OPENAI_REPORT_WRITER = saved;
      jest.resetModules();
    }
  });

  test('every generated-text policy crosses providers', () => {
    const M = require('../config/models');
    for (const policy of Object.values(M.TEXT_POLICIES)) {
      expect(policy.primary.provider).not.toBe(policy.fallback.provider);
      expect(policy.primary.model).toBeTruthy();
      expect(policy.fallback.model).toBeTruthy();
    }
    expect(M.TEXT_POLICIES.report.primary).toEqual({ provider: 'openai', model: M.OPENAI_REPORT_WRITER });
    expect(M.TEXT_POLICIES.report.fallback).toEqual({ provider: 'anthropic', model: M.FLAGSHIP });
  });
});
