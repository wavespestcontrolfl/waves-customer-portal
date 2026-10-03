// GATE_TS_WATCH_LIST on the T&S photo read: the prompt gains this month's watch
// list and asks for an OPTIONAL watch_signals; parsing is tolerant and never
// moves a score or fails a valid read; gate off = byte-identical. Synthetic data.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const gates = require('../config/feature-gates');
const {
  VISION_PROMPT, visionPromptText, analyzePhoto, previewTreeShrubAssessment, isValidTreeShrubScores,
} = require('../services/tree-shrub-assessment');
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
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }),
});
const sentPrompt = () => JSON.parse(global.fetch.mock.calls[0][1].body).contents[0].parts[1].text;

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

describe('the prompt', () => {
  test('gate off: byte-identical to today, month or not', () => {
    expect(visionPromptText()).toBe(VISION_PROMPT);
    expect(visionPromptText(3)).toBe(VISION_PROMPT);
    expect(VISION_PROMPT).not.toContain('watch list');
    expect(VISION_PROMPT).not.toContain('watch_signals');
  });
  test('gate off with the tech-findings gate on: still exactly the tech-findings prompt', () => {
    process.env.GATE_TS_TECH_FINDINGS_COPY = 'true';
    const marker = 'Return this exact JSON structure';
    const expected = VISION_PROMPT.replace(marker, `${PALM_CROWN_PROMPT_RULE} In "observations", never call a palm's crown, spear leaf or newest fronds healthy, fine or normal; if only the crown is in view, say it is not clearly visible.\n\n${marker}`);
    expect(visionPromptText(3)).toBe(expected);
  });
  test('gate on with no valid month: the same prompt as gate off', () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    expect(visionPromptText()).toBe(VISION_PROMPT);
    expect(visionPromptText(0)).toBe(VISION_PROMPT);
    expect(visionPromptText(13)).toBe(VISION_PROMPT);
  });
  test('gate on: the month block sits before the JSON instruction and the JSON gains watch_signals', () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    const prompt = visionPromptText(10);
    const block = watchListPromptBlock(10);
    expect(prompt).toContain(block);
    expect(prompt.indexOf(block)).toBeLessThan(prompt.indexOf('Return this exact JSON structure'));
    expect(prompt).toMatch(/"watch_signals": \["<watch-list key>"\]\n\}$/);
    // everything else is the original prompt
    expect(prompt.replace(`${block}\n\n`, '').replace(',\n  "watch_signals": ["<watch-list key>"]', '')).toBe(VISION_PROMPT);
  });
  test('gate on beside the tech-findings gate: both additions, in order', () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    process.env.GATE_TS_TECH_FINDINGS_COPY = 'true';
    const prompt = visionPromptText(10);
    expect(prompt).toContain('PHOTO REACH');
    expect(prompt).toContain("This month's watch list");
    expect(prompt.indexOf('PHOTO REACH')).toBeLessThan(prompt.indexOf("This month's watch list"));
    expect(prompt.match(/Return this exact JSON structure/g)).toHaveLength(1);
  });
  test('the optional field is not part of the validated schema', () => {
    expect(isValidTreeShrubScores({ ...SCORES })).toBe(true);
    expect(isValidTreeShrubScores({ ...SCORES, watch_signals: 'garbage' })).toBe(true);
    expect(isValidTreeShrubScores({ ...SCORES, watch_signals: ['scale'], foliage_fullness: 250 })).toBe(false);
  });
});

describe('analyzePhoto', () => {
  test('gate off with a month: the request and the result are exactly what they are with no month', async () => {
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...SCORES, watch_signals: ['scale'] }));
    const withMonth = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    const promptWithMonth = sentPrompt();
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...SCORES, watch_signals: ['scale'] }));
    const noMonth = await analyzePhoto('b64', 'image/jpeg');
    expect(promptWithMonth).toBe(VISION_PROMPT);
    expect(sentPrompt()).toBe(VISION_PROMPT);
    expect(withMonth).toEqual(noMonth);
    expect(Object.keys(withMonth).sort()).toEqual(['claude', 'composite', 'divergenceFlags', 'gemini']);
  });

  test('gate on: the prompt carries the block and the result carries known signals in list order', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({
      ...SCORES, watch_signals: ['whitefly', 'scale', 'scale', 'made_up', 7, 'trunk_conk_base', 'aphids'],
    }));
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(sentPrompt()).toBe(visionPromptText(10));
    expect(sentPrompt()).toContain(watchListPromptBlock(10));
    // October list: scale, whitefly, root_rot, bed_weeds, then year-round. aphids is not on it.
    expect(result.watchSignals).toEqual(['scale', 'whitefly', 'trunk_conk_base']);
    // the raw field never rides into the composite that gets stored
    expect(result.composite.watch_signals).toBeUndefined();
    expect(result.gemini.watch_signals).toBeUndefined();
  });

  test('gate on: a missing or malformed field is [] and the read still stands, scores unchanged', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...SCORES }));
    const clean = await analyzePhoto('b64', 'image/jpeg', { month: 4 });
    expect(clean.watchSignals).toEqual([]);
    for (const bad of ['scale', 5, { 0: 'scale' }, [null, {}, []], true]) {
      global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...SCORES, watch_signals: bad }));
      const result = await analyzePhoto('b64', 'image/jpeg', { month: 4 });
      expect(result).not.toBeNull();
      expect(result.watchSignals).toEqual([]);
      expect(result.composite).toEqual(clean.composite);
    }
  });

  test('gate on: signals never change a score', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...SCORES, watch_signals: ['scale', 'sooty_mold'] }));
    const flagged = await analyzePhoto('b64', 'image/jpeg', { month: 1 });
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...SCORES }));
    const none = await analyzePhoto('b64', 'image/jpeg', { month: 1 });
    expect(flagged.composite).toEqual(none.composite);
  });

  test('gate on: an invalid read still fails over to Claude exactly as before, and the fallback is read for signals too', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...SCORES, foliage_fullness: 250, watch_signals: ['scale'] }));
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ ...SCORES, watch_signals: ['whitefly'] }) }] });
    const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCreate.mock.calls[0][0].messages[0].content[1].text).toContain(watchListPromptBlock(10));
    expect(result.watchSignals).toEqual(['whitefly']);
  });

  test('gate on, no month passed: no block, no watchSignals key (every existing caller unchanged)', async () => {
    process.env.GATE_TS_WATCH_LIST = 'true';
    global.fetch = jest.fn().mockResolvedValue(geminiResponse({ ...SCORES }));
    const result = await analyzePhoto('b64', 'image/jpeg');
    expect(sentPrompt()).toBe(VISION_PROMPT);
    expect('watchSignals' in result).toBe(false);
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
