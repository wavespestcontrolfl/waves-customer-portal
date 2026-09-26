// Owner ruling 2026-09-26 (TEXT_POLICIES.photoIdVision): pest identification
// runs Gemini 3.8 Flash first. The same photo is handed to ChatGPT's best
// vision model (OPENAI_FRONTIER) only when Gemini misses (HTTP error / empty /
// unparseable / incomplete), is unsure (confidence_score under
// PHOTO_ID_ESCALATE_BELOW, default 0.80), or lists a runner-up whose risk
// differs from its pick — and then the second look's answer decides (an
// agreement on the same species keeps the lower confidence). Never Claude,
// never both providers at once. A lone answer still goes through
// mergeModelResults' single_model downgrade, so one model alone can never
// read "high".

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  dispatch: (...args) => mockDispatch(...args),
}));

const MODELS = require('../config/models');
const { analyzePhoto, mergeModelResults, identifyPest, _test } = require('../services/pest-identification');

const GEMINI_ID = {
  best_match: 'ghost ant', alternates: [], category: 'insect', confidence: 'high', confidence_score: 0.92,
  distinguishing_features: ['pale legs'], not_a_pest: false, observations: 'small pale ants trailing',
};

const OPENAI_ID = {
  best_match: 'fire ant', alternates: [], category: 'insect', confidence: 'high', confidence_score: 0.9,
  distinguishing_features: ['reddish body'], not_a_pest: false, observations: 'reddish ants near a mound',
};

function geminiResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }),
  };
}

function openaiAnswers(body) {
  mockDispatch.mockResolvedValue({ ok: true, json: body, text: JSON.stringify(body) });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PHOTO_ID_ESCALATE_BELOW;
});

