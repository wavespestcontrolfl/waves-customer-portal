// GATE_TS_WATCH_LIST: the watch read through the REAL shared dispatcher chain
// (no mock of services/llm/call): Gemini answers; a nonconforming or missing
// Gemini answer hands the read to the OpenAI stand-in; both missing is no read.
// Only the network is faked. Synthetic data.
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GATE_TS_WATCH_LIST = 'true';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { analyzePhoto } = require('../services/tree-shrub-assessment');

const SCORES = {
  foliage_fullness: 70, leaf_color_vigor: 64,
  pest_signals: 'minor', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none',
  observations: 'Some thin foliage with scale-like bumps on a few leaves.',
};
const gemini = (body) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(body) }] } }] }),
});
const openai = (body) => ({
  ok: true,
  status: 200,
  json: async () => ({ id: 'resp_1', model: 'gpt-6-sol', status: 'completed', output_text: JSON.stringify(body) }),
});

// Main read: Gemini with the scores prompt. Watch read: Gemini or OpenAI with the watch prompt.
function serve({ geminiWatch, openaiWatch }) {
  global.fetch = jest.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('openai.com')) return openaiWatch();
    const text = body.contents[0].parts.map((p) => p.text || '').join('');
    return text.includes("This month's watch list") ? geminiWatch() : gemini(SCORES);
  });
}
const openaiCalls = () => global.fetch.mock.calls.filter(([url]) => String(url).includes('openai.com'));

afterAll(() => { delete process.env.GATE_TS_WATCH_LIST; });

test('Gemini answers: one watch call, no OpenAI', async () => {
  serve({ geminiWatch: () => gemini({ watch_signals: ['whitefly', 'scale'] }), openaiWatch: () => openai({ watch_signals: [] }) });
  const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
  expect(result.watchSignals).toEqual(['scale', 'whitefly']);
  expect(openaiCalls()).toHaveLength(0);
});

test('a nonconforming Gemini answer falls to OpenAI, whose conforming answer stands', async () => {
  serve({ geminiWatch: () => gemini({ watch_signals: ['scale', 'made_up'] }), openaiWatch: () => openai({ watch_signals: ['root_rot'] }) });
  const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
  expect(result.watchSignals).toEqual(['root_rot']);
  expect(openaiCalls()).toHaveLength(1);
  // the main read is the unchanged Gemini read
  expect(result.composite.observations).toBe(SCORES.observations);
});

test('a Gemini HTTP error falls to OpenAI', async () => {
  serve({ geminiWatch: () => ({ ok: false, status: 503, statusText: 'unavailable' }), openaiWatch: () => openai({ watch_signals: ['scale'] }) });
  expect((await analyzePhoto('b64', 'image/jpeg', { month: 10 })).watchSignals).toEqual(['scale']);
});

test('both legs missing is no read (null), and the main read still answers', async () => {
  serve({ geminiWatch: () => gemini({ nope: true }), openaiWatch: () => openai({ watch_signals: 'scale' }) });
  const result = await analyzePhoto('b64', 'image/jpeg', { month: 10 });
  expect(result.watchSignals).toBeNull();
  expect(result.gemini).toMatchObject({ foliage_fullness: SCORES.foliage_fullness });
});
