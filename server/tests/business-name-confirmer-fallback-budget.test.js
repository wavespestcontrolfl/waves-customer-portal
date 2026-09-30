// #5146 r9 (P1): the company-extraction dispatchWithFallback call
// (business-name-confirmer.js extractCompanyNames) must reserve budget for
// the fallback. Without reserveFallbackBudget, an explicit timeoutMs hands
// the WHOLE remaining budget to the primary leg (runFallbackChain's
// `explicitBudget && !reserveFallbackBudget` branch) — a stalled primary can
// then consume the entire 30s CALL_TIMEOUT_MS and leave the fallback
// `timeout_budget_exhausted` for the exact outage it exists to survive.
//
// Unlike business-name-confirmer.test.js, this file does NOT mock
// services/llm/call — it exercises the real dispatcher (mocking only the
// OpenAI fetch transport and the Anthropic SDK client), the same way
// llm-call.test.js proves the shared mechanism, so the actual budget split
// this caller now gets is proven end to end.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const { extractCompanyNames } = require('../services/content/business-name-confirmer');

const DRAFT = {
  title: 'Comparing Termite Plans in Sarasota',
  frontmatter: { slug: '/pest-control/hulett-alternatives/' },
  body: 'Compare plans before you switch.',
};

describe('extractCompanyNames — fallback budget reservation (#5146 r9)', () => {
  let originalFetch;
  let savedKeys;

  beforeEach(() => {
    savedKeys = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-key';
    originalFetch = global.fetch;
    mockAnthropicCreate.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of [['ANTHROPIC_API_KEY', savedKeys.anthropic], ['OPENAI_API_KEY', savedKeys.openai]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  test('a primary that stalls for its whole leg still leaves the fallback a positive, bounded share of the 30s budget', async () => {
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    // Primary (OpenAI) "stalls" — consumes its ENTIRE allotted per-leg share
    // before failing, exactly what a real stalled provider does once its own
    // adapter-level abort (AbortSignal timeoutMs) cuts it off.
    global.fetch = jest.fn().mockImplementation(async () => {
      now += 15000;
      return { ok: false, status: 529 };
    });
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ companies: ['Orkin'] }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await extractCompanyNames(DRAFT);

    expect(result).toMatchObject({ ok: true, companies: ['Orkin'] });
    // The fallback was actually called — not skipped as
    // timeout_budget_exhausted — with a POSITIVE, bounded timeout: reserved
    // budget, never the full 30s CALL_TIMEOUT_MS an unreserved chain would
    // have handed it after the stalled primary had already spent 15s of it.
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    const anthropicOpts = mockAnthropicCreate.mock.calls.at(-1)[1];
    expect(anthropicOpts.timeout).toBeGreaterThan(0);
    expect(anthropicOpts.timeout).toBeLessThanOrEqual(15000);
  });

  test('the same scenario WITHOUT reservation would starve the fallback (regression guard on the raw dispatcher)', async () => {
    // Pins the pre-fix failure mode this caller used to be exposed to: the
    // same stalled-for-its-whole-share primary, but with
    // reserveFallbackBudget left off (an explicit timeoutMs hands the
    // primary the FULL remaining budget instead of a reserved share) —
    // the fallback is never even reached. Exercises the shared dispatcher
    // directly (not extractCompanyNames, which now always reserves) so a
    // future change to call.js's default can't silently re-break this
    // caller without also breaking this guard.
    const { dispatchWithFallback } = require('../services/llm/call');
    const MODELS = require('../config/models');
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    global.fetch = jest.fn().mockImplementation(async () => {
      now += 30000; // an unreserved leg is handed, and spends, the WHOLE budget
      return { ok: false, status: 529 };
    });

    const result = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
      system: 's', text: 't', jsonMode: true, timeoutMs: 30000,
    });

    expect(result).toMatchObject({
      ok: false,
      failures: [
        expect.objectContaining({ reason: 'openai_529' }),
        expect.objectContaining({ reason: 'timeout_budget_exhausted' }),
      ],
    });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });
});
