// Lazy-load googleapis (~71MB) — only when GBP methods are called
let _googleapis;
function getGoogle() {
  if (!_googleapis) { try { _googleapis = require('googleapis').google; } catch { _googleapis = null; } }
  return _googleapis;
}
const logger = require('./logger');
const db = require('../models/db');
const { WAVES_LOCATIONS } = require('../config/locations');
const MODELS = require('../config/models');
const NotificationService = require('./notification-service');
const { runExclusive } = require('../utils/cron-lock');
const { DRAFT_REPLY_PREFIX } = require('./review-reply/draft-prefix');

function starRatingToNumber(value) {
  if (typeof value === 'number') return value;
  const map = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return map[String(value || '').toUpperCase()] || 0;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return null;
}

function sameReviewerAndTime(row, reviewerName, createdAt, maxDriftMs = 24 * 60 * 60 * 1000) {
  if (!row?.reviewer_name || !row?.review_created_at || !reviewerName || !createdAt) return false;
  const rowTime = new Date(row.review_created_at).getTime();
  const reviewTime = new Date(createdAt).getTime();
  if (!Number.isFinite(rowTime) || !Number.isFinite(reviewTime)) return false;
  return row.reviewer_name.toLowerCase() === reviewerName.toLowerCase() &&
    Math.abs(rowTime - reviewTime) <= maxDriftMs;
}

/**
 * Google Business Profile service — fully separate credentials per account.
 *
 * Each location has its own Google Cloud project with its own OAuth2 Client ID,
 * Secret, and Refresh Token:
 *
 *   GBP_CLIENT_ID_LWR / GBP_CLIENT_SECRET_LWR / GBP_REFRESH_TOKEN_LWR
 *   GBP_CLIENT_ID_PARRISH / GBP_CLIENT_SECRET_PARRISH / GBP_REFRESH_TOKEN_PARRISH
 *   GBP_CLIENT_ID_SARASOTA / GBP_CLIENT_SECRET_SARASOTA / GBP_REFRESH_TOKEN_SARASOTA
 *   GBP_CLIENT_ID_VENICE / GBP_CLIENT_SECRET_VENICE / GBP_REFRESH_TOKEN_VENICE
 */

const LOCATION_ENV_KEYS = {
  'bradenton': 'LWR',
  'parrish': 'PARRISH',
  'sarasota': 'SARASOTA',
  'venice': 'VENICE',
};

function tokenSettingsKey(locationId) {
  return `gbp.oauth_tokens.${locationId}`;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Google's review feed returns very fresh reviews inconsistently: a review a
// few hours old can be present in one pull and absent from the next while
// Google's replication/spam screening settles, then reappear (2026-08-13: a
// 2.5h-old review vanished from the 20:00Z pull, rang the removal alert, and
// was back by 00:00Z). The missing-review reconcile therefore ignores rows
// whose review is younger than this window — a genuinely removed new review
// still stamps (and alerts) on the first reconcile after the window ends.
const MISSING_REVIEW_GRACE_MS = 48 * 60 * 60 * 1000;

// Google's My Business v4 endpoints normally return JSON, but when the OAuth
// client lives in a project where the API isn't enabled — or hits a redirect
// chain — they sometimes return 2xx with an HTML body. Parsing that as JSON
// produces an opaque SyntaxError that bubbles up to the user as "Unexpected
// token '<'". Read as text first, only JSON.parse when the body looks like
// JSON, and surface the raw status + a truncated body on anything else.
async function readJsonOrThrow(res, label) {
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) {
    throw new Error(`${label} ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!ct.includes('application/json') && !text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
    throw new Error(`${label} returned non-JSON response (status ${res.status}, content-type ${ct || 'unknown'}): ${text.slice(0, 500)}`);
  }
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${label} returned malformed JSON (status ${res.status}): ${e.message}`); }
}

class GoogleBusinessService {
  constructor() {
    // Check if any location has OAuth client credentials. Refresh tokens are
    // NOT required here: they live in system_settings (written by the admin
    // connect flow) and are resolved per-location in _getClient at call time.
    this.configured = Object.values(LOCATION_ENV_KEYS).some(key =>
      process.env[`GBP_CLIENT_ID_${key}`] &&
      process.env[`GBP_CLIENT_SECRET_${key}`]
    );

    const domain = process.env.SERVER_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || 'portal.wavespestcontrol.com';
    this.redirectUri = process.env.GBP_REDIRECT_URI || `https://${domain}/api/admin/settings/google/callback`;

    // Cache of OAuth2 clients per location
    this._clients = {};

    if (!this.configured) {
      logger.warn('[gbp] No GBP OAuth client credentials found for any location — Google Business Profile disabled');
    }
  }

  /**
   * Get an OAuth2 client for a specific location.
   * Each location has its own Client ID, Secret, and Refresh Token.
   */
  async _getStoredTokens(locationId) {
    try {
      const row = await db('system_settings')
        .where({ key: tokenSettingsKey(locationId) })
        .first();
      return parseJsonObject(row?.value);
    } catch (err) {
      logger.warn(`[gbp] Stored token lookup failed for ${locationId}: ${err.message}`);
      return {};
    }
  }

  async storeTokens(locationId, tokens = {}, options = {}) {
    const envKey = LOCATION_ENV_KEYS[locationId];
    if (!envKey) throw new Error(`Unknown location: ${locationId}`);

    const existing = options.merge ? await this._getStoredTokens(locationId) : {};
    const refreshToken = tokens.refresh_token || existing.refresh_token || process.env[`GBP_REFRESH_TOKEN_${envKey}`] || null;
    if (!refreshToken) {
      throw new Error('Google did not return a GBP refresh token. Revoke the app grant and start OAuth again.');
    }

    const now = new Date();
    const tokenRecord = {
      refresh_token: refreshToken,
      access_token: tokens.access_token || existing.access_token || null,
      token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : existing.token_expires_at || null,
      scope: tokens.scope || existing.scope || null,
      token_type: tokens.token_type || existing.token_type || null,
      updated_at: now.toISOString(),
    };

    await db('system_settings')
      .insert({
        key: tokenSettingsKey(locationId),
        value: JSON.stringify(tokenRecord),
        category: 'integrations',
        description: `Google Business Profile OAuth tokens for ${locationId}`,
        created_at: now,
        updated_at: now,
      })
      .onConflict('key')
      .merge({
        value: JSON.stringify(tokenRecord),
        category: 'integrations',
        description: `Google Business Profile OAuth tokens for ${locationId}`,
        updated_at: now,
      });

    delete this._clients[locationId];
    this.configured = true;

    return {
      connected: true,
      locationId,
      tokenExpiresAt: tokenRecord.token_expires_at,
      hasRefreshToken: true,
    };
  }

  async _getClient(locationId) {
    if (this._clients[locationId]) return this._clients[locationId];

    const envKey = LOCATION_ENV_KEYS[locationId];
    if (!envKey) return null;

    const clientId = process.env[`GBP_CLIENT_ID_${envKey}`];
    const clientSecret = process.env[`GBP_CLIENT_SECRET_${envKey}`];
    const storedTokens = await this._getStoredTokens(locationId);
    const refreshToken = storedTokens.refresh_token || process.env[`GBP_REFRESH_TOKEN_${envKey}`];

    if (!clientId || !clientSecret || !refreshToken) return null;

    const client = new (getGoogle()).auth.OAuth2(clientId, clientSecret, this.redirectUri);
    const expiryDate = storedTokens.token_expires_at ? new Date(storedTokens.token_expires_at).getTime() : undefined;
    client.setCredentials({
      refresh_token: refreshToken,
      access_token: storedTokens.access_token || undefined,
      expiry_date: Number.isFinite(expiryDate) ? expiryDate : undefined,
    });
    client.on('tokens', async (tokens) => {
      try {
        await this.storeTokens(locationId, tokens, { merge: true });
      } catch (err) {
        logger.warn(`[gbp] Token refresh persistence failed for ${locationId}: ${err.message}`);
      }
    });
    this._clients[locationId] = client;
    return client;
  }

