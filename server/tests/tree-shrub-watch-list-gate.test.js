// GATE_TS_WATCH_LIST on the T&S photo read: the watch list is NEVER in the main
// read's prompt (that read writes the observations customer copy uses). Watch
// signals come from a SEPARATE read through the shared LLM dispatcher
// (TEXT_POLICIES.treeShrubWatchSignals) that asks only for keys; its failure can
// never fail or change the main read; gate off = exactly one call, byte-
// identical. Synthetic data.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));
// The watch read rides the shared dispatcher; the main read still uses its own fetch.
const mockDispatchWithFallback = jest.fn();
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  dispatchWithFallback: (...args) => mockDispatchWithFallback(...args),
}));

const gates = require('../config/feature-gates');
const MODELS = require('../config/models');
const logger = require('../services/logger');
const {
  VISION_PROMPT, visionPromptText, analyzePhoto, previewTreeShrubAssessment, isValidTreeShrubScores,
} = require('../services/tree-shrub-assessment');
const { ITEMS, watchListPromptBlock, MONTHS } = require('../config/tree-shrub-watch-list');
const { PALM_CROWN_PROMPT_RULE } = require('../services/service-report/tree-shrub-tech-findings');

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
const promptOf = (call) => JSON.parse(call[1].body).contents[0].parts[1].text;
// The MAIN read's transport: global.fetch (the watch read never uses it).
function serveMain(main = SCORES) {
  global.fetch = jest.fn(async () => geminiResponse(main));
}
// The watch read's transport: the shared dispatcher, one answer per call.
const watchAnswer = (json) => ({ ok: true, json, provider: 'gemini', model: 'gemini-3.6-flash' });
function serveWatch(answer = watchAnswer({ watch_signals: [] })) {
  mockDispatchWithFallback.mockReset();
  mockDispatchWithFallback.mockImplementation(async () => {
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer;
  });
}
const serve = ({ main = SCORES, watch } = {}) => { serveMain(main); serveWatch(watch); };

const saved = {};
beforeEach(() => {
  jest.clearAllMocks();
  serveWatch();
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
  test('gate off with a month: one main call, the plain prompt, no dispatch, no watchSignals key', async () => {
    serve();
    const withMonth = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(promptOf(global.fetch.mock.calls[0])).toBe(VISION_PROMPT);
    expect(mockDispatchWithFallback).not.toHaveBeenCalled();
    serve();
    const noMonth = await analyzePhoto('b64', 'image/jpeg');
    expect(withMonth).toEqual(noMonth);
    expect(Object.keys(withMonth).sort()).toEqual(['claude', 'composite', 'divergenceFlags', 'gemini']);
  });
  test('gate on, no or bad month: one main call, no dispatch, no watchSignals key (every existing caller unchanged)', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    for (const options of [undefined, {}, { month: 0 }, { month: 13 }, { month: 'x' }]) {
      serve();
      const result = await analyzePhoto('b64', 'image/jpeg', options);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mockDispatchWithFallback).not.toHaveBeenCalled();
      expect('watchSignals' in result).toBe(false);
    }
  });
});

