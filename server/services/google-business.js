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
const DRAFT_REPLY_PREFIX = '[DRAFT]';

function isDraftReply(reply) {
  return typeof reply === 'string' && reply.trim().startsWith(DRAFT_REPLY_PREFIX);
}

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
    // Check if any location has credentials
    this.configured = Object.values(LOCATION_ENV_KEYS).some(key =>
      process.env[`GBP_CLIENT_ID_${key}`] &&
      process.env[`GBP_CLIENT_SECRET_${key}`] &&
      process.env[`GBP_REFRESH_TOKEN_${key}`]
    );

    const domain = process.env.SERVER_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || 'portal.wavespestcontrol.com';
    this.redirectUri = process.env.GBP_REDIRECT_URI || `https://${domain}/api/admin/settings/google/callback`;

    // Cache of OAuth2 clients per location
    this._clients = {};

    if (!this.configured) {
      logger.warn('[gbp] No GBP credentials found for any location — Google Business Profile disabled');
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

  async replyToReview(reviewResourceName, replyText, locationId) {
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
    const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ comment: replyText }) });
    return readJsonOrThrow(res, 'GBP replyToReview');
  }

  async deleteReply(reviewResourceName, locationId) {
    if (!locationId) {
      const match = reviewResourceName.match(/accounts\/(\d+)\/locations\/(\d+)/);
      if (match) {
        const loc = WAVES_LOCATIONS.find(l => l.googleAccountId === match[1]);
        locationId = loc?.id || 'bradenton';
      }
    }
    const headers = await this._getHeaders(locationId);
    const url = `https://mybusiness.googleapis.com/v4/${reviewResourceName}/reply`;
    const res = await fetch(url, { method: 'DELETE', headers });
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
    const customer = await db('customers')
      .whereRaw("LOWER(TRIM(first_name || ' ' || COALESCE(last_name, ''))) = LOWER(?)", [reviewerName])
      .first();
    return customer?.id || null;
  }

  async _findExistingReview(normalized) {
    let existing = await db('google_reviews').where({ gbp_review_name: normalized.gbp_review_name }).first();
    if (existing) return existing;
    existing = await db('google_reviews').where({ google_review_id: normalized.google_review_id }).first();
    if (existing) return existing;
    const candidates = await db('google_reviews')
      .where({ location_id: normalized.location_id })
      .where('reviewer_name', '!=', '_stats')
      .select('id', 'reviewer_name', 'review_created_at');
    return candidates.find(row => sameReviewerAndTime(row, normalized.reviewer_name, normalized.review_created_at)) || null;
  }

  async _upsertGbpReview(normalized) {
    const existing = await this._findExistingReview(normalized);
    const customerId = await this._findCustomerIdByReviewerName(normalized.reviewer_name);
    const replyFields = isDraftReply(existing?.review_reply)
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
      customer_id: customerId || existing?.customer_id || null,
      synced_at: db.fn.now(),
      ...replyFields,
    };
    if (existing) {
      await db('google_reviews').where({ id: existing.id }).update(row);
      return { id: existing.id, inserted: false };
    }
    const [insertedReview] = await db('google_reviews').insert(row).returning('id');
    return { id: insertedReview?.id || insertedReview, inserted: true };
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

  async _syncPlacesReviewSampleForLocation(loc, googleKey) {
    if (!loc.googlePlaceId || !googleKey) return { synced: 0, new: 0 };
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${loc.googlePlaceId}&fields=reviews,rating,user_ratings_total,name&reviews_sort=newest&key=${googleKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK') throw new Error(`Places API: ${data.status}`);
    const reviews = data.result?.reviews || [];
    let synced = 0, newCount = 0;
    for (const review of reviews) {
      const googleId = `places_${loc.googlePlaceId}_${review.time}`;
      const existing = await db('google_reviews').where({ google_review_id: googleId }).first();
      const ownerReply = review.owner_response?.text || null;
      const customerId = await this._findCustomerIdByReviewerName(review.author_name || 'Anonymous');
      if (existing) {
        const upd = {
          star_rating: review.rating || 0,
          review_text: review.text || null,
          reviewer_photo_url: review.profile_photo_url || null,
          customer_id: customerId || existing.customer_id,
          synced_at: db.fn.now(),
        };
        if (ownerReply && (!existing.review_reply || isDraftReply(existing.review_reply))) {
          upd.review_reply = ownerReply;
          upd.reply_updated_at = db.fn.now();
        }
        await db('google_reviews').where({ id: existing.id }).update(upd);
      } else {
        await db('google_reviews').insert({
          google_review_id: googleId,
          location_id: loc.id,
          reviewer_name: review.author_name || 'Anonymous',
          reviewer_photo_url: review.profile_photo_url || null,
          star_rating: review.rating || 0,
          review_text: review.text || null,
          review_reply: ownerReply,
          reply_updated_at: ownerReply ? new Date() : null,
          review_created_at: new Date(review.time * 1000).toISOString(),
          customer_id: customerId,
          synced_at: db.fn.now(),
        }).returning('id');
        newCount++;
      }
      synced++;
    }
    return { synced, new: newCount };
  }

  // =========================================================================
  // REVIEW SYNC - GBP Reviews API primary; Places kept for stats/fallback.
  // =========================================================================
  async syncAllReviews() {
    const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!GOOGLE_KEY) {
      logger.error('[google-business] GOOGLE_MAPS_API_KEY not set - skipping review sync');
      return { synced: 0, error: 'GOOGLE_MAPS_API_KEY not configured' };
    }
    let totalSynced = 0, totalNew = 0;
    const errors = [];
    const sources = {};

    for (const loc of WAVES_LOCATIONS) {
      try {
        await this._syncPlacesStatsForLocation(loc, GOOGLE_KEY).catch(err => {
          logger.warn(`[gbp] Places stats sync failed for ${loc.name}: ${err.message}`);
        });

        let usedGbp = false;
        if (loc.googleLocationResourceName && await this._getClient(loc.id)) {
          try {
            const reviews = await this.getAllLocationReviews(loc.googleLocationResourceName, loc.id, 100);
            for (const review of reviews) {
              const normalized = this._normalizeGbpReview(review, loc);
              const result = await this._upsertGbpReview(normalized);
              if (result.inserted) totalNew++;
              totalSynced++;
            }
            sources[loc.id] = 'gbp';
            usedGbp = true;
            logger.info(`[gbp] Synced ${reviews.length} reviews for ${loc.name} via GBP Reviews API`);
          } catch (gbpErr) {
            errors.push({ location: loc.name, error: gbpErr.message, source: 'gbp' });
            logger.warn(`[gbp] GBP Reviews sync failed for ${loc.name}; using Places fallback: ${gbpErr.message}`);
          }
        }

        if (!usedGbp) {
          const sample = await this._syncPlacesReviewSampleForLocation(loc, GOOGLE_KEY);
          totalSynced += sample.synced;
          totalNew += sample.new;
          sources[loc.id] = sample.synced > 0 ? 'places_fallback' : 'none';
          logger.info(`[gbp] Synced ${sample.synced} review sample rows for ${loc.name} via Places API fallback`);
        }
      } catch (err) {
        logger.error(`Review sync failed for ${loc.name}: ${err.message}`);
        errors.push({ location: loc.name, error: err.message });
        if (!sources[loc.id]) sources[loc.id] = 'none';
      }
    }

    await this._resolveGbpResourceNames();

    return { synced: totalSynced, new: totalNew, errors, sources };
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
