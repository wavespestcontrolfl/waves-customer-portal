// GATE_LAWN_V13: a stored estimate replayed as sold keeps its bahia lawn price, but a lawn line the
// customer add-service rail ADDS in the same recompute was never sold and is parked for review. A
// browser-posted replay marker is never honored.
const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
const { generateEstimate } = require('../services/pricing-engine');
const { addedLineReviewOnly } = require('../routes/estimate-public');

const BASE = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, estimatedTurfSf: 4500 };
const bahia = { track: 'bahia', tier: 'enhanced' };
const lawnLine = (estimate) => estimate.lineItems.find((l) => l.service === 'lawn_care');

afterEach(() => { delete process.env.GATE_LAWN_V13; });

describe('engine, GATE_LAWN_V13 on', () => {
  beforeEach(() => { process.env.GATE_LAWN_V13 = 'true'; });
  const replay = (extra = {}) => generateEstimate({ ...BASE, services: { lawn: bahia }, savedEstimateReplay: true, ...extra });

  test('an already-sent bahia lawn replayed as sold is honored', () => {
    const result = replay();
    expect(lawnLine(result).requiresManualReview).toBe(false);
    expect(addedLineReviewOnly(result, 'lawn_care')).toBe(false);
  });

  test('the same replay with the lawn line ADDED by the mutation is reviewed, and the add rail sees it', () => {
    const result = replay({ addedServiceKeys: ['lawn_care'] });
    expect(lawnLine(result).manualReviewReasons).toContain('lawn_v13_bahia_no_program');
    expect(lawnLine(result).requiresCustomQuote).toBe(true);
    expect(addedLineReviewOnly(result, 'lawn_care')).toBe(true);
  });

  test('adding some other service leaves a sold bahia lawn honored', () => {
    const result = replay({ addedServiceKeys: ['mosquito'] });
    expect(lawnLine(result).requiresManualReview).toBe(false);
  });
});

describe('serverRecomputeFromEstimateData', () => {
  const deps = (extra = {}) => ({
    generateEstimate: jest.fn(() => ({ lineItems: [], summary: {}, warnings: [] })),
    needsSync: () => false,
    syncConstantsFromDB: jest.fn(),
    mapV1ToLegacyShape: jest.fn((r) => r),
    translateV2CallToV1Input: null,
    ...extra,
  });
  const stored = (extra = {}) => ({ engineInputs: { ...BASE, services: { lawn: bahia }, ...extra } });
  const seen = (d) => d.generateEstimate.mock.calls[0][0];

  test('a declared replay marks the input as sold and carries the added service keys', async () => {
    const plain = deps();
    await serverRecomputeFromEstimateData(stored(), { ...plain, replaySavedPricingKnobs: true });
    expect(seen(plain)).toMatchObject({ savedEstimateReplay: true, addedServiceKeys: [] });
    const add = deps();
    await serverRecomputeFromEstimateData(stored(), { ...add, replaySavedPricingKnobs: true, addedServiceKeys: ['lawn_care'] });
    expect(seen(add)).toMatchObject({ savedEstimateReplay: true, addedServiceKeys: ['lawn_care'] });
  });

  test('a browser save never carries either marker into the engine', async () => {
    const d = deps();
    const payload = stored({ savedEstimateReplay: true, addedServiceKeys: [] });
    await serverRecomputeFromEstimateData(payload, d);
    expect(seen(d)).not.toHaveProperty('savedEstimateReplay');
    expect(seen(d)).not.toHaveProperty('addedServiceKeys');
    // ...and the posted payload itself is untouched.
    expect(payload.engineInputs.savedEstimateReplay).toBe(true);
  });

  test('a real browser save of a new bahia lawn is reviewed even when it claims to be a replay', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    const out = await serverRecomputeFromEstimateData(stored({ savedEstimateReplay: true }), {
      needsSync: () => false, syncConstantsFromDB: jest.fn(), translateV2CallToV1Input: null,
    });
    expect(out.recomputed).toBe(true);
    expect(lawnLine(out.rawEngineResult).manualReviewReasons).toContain('lawn_v13_bahia_no_program');
  });
});
