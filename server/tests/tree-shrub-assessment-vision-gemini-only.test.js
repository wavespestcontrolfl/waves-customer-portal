// Owner ruling 2026-09-24: tree & shrub vision scoring runs on Gemini only —
// no more Claude+Gemini fan-out/averaging. Claude is a fallback ONLY when
// Gemini returns nothing (HTTP error / empty / unparseable / schema-invalid).
// This locks analyzePhoto's behavior at that boundary: a Gemini success never
// calls Claude and returns Gemini's scores unchanged with no divergence
// flags; a Gemini miss falls back to Claude, whose scores also pass through
// unchanged. Mirrors lawn-assessment-vision-gemini-only.test.js.

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const { analyzePhoto } = require('../services/tree-shrub-assessment');

const GEMINI_SCORES = {
  foliage_fullness: 88, leaf_color_vigor: 82,
  pest_signals: 'none', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none',
  observations: 'Full, vibrant hedges with no visible pest or disease signals.',
};

const CLAUDE_SCORES = {
  foliage_fullness: 55, leaf_color_vigor: 48,
  pest_signals: 'moderate', disease_signals: 'minor', water_heat_stress: 'minor', pruning_mechanical: 'none',
  observations: 'Sparse foliage consistent with scale-like pest pressure.',
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

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toMatchObject({ foliage_fullness: 88, leaf_color_vigor: 82, pest_signals: 'none' });
    expect(result.claude).toBeNull();
    expect(result.composite).toEqual(result.gemini);
    expect(result.divergenceFlags).toEqual([]);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('Gemini miss (HTTP error) falls back to Claude, whose scores pass through unchanged', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(CLAUDE_SCORES) }],
    });

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toBeNull();
    expect(result.claude).toMatchObject({ foliage_fullness: 55, leaf_color_vigor: 48, pest_signals: 'moderate' });
    expect(result.composite).toEqual(result.claude);
    expect(result.divergenceFlags).toEqual([]);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('both providers miss → null (never throws)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    mockAnthropicCreate.mockResolvedValue({ content: [] });

    const result = await analyzePhoto('base64photo', 'image/jpeg');
    expect(result).toBeNull();
  });
});

// Codex P1 pattern (2026-09-24, #4730): a syntactically valid but incomplete
// Gemini response is still a truthy object. It must count as a miss so Claude
// runs, instead of the missing fields becoming false "zero health" findings.
describe('analyzePhoto — incomplete Gemini scores are a miss, not a result', () => {
  const claudeOk = () => mockAnthropicCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(CLAUDE_SCORES) }],
  });

  it.each([
    ['empty object', {}],
    ['missing foliage_fullness', (({ foliage_fullness, ...rest }) => rest)(GEMINI_SCORES)],
    ['foliage_fullness out of range', { ...GEMINI_SCORES, foliage_fullness: 140 }],
    ['unknown severity value', { ...GEMINI_SCORES, pest_signals: 'extreme' }],
    ['missing observations', (({ observations, ...rest }) => rest)(GEMINI_SCORES)],
  ])('%s → falls back to Claude', async (_label, body) => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(body));
    claudeOk();

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toBeNull();
    expect(result.composite).toMatchObject({ foliage_fullness: 55, leaf_color_vigor: 48 });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('an incomplete Claude fallback is rejected too → null, never zero scores', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({}));
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });

    expect(await analyzePhoto('base64photo', 'image/jpeg')).toBeNull();
  });

  it('formatting noise (quoted numbers, capitalized severities) is normalized, not rejected', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({
      ...GEMINI_SCORES, foliage_fullness: '88', leaf_color_vigor: '82', pest_signals: 'None', disease_signals: 'None',
    }));

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toMatchObject({ foliage_fullness: 88, leaf_color_vigor: 82, pest_signals: 'none' });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });
});