describe('analyzePhoto — Gemini first, ChatGPT only for a second look', () => {
  it('a sure Gemini answer stands alone: OpenAI is never called', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(GEMINI_ID));

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toMatchObject({ best_match: 'ghost ant', confidence_score: 0.92 });
    expect(result.openai).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('an unsure Gemini answer (score under 0.80) goes to OpenAI on the photoIdVision route', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, confidence: 'moderate', confidence_score: 0.62 }));
    openaiAnswers(OPENAI_ID);

    const result = await analyzePhoto('base64photo', 'image/png');

    expect(result.gemini).toMatchObject({ best_match: 'ghost ant' });
    expect(result.openai).toMatchObject({ best_match: 'fire ant' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [route, payload] = mockDispatch.mock.calls[0];
    expect(route).toBe(MODELS.TEXT_POLICIES.photoIdVision.fallback);
    expect(route).toEqual({ provider: 'openai', model: MODELS.OPENAI_FRONTIER });
    expect(payload).toMatchObject({
      images: [{ data: 'base64photo', mimeType: 'image/png' }],
      jsonMode: true,
      laneId: 'pest_id',
      policyLabel: 'photoIdVision',
    });
    expect(payload.timeoutMs).toBeGreaterThan(0);
  });

  it('with no usable score, anything short of "high" is unsure', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, confidence: 'moderate', confidence_score: 'n/a' }));
    openaiAnswers(OPENAI_ID);
    await analyzePhoto('base64photo', 'image/jpeg');
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockDispatch.mockClear();
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, confidence: 'high', confidence_score: undefined }));
    await analyzePhoto('base64photo', 'image/jpeg');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('reads a percentage score as a fraction', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, confidence_score: 85 }));

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini.confidence_score).toBeCloseTo(0.85);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('PHOTO_ID_ESCALATE_BELOW moves the bar; a bad value falls back to 0.80', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, confidence: 'moderate', confidence_score: 0.6 }));
    openaiAnswers(OPENAI_ID);

    process.env.PHOTO_ID_ESCALATE_BELOW = '0.5';
    await analyzePhoto('base64photo', 'image/jpeg');
    expect(mockDispatch).not.toHaveBeenCalled();

    process.env.PHOTO_ID_ESCALATE_BELOW = 'eighty';
    await analyzePhoto('base64photo', 'image/jpeg');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('a sure answer with a runner-up of different risk still gets a second look', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, alternates: ['subterranean termite'] }));
    openaiAnswers(GEMINI_ID);

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(result.openai).toMatchObject({ best_match: 'ghost ant' });
  });

  it('a disease-carrying runner-up counts as a different risk', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, best_match: 'silverfish', alternates: ['american cockroach'] }));
    openaiAnswers({ ...GEMINI_ID, best_match: 'silverfish' });

    await analyzePhoto('base64photo', 'image/jpeg');

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('two different kinds of hazard (fire ant vs termite) still count as a different risk', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, best_match: 'fire ant', alternates: ['subterranean termite'] }));
    openaiAnswers({ ...GEMINI_ID, best_match: 'fire ant' });

    await analyzePhoto('base64photo', 'image/jpeg');

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('a runner-up of the same risk does not escalate', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, alternates: ['bigheaded ant', 42] }));

    await analyzePhoto('base64photo', 'image/jpeg');

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('Gemini miss (HTTP error) goes to OpenAI', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    openaiAnswers(OPENAI_ID);

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toBeNull();
    expect(result.openai).toMatchObject({ best_match: 'fire ant' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('Gemini miss (empty response) goes to OpenAI', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
    });
    openaiAnswers(OPENAI_ID);

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toBeNull();
    expect(result.openai).toMatchObject({ best_match: 'fire ant' });
  });

  it('a risky runner-up whose second look fails is reported as unresolved', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, alternates: ['subterranean termite'] }));
    mockDispatch.mockResolvedValue({ ok: false, reason: 'openai_timeout' });

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.openai).toBeNull();
    expect(result.unresolved.map((entry) => entry.slug)).toEqual(['subterranean-termite']);
  });

  it('an OpenAI miss or an invalid OpenAI answer is null, never a result', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

    mockDispatch.mockResolvedValue({ ok: false, reason: 'openai_timeout' });
    expect(await analyzePhoto('base64photo', 'image/jpeg')).toMatchObject({ openai: null, gemini: null });

    openaiAnswers({ best_match: 'fire ant' });
    expect(await analyzePhoto('base64photo', 'image/jpeg')).toMatchObject({ openai: null, gemini: null });

    mockDispatch.mockRejectedValue(new Error('socket hang up'));
    expect(await analyzePhoto('base64photo', 'image/jpeg')).toMatchObject({ openai: null, gemini: null });
  });
});

describe('resolvePhoto — one decisive answer per photo', () => {
  it('a lone Gemini answer downgrades a notch, never "high"', () => {
    const photo = _test.resolvePhoto({ openai: null, gemini: { ...GEMINI_ID, confidence: 'high' }, unresolved: [] });
    expect(photo).toMatchObject({ agreement: 'single_model', confidence: 'moderate' });
  });

  it('when the models name the same species, the agreement keeps the lower confidence', () => {
    const photo = _test.resolvePhoto({ openai: { ...GEMINI_ID, confidence: 'high' }, gemini: { ...GEMINI_ID, confidence: 'moderate' } });
    expect(photo).toMatchObject({ agreement: 'match', confidence: 'moderate' });
    expect(photo.entry.slug).toBe('ghost-ant');
  });

  it('when they differ, the second look decides, as a lone answer', () => {
    const photo = _test.resolvePhoto({ openai: OPENAI_ID, gemini: { ...GEMINI_ID, confidence: 'moderate' } });
    expect(photo).toMatchObject({ agreement: 'single_model', confidence: 'moderate' });
    expect(photo.entry.slug).toBe('fire-ant');
  });

  it('an "unidentifiable" second look decides too: nothing is named', () => {
    const photo = _test.resolvePhoto({ openai: { ...OPENAI_ID, best_match: 'unidentifiable', category: 'other', confidence: 'low' }, gemini: GEMINI_ID });
    expect(photo.entry).toBeNull();
  });

  it('after a Gemini miss, the second look is the lone answer', () => {
    const photo = _test.resolvePhoto({ openai: { ...OPENAI_ID, confidence: 'high' }, gemini: null });
    expect(photo).toMatchObject({ agreement: 'single_model', confidence: 'moderate' });
  });
});

