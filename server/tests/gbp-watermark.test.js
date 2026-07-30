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
    gbpService.createPost.mockResolvedValue({ name: 'accounts/1/locations/2/localPosts/3' });
  });
  afterEach(() => { global.fetch = realFetch; });

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
