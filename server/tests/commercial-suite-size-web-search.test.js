/**
 * The web-search leg is DISPLAY ONLY (owner ruling on primary review of PR
 * #4840, AGENTS.md: an LLM proposes intent, never a price/size field) — it
 * finds a business name/type for the operator's notes, never a suite size.
 * Routed through the shared LLM dispatcher (server/services/llm/call.js
 * callAnthropic).
 */

jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  callAnthropic: jest.fn(),
}));

const { callAnthropic } = require('../services/llm/call');
const {
  acceptWebSearchResult,
  webSearchLegEnabled,
  resolveViaWebSearch,
  buildPrompt,
} = require('../services/commercial-suite-size/web-search-leg');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('webSearchLegEnabled (COMMERCIAL_SUITE_WEB_SEARCH kill switch)', () => {
  const ORIGINAL = process.env.COMMERCIAL_SUITE_WEB_SEARCH;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.COMMERCIAL_SUITE_WEB_SEARCH;
    else process.env.COMMERCIAL_SUITE_WEB_SEARCH = ORIGINAL;
  });

  test('defaults ON when unset', () => {
    delete process.env.COMMERCIAL_SUITE_WEB_SEARCH;
    expect(webSearchLegEnabled()).toBe(true);
  });

  test.each(['0', 'false', 'off', 'FALSE'])('disabled by %s', (v) => {
    process.env.COMMERCIAL_SUITE_WEB_SEARCH = v;
    expect(webSearchLegEnabled()).toBe(false);
  });
});

describe('acceptWebSearchResult', () => {
  test('accepts a name + type', () => {
    expect(acceptWebSearchResult({ businessName: 'Test Taco Shop', businessType: 'restaurant' }))
      .toEqual({ businessName: 'Test Taco Shop', businessType: 'restaurant' });
  });

  test('accepts a name alone, or a type alone', () => {
    expect(acceptWebSearchResult({ businessName: 'Test Taco Shop', businessType: null }))
      .toEqual({ businessName: 'Test Taco Shop', businessType: null });
    expect(acceptWebSearchResult({ businessName: null, businessType: 'restaurant' }))
      .toEqual({ businessName: null, businessType: 'restaurant' });
  });

  test('returns null when neither field is present, or the input is malformed', () => {
    expect(acceptWebSearchResult({ businessName: null, businessType: null })).toBeNull();
    expect(acceptWebSearchResult(null)).toBeNull();
    expect(acceptWebSearchResult('not an object')).toBeNull();
  });

  // The old schema (suiteSqft/suiteSqftQuote/suiteSqftUrl) is gone — a
  // response still carrying those legacy fields must never resurrect a
  // size; only businessName/businessType are ever read.
  test('ignores a legacy-shaped response with a size field — no size output exists to read', () => {
    const result = acceptWebSearchResult({
      businessName: 'Test Taco Shop', suiteSqft: 1400, suiteSqftQuote: 'Suite 102 is 1,400 sq ft.',
    });
    expect(result).toEqual({ businessName: 'Test Taco Shop', businessType: null });
    expect(result.value).toBeUndefined();
  });
});

describe('buildPrompt', () => {
  test('asks only for businessName/businessType, never a size', () => {
    const prompt = buildPrompt({ address: { street: '4400 Test Commons Pkwy E', unit: '102', zip: '00000' } });
    expect(prompt).toContain('businessName');
    expect(prompt).toContain('businessType');
    expect(prompt).not.toMatch(/suiteSqft|square feet|sq ft.*lease/i);
  });
});

describe('resolveViaWebSearch — gating', () => {
  test('skipped when the kill switch is off, without calling the LLM dispatcher', async () => {
    process.env.COMMERCIAL_SUITE_WEB_SEARCH = 'false';
    const result = await resolveViaWebSearch({ address: { street: '4400 Test Commons Pkwy E', zip: '00000' } });
    expect(result).toBeNull();
    expect(callAnthropic).not.toHaveBeenCalled();
    delete process.env.COMMERCIAL_SUITE_WEB_SEARCH;
  });

  test('skipped with no street address', async () => {
    const result = await resolveViaWebSearch({ address: {} });
    expect(result).toBeNull();
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  test('a dispatcher failure (any reason) resolves null, never throws', async () => {
    callAnthropic.mockResolvedValue({ ok: false, reason: 'anthropic_timeout' });
    await expect(resolveViaWebSearch({ address: { street: '4400 Test Commons Pkwy E', zip: '00000' } }))
      .resolves.toBeNull();
  });

  test('parses a successful dispatcher response into an accepted result', async () => {
    callAnthropic.mockResolvedValue({ ok: true, text: JSON.stringify({ businessName: 'Test Taco Shop', businessType: 'restaurant' }) });
    const result = await resolveViaWebSearch({ address: { street: '4400 Test Commons Pkwy E', unit: '102', zip: '00000' } });
    expect(result).toEqual({ businessName: 'Test Taco Shop', businessType: 'restaurant' });
  });

  test('calls callAnthropic with the web_search tool, WORKHORSE model, and an 8192 token budget', async () => {
    callAnthropic.mockResolvedValue({ ok: true, text: JSON.stringify({ businessName: null, businessType: null }) });
    await resolveViaWebSearch({ address: { street: '4400 Test Commons Pkwy E', unit: '102', zip: '00000' } });
    expect(callAnthropic).toHaveBeenCalledTimes(1);
    const call = callAnthropic.mock.calls[0][0];
    expect(call.tools[0].type).toBe('web_search_20250305');
    // 8192, not 1536/1024 — WORKHORSE's adaptive thinking spends from the
    // same budget as the text (ai-property-lookup.js's own documented trap).
    expect(call.maxTokens).toBe(8192);
  });

  test('threads timeoutMs and anthropicClient through to the dispatcher', async () => {
    callAnthropic.mockResolvedValue({ ok: true, text: JSON.stringify({ businessName: null, businessType: null }) });
    const anthropicClient = { fake: true };
    await resolveViaWebSearch(
      { address: { street: '4400 Test Commons Pkwy E', zip: '00000' } },
      { timeoutMs: 5000, anthropicClient },
    );
    const call = callAnthropic.mock.calls[0][0];
    expect(call.timeoutMs).toBe(5000);
    expect(call.anthropicClient).toBe(anthropicClient);
  });
});

describe('Codex #4872 r1: the answer is read from the FINAL text block', () => {
  test('a preamble text block before the searches does not hide the JSON answer', async () => {
    callAnthropic.mockResolvedValue({
      ok: true,
      text: 'Let me search for that address.',
      response: {
        content: [
          { type: 'text', text: 'Let me search for that address.' },
          { type: 'server_tool_use', name: 'web_search' },
          { type: 'web_search_tool_result', content: [] },
          { type: 'text', text: '{"businessName":"Test Taco Shop","businessType":"restaurant"}' },
        ],
      },
    });
    const result = await resolveViaWebSearch({ address: { street: '4400 Test Commons Pkwy E', unit: '102', zip: '00000' } });
    expect(result).toEqual({ businessName: 'Test Taco Shop', businessType: 'restaurant' });
    expect(callAnthropic.mock.calls[0][0].jsonMode).toBe(false);
  });
});