  /**
   * Get auth headers for a specific location's Google account.
   */
  async _getHeaders(locationId) {
    const client = await this._getClient(locationId);
    if (!client) throw new Error(`No GBP credentials for location: ${locationId}`);
    const { token } = await client.getAccessToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  /**
   * Check which locations have credentials configured.
   */
  async getConfiguredLocations() {
    const configured = [];
    for (const loc of WAVES_LOCATIONS) {
      if (await this._getClient(loc.id)) configured.push(loc);
    }
    return configured;
  }

  /**
   * Whether a single location can actually publish: client ID/secret + a
   * refresh token (the same readiness _getClient enforces). Use this before
   * spending image-generation credits on a post bound to one location —
   * `this.configured` only proves *some* location has client creds, not the
   * target one.
   */
  async isLocationConfigured(locationId) {
    return !!(await this._getClient(locationId));
  }

  // =========================================================================
  // REVIEWS
  // =========================================================================
  async getReviews(locationResourceName, locationId, pageSize = 50, pageToken = null) {
    const headers = await this._getHeaders(locationId);
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `https://mybusiness.googleapis.com/v4/${locationResourceName}/reviews?${params.toString()}`;
    const res = await fetch(url, { headers });
    const data = await readJsonOrThrow(res, 'GBP getReviews');
    return data;
  }

  async getAllLocationReviews(locationResourceName, locationId, pageSize = 50) {
    const reviews = [];
    let pageToken = null;
    do {
      const page = await this.getReviews(locationResourceName, locationId, pageSize, pageToken);
      reviews.push(...(page.reviews || []));
      pageToken = page.nextPageToken || null;
    } while (pageToken);
    return reviews;
  }

  async getAllReviews(pageSize = 50) {
    const allReviews = [];
    for (const loc of WAVES_LOCATIONS) {
      if (!loc.googleLocationResourceName) continue;
      try {
        const reviews = await this.getAllLocationReviews(loc.googleLocationResourceName, loc.id, pageSize);
        reviews.forEach(r => allReviews.push({ ...r, _locationId: loc.id, _locationName: loc.name }));
      } catch (err) {
        logger.error(`Failed to fetch reviews for ${loc.name}: ${err.message}`);
      }
    }
    return allReviews;
  }

  // `signal` (AbortSignal) lets a caller with a total deadline actually cancel
  // the request instead of just racing a timer (auto-reply publisher).
  async replyToReview(reviewResourceName, replyText, locationId, { signal } = {}) {
    // Determine location from resource name if not provided
    if (!locationId) {
      const match = reviewResourceName.match(/accounts\/(\d+)\/locations\/(\d+)/);
      if (match) {
        const loc = WAVES_LOCATIONS.find(l => l.googleAccountId === match[1]);
        locationId = loc?.id || 'bradenton';
      }
    }
    const headers = await this._getHeaders(locationId);
    const url = `https://mybusiness.googleapis.com/v4/${reviewResourceName}/reply`;
    const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ comment: replyText }), ...(signal ? { signal } : {}) });
    return readJsonOrThrow(res, 'GBP replyToReview');
  }

  // Single-review read (v4 GET {name}) — used by the reply publisher to see
  // Google's CURRENT owner reply inside its publish claim, since the hourly
  // sync cannot close the "owner replied in Google after the last sync" gap.
  async getReview(reviewResourceName, locationId, { signal } = {}) {
    if (!locationId) {
      const match = reviewResourceName.match(/accounts\/(\d+)\/locations\/(\d+)/);
      if (match) {
        const loc = WAVES_LOCATIONS.find(l => l.googleAccountId === match[1]);
        locationId = loc?.id || 'bradenton';
      }
    }
    const headers = await this._getHeaders(locationId);
    const res = await fetch(`https://mybusiness.googleapis.com/v4/${reviewResourceName}`, { headers, ...(signal ? { signal } : {}) });
    return readJsonOrThrow(res, 'GBP getReview');
  }

  async deleteReply(reviewResourceName, locationId, { signal } = {}) {
    if (!locationId) {
      const match = reviewResourceName.match(/accounts\/(\d+)\/locations\/(\d+)/);
      if (match) {
        const loc = WAVES_LOCATIONS.find(l => l.googleAccountId === match[1]);
        locationId = loc?.id || 'bradenton';
      }
    }
    const headers = await this._getHeaders(locationId);
    const url = `https://mybusiness.googleapis.com/v4/${reviewResourceName}/reply`;
    const res = await fetch(url, { method: 'DELETE', headers, ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GBP deleteReply ${res.status}: ${text.slice(0, 500)}`);
    }
    return true;
  }

  // =========================================================================
  // LOCATION METRICS
  // =========================================================================
  async getLocationDetails(locationResourceName, locationId) {
    const headers = await this._getHeaders(locationId);
    const url = `https://mybusiness.googleapis.com/v4/${locationResourceName}`;
    const res = await fetch(url, { headers });
    return readJsonOrThrow(res, 'GBP getLocationDetails');
  }

  // =========================================================================
  // GOOGLE POSTS
  // =========================================================================
  async createPost(locationResourceName, { summary, callToAction, mediaUrl }, locationId) {
    const headers = await this._getHeaders(locationId);
    const url = `https://mybusiness.googleapis.com/v4/${locationResourceName}/localPosts`;
    const body = { languageCode: 'en', summary, topicType: 'STANDARD' };
    if (callToAction) body.callToAction = callToAction;
    if (mediaUrl) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: mediaUrl }];
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return readJsonOrThrow(res, 'GBP createPost');
  }

  /**
   * List recent local posts for a location (newest first). Read-only.
   * Each post carries a public `searchUrl` (the post as it appears on the
   * profile) plus optional media. Used by the public /social feed.
   */
  async listLocalPosts(locationResourceName, locationId, pageSize = 5) {
    const headers = await this._getHeaders(locationId);
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    const url = `https://mybusiness.googleapis.com/v4/${locationResourceName}/localPosts?${params.toString()}`;
    const res = await fetch(url, { headers });
    const data = await readJsonOrThrow(res, 'GBP listLocalPosts');
    return Array.isArray(data.localPosts) ? data.localPosts : [];
  }

  _normalizeGbpReview(review, loc) {
    const ownerReply = firstDefined(review.reviewReply?.comment, review.ownerResponse?.comment, review.owner_response?.text);
    return {
      google_review_id: review.name,
      gbp_review_name: review.name,
      location_id: loc.id,
      reviewer_name: review.reviewer?.displayName || 'Anonymous',
      reviewer_photo_url: firstDefined(review.reviewer?.profilePhotoUrl, review.reviewer?.profile_photo_url, null),
      star_rating: starRatingToNumber(review.starRating),
      review_text: firstDefined(review.comment, review.text, null),
      review_created_at: firstDefined(review.createTime, review.updateTime, new Date().toISOString()),
      owner_reply: ownerReply,
      owner_reply_updated_at: ownerReply ? firstDefined(review.reviewReply?.updateTime, review.ownerResponse?.updateTime, new Date().toISOString()) : null,
    };
  }

  async _findCustomerIdByReviewerName(reviewerName) {
    if (!reviewerName || reviewerName === 'Anonymous') return null;
    // Exclude soft-deleted customers: linking a review to a deleted record
    // would silently suppress both the auto-mark (the flip no-ops on
    // deleted_at) AND the unlinked-review alert, dropping the review from the
    // manual-match queue. Treating a deleted-only name match as "no match"
    // routes it to the admin notification instead.
    //
    // Require an UNAMBIGUOUS match. Google display names are not unique, so if
    // two active customers share the reviewer's name we can't tell which one
    // actually left the review. Auto-marking an arbitrary one would suppress
    // review outreach (initial ask, inline suffix, 48h followup) for a customer
    // who never reviewed. Treat 2+ matches as "no match" so the review falls
    // through to the manual-match alert instead of an arbitrary auto-link.
    // limit(2) is all we need to detect ambiguity.
    //
    // Match on first + last name TOKEN, tolerating middle names/initials and
    // punctuation in the Google display name — "Michael P. Fossier" must
    // match customer "Michael Fossier" (prod miss 2026-07-10). Single-token
    // display names can't produce a confident match and fall through to the
    // manual queue.
    const tokens = String(reviewerName)
      .replace(/[.,]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length < 2) return null;

    // TIER 1 — exact full-name equality (the original rule). Checked FIRST
    // and on its own: an exact "Mary Ann Smith" row must win even when the
    // looser token arm would ALSO match a "Mary Smith" row and read as
    // ambiguous (Codex round-2). Two exact rows are still ambiguous.
    const exact = await db('customers')
      .whereNull('deleted_at')
      .whereRaw("LOWER(TRIM(first_name || ' ' || COALESCE(last_name, ''))) = LOWER(?)", [reviewerName])
      .select('id')
      .limit(2);
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) {
      logger.info('[gbp] Reviewer name matched multiple active customers — routing to manual match, no auto-mark');
      return null;
    }

    // TIER 2 — token match, tolerating middle names/initials and punctuation
    // ("Michael P. Fossier" → customer "Michael Fossier", prod miss
    // 2026-07-10). The joined-leading-tokens arm keeps two-word first names
    // matching. Same unambiguous-match guard.
    const firstToken = tokens[0];
    const leadingTokens = tokens.slice(0, -1).join(' ');
    const lastToken = tokens[tokens.length - 1];
    const matches = await db('customers')
      .whereNull('deleted_at')
      .whereRaw('(LOWER(TRIM(first_name)) = LOWER(?) OR LOWER(TRIM(first_name)) = LOWER(?))', [firstToken, leadingTokens])
      .whereRaw("LOWER(TRIM(COALESCE(last_name, ''))) = LOWER(?)", [lastToken])
      .select('id')
      .limit(2);
    if (matches.length !== 1) {
      if (matches.length > 1) {
        // ID-less log — reviewer names are PII (AGENTS.md); the name rides in
        // the unlinked-review admin notification, not the plaintext log.
        logger.info('[gbp] Reviewer name matched multiple active customers — routing to manual match, no auto-mark');
      }
      // NO surname-initial expansion ("Michael F." → Michael Fossier): an
      // initial is too weak an identity to auto-attribute (any stranger can
      // share it — pre-push P1 ×3). Truncated display names are exactly what
      // the click auto-link handles without needing the name at all; the
      // rest stay in the manual queue with the likely-reviewer suggestions.
      return null;
    }
    return matches[0].id;
  }

  /**
   * Auto-flip a matched customer's "already left a Google review" flag when a
   * review of theirs syncs in. Same effect as the Customer 360 toggle / the
   * one-shot backfill endpoint: the customer is then skipped by the
   * review-request cron — no initial request, no inline suffix, no 48h
   * followup (review-request.js gates on has_left_google_review).
   *
   * Idempotent: only writes when the flag is currently false/null, so the
   * original review_marked_at is preserved and repeat hourly syncs are no-ops.
   * Best-effort — never throws into the sync loop (CLAUDE.md Rule 6).
   *
   * @param {number} customerId  matched customer id (falsy = skip)
   * @returns {Promise<boolean>} true when this call flipped the flag
   */
  async _markCustomerLeftReview(customerId) {
    if (!customerId) return false;
    try {
      const flipped = await db('customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .where(function () {
          this.where('has_left_google_review', false).orWhereNull('has_left_google_review');
        })
        .update({ has_left_google_review: true, review_marked_at: new Date() });
      if (flipped > 0) {
        logger.info(`[gbp] Auto-marked customer ${customerId} as already-left-review — excluded from review-request + 48h followup`);
        try {
          await db('activity_log').insert({
            customer_id: customerId,
            action: 'review_auto_marked',
            description: 'Auto-marked "already left a Google review" — a matched Google review synced in. Now excluded from review-request and 48h follow-up SMS.',
          });
        } catch { /* best-effort audit trail */ }
      }
      return flipped > 0;
    } catch (err) {
      logger.warn(`[gbp] Auto-mark left-review failed for customer ${customerId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Surface a freshly-synced Google review we couldn't tie to a customer so the
   * office can match it (or manually mark the customer as already-reviewed).
   * Fires once, on first insert only — callers gate on the new-review branch so
   * repeat hourly syncs don't re-notify. Best-effort (notifyAdmin self-catches).
   *
   * @param {{reviewer_name?:string, star_rating?:number, review_text?:string, location_id?:string, google_review_id?:string, review_created_at?:string}} row
   */
  async _notifyUnlinkedReview(row) {
    try {
      const loc = WAVES_LOCATIONS.find(l => l.id === row.location_id);
      const locName = loc?.name || row.location_id || 'Unknown location';
      const stars = Number(row.star_rating) || 0;
      const reviewer = row.reviewer_name || 'Anonymous';
      const snippet = row.review_text ? ` — "${String(row.review_text).slice(0, 120)}"` : '';
      // Click-time detective work: customers whose tracked review-link click
      // landed near this review's timestamp. Suggestion only — the office
      // confirms via the manual match flow; nothing is auto-linked.
      const { findLikelyReviewers } = require('./review-click-correlation');
      const likely = await findLikelyReviewers(row, { limit: 3 });
      let likelyLine = '';
      if (likely.length) {
        const top = likely[0];
        const topName = [top.firstName, top.lastName].filter(Boolean).join(' ') || 'a customer';
        const more = likely.length > 1 ? ` (+${likely.length - 1} more in Reviews)` : '';
        likelyLine = ` Likely reviewer: ${topName} tapped their review link ${top.clickOffsetLabel} this review posted${more}.`;
      }
      await NotificationService.notifyAdmin(
        'review',
        `Unlinked Google review from ${reviewer}`,
        `${stars}-star review at ${locName} couldn't be matched to a customer${snippet}. Open Reviews to match it, or mark the customer as already-reviewed.${likelyLine}`,
        {
          link: '/admin/reviews',
          metadata: {
            googleReviewId: row.google_review_id || null,
            locationId: row.location_id || null,
            reviewerName: reviewer,
            starRating: stars,
            reason: 'no_customer_match',
            likelyReviewers: likely.map(l => ({
              customerId: l.customerId,
              name: [l.firstName, l.lastName].filter(Boolean).join(' ') || null,
              clickedAt: l.clickedAt,
              clickOffsetLabel: l.clickOffsetLabel,
              locationMatch: l.locationMatch,
            })),
          },
        },
      );
      // ID-only logging — reviewer display names are PII (AGENTS.md). The
      // name rides in the admin notification, not the plaintext log.
      logger.info(`[gbp] Unlinked review (${row.google_review_id || 'unknown id'}) at ${locName} — admin notified`);
    } catch (err) {
      logger.warn(`[gbp] Unlinked-review notify failed: ${err.message}`);
    }
  }

  /**
   * GATE_REVIEW_CLICK_AUTOLINK: link an unlinked review to the ONE customer
   * whose tracked review-link click confidently explains it (sole clicker in
   * the correlation window, location match, tight before-window — see
   * findConfidentClickMatch). Runs from the deferred end-of-batch phase so
   * the sole-clicker exclusion sees the whole batch's links, and re-reads
   * the live row so a manual match landed mid-sync always wins.
   *
   * @param {{google_review_id?: string, reviewer_name?: string, location_id?: string, review_created_at?: string}} row
   * @returns {Promise<boolean>} true when linked (caller skips the
   *   unlinked-review notification); false on gate-off, ambiguity, a lost
   *   race, or any error — failure routes to the manual queue, never a guess.
   */
  async _attemptClickAutoLink(row) {
    try {
      const { isEnabled } = require('../config/feature-gates');
      if (!isEnabled('reviewClickAutoLink')) return false;
      if (!row?.google_review_id || !row?.location_id) return false;
      // Everything — correlation, liveness read, write, side effects — runs
      // under the SAME per-location advisory lock manual attribution holds
      // (review-incentives.js, pre-push P1 r3/r4): the sole-clicker check
      // must not go stale before the write, and a manual match must never
      // interleave between the link and its flag-flip/thank-you. Lock
      // contention (another mutator active) = fall to the manual queue.
      const outcome = await runExclusive(`gbp-review-sync:${row.location_id}`, async () => {
        const { findConfidentClickMatch, AUTO_LINK_MAX_BEFORE_MS } = require('./review-click-correlation');
        // Evidence checks + guarded write in ONE transaction: the
        // correlation runs against the same snapshot the write commits
        // against, so a click committed since the flush was queued is seen
        // here (pre-push P1 r5), and the correlation must run BEFORE the
        // update — after it, the just-linked customer would vanish from its
        // own candidate set and the recheck would reject every link
        // (pre-push P1 r7; the mocked-correlation tests couldn't catch
        // that — MOCK ≠ prod).
        // ACCEPTED RESIDUAL: a click that commits between this transaction's
        // snapshot and its commit is invisible — the window is milliseconds,
        // the link is undoable in Reviews, and serializing the
        // customer-facing /go redirect behind sync locks would trade a
        // paper-thin race for real latency.
        let result;
        try {
          result = await db.transaction(async (trx) => {
          const match = await findConfidentClickMatch(row, { conn: trx });
          if (!match) return { nomatch: true };
          // The collector entry is a detached payload — re-read the live row.
          const live = await trx('google_reviews')
            .where({ google_review_id: row.google_review_id })
            .first('id', 'customer_id', 'missing_since', 'star_rating', 'location_id');
          // Vanished or removal-stamped since the collector queued it: the
          // review is no longer live, so the match-this bell would point at
          // an unusable flow (the removal alert already rang) — handled,
          // not ambiguous (GH codex #3483 r4).
          if (!live || live.missing_since) return { handled: true };
          // Linked since insert (manual match mid-sync): nothing to do, and
          // a "come match this" bell for an already-matched review is pure
          // noise — handled, so the caller skips the unlinked notification.
          if (live.customer_id) return { handled: true };
          // One click must correspond to ONE eligible review (pre-push P1
          // r6): if another unlinked review at this location also sits
          // inside the click's forward window, the click can't say which of
          // them the customer wrote — whichever processed first would steal
          // it. JS-side id filter so mocked whereNot can't drop the guard.
          const clickedAtMs = new Date(match.clickedAt).getTime();
          const windowRows = await trx('google_reviews')
            .whereNull('customer_id')
            .whereNull('missing_since')
            .where('location_id', row.location_id)
            .whereRaw("(reviewer_name IS NULL OR reviewer_name != '_stats')")
            .where('review_created_at', '>=', new Date(clickedAtMs))
            .where('review_created_at', '<=', new Date(clickedAtMs + AUTO_LINK_MAX_BEFORE_MS))
            .limit(10)
            .select('id');
          if (windowRows.some((r) => r.id !== live.id)) return { nomatch: true };
          // Conditional-write guards (pre-push P1 r2): a manual match or a
          // removal-reconcile stamp that committed before the lock was free
          // must win at the atomic write. Zero rows = a manual link stands
          // or the review is gone; either way the unlinked bell is noise.
          // One Date for the link stamp AND the flag mark below: the
          // reversal ownership check compares them for equality — a LATER
          // human mark bumps review_marked_at past auto_linked_at and wins.
          const markTime = new Date();
          const updated = await trx('google_reviews')
            .where({ id: live.id })
            .whereNull('customer_id')
            .whereNull('missing_since')
            .update({ customer_id: match.customerId, link_source: 'click_auto', auto_linked_at: markTime });
          if (!updated) return { handled: true };
          // Suppression flip in the SAME transaction (pre-push P1): a
          // linked review with a still-false flag would keep asking the
          // customer forever — the retry sweep only scans UNLINKED rows —
          // so a failed flip must roll the link back for the next sweep.
          // Zero rows = the flag was claimed by a HUMAN between the
          // correlation read and this write (correlation refuses
          // already-flagged candidates), so ownership would be ambiguous —
          // abort the link toward the manual queue (GH codex #3483 r7).
          const flipped = await trx('customers')
            .where({ id: match.customerId })
            .whereNull('deleted_at')
            .where(function alreadyFlagged() {
              this.where('has_left_google_review', false).orWhereNull('has_left_google_review');
            })
            .update({ has_left_google_review: true, review_marked_at: markTime });
          if (!flipped) {
            const raceErr = new Error('suppression flag claimed concurrently');
            raceErr.code = 'FLAG_CLAIM_RACE';
            throw raceErr;
          }
          return { linked: true, match, live };
          });
        } catch (err) {
          if (err?.code === 'FLAG_CLAIM_RACE') return { nomatch: true };
          throw err;
        }
        if (!result?.linked) return result;
        // The flag flip committed atomically with the link above. NO
        // thank-you enrollment here — like the payout (pre-push P0),
        // customer-facing copy waits for the human confirm: a wrong
        // probabilistic link must never text "thanks for your review" to
        // someone who didn't write it, and a re-match can't reliably claw
        // back an already-active enrollment (GH codex r2 P1).
        // manualAttributeGoogleReview enrolls on confirm.
        // Best-effort audit trail, mirroring _markCustomerLeftReview.
        try {
          await db('activity_log').insert({
            customer_id: result.match.customerId,
            action: 'review_auto_marked',
            description: 'Click auto-link — marked "already left a Google review"; review asks stop pending human confirm in Reviews.',
          });
        } catch { /* audit only */ }
        return result;
      }, { recordHealth: false });
      if (outcome?.skipped || outcome?.nomatch) return false;
      if (!outcome?.linked) return true;
      const match = outcome.match;
      // FYI bell (exception-based ops): say WHAT linked and WHY so a wrong
      // match is one glance + one manual re-match away, not silent.
      try {
        const stars = Number(row.star_rating) || 0;
        await NotificationService.notifyAdmin(
          'review',
          `Auto-linked Google review from ${row.reviewer_name || 'Anonymous'}`,
          `${stars}-star review was linked by click tracking: the customer tapped their review link ${match.clickOffsetLabel} this review posted (only click in the window, same location). Wrong match? Re-match it in Reviews.`,
          {
            link: '/admin/reviews',
            metadata: {
              googleReviewId: row.google_review_id,
              customerId: match.customerId,
              clickedAt: match.clickedAt,
              clickOffsetLabel: match.clickOffsetLabel,
              reason: 'click_auto_link',
            },
          },
        );
      } catch { /* best-effort — the link itself already stands */ }
      // ID-only logging (AGENTS.md) — reviewer display names are PII.
      logger.info(`[gbp] Click auto-link: review ${row.google_review_id} → customer ${match.customerId} (${match.clickOffsetLabel})`);
      return true;
    } catch (err) {
      logger.warn(`[gbp] Click auto-link failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Retry the confident click auto-link over reviews that synced in unlinked
   * on EARLIER runs — a click stamped after a review's first sync (rate-page
   * fallback, delayed tap) can turn a parked review decidable later. Runs at
   * the end of each batch sync; idempotent (linked rows drop out of the
   * unlinked set), capped, and per-row failures never break the sync.
   */
  async _retryUnlinkedReviewAutoLink() {
    try {
      const { isEnabled } = require('../config/feature-gates');
      if (!isEnabled('reviewClickAutoLink')) return;
      const rows = await db('google_reviews')
        .whereNull('customer_id')
        .whereNull('missing_since')
        .whereNotNull('google_review_id')
        .whereRaw("(reviewer_name IS NULL OR reviewer_name != '_stats')")
        .whereNot('google_review_id', 'like', 'places_stats_%')
        .where('review_created_at', '>=', new Date(Date.now() - 90 * 24 * 3600 * 1000))
        .orderBy('review_created_at', 'desc')
        // Runaway guard, not a work queue: 90d of real review volume is a
        // few dozen rows, so every unlinked review in the window is examined
        // each run — the cap only bites on pathological data (pre-push P1:
        // a tight newest-first cap would permanently starve older rows).
        .limit(200)
        .select('google_review_id', 'reviewer_name', 'location_id', 'review_created_at', 'star_rating');
      for (const row of rows) {
        await this._attemptClickAutoLink(row);
      }
    } catch (err) {
      logger.warn(`[gbp] Unlinked-review auto-link retry failed: ${err.message}`);
    }
  }

  async _findExistingReview(normalized) {
    let existing = await db('google_reviews').where({ gbp_review_name: normalized.gbp_review_name }).first();
    if (existing) return existing;
    existing = await db('google_reviews').where({ google_review_id: normalized.google_review_id }).first();
    if (existing) return existing;
    // The fuzzy name+time fallback must never match a stamped row: a
    // different account posting under the same display name within the
    // time tolerance would hijack the retained evidence row — the upsert
    // would overwrite it and the reinstatement clear would drop its stamp.
    // Stamped rows are only reachable via the stable GBP identity lookups
    // above (a genuine reinstatement keeps its review ID); anything else
    // inserts as a distinct review.
    const candidates = await db('google_reviews')
      .where({ location_id: normalized.location_id })
      .where('reviewer_name', '!=', '_stats')
      .whereNull('missing_since')
      .select('id', 'reviewer_name', 'review_created_at');
    const hit = candidates.find(row => sameReviewerAndTime(row, normalized.reviewer_name, normalized.review_created_at));
    // Callers read the FULL row (reply, draft/auto-reply state, publish
    // claim) off `existing` — the fuzzy candidate projection above is not it.
    return hit ? (await db('google_reviews').where({ id: hit.id }).first()) || null : null;
  }

  // A reviewer edit (rating / text / name) on a review the auto-reply lane
  // has touched: a POSTED reply may no longer fit (5★ praise → 1★
  // complaint) — park it for a person; a pipeline-owned DRAFT was written
  // for the old review — clear it and requeue (no bell: the runner redrafts).
  // Compare-and-set on the state the snapshot saw. Shared by the GBP upsert
  // and the Places fallback.
  async _reconcileReviewEdit(existing, normalized, { conn = db, bell = true } = {}) {
    const { applyReviewEditFields } = require('./review-reply/runner');
    const wasPosted = existing.auto_reply_status === 'posted';
    const n = await applyReviewEditFields(existing.id, existing, normalized, { conn });
    if (n === 0) return false;
    if (!wasPosted) return true;
    // Inside a caller's transaction the bell is deferred to after commit
    // (see _bellEditedAfterPost); the Places path bells inline.
    if (!bell) return 'posted_parked';
    await this._bellEditedAfterPost(existing, normalized);
    return true;
  }

  async _bellEditedAfterPost(existing, normalized) {
    // One bell for every "review changed under a posted reply" path
    // (sync edit here, manual re-attribution in review-incentives).
    const { notifyReviewEditedAfterPost } = require('./review-reply/runner');
    await notifyReviewEditedAfterPost(existing, { location_id: normalized.location_id, star_rating: normalized.star_rating, cause: 'edit' });
    return true;
  }

  async _upsertGbpReview(normalized, syncStart = null, pendingUnlinkedNotifications = null, pendingRestoredNotifications = null) {
    const existing = await this._findExistingReview(normalized);
    const customerId = await this._findCustomerIdByReviewerName(normalized.reviewer_name);
    // Reply fields from the feed snapshot — deferred under a live publish
    // claim, replacing a local draft when Google has an owner reply, and
    // preserving a draft against an empty feed (services/review-reply/runner).
    const { syncReplyFields, applySyncReplyFields } = require('./review-reply/runner');
    // Existing rows: reply fields are written by applySyncReplyFields as a
    // separate statement conditioned on the publish claim at write time.
    // New rows carry them in the insert (no claim can exist yet).
    const existingReplyFields = existing ? syncReplyFields(existing, normalized, { fnNow: db.fn.now() }) : null;
    const replyFields = existing
      ? {}
      : {
          review_reply: normalized.owner_reply,
          reply_updated_at: normalized.owner_reply ? normalized.owner_reply_updated_at || db.fn.now() : null,
        };
    const row = {
      google_review_id: normalized.google_review_id,
      gbp_review_name: normalized.gbp_review_name,
      location_id: normalized.location_id,
      reviewer_name: normalized.reviewer_name,
      reviewer_photo_url: normalized.reviewer_photo_url,
      star_rating: normalized.star_rating,
      review_text: normalized.review_text,
      review_created_at: normalized.review_created_at,
      // Existing link FIRST: once a review is attributed (manual, click
      // auto-link, or an earlier name match) a later sync's name match must
      // never silently reassign it — that would strand the original
      // customer's suppression flag with no provenance-aware reversal (GH
      // codex #3483 r1 P2). Corrections go through manual attribution only.
      customer_id: existing?.customer_id || customerId || null,
      // One clock authority for the reconcile ordering tokens: synced_at is
      // compared against runner fetch-start timestamps (Node clock), so it
      // must come from the same clock — db.fn.now() (Postgres) behind the
      // app clock would make rows refreshed THIS run satisfy
      // `synced_at < syncStart` and let the reconcile stamp every returned
      // review. "Live as of this runner's fetch start" is also the honest
      // assertion — the feed was fetched then, not at write time.
      synced_at: syncStart ? new Date(syncStart).toISOString() : db.fn.now(),
      ...replyFields,
    };
    // Monotonic liveness: an older overlapping runner must never regress a
    // newer runner's synced_at — writing its earlier fetch start over a
    // fresher token would make the newer runner's reconcile see
    // `synced_at < syncStart` and falsely stamp a review both feeds
    // returned. GREATEST makes the write a no-op unless it advances.
    const monotonicSyncedAt = syncStart
      ? db.raw('GREATEST(COALESCE(synced_at, to_timestamp(0)), ?::timestamptz)', [new Date(syncStart).toISOString()])
      : db.fn.now();
    let result;
    if (existing) {
      // A Places-first row that parked waiting for its GBP identity re-enters
      // the auto-reply queue once this authoritative sync attaches the name.
      const { applyRequeueOnIdentity } = require('./review-reply/runner');
      // Content update + reply sync + reviewer-edit reconciliation commit
      // TOGETHER: if the edit's park/requeue were written after the content
      // in a separate statement, a crash in between would leave the next
      // sync seeing the edited text as the existing fingerprint (no change
      // detected) and a posted reply attached to a rewritten review.
      const edited = await db.transaction(async (trx) => {
        // The row as it is NOW, locked for this transaction (hook P1): a
        // publisher can move it queued/drafted → posted between the pre-
        // transaction snapshot and here; reconciling against the stale
        // snapshot would CAS zero rows and leave a now-stale reply 'posted'.
        const live = (await trx('google_reviews').where({ id: existing.id }).forUpdate().first()) || existing;
        await trx('google_reviews').where({ id: existing.id }).update({ ...row, synced_at: monotonicSyncedAt });
        // Conditional on the row STILL being parked for that reason (an admin
        // Skip in the meantime wins).
        await applyRequeueOnIdentity(existing.id, live, normalized, { conn: trx });
        const liveReplyFields = syncReplyFields(live, normalized, { fnNow: db.fn.now() });
        const promotedParked = liveReplyFields.auto_reply_status === 'parked' && liveReplyFields.auto_reply_reason === 'review_edited_after_post'
          && (await applySyncReplyFields(existing.id, liveReplyFields, { conn: trx, expectedReply: live.review_reply ?? null })) > 0;
        if (!promotedParked && !(liveReplyFields.auto_reply_status === 'parked' && liveReplyFields.auto_reply_reason === 'review_edited_after_post')) {
          await applySyncReplyFields(existing.id, liveReplyFields, { conn: trx, expectedReply: live.review_reply ?? null });
        }
        // A reviewer edit: a POSTED reply parks for a person, a pipeline
        // draft is cleared and requeued. Judged on the row AFTER the reply
        // sync (a landed google_uncertain / persist_failed write promoted to
        // posted just above must park like any posted reply — codex r39),
        // with the review CONTENT from the pre-update snapshot.
        const afterSync = (await trx('google_reviews').where({ id: existing.id }).first()) || live;
        const basis = { ...afterSync, star_rating: live.star_rating, review_text: live.review_text, reviewer_name: live.reviewer_name, customer_id: live.customer_id };
        const reconciled = await this._reconcileReviewEdit(basis, normalized, { conn: trx, bell: false });
        return promotedParked ? 'posted_parked' : reconciled;
      });
      // The action bell only after the park is durable.
      if (edited === 'posted_parked') await this._bellEditedAfterPost(existing, normalized);
      result = { id: existing.id, inserted: false };
    } else {
      try {
        // Auto-reply lane: a review the sync sees for the FIRST time enters
        // the jittered reply queue in the SAME insert (atomic — a separate
        // post-insert hook that failed would leave the row unqueued forever,
        // since later syncs take the update path). Deploy-forward only: rows
        // that existed before the lane shipped never gain these columns.
        // Lazy require: the runner depends on this service.
        const { autoReplyInsertFields } = require('./review-reply/runner');
        const autoReply = autoReplyInsertFields({
          location_id: normalized.location_id,
          reviewer_name: normalized.reviewer_name,
          owner_reply: normalized.owner_reply,
          review_created_at: normalized.review_created_at,
        });
        const [insertedReview] = await db('google_reviews').insert({ ...row, ...autoReply }).returning('id');
        result = { id: insertedReview?.id || insertedReview, inserted: true };
      } catch (err) {
        // Overlapping runners (hourly job vs manual sync vs deploy instance)
        // can both miss the existence check for a newly arrived review; the
        // loser hits the google_review_id unique constraint. That's a
        // healthy sync racing itself, not a GBP failure — letting it bubble
        // would ring the degraded-sync alert. Convert to the update path on
        // the winner's row.
        if (err?.code !== '23505') throw err;
        const winner = await db('google_reviews').where({ google_review_id: normalized.google_review_id }).first();
        if (!winner) throw err;
        // Recompute the loser's update from the CURRENT winner row, not the
        // pre-insert null snapshot: the winner may already carry a local
        // draft reply or a manual customer match, and blindly applying `row`
        // (built with existing = null) would overwrite both and bypass the
        // draft-preservation rule above.
        const { review_reply: _loserReply, reply_updated_at: _loserReplyAt, ...providerRow } = row;
        const winnerReplyFields = syncReplyFields(winner, normalized, { fnNow: db.fn.now() });
        // An OLDER runner losing the race must not write its older snapshot
        // over the winner's newer content (codex r40): the provider-content
        // write and the reply sync apply only while this runner's fetch
        // start is at least as new as the stored liveness token.
        const loserWrite = db('google_reviews').where({ id: winner.id });
        if (syncStart) loserWrite.whereRaw('(synced_at IS NULL OR synced_at <= ?::timestamptz)', [new Date(syncStart).toISOString()]);
        const loserUpdated = await loserWrite.update({
          ...providerRow,
          synced_at: monotonicSyncedAt,
          // Same existing-link-first rule as the row build above.
          customer_id: winner.customer_id || customerId || null,
        });
        if ((Array.isArray(loserUpdated) ? loserUpdated.length : loserUpdated) > 0) {
          await applySyncReplyFields(winner.id, winnerReplyFields, { expectedReply: winner.review_reply ?? null });
        } else {
          logger.info(`[gbp] insert race: older runner yielded to the newer winner row ${winner.id}`);
        }
        result = { id: winner.id, inserted: false };
      }
    }
    // Reinstatement clear — a review present in the feed is not missing. The
    // main update above deliberately never touches missing_since; the clear
    // is its own conditional UPDATE evaluated against the CURRENT column
    // value, so a stamp committed by a newer reconciliation between our
    // snapshot read and this statement survives (only stamps older than this
    // runner's fetch start may be cleared). A fresh insert carries no stamp.
    if (!result.inserted) {
      const clear = db('google_reviews')
        .where({ id: result.id })
        .whereNotNull('missing_since');
      if (syncStart) clear.where('missing_since', '<', new Date(syncStart).toISOString());
      const cleared = await clear.update({ missing_since: null }, ['id']);
      // A stamped→clear transition means a review the removal alert reported
      // gone is back on Google — tell the admin, or the "removed" bell is the
      // last word they ever hear about it. Collected per run and flushed as
      // one bell per location (a profile-wide reinstatement would otherwise
      // ring dozens of bells).
      if ((cleared || []).length > 0 && Array.isArray(pendingRestoredNotifications)) {
        pendingRestoredNotifications.push({
          review_id: result.id,
          location_id: normalized.location_id,
          reviewer_name: normalized.reviewer_name,
          star_rating: normalized.star_rating,
        });
      }
    }
    if (row.customer_id) {
      // A matched review means the customer left one — stop asking them.
      await this._markCustomerLeftReview(row.customer_id);
      // Thank-you sequence on the ATTRIBUTION moment only (a new review, or
      // an existing one that just matched a customer) — not on every hourly
      // re-sync; the helper's once-ever dedupe backstops replays anyway.
      // Gate / 4-5-star bar / location mapping live in the shared helper so
      // the manual-match flow (review-incentives) behaves identically.
      const justAttributed = result.inserted || !existing?.customer_id;
      if (justAttributed) {
        const { enrollReviewThankYou } = require('./automation-enroll');
        await enrollReviewThankYou({
          customerId: row.customer_id,
          locationId: row.location_id,
          starRating: row.star_rating,
          source: 'google_review',
        });
      }
    } else if (result.inserted) {
      // New review we couldn't tie to a customer — alert the office to match
      // it. During a batch sync the notification is DEFERRED to the end of
      // the run: the likely-reviewer exclusion inside it queries
      // google_reviews.customer_id links, and a matched review later in the
      // same provider response isn't inserted yet — notifying inline could
      // name that customer as an earlier unlinked review's likely reviewer
      // (codex #3264 r2).
      if (Array.isArray(pendingUnlinkedNotifications)) {
        pendingUnlinkedNotifications.push(row);
      } else if (!(await this._attemptClickAutoLink(row))) {
        await this._notifyUnlinkedReview(row);
      }
    }
    return result;
  }

  async _syncPlacesStatsForLocation(loc, googleKey) {
    if (!loc.googlePlaceId || !googleKey) return null;
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${loc.googlePlaceId}&fields=rating,user_ratings_total,name&key=${googleKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') throw new Error(`Places API: ${data.status}`);
    const googleRating = data.result?.rating || null;
    const googleTotalReviews = data.result?.user_ratings_total || null;
    if (!googleRating && !googleTotalReviews) return null;
    const existing = await db('google_reviews').where({ google_review_id: `places_stats_${loc.id}` }).first();
    const statsData = JSON.stringify({ rating: googleRating, totalReviews: googleTotalReviews });
    if (existing) {
      await db('google_reviews').where({ id: existing.id }).update({ review_text: statsData, synced_at: db.fn.now() });
    } else {
      await db('google_reviews').insert({
        google_review_id: `places_stats_${loc.id}`,
        location_id: loc.id,
        reviewer_name: '_stats',
        star_rating: Math.round(googleRating || 5),
        review_text: statsData,
        review_created_at: new Date().toISOString(),
        synced_at: db.fn.now(),
      });
    }
    return { rating: googleRating, totalReviews: googleTotalReviews };
  }

  async _syncPlacesReviewSampleForLocation(loc, googleKey, pendingUnlinkedNotifications = null, pendingRestoredNotifications = null) {
    if (!loc.googlePlaceId || !googleKey) return { synced: 0, new: 0 };
    // Ordering token for the reinstatement clear below — a removal stamp
    // written after this fetch began is newer information than this sample.
    const sampleSyncStart = new Date();
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${loc.googlePlaceId}&fields=reviews,rating,user_ratings_total,name&reviews_sort=newest&key=${googleKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') throw new Error(`Places API: ${data.status}`);
    const reviews = data.result?.reviews || [];
    let synced = 0, newCount = 0;
    for (const review of reviews) {
      const googleId = `places_${loc.googlePlaceId}_${review.time}`;
      let existing = await db('google_reviews').where({ google_review_id: googleId }).first();
      // The synthetic id embeds the Places `time` field, which moves when a
      // reviewer EDITS their review — so an edited review comes back with a
      // brand-new id and used to be re-inserted as a duplicate row (a
      // GBP-replied review then sat in the "No Portal Reply" queue twice).
      // Google allows one review per account per listing, but display names
      // are NOT unique across accounts, so a name match alone never merges.
      // The dedup requires the name-matched row to be GBP-linked AND carry
      // identical content (text + rating): then the "merge" is a content
      // no-op that only prevents the duplicate insert. A name match with
      // DIFFERENT content is ambiguous — the same review edited while GBP is
      // down, or a different account sharing the name — and is skipped
      // entirely: no overwrite, no insert. The authoritative GBP feed
      // resolves it on recovery (updates the linked row in place for an
      // edit; inserts under its own resource name for a new account).
      // Un-linked Places rows are never name-matched; a same-name reviewer
      // there always inserts a new row.
      const reviewerName = review.author_name || 'Anonymous';
      if (!existing && reviewerName !== 'Anonymous') {
        const sameReviewer = await db('google_reviews')
          .where({ location_id: loc.id })
          .where('reviewer_name', '!=', '_stats')
          .whereNotNull('gbp_review_name')
          .whereRaw('LOWER(reviewer_name) = LOWER(?)', [reviewerName]);
        if (sameReviewer.length === 1) {
          const candidate = sameReviewer[0];
          const sameContent = (candidate.review_text || null) === (review.text || null)
            && Number(candidate.star_rating) === Number(review.rating || 0);
          if (sameContent) {
            // A stamped candidate is retained evidence. Same-name+content
            // alone must not select it: the merge below would overwrite its
            // photo/customer fields and run attribution side effects for
            // what may be a copycat account. Only the exact-second identity
            // proof (Places `time` == stored creation instant — the same
            // corroboration that gates the stamp clear) may touch a stamped
            // row; otherwise defer to the authoritative GBP feed.
            const placesSec = review.time ? Math.floor(review.time) : null;
            const candidateSec = candidate.review_created_at
              ? Math.floor(new Date(candidate.review_created_at).getTime() / 1000)
              : null;
            if (candidate.missing_since && !(placesSec != null && candidateSec != null && placesSec === candidateSec)) {
              logger.info(`[gbp] Places sample: same-name match on stamped evidence row ${candidate.id} at ${loc.id} lacks identity corroboration — deferring to GBP feed`);
              continue;
            }
            existing = candidate;
          } else {
            // Different content on a row the auto-reply lane has touched:
            // during a GBP outage this is how a reviewer edit looks (the
            // Places id moved with the edit). The row is still not merged or
            // overwritten — only its auto-reply state is reconciled (posted →
            // parked for a person; pipeline draft → cleared + requeued). A
            // same-name different account costs one human glance at the
            // bell; a rewritten complaint left answered by praise is the
            // worse failure.
            // Display names are not unique (hook P1): only the exact-second
            // identity proof (Places `time` == stored creation instant, the
            // same corroboration the stamp clear and synced_at refresh use)
            // may let this sample mutate the candidate's auto-reply state.
            // An uncorroborated same-name sample is a different account until
            // the authoritative GBP feed says otherwise.
            const editPlacesSec = review.time ? Math.floor(review.time) : null;
            const editCandidateSec = candidate.review_created_at ? Math.floor(new Date(candidate.review_created_at).getTime() / 1000) : null;
            const editCorroborated = editPlacesSec != null && editCandidateSec != null && editPlacesSec === editCandidateSec;
            if (editCorroborated && !candidate.missing_since && ['posted', 'drafted', 'parked', 'failed'].includes(candidate.auto_reply_status)) {
              await this._reconcileReviewEdit(candidate, { star_rating: review.rating || 0, review_text: review.text || null, reviewer_name: reviewerName, location_id: loc.id });
            }
            logger.info(`[gbp] Places sample: ambiguous same-name review at ${loc.id} (row ${candidate.id}) — deferring to GBP feed`);
            continue;
          }
        }
      }
      const ownerReply = review.owner_response?.text || null;
      const customerId = await this._findCustomerIdByReviewerName(reviewerName);
      if (existing) {
        // A row in Google's CURRENT Places sample is proof a review is live —
        // but proof about THIS row only when the identity corroborates.
        // Display names aren't unique across accounts, so the same-name
        // same-content merge above can be a different reviewer; clearing a
        // removal stamp on that evidence would revive the removed review for
        // the testimonial/marketing surfaces. The Places `time` of an
        // unedited review IS its creation instant — require exact-second
        // equality with the stored review_created_at (a tolerance window,
        // however small, readmits a copycat posted near the original's
        // creation time). If the timestamps disagree, keep the stamp; a
        // genuine reinstatement still clears on the next authoritative GBP
        // pull, so failing closed here costs only the outage window.
        const placesSec = review.time ? Math.floor(review.time) : null;
        const createdSec = existing.review_created_at
          ? Math.floor(new Date(existing.review_created_at).getTime() / 1000)
          : null;
        const identityCorroborated = placesSec != null && createdSec != null && placesSec === createdSec;
        const upd = {
          star_rating: review.rating || 0,
          review_text: review.text || null,
          reviewer_photo_url: review.profile_photo_url || null,
          // Existing link first — mirror of _upsertGbpReview (GH codex r1).
          customer_id: existing.customer_id || customerId,
        };
        // synced_at participates in the authoritative reconcile's claim
        // predicate (synced_at < syncStart ⇒ stampable) — refreshing it
        // asserts "seen live just now". An uncorroborated same-name match
        // hasn't proven that about THIS row, and refreshing would let a
        // copycat's Places appearance suppress a concurrent GBP removal
        // stamp — so liveness freshness requires the same identity proof
        // as the stamp clear.
        // Fetch-start timestamp, not db.fn.now() — synced_at is an ordering
        // token compared against runner fetch starts (Node clock); see
        // _upsertGbpReview for the skew rationale. GREATEST keeps it
        // monotonic against a newer overlapping runner's token.
        if (identityCorroborated) {
          upd.synced_at = db.raw('GREATEST(COALESCE(synced_at, to_timestamp(0)), ?::timestamptz)', [sampleSyncStart.toISOString()]);
        }
        // Content update + reviewer-edit reconciliation commit together (same
        // reason as the authoritative upsert): a crash between them would
        // leave the next sync seeing the edited text as the existing
        // fingerprint. The action bell fires only after commit.
        const placesEdit = { star_rating: review.rating || 0, review_text: review.text || null, reviewer_name: reviewerName, location_id: loc.id };
        const edited = await db.transaction(async (trx) => {
          // Same live re-read under the lock as the authoritative upsert.
          const live = (await trx('google_reviews').where({ id: existing.id }).forUpdate().first()) || existing;
          await trx('google_reviews').where({ id: existing.id }).update(upd);
          // Owner reply first (a landed uncertain write becomes posted), then
          // the reviewer-edit reconciliation on the post-sync row (codex r39).
          // A Places owner reply that differs from the local one goes through
          // the canonical sync path: it fills an empty slot, replaces a
          // "[DRAFT]", and — when the owner edited our POSTED reply directly
          // on Google during a GBP outage — replaces the stale text and
          // closes the automatic state (edited_on_google). Judged against the
          // row AS IT IS after the reconciliation above (hook P1: a cleared
          // draft must not make this CAS miss), inside the same transaction.
          // An ABSENT Places reply is still never a downgrade (the sample is
          // not authoritative for deletions).
          if (ownerReply) {
            const after = (await trx('google_reviews').where({ id: existing.id }).forUpdate().first()) || live;
            if (ownerReply.trim() !== String(after.review_reply || '').trim()) {
              const { syncReplyFields, applySyncReplyFields } = require('./review-reply/runner');
              await applySyncReplyFields(existing.id, syncReplyFields(after, { owner_reply: ownerReply }, { fnNow: db.fn.now() }), { conn: trx, expectedReply: after.review_reply ?? null });
            }
          }
          const afterSync = (await trx('google_reviews').where({ id: existing.id }).first()) || live;
          const basis = { ...afterSync, star_rating: live.star_rating, review_text: live.review_text, reviewer_name: live.reviewer_name, customer_id: live.customer_id };
          return this._reconcileReviewEdit(basis, placesEdit, { conn: trx, bell: false });
        });
        if (edited === 'posted_parked') await this._bellEditedAfterPost(existing, placesEdit);
        // Reinstatement clear, mirroring _upsertGbpReview: the main update
        // never touches missing_since; the clear is a separate conditional
        // UPDATE against the CURRENT column value with the ordering token,
        // so an authoritative stamp committed after this sample's fetch
        // began survives a concurrent degraded runner.
        if (identityCorroborated) {
          const cleared = await db('google_reviews')
            .where({ id: existing.id })
            .whereNotNull('missing_since')
            .where('missing_since', '<', sampleSyncStart.toISOString())
            .update({ missing_since: null }, ['id']);
          // Stamped→clear transition — surface the reinstatement, mirroring
          // the GBP-path collection in _upsertGbpReview.
          if ((cleared || []).length > 0 && Array.isArray(pendingRestoredNotifications)) {
            pendingRestoredNotifications.push({
              review_id: existing.id,
              location_id: loc.id,
              reviewer_name: existing.reviewer_name,
              star_rating: existing.star_rating,
            });
          }
        }
      } else {
        // Same atomic auto-reply queueing as the GBP insert: a review first
        // seen through the Places fallback is matched by identity once GBP
        // recovers and takes the update path, so this insert is its only
        // chance to enter the pipeline.
        const { autoReplyInsertFields } = require('./review-reply/runner');
        const placesCreatedAt = new Date(review.time * 1000).toISOString();
        await db('google_reviews').insert({
          google_review_id: googleId,
          location_id: loc.id,
          reviewer_name: reviewerName,
          reviewer_photo_url: review.profile_photo_url || null,
          star_rating: review.rating || 0,
          review_text: review.text || null,
          review_reply: ownerReply,
          reply_updated_at: ownerReply ? new Date() : null,
          review_created_at: placesCreatedAt,
          customer_id: customerId,
          synced_at: sampleSyncStart.toISOString(),
          ...autoReplyInsertFields({ location_id: loc.id, reviewer_name: reviewerName, owner_reply: ownerReply, review_created_at: placesCreatedAt }),
        }).returning('id');
        newCount++;
      }
      // Existing-link-first, matching the persisted field above: a late name
      // match must not suppress customer B's asks while the row stays linked
      // to customer A (GH codex #3483 r3).
      const effectiveCustomerId = existing?.customer_id || customerId || null;
      if (effectiveCustomerId) {
        // Matched to a customer → they left a review; auto-exclude from outreach.
        await this._markCustomerLeftReview(effectiveCustomerId);
        // Same attribution-moment thank-you hook as the GBP feed path.
        const justAttributed = !existing || !existing.customer_id;
        if (justAttributed) {
          const { enrollReviewThankYou } = require('./automation-enroll');
          await enrollReviewThankYou({
            customerId: effectiveCustomerId,
            locationId: loc.id,
            starRating: review.rating || 0,
            source: 'google_review_places',
          });
        }
      } else if (!existing) {
        // Newly inserted, unmatched → alert the office to match it. Deferred
        // to the end of the batch run when a collector is passed (see
        // _upsertGbpReview) so the likely-reviewer exclusion sees the whole
        // batch's links.
        const notifyRow = {
          reviewer_name: reviewerName,
          star_rating: review.rating || 0,
          review_text: review.text || null,
          location_id: loc.id,
          google_review_id: googleId,
          review_created_at: new Date(review.time * 1000).toISOString(),
        };
        if (Array.isArray(pendingUnlinkedNotifications)) {
          pendingUnlinkedNotifications.push(notifyRow);
        } else if (!(await this._attemptClickAutoLink(notifyRow))) {
          await this._notifyUnlinkedReview(notifyRow);
        }
      }
      synced++;
    }
    return { synced, new: newCount };
  }

  // =========================================================================
  // REVIEW SYNC - GBP Reviews API primary; Places kept for stats/fallback.
  // =========================================================================
  async syncAllReviews() {
    // The Maps key powers only the Places stats + review-sample fallback.
    // GBP Reviews auth is separate (_getClient), so a missing Maps key must
    // not stop the authoritative GBP loop — that would also silence the
    // degraded-sync and removal alerts this watchdog exists to emit.
    const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || null;
    if (!GOOGLE_KEY) {
      logger.error('[google-business] GOOGLE_MAPS_API_KEY not set — Places stats/fallback disabled; continuing GBP review sync');
    }
    let totalSynced = 0, totalNew = 0;
    const errors = [];
    const sources = {};
    // Current-run pull sizes per location — the health check must judge the
    // FEED, not retained rows (a wiped profile keeps its old rows with
    // missing_since stamps, so a stored-row count reads healthy forever —
    // codex #3298 r1).
    const pulledCounts = {};
    // Unlinked-review notifications collected across the WHOLE run and fired
    // after every location's reviews are inserted/linked — the likely-reviewer
    // exclusion must see the full batch (codex #3264 r2).
    const pendingUnlinked = [];

    for (const loc of WAVES_LOCATIONS) {
      try {
        // Serialize each location's pull/reconcile/fallback cycle across
        // overlapping runners (hourly job vs manual sync vs deploy overlap).
        // The ordering tokens close the update-side races, but an INSERT
        // has no prior row to order against: an older runner pausing after
        // its fetch can insert a review AFTER a newer reconcile proved it
        // absent, leaving an unstamped ghost row with no removal alert.
        // pg_try_advisory_lock is non-blocking — the loser skips the
        // location and the holder's cycle (or the next hourly tick) covers
        // it; a skipped location must NOT ring the degraded alert.
        const cycle = await runExclusive(`gbp-review-sync:${loc.id}`, async () => {
        // Reinstated-review notifications (stamped missing_since → cleared)
        // for THIS location's cycle, flushed as one bell before the location
        // lock releases — the removal alert's correction; without it
        // "removed" is the last word the admin ever hears about a review
        // that came back. Deferring past the lock would let a newer runner
        // re-stamp and alert "removed" first, then our stale "restored"
        // bell would land LAST and contradict it (codex #3397 r1) — under
        // the lock, any later removal alert arrives after us, so the
        // newest information always rings last.
        const locRestored = [];
        if (GOOGLE_KEY) {
          await this._syncPlacesStatsForLocation(loc, GOOGLE_KEY).catch(err => {
            logger.warn(`[gbp] Places stats sync failed for ${loc.name}: ${err.message}`);
          });
        }

        let usedGbp = false;
        let gbpFailure = null;
        const locSyncStart = new Date();
        if (loc.googleLocationResourceName && await this._getClient(loc.id)) {
          try {
            // Default page size (50) — the GBP reviews.list API caps
            // pageSize at 50, and an oversized value risks the whole pull
            // rejecting, which would push every location into degraded
            // fallback and stall reconciliation. Pagination fetches all
            // pages regardless.
            const reviews = await this.getAllLocationReviews(loc.googleLocationResourceName, loc.id);
            pulledCounts[loc.id] = reviews.length;
            for (const review of reviews) {
              const normalized = this._normalizeGbpReview(review, loc);
              const result = await this._upsertGbpReview(normalized, locSyncStart, pendingUnlinked, locRestored);
              if (result.inserted) totalNew++;
              totalSynced++;
            }
            sources[loc.id] = 'gbp';
            usedGbp = true;
            logger.info(`[gbp] Synced ${reviews.length} reviews for ${loc.name} via GBP Reviews API`);
            // Authoritative full pull succeeded → anything we synced before
            // that Google no longer returns has been removed/filtered.
            // A failed reconcile must NOT hide behind the successful pull:
            // it silently disables removal detection, so it joins
            // result.errors and rings the degraded-sync alert (24h-deduped)
            // — without falling back to Places (the pull itself was fine).
            const reconcile = await this._reconcileMissingReviews(loc, locSyncStart);
            if (reconcile && reconcile.ok === false) {
              errors.push({ location: loc.name, error: reconcile.error, source: 'reconcile' });
              await this._notifyDegradedSync(loc, `removal reconcile failed: ${reconcile.error}`);
            }
          } catch (gbpErr) {
            gbpFailure = gbpErr.message;
            errors.push({ location: loc.name, error: gbpErr.message, source: 'gbp' });
            logger.warn(`[gbp] GBP Reviews sync failed for ${loc.name}; using Places fallback: ${gbpErr.message}`);
          }
        } else if (loc.googleLocationResourceName) {
          gbpFailure = 'no_client';
        }

        if (!usedGbp) {
          if (loc.googleLocationResourceName) {
            // Running blind — removals and most new reviews are invisible
            // until the GBP credentials work. Alert BEFORE attempting the
            // fallible Places fallback: if that throws too, the outer catch
            // would otherwise skip the alert and recreate the silent
            // failure this watchdog exists to detect.
            await this._notifyDegradedSync(loc, gbpFailure || 'no_client');
          }
          if (GOOGLE_KEY) {
            const sample = await this._syncPlacesReviewSampleForLocation(loc, GOOGLE_KEY, pendingUnlinked, locRestored);
            pulledCounts[loc.id] = sample.synced;
            totalSynced += sample.synced;
            totalNew += sample.new;
            sources[loc.id] = sample.synced > 0 ? 'places_fallback' : 'none';
            logger.info(`[gbp] Synced ${sample.synced} review sample rows for ${loc.name} via Places API fallback`);
          } else {
            sources[loc.id] = 'none';
          }
        }
        await this._notifyRestoredReviews(locRestored);
        return { done: true };
        }, { recordHealth: false });
        if (cycle?.skipped) {
          sources[loc.id] = 'concurrent_skip';
          logger.info(`[gbp] Review sync for ${loc.name} skipped — another runner holds the location lock (${cycle.reason})`);
        }
      } catch (err) {
        logger.error(`Review sync failed for ${loc.name}: ${err.message}`);
        errors.push({ location: loc.name, error: err.message });
        if (!sources[loc.id]) sources[loc.id] = 'none';
      }
    }

    // Whole batch is now inserted/linked — safe to run the likely-reviewer
    // lookup inside each deferred notification. Confident click evidence
    // links the review outright (gated) instead of parking it in the manual
    // queue; both helpers self-catch, so one failure can't drop the rest.
    for (const row of pendingUnlinked) {
      const autoLinked = await this._attemptClickAutoLink(row);
      if (!autoLinked) await this._notifyUnlinkedReview(row);
    }
    // Clicks stamped after a review's first sync can turn an already-parked
    // review decidable — sweep the recent unlinked set each run (gated).
    await this._retryUnlinkedReviewAutoLink();

    await this._resolveGbpResourceNames();
    try {
      const ReviewIncentives = require('./review-incentives');
      await ReviewIncentives.syncReviewIncentives({ sinceDays: 90 });
    } catch (err) {
      logger.warn(`[gbp] Review incentive sync skipped: ${err?.code || err?.name || 'Error'}`);
    }

    // Outcome-level health check (2026-08-08 audit): the degraded-sync bell
    // only fires when the sync MECHANICS fail this run. Two silent classes
    // slipped through it for months: a GBP pull that "succeeds" with an
    // empty feed (Venice — Google wiped the profile's reviews and nothing
    // noticed), and Places stats failing quietly under its catch→warn
    // (every location's _stats froze). Reviewers on a dead feed can never
    // auto-mark as having reviewed, so they keep getting asked — the exact
    // class the 2026-08-08 manual review-status backfill fixed by hand.
    // Best-effort: health
    // reporting must never break the sync itself.
    await this._assessReviewSyncHealth(sources, pulledCounts).catch((err) => {
      logger.warn(`[gbp] review sync health assessment failed: ${err.message}`);
    });

    return { synced: totalSynced, new: totalNew, errors, sources };
  }

  /**
   * Pure classifier for one location's sync-health picture. Returns null when
   * healthy, else { cls, severity ('FIX'|'ACT'), detail }.
   *
   * Classes:
   *   feed_down     FIX  nothing synced this run (no GBP, no Places sample)
   *   feed_degraded ACT  GBP creds broken; running on the ~5-review sample
   *   silent_empty  ACT  GBP pull succeeds but the feed has ZERO reviews
   *                      (the Venice wipe class — mechanically "healthy")
   *   ingest_stale  ACT  Google shows more reviews than we ever ingested and
   *                      nothing new has landed in 14d — reviewers exist that
   *                      auto-mark can never see
   *   stats_stale   ACT  no _stats row, or Places stats older than 7d — the
   *                      totals cross-check above is running blind
   */
  _classifyLocationSyncHealth({ hasResource, source, pulledCount, rowCount, newestIngestAt, statsUpdatedAt, statsTotal, now = Date.now() }) {
    if (!hasResource) return null;               // not a GBP-tracked location
    if (source === 'concurrent_skip') return null; // another runner owns this cycle
    const days = (ts) => (ts ? (now - new Date(ts).getTime()) / 86400000 : Infinity);

    if (source === 'none') {
      return { cls: 'feed_down', severity: 'FIX', detail: 'nothing synced this run — GBP pull failed and no Places sample landed' };
    }
    if (source === 'places_fallback') {
      return { cls: 'feed_degraded', severity: 'ACT', detail: 'GBP credentials are broken — running on the ~5-review Places sample; removals and most new reviews are invisible' };
    }
    // Judged on the CURRENT pull, not retained rows: a wiped profile keeps
    // its historical rows (missing_since-stamped, never deleted), so a
    // stored-row count would read healthy forever after the wipe.
    if (source === 'gbp' && Number(pulledCount) === 0) {
      return { cls: 'silent_empty', severity: 'ACT', detail: 'the GBP pull succeeds but the feed returns ZERO reviews — profile wiped, suspended, or re-created (the Venice class)' };
    }
    if (Number.isFinite(statsTotal) && statsTotal > rowCount && days(newestIngestAt) > 14) {
      return { cls: 'ingest_stale', severity: 'ACT', detail: `Google shows ${statsTotal} reviews but only ${rowCount} were ever ingested and nothing new in ${Math.floor(days(newestIngestAt))}d — those reviewers can never auto-mark` };
    }
    if (days(statsUpdatedAt) > 7) {
      return { cls: 'stats_stale', severity: 'ACT', detail: statsUpdatedAt ? `Places stats last updated ${Math.floor(days(statsUpdatedAt))}d ago — the review-total cross-check is blind` : 'no Places stats row has ever been written for this location' };
    }
    return null;
  }

  /**
   * Emailed escalation of the per-location classification — exceptions only
   * (a healthy fleet sends nothing), email-first to contact@ with the FIX:/
   * ACT: subject convention (bounce-rescue pattern), admin bell as the
   * backup channel, 24h-deduped via the notifications table. Kill switch:
   * REVIEW_SYNC_HEALTH_EMAIL=off (same convention as EMAIL_BOUNCE_RECOVERY).
   */
  async _assessReviewSyncHealth(sources = {}, pulledCounts = {}) {
    if (String(process.env.REVIEW_SYNC_HEALTH_EMAIL || '').toLowerCase() === 'off') return { skipped: 'disabled' };
    // A cycle split across overlapping runners (per-location locks) gives
    // each runner a PARTIAL fleet view — two different signatures would both
    // pass the signature-keyed dedupe and double-email in the same hour
    // (pre-push audit r2). Defer to the next complete cycle instead; the
    // hourly cadence makes that at most an hour of delay.
    if (Object.values(sources).includes('concurrent_skip')) return { skipped: 'partial_cycle' };

    const rows = await db('google_reviews')
      .select('location_id')
      // LIVE rows only — retained missing_since removal evidence must not
      // count as coverage: 60 historical rows incl. 20 removals would make a
      // Places total of 47 read fully ingested while the live feed holds 40
      // (codex #3298 r2). newest_ingest_at stays all-rows: ingestion recency
      // is about the pipeline moving, not the row's later removal.
      .select(db.raw(`COUNT(*) FILTER (WHERE reviewer_name != '_stats' AND missing_since IS NULL) AS row_count`))
      .select(db.raw(`MAX(created_at) FILTER (WHERE reviewer_name != '_stats') AS newest_ingest_at`))
      // _syncPlacesStatsForLocation stamps synced_at (updated_at has no
      // auto-touch trigger) — reading updated_at would mark every
      // established location stats_stale forever (codex #3298 r1).
      .select(db.raw(`MAX(COALESCE(synced_at, updated_at)) FILTER (WHERE reviewer_name = '_stats') AS stats_updated_at`))
      .groupBy('location_id');
    const byLoc = Object.fromEntries(rows.map((r) => [r.location_id, r]));

    // _stats totals ride in the row's review_text as JSON ({rating, totalReviews}).
    const statsRows = await db('google_reviews')
      .where({ reviewer_name: '_stats' })
      .select('location_id', 'review_text');
    const totals = {};
    for (const s of statsRows) {
      try { totals[s.location_id] = Number(JSON.parse(s.review_text)?.totalReviews); } catch { /* unparseable stats */ }
    }

    const findings = [];
    for (const loc of WAVES_LOCATIONS) {
      const agg = byLoc[loc.id] || {};
      const verdict = this._classifyLocationSyncHealth({
        hasResource: !!loc.googleLocationResourceName,
        source: sources[loc.id],
        pulledCount: pulledCounts[loc.id],
        rowCount: Number(agg.row_count) || 0,
        newestIngestAt: agg.newest_ingest_at || null,
        statsUpdatedAt: agg.stats_updated_at || null,
        statsTotal: totals[loc.id],
      });
      if (verdict) findings.push({ loc, ...verdict });
    }
    if (!findings.length) return { healthy: true };

    const anyFix = findings.some((f) => f.severity === 'FIX');
    // Signature-keyed dedupe (pre-push audit): a constant title would let one
    // location's stats_stale suppress a DIFFERENT location going feed_down an
    // hour later. Same finding set → deduped 24h; any new/changed finding →
    // new title → sends immediately.
    const signature = findings.map((f) => `${f.loc.id}:${f.cls}`).sort().join('|');
    const title = `Review sync health escalation [${signature}]`;
    const result = await runExclusive('gbp-sync-health-notify', async () => {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await db('notifications')
        .where({ recipient_type: 'admin', title })
        .where('created_at', '>', dayAgo)
        .first();
      if (recent) return { deduped: true };

      const lines = findings.map((f) => `${f.severity} ${f.loc.name} [${f.cls}]: ${f.detail}`);
      const body = [
        'Hourly Google review sync — per-location health check found problems the mechanical degraded-sync alert cannot see:',
        '',
        ...lines,
        '',
        'A dead or stale feed means reviewers on that profile are never auto-marked as having reviewed, so review asks keep going to customers who already reviewed.',
        'Remediation: reconnect the GBP account for credential failures (/admin/reviews sync status); for silent_empty confirm the profile state in Google Business Profile (removed/suspended listings need the support case); stats_stale usually means the Places API call is failing — check GOOGLE_MAPS_API_KEY quota/validity.',
      ].join('\n');
      const subject = `${anyFix ? 'FIX' : 'ACT'}: Google review sync — ${findings.length} location${findings.length === 1 ? '' : 's'} degraded or stale`;

      // Durable claim BEFORE the external send (pre-push audit): SMTP
      // succeeding before the marker lands would resend the email every
      // hourly run if the process died or the insert failed (notifyAdmin
      // swallows DB errors → null). The bell row is the claim AND the backup
      // surface, so it always carries the full body; no marker → no send,
      // and the next hourly tick retries the whole escalation.
      const marker = await NotificationService.notifyAdmin(
        'review',
        title,
        `${subject}\n\n${body}`,
        // bell: true — GATE_ADMIN_BELL_POLICY suppressing this row would
        // erase the dedupe marker (codex #3298 r1).
        { link: '/admin/reviews', bell: true },
      );
      if (!marker) return { skipped: 'marker_failed' };

      let emailed = false;
      try {
        const email = require('./email');
        const sent = await email.send({ to: 'contact@wavespestcontrol.com', subject, heading: 'Review sync health', body });
        emailed = !!sent?.ok;
      } catch { /* the bell already carries the full body */ }
      if (!emailed) {
        logger.warn('[gbp] sync-health escalation email failed — the bell carries the full escalation');
      }
      return { emailed, findings: findings.length };
    }, { recordHealth: false });
    if (result?.skipped === true) return { skipped: 'lock' };
    return result;
  }

  /**
   * After a successful FULL GBP Reviews API pull for a location, stamp
   * missing_since on previously-synced rows the feed no longer returned —
   * Google removed or filtered them (Aug 2026: a sweep wiped EVERY review
   * on the Venice profile and nothing noticed for months). Runs ONLY on
   * the authoritative GBP path: the Places fallback is a ~5-review sample
   * and a failed fetch proves nothing, so both fail closed (no stamping).
   * Rows are never deleted, and a review that reappears clears its stamp
   * via the upsert. Notifies once per NULL→stamped transition batch, so
   * repeat hourly syncs don't re-notify. Best-effort — never throws into
   * the sync loop (a reconcile failure must not trigger the Places
   * fallback for a location whose GBP pull succeeded).
   */
  async _reconcileMissingReviews(loc, syncStart) {
    try {
      // Only rows with an authoritative GBP identity: a Places-sampled row
      // (gbp_review_name null) can go stale legitimately — an edit moves the
      // Places timestamp, the GBP upsert may insert the same review under
      // its resource name, and the orphaned sample row would be falsely
      // reported as removed.
      const candidates = await db('google_reviews')
        .where({ location_id: loc.id })
        .where('reviewer_name', '!=', '_stats')
        .whereNotNull('gbp_review_name')
        .whereNull('missing_since')
        .where('synced_at', '<', syncStart)
        // Fresh-review grace window: brand-new reviews flicker in and out of
        // the feed while Google settles (see MISSING_REVIEW_GRACE_MS) — one
        // absent pull is not removal evidence for them. review_created_at is
        // immutable, so the candidate select is the only place this needs to
        // hold; a NULL creation time stays stampable (fail toward alerting).
        .whereRaw('(review_created_at IS NULL OR review_created_at < ?)', [new Date(new Date(syncStart).getTime() - MISSING_REVIEW_GRACE_MS).toISOString()])
        // A testimonial publisher stamps a short-lived publish claim (under
        // this location's advisory lock) before its slow external posting —
        // skip claimed rows so a removal stamp cannot land mid-publication;
        // an expired claim (crashed publisher) is stampable again.
        .whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [new Date().toISOString()])
        .select('id', 'reviewer_name', 'star_rating', 'review_created_at');
      if (candidates.length === 0) return { ok: true };

      // Atomic claim + alert in ONE transaction: the hourly job and the
      // manual admin sync (or two instances overlapping during a deploy) can
      // both select the same rows — conditioning the update on missing_since
      // IS NULL means only one runner claims each row, so only one
      // notification fires. And because the claim is one-shot (stamped rows
      // are excluded from every later reconcile), a lost notification insert
      // would silence the alert forever — notifyAdmin swallows insert errors
      // and returns null, so a null return throws INSIDE the transaction and
      // the rollback releases the claim atomically (a separate compensating
      // update could fail in the same outage that broke the insert). The
      // next sync then re-claims and re-notifies. Intentional suppression
      // returns a truthy sentinel and commits (stamp kept).
      let gone = [];
      const reversedCustomerIds = [];
      try {
        await db.transaction(async (trx) => {
          const claimedRows = await trx('google_reviews')
            .whereIn('id', candidates.map(r => r.id))
            .whereNull('missing_since')
            // Re-check freshness at claim time: an overlapping runner may have
            // confirmed a candidate live (refreshed synced_at) between our
            // candidate select and this update — a stale snapshot must not
            // stamp a review another sync just proved is on Google.
            .where('synced_at', '<', syncStart)
            // Publish-claim re-check at claim time, mirroring the candidate
            // select — a claim stamped between the select and this update
            // must also defer the stamp.
            .whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [new Date().toISOString()])
            // Stamp with the runner's own fetch start, not db.fn.now() —
            // the reinstatement clears compare missing_since against other
            // runners' fetch starts (Node clock), and a Postgres-clock stamp
            // behind the app clock could be "older" than a fetch that
            // predates the removal, letting a stale runner clear it.
            .update({ missing_since: new Date(syncStart).toISOString() }, ['id']);
          const claimedIds = new Set((claimedRows || []).map(r => r.id));
          gone = candidates.filter(r => claimedIds.has(r.id));
          if (gone.length === 0) return;

          // Unconfirmed click auto-links whose review just vanished (GH
          // codex #3483 r5): every correction surface excludes missing_since
          // rows, so the auto-owned suppression flag would strand forever.
          // Reverse it in the SAME transaction as the stamp — sole-basis
          // only (another linked review still proves they reviewed); a
          // 'manual'/'manual_no_visit' link was human-confirmed and keeps
          // its flag like any other removed attributed review.
          const autoLinked = await trx('google_reviews')
            .whereIn('id', gone.map(r => r.id))
            .where({ link_source: 'click_auto' })
            .whereNotNull('customer_id')
            .select('id', 'customer_id', 'auto_linked_at');
          for (const alRow of autoLinked) {
            const otherLink = await trx('google_reviews')
              .where({ customer_id: alRow.customer_id })
              .whereNot('id', alRow.id)
              .first('id');
            // Unlink the unconfirmed probabilistic match itself (GH codex
            // #3483 r7): the review is gone from Google, yet a retained
            // customer_id still reads as "has a linked review" in every
            // suppression check (sequence runner, correlation's linked
            // exclusion). The retained row keeps the review text as
            // evidence; only the never-confirmed attribution is dropped.
            await trx('google_reviews')
              .where({ id: alRow.id, link_source: 'click_auto' })
              .update({ customer_id: null, link_source: null, auto_linked_at: null });
            // Ownership check (GH codex r6): a review_marked_at LATER than
            // this auto-link's own stamp means a human independently
            // confirmed the customer reviewed — that flag is not ours to
            // clear.
            const cust = await trx('customers')
              .where({ id: alRow.customer_id })
              .first('review_marked_at');
            const ownedByAutoLink = alRow.auto_linked_at && cust?.review_marked_at
              && new Date(cust.review_marked_at) <= new Date(alRow.auto_linked_at);
            if (!otherLink && ownedByAutoLink) {
              // Ownership predicate IN the write (GH codex r8): a
              // concurrent human mark bumps review_marked_at, the
              // conditional no-ops, and the human's confirmation survives.
              // Sole-basis check ALSO in the write (GH codex r10): this
              // location's lock doesn't serialize an attribution linking
              // another review to the same customer elsewhere, so the
              // otherLink pre-read can miss a link committing in the gap —
              // the subquery re-evaluates at write time and refuses the
              // clear once any other linked review proves the customer
              // reviewed. Audit entry only when the clear actually happened
              // (GH codex r9) — a no-op race must not log "review asks
              // resume".
              const cleared = await trx('customers')
                .where({ id: alRow.customer_id })
                .where({ review_marked_at: cust.review_marked_at })
                .whereNotExists(function soleBasis() {
                  this.select(1)
                    .from('google_reviews')
                    .where('google_reviews.customer_id', alRow.customer_id)
                    .whereNot('google_reviews.id', alRow.id);
                })
                .update({ has_left_google_review: false, review_marked_at: null });
              // Audit rows are inserted AFTER the transaction commits
              // (pre-push P1): a caught statement error still marks the
              // whole PostgreSQL transaction aborted, so an in-trx
              // "best-effort" insert would fail the later notification
              // query and roll back the entire stamp/unlink/reversal.
              if (cleared) reversedCustomerIds.push(alRow.customer_id);
            }
          }

          const names = gone.slice(0, 15)
            .map(r => `${r.reviewer_name || 'Anonymous'} (${Number(r.star_rating) || 0}-star)`)
            .join(', ');
          const suffix = gone.length > 15 ? ` and ${gone.length - 15} more` : '';
          const notif = await NotificationService.notifyAdmin(
            'review',
            `${gone.length} Google review${gone.length === 1 ? '' : 's'} removed at ${loc.name}`,
            `Google no longer returns these reviews for ${loc.name}: ${names}${suffix}. The full text is kept in the portal. If they are legitimate customer reviews caught in a spam sweep, file a missing-reviews case with Google Business Profile support and escalate by replying in-thread.`,
            {
              bell: true,
              link: '/admin/reviews',
              metadata: { locationId: loc.id, reason: 'reviews_missing', count: gone.length, reviewIds: gone.map(r => r.id) },
              connection: trx,
            },
          );
          if (!notif) throw new Error('removal-alert notification insert failed');
        });
      } catch (err) {
        logger.warn(`[gbp] Removal alert for ${loc.name} rolled back (${err.message}) — claim released, retrying next sync`);
        return { ok: false, error: `removal-alert transaction rolled back: ${err.message}` };
      }
      if (gone.length === 0) return { ok: true };
      // Genuinely best-effort audit trail, outside the transaction (matching
      // the manual-attribution path): the reversal itself is committed, so a
      // lost audit row costs nothing durable and must never fail the sync.
      for (const reversedId of reversedCustomerIds) {
        try {
          await db('activity_log').insert({
            customer_id: reversedId,
            action: 'review_automark_reversed',
            description: 'Auto-linked Google review was removed from Google before confirmation — "already left a Google review" cleared; review asks resume.',
          });
        } catch { /* audit only — the reversal is already committed */ }
      }
      // Count only — reviewer display names are PII and ride in the admin
      // notification, not the plaintext log.
      logger.warn(`[gbp] ${gone.length} review(s) at ${loc.name} disappeared from the GBP feed — stamped missing_since, admin notified`);
      return { ok: true };
    } catch (err) {
      // Surfaced to the caller: a silently failing reconcile disables
      // removal detection while the sync still reports GBP success — the
      // exact failure mode this watchdog exists to alert on.
      logger.warn(`[gbp] Missing-review reconcile failed for ${loc.name}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Correction bell for the removal alert: reviews whose missing_since stamp
   * cleared this run are back on Google, and the admin who saw "removed"
   * needs to hear it (2026-08-13: a transient false removal alert sent the
   * owner toward filing a GBP support case for a review that was already
   * back). One bell per location per cycle, flushed while the caller still
   * holds that location's gbp-review-sync lock so a newer runner's removal
   * alert can only land AFTER this correction, never be contradicted by it
   * (codex #3397 r1). Best-effort by design — the stamp
   * is already cleared, so unlike the removal alert's claim/rollback
   * coupling, a lost good-news bell costs nothing durable and must never
   * fail the sync.
   */
  async _notifyRestoredReviews(restored) {
    if (!Array.isArray(restored) || restored.length === 0) return;
    const byLocation = new Map();
    for (const row of restored) {
      if (!byLocation.has(row.location_id)) byLocation.set(row.location_id, []);
      byLocation.get(row.location_id).push(row);
    }
    for (const [locationId, rows] of byLocation) {
      try {
        const locName = WAVES_LOCATIONS.find(l => l.id === locationId)?.name || locationId;
        const names = rows.slice(0, 15)
          .map(r => `${r.reviewer_name || 'Anonymous'} (${Number(r.star_rating) || 0}-star)`)
          .join(', ');
        const suffix = rows.length > 15 ? ` and ${rows.length - 15} more` : '';
        await NotificationService.notifyAdmin(
          'review',
          `${rows.length} Google review${rows.length === 1 ? '' : 's'} restored at ${locName}`,
          `Back on Google for ${locName}: ${names}${suffix}. These were previously reported removed — no missing-reviews case is needed for them.`,
          {
            bell: true,
            link: '/admin/reviews',
            metadata: { locationId, reason: 'reviews_restored', count: rows.length, reviewIds: rows.map(r => r.review_id) },
          },
        );
        logger.info(`[gbp] ${rows.length} previously-missing review(s) at ${locName} reappeared — stamp cleared, admin notified`);
      } catch (err) {
        logger.warn(`[gbp] Restored-review notification failed for ${locationId}: ${err.message}`);
      }
    }
  }

  /**
   * A location configured for GBP that could not complete an authoritative
   * Reviews API pull is running blind: removals are undetectable and the
   * Places sample misses most reviews. This is exactly how the Venice
   * review wipe went unnoticed — its refresh token was never provisioned,
   * the sync silently fell back, and zero rows were ever stored. Alerts at
   * most once per 24h per location (dedupe on the notification title).
   * Best-effort — never throws into the sync loop.
   */
  async _notifyDegradedSync(loc, cause) {
    try {
      // The title is the 24h dedupe key, so distinct failure classes need
      // distinct titles: a pull-failure alert this morning must not
      // suppress a reconcile-failure alert this afternoon — they have
      // different remediation and both mean removals go undetected.
      const reconcileFailure = String(cause || '').startsWith('removal reconcile failed');
      const title = reconcileFailure
        ? `Google review removal reconcile failing for ${loc.name}`
        : `Google review sync degraded for ${loc.name}`;
      // The advisory lock serializes the check-then-insert across the hourly
      // job, the manual admin sync, and overlapping deploy instances — a
      // plain read-then-insert here would double-notify. A held lock means
      // another runner is already alerting; skipping is correct.
      await runExclusive(`gbp-degraded-notify:${loc.id}`, async () => {
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recent = await db('notifications')
          .where({ recipient_type: 'admin', title })
          .where('created_at', '>', dayAgo)
          .first();
        if (recent) return;

        // A reconcile failure is its own case: the authoritative pull
        // SUCCEEDED (new reviews still sync, no Places fallback runs), but
        // removal detection is dead until the reconcile works — the body
        // must not claim the feed is down or that a fallback will run.
        const detail = cause === 'no_client'
          ? `the GBP client could not be initialized: ${await this._describeCredentialGap(loc)}`
          : `the GBP Reviews API pull failed: ${cause}`;
        // Without a Maps key the caller skips the Places sample entirely —
        // the alert must not claim a partial feed remains during what is
        // actually a complete tracking outage. With a key, this alert fires
        // BEFORE the fallback runs (deliberately — a fallback failure must
        // not swallow it), so describe the sample as an attempt, not a fact.
        const fallbackState = process.env.GOOGLE_MAPS_API_KEY
          ? `is degraded — the sync will attempt the ~5-review Places sample fallback`
          : `is fully down — no Places fallback is available (GOOGLE_MAPS_API_KEY is not set)`;
        const body = reconcileFailure
          ? `Review sync for ${loc.name} pulled the GBP feed, but the ${cause}. New reviews are still syncing; REMOVALS will not be detected until the reconcile succeeds.`
          : `Review tracking for ${loc.name} ${fallbackState} because ${detail}. Removed reviews and most new reviews will NOT be detected until the GBP connection works.`;
        await NotificationService.notifyAdmin(
          'review',
          title,
          body,
          { bell: true, link: '/admin/reviews', metadata: { locationId: loc.id, reason: 'gbp_sync_degraded', cause } },
        );
        logger.warn(`[gbp] Review sync degraded for ${loc.name} (${cause === 'no_client' ? 'no client' : 'pull failed'}) — admin notified`);
      }, { recordHealth: false });
    } catch (err) {
      logger.warn(`[gbp] Degraded-sync notify failed for ${loc.name}: ${err.message}`);
    }
  }

  /**
   * Name the credential component that is actually missing, mirroring the
   * checks _getClient performs (env client id/secret; refresh token from
   * system_settings first, env fallback) — so the degraded-sync alert sends
   * the admin to the right knob instead of guessing "token not set".
   */
  async _describeCredentialGap(loc) {
    try {
      const envKey = LOCATION_ENV_KEYS[loc.id];
      if (!envKey) return 'no GBP credential mapping exists for this location';
      const missing = [];
      if (!process.env[`GBP_CLIENT_ID_${envKey}`] || !process.env[`GBP_CLIENT_SECRET_${envKey}`]) {
        missing.push(`the OAuth client credentials (GBP_CLIENT_ID_${envKey} / GBP_CLIENT_SECRET_${envKey})`);
      }
      const stored = await this._getStoredTokens(loc.id);
      if (!stored.refresh_token && !process.env[`GBP_REFRESH_TOKEN_${envKey}`]) {
        missing.push(`a refresh token (connect the location in admin Google settings, or set GBP_REFRESH_TOKEN_${envKey})`);
      }
      if (missing.length === 0) return 'credentials are present but the client still failed to initialize';
      return `missing ${missing.join(' and ')}`;
    } catch {
      return 'the GBP credential state could not be determined';
    }
  }

  /**
   * Fetch reviews from GBP API and match to stored reviews to populate gbp_review_name.
   * This enables reply posting. Only processes reviews without a gbp_review_name already set.
   */
  async _resolveGbpResourceNames() {
    try {
      const unresolved = await db('google_reviews')
        .whereNull('gbp_review_name')
        .where('reviewer_name', '!=', '_stats')
        .select('id', 'reviewer_name', 'review_created_at', 'location_id');
      if (unresolved.length === 0) return;

      // Group by location
      const byLocation = {};
      for (const r of unresolved) {
        if (!byLocation[r.location_id]) byLocation[r.location_id] = [];
        byLocation[r.location_id].push(r);
      }

      for (const [locId, reviews] of Object.entries(byLocation)) {
        const loc = WAVES_LOCATIONS.find(l => l.id === locId);
        if (!loc?.googleLocationResourceName) continue;
        if (!(await this._getClient(locId))) continue;

        try {
          const gbpReviews = await this.getAllLocationReviews(loc.googleLocationResourceName, locId, 100);
          for (const gbpRev of gbpReviews) {
            // Match by reviewer display name + approximate timestamp
            const gbpName = gbpRev.reviewer?.displayName || '';
            const gbpTime = gbpRev.createTime ? new Date(gbpRev.createTime).getTime() : 0;

            const match = reviews.find(r => {
              if (!r.reviewer_name || !r.review_created_at) return false;
              const localTime = new Date(r.review_created_at).getTime();
              const nameMatch = r.reviewer_name.toLowerCase() === gbpName.toLowerCase();
              const timeClose = Math.abs(localTime - gbpTime) < 86400000; // within 24h
              return nameMatch && timeClose;
            });

            if (match && gbpRev.name) {
              await db('google_reviews').where({ id: match.id }).update({ gbp_review_name: gbpRev.name });
              logger.info(`[gbp] Resolved GBP resource name for ${gbpName}: ${gbpRev.name}`);
            }
          }
        } catch (err) {
          logger.warn(`[gbp] GBP resource name resolution failed for ${loc.name}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`[gbp] Resource name resolution skipped: ${err.message}`);
    }
  }

  // =========================================================================
  // PERFORMANCE METRICS SYNC — daily GBP insights per location
  // =========================================================================

  /**
   * Sync Google Business Profile Performance metrics into gbp_performance_daily.
   * Uses the Business Profile Performance API v1:
   *   https://businessprofileperformance.googleapis.com/v1/locations/{id}:fetchMultiDailyMetricsTimeSeries
   *
   * Data has a ~2-day reporting lag. Upserts by (location_id, date).
   */
  async syncPerformanceDaily(daysBack = 7) {
    const configuredLocations = await this.getConfiguredLocations();
    if (configuredLocations.length === 0) {
      logger.warn('[gbp] No GBP credentials — skipping performance sync');
      return { synced: false, partial: false, rows: 0, errors: [], reason: 'not_configured' };
    }

    const METRICS = [
      'CALL_CLICKS',
      'WEBSITE_CLICKS',
      'BUSINESS_DIRECTION_REQUESTS',
      'BUSINESS_BOOKINGS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    ];

    const end = new Date(Date.now() - 2 * 86400000); // 2-day lag
    const start = new Date(end.getTime() - daysBack * 86400000);
    const pad = n => String(n).padStart(2, '0');
    const dateRangeQS = [
      `dailyRange.startDate.year=${start.getUTCFullYear()}`,
      `dailyRange.startDate.month=${start.getUTCMonth() + 1}`,
      `dailyRange.startDate.day=${start.getUTCDate()}`,
      `dailyRange.endDate.year=${end.getUTCFullYear()}`,
      `dailyRange.endDate.month=${end.getUTCMonth() + 1}`,
      `dailyRange.endDate.day=${end.getUTCDate()}`,
    ].join('&');
    const metricsQS = METRICS.map(m => `dailyMetrics=${m}`).join('&');

    let totalRows = 0;
    const errors = [];

    for (const loc of configuredLocations) {
      try {
        const headers = await this._getHeaders(loc.id);
        const url = `https://businessprofileperformance.googleapis.com/v1/locations/${loc.googleLocationId}:fetchMultiDailyMetricsTimeSeries?${metricsQS}&${dateRangeQS}`;
        const resp = await fetch(url, { headers });
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`${resp.status} ${body.slice(0, 200)}`);
        }
        const data = await resp.json();

        // Aggregate metric values by date
        const byDate = {}; // { 'YYYY-MM-DD': { metric: value } }
        for (const series of (data.multiDailyMetricTimeSeries || [])) {
          for (const entry of (series.dailyMetricTimeSeries || [])) {
            const metric = entry.dailyMetric;
            const points = entry.timeSeries?.datedValues || [];
            for (const p of points) {
              const d = `${p.date.year}-${pad(p.date.month)}-${pad(p.date.day)}`;
              if (!byDate[d]) byDate[d] = {};
              byDate[d][metric] = parseInt(p.value || 0, 10);
            }
          }
        }

        // Upsert per day
        for (const [date, metrics] of Object.entries(byDate)) {
          const row = {
            location_id: loc.id,
            location_name: loc.name,
            date,
            calls: metrics.CALL_CLICKS || 0,
            website_clicks: metrics.WEBSITE_CLICKS || 0,
            direction_requests: metrics.BUSINESS_DIRECTION_REQUESTS || 0,
            bookings: metrics.BUSINESS_BOOKINGS || 0,
            search_views:
              (metrics.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH || 0) +
              (metrics.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0),
            maps_views:
              (metrics.BUSINESS_IMPRESSIONS_DESKTOP_MAPS || 0) +
              (metrics.BUSINESS_IMPRESSIONS_MOBILE_MAPS || 0),
            metadata: metrics,
            updated_at: db.fn.now(),
          };
          await db('gbp_performance_daily')
            .insert(row)
            .onConflict(['location_id', 'date'])
            .merge();
          totalRows++;
        }

        logger.info(`[gbp] Performance synced for ${loc.name}: ${Object.keys(byDate).length} days`);
      } catch (err) {
        logger.error(`[gbp] Performance sync failed for ${loc.name}: ${err.message}`);
        errors.push({ location: loc.name, error: err.message });
      }
    }

    const synced = errors.length === 0;
    return {
      synced,
      partial: totalRows > 0 && errors.length > 0,
      rows: totalRows,
      errors,
    };
  }

  // =========================================================================
  // OAUTH HELPERS — for initial token setup
  // =========================================================================
  getAuthUrl(locationId, state = locationId) {
    const envKey = LOCATION_ENV_KEYS[locationId];
    if (!envKey) throw new Error(`Unknown location: ${locationId}`);
    const clientId = process.env[`GBP_CLIENT_ID_${envKey}`];
    const clientSecret = process.env[`GBP_CLIENT_SECRET_${envKey}`];
    if (!clientId || !clientSecret) throw new Error(`GBP_CLIENT_ID_${envKey} and GBP_CLIENT_SECRET_${envKey} must be set first`);
    const client = new (getGoogle()).auth.OAuth2(clientId, clientSecret, this.redirectUri);
    return client.generateAuthUrl({
      access_type: 'offline', prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/business.manage'],
      state,
    });
  }

  async handleCallback(code, locationId) {
    const envKey = LOCATION_ENV_KEYS[locationId];
    const clientId = process.env[`GBP_CLIENT_ID_${envKey}`];
    const clientSecret = process.env[`GBP_CLIENT_SECRET_${envKey}`];
    if (!clientId || !clientSecret) throw new Error(`GBP_CLIENT_ID_${envKey} and GBP_CLIENT_SECRET_${envKey} must be set first`);
    const client = new (getGoogle()).auth.OAuth2(clientId, clientSecret, this.redirectUri);
    const { tokens } = await client.getToken(code);
    return this.storeTokens(locationId, tokens);
  }
}

module.exports = new GoogleBusinessService();
