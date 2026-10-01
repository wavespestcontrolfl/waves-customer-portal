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
    expect(M.GEMINI_VISION_BEST).toBe(process.env.MODEL_GEMINI_VISION || 'gemini-3.8-flash');
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

  test('photoCaptions runs Gemini first, Claude only as the fallback (owner 2026-09-24)', () => {
    const M = require('../config/models');
    expect(M.TEXT_POLICIES.photoCaptions.primary).toEqual({ provider: 'gemini', model: M.GEMINI_VISION_BEST });
    expect(M.TEXT_POLICIES.photoCaptions.fallback).toEqual({ provider: 'anthropic', model: M.VISION });
    // visionAnalysis (vision-delta, and every other photo lane) is untouched.
    expect(M.TEXT_POLICIES.visionAnalysis.primary).toEqual({ provider: 'anthropic', model: M.VISION });
  });

  test('photoIdVision runs Gemini first and ChatGPT\'s best vision model second, no Claude (owner 2026-09-26)', () => {
    const M = require('../config/models');
    expect(M.TEXT_POLICIES.photoIdVision.primary).toEqual({ provider: 'gemini', model: M.GEMINI_VISION_BEST });
    expect(M.TEXT_POLICIES.photoIdVision.fallback).toEqual({ provider: 'openai', model: M.OPENAI_FRONTIER });
  });

  test('plantIdVision runs Gemini first and GPT-6 Sol second, no Claude (owner 2026-09-28) — the pest engine keeps photoIdVision unchanged', () => {
    const M = require('../config/models');
    expect(M.TEXT_POLICIES.plantIdVision.primary).toEqual({ provider: 'gemini', model: M.GEMINI_VISION_BEST });
    expect(M.TEXT_POLICIES.plantIdVision.fallback).toEqual({ provider: 'openai', model: M.OPENAI_PLANT_ID });
    expect(M.OPENAI_PLANT_ID).not.toBe(M.OPENAI_FRONTIER);
    // The pest engine's own ladder is untouched by the 2026-09-28 ruling.
    expect(M.TEXT_POLICIES.photoIdVision.fallback).toEqual({ provider: 'openai', model: M.OPENAI_FRONTIER });
  });

  test('lawnVisitAssessment runs Gemini first and GPT-6 Sol second on its own selector (owner 2026-09-29, was Astra)', () => {
    const M = require('../config/models');
    expect(M.TEXT_POLICIES.lawnVisitAssessment.primary).toEqual({ provider: 'gemini', model: M.GEMINI_VISION_BEST });
    expect(M.TEXT_POLICIES.lawnVisitAssessment.fallback).toEqual({ provider: 'openai', model: M.OPENAI_LAWN_ASSESSMENT });
    expect(M.OPENAI_LAWN_ASSESSMENT).toBe(process.env.MODEL_OPENAI_LAWN_ASSESSMENT || 'gpt-6-sol');
    // The pest identifier's Astra second look is untouched.
    expect(M.TEXT_POLICIES.photoIdVision.fallback).toEqual({ provider: 'openai', model: M.OPENAI_FRONTIER });
  });

  test('MODEL_OPENAI_LAWN_ASSESSMENT overrides only the lawn backup leg', () => {
    const saved = process.env.MODEL_OPENAI_LAWN_ASSESSMENT;
    jest.resetModules();
    process.env.MODEL_OPENAI_LAWN_ASSESSMENT = 'gpt-lawn-canary';
    try {
      const M = require('../config/models');
      expect(M.TEXT_POLICIES.lawnVisitAssessment.fallback.model).toBe('gpt-lawn-canary');
      expect(M.TEXT_POLICIES.photoIdVision.fallback.model).toBe(M.OPENAI_FRONTIER);
      expect(M.TEXT_POLICIES.plantIdVision.fallback.model).toBe(M.OPENAI_PLANT_ID);
    } finally {
      if (saved === undefined) delete process.env.MODEL_OPENAI_LAWN_ASSESSMENT; else process.env.MODEL_OPENAI_LAWN_ASSESSMENT = saved;
      jest.resetModules();
    }
  });

  test('plantIdReferee is a single-leg Anthropic route on Claude Fable at effort high (owner 2026-09-28), outside the two-provider TEXT_POLICIES map', () => {
    const M = require('../config/models');
    expect(M.ROUTES.plantIdReferee).toEqual({ provider: 'anthropic', model: M.PLANT_ID_REFEREE, effort: 'high' });
    expect(M.PLANT_ID_REFEREE).toBe(process.env.MODEL_PLANT_ID_REFEREE || 'claude-fable-5-1');
    expect(M.MODEL_CATALOG[M.PLANT_ID_REFEREE].requires).toBe('deep');
  });

  test('adsAdvisor policy is Fable 5.1 at effort high with the OpenAI report writer behind it (owner 2026-10-01); MODEL_ADS_ADVISOR moves only its Anthropic leg', () => {
    const M = require('../config/models');
    expect(M.TEXT_POLICIES.adsAdvisor.primary).toEqual({ provider: 'anthropic', model: M.ADS_ADVISOR, effort: 'high' });
    expect(M.TEXT_POLICIES.adsAdvisor.fallback).toEqual({ provider: 'openai', model: M.OPENAI_REPORT_WRITER });
    expect(M.ADS_ADVISOR).toBe(process.env.MODEL_ADS_ADVISOR || 'claude-fable-5-1');
    expect(M.MODEL_CATALOG[M.ADS_ADVISOR].requires).toBe('deep');
    const saved = process.env.MODEL_ADS_ADVISOR;
    jest.resetModules();
    process.env.MODEL_ADS_ADVISOR = 'claude-fable-canary';
    try {
      const N = require('../config/models');
      expect(N.TEXT_POLICIES.adsAdvisor.primary.model).toBe('claude-fable-canary');
      expect(N.TEXT_POLICIES.highStakes.primary.model).toBe(N.FLAGSHIP);
    } finally {
      if (saved === undefined) delete process.env.MODEL_ADS_ADVISOR; else process.env.MODEL_ADS_ADVISOR = saved;
      jest.resetModules();
    }
  });

  test('lawnAssessmentReferee is a single-leg Anthropic route on Claude Fable at effort high (owner 2026-09-29), outside TEXT_POLICIES', () => {
    const M = require('../config/models');
    expect(M.ROUTES.lawnAssessmentReferee).toEqual({ provider: 'anthropic', model: M.LAWN_ASSESSMENT_REFEREE, effort: 'high' });
    expect(M.LAWN_ASSESSMENT_REFEREE).toBe(process.env.MODEL_LAWN_ASSESSMENT_REFEREE || 'claude-fable-5-1');
    expect(M.MODEL_CATALOG[M.LAWN_ASSESSMENT_REFEREE].requires).toBe('deep');
  });

  test('MODEL_LAWN_ASSESSMENT_REFEREE overrides only the lawn referee route', () => {
    const saved = process.env.MODEL_LAWN_ASSESSMENT_REFEREE;
    jest.resetModules();
    process.env.MODEL_LAWN_ASSESSMENT_REFEREE = 'claude-fable-canary';
    try {
      const M = require('../config/models');
      expect(M.ROUTES.lawnAssessmentReferee.model).toBe('claude-fable-canary');
      expect(M.ROUTES.plantIdReferee.model).toBe(M.PLANT_ID_REFEREE);
    } finally {
      if (saved === undefined) delete process.env.MODEL_LAWN_ASSESSMENT_REFEREE; else process.env.MODEL_LAWN_ASSESSMENT_REFEREE = saved;
      jest.resetModules();
    }
  });

  test('MODEL_OPENAI_PLANT_ID and MODEL_PLANT_ID_REFEREE env overrides flow into the registry', () => {
    const savedOpenai = process.env.MODEL_OPENAI_PLANT_ID;
    const savedReferee = process.env.MODEL_PLANT_ID_REFEREE;
    jest.resetModules();
    process.env.MODEL_OPENAI_PLANT_ID = 'gpt-plant-canary';
    process.env.MODEL_PLANT_ID_REFEREE = 'claude-fable-canary';
    try {
      const M = require('../config/models');
      expect(M.OPENAI_PLANT_ID).toBe('gpt-plant-canary');
      expect(M.TEXT_POLICIES.plantIdVision.fallback.model).toBe('gpt-plant-canary');
      expect(M.PLANT_ID_REFEREE).toBe('claude-fable-canary');
      expect(M.ROUTES.plantIdReferee.model).toBe('claude-fable-canary');
    } finally {
      if (savedOpenai === undefined) delete process.env.MODEL_OPENAI_PLANT_ID; else process.env.MODEL_OPENAI_PLANT_ID = savedOpenai;
      if (savedReferee === undefined) delete process.env.MODEL_PLANT_ID_REFEREE; else process.env.MODEL_PLANT_ID_REFEREE = savedReferee;
      jest.resetModules();
    }
  });

  test('photoCaptions honors the shared GEMINI_VISION_MODEL override like the other photo lanes', () => {
    const prev = process.env.GEMINI_VISION_MODEL;
    process.env.GEMINI_VISION_MODEL = 'gemini-pinned-rollback';
    try {
      jest.isolateModules(() => {
        const M = require('../config/models');
        expect(M.TEXT_POLICIES.photoCaptions.primary).toEqual({ provider: 'gemini', model: 'gemini-pinned-rollback' });
      });
    } finally {
      if (prev === undefined) delete process.env.GEMINI_VISION_MODEL;
      else process.env.GEMINI_VISION_MODEL = prev;
    }
  });
});
