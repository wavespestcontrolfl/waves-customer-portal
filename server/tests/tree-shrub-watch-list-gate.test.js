// GATE_TS_WATCH_LIST on the T&S photo read: the watch list is NEVER in the main
// read's prompt (that read writes the observations customer copy uses). Watch
// signals come from a SEPARATE Gemini call that asks only for keys; its failure
// can never fail or change the main read; gate off = exactly one call, byte-
// identical. Synthetic data.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const gates = require('../config/feature-gates');
const logger = require('../services/logger');
const {
  VISION_PROMPT, visionPromptText, analyzePhoto, previewTreeShrubAssessment, isValidTreeShrubScores,
} = require('../services/tree-shrub-assessment');
const { ITEMS } = require('../config/tree-shrub-watch-list');
const { PALM_CROWN_PROMPT_RULE } = require('../services/service-report/tree-shrub-tech-findings');
const { watchListPromptBlock, MONTHS } = require('../config/tree-shrub-watch-list');

const SCORES = {
  foliage_fullness: 70, leaf_color_vigor: 64,
  pest_signals: 'minor', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none',
  observations: 'Some thin foliage with scale-like bumps on a few leaves.',
};
const geminiResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: typeof body === 'string' ? body : JSON.stringify(body) }] } }] }),
});
const bodyOf = (call) => JSON.parse(call[1].body);
const promptOf = (call) => bodyOf(call).contents[0].parts[1].text;
const isWatchCall = (call) => promptOf(call).includes("This month's watch list");
const mainCalls = () => global.fetch.mock.calls.filter((call) => !isWatchCall(call));
const watchCalls = () => global.fetch.mock.calls.filter(isWatchCall);
// One fetch mock serving both calls: the main read and the watch-signal read.
function serve({ main = SCORES, watch = { watch_signals: [] } } = {}) {
  global.fetch = jest.fn(async (url, init) => {
    const text = JSON.parse(init.body).contents[0].parts[1].text;
    const answer = text.includes("This month's watch list") ? watch : main;
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'function') return answer();
    return geminiResponse(answer);
  });
}

