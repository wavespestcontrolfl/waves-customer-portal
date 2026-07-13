jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockCreate },
})));

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
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Large black-and-yellow orb weaver spider on its web outside a Florida home' }],
    });

    const alt = await describeHeroForAlt({
      buffer: PNG_BUFFER,
      title: 'Colorful Spiders in Southwest Florida',
      keyword: 'color spiders',
    });

    expect(alt).toBe('Large black-and-yellow orb weaver spider on its web outside a Florida home');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: MODELS.VISION }));
    const content = mockCreate.mock.calls[0][0].messages[0].content;
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: PNG_BUFFER.toString('base64') },
    });
    expect(content[1].text).toContain('Colorful Spiders in Southwest Florida');
  });

  test('fails open (null) on an API error', async () => {
    mockCreate.mockRejectedValue(new Error('overloaded'));
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' })).resolves.toBeNull();
  });

  test('fails open (null) on unusable output instead of stamping junk', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'A bug.' }] }); // too short
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' })).resolves.toBeNull();
  });

  test('skips the API entirely without image bytes or an API key', async () => {
    await expect(describeHeroForAlt({ buffer: null, title: 'T' })).resolves.toBeNull();

    delete process.env.ANTHROPIC_API_KEY;
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' })).resolves.toBeNull();

    expect(mockCreate).not.toHaveBeenCalled();
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
