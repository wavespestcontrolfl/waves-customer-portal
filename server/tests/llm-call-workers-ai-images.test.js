// callWorkersAIDecision with `images` (Clef takes up to 4 embedded photos).
// Global fetch is mocked; no live calls. Image strings are synthetic bytes
// behind a data-URL prefix: the adapter checks shape, count and total size.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockRecordCall = jest.fn(() => 77);
const mockRecordTrace = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, recordCall: (...a) => mockRecordCall(...a), recordTrace: (...a) => mockRecordTrace(...a), recordDispatch: jest.fn() };
});

const crypto = require('crypto');
const { callWorkersAIDecision, dispatch, CLEF_MAX_IMAGES, CLEF_IMAGES_BUDGET_BYTES } = require('../services/llm/call');
const { ROUTES } = require('../config/models');

const QUESTIONS = { clear: { type: 'noul', instructions: 'Is the photo clear?' } };
const STATE = { note: 'synthetic state' };
const ENVELOPE = { result: { model: 'clef-flash', answers: { clear: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1200, output_tokens: 0 } }, success: true, errors: [] };
const okResponse = () => ({ ok: true, status: 200, json: async () => ENVELOPE });

const rawBytes = (n, fill) => Buffer.alloc(n, fill);
const urlOf = (bytes) => `data:image/jpeg;base64,${bytes.toString('base64')}`;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('callWorkersAIDecision images', () => {
  const originalFetch = global.fetch;
  const saved = { token: process.env.CF_WORKERS_AI_TOKEN, account: process.env.CF_ACCOUNT_ID };
  beforeEach(() => {
    process.env.CF_WORKERS_AI_TOKEN = 'wai-token';
    process.env.CF_ACCOUNT_ID = 'acct123';
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    mockRecordCall.mockClear();
    mockRecordTrace.mockClear();
  });
  afterAll(() => {
    global.fetch = originalFetch;
    if (saved.token === undefined) delete process.env.CF_WORKERS_AI_TOKEN; else process.env.CF_WORKERS_AI_TOKEN = saved.token;
    if (saved.account === undefined) delete process.env.CF_ACCOUNT_ID; else process.env.CF_ACCOUNT_ID = saved.account;
  });

  test('the limits are 4 images and 150 KB', () => {
    expect(CLEF_MAX_IMAGES).toBe(4);
    expect(CLEF_IMAGES_BUDGET_BYTES).toBe(150 * 1024);
  });

  test.each([[undefined], [null], [[]]])('no images (%j): the body is exactly { state, questions } with no images key', async (images) => {
    const result = await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, images });
    expect(result.ok).toBe(true);
    const body = global.fetch.mock.calls[0][1].body;
    expect(JSON.parse(body)).toEqual({ state: STATE, questions: QUESTIONS });
    expect(Object.keys(JSON.parse(body))).toEqual(['state', 'questions']);
    // ledger text is the state alone, as before
    expect(mockRecordTrace).toHaveBeenCalledWith(77, expect.objectContaining({ prompt: JSON.stringify(STATE) }));
  });

  test('with images the body carries them beside state and questions', async () => {
    const a = rawBytes(2000, 1);
    const b = rawBytes(3000, 2);
    const images = [urlOf(a), urlOf(b)];
    const result = await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, images });
    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ images, state: STATE, questions: QUESTIONS });
  });

  test('the ledger text never holds image bytes: a count and the sha256 of each image stand in', async () => {
    const a = rawBytes(2000, 7);
    const b = rawBytes(2500, 9);
    const images = [urlOf(a), urlOf(b)];
    await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, images, laneId: 'typed_decisions_clef' });
    const trace = mockRecordTrace.mock.calls[0][1];
    expect(trace.prompt).toBe(`${JSON.stringify(STATE)}\n[images: 2, sha256 ${sha(a)},${sha(b)}]`);
    expect(trace.prompt).not.toContain(a.toString('base64').slice(0, 40));
    // nothing else handed to the ledger carries the payload either
    expect(JSON.stringify(mockRecordCall.mock.calls)).not.toContain(a.toString('base64').slice(0, 40));
  });

  test('more than four images fails the leg before any network call, and is ledgered without bytes', async () => {
    const one = urlOf(rawBytes(100, 3));
    const result = await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, images: [one, one, one, one, one] });
    expect(result).toEqual({ ok: false, reason: 'cloudflare_images_too_large' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockRecordCall.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'cloudflare_images_too_large', provider: 'cloudflare' });
    expect(mockRecordTrace.mock.calls[0][1].prompt).toContain('[images: 5,');
    expect(mockRecordTrace.mock.calls[0][1].prompt).not.toContain(one.slice(23, 60));
  });

  test('a total over 150 KB fails the leg before any network call; exactly at the limit is sent', async () => {
    const over = urlOf(rawBytes(120 * 1024, 4));
    expect(over.length).toBeGreaterThan(CLEF_IMAGES_BUDGET_BYTES);
    expect(await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, images: [over] })).toEqual({ ok: false, reason: 'cloudflare_images_too_large' });
    const two = [urlOf(rawBytes(60 * 1024, 5)), urlOf(rawBytes(60 * 1024, 6))];
    expect(two[0].length + two[1].length).toBeGreaterThan(CLEF_IMAGES_BUDGET_BYTES);
    expect(await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, images: two })).toMatchObject({ ok: false, reason: 'cloudflare_images_too_large' });
    expect(global.fetch).not.toHaveBeenCalled();

    // The limit is the SERIALIZED body: images + state + questions.
    const prefix = 'data:image/jpeg;base64,';
    const overhead = JSON.stringify({ images: [prefix], state: STATE, questions: QUESTIONS }).length;
    const fits = `${prefix}${'A'.repeat(Math.floor((CLEF_IMAGES_BUDGET_BYTES - overhead) / 4) * 4)}`;
    expect(JSON.stringify({ images: [fits], state: STATE, questions: QUESTIONS }).length).toBeLessThanOrEqual(CLEF_IMAGES_BUDGET_BYTES);
    expect((await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, images: [fits] })).ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].body.length).toBeLessThanOrEqual(CLEF_IMAGES_BUDGET_BYTES);
  });

  test('the state counts toward the limit: images that fit alone are refused beside a large state', async () => {
    const image = urlOf(rawBytes(90 * 1024, 7));
    expect((await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, images: [image] })).ok).toBe(true);
    const bigState = { note: 'x'.repeat(40 * 1024) };
    expect(await callWorkersAIDecision({ model: 'clef-flash', state: bigState, questions: QUESTIONS, images: [image] })).toEqual({ ok: false, reason: 'cloudflare_images_too_large' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('entries that are not image data URLs, or a non-array, are refused before any network call', async () => {
    for (const images of ['data:image/jpeg;base64,AAAA', ['https://example.test/a.jpg'], [42], ['data:text/plain;base64,AAAA'], ['data:image/jpeg;base64,not base64!'], ['data:image/jpeg;base64,A'], ['data:image/jpeg;base64,AA='], ['data:image/jpeg;base64,AB==']]) {
      expect(await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, images })).toEqual({ ok: false, reason: 'cloudflare_bad_images' });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('dispatch threads images to the Clef route; the TypeSafe route refuses them', async () => {
    const images = [urlOf(rawBytes(500, 8))];
    const ok = await dispatch(ROUTES.typedDecisionClef, { state: STATE, questions: QUESTIONS, images });
    expect(ok.ok).toBe(true);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).images).toEqual(images);
    global.fetch.mockClear();
    process.env.TYPESAFE_API_KEY = 'ts-key';
    expect(await dispatch(ROUTES.typedDecision, { state: STATE, questions: QUESTIONS, images })).toEqual({ ok: false, reason: 'typesafe_no_images' });
    expect(global.fetch).not.toHaveBeenCalled();
    delete process.env.TYPESAFE_API_KEY;
  });
});
