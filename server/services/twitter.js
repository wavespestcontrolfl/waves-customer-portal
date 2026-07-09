/**
 * X (Twitter) posting service — single brand account, OAuth 1.0a user context.
 *
 * Posting uses the v2 create-Tweet endpoint (POST /2/tweets), authorized with
 * OAuth 1.0a user-context credentials generated once in the X developer
 * portal (the app's consumer key/secret plus an access token/secret minted
 * for the brand account). No callback flow, no token rotation, nothing in the
 * DB — the four env vars are the whole grant. The free API tier's write cap
 * (~500 posts/month app-wide) comfortably covers blog-share cadence.
 *
 * Env: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN,
 *      TWITTER_ACCESS_TOKEN_SECRET.
 *      (TWITTER_BEARER_TOKEN is the separate app-only READ credential used by
 *      the backlink-agent x-poller — a bearer token cannot create tweets.)
 *
 * Tweets go out as text + article URL: X wraps every URL to a fixed-length
 * t.co link (23 chars against the 280 limit) and renders the link card from
 * the page's og:image, so no media upload is needed for blog shares.
 */

const crypto = require('crypto');
const logger = require('./logger');

const TWEETS_URL = 'https://api.twitter.com/2/tweets';
// X counts every URL as a fixed t.co length regardless of the real URL.
const TCO_URL_LENGTH = 23;
const TWEET_LIMIT = 280;

// RFC 3986 percent-encoding — encodeURIComponent leaves !*'() unencoded,
// which breaks the OAuth 1.0a signature base string.
function pctEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

class TwitterService {
  get configured() {
    return !!(
      process.env.TWITTER_API_KEY
      && process.env.TWITTER_API_SECRET
      && process.env.TWITTER_ACCESS_TOKEN
      && process.env.TWITTER_ACCESS_TOKEN_SECRET
    );
  }

  // OAuth 1.0a HMAC-SHA1 Authorization header for a JSON-body request: only
  // the oauth_* params (plus query params — none here) enter the signature
  // base string; a JSON body is excluded by spec.
  _authHeader(method, url) {
    const oauth = {
      oauth_consumer_key: process.env.TWITTER_API_KEY,
      oauth_nonce: crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_token: process.env.TWITTER_ACCESS_TOKEN,
      oauth_version: '1.0',
    };
    const paramString = Object.keys(oauth)
      .sort()
      .map((k) => `${pctEncode(k)}=${pctEncode(oauth[k])}`)
      .join('&');
    const baseString = [method.toUpperCase(), pctEncode(url), pctEncode(paramString)].join('&');
    const signingKey = `${pctEncode(process.env.TWITTER_API_SECRET)}&${pctEncode(process.env.TWITTER_ACCESS_TOKEN_SECRET)}`;
    oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
    return `OAuth ${Object.keys(oauth)
      .sort()
      .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`)
      .join(', ')}`;
  }

  // Compose the tweet text: caption + blank line + article URL, trimming the
  // CAPTION (never the URL) if the t.co-adjusted length would exceed 280.
  composeTweet(text, link) {
    const caption = String(text || '').trim();
    if (!link) return caption;
    const separator = '\n\n';
    const budget = TWEET_LIMIT - TCO_URL_LENGTH - separator.length;
    const trimmed = caption.length > budget ? `${caption.slice(0, budget - 1).trimEnd()}…` : caption;
    return `${trimmed}${separator}${link}`;
  }

  async createPost({ text, link } = {}) {
    if (!this.configured) {
      throw new Error('X (Twitter) credentials not configured (TWITTER_API_KEY/SECRET + TWITTER_ACCESS_TOKEN/SECRET)');
    }
    const status = this.composeTweet(text, link);
    if (!status) throw new Error('X post requires text');

    const res = await fetch(TWEETS_URL, {
      method: 'POST',
      headers: {
        Authorization: this._authHeader('POST', TWEETS_URL),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: status }),
    });
    if (!res.ok) {
      throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data = await res.json();
    const postId = data?.data?.id || null;
    logger.info(`[twitter] tweet created: ${postId}`);
    return { platform: 'twitter', postId, success: true };
  }
}

module.exports = new TwitterService();
module.exports._test = { pctEncode, TWEETS_URL, TCO_URL_LENGTH, TWEET_LIMIT };
