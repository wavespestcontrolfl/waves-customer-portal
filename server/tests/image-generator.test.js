/**
 * Unit tests for image-generator. Mocked fetch — no API calls.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { ImageGenerator, _internals } = require('../services/content/image-generator');
const {
  DEFAULT_CHAIN, MODEL_MAP, MODE_SIZES,
  parseChain, isFatalOpenAIError, sizeFor, buildPrompt,
} = _internals;

// Helpers to build Response-like fixtures for mocked fetch.
function ok(body) { return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }); }
function err(status, body = '') { return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}), text: () => Promise.resolve(body) }); }
function thrown(message) { return Promise.reject(new Error(message)); }

const OPENAI_OK_BODY = { data: [{ b64_json: 'AAAA' }] };
const GEMINI_OK_BODY = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'BBBB' } }] } }] };

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => {
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'BLOG_IMAGE_PROVIDER']) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

// ── pure helpers ────────────────────────────────────────────────────

describe('parseChain', () => {
  test('default when env unset', () => {
    expect(parseChain(undefined)).toEqual(['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gemini']);
  });
  test('respects env override', () => {
    expect(parseChain('gemini,gpt-image-2')).toEqual(['gemini', 'gpt-image-2']);
  });
  test('drops unknown providers', () => {
    expect(parseChain('made-up-1,gpt-image-2,nothing')).toEqual(['gpt-image-2']);
  });
  test('trims whitespace + lowercases', () => {
    expect(parseChain(' GPT-Image-2 , Gemini ')).toEqual(['gpt-image-2', 'gemini']);
  });
});

describe('isFatalOpenAIError', () => {
  test.each([
    [404, true], [400, true], [401, true], [403, true],
    [429, false], [408, false], [500, false], [502, false], [503, false],
  ])('status %d → fatal=%s', (status, expected) => {
    expect(isFatalOpenAIError(status)).toBe(expected);
  });
});

describe('sizeFor', () => {
  test('blog-hero defaults', () => {
    expect(sizeFor('blog-hero', 'openai')).toBe('1536x1024');
    expect(sizeFor('blog-hero', 'gemini')).toBe('1536x1024');
  });
  test('social-square', () => {
    expect(sizeFor('social-square', 'openai')).toBe('1024x1024');
  });
  test('unknown mode falls back to blog-hero', () => {
    expect(sizeFor('made-up', 'openai')).toBe('1536x1024');
  });
});

describe('buildPrompt', () => {
  test('includes title + city when present', () => {
    const p = buildPrompt({ title: 'Pest Control Bradenton', city: 'Bradenton', mode: 'blog-hero' });
    expect(p).toMatch(/Pest Control Bradenton/);
    expect(p).toMatch(/Bradenton/);
    expect(p).toMatch(/no text/i);
  });
  test('social-square wording differs', () => {
    expect(buildPrompt({ title: 'X', mode: 'social-square' })).toMatch(/social media tile/);
    expect(buildPrompt({ title: 'X', mode: 'blog-hero' })).toMatch(/blog hero image/);
  });
  test('embeds mode-specific aspect/dimensions (needed for Gemini)', () => {
    expect(buildPrompt({ title: 'X', mode: 'social-square' })).toMatch(/1:1.*1024x1024/);
    expect(buildPrompt({ title: 'X', mode: 'blog-hero' })).toMatch(/3:2.*1536x1024/);
  });
});

// ── ImageGenerator chain behavior ───────────────────────────────────

describe('ImageGenerator: chain success on first provider', () => {
  test('gpt-image-2 succeeds → returns its dataUrl + model slug', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const mockFetch = jest.fn().mockReturnValue(ok(OPENAI_OK_BODY));
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gemini', fetchFn: mockFetch });
    const r = await gen.generate({ title: 'Test', mode: 'blog-hero' });
    expect(r.model).toBe('gpt-image-2');
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,AAAA$/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('ImageGenerator: chain fallback on fatal OpenAI error', () => {
  test('404 model_not_found on gpt-image-2 → falls to gpt-image-1', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const mockFetch = jest.fn()
      .mockReturnValueOnce(err(404, 'model_not_found'))
      .mockReturnValueOnce(ok(OPENAI_OK_BODY));
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gpt-image-1', fetchFn: mockFetch });
    const r = await gen.generate({ title: 'Test' });
    expect(r.model).toBe('gpt-image-1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
  test('400 invalid_request on gpt-image-2 → falls to next', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GEMINI_API_KEY = 'gem-test';
    const mockFetch = jest.fn()
      .mockReturnValueOnce(err(400, 'invalid model'))
      .mockReturnValueOnce(ok(GEMINI_OK_BODY));
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gemini', fetchFn: mockFetch });
    const r = await gen.generate({ title: 'Test' });
    expect(r.model).toBe('gemini');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('ImageGenerator: skipped when key missing', () => {
  test('OPENAI_API_KEY missing → openai entries skipped, falls to gemini', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = 'gem-test';
    const mockFetch = jest.fn().mockReturnValue(ok(GEMINI_OK_BODY));
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gemini', fetchFn: mockFetch });
    const r = await gen.generate({ title: 'Test' });
    expect(r.model).toBe('gemini');
    expect(mockFetch).toHaveBeenCalledTimes(1); // only gemini was called
  });
  test('all keys missing → throws after exhausting chain', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const mockFetch = jest.fn();
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gemini', fetchFn: mockFetch });
    await expect(gen.generate({ title: 'Test' })).rejects.toThrow(/all providers failed/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('ImageGenerator: retryable errors fall through to next provider', () => {
  // The whole point of the chain is resilience — a 408/429/5xx on one
  // provider should try the next one. Admin and social callers do not
  // retry, so bailing on retryable used to defeat the fallback.
  test('500 on gpt-image-2 falls through to gemini', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GEMINI_API_KEY = 'gem-test';
    const mockFetch = jest.fn()
      .mockReturnValueOnce(err(500, 'server error'))
      .mockReturnValueOnce(ok(GEMINI_OK_BODY));
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gemini', fetchFn: mockFetch });
    const r = await gen.generate({ title: 'Test' });
    expect(r.model).toBe('gemini');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
  test('429 on gpt-image-2 + 503 on gemini → throws after exhausting chain', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GEMINI_API_KEY = 'gem-test';
    const mockFetch = jest.fn()
      .mockReturnValueOnce(err(429, 'rate limited'))
      .mockReturnValueOnce(err(503, 'unavailable'));
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gemini', fetchFn: mockFetch });
    await expect(gen.generate({ title: 'Test' })).rejects.toThrow(/all providers failed/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('ImageGenerator: Gemini safety refusal', () => {
  test('Gemini text-only response (safety filter) → fatal, falls through if more in chain', async () => {
    process.env.GEMINI_API_KEY = 'gem-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    const safetyResponse = { candidates: [{ content: { parts: [{ text: "I can't generate that image" }] } }] };
    const mockFetch = jest.fn()
      .mockReturnValueOnce(ok(safetyResponse))
      .mockReturnValueOnce(ok(OPENAI_OK_BODY));
    const gen = new ImageGenerator({ envChain: 'gemini,gpt-image-2', fetchFn: mockFetch });
    const r = await gen.generate({ title: 'Test' });
    expect(r.model).toBe('gpt-image-2');
  });
});

describe('ImageGenerator: capabilityCheck', () => {
  test('reports availability per OpenAI /v1/models response', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GEMINI_API_KEY = 'gem-test';
    const mockFetch = jest.fn().mockReturnValue(ok({
      data: [{ id: 'gpt-image-1' }, { id: 'gpt-image-2' }],
    }));
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gpt-image-1.5,gemini', fetchFn: mockFetch });
    const check = await gen.capabilityCheck();
    expect(check.providers['gpt-image-2']).toBe('available');
    expect(check.providers['gpt-image-1.5']).toBe('model_not_listed');
    expect(check.providers['gemini']).toBe('key_present');
  });
  test('caches result — second call doesn\'t re-fetch', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const mockFetch = jest.fn().mockReturnValue(ok({ data: [] }));
    const gen = new ImageGenerator({ envChain: 'gpt-image-2', fetchFn: mockFetch });
    await gen.capabilityCheck();
    await gen.capabilityCheck();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
  test('reports missing API key cleanly', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gemini', fetchFn: jest.fn() });
    const check = await gen.capabilityCheck();
    expect(check.providers['gpt-image-2']).toBe('OPENAI_API_KEY_missing');
    expect(check.providers['gemini']).toBe('GEMINI_API_KEY_missing');
  });
});

describe('ImageGenerator: invalid env chain falls back to default', () => {
  test('all-bogus chain → uses defaults', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const mockFetch = jest.fn().mockReturnValue(ok(OPENAI_OK_BODY));
    const gen = new ImageGenerator({ envChain: 'nothing,bogus', fetchFn: mockFetch });
    const r = await gen.generate({ title: 'Test' });
    expect(r.model).toBe('gpt-image-2'); // first in DEFAULT_CHAIN
  });
});

describe('ImageGenerator: attempts breadcrumb on failure', () => {
  test('throws Error with .attempts populated', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GEMINI_API_KEY = 'gem-test';
    const mockFetch = jest.fn()
      .mockReturnValueOnce(err(404))
      .mockReturnValueOnce(err(400))
      .mockReturnValueOnce(err(400));
    const gen = new ImageGenerator({ envChain: 'gpt-image-2,gpt-image-1,gemini', fetchFn: mockFetch });
    try {
      await gen.generate({ title: 'Test' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err.message).toMatch(/all providers failed/);
      expect(err.attempts.length).toBe(3);
      expect(err.attempts.map((a) => a.provider)).toEqual(['gpt-image-2', 'gpt-image-1', 'gemini']);
    }
  });
});

// ── image-native Gemini slugs (creative engine) ─────────────────────

describe('gemini image-native models', () => {
  test('MODEL_MAP registers the nano-banana slugs with aspect support', () => {
    expect(MODEL_MAP['gemini-image-best']).toMatchObject({ api: 'gemini', imageAspect: true });
    expect(MODEL_MAP['gemini-image']).toMatchObject({ api: 'gemini', imageAspect: true });
    // legacy text-model slug must NOT get imageConfig (it would 400)
    expect(MODEL_MAP.gemini.imageAspect).toBeUndefined();
  });

  test('image-native slug sends imageConfig.aspectRatio; legacy gemini does not', async () => {
    process.env.GEMINI_API_KEY = 'k';
    delete process.env.OPENAI_API_KEY;
    const bodies = [];
    const fetchFn = jest.fn().mockImplementation((url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return ok(GEMINI_OK_BODY);
    });

    const withAspect = new ImageGenerator({ envChain: 'gemini-image-best', fetchFn });
    await withAspect.generate({ title: 't', mode: 'social-square' });
    expect(bodies[0].generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' });

    const legacy = new ImageGenerator({ envChain: 'gemini', fetchFn });
    await legacy.generate({ title: 't', mode: 'social-square' });
    expect(bodies[1].generationConfig.imageConfig).toBeUndefined();
  });

  test('blog-hero mode maps to 3:2 for image-native models', async () => {
    process.env.GEMINI_API_KEY = 'k';
    const bodies = [];
    const fetchFn = jest.fn().mockImplementation((url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return ok(GEMINI_OK_BODY);
    });
    const gen = new ImageGenerator({ envChain: 'gemini-image', fetchFn });
    await gen.generate({ title: 't', mode: 'blog-hero' });
    expect(bodies[0].generationConfig.imageConfig).toEqual({ aspectRatio: '3:2' });
  });

  test('default prompt style is brand palette, not teal', () => {
    const prompt = buildPrompt({ title: 'x', mode: 'social-square' });
    expect(prompt).toContain('#009CDE');
    expect(prompt).toContain('#FFD700');
    expect(prompt).toContain('no teal');
    expect(prompt).not.toContain('#0ea5e9');
  });
});
