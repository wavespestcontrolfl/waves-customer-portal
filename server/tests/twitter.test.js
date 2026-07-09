// X (Twitter) posting service — OAuth 1.0a user-context creds from env, v2
// create-Tweet endpoint. Blog shares tweet text + article URL (X wraps URLs
// to a fixed 23-char t.co link and renders the card from the page og:image).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ s3: {} }));

const twitter = require('../services/twitter');
const { TWEETS_URL, TCO_URL_LENGTH, TWEET_LIMIT, pctEncode } = twitter._test;

const LINK = 'https://www.wavespestcontrol.com/pest-control/lizard-droppings/';

function setCreds() {
  process.env.TWITTER_API_KEY = 'ck';
  process.env.TWITTER_API_SECRET = 'cs';
  process.env.TWITTER_ACCESS_TOKEN = 'at';
  process.env.TWITTER_ACCESS_TOKEN_SECRET = 'as';
}
function clearCreds() {
  delete process.env.TWITTER_API_KEY;
  delete process.env.TWITTER_API_SECRET;
  delete process.env.TWITTER_ACCESS_TOKEN;
  delete process.env.TWITTER_ACCESS_TOKEN_SECRET;
}

describe('twitter service', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    clearCreds();
    jest.clearAllMocks();
  });

  test('configured requires all four OAuth 1.0a env vars', () => {
    expect(twitter.configured).toBe(false);
    setCreds();
    expect(twitter.configured).toBe(true);
    delete process.env.TWITTER_ACCESS_TOKEN_SECRET;
    expect(twitter.configured).toBe(false);
  });

  test('pctEncode is RFC 3986 (encodes the characters encodeURIComponent leaves bare)', () => {
    expect(pctEncode("a!*'()b")).toBe('a%21%2A%27%28%29b');
    expect(pctEncode('a b&c')).toBe('a%20b%26c');
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
    test('throws without credentials, without calling the API', async () => {
      global.fetch = jest.fn();
      await expect(twitter.createPost({ text: 'T', link: LINK })).rejects.toThrow(/not configured/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('posts to /2/tweets with an OAuth 1.0a header and text ending in the article URL', async () => {
      setCreds();
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ data: { id: '1234567890' } }),
        text: async () => '',
      }));

      const res = await twitter.createPost({ text: 'Lizard droppings caption', link: LINK });

      expect(res).toEqual({ platform: 'twitter', postId: '1234567890', success: true });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe(TWEETS_URL);
      expect(opts.method).toBe('POST');
      const auth = opts.headers.Authorization;
      expect(auth).toMatch(/^OAuth /);
      for (const k of ['oauth_consumer_key="ck"', 'oauth_token="at"', 'oauth_signature_method="HMAC-SHA1"', 'oauth_signature=']) {
        expect(auth).toContain(k);
      }
      expect(JSON.parse(opts.body)).toEqual({ text: `Lizard droppings caption\n\n${LINK}` });
    });

    test('surfaces API errors with status and body', async () => {
      setCreds();
      global.fetch = jest.fn(async () => ({ ok: false, status: 403, text: async () => 'no write access' }));

      await expect(twitter.createPost({ text: 'T', link: LINK })).rejects.toThrow(/X API 403: no write access/);
    });

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
    jest.clearAllMocks();
  });

  test('blog share on channels:[twitter] tweets caption + article URL', async () => {
    process.env.SOCIAL_TWITTER_ENABLED = 'true';
    setCreds();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: { id: '99' } }),
      text: async () => '',
    }));

    const res = await social.publishToAll({
      title: 'T', description: 'D', link: LINK, source: 'autonomous_blog',
      channels: ['twitter'], customContent: { twitter: 'X caption' }, noAiImage: true,
    });

    expect(res.platforms).toEqual([expect.objectContaining({ platform: 'twitter', postId: '99', success: true })]);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe(TWEETS_URL);
    expect(JSON.parse(opts.body).text).toBe(`X caption\n\n${LINK}`);
  });

  test('flag off (or creds missing) → skipped, never a failure', async () => {
    global.fetch = jest.fn();

    const off = await social.publishToAll({
      title: 'T', link: LINK, source: 'autonomous_blog',
      channels: ['twitter'], customContent: { twitter: 'X caption' }, noAiImage: true,
    });
    expect(off.platforms).toEqual([{ platform: 'twitter', skipped: 'Disabled' }]);

    process.env.SOCIAL_TWITTER_ENABLED = 'true'; // enabled but unconfigured
    const noCreds = await social.publishToAll({
      title: 'T', link: LINK, source: 'autonomous_blog',
      channels: ['twitter'], customContent: { twitter: 'X caption' }, noAiImage: true,
    });
    expect(noCreds.platforms).toEqual([{ platform: 'twitter', skipped: expect.stringMatching(/credentials not configured/) }]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
