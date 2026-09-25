jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getVerifiedOverrides: jest.fn(async () => null),
  getCachedLookup: jest.fn(async () => null),
  applyVerifiedOverrides: jest.fn((record) => record),
}));
jest.mock('../services/property-lookup/fema-nfhl', () => ({ lookupFloodZoneByPoint: jest.fn(async () => null) }));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  ...jest.requireActual('../services/property-lookup/ai-property-lookup'),
  lookupPropertyFromAITrio: jest.fn(async () => ({
    squareFootage: 2400, lotSize: 10000, propertyType: 'Single Family',
    stories: 1, _source: 'county', _storiesSource: 'county',
  })),
  lookupStoriesEvidenceFromAI: jest.fn(async () => null),
}));

const { performPropertyLookup } = require('../routes/property-lookup-v2');
const MODELS = require('../config/models');
const ADDRESS = '200 Example Way, Bradenton, FL 34203';
const ANALYSIS = {
  propertyUse: 'RESIDENTIAL', structureAttachment: 'DETACHED', sharedWallCount: 0,
  pool: 'NO', poolCage: 'NO', poolCageSize: 'NONE', largeDriveway: 'NO',
  shrubDensity: 'LIGHT', treeDensity: 'LIGHT', landscapeComplexity: 'SIMPLE',
  estimatedTurfSf: 4000, estimatedBedAreaSf: 300, estimatedPalmCount: 2,
  estimatedTreeCount: 1, outbuildingCount: 0, confidenceScore: 85,
  imperviousSurfacePercent: 30, shadeCoveragePercent: 10, nearWater: 'NONE',
  overallPestPressureEstimate: 'LOW', analysisNotes: 'Clear satellite view.',
};
const KEYS = ['GOOGLE_MAPS_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
const savedEnv = {};
const savedFetch = global.fetch;
let modelCalls;

beforeEach(() => {
  for (const key of KEYS) {
    savedEnv[key] = process.env[key];
    process.env[key] = `test-${key}`;
  }
  modelCalls = [];
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = savedFetch;
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function mockNetwork({ gemini = ANALYSIS, openai = ANALYSIS, onGemini } = {}) {
  global.fetch = jest.fn(async (url, options) => {
    const target = String(url);
    if (target.includes('/geocode/')) return {
      ok: true,
      json: async () => ({ status: 'OK', results: [{ formatted_address: ADDRESS, geometry: { location: { lat: 27.4, lng: -82.4 }, location_type: 'ROOFTOP' } }] }),
    };
    if (target.includes('staticmap')) return { ok: true, arrayBuffer: async () => Buffer.from('test-image') };
    const body = JSON.parse(options.body);
    modelCalls.push({ target, body });
    if (target.includes('generativelanguage.googleapis.com')) {
      if (onGemini) onGemini();
      if (gemini === null) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini) }] }, finishReason: 'STOP' }] }) };
    }
    if (target.includes('api.openai.com')) {
      if (openai === null) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ status: 'completed', output_text: JSON.stringify(openai) }) };
    }
    throw new Error('Unexpected provider');
  });
}

function lookup(options = {}) {
  return performPropertyLookup(ADDRESS, { persist: false, prioritizeAccuracy: true, ...options });
}

test('Gemini success uses one model and preserves single-source measurement provenance', async () => {
  mockNetwork();
  const result = await lookup();
  expect(modelCalls).toHaveLength(1);
  expect(modelCalls[0].target).toContain('/gemini-3.8-flash:generateContent');
  expect(modelCalls[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  expect(result.aiAnalysis._sources).toEqual(['gemini']);
  expect(result.aiAnalysis.estimatedTurfSf).toBe(4000);
  expect(result.aiAnalysis._structureAttachmentSupport).toBe(1);
  expect(result.meta.providerStatus.satelliteVision).toEqual({ gemini: { configured: true, available: true } });
});

test.each([
  ['HTTP error', null],
  ['empty object', {}],
  ['out-of-range confidence', { ...ANALYSIS, confidenceScore: 101 }],
  ['missing measurement', { ...ANALYSIS, estimatedTurfSf: undefined }],
  ['invalid pricing feature', { ...ANALYSIS, pool: 'MAYBE' }],
])('Gemini %s calls Sol once, with no third provider', async (_label, gemini) => {
  mockNetwork({ gemini, openai: { ...ANALYSIS, estimatedTurfSf: 4500 } });
  const result = await lookup();
  expect(modelCalls).toHaveLength(2);
  expect(modelCalls[0].target).toContain('generativelanguage.googleapis.com');
  expect(modelCalls[1].target).toBe('https://api.openai.com/v1/responses');
  expect(modelCalls[1].body.model).toBe('gpt-6-sol');
  expect(modelCalls[1].body.model).toBe(MODELS.OPENAI_ESTIMATE_VISION);
  expect(modelCalls[1].body.input[0].content.filter((part) => part.type === 'input_image')).toHaveLength(5);
  expect(result.aiAnalysis._sources).toEqual(['openai']);
  expect(result.aiAnalysis.estimatedTurfSf).toBe(4500);
  expect(result.meta.providerStatus.satelliteVision).toEqual({
    gemini: { configured: true, available: false },
    openai: { configured: true, available: true },
  });
});

test('a Gemini timeout leaves time for the Sol fallback within the lookup deadline', async () => {
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const signals = jest.spyOn(AbortSignal, 'timeout');
  mockNetwork({ onGemini: () => {
    now += 25000;
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  } });
  const result = await lookup({ prioritizeAccuracy: false });
  expect(modelCalls).toHaveLength(2);
  expect(result.aiAnalysis._sources).toEqual(['openai']);
  expect(signals.mock.calls.slice(-2).map(([ms]) => ms)).toEqual([25000, 25000]);
  expect(result.meta.lookupMs).toBeLessThan(result.meta.budgetMs);
});

test('missing Gemini credentials go straight to Sol', async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  mockNetwork();
  const result = await lookup();
  expect(modelCalls).toHaveLength(1);
  expect(modelCalls[0].body.model).toBe('gpt-6-sol');
  expect(result.aiAnalysis._sources).toEqual(['openai']);
});

test('both models failing leaves no image analysis and never attempts Claude', async () => {
  mockNetwork({ gemini: {}, openai: {} });
  const result = await lookup();
  expect(modelCalls).toHaveLength(2);
  expect(modelCalls.every(({ target }) => !target.includes('anthropic'))).toBe(true);
  expect(result.aiAnalysis).toBeNull();
  expect(result.errors).toContainEqual({ source: 'ai', message: 'All AI vision models failed — check API keys' });
});
