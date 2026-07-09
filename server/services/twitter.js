/**
 * X (Twitter) posting service — publishes via Zernio (zernio.com), the same
 * social-publishing backend the daily content calendar uses.
 *
 * History: v1 posted straight to X's v2 create-Tweet endpoint with OAuth 1.0a
 * user-context creds. X's Feb-2026 switch to pay-per-use API credits closed
 * the free write path (every create 402'd CreditsDepleted), so posting now
 * rides the brand account's Zernio connection (flat per-account pricing —
 * no X credits involved). Zernio holds the X OAuth; we hold one API key.
 *
 * Env: ZERNIO_API_KEY (required).
 *      ZERNIO_TWITTER_ACCOUNT_ID (optional) pins the Zernio account id; when
 *      unset, the connected twitter account is discovered via GET /accounts
 *      and cached in-process.
 *      (TWITTER_BEARER_TOKEN remains the separate app-only READ credential
 *      used by the backlink-agent x-poller — X's write-credit change does not
 *      affect reads. The four TWITTER_* OAuth 1.0a write vars are retired.)
 *
 * Tweets go out as text + article URL: X wraps every URL to a fixed-length
 * t.co link (23 chars against the 280 limit) and renders the link card from
 * the page's og:image, so no media upload is needed for blog shares.
 */

const logger = require('./logger');

const ZERNIO_API = 'https://zernio.com/api/v1';
// X counts every URL as a fixed t.co length regardless of the real URL.
const TCO_URL_LENGTH = 23;
const TWEET_LIMIT = 280;
const ACCOUNT_CACHE_MS = 10 * 60 * 1000;

class TwitterService {
  constructor() {
    this._account = { id: null, fetchedAt: 0 };
  }

  get configured() {
    return !!process.env.ZERNIO_API_KEY;
  }

  async _zernio(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${ZERNIO_API}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const bodyText = (await res.text()).slice(0, 500);
      const err = new Error(`Zernio ${method} /${path} ${res.status}: ${bodyText}`);
      err.status = res.status;
      err.bodyText = bodyText;
      throw err;
    }
    return res.json();
  }

  // The Zernio account id for the connected X profile. Pinned via env when
  // set; otherwise discovered from GET /accounts and cached (reconnecting the
  // X profile in the Zernio dashboard mints a new id, hence the TTL).
  async _resolveAccountId() {
    if (process.env.ZERNIO_TWITTER_ACCOUNT_ID) return process.env.ZERNIO_TWITTER_ACCOUNT_ID;
    if (this._account.id && Date.now() - this._account.fetchedAt < ACCOUNT_CACHE_MS) {
      return this._account.id;
    }
    const data = await this._zernio('accounts');
    const accounts = Array.isArray(data) ? data : (data?.accounts || []);
    // Healthy-connection filter (fields observed on the live accounts API):
    // an expired/reconnected profile leaves a stale sibling entry behind with
    // platformStatus off 'active', enabled=false, or intentionalDisconnectAt
    // set — those must never be selected or counted toward ambiguity.
    const matches = accounts.filter((a) => a?.platform === 'twitter' && a?._id
      && a?.isActive !== false && a?.enabled !== false
      && (a?.platformStatus == null || a.platformStatus === 'active')
      && !a?.intentionalDisconnectAt);
    if (!matches.length) {
      throw new Error('No active X (twitter) account connected in Zernio — connect one in the Zernio dashboard');
    }
    // Fail closed on ambiguity: a shared workspace with a second X profile
    // must never receive brand posts by list-order accident.
    if (matches.length > 1) {
      throw new Error('Multiple active X (twitter) accounts connected in Zernio — set ZERNIO_TWITTER_ACCOUNT_ID to pin the brand account');
    }
    this._account = { id: matches[0]._id, fetchedAt: Date.now() };
    return matches[0]._id;
  }

  _parseExistingPostId(bodyText) {
    try {
      const body = JSON.parse(bodyText);
      const id = body?.existingPostId || body?.details?.existingPostId
        || body?.post?._id || body?.error?.existingPostId;
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
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

  // Zernio accepts publish-now posts asynchronously: the create returns the
  // queued post, then a worker pushes it to X. Poll briefly for the terminal
  // per-platform status so a platform-side rejection surfaces here as a
  // partial failure (same reason the old direct path surfaced X's 402s)
  // instead of dying silently in the queue. Still-pending after the budget is
  // treated as accepted — the Zernio dashboard is the async monitor surface.
  // The budget is WALL-CLOCK, and status reads use a short per-read timeout:
  // hung reads must never stretch an already-created post into a long
  // publish block for the calling request.
  async _waitForPlatformResult(postId, { budgetMs = 12000, delayMs = 2000, readTimeoutMs = 3000 } = {}) {
    const deadline = Date.now() + budgetMs;
    let last = null;
    while (Date.now() + delayMs < deadline) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      let data;
      try {
        data = await this._zernio(`posts/${postId}`, { timeoutMs: readTimeoutMs });
      } catch (err) {
        // Transient read failures never fail the (already-created) post.
        logger.warn(`[twitter] Zernio status read failed for ${postId}: ${err.message}`);
        continue;
      }
      const post = data?.post || data;
      last = (post?.platforms || []).find((p) => p?.platform === 'twitter') || null;
      const status = String(last?.status || post?.status || '').toLowerCase();
      if (status === 'published') return last;
      if (status === 'failed' || status === 'error') {
        throw new Error(`Zernio X publish failed: ${(last?.error || post?.error || status).toString().slice(0, 300)}`);
      }
    }
    logger.info(`[twitter] Zernio post ${postId} still pending at the ${budgetMs}ms poll budget — treating as accepted`);
    return last;
  }

  async createPost({ text, link } = {}) {
    if (!this.configured) {
      throw new Error('X (Twitter) posting not configured (ZERNIO_API_KEY)');
    }
    const status = this.composeTweet(text, link);
    if (!status) throw new Error('X post requires text');

    const accountId = await this._resolveAccountId();
    // NOT retried: like the direct create-Tweet call this replaced, publish
    // is non-idempotent — a lost response on a successful create would
    // duplicate the tweet.
    let created;
    try {
      created = await this._zernio('posts', {
        method: 'POST',
        body: {
          content: status,
          platforms: [{ platform: 'twitter', accountId }],
          publishNow: true,
        },
      });
    } catch (err) {
      // Zernio dedupes identical content by hash: a replayed create (e.g. an
      // operator channel-retry after a lost response) 409s with the id of the
      // post that already exists. Converge on that post instead of recording
      // a permanent failure the retry path could never clear.
      const existingId = err.status === 409 ? this._parseExistingPostId(err.bodyText) : null;
      if (!existingId) throw err;
      logger.info(`[twitter] Zernio deduped a replayed create → existing post ${existingId}`);
      created = { post: { _id: existingId } };
    }
    const zernioPostId = (created?.post || created)?._id;
    if (!zernioPostId) {
      throw new Error(`Zernio create returned no post id: ${JSON.stringify(created).slice(0, 300)}`);
    }

    const platformEntry = await this._waitForPlatformResult(zernioPostId);
    const postId = platformEntry?.platformPostId || zernioPostId;
    logger.info(`[twitter] tweet created via Zernio: ${postId} (zernio post ${zernioPostId})`);
    return { platform: 'twitter', postId, success: true };
  }
}

module.exports = new TwitterService();
module.exports._test = { ZERNIO_API, TCO_URL_LENGTH, TWEET_LIMIT };
