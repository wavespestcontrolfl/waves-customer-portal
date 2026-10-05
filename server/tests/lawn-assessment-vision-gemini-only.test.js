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

// Codex P1 (#4730 r1): a syntactically valid but incomplete Gemini response is
// still a truthy object. It must count as a miss so Claude runs, instead of the
// missing fields becoming zero-density / stress findings on the customer report.
describe('analyzePhoto — incomplete Gemini scores are a miss, not a result', () => {
  const claudeOk = () => mockAnthropicCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(CLAUDE_SCORES) }],
  });

  it.each([
    ['empty object', {}],
    ['missing turf_density', (({ turf_density, ...rest }) => rest)(GEMINI_SCORES)],
    ['turf_density out of range', { ...GEMINI_SCORES, turf_density: 140 }],
    ['color_health out of range', { ...GEMINI_SCORES, color_health: 0 }],
    ['unknown severity value', { ...GEMINI_SCORES, fungal_activity: 'extreme' }],
    ['missing observations', (({ observations, ...rest }) => rest)(GEMINI_SCORES)],
  ])('%s → falls back to Claude', async (_label, body) => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(body));
    claudeOk();

    const result = await analyzePhoto('base64photo', 'image/jpeg', {});

    expect(result.gemini).toBeNull();
    expect(result.composite).toMatchObject({ turf_density: 40, weed_coverage: 35 });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('an incomplete Claude fallback is rejected too → null, never zero scores', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({}));
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });

    expect(await analyzePhoto('base64photo', 'image/jpeg', {})).toBeNull();
  });

  it('formatting noise (quoted numbers, capitalized enums) is normalized, not rejected', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({
      ...GEMINI_SCORES, turf_density: '82', color_health: '8', fungal_activity: 'None', thatch_visibility: 'Low',
    }));

    const result = await analyzePhoto('base64photo', 'image/jpeg', {});

    expect(result.gemini).toMatchObject({ turf_density: 82, color_health: 8, fungal_activity: 'none', thatch_visibility: 'low' });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });
});

// Codex r2 P1: overwatering_signal must be validated BEFORE boolean coercion,
// or a missing/null flag silently becomes false and skips the Claude fallback.
describe('analyzePhoto — overwatering flag must be explicit', () => {
  it.each([
    ['missing', (({ overwatering_signal, ...rest }) => rest)(GEMINI_SCORES)],
    ['null', { ...GEMINI_SCORES, overwatering_signal: null }],
    ['garbage string', { ...GEMINI_SCORES, overwatering_signal: 'maybe' }],
  ])('%s → falls back to Claude', async (_label, body) => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(body));
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(CLAUDE_SCORES) }] });

    const result = await analyzePhoto('base64photo', 'image/jpeg', {});

    expect(result.gemini).toBeNull();
    expect(result.composite.overwatering_signal).toBe(true);
  });

  it('string "True"/"false" still normalizes to a boolean', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_SCORES, overwatering_signal: 'True' }));

    const result = await analyzePhoto('base64photo', 'image/jpeg', {});

    expect(result.gemini.overwatering_signal).toBe(true);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });
});

// POST /admin/lawn-assessment/assess hands every photo what is left of its
// request window (Cloudflare 524s the technician at 100 s). The budget must
// reach the Gemini fetch as an abort signal, and a photo already out of time
// skips the Claude fallback instead of starting a fresh 10-minute SDK call.
describe('analyzePhoto — timeoutMs budget', () => {
  it('a stalled Gemini leaves the Claude fallback the second half of the budget', async () => {
    // Real timers: AbortSignal.timeout runs on Node's own clock. Gemini
    // "answers" only when its abort signal fires, i.e. at its half of the budget.
    global.fetch = jest.fn((url, init) => new Promise((resolve) => {
      init.signal.addEventListener('abort', () => resolve({ ok: false, status: 499, statusText: 'aborted' }));
    }));
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(CLAUDE_SCORES) }] });

    const started = Date.now();
    const result = await analyzePhoto('base64photo', 'image/jpeg', {}, { timeoutMs: 4000 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(result.claude).toMatchObject({ turf_density: CLAUDE_SCORES.turf_density });
    const options = mockAnthropicCreate.mock.calls[0][1];
    expect(options.timeout).toBeGreaterThan(1000);
    expect(options.timeout).toBeLessThanOrEqual(2100);
  }, 10000);

  it('passes the budget to the Gemini fetch as an abort signal', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(GEMINI_SCORES));

    await analyzePhoto('base64photo', 'image/jpeg', {}, { timeoutMs: 5000 });

    const init = global.fetch.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it('runs with no deadline when no budget is given', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(GEMINI_SCORES));

    await analyzePhoto('base64photo', 'image/jpeg', {});

    expect(global.fetch.mock.calls[0][1].signal).toBeUndefined();
  });

  it('a photo handed no budget at all is never sent to either provider', async () => {
    global.fetch = jest.fn();

    const result = await analyzePhoto('base64photo', 'image/jpeg', {}, { timeoutMs: 0 });

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it('a Gemini miss that used up the budget returns null without calling Claude', async () => {
    global.fetch = jest.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ok: false, status: 503, statusText: 'Service Unavailable' };
    });

    const result = await analyzePhoto('base64photo', 'image/jpeg', {}, { timeoutMs: 1 });

    expect(result).toBeNull();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it('a Gemini miss with budget left falls back to Claude under the same deadline, retries off', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(CLAUDE_SCORES) }] });

    const result = await analyzePhoto('base64photo', 'image/jpeg', {}, { timeoutMs: 20000 });

    expect(result.claude).toMatchObject({ turf_density: CLAUDE_SCORES.turf_density });
    const options = mockAnthropicCreate.mock.calls[0][1];
    expect(options.maxRetries).toBe(0);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(20000);
  });
});
