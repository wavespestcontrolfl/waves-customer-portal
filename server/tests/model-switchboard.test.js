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
      expect(['live', 'restart']).toContain(lane.applies);
    }
  });

  it('counts the lanes that follow each selector and reports code defaults when no env is set', () => {
    const { selectors } = sb.getSwitchboard();
    const flagship = selectors.find((s) => s.key === 'FLAGSHIP');
    expect(flagship.laneCount).toBeGreaterThan(5);
    expect(flagship.overridden).toBe(!!process.env.MODEL_FLAGSHIP);
    expect(flagship.current).toBe(MODELS.FLAGSHIP);
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
      // A pinned lane no longer follows its selector, so it is not counted there.
      const following = lanes.filter((l) => l.primary.selector === 'FLAGSHIP' && !l.primary.pinned).length;
      expect(flagship.laneCount).toBe(following);
    } finally {
      if (prevFlagship === undefined) delete process.env.MODEL_FLAGSHIP; else process.env.MODEL_FLAGSHIP = prevFlagship;
      if (prevIb === undefined) delete process.env.INTELLIGENCE_BAR_MODEL; else process.env.INTELLIGENCE_BAR_MODEL = prevIb;
    }
  });

  it('locks the lanes a generic picker must not move', () => {
    const { lanes, selectors } = sb.getSwitchboard();
    for (const id of ['call_extraction', 'transcription', 'embeddings', 'image_gen', 'mentions_prober']) {
      expect(lanes.find((l) => l.id === id).lock).toBeTruthy();
    }
    expect(selectors.find((s) => s.key === 'OPENAI_EMBEDDING').lock.kind).toBe('migration');
    // Muse has no adapter: present in the catalog only as an unavailable option.
    expect(sb.MODEL_CATALOG['muse-spark-1.3'].status).toBe('unavailable');
  });
});
