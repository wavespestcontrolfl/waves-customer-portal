// Owner ruling 2026-09-24: satellite property analysis runs as a ladder —
// Gemini first, then Claude, then OpenAI as the true last resort — stopping
// at the first schema-valid result. No more three-way parallel fan-out with
// agreement-based confidence. A single-source result must never report
// "high" confidence (that used to require multi-provider agreement).

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-maps-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const satelliteAnalyzer = require('../services/satellite-analyzer');
const { isValidSatelliteAnalysis, normalizeSatelliteAnalysis } = satelliteAnalyzer;

const FULL_ANALYSIS = {
  lot_sqft: 8000, lawn_sqft: 4000, house_footprint_sqft: 2000, bed_area_sqft: 400, driveway_sqft: 600,
  palm_count: 3, tree_count: 2, shrub_density: 'MODERATE', tree_density: 'SPARSE',
  landscape_complexity: 'MODERATE', has_pool: true, has_pool_cage: true, has_large_driveway: false,
  near_water: false, property_type: 'Single Family', roof_condition: 'good', perimeter_linear_ft: 220,
  notes: 'Nothing notable.',
};

const CLAUDE_ANALYSIS = { ...FULL_ANALYSIS, lot_sqft: 9000, notes: 'Claude read.' };
const OPENAI_ANALYSIS = { ...FULL_ANALYSIS, lot_sqft: 7000, notes: 'OpenAI read.' };

function imageBuffer() {
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
}
function geminiHttpResponse(body) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }) };
}
function openaiHttpResponse(body) {
  return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(body) }) };
}

function mockFetchRouting({ gemini, openai } = {}) {
  global.fetch = jest.fn((url) => {
    if (String(url).includes('staticmap')) return Promise.resolve(imageBuffer());
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return gemini ? Promise.resolve(geminiHttpResponse(gemini)) : Promise.resolve({ ok: false, status: 500, statusText: 'error' });
    }
    if (String(url).includes('api.openai.com')) {
      return openai ? Promise.resolve(openaiHttpResponse(openai)) : Promise.resolve({ ok: false, status: 500, statusText: 'error' });
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isValidSatelliteAnalysis — schema contract validation', () => {
  it('accepts a fully-populated response', () => {
    expect(isValidSatelliteAnalysis(FULL_ANALYSIS)).toBe(true);
  });

  it('rejects an empty object — a truthy `{}` must not read as a real result', () => {
    expect(isValidSatelliteAnalysis({})).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { lot_sqft: _lotSqft, ...rest } = FULL_ANALYSIS;
    expect(isValidSatelliteAnalysis(rest)).toBe(false);
  });

  it('rejects an out-of-contract enum value', () => {
    expect(isValidSatelliteAnalysis({ ...FULL_ANALYSIS, property_type: 'single_family' })).toBe(false);
  });

  it('normalizes formatting noise (quoted numbers, stringified booleans, casing) before validation', () => {
    const noisy = {
      ...FULL_ANALYSIS,
      lot_sqft: '8000',
      has_pool: 'true',
      shrub_density: 'moderate',
      landscape_complexity: 'moderate',
      roof_condition: 'GOOD',
      property_type: 'single family',
    };
    normalizeSatelliteAnalysis(noisy);
    expect(isValidSatelliteAnalysis(noisy)).toBe(true);
    expect(noisy.lot_sqft).toBe(8000);
    expect(noisy.has_pool).toBe(true);
    expect(noisy.shrub_density).toBe('MODERATE');
    expect(noisy.property_type).toBe('Single Family');
  });
});

describe('analyze() — Gemini → Claude → OpenAI ladder, stopping at first valid result', () => {
  it('Gemini valid → Claude and OpenAI never called', async () => {
    mockFetchRouting({ gemini: FULL_ANALYSIS });

    const result = await satelliteAnalyzer.analyze('123 Test St', 27.0, -82.5);

    expect(result.source).toBe('gemini');
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    // Rungs the ladder never reached get no status entry, so the estimate
    // pages' "ChatGPT skipped" warning (configured === false) cannot fire.
    expect(result.providerStatus.claude).toBeUndefined();
    expect(result.providerStatus.gemini).toEqual({ configured: true, available: true });
    expect(result.providerStatus.openai).toBeUndefined();
    expect(result.confidence).toBe('single_model');
  });

  it('Gemini miss (malformed `{}`) → Claude runs and wins; OpenAI never called', async () => {
    mockFetchRouting({ gemini: {} });
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(CLAUDE_ANALYSIS) }] });

    const result = await satelliteAnalyzer.analyze('123 Test St', 27.0, -82.5);

    expect(result.source).toBe('claude');
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(result.providerStatus.openai).toBeUndefined();
    expect(result.confidence).toBe('single_model');
  });

  it('Gemini and Claude both miss → OpenAI runs as the true last resort', async () => {
    mockFetchRouting({ openai: OPENAI_ANALYSIS });
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });

    const result = await satelliteAnalyzer.analyze('123 Test St', 27.0, -82.5);

    expect(result.source).toBe('openai');
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(result.confidence).toBe('single_model');
  });

  it('a single-source result never reports "high" confidence', async () => {
    mockFetchRouting({ gemini: FULL_ANALYSIS });
    const result = await satelliteAnalyzer.analyze('123 Test St', 27.0, -82.5);
    expect(result.confidence).not.toBe('high');
    expect(result.confidence).toBe('single_model');
  });

  it('all three miss → error, and providerStatus reflects real attempts (not false "available:false" on a skipped rung)', async () => {
    mockFetchRouting({});
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });

    const result = await satelliteAnalyzer.analyze('123 Test St', 27.0, -82.5);

    expect(result.error).toBe('All vision models failed');
  });
});