const saved = {};
beforeEach(() => {
  jest.clearAllMocks();
  for (const name of ['GATE_TS_WATCH_LIST', 'GATE_TS_TECH_FINDINGS_COPY']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe('tsWatchListLive', () => {
  test('strict opt-in, read at call time', () => {
    expect(gates.tsWatchListLive()).toBe(false);
    for (const value of ['1', 'TRUE', 'True', 'yes', ' true', 'false', '']) {
      process.env.GATE_TS_WATCH_LIST = value;
      expect(gates.tsWatchListLive()).toBe(false);
    }
    process.env.GATE_TS_WATCH_LIST = 'true';
    expect(gates.tsWatchListLive()).toBe(true);
    delete process.env.GATE_TS_WATCH_LIST;
    expect(gates.tsWatchListLive()).toBe(false);
  });
  test('the boot status log sees it, dark by default', () => {
    expect(JSON.stringify(Object.keys(gates))).toContain('tsWatchListLive');
    const src = require('fs').readFileSync(require.resolve('../config/feature-gates'), 'utf8');
    expect(src).toContain("tsWatchList: process.env.GATE_TS_WATCH_LIST === 'true',");
    expect(src).toContain(' *   GATE_TS_WATCH_LIST=true (');
  });
});

describe('the MAIN prompt never depends on the watch list', () => {
  test('gate off or on, any month: visionPromptText() is the same prompt', () => {
    expect(visionPromptText()).toBe(VISION_PROMPT);
    process.env.GATE_TS_WATCH_LIST = 'true';
    expect(visionPromptText()).toBe(VISION_PROMPT);
    expect(visionPromptText(3)).toBe(VISION_PROMPT);
    expect(VISION_PROMPT).not.toContain('watch list');
    expect(VISION_PROMPT).not.toContain('watch_signals');
  });
  test('it depends only on the tech-findings gate, with the watch gate on or off', () => {
    process.env.GATE_TS_TECH_FINDINGS_COPY = 'true';
    const marker = 'Return this exact JSON structure';
    const expected = VISION_PROMPT.replace(marker, `${PALM_CROWN_PROMPT_RULE} In "observations", never call a palm's crown, spear leaf or newest fronds healthy, fine or normal; if only the crown is in view, say it is not clearly visible.\n\n${marker}`);
    expect(visionPromptText()).toBe(expected);
    process.env.GATE_TS_WATCH_LIST = 'true';
    expect(visionPromptText(10)).toBe(expected);
  });
  test('the optional field is not part of the validated schema', () => {
    expect(isValidTreeShrubScores({ ...SCORES })).toBe(true);
    expect(isValidTreeShrubScores({ ...SCORES, watch_signals: 'garbage' })).toBe(true);
    expect(isValidTreeShrubScores({ ...SCORES, watch_signals: ['scale'], foliage_fullness: 250 })).toBe(false);
  });
});

describe('analyzePhoto: gate off or no month = exactly one call, as before', () => {
  test('gate off with a month: one call, the plain prompt, no watchSignals key', async () => {
    serve();
    const withMonth = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(promptOf(global.fetch.mock.calls[0])).toBe(VISION_PROMPT);
    serve();
    const noMonth = await analyzePhoto('b64', 'image/jpeg');
    expect(withMonth).toEqual(noMonth);
    expect(Object.keys(withMonth).sort()).toEqual(['claude', 'composite', 'divergenceFlags', 'gemini']);
  });
  test('gate on, no or bad month: one call, no watchSignals key (every existing caller unchanged)', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    for (const options of [undefined, {}, { month: 0 }, { month: 13 }, { month: 'x' }]) {
      serve();
      const result = await analyzePhoto('b64', 'image/jpeg', options);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect('watchSignals' in result).toBe(false);
    }
  });
});

describe('analyzePhoto: gate on with a valid month', () => {
  beforeEach(() => { process.env.GATE_TS_WATCH_LIST = 'true'; });

  test('two calls per photo: the main read and the watch read', async () => {
    serve({ watch: { watch_signals: ['scale'] } });
    await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mainCalls()).toHaveLength(1);
    expect(watchCalls()).toHaveLength(1);
  });

  test('the main call is byte-identical to the gate-off call: same prompt, same request body', async () => {
    serve({ watch: { watch_signals: ['scale'] } });
    await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    const gateOnMain = mainCalls()[0];
    expect(promptOf(gateOnMain)).toBe(visionPromptText());
    expect(promptOf(gateOnMain)).toBe(VISION_PROMPT);
    delete process.env.GATE_TS_WATCH_LIST;
    serve();
    await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    const gateOffMain = global.fetch.mock.calls[0];
    expect(gateOnMain[0]).toBe(gateOffMain[0]);
    expect(gateOnMain[1].body).toBe(gateOffMain[1].body);
  });

  test('the main prompt carries no watch-list text and no item key from any month', async () => {
    serve();
    for (const month of [1, 5, 10, 12]) {
      global.fetch = undefined;
      serve();
      await analyzePhoto('b64', 'image/jpeg', { month });
      const prompt = promptOf(mainCalls()[0]);
      expect(prompt).not.toMatch(/watch.?list|watch_signals/i);
      for (const key of Object.keys(ITEMS)) expect(prompt).not.toContain(`- ${key}:`);
    }
  });

  test('the watch call asks only for keys: the month block, no observations, no scores', async () => {
    serve();
    await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    const call = watchCalls()[0];
    const prompt = promptOf(call);
    expect(prompt).toBe(watchListPromptBlock(10));
    expect(prompt).toContain('- scale: Possible scale');
    expect(prompt).toContain('{"watch_signals": ["<watch-list key>"]}');
    // it never asks for the main read's fields
    for (const field of ['foliage_fullness', 'leaf_color_vigor', 'pest_signals', 'disease_signals', 'water_heat_stress', 'pruning_mechanical', '"observations"']) {
      expect(prompt).not.toContain(field);
    }
    expect(prompt).toMatch(/no scores, no observations/);
  });

  test('the watch call is Gemini, same key, with a small output ceiling', async () => {
    serve();
    await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    const [url, init] = watchCalls()[0];
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('key=test-gemini-key');
    expect(url).toBe(mainCalls()[0][0]);
    expect(JSON.parse(init.body).generationConfig.maxOutputTokens).toBeLessThanOrEqual(1024);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  test('known signals in list order; unknown, duplicate and other-month keys dropped', async () => {
    serve({ watch: { watch_signals: ['whitefly', 'scale', 'scale', 'made_up', 7, 'trunk_conk_base', 'aphids'] } });
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    // October: scale, whitefly, root_rot, bed_weeds, then year-round. aphids is not on it.
    expect(result.watchSignals).toEqual(['scale', 'whitefly', 'trunk_conk_base']);
  });

  test('a missing or malformed watch field is [] and the main read is unchanged', async () => {
    serve();
    const clean = await analyzePhoto('b64', 'image/jpeg', { month: 4 });
    expect(clean.watchSignals).toEqual([]);
    for (const bad of ['scale', 5, { 0: 'scale' }, [null, {}, []], true, null]) {
      serve({ watch: { watch_signals: bad } });
      const result = await analyzePhoto('b64', 'image/jpeg', { month: 4 });
      expect(result.watchSignals).toEqual([]);
      expect(result.composite).toEqual(clean.composite);
    }
  });

  test.each([
    ['HTTP 500', () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })],
    ['garbage JSON', () => geminiResponse('this is not json')],
    ['empty answer', () => ({ ok: true, status: 200, json: async () => ({ candidates: [] }) })],
    ['a thrown fetch', new Error('network down')],
  ])('watch call failure (%s): watchSignals [] and the main read unchanged, warned', async (_name, watch) => {
    serve();
    const reference = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    serve({ watch });
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(result).not.toBeNull();
    expect(result.watchSignals).toEqual([]);
    expect(result.composite).toEqual(reference.composite);
    expect(result.gemini).toEqual(reference.gemini);
    expect(result.claude).toBeNull();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    if (_name !== 'empty answer') expect(logger.warn).toHaveBeenCalled();
  });

  test('a stalled watch call aborts at its deadline: the main read still answers, watchSignals []', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);
    try {
      global.fetch = jest.fn((url, init) => {
        const text = JSON.parse(init.body).contents[0].parts[1].text;
        if (!text.includes("This month's watch list")) return Promise.resolve(geminiResponse(SCORES));
        // Never answers; only the request's own abort signal ends it.
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        });
      });
      const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
      expect(result.watchSignals).toEqual([]);
      expect(result.gemini).toMatchObject({ foliage_fullness: SCORES.foliage_fullness });
    } finally {
      AbortSignal.timeout = realTimeout;
    }
  });

  test('no Gemini key: the watch read is [] without a call (the main read is unaffected)', async () => {
    jest.resetModules();
    const key = process.env.GEMINI_API_KEY;
    const googleKey = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      const fresh = require('../services/tree-shrub-assessment');
      global.fetch = jest.fn();
      mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(SCORES) }] });
      const result = await fresh.analyzePhoto('b64', 'image/jpeg', { month: 10 });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.watchSignals).toEqual([]);
      expect(result.composite.observations).toBe(SCORES.observations);
    } finally {
      process.env.GEMINI_API_KEY = key;
      if (googleKey !== undefined) process.env.GOOGLE_API_KEY = googleKey;
    }
  });

  test('a main read that is invalid still fails over to Claude, which is never given the watch list', async () => {
    serve({
      main: { ...SCORES, foliage_fullness: 250 },
      watch: { watch_signals: ['scale'] },
    });
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(SCORES) }] });
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCreate.mock.calls[0][0].messages[0].content[1].text).toBe(VISION_PROMPT);
    expect(result.watchSignals).toEqual(['scale']);
  });

  test('a main read that cannot be had is null, as today, whatever the watch read says', async () => {
    serve({ main: { garbage: true }, watch: { watch_signals: ['scale'] } });
    mockAnthropicCreate.mockResolvedValue(null);
    expect(await analyzePhoto('b64', 'image/jpeg', { month: 10 })).toBeNull();
  });

  test('a stray watch_signals field in the MAIN reply changes nothing and is not the source of signals', async () => {
    serve({ main: { ...SCORES, watch_signals: ['scale', 'sooty_mold'] }, watch: { watch_signals: ['whitefly'] } });
    const stray = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    delete process.env.GATE_TS_WATCH_LIST;
    serve({ main: { ...SCORES, watch_signals: ['scale', 'sooty_mold'] } });
    const off = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(stray.watchSignals).toEqual(['whitefly']);
    expect(stray.composite).toEqual(off.composite);
    expect(isValidTreeShrubScores(stray.gemini)).toBe(true);
  });

  test('a watch-list item the watch call names never reaches the observations', async () => {
    const watch = { watch_signals: ['root_rot', 'trunk_conk_base', 'scale'], observations: 'Root rot and trunk conk everywhere.', note: 'root rot' };
    serve({ watch });
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(result.watchSignals).toEqual(['scale', 'root_rot', 'trunk_conk_base']);
    expect(result.composite.observations).toBe(SCORES.observations);
    expect(result.composite.observations).not.toMatch(/root rot|trunk conk/i);
    expect(JSON.stringify(result.composite)).not.toMatch(/root_rot|trunk_conk_base/);
    // and the watch reply's own prose is never read
    expect(JSON.stringify(result)).not.toContain('everywhere');
  });

  test('scores are the same with or without signals', async () => {
    serve({ watch: { watch_signals: ['scale', 'sooty_mold'] } });
    const flagged = await analyzePhoto('b64', 'image/jpeg', { month: 1 });
    serve({ watch: { watch_signals: [] } });
    const none = await analyzePhoto('b64', 'image/jpeg', { month: 1 });
    expect(flagged.composite).toEqual(none.composite);
  });
});

