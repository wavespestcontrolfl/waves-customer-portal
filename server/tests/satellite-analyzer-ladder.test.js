// Estimate image analysis is a two-provider ladder: Gemini 3.8 Flash first,
// then OpenAI Sol. Every provider request is mocked in this file.

const ORIGINAL_ENV = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
};
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key';
// A legacy global override must not move the estimate-specific OpenAI rung.
process.env.OPENAI_MODEL = 'gpt-6-astra';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

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

const OPENAI_ANALYSIS = { ...FULL_ANALYSIS, lot_sqft: 7000, notes: 'OpenAI read.' };

function imageResponse() {
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
}

function geminiResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      modelVersion: 'gemini-3.8-flash',
      responseId: 'gemini-test-response',
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(body) }] } }],
    }),
  };
}

function openaiResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'openai-test-response',
      status: 'completed',
      model: 'gpt-6-sol',
      output_text: JSON.stringify(body),
    }),
  };
}

function mockFetchRouting({ gemini, openai } = {}) {
  global.fetch = jest.fn((url) => {
    const target = String(url);
    if (target.includes('staticmap')) return Promise.resolve(imageResponse());
    if (target.includes('generativelanguage.googleapis.com')) {
      return gemini !== undefined
        ? Promise.resolve(geminiResponse(gemini))
        : Promise.resolve({ ok: false, status: 500, statusText: 'error' });
    }
    if (target.includes('api.openai.com')) {
      return openai !== undefined
        ? Promise.resolve(openaiResponse(openai))
        : Promise.resolve({ ok: false, status: 500, statusText: 'error' });
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function providerCalls(fragment) {
  return global.fetch.mock.calls.filter(([url]) => String(url).includes(fragment));
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

  it('normalizes formatting noise before validation', () => {
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

describe('analyze() — Gemini → OpenAI Sol ladder', () => {
  it('accepts a valid Gemini result and never calls a fallback provider', async () => {
    mockFetchRouting({ gemini: FULL_ANALYSIS });

    const result = await satelliteAnalyzer.analyze('123 Test St', 27.0, -82.5);

    expect(result.source).toBe('gemini');
    expect(result.confidence).toBe('single_model');
    expect(result.providerStatus).toEqual({ gemini: { configured: true, available: true } });
    expect(providerCalls('api.openai.com')).toHaveLength(0);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();

    const geminiCalls = providerCalls('generativelanguage.googleapis.com');
    expect(geminiCalls).toHaveLength(1);
    expect(String(geminiCalls[0][0])).toContain('/gemini-3.8-flash:generateContent');
    const body = JSON.parse(geminiCalls[0][1].body);
    expect(body.contents[0].parts.filter((part) => part.inline_data)).toEqual([
      { inline_data: { mime_type: 'image/png', data: expect.any(String) } },
      { inline_data: { mime_type: 'image/png', data: expect.any(String) } },
    ]);
    expect(body.generationConfig.response_mime_type).toBe('application/json');
    expect(body.generationConfig.response_json_schema).toMatchObject({
      type: 'object', additionalProperties: false, required: expect.arrayContaining(['lot_sqft', 'notes']),
    });
  });

  it('rejects malformed Gemini JSON and accepts the OpenAI Sol fallback', async () => {
    mockFetchRouting({ gemini: {}, openai: OPENAI_ANALYSIS });

    const result = await satelliteAnalyzer.analyze('123 Test St', 27.0, -82.5);

    expect(result.source).toBe('openai');
    expect(result.confidence).toBe('single_model');
    expect(result.providerStatus).toEqual({
      gemini: { configured: true, available: false },
      openai: { configured: true, available: true },
    });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();

    const openaiCalls = providerCalls('api.openai.com');
    expect(openaiCalls).toHaveLength(1);
    const body = JSON.parse(openaiCalls[0][1].body);
    expect(body.model).toBe('gpt-6-sol');
    expect(body.store).toBe(false);
    expect(body.input[0].content.filter((part) => part.type === 'input_image')).toEqual([
      { type: 'input_image', image_url: expect.stringMatching(/^data:image\/png;base64,/) },
      { type: 'input_image', image_url: expect.stringMatching(/^data:image\/png;base64,/) },
    ]);
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
  });

  it('reports both real attempts when both providers fail, with no Claude call', async () => {
    mockFetchRouting();

    const result = await satelliteAnalyzer.analyze('123 Test St', 27.0, -82.5);

    expect(result.error).toBe('All vision models failed');
    expect(result.providerStatus).toEqual({
      gemini: { configured: true, available: false },
      openai: { configured: true, available: false },
    });
    expect(providerCalls('generativelanguage.googleapis.com')).toHaveLength(1);
    expect(providerCalls('api.openai.com')).toHaveLength(1);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });
});