describe('analyzePhoto: gate on with a valid month', () => {
  beforeEach(() => { process.env.GATE_TS_WATCH_LIST = 'true'; });

  test('per photo: one main fetch and one dispatch', async () => {
    serve({ watch: watchAnswer({ watch_signals: ['scale'] }) });
    await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockDispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('the two reads run in parallel: the watch read starts before the main read answers', async () => {
    let releaseMain;
    global.fetch = jest.fn(() => new Promise((resolve) => { releaseMain = () => resolve(geminiResponse(SCORES)); }));
    const pending = analyzePhoto('b64', 'image/jpeg', { month: 10 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockDispatchWithFallback).toHaveBeenCalledTimes(1);
    releaseMain();
    expect((await pending).watchSignals).toEqual([]);
  });

  test('the main call is byte-identical to the gate-off call: same prompt, same request body', async () => {
    serve({ watch: watchAnswer({ watch_signals: ['scale'] }) });
    await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    const gateOnMain = global.fetch.mock.calls[0];
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
    for (const month of [1, 5, 10, 12]) {
      serve();
      await analyzePhoto('b64', 'image/jpeg', { month });
      const prompt = promptOf(global.fetch.mock.calls[0]);
      expect(prompt).not.toMatch(/watch.?list|watch_signals/i);
      for (const key of Object.keys(ITEMS)) expect(prompt).not.toContain(`- ${key}:`);
    }
  });

  test('the watch read uses the treeShrubWatchSignals policy: Gemini first, OpenAI on a miss, no Claude', async () => {
    serve();
    await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    const [policy] = mockDispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.treeShrubWatchSignals);
    expect(policy.name).toBe('treeShrubWatchSignals');
    expect(policy.primary).toEqual({ provider: 'gemini', model: MODELS.GEMINI_PHOTO_ID_PLANT });
    expect(policy.fallback).toEqual({ provider: 'openai', model: MODELS.OPENAI_PLANT_ID });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  test('the watch payload asks only for keys: the month block, one image, no observations, no scores', async () => {
    serve();
    await analyzePhoto('b64', 'image/png', { month: 10 });
    const [, payload, options] = mockDispatchWithFallback.mock.calls[0];
    expect(payload.text).toBe(watchListPromptBlock(10));
    expect(payload.system).toBeUndefined();
    expect(payload.images).toEqual([{ data: 'b64', mimeType: 'image/png' }]);
    expect(payload.jsonMode).toBe(true);
    expect(payload.laneId).toBe('ts_watch_signals');
    expect(payload.maxTokens).toBeLessThanOrEqual(1024);
    expect(payload.text).toContain('- scale: Possible scale');
    expect(payload.text).toContain('{"watch_signals": ["<watch-list key>"]}');
    for (const field of ['foliage_fullness', 'leaf_color_vigor', 'pest_signals', 'disease_signals', 'water_heat_stress', 'pruning_mechanical', '"observations"']) {
      expect(payload.text).not.toContain(field);
    }
    expect(payload.text).toMatch(/no scores, no observations/);
    // bounded at 20 s from both sides, shared across the two legs
    expect(payload.timeoutMs).toBe(20000);
    expect(options.hardDeadline).toBe(true);
    expect(options.reserveFallbackBudget).toBe(true);
  });

  test('known signals come back in list order, duplicates once', async () => {
    serve({ watch: watchAnswer({ watch_signals: ['whitefly', 'scale', 'scale', 'trunk_conk_base'] }) });
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    // October: scale, whitefly, root_rot, bed_weeds, then year-round.
    expect(result.watchSignals).toEqual(['scale', 'whitefly', 'trunk_conk_base']);
  });

  test('an empty array is a real "nothing flagged" ([]), distinct from no read', async () => {
    serve({ watch: watchAnswer({ watch_signals: [] }) });
    expect((await analyzePhoto('b64', 'image/jpeg', { month: 10 })).watchSignals).toEqual([]);
  });

  const NONCONFORMING = ['scale', 5, { 0: 'scale' }, [null, {}, []], ['scale insect'], ['scale', 'made_up'], ['spider_mites'], true, null];

  test('a missing or malformed array, or any entry off the month list, is no read (null); the main read is unchanged', async () => {
    serve();
    const clean = await analyzePhoto('b64', 'image/jpeg', { month: 4 });
    expect(clean.watchSignals).toEqual([]);
    for (const bad of NONCONFORMING) {
      serve({ watch: watchAnswer({ watch_signals: bad }) });
      const result = await analyzePhoto('b64', 'image/jpeg', { month: 4 });
      expect(result.watchSignals).toBeNull();
      expect(result.composite).toEqual(clean.composite);
    }
    serve({ watch: watchAnswer({ something_else: ['scale'] }) });
    expect((await analyzePhoto('b64', 'image/jpeg', { month: 4 })).watchSignals).toBeNull();
  });

  test('the chain validator rejects a nonconforming answer so the next leg gets its turn, and accepts a conforming one', async () => {
    serve();
    await analyzePhoto('b64', 'image/jpeg', { month: 4 });
    const { validate } = mockDispatchWithFallback.mock.calls[0][2];
    for (const bad of NONCONFORMING) expect(validate({ ok: true, json: { watch_signals: bad } })).toBe('schema_invalid:watch_signals');
    expect(validate({ ok: true, json: null })).toBe('schema_invalid:watch_signals');
    expect(validate({ ok: true, json: { watch_signals: ['scale', 'caterpillars'] } })).toBeNull();
    expect(validate({ ok: true, json: { watch_signals: [] } })).toBeNull();
  });

  test.each([
    ['a failed dispatch (every leg missed)', () => ({ ok: false, reason: 'all_providers_failed', failures: [] })],
    ['a dispatch that throws', new Error('dispatcher blew up')],
    ['a dispatch that rejects later', () => Promise.reject(new Error('late failure'))],
    ['an answer with no body', () => ({ ok: true })],
    ['no response at all', () => undefined],
  ])('%s: no watch read (null), the main read unchanged, warned', async (_name, watch) => {
    serve();
    const reference = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    serve({ watch });
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(result).not.toBeNull();
    expect(result.watchSignals).toBeNull();
    expect(result.composite).toEqual(reference.composite);
    expect(result.gemini).toEqual(reference.gemini);
    expect(result.claude).toBeNull();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('a dispatch that never resolves hits the hard deadline: the main read still answers, no watch read', async () => {
    jest.useFakeTimers();
    try {
      serve({ watch: () => new Promise(() => {}) });
      const pending = analyzePhoto('b64', 'image/jpeg', { month: 10 });
      let settled = false;
      pending.then(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(20000);
      expect(settled).toBe(false); // the bound is 20 s plus a short grace, never earlier
      await jest.advanceTimersByTimeAsync(2000);
      const result = await pending;
      expect(result.watchSignals).toBeNull();
      expect(result.gemini).toMatchObject({ foliage_fullness: SCORES.foliage_fullness });
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a main read that is invalid still fails over to Claude, which is never given the watch list', async () => {
    serve({
      main: { ...SCORES, foliage_fullness: 250 },
      watch: watchAnswer({ watch_signals: ['scale'] }),
    });
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(SCORES) }] });
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCreate.mock.calls[0][0].messages[0].content[1].text).toBe(VISION_PROMPT);
    expect(result.watchSignals).toEqual(['scale']);
  });

  test('a main read that cannot be had is null, as today, whatever the watch read says', async () => {
    serve({ main: { garbage: true }, watch: watchAnswer({ watch_signals: ['scale'] }) });
    mockAnthropicCreate.mockResolvedValue(null);
    expect(await analyzePhoto('b64', 'image/jpeg', { month: 10 })).toBeNull();
  });

  test('a stray watch_signals field in the MAIN reply changes nothing and is not the source of signals', async () => {
    serve({ main: { ...SCORES, watch_signals: ['scale', 'sooty_mold'] }, watch: watchAnswer({ watch_signals: ['whitefly'] }) });
    const stray = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    delete process.env.GATE_TS_WATCH_LIST;
    serve({ main: { ...SCORES, watch_signals: ['scale', 'sooty_mold'] } });
    const off = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(stray.watchSignals).toEqual(['whitefly']);
    expect(stray.composite).toEqual(off.composite);
    expect(isValidTreeShrubScores(stray.gemini)).toBe(true);
  });

  test('a watch-list item the watch read names never reaches the observations', async () => {
    serve({
      watch: watchAnswer({ watch_signals: ['root_rot', 'trunk_conk_base', 'scale'], observations: 'Root rot and trunk conk everywhere.', note: 'root rot' }),
    });
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(result.watchSignals).toEqual(['scale', 'root_rot', 'trunk_conk_base']);
    expect(result.composite.observations).toBe(SCORES.observations);
    expect(result.composite.observations).not.toMatch(/root rot|trunk conk/i);
    expect(JSON.stringify(result.composite)).not.toMatch(/root_rot|trunk_conk_base/);
    expect(JSON.stringify(result)).not.toContain('everywhere');
  });

  test('scores are the same with or without signals', async () => {
    serve({ watch: watchAnswer({ watch_signals: ['scale', 'sooty_mold'] }) });
    const flagged = await analyzePhoto('b64', 'image/jpeg', { month: 1 });
    serve({ watch: watchAnswer({ watch_signals: [] }) });
    const none = await analyzePhoto('b64', 'image/jpeg', { month: 1 });
    expect(flagged.composite).toEqual(none.composite);
  });
});

describe('the policy is registered', () => {
  test('models, switchboard and agent-control all know the lane', () => {
    const switchboard = require('../services/model-switchboard');
    expect(MODELS.TEXT_POLICIES.treeShrubWatchSignals.name).toBe('treeShrubWatchSignals');
    const src = require('fs').readFileSync(require.resolve('../services/model-switchboard'), 'utf8');
    expect(src).toContain("treeShrubWatchSignals: { primary: 'GEMINI_PHOTO_ID_PLANT', fallback: 'OPENAI_PLANT_ID' },");
    expect(src).toContain("L('ts_watch_signals'");
    const { LANE_RUNTIME } = require('../services/agent-control/lane-policies');
    expect(LANE_RUNTIME.ts_watch_signals).toMatchObject({ ledger: 'call', side_effect_class: 'draft_for_human' });
    expect(switchboard).toBeTruthy();
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
    const { watchSignals, watchSignalsComplete, ...rest } = on;
    expect(watchSignals).toEqual(['scale']);
    expect(watchSignalsComplete).toBe(true);
    expect(rest).toEqual(off);
  });

  test('gate on: one failed watch read marks the result incomplete, never a clean []', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    const result = await previewTreeShrubAssessment({ photos, loadImage, analyze: analyzeWith([['scale'], null, []]), month: 10 });
    expect(result.watchSignals).toEqual(['scale']);
    expect(result.watchSignalsComplete).toBe(false);
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
    // Only a caller that shows the list (the Fast Complete sheet) gets the watch read.
    expect(block).toMatch(/month: req\.body\?\.watchList === true\s+\? require\('\.\.\/services\/tree-shrub-watch-items'\)\.visitWatchMonth\(svc\.scheduled_date\)\s+: null,/);
    expect(block).toContain("return res.json({ ...result, photosHash, status: 'complete' });");
  });
});