describe('previewTreeShrubAssessment', () => {
  const photos = [{ data: 'a' }, { data: 'b' }, { data: 'c' }];
  const loadImage = async (p) => ({ base64: p.data, mimeType: 'image/jpeg' });
  const composite = { ...SCORES };
  const analyzeWith = (perPhoto) => {
    let i = 0;
    return jest.fn(async () => ({ composite, watchSignals: perPhoto[i++] }));
  };

  test('gate off: analyze gets two arguments and the response has no watchSignals key', async () => {
    const analyze = analyzeWith([['scale'], [], ['whitefly']]);
    const result = await previewTreeShrubAssessment({ photos, loadImage, analyze, month: 10 });
    expect(analyze.mock.calls.every((call) => call.length === 2)).toBe(true);
    expect('watchSignals' in result).toBe(false);
  });

  test('gate on: the visit month goes to analyze and signals are unioned across photos in list order', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    const analyze = analyzeWith([['whitefly', 'made_up'], ['scale'], ['whitefly', 'trunk_conk_base']]);
    const result = await previewTreeShrubAssessment({ photos, loadImage, analyze, month: 10 });
    expect(analyze.mock.calls.every((call) => call[2] && call[2].month === 10)).toBe(true);
    expect(result.watchSignals).toEqual(['scale', 'whitefly', 'trunk_conk_base']);
    expect(result.scoredCount).toBe(3);
  });

  test('gate on: scores and findings are the same with or without signals', async () => {
    const off = await previewTreeShrubAssessment({ photos, loadImage, analyze: analyzeWith([[], [], []]), month: 10 });
    process.env.GATE_TS_WATCH_LIST = 'true';
    const on = await previewTreeShrubAssessment({ photos, loadImage, analyze: analyzeWith([['scale'], ['scale'], ['scale']]), month: 10 });
    const { watchSignals, ...rest } = on;
    expect(watchSignals).toEqual(['scale']);
    expect(rest).toEqual(off);
  });

  test('gate on, no or bad month: no signals key and the two-argument call', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    const analyze = analyzeWith([['scale'], [], []]);
    const result = await previewTreeShrubAssessment({ photos, loadImage, analyze });
    expect(analyze.mock.calls.every((call) => call.length === 2)).toBe(true);
    expect('watchSignals' in result).toBe(false);
    expect(Object.keys(MONTHS)).toHaveLength(12);
  });
});

describe('route wiring', () => {
  test('assess-preview passes the visit month, read from the scheduled date', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-dispatch'), 'utf8');
    const start = src.indexOf("router.post('/:serviceId/tree-shrub/assess-preview'");
    const block = src.slice(start, src.indexOf("router.post('/:serviceId/rain-out'", start));
    expect(block).toContain("'id', 'service_type', 'scheduled_date'");
    expect(block).toContain("month: require('../services/tree-shrub-watch-items').visitWatchMonth(svc.scheduled_date),");
    expect(block).toContain("return res.json({ ...result, photosHash, status: 'complete' });");
  });
});
