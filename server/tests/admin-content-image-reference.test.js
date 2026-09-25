/**
 * generateFeaturedImage (admin-content-v2.js) — stamps the logo/van-wrap
 * reference markers on the stored data: URL so the publish-time re-screen
 * knows which allowances apply (Codex r2 P2 on #4785: the van-wrap marker
 * was previously dropped here, so an admin-generated hero whose plan placed
 * a van in frame re-screened at publish time WITHOUT allowVanWrap, and its
 * own legitimate wrap branding was reported as forbidden).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/content-astro/astro-publisher', () => {
  const actual = jest.requireActual('../services/content-astro/astro-publisher');
  return {
    generatePlannedImage: jest.fn(),
    // Real stamp/parse helpers — only generation is mocked, so the test
    // verifies the ACTUAL data-URL round trip, not a mocked stand-in.
    _internals: { stampLogoReference: actual._internals.stampLogoReference, stampVanWrapReference: actual._internals.stampVanWrapReference, parseImageDataUrl: actual._internals.parseImageDataUrl },
  };
});

const AstroPublisher = require('../services/content-astro/astro-publisher');
const { _internals } = require('../routes/admin-content-v2');
const { generateFeaturedImage } = _internals;

const basePlan = { style: 'photo', setting: 'a front yard, palms', timeOfDay: 'noon' };

function mockHero(overrides = {}) {
  AstroPublisher.generatePlannedImage.mockResolvedValue({
    dataUrl: 'data:image/png;base64,AAAA',
    model: 'gpt-image-2',
    plan: basePlan,
    screen: { checked: true, ok: true, reasons: [] },
    logoReference: false,
    vanWrapReference: false,
    ...overrides,
  });
}

describe('generateFeaturedImage: reference markers follow the hero flags', () => {
  beforeEach(() => jest.clearAllMocks());

  test('logoReference: true, vanWrapReference: false → only the logo marker is stamped', async () => {
    mockHero({ logoReference: true, vanWrapReference: false });
    const url = await generateFeaturedImage({ title: 'T', slug: 's' });
    expect(AstroPublisher._internals.parseImageDataUrl(url)).toMatchObject({ logoReference: true, vanWrapReference: false });
  });

  test('vanWrapReference: true, logoReference: false → only the van-wrap marker is stamped (the bug: this used to be dropped entirely)', async () => {
    mockHero({ logoReference: false, vanWrapReference: true });
    const url = await generateFeaturedImage({ title: 'T', slug: 's' });
    expect(AstroPublisher._internals.parseImageDataUrl(url)).toMatchObject({ logoReference: false, vanWrapReference: true });
  });

  test('both references attached → both markers survive the round trip', async () => {
    mockHero({ logoReference: true, vanWrapReference: true });
    const url = await generateFeaturedImage({ title: 'T', slug: 's' });
    expect(AstroPublisher._internals.parseImageDataUrl(url)).toMatchObject({ logoReference: true, vanWrapReference: true });
  });

  test('neither reference attached → the plain data URL is returned untouched', async () => {
    mockHero({ logoReference: false, vanWrapReference: false });
    const url = await generateFeaturedImage({ title: 'T', slug: 's' });
    expect(url).toBe('data:image/png;base64,AAAA');
  });
});
