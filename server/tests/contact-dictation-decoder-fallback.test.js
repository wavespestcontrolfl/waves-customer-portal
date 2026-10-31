// GATE_CALL_EMAIL_CHECKS (owner 2026-10-29): the contact dictation decoder no
// longer depends on Gemini alone. With the gate on it walks the shared
// fallback chain (Gemini, then the OpenAI extraction model); when every model
// fails it logs that and writes one engineering row a day to the Activity
// feed. With the gate off the old single Gemini call runs, and a failed
// request is now logged instead of silent. Synthetic transcript.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ ok: true })) }));

const logger = require('../services/logger');
const { dispatchWithFallback } = require('../services/llm/call');
const { deliverOpsDigest } = require('../services/ops-digest');
const { decodeDictatedContacts } = require('../services/contact-dictation');

const TRANSCRIPT = 'Agent: And a good email? Caller: B-R-I-G-H-T-O-N at gmail dot com.';
const DECODED = {
  emails: [{ raw_spoken: 'B-R-I-G-H-T-O-N at gmail dot com', candidates: [{ value: 'brighton@gmail.com', confidence: 0.97 }] }],
  addresses: [],
  names: [],
};

let fetchSpy;
beforeEach(() => {
  jest.clearAllMocks();
  fetchSpy = jest.spyOn(global, 'fetch');
  process.env.GEMINI_API_KEY = 'test-key';
});
afterEach(() => {
  fetchSpy.mockRestore();
  delete process.env.GATE_CALL_EMAIL_CHECKS;
  delete process.env.GEMINI_API_KEY;
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_CALL_EMAIL_CHECKS = 'true'; });

  test('decodes through the fallback chain: Gemini first, the OpenAI extraction model second', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: DECODED });
    const out = await decodeDictatedContacts({ transcript: TRANSCRIPT });
    expect(out.emails[0].candidates[0].value).toBe('brighton@gmail.com');
    expect(fetchSpy).not.toHaveBeenCalled();
    const [route, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(route.primary).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-pro' });
    expect(route.fallback.provider).toBe('openai');
    expect(payload).toMatchObject({ jsonMode: true, temperature: 0 });
    // The chain reads its budget from the payload (llm/call.js runFallbackChain),
    // split across the two legs: each keeps the old 180 s single-call limit.
    const single = Number(process.env.CALL_PROC_EXTRACT_TIMEOUT_MS) > 0 ? Number(process.env.CALL_PROC_EXTRACT_TIMEOUT_MS) : 180000;
    expect(payload.timeoutMs).toBe(2 * single);
    expect(options.timeoutMs).toBeUndefined();
    expect(options.reserveFallbackBudget).toBe(true);
    expect(options.validate({ json: { emails: [] } })).toBeNull();
    expect(options.validate({ json: { nothing: true } })).toBe('decoder_shape_invalid');
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('every model failed: a warning and one engineering row a day, and the call carries on with no decode', async () => {
    dispatchWithFallback.mockResolvedValue({
      ok: false,
      failures: [{ provider: 'gemini', reason: 'gemini_429' }, { provider: 'openai', reason: 'openai_timeout' }],
    });
    await expect(decodeDictatedContacts({ transcript: TRANSCRIPT })).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('gemini gemini_429, openai openai_timeout'));
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const digest = deliverOpsDigest.mock.calls[0][0];
    expect(digest).toMatchObject({ key: 'contact-decoder-down', audience: 'engineering', link: '/admin/communications' });
    expect(digest.dedupeKey).toMatch(/^contact-decoder-down:\d{4}-\d{2}-\d{2}$/);
    expect(digest.headline.length).toBeLessThanOrEqual(60);
    expect(digest.summary.length).toBeLessThanOrEqual(110);
  });

  test('a failed fault row never fails the call', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
    deliverOpsDigest.mockRejectedValueOnce(new Error('feed down'));
    await expect(decodeDictatedContacts({ transcript: TRANSCRIPT })).resolves.toBeNull();
  });
});

describe('gate off', () => {
  test('the old single Gemini call runs, and a refused request is logged', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await expect(decodeDictatedContacts({ transcript: TRANSCRIPT })).resolves.toBeNull();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0][0]).toContain('generativelanguage.googleapis.com');
    expect(fetchSpy.mock.calls[0][0]).not.toMatch(/[?&]key=/);
    expect(fetchSpy.mock.calls[0][1].headers['x-goog-api-key']).toBe('test-key');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('gemini 429'));
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('a working Gemini call decodes as before', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(DECODED) }] } }] }),
    });
    const out = await decodeDictatedContacts({ transcript: TRANSCRIPT });
    expect(out.emails[0].candidates[0].value).toBe('brighton@gmail.com');
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});