// Codex P1 class (#4730 r1): a parseable but empty Gemini answer must count as
// a miss so the OpenAI leg runs, not as a lone result that skips it.
describe('analyzePhoto — an incomplete Gemini answer is a miss', () => {
  it.each([
    ['empty object', {}],
    ['blank best_match', { ...GEMINI_ID, best_match: '  ' }],
    ['unknown category', { ...GEMINI_ID, category: 'bug' }],
    ['missing confidence', (({ confidence, ...rest }) => rest)(GEMINI_ID)],
    ['missing not_a_pest', (({ not_a_pest, ...rest }) => rest)(GEMINI_ID)],
    ['null not_a_pest', { ...GEMINI_ID, not_a_pest: null }],
  ])('%s → goes to OpenAI', async (_label, body) => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse(body));
    openaiAnswers(OPENAI_ID);

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toBeNull();
    expect(result.openai).toMatchObject({ best_match: 'fire ant' });
  });

  it('a padded " true " not_a_pest is stored as a real boolean', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, not_a_pest: ' True ' }));

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini.not_a_pest).toBe(true);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('a blurry-photo "unidentifiable" answer is kept, and being unsure it gets the second look', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({
      ...GEMINI_ID, best_match: 'unidentifiable', category: 'other', confidence: 'low', confidence_score: 0.1,
    }));
    openaiAnswers({ ...OPENAI_ID, best_match: 'unidentifiable', category: 'other', confidence: 'low', confidence_score: 0.1 });

    const result = await analyzePhoto('base64photo', 'image/jpeg');

    expect(result.gemini).toMatchObject({ best_match: 'unidentifiable' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('identifyPest — photos are read side by side', () => {
  it('keeps photo order while one photo waits on its second look', async () => {
    let releaseSlowPhoto;
    const slowPhoto = new Promise((resolve) => { releaseSlowPhoto = resolve; });
    global.fetch = jest.fn((url, init) => {
      const body = JSON.parse(init.body);
      const photo = body.contents[0].parts[0].inline_data.data;
      return Promise.resolve(geminiResponse(photo === 'first'
        ? { ...GEMINI_ID, confidence: 'moderate', confidence_score: 0.5 }
        : { ...GEMINI_ID, best_match: 'bigheaded ant' }));
    });
    mockDispatch.mockImplementation(() => slowPhoto.then(() => ({ ok: true, json: GEMINI_ID })));

    const pending = identifyPest([{ data: 'first' }, { data: 'second' }]);
    await new Promise((resolve) => setImmediate(resolve));
    // Both Gemini reads have gone out while the first photo's second look waits.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    releaseSlowPhoto();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.perPhoto.map((photo) => photo.entry && photo.entry.slug)).toEqual(['ghost-ant', 'bigheaded-ant']);
    expect(result.perPhoto[0].agreement).toBe('match');
  });

  it('an unsure Gemini answer that the second look overrules reports the second look\'s species', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, confidence: 'moderate', confidence_score: 0.5 }));
    openaiAnswers({ ...OPENAI_ID, confidence: 'high' });

    const result = await identifyPest([{ data: 'one' }]);

    expect(result.identification.entry.slug).toBe('fire-ant');
    expect(result.identification.confidence).toBe('moderate');
  });

  it('a risky runner-up with a failed second look makes the upload unresolved', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...GEMINI_ID, alternates: ['subterranean termite'] }));
    mockDispatch.mockResolvedValue({ ok: false, reason: 'openai_timeout' });

    const result = await identifyPest([{ data: 'one' }]);

    expect(result.identification).toMatchObject({ entry: null, unresolved: true });
    expect(result.alternate_slugs).toEqual(expect.arrayContaining(['ghost-ant', 'subterranean-termite']));
  });
});
