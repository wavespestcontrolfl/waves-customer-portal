// Owner ruling 2026-09-24: lawn health scoring runs on Gemini only — no more
// Claude+Gemini averaging. Claude is a fallback ONLY when Gemini returns
// nothing (HTTP error / empty / unparseable). This locks analyzePhoto's
// behavior at that boundary: a Gemini success never calls Claude and returns
// Gemini's scores unchanged with no divergence flags; a Gemini miss falls
// back to Claude, whose scores also pass through unchanged.

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const { analyzePhoto } = require('../services/lawn-assessment');

const GEMINI_SCORES = {
  turf_density: 82, weed_coverage: 6, color_health: 8,
  fungal_activity: 'none', insect_damage: 'none', drought_stress: 'none', mechanical_damage: 'none',
  thatch_visibility: 'low', overwatering_signal: false, grass_type: 'st_augustine',
  observations: 'Healthy, uniform green turf with no visible stress.',
};

const CLAUDE_SCORES = {
  turf_density: 40, weed_coverage: 35, color_health: 4,
  fungal_activity: 'moderate', insect_damage: 'minor', drought_stress: 'moderate', mechanical_damage: 'none',
  thatch_visibility: 'moderate', overwatering_signal: true, grass_type: 'st_augustine',
  observations: 'Patchy browning consistent with drought stress.',
};

function geminiResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('analyzePhoto — Gemini-only scoring with a Claude fallback', () => {
  it('Gemini success: composite is Gemini\'s scores unchanged, no divergence flags, Claude never called', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(GEMINI_SCORES));

    const result = await analyzePhoto('base64photo', 'image/jpeg', {});

    expect(result.gemini).toMatchObject({ turf_density: 82, weed_coverage: 6, color_health: 8, grass_type: 'st_augustine' });
    expect(result.claude).toBeNull();
    expect(result.composite).toEqual(result.gemini);
    expect(result.divergenceFlags).toEqual([]);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    // Only one Gemini attempt: GEMINI_VISION_FALLBACK defaults to the same
    // model as GEMINI_VISION_BEST, so the retry rung is skipped on success too.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('Gemini miss (HTTP error) falls back to Claude, whose scores pass through unchanged', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(CLAUDE_SCORES) }],
    });

    const result = await analyzePhoto('base64photo', 'image/jpeg', {});

    expect(result.gemini).toBeNull();
    expect(result.claude).toMatchObject({ turf_density: 40, weed_coverage: 35, color_health: 4, grass_type: 'st_augustine' });
    expect(result.composite).toEqual(result.claude);
    expect(result.divergenceFlags).toEqual([]);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('both providers miss → null (never throws)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    mockAnthropicCreate.mockResolvedValue({ content: [] });

    const result = await analyzePhoto('base64photo', 'image/jpeg', {});
    expect(result).toBeNull();
  });
});
