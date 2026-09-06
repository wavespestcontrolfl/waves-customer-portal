jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));

const MODELS = require('../config/models');
const { describeHeroForAlt, sanitizeAlt } = require('../services/content/hero-alt-vision');

const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('describeHeroForAlt', () => {
  const OLD_KEY = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = OLD_KEY;
  });

  test('returns the sanitized vision description on the happy path', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Large black-and-yellow orb weaver spider on its web outside a Florida home' });

    const alt = await describeHeroForAlt({
      buffer: PNG_BUFFER,
      title: 'Colorful Spiders in Southwest Florida',
      keyword: 'color spiders',
    });

    expect(alt).toBe('Large black-and-yellow orb weaver spider on its web outside a Florida home');
    const [policy, payload] = mockDispatch.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.visionAnalysis);
    expect(payload.images).toEqual([{ data: PNG_BUFFER.toString('base64'), mimeType: 'image/webp' }]);
    expect(payload.jsonMode).toBe(false);
    expect(payload.text).toContain('Colorful Spiders in Southwest Florida');
  });

  test('forwards the caller\'s remaining slot time; a spent deadline keeps the writer alt without a call (Codex r9 P2 on #3964)', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'A sprinkler head watering a Bradenton lawn' });
    await describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T', timeoutMs: 42_000 });
    expect(mockDispatch.mock.calls[0][1].timeoutMs).toBe(42_000);
    await describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' });
    expect(mockDispatch.mock.calls[1][1]).not.toHaveProperty('timeoutMs');
    mockDispatch.mockClear();
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T', timeoutMs: 0 })).resolves.toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('fails open (null) when both providers miss', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' })).resolves.toBeNull();
  });

  test('fails open (null) when the dispatcher throws', async () => {
    mockDispatch.mockRejectedValue(new Error('overloaded'));
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' })).resolves.toBeNull();
  });

  test('fails open (null) on unusable output instead of stamping junk', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'A bug.' }); // too short
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' })).resolves.toBeNull();
  });

  test('skips the dispatcher entirely without image bytes', async () => {
    await expect(describeHeroForAlt({ buffer: null, title: 'T' })).resolves.toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('sanitizeAlt', () => {
  test('strips label prefixes, wrapping quotes, fences, and collapses whitespace', () => {
    expect(sanitizeAlt('Alt text: "Green lynx spider resting on a bright  tropical leaf"'))
      .toBe('Green lynx spider resting on a bright tropical leaf');
    expect(sanitizeAlt('```\nWasp nest under the eave of a stucco Florida home\n```'))
      .toBe('Wasp nest under the eave of a stucco Florida home');
  });

  test('rejects too-short, too-long, and non-string output', () => {
    expect(sanitizeAlt('A spider.')).toBeNull();
    expect(sanitizeAlt('x'.repeat(200))).toBeNull();
    expect(sanitizeAlt(undefined)).toBeNull();
  });
});
