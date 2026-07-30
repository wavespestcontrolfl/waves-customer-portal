/**
 * GBP watermark contract (owner directive 2026-07-30): every GBP post image
 * carries a small Waves logo bottom-right, applied inside postToGBP — the one
 * choke point every GBP post passes through. Rendered cards skip via
 * opts.alreadyBranded (their chrome already carries the logo). Fail-OPEN: any
 * watermark error posts the ORIGINAL image rather than blocking the post.
 */

jest.mock('../services/google-business', () => ({
  createPost: jest.fn(),
  getConfiguredLocations: jest.fn(async () => []),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const gbpService = require('../services/google-business');
const { postToGBP } = require('../services/social-media');
const { WAVES_LOCATIONS } = require('../config/locations');

const LOC = WAVES_LOCATIONS.find((l) => l.googleLocationResourceName)?.id;

describe('postToGBP watermark gate', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SOCIAL_MEDIA_CDN_DOMAIN = 'cdn.example.com';
    gbpService.createPost.mockResolvedValue({ name: 'accounts/1/locations/2/localPosts/3' });
  });
  afterEach(() => { global.fetch = realFetch; delete process.env.SOCIAL_MEDIA_CDN_DOMAIN; });

  test('location config sanity: at least one GBP-resourced location exists', () => {
    expect(LOC).toBeTruthy();
  });

  test('alreadyBranded images are passed through untouched — no fetch, no re-host', async () => {
    global.fetch = jest.fn();
    const r = await postToGBP(LOC, 'summary', 'https://www.wavespestcontrol.com/x/', 'https://cdn.example.com/card-gbp.jpg', { alreadyBranded: true });
    expect(r.success).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(gbpService.createPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mediaUrl: 'https://cdn.example.com/card-gbp.jpg' }),
      LOC,
    );
  });

  test('watermark failure fails OPEN — original image still posts', async () => {
    // Source image unreachable → watermarkGbpImage returns the original URL.
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 }));
    const r = await postToGBP(LOC, 'summary', 'https://www.wavespestcontrol.com/x/', 'https://cdn.example.com/blog-hero-x.jpg');
    expect(r.success).toBe(true);
    expect(global.fetch).toHaveBeenCalled(); // watermark path WAS attempted
    expect(gbpService.createPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mediaUrl: 'https://cdn.example.com/blog-hero-x.jpg' }),
      LOC,
    );
  });

  test('SSRF guard: untrusted hosts are never fetched — original URL posts as-is', async () => {
    global.fetch = jest.fn();
    for (const url of [
      'https://evil.example.net/x.jpg',
      'http://cdn.example.com/downgrade.jpg', // https only
      'https://169.254.169.254/latest/meta-data', // metadata endpoint
      'https://localhost:3001/internal.jpg',
      'not a url',
    ]) {
      const r = await postToGBP(LOC, 'summary', 'https://www.wavespestcontrol.com/x/', url);
      expect(r.success).toBe(true);
      expect(gbpService.createPost).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ mediaUrl: url }),
        LOC,
      );
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('own-host images ARE fetched for watermarking (CDN + wavespestcontrol.com)', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 })); // fail-open path
    await postToGBP(LOC, 'summary', 'https://www.wavespestcontrol.com/x/', 'https://www.wavespestcontrol.com/images/blog/x/hero.jpg');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Redirects are refused outright — our hosts don't redirect.
    expect(global.fetch).toHaveBeenCalledWith(
      'https://www.wavespestcontrol.com/images/blog/x/hero.jpg',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  test('text-only posts skip the watermark path entirely', async () => {
    global.fetch = jest.fn();
    const r = await postToGBP(LOC, 'summary', 'https://www.wavespestcontrol.com/x/', null);
    expect(r.success).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(gbpService.createPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mediaUrl: undefined }),
      LOC,
    );
  });
});
