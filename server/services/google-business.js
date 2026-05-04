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
  'lakewood-ranch': 'LWR',
  'parrish': 'PARRISH',
  'sarasota': 'SARASOTA',
  'venice': 'VENICE',
};

class GoogleBusinessService {
  constructor() {
    // Check if any location has credentials
    this.configured = Object.values(LOCATION_ENV_KEYS).some(key =>
      process.env[`GBP_CLIENT_ID_${key}`] && process.env[`GBP_REFRESH_TOKEN_${key}`]
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
  _getClient(locationId) {
    if (this._clients[locationId]) return this._clients[locationId];

    const envKey = LOCATION_ENV_KEYS[locationId];
    if (!envKey) return null;

    const clientId = process.env[`GBP_CLIENT_ID_${envKey}`];
    const clientSecret = process.env[`GBP_CLIENT_SECRET_${envKey}`];
    const refreshToken = process.env[`GBP_REFRESH_TOKEN_${envKey}`];

    if (!clientId || !clientSecret || !refreshToken) return null;

    const client = new (getGoogle()).auth.OAuth2(clientId, clientSecret, this.redirectUri);
    client.setCredentials({ refresh_token: refreshToken });
    this._clients[locationId] = client;
    return client;
  }

  /**
   * Get auth headers for a specific location's Google account.
   */
  async _getHeaders(locationId) {
    const client = this._getClient(locationId);
    if (!client) throw new Error(`No GBP credentials for location: ${locationId}`);
    const { token } = await client.getAccessToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  /**
   * Check which locations have credentials configured.
   */
  getConfiguredLocations() {
    return WAVES_LOCATIONS.filter(loc => {
      const envKey = LOCATION_ENV_KEYS[loc.id];
      return envKey && process.env[`GBP_CLIENT_ID_${envKey}`] && process.env[`GBP_REFRESH_TOKEN_${envKey}`];
    });
  }

  // =========================================================================
  // REVIEWS
  // =========================================================================
  async getReviews(locationResourceName, locationId, pageSize = 50) {
    const headers = await this._getHeaders(locationId);
    const url = `https://mybusiness.googleapis.com/v4/${locationResourceName}/reviews?pageSize=${pageSize}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GBP API ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.reviews || [];
  }

  async getAllReviews(pageSize = 50) {
    const allReviews = [];
    for (const loc of WAVES_LOCATIONS) {
      if (!loc.googleLocationResourceName) continue;
      try {
        const reviews = await this.getReviews(loc.googleLocationResourceName, loc.id, pageSize);
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
        locationId = loc?.id || 'lakewood-ranch';
      }
    }
    const headers = await this._getHeaders(locationId);
    const url = `https://mybusiness.googleapis.com/v4/${reviewResourceName}/reply`;
    const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ comment: replyText }) });
    if (!res.ok) throw new Error(`Reply failed: ${res.status}`);
    return res.json();
  }

  async deleteReply(reviewResourceName, locationId) {
    if (!locationId) {
      const match = reviewResourceName.match(/accounts\/(\d+)\/locations\/(\d+)/);
      if (match) {
        const loc = WAVES_LOCATIONS.find(l => l.googleAccountId === match[1]);
        locationId = loc?.id || 'lakewood-ranch';
      }
    }
    const headers = await this._getHeaders(locationId);
    const url = `https://mybusiness.googleapis.com/v4/${reviewResourceName}/reply`;
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok) throw new Error(`Delete reply failed: ${res.status}`);
    return true;
  }

  // =========================================================================
  // LOCATION METRICS
  // =========================================================================
  async getLocationDetails(locationResourceName, locationId) {
    const headers = await this._getHeaders(locationId);
    const url = `https://mybusiness.googleapis.com/v4/${locationResourceName}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Location fetch failed: ${res.status}`);
    return res.json();
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
    if (!res.ok) throw new Error(`Post failed: ${res.status}`);
    return res.json();
  }

  // =========================================================================
  // REVIEW SYNC — uses Google Places API (no GBP API access needed)
  // =========================================================================
  async syncAllReviews() {
    const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!GOOGLE_KEY) {
      logger.error('[google-business] GOOGLE_MAPS_API_KEY not set — skipping review sync');
      return { synced: 0, error: 'GOOGLE_MAPS_API_KEY not configured' };
    }
    let totalSynced = 0, totalNew = 0;
    const errors = [];

    for (const loc of WAVES_LOCATIONS) {
      if (!loc.googlePlaceId) continue;

      try {
        const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${loc.googlePlaceId}&fields=reviews,rating,user_ratings_total,name&reviews_sort=newest&key=${GOOGLE_KEY}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.status !== 'OK') {
          errors.push({ location: loc.name, error: `Places API: ${data.status}` });
          continue;
        }

        const reviews = data.result?.reviews || [];
        const googleRating = data.result?.rating || null;
        const googleTotalReviews = data.result?.user_ratings_total || null;

        // Store aggregate stats for this location
        if (googleRating || googleTotalReviews) {
          try {
            const existing = await db('google_reviews')
              .where({ google_review_id: `places_stats_${loc.id}` }).first();
            const statsData = JSON.stringify({ rating: googleRating, totalReviews: googleTotalReviews });
            if (existing) {
              await db('google_reviews').where({ id: existing.id }).update({
                review_text: statsData, synced_at: db.fn.now(),
              });
            } else {
              await db('google_reviews').insert({
                google_review_id: `places_stats_${loc.id}`, location_id: loc.id,
                reviewer_name: '_stats', star_rating: Math.round(googleRating || 5),
                review_text: statsData, review_created_at: new Date().toISOString(),
                synced_at: db.fn.now(),
              });
            }
          } catch { /* non-critical */ }
        }

        for (const review of reviews) {
          // Places API uses author_name + time as unique key (no stable ID)
          const googleId = `places_${loc.googlePlaceId}_${review.time}`;
          const rating = review.rating || 0;
          const reviewerName = review.author_name || 'Anonymous';
          const reviewText = review.text || null;
          const reviewerPhoto = review.profile_photo_url || null;
          const createdAt = new Date(review.time * 1000).toISOString();

          // Places API includes owner response if one exists
          const ownerReply = review.owner_response?.text || null;

          let customerId = null;
          if (reviewerName && reviewerName !== 'Anonymous') {
            const customer = await db('customers')
              .whereRaw("LOWER(TRIM(first_name || ' ' || COALESCE(last_name, ''))) = LOWER(?)", [reviewerName])
              .first();
            if (customer) customerId = customer.id;
          }

          const existing = await db('google_reviews').where({ google_review_id: googleId }).first();

          if (existing) {
            const upd = {
              star_rating: rating, review_text: reviewText,
              reviewer_photo_url: reviewerPhoto,
              customer_id: customerId || existing.customer_id,
              synced_at: db.fn.now(),
            };
            // Only update reply from Google if we don't have a real local reply already.
            if (ownerReply && (!existing.review_reply || isDraftReply(existing.review_reply))) {
              upd.review_reply = ownerReply;
              upd.reply_updated_at = db.fn.now();
            }
            await db('google_reviews').where({ id: existing.id }).update(upd);
            totalSynced++;
          } else {
            const [insertedReview] = await db('google_reviews').insert({
              google_review_id: googleId, location_id: loc.id,
              reviewer_name: reviewerName, reviewer_photo_url: reviewerPhoto,
              star_rating: rating, review_text: reviewText,
              review_reply: ownerReply, reply_updated_at: ownerReply ? new Date() : null,
              review_created_at: createdAt, customer_id: customerId, synced_at: db.fn.now(),
            }).returning('id');
            const insertedReviewId = insertedReview?.id || insertedReview;
            totalNew++;
            totalSynced++;

            if (rating <= 2) {
              await db('activity_log').insert({
                action: 'review_received',
                description: `New ${rating}-star review on ${loc.name} from ${reviewerName}: "${(reviewText || '').slice(0, 100)}"`,
                metadata: JSON.stringify({ locationId: loc.id, rating, reviewerName }),
              });

              // --- Negative review escalation ---
              try {
                const WAVES_ADMIN_PHONE = '+19413187612';
                const TwilioService = require('./twilio');
                await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
                  `⚠️ ${rating}-star review from ${reviewerName} on ${loc.name}: "${(reviewText || 'No comment').substring(0, 100)}..."`,
                  { messageType: 'internal_alert' }
                );
              } catch (smsErr) {
                logger.error(`[gbp] Negative review SMS alert failed: ${smsErr.message}`);
              }

              // Store generated drafts with a sentinel prefix so the Reviews UI
              // can surface them without counting them as real Google replies.
              try {
                const Anthropic = require('@anthropic-ai/sdk');
                const aiClient = new Anthropic();
                const aiMsg = await aiClient.messages.create({
                  model: MODELS.FLAGSHIP,
                  max_tokens: 400,
                  messages: [{ role: 'user', content: `Write a professional, empathetic reply to a ${rating}-star review for Waves Pest Control ${loc.name}. The reviewer "${reviewerName}" said: "${reviewText || '(no comment)'}". Keep it under 2 paragraphs. Acknowledge the concern, apologize, and invite them to contact us directly. End with: The 🌊 Waves Pest Control ${loc.name} Team` }],
                });
                const draftReply = aiMsg.content[0]?.text || '';
                if (draftReply) {
                  if (!ownerReply && insertedReviewId) {
                    await db('google_reviews').where({ id: insertedReviewId }).update({
                      review_reply: `${DRAFT_REPLY_PREFIX} ${draftReply}`,
                    });
                  }
                  await db('activity_log').insert({
                    action: 'review_reply_draft_generated',
                    description: `AI reply draft generated for ${rating}-star review on ${loc.name}`,
                    metadata: JSON.stringify({ locationId: loc.id, rating, googleReviewId: googleId, reviewRowId: insertedReviewId || null }),
                  }).catch(() => {});
                }
              } catch (aiErr) {
                logger.error(`[gbp] AI draft reply generation failed: ${aiErr.message}`);
              }

              // Create escalation interaction if customer matched
              if (customerId) {
                try {
                  await db('customer_interactions').insert({
                    customer_id: customerId,
                    interaction_type: 'escalation',
                    subject: `${rating}-star Google review escalation`,
                    notes: `Negative review on ${loc.name}: "${(reviewText || '').slice(0, 300)}"`,
                    channel: 'google_review',
                  });
                } catch (intErr) {
                  logger.error(`[gbp] Escalation interaction insert failed: ${intErr.message}`);
                }
              }
            }
          }
        }

        logger.info(`[gbp] Synced ${reviews.length} reviews for ${loc.name} via Places API`);
      } catch (err) {
        logger.error(`Review sync failed for ${loc.name}: ${err.message}`);
        errors.push({ location: loc.name, error: err.message });
      }
    }

    // After Places API sync, try to resolve GBP resource names for reviews missing them
    await this._resolveGbpResourceNames();

    return { synced: totalSynced, new: totalNew, errors };
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
        if (!this._getClient(locId)) continue;

        try {
          const gbpReviews = await this.getReviews(loc.googleLocationResourceName, locId, 100);
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
    if (!this.configured) {
      logger.warn('[gbp] No GBP credentials — skipping performance sync');
      return { synced: false, reason: 'not_configured' };
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

    for (const loc of this.getConfiguredLocations()) {
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

    return { synced: true, rows: totalRows, errors };
  }

  // =========================================================================
  // OAUTH HELPERS — for initial token setup
  // =========================================================================
  getAuthUrl(locationId) {
    const envKey = LOCATION_ENV_KEYS[locationId];
    if (!envKey) throw new Error(`Unknown location: ${locationId}`);
    const clientId = process.env[`GBP_CLIENT_ID_${envKey}`];
    const clientSecret = process.env[`GBP_CLIENT_SECRET_${envKey}`];
    if (!clientId || !clientSecret) throw new Error(`GBP_CLIENT_ID_${envKey} and GBP_CLIENT_SECRET_${envKey} must be set first`);
    const client = new (getGoogle()).auth.OAuth2(clientId, clientSecret, this.redirectUri);
    return client.generateAuthUrl({
      access_type: 'offline', prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/business.manage'],
      state: locationId,
    });
  }

  async handleCallback(code, locationId) {
    const envKey = LOCATION_ENV_KEYS[locationId];
    const clientId = process.env[`GBP_CLIENT_ID_${envKey}`];
    const clientSecret = process.env[`GBP_CLIENT_SECRET_${envKey}`];
    const client = new (getGoogle()).auth.OAuth2(clientId, clientSecret, this.redirectUri);
    const { tokens } = await client.getToken(code);
    return tokens;
  }
}

module.exports = new GoogleBusinessService();
