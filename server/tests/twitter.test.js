// X (Twitter) posting service — publishes through Zernio (the daily-content
// backend) since X's Feb-2026 pay-per-use credits closed the free direct
// write path. Blog shares tweet text + article URL (X wraps URLs to a fixed
// 23-char t.co link and renders the card from the page og:image).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ s3: {} }));

const twitter = require('../services/twitter');
const { ZERNIO_API, TCO_URL_LENGTH, TWEET_LIMIT } = twitter._test;

const LINK = 'https://www.wavespestcontrol.com/pest-control/lizard-droppings/';
const ACCOUNT_ID = '6a500d943ecd8aa344819c49';

function setCreds() {
  process.env.ZERNIO_API_KEY = 'zk';
}
function clearCreds() {
  delete process.env.ZERNIO_API_KEY;
  delete process.env.ZERNIO_TWITTER_ACCOUNT_ID;
}

// One fetch mock covering the createPost round-trip: account discovery,
// post create, then the bounded publish-status poll.
function mockZernio({ createStatus = 200, pollStatus = 'published', platformPostId = '1234567890' } = {}) {
  return jest.fn(async (url, opts = {}) => {
    if (url === `${ZERNIO_API}/accounts`) {
      return {
        ok: true,
        json: async () => ({ accounts: [
          { _id: 'fb-id', platform: 'facebook', isActive: true },
          { _id: ACCOUNT_ID, platform: 'twitter', isActive: true },
        ] }),
        text: async () => '',
      };
    }
    if (url === `${ZERNIO_API}/posts` && opts.method === 'POST') {
      if (createStatus !== 200) {
        return { ok: false, status: createStatus, text: async () => 'create rejected' };
      }
      return { ok: true, json: async () => ({ post: { _id: 'zp1' } }), text: async () => '' };
    }
    if (url === `${ZERNIO_API}/posts/zp1`) {
      return {
        ok: true,
        json: async () => ({ post: {
          _id: 'zp1',
          status: pollStatus,
          platforms: [{ platform: 'twitter', status: pollStatus, platformPostId, error: pollStatus === 'failed' ? 'duplicate content' : undefined }],
        } }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('twitter service', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    clearCreds();
    twitter._account = { id: null, fetchedAt: 0 };
    jest.clearAllMocks();
  });

  test('configured requires ZERNIO_API_KEY', () => {
    expect(twitter.configured).toBe(false);
    setCreds();
    expect(twitter.configured).toBe(true);
  });

  describe('composeTweet', () => {
    test('appends the article URL after a blank line; caption alone without a link', () => {
      expect(twitter.composeTweet('Caption', LINK)).toBe(`Caption\n\n${LINK}`);
      expect(twitter.composeTweet('Caption', null)).toBe('Caption');
    });

    test('trims the CAPTION (never the URL) when the t.co-adjusted length would exceed 280', () => {
      const long = 'x'.repeat(400);
      const composed = twitter.composeTweet(long, LINK);
      expect(composed.endsWith(`\n\n${LINK}`)).toBe(true);
      const caption = composed.slice(0, -(`\n\n${LINK}`.length));
      expect(caption.endsWith('…')).toBe(true);
      // Effective X length: caption + separator + fixed t.co URL length.
      expect(caption.length + 2 + TCO_URL_LENGTH).toBeLessThanOrEqual(TWEET_LIMIT);
    });
  });

  describe('createPost', () => {
    test('throws without ZERNIO_API_KEY, without calling the API', async () => {
      global.fetch = jest.fn();
      await expect(twitter.createPost({ text: 'T', link: LINK })).rejects.toThrow(/not configured/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('discovers the twitter account, creates a publish-now Zernio post, and returns the platform post id', async () => {
      setCreds();
      global.fetch = mockZernio();

      const res = await twitter.createPost({ text: 'Lizard droppings caption', link: LINK });

      expect(res).toEqual({ platform: 'twitter', postId: '1234567890', success: true });
      const createCall = global.fetch.mock.calls.find(([u, o]) => u === `${ZERNIO_API}/posts` && o?.method === 'POST');
      expect(createCall).toBeTruthy();
      expect(createCall[1].headers.Authorization).toBe('Bearer zk');
      expect(JSON.parse(createCall[1].body)).toEqual({
        content: `Lizard droppings caption\n\n${LINK}`,
        platforms: [{ platform: 'twitter', accountId: ACCOUNT_ID }],
        publishNow: true,
      });
    }, 15000);

    test('ZERNIO_TWITTER_ACCOUNT_ID pin skips account discovery', async () => {
      setCreds();
      process.env.ZERNIO_TWITTER_ACCOUNT_ID = 'pinned-id';
      global.fetch = mockZernio();

      await twitter.createPost({ text: 'T', link: LINK });

      expect(global.fetch.mock.calls.some(([u]) => u === `${ZERNIO_API}/accounts`)).toBe(false);
      const createCall = global.fetch.mock.calls.find(([u, o]) => u === `${ZERNIO_API}/posts` && o?.method === 'POST');
      expect(JSON.parse(createCall[1].body).platforms).toEqual([{ platform: 'twitter', accountId: 'pinned-id' }]);
    }, 15000);

    test('replayed create (Zernio 409 dedupe) converges on the existing post instead of failing', async () => {
      setCreds();
      const base = mockZernio();
      global.fetch = jest.fn(async (url, opts = {}) => {
        if (url === `${ZERNIO_API}/posts` && opts.method === 'POST') {
          return { ok: false, status: 409, text: async () => JSON.stringify({ existingPostId: 'zp1' }) };
        }
        return base(url, opts);
      });

      const res = await twitter.createPost({ text: 'T', link: LINK });
      expect(res).toEqual({ platform: 'twitter', postId: '1234567890', success: true });
    }, 20000);

    test('409 dedupe id under details.existingPostId also converges', async () => {
      setCreds();
      const base = mockZernio();
      global.fetch = jest.fn(async (url, opts = {}) => {
        if (url === `${ZERNIO_API}/posts` && opts.method === 'POST') {
          return { ok: false, status: 409, text: async () => JSON.stringify({ details: { existingPostId: 'zp1' } }) };
        }
        return base(url, opts);
      });
      const res = await twitter.createPost({ text: 'T', link: LINK });
      expect(res).toEqual({ platform: 'twitter', postId: '1234567890', success: true });
    }, 20000);

    test('stale/disconnected sibling X entries are ignored — healthy account selected, no false ambiguity', async () => {
      setCreds();
      const base = mockZernio();
      global.fetch = jest.fn(async (url, opts = {}) => {
        if (url === `${ZERNIO_API}/accounts`) {
          return {
            ok: true,
            json: async () => ({ accounts: [
              { _id: 'x-stale-status', platform: 'twitter', isActive: true, platformStatus: 'expired' },
              { _id: 'x-disabled', platform: 'twitter', isActive: true, enabled: false },
              { _id: 'x-disconnected', platform: 'twitter', isActive: true, intentionalDisconnectAt: '2026-07-01T00:00:00Z' },
              { _id: ACCOUNT_ID, platform: 'twitter', isActive: true, enabled: true, platformStatus: 'active' },
            ] }),
            text: async () => '',
          };
        }
        return base(url, opts);
      });
      await twitter.createPost({ text: 'T', link: LINK });
      const createCall = global.fetch.mock.calls.find(([u, o]) => u === `${ZERNIO_API}/posts` && o?.method === 'POST');
      expect(JSON.parse(createCall[1].body).platforms).toEqual([{ platform: 'twitter', accountId: ACCOUNT_ID }]);
    }, 20000);

    test('multiple active X accounts without a pin → fail closed', async () => {
      setCreds();
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ accounts: [
          { _id: 'x-one', platform: 'twitter', isActive: true },
          { _id: 'x-two', platform: 'twitter', isActive: true },
        ] }),
        text: async () => '',
      }));
      await expect(twitter.createPost({ text: 'T', link: LINK })).rejects.toThrow(/Multiple active X \(twitter\) accounts.*ZERNIO_TWITTER_ACCOUNT_ID/);
      expect(global.fetch.mock.calls.every(([u]) => u === `${ZERNIO_API}/accounts`)).toBe(true);
    });

    test('no connected X account in Zernio → clear error before any create', async () => {
      setCreds();
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ accounts: [{ _id: 'fb-id', platform: 'facebook', isActive: true }] }),
        text: async () => '',
      }));
      await expect(twitter.createPost({ text: 'T', link: LINK })).rejects.toThrow(/No active X \(twitter\) account/);
      expect(global.fetch.mock.calls.every(([u]) => u === `${ZERNIO_API}/accounts`)).toBe(true);
    });

    test('surfaces Zernio create errors with status and body', async () => {
      setCreds();
      global.fetch = mockZernio({ createStatus: 402 });
      await expect(twitter.createPost({ text: 'T', link: LINK })).rejects.toThrow(/Zernio POST \/posts 402: create rejected/);
    });

    test('platform-side publish failure surfaces as an error', async () => {
      setCreds();
      global.fetch = mockZernio({ pollStatus: 'failed' });
      await expect(twitter.createPost({ text: 'T', link: LINK })).rejects.toThrow(/Zernio X publish failed: duplicate content/);
    }, 15000);

    test('empty text (and no link) is rejected before hitting the API', async () => {
      setCreds();
      global.fetch = jest.fn();
      await expect(twitter.createPost({ text: '   ' })).rejects.toThrow(/requires text/);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});

