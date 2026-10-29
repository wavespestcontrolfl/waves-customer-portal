// runPerception's OpenAI backup (owner 2026-10-29, "sure add it"). An Analyze
// photos test came back as the canned score composite while the AI Studio spend
// cap refused every Gemini call (429): the perception leg had no second model.
// This file locks in: Gemini still reads first with the same raw request; any
// Gemini miss hands the same photos to the lawn photo lane's OpenAI model
// through dispatch() under the lawn_diag_vision lane; the result names the model
// that really read the photos; both missing keeps Gemini's reason for the ladder.
process.env.GEMINI_API_KEY = 'test-gemini-key';

const mockDispatch = jest.fn();
const mockRejectCall = jest.fn();
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  dispatch: (...args) => mockDispatch(...args),
  rejectCall: (...args) => mockRejectCall(...args),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const MODELS = require('../config/models');
const { runPerception, LAWN_PIPELINE_MODELS } = require('../services/lawn-diagnostic-prompt');

const OBSERVATIONS = {
  observations: [{ area: 'front', location: 'sun', color: 'brown', pattern: 'irregular patch', distribution: 'one section', detail: 'granules on the blades', caveats: null }],
  overall_notes: 'One close photo of a brown patch.',
};
const photos = [{ data: 'ZmFrZQ==', mimeType: 'image/jpeg' }];

function geminiReply(json, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }),
  };
}

function backupReply(json) {
  return { ok: true, text: JSON.stringify(json), json, model: MODELS.OPENAI_LAWN_ASSESSMENT };
}

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});
afterAll(() => {
  global.fetch = realFetch;
});

describe('runPerception: Gemini first, OpenAI backup on any miss', () => {
  test('a Gemini read with observations never calls the backup', async () => {
    global.fetch.mockResolvedValue(geminiReply(OBSERVATIONS));
    const out = await runPerception({ photos, season: 'fall' });
    expect(out).toEqual({ ok: true, observations: OBSERVATIONS.observations, overall_notes: OBSERVATIONS.overall_notes, model: LAWN_PIPELINE_MODELS.vision });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('generativelanguage.googleapis.com');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a Gemini 429 (spend cap) hands the same photos to the lawn OpenAI model under lawn_diag_vision', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    mockDispatch.mockResolvedValue(backupReply(OBSERVATIONS));
    const out = await runPerception({ photos, season: 'fall' });
    expect(out).toEqual({
      ok: true,
      observations: OBSERVATIONS.observations,
      overall_notes: OBSERVATIONS.overall_notes,
      model: MODELS.OPENAI_LAWN_ASSESSMENT,
      primaryReason: 'gemini_429',
    });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [route, payload] = mockDispatch.mock.calls[0];
    expect(route).toEqual({ provider: MODELS.PROVIDER.OPENAI, model: MODELS.OPENAI_LAWN_ASSESSMENT });
    expect(payload).toMatchObject({ jsonMode: true, laneId: 'lawn_diag_vision', timeoutMs: 120000, maxTokens: 4096 });
    expect(payload.images).toEqual([{ data: 'ZmFrZQ==', mimeType: 'image/jpeg' }]);
    expect(payload.text).toContain('Report ONLY what is visually present');
    expect(payload.text).toContain('1 attached photo(s). Season: fall.');
    expect(mockRejectCall).not.toHaveBeenCalled();
  });

  test('a Gemini reply without observations and a thrown Gemini request both reach the backup', async () => {
    global.fetch.mockResolvedValueOnce(geminiReply({ observations: [] }));
    mockDispatch.mockResolvedValue(backupReply(OBSERVATIONS));
    const empty = await runPerception({ photos });
    expect(empty).toMatchObject({ ok: true, model: MODELS.OPENAI_LAWN_ASSESSMENT, primaryReason: 'no_observations' });

    global.fetch.mockRejectedValueOnce(new Error('socket hang up'));
    const thrown = await runPerception({ photos });
    expect(thrown).toMatchObject({ ok: true, model: MODELS.OPENAI_LAWN_ASSESSMENT, primaryReason: 'error' });
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  test('both missing keeps Gemini\'s reason (the ladder\'s fallback_reason) and reports the backup\'s', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    mockDispatch.mockResolvedValue({ ok: false, reason: 'openai_500' });
    const out = await runPerception({ photos });
    expect(out).toEqual({ ok: false, reason: 'gemini_429', backupReason: 'openai_500' });
  });

  test('a thrown backup dispatch is a missed read, never a thrown runPerception', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    mockDispatch.mockRejectedValue(new Error('adapter blew up'));
    await expect(runPerception({ photos })).resolves.toEqual({ ok: false, reason: 'gemini_429', backupReason: 'error' });
  });

  test('a backup answer with no observations fails its recorded row and the read', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const reply = backupReply({ observations: [], overall_notes: 'nothing to see' });
    mockDispatch.mockResolvedValue(reply);
    const out = await runPerception({ photos });
    expect(out).toEqual({ ok: false, reason: 'gemini_429', backupReason: 'no_observations' });
    expect(mockRejectCall).toHaveBeenCalledWith(reply, 'no_observations');
  });

  test('the backup gets the same capped photo set Gemini gets', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ data: `cGhvdG8${i}`, mimeType: i % 2 ? 'image/png' : undefined }));
    global.fetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    mockDispatch.mockResolvedValue(backupReply(OBSERVATIONS));
    await runPerception({ photos: six });
    const geminiBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const geminiImages = geminiBody.contents[0].parts.filter((part) => part.inline_data);
    const backupImages = mockDispatch.mock.calls[0][1].images;
    expect(backupImages).toHaveLength(geminiImages.length);
    expect(backupImages.map((img) => img.mimeType)).toEqual(geminiImages.map((part) => part.inline_data.mime_type));
  });

  test('no photos: no request to either provider', async () => {
    const out = await runPerception({ photos: [{ mimeType: 'image/jpeg' }] });
    expect(out).toEqual({ ok: false, reason: 'no_photos' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('runPerception without a Gemini key', () => {
  test('skips the Gemini request and reads with the backup', async () => {
    const saved = { gemini: process.env.GEMINI_API_KEY, google: process.env.GOOGLE_API_KEY };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      let isolated;
      jest.isolateModules(() => { isolated = require('../services/lawn-diagnostic-prompt'); });
      mockDispatch.mockResolvedValue(backupReply(OBSERVATIONS));
      const out = await isolated.runPerception({ photos });
      expect(out).toMatchObject({ ok: true, model: MODELS.OPENAI_LAWN_ASSESSMENT, primaryReason: 'no_gemini_key' });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      if (saved.gemini !== undefined) process.env.GEMINI_API_KEY = saved.gemini;
      if (saved.google !== undefined) process.env.GOOGLE_API_KEY = saved.google;
    }
  });
});
