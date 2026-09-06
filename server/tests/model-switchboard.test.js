// Model switchboard: the Models tab's lane catalog must stay attributable to
// the live registry. No DB, no network — config/models.js is plain consts.

describe('model-switchboard', () => {
  let sb;
  let MODELS;
  beforeEach(() => {
    jest.resetModules();
    MODELS = require('../config/models');
    sb = require('../services/model-switchboard');
  });

  it('every selector names a real registry export with a model id', () => {
    for (const sel of sb.SELECTORS) {
      expect(typeof MODELS[sel.key]).toBe('string');
      expect(MODELS[sel.key].length).toBeGreaterThan(0);
    }
    const keys = sb.SELECTORS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('route and policy attributions match the registry (drift guard)', () => {
    for (const [route, selKey] of Object.entries(sb.ROUTE_SELECTOR)) {
      expect(MODELS.ROUTES[route]).toBeDefined();
      expect(MODELS.ROUTES[route].model).toBe(MODELS[selKey]);
    }
    for (const [policy, legs] of Object.entries(sb.POLICY_SELECTOR)) {
      expect(MODELS.TEXT_POLICIES[policy]).toBeDefined();
      expect(MODELS.TEXT_POLICIES[policy].primary.model).toBe(MODELS[legs.primary]);
      expect(MODELS.TEXT_POLICIES[policy].fallback.model).toBe(MODELS[legs.fallback]);
    }
    // Every route / policy the registry ships is attributed here.
    expect(Object.keys(sb.ROUTE_SELECTOR).sort()).toEqual(Object.keys(MODELS.ROUTES).sort());
    expect(Object.keys(sb.POLICY_SELECTOR).sort()).toEqual(Object.keys(MODELS.TEXT_POLICIES).sort());
  });

  it('every lane resolves to a model with a known provider and a listed policy', () => {
    const { lanes, policies, models } = sb.getSwitchboard();
    const policyKeys = new Set(policies.map((p) => p.key));
    const ids = lanes.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lane of lanes) {
      expect(policyKeys.has(lane.policy)).toBe(true);
      expect(typeof lane.primary.model).toBe('string');
      expect(lane.primary.provider).not.toBe('unknown');
      expect(models[lane.primary.model]).toBeDefined();
      if (lane.fallback) {
        expect(typeof lane.fallback.model).toBe('string');
        expect(models[lane.fallback.model]).toBeDefined();
      }
      expect(['live', 'restart', 'registration']).toContain(lane.applies);
    }
  });

  it('counts the lanes that follow each selector and reports code defaults when no env is set', () => {
    const { selectors } = sb.getSwitchboard();
    const flagship = selectors.find((s) => s.key === 'FLAGSHIP');
    expect(flagship.laneCount).toBeGreaterThan(5);
    expect(flagship.overridden).toBe(!!process.env.MODEL_FLAGSHIP);
    expect(flagship.current).toBe(MODELS.FLAGSHIP);
    // Every non-derived selector reports the default it returns to when its
    // override is deleted, and that default is the registry's own.
    for (const sel of selectors) {
      if (sel.derivesFrom) expect(sel.codeDefault).toBeNull();
      else expect(sel.codeDefault).toBe(MODELS.DEFAULTS[sel.key]);
    }
    expect(MODELS.DEFAULTS.FLAGSHIP).toMatch(/^claude-/);
  });

  it('an override set through a legacy alias is deleted by its own name, and the next alias takes over', () => {
    const prev = { MODEL_OPENAI_BALANCED: process.env.MODEL_OPENAI_BALANCED, MODEL_OPENAI_BEST: process.env.MODEL_OPENAI_BEST, OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL, OPENAI_MODEL: process.env.OPENAI_MODEL };
    try {
      delete process.env.MODEL_OPENAI_BALANCED;
      process.env.MODEL_OPENAI_BEST = 'gpt-9.9-alias';
      process.env.OPENAI_VISION_MODEL = 'gpt-9.9-vision';
      process.env.OPENAI_MODEL = 'gpt-9.9-generic';
      jest.resetModules();
      const { selectors, lanes } = require('../services/model-switchboard').getSwitchboard();
      const balanced = selectors.find((s) => s.key === 'OPENAI_BALANCED');
      expect(balanced.overridden).toBe(true);
      expect(balanced.overrideEnv).toBe('MODEL_OPENAI_BEST');
      expect(balanced.current).toBe('gpt-9.9-alias');
      expect(balanced.unpinnedModel).toBe(require('../config/models').DEFAULTS.OPENAI_BALANCED);
      // Both aliases set: deleting the active one lands on the next, not the code default.
      const sat = lanes.find((l) => l.id === 'satellite').also[0];
      expect(sat.pinEnv).toBe('OPENAI_VISION_MODEL');
      expect(sat.setEnv).toBe('OPENAI_VISION_MODEL');
      expect(sat.unpinnedModel).toBe('gpt-9.9-generic');
      delete process.env.OPENAI_VISION_MODEL;
      jest.resetModules();
      const sat2 = require('../services/model-switchboard').getSwitchboard().lanes.find((l) => l.id === 'satellite').also[0];
      expect(sat2.pinned).toBe(true);
      expect(sat2.setEnv).toBe('OPENAI_MODEL');
      expect(sat2.unpinnedModel).toBe('gpt-5-mini');
    } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('managed agents are registration-locked: not counted in a selector blast radius, applies at re-registration', () => {
    const { selectors, lanes } = sb.getSwitchboard();
    const agents = lanes.filter((l) => l.policy === 'agents');
    expect(agents.length).toBeGreaterThan(0);
    for (const lane of agents) {
      expect(lane.lock.kind).toBe('registration');
      expect(lane.applies).toBe('registration');
    }
    const flagship = selectors.find((s) => s.key === 'FLAGSHIP');
    const following = lanes.filter((l) => l.primary.selector === 'FLAGSHIP' && !l.primary.pinned && l.lock?.kind !== 'registration').length;
    expect(flagship.laneCount).toBe(following);
  });

  it('turf OCR is a two-model consensus (fan-out), and the SMS canary probes are lanes of their own', () => {
    const { lanes } = sb.getSwitchboard();
    const turf = lanes.find((l) => l.id === 'turf_ocr');
    expect(turf.fanout).toBe(true);
    expect(turf.fallback).toBeNull();
    expect(turf.also.map((a) => a.model)).toEqual([MODELS.VISION]);
    const canary = lanes.find((l) => l.id === 'sms_canary_default');
    expect(canary.primary.model).toBe(MODELS.ROUTES.smsDraftDefault.model);
    expect(canary.fallback).toBeNull();
    expect(lanes.find((l) => l.id === 'sms_canary_save_sale').primary.model).toBe(MODELS.ROUTES.smsDraftSaveSale.model);
    // lead triage maps the JSON without validating it → nothing catches a regression.
    expect(lanes.find((l) => l.id === 'lead_triage').continuity).toBe('unchecked');
    // The fact-check gate passes `{}` (missing findings = none), so nothing deterministic catches a regression.
    expect(lanes.find((l) => l.id === 'fact_check_gate').continuity).toBe('unchecked');
    // turf-height-ocr.js reconciles the consensus against the tech's manual reading and parks divergences as `discrepancy`.
    expect(turf.continuity).toBe('verified');
    // The gauge photo is technician-uploaded content → per-lane approval, never bulk-eligible.
    expect(turf.inbound).toBe(true);
  });

  it('reflects an env override as the running model and as a pin', () => {
    jest.resetModules();
    const prevFlagship = process.env.MODEL_FLAGSHIP;
    const prevIb = process.env.INTELLIGENCE_BAR_MODEL;
    process.env.MODEL_FLAGSHIP = 'claude-opus-5';
    process.env.INTELLIGENCE_BAR_MODEL = 'claude-sonnet-5';
    try {
      const fresh = require('../services/model-switchboard');
      const { selectors, lanes } = fresh.getSwitchboard();
      const flagship = selectors.find((s) => s.key === 'FLAGSHIP');
      expect(flagship.current).toBe('claude-opus-5');
      expect(flagship.overridden).toBe(true);
      expect(flagship.overrideEnv).toBe('MODEL_FLAGSHIP');
      const ib = lanes.find((l) => l.id === 'ib_admin');
      expect(ib.primary.model).toBe('claude-sonnet-5');
      expect(ib.primary.pinned).toBe(true);
      expect(ib.primary.pinEnv).toBe('INTELLIGENCE_BAR_MODEL');
      // Deleting the pin returns the lane to its selector (which is overridden here).
      expect(ib.primary.unpinnedModel).toBe('claude-opus-5');
      // A pinned lane no longer follows its selector, so it is not counted
      // there; nor does a registration-locked managed agent.
      const following = lanes.filter((l) => l.primary.selector === 'FLAGSHIP' && !l.primary.pinned && l.lock?.kind !== 'registration').length;
      expect(flagship.laneCount).toBe(following);
    } finally {
      if (prevFlagship === undefined) delete process.env.MODEL_FLAGSHIP; else process.env.MODEL_FLAGSHIP = prevFlagship;
      if (prevIb === undefined) delete process.env.INTELLIGENCE_BAR_MODEL; else process.env.INTELLIGENCE_BAR_MODEL = prevIb;
    }
  });

  it('models the registry alias: OPENAI_SMS_DRAFT follows OPENAI_FAST until set', () => {
    const { selectors } = sb.getSwitchboard();
    const smsDraft = selectors.find((s) => s.key === 'OPENAI_SMS_DRAFT');
    expect(smsDraft.derivesFrom).toBe('OPENAI_FAST');
    expect(smsDraft.derived).toBe(!process.env.MODEL_OPENAI_SMS_DRAFT);
    expect(MODELS.OPENAI_SMS_DRAFT).toBe(process.env.MODEL_OPENAI_SMS_DRAFT || MODELS.OPENAI_FAST);
  });

  it('call extraction follows CALL_EXTRACTION_PROVIDER like the processor does (fallback flips)', () => {
    const prev = process.env.CALL_EXTRACTION_PROVIDER;
    try {
      delete process.env.CALL_EXTRACTION_PROVIDER;
      jest.resetModules();
      let lane = require('../services/model-switchboard').getSwitchboard().lanes.find((l) => l.id === 'call_extraction');
      expect(lane.primary.provider).toBe('openai');
      expect(lane.fallback.model).toBe(MODELS.CALL_EXTRACTION_ANTHROPIC);

      process.env.CALL_EXTRACTION_PROVIDER = 'anthropic';
      jest.resetModules();
      lane = require('../services/model-switchboard').getSwitchboard().lanes.find((l) => l.id === 'call_extraction');
      expect(lane.primary.model).toBe(MODELS.CALL_EXTRACTION_ANTHROPIC);
      expect(lane.fallback.provider).toBe('openai');

      process.env.CALL_EXTRACTION_PROVIDER = 'gemini';
      jest.resetModules();
      lane = require('../services/model-switchboard').getSwitchboard().lanes.find((l) => l.id === 'call_extraction');
      expect(lane.primary.provider).toBe('gemini');
      expect(lane.fallback.model).toBe(MODELS.CALL_EXTRACTION_ANTHROPIC);
    } finally {
      if (prev === undefined) delete process.env.CALL_EXTRACTION_PROVIDER; else process.env.CALL_EXTRACTION_PROVIDER = prev;
    }
  });

  it('photo lanes carry the shared Gemini retry leg and the fan-outs their OpenAI arm', () => {
    const { lanes } = sb.getSwitchboard();
    const pest = lanes.find((l) => l.id === 'pest_id');
    expect(pest.retry.model).toBe(MODELS.GEMINI_VISION_FALLBACK);
    expect(pest.retry.selector).toBe('GEMINI_VISION_FALLBACK');
    const sat = lanes.find((l) => l.id === 'satellite');
    expect(sat.also.map((a) => a.pinEnv)).toEqual(['OPENAI_VISION_MODEL']);
    expect(sat.also[0].provider).toBe('openai');
    expect(lanes.find((l) => l.id === 'property_trio').also[0].pinEnv).toBe('OPENAI_PROPERTY_MODEL');
    // The caption read and the treatment-zone map are sequential ladders in
    // execution order (Gemini → prior Gemini → Claude), not fan-outs.
    for (const id of ['tech_caption_vision', 'treatment_zone']) {
      const ladder = lanes.find((l) => l.id === id);
      expect({ id, fanout: ladder.fanout, primary: ladder.primary.provider, fallback: ladder.fallback.selector, retry: ladder.retry.selector })
        .toEqual({ id, fanout: false, primary: 'gemini', fallback: 'GEMINI_VISION_FALLBACK', retry: 'VISION' });
    }
  });

  it('an uncatalogued Fable id configured through env keeps the deep-only restriction', () => {
    const prev = process.env.MODEL_DEEP;
    process.env.MODEL_DEEP = 'claude-fable-9-9';
    try {
      jest.resetModules();
      const { models } = require('../services/model-switchboard').getSwitchboard();
      expect(models['claude-fable-9-9'].requires).toBe('deep');
      expect(models['claude-fable-9-9'].provider).toBe('anthropic');
    } finally {
      if (prev === undefined) delete process.env.MODEL_DEEP; else process.env.MODEL_DEEP = prev;
    }
  });

  it('research miner: CALL_RESEARCH_MODEL moves the primary only, never the fallback', () => {
    const prevM = process.env.CALL_RESEARCH_MODEL;
    const prevP = process.env.CALL_RESEARCH_PROVIDER;
    try {
      process.env.CALL_RESEARCH_MODEL = 'gpt-9.9-test';
      delete process.env.CALL_RESEARCH_PROVIDER;
      jest.resetModules();
      const lane = require('../services/model-switchboard').getSwitchboard().lanes.find((l) => l.id === 'call_research');
      expect(lane.primary.model).toBe('gpt-9.9-test');
      expect(lane.fallback.model).toBe(MODELS.CALL_RESEARCH_ANTHROPIC);
      process.env.CALL_RESEARCH_PROVIDER = 'anthropic';
      jest.resetModules();
      const lane2 = require('../services/model-switchboard').getSwitchboard().lanes.find((l) => l.id === 'call_research');
      expect(lane2.primary.model).toBe('gpt-9.9-test'); // override applies to whichever primary
      expect(lane2.fallback.model).toBe('gpt-5.6-sol'); // DEFAULT_MODEL_FOR.openai, untouched by the override
    } finally {
      if (prevM === undefined) delete process.env.CALL_RESEARCH_MODEL; else process.env.CALL_RESEARCH_MODEL = prevM;
      if (prevP === undefined) delete process.env.CALL_RESEARCH_PROVIDER; else process.env.CALL_RESEARCH_PROVIDER = prevP;
    }
  });

  it('the image lane resolves BLOG_IMAGE_PROVIDER as a chain: first valid slug, literal when none is valid', () => {
    const prev = process.env.BLOG_IMAGE_PROVIDER;
    try {
      process.env.BLOG_IMAGE_PROVIDER = 'gemini-image-best, gpt-image-2';
      jest.resetModules();
      let lane = require('../services/model-switchboard').getSwitchboard().lanes.find((l) => l.id === 'image_gen');
      expect(lane.primary.model).toBe(MODELS.GEMINI_IMAGE_BEST);
      expect(lane.primary.provider).toBe('gemini');
      expect(lane.primary.setEnv).toBe('BLOG_IMAGE_PROVIDER');

      process.env.BLOG_IMAGE_PROVIDER = 'not-a-provider';
      jest.resetModules();
      lane = require('../services/model-switchboard').getSwitchboard().lanes.find((l) => l.id === 'image_gen');
      expect(lane.primary.model).toBe('gpt-image-2');
    } finally {
      if (prev === undefined) delete process.env.BLOG_IMAGE_PROVIDER; else process.env.BLOG_IMAGE_PROVIDER = prev;
    }
  });

  it('the image lane exposes the Nano Banana Pro selector and reports it as the chain\'s second leg (Codex r1 P2 on #3964)', () => {
    expect(sb.SELECTORS.find((s) => s.key === 'GEMINI_IMAGE_PRO')).toMatchObject({ env: 'MODEL_GEMINI_IMAGE_PRO', accepts: { providers: ['gemini'], cap: 'image' } });
    const lane = sb.getSwitchboard().lanes.find((l) => l.id === 'image_gen');
    expect(lane.fallback.model).toBe(MODELS.GEMINI_IMAGE_PRO);
    expect(lane.note).toMatch(/gpt-image-2 → GEMINI_IMAGE_PRO → gpt-image-1\.5/);
  });

  it('locks the lanes a generic picker must not move', () => {
    const { lanes, selectors } = sb.getSwitchboard();
    for (const id of ['call_extraction', 'transcription', 'embeddings', 'image_gen', 'mentions_prober']) {
      expect(lanes.find((l) => l.id === id).lock).toBeTruthy();
    }
    expect(selectors.find((s) => s.key === 'OPENAI_EMBEDDING').lock.kind).toBe('migration');
    // A selector referenced only by locked lanes is locked too, so the
    // selector picker can't move what the lane lock says is frozen.
    const lockedLaneSelectors = new Set(
      lanes.filter((l) => l.lock).flatMap((l) => [l.primary.selector, l.fallback?.selector]).filter(Boolean),
    );
    for (const key of lockedLaneSelectors) {
      const onlyLocked = lanes.filter((l) => l.primary.selector === key || l.fallback?.selector === key).every((l) => l.lock);
      if (onlyLocked) expect(selectors.find((s) => s.key === key).lock).toBeTruthy();
    }
    // Muse has no adapter: present in the catalog only as an unavailable option.
    expect(sb.MODEL_CATALOG['muse-spark-1.3'].status).toBe('unavailable');
  });

  it('only DEEP-path selectors may take Fable, and inbound-content lanes are flagged', () => {
    const { selectors, lanes } = sb.getSwitchboard();
    // FLAGSHIP feeds image payloads (satellite, property lookup v2): the
    // picker must require vision, so a text-only find cannot be drafted.
    expect(selectors.find((s) => s.key === 'FLAGSHIP').accepts.cap).toBe('vision');
    // OPENAI_BALANCED is the OpenAI leg of ROUTES.visionAnalysis (vision-delta, admin dispatch send images).
    expect(selectors.find((s) => s.key === 'OPENAI_BALANCED').accepts.cap).toBe('vision');
    // response-drafter.js picks customerCopy for routine intents and highStakes for cancel / complaint / severity — two lanes, two backups.
    expect(lanes.find((l) => l.id === 'response_drafter').fallback.model).toBe(MODELS.TEXT_POLICIES.customerCopy.fallback.model);
    expect(lanes.find((l) => l.id === 'response_drafter_high_stakes').fallback.model).toBe(MODELS.TEXT_POLICIES.highStakes.fallback.model);
    const deepSafe = selectors.filter((s) => s.accepts.deep).map((s) => s.key).sort();
    expect(deepSafe).toEqual(['DEEP', 'EXTREME']);
    for (const id of Object.keys(sb.MODEL_CATALOG).filter((k) => /fable|mythos/.test(k))) {
      expect(sb.MODEL_CATALOG[id].requires).toBe('deep');
    }
    // A pin on a DEEP lane inherits the deep-safe accepts; a FLAGSHIP pin does not.
    expect(lanes.find((l) => l.id === 'fact_check_gate').primary.accepts.deep).toBe(true);
    expect(lanes.find((l) => l.id === 'ib_admin').primary.accepts.deep).toBeUndefined();
    // intent_composer: the prompt carries the transcript, SMS thread and
    // customer profile, so a pinned ESTIMATOR_ENGINE_MODEL needs per-lane review.
    for (const id of ['sms_draft', 'call_extraction', 'pest_id', 'ask_waves', 'intent_composer']) {
      expect(lanes.find((l) => l.id === id).inbound).toBe(true);
    }
    expect(lanes.find((l) => l.id === 'tax_advisor').inbound).toBe(false);
  });
});