describe('publishToAll twitter integration', () => {
  const social = require('../services/social-media');
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.SOCIAL_AUTOMATION_ENABLED = 'true';
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.SOCIAL_AUTOMATION_ENABLED;
    delete process.env.SOCIAL_TWITTER_ENABLED;
    clearCreds();
    twitter._account = { id: null, fetchedAt: 0 };
    jest.clearAllMocks();
  });

  test('blog share on channels:[twitter] tweets caption + article URL via Zernio', async () => {
    process.env.SOCIAL_TWITTER_ENABLED = 'true';
    setCreds();
    global.fetch = mockZernio({ platformPostId: '99' });

    const res = await social.publishToAll({
      title: 'T', description: 'D', link: LINK, source: 'autonomous_blog',
      channels: ['twitter'], customContent: { twitter: 'X caption' }, noAiImage: true,
    });

    expect(res.platforms).toEqual([expect.objectContaining({ platform: 'twitter', postId: '99', success: true })]);
    const createCall = global.fetch.mock.calls.find(([u, o]) => u === `${ZERNIO_API}/posts` && o?.method === 'POST');
    expect(JSON.parse(createCall[1].body).content).toBe(`X caption\n\n${LINK}`);
  }, 15000);

  test('flag off (or key missing) → skipped, never a failure', async () => {
    global.fetch = jest.fn();

    const off = await social.publishToAll({
      title: 'T', link: LINK, source: 'autonomous_blog',
      channels: ['twitter'], customContent: { twitter: 'X caption' }, noAiImage: true,
    });
    expect(off.platforms).toEqual([{ platform: 'twitter', skipped: 'Disabled' }]);

    process.env.SOCIAL_TWITTER_ENABLED = 'true'; // enabled but unconfigured
    const noKey = await social.publishToAll({
      title: 'T', link: LINK, source: 'autonomous_blog',
      channels: ['twitter'], customContent: { twitter: 'X caption' }, noAiImage: true,
    });
    expect(noKey.platforms).toEqual([{ platform: 'twitter', skipped: expect.stringMatching(/not configured/) }]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
