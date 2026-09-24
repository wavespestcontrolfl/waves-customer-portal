// Owner ruling 2026-09-24: pest identification vision runs Gemini first — no
// more Claude+Gemini fan-out. Claude runs ONLY when Gemini returns nothing
// (HTTP error / empty / unparseable). This locks analyzePhoto's sequencing:
// a Gemini success never calls Claude, and mergeModelResults' single_model
// path (confidence downgraded a notch) is what a lone Gemini or lone-Claude-
// fallback result goes through — it can never read as the two-model
// "agreement" case.

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const { analyzePhoto, mergeModelResults } = require('../services/pest-identification');

const GEMINI_ID = {
  best_match: 'ghost ant', alternates: [], category: 'insect', confidence: 'high',
  distinguishing_features: ['pale legs'], not_a_pest: false, observations: 'small pale ants trailing',
};

const CLAUDE_ID = {
  best_match: 'fire ant', alternates: [], category: 'insect', confidence: 'high',
  distinguishing_features: ['reddish body'], not_a_pest: false, observations: 'reddish ants near a mound',
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

describe('analyzePhoto — Gemini-first identification with a Claude fallback', () => {
  it('Gemini success: gemini set, claude null, Claude never called', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(GEMINI_ID));

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toMatchObject({ best_match: 'ghost ant' });
    expect(result.claude).toBeNull();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('Gemini miss (HTTP error) falls back to Claude', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(CLAUDE_ID) }],
    });

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toBeNull();
    expect(result.claude).toMatchObject({ best_match: 'fire ant' });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('Gemini miss (empty response) falls back to Claude', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
    });
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(CLAUDE_ID) }],
    });

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toBeNull();
    expect(result.claude).toMatchObject({ best_match: 'fire ant' });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('both providers miss → both null', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    mockAnthropicCreate.mockResolvedValue({ content: [] });

    const result = await analyzePhoto('base64photo', 'image/jpeg');
    expect(result.gemini).toBeNull();
    expect(result.claude).toBeNull();
  });
});

// A single-model result (Gemini alone, or Claude as its fallback) must always
// go through mergeModelResults' single_model downgrade — it can never read
// as the agreed, non-downgraded confidence a two-model match would produce.
describe('a single-model result from the sequential ladder is downgraded, never "high" from agreement', () => {
  it('Gemini-only high confidence downgrades to moderate via mergeModelResults', () => {
    const merged = mergeModelResults(null, { ...GEMINI_ID, confidence: 'high' });
    expect(merged.agreement).toBe('single_model');
    expect(merged.confidence).toBe('moderate');
  });

  it('Claude-as-fallback high confidence also downgrades to moderate', () => {
    const merged = mergeModelResults({ ...CLAUDE_ID, confidence: 'high' }, null);
    expect(merged.agreement).toBe('single_model');
    expect(merged.confidence).toBe('moderate');
  });
});

// Codex P1 class (#4730 r1): a parseable but empty Gemini answer must count as
// a miss so Claude runs, not as a lone result that skips the fallback.
describe('analyzePhoto — an incomplete Gemini answer is a miss', () => {
  it.each([
    ['empty object', {}],
    ['blank best_match', { ...GEMINI_ID, best_match: '  ' }],
    ['unknown category', { ...GEMINI_ID, category: 'bug' }],
    ['missing confidence', (({ confidence, ...rest }) => rest)(GEMINI_ID)],
    ['missing not_a_pest', (({ not_a_pest, ...rest }) => rest)(GEMINI_ID)],
    ['null not_a_pest', { ...GEMINI_ID, not_a_pest: null }],
  ])('%s → falls back to Claude', async (_label, body) => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(body));
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(CLAUDE_ID) }] });

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toBeNull();
    expect(result.claude).toMatchObject({ best_match: 'fire ant' });
  });

  it('a padded " true " not_a_pest is stored as a real boolean', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, not_a_pest: ' True ' }));

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini.not_a_pest).toBe(true);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it('a blurry-photo "unidentifiable" answer is valid, not a miss', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({
      ...GEMINI_ID, best_match: 'unidentifiable', category: 'other', confidence: 'low',
    }));

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toMatchObject({ best_match: 'unidentifiable' });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });
});
