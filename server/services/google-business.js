const { google } = require('googleapis');
const logger = require('./logger');
const db = require('../models/db');
const { WAVES_LOCATIONS } = require('../config/locations');

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

    this.redirectUri = process.env.GBP_REDIRECT_URI || 'https://portal.wavespestcontrol.com/api/admin/settings/google/callback';

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

    const client = new google.auth.OAuth2(clientId, clientSecret, this.redirectUri);
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
  // REVIEW SYNC — fetches from Google and upserts into local DB
  // =========================================================================
  async syncAllReviews() {
    if (!this.configured) {
      logger.info('Google Business not configured — skipping review sync');
      return { synced: 0, new: 0, errors: [] };
    }

    let totalSynced = 0, totalNew = 0;
    const errors = [];

    for (const loc of WAVES_LOCATIONS) {
      if (!loc.googleLocationResourceName) continue;

      // Check if this location has credentials
      const envKey = LOCATION_ENV_KEYS[loc.id];
      if (!envKey || !process.env[`GBP_CLIENT_ID_${envKey}`] || !process.env[`GBP_REFRESH_TOKEN_${envKey}`]) {
        errors.push({ location: loc.name, error: 'No credentials configured' });
        continue;
      }

      try {
        const reviews = await this.getReviews(loc.googleLocationResourceName, loc.id, 50);

        for (const review of reviews) {
          const googleId = review.name;
          const rating = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 }[review.starRating] || 0;
          const reviewerName = review.reviewer?.displayName || 'Anonymous';
          const reviewText = review.comment || null;
          const replyText = review.reviewReply?.comment || null;
          const createdAt = review.createTime;

          let customerId = null;
          if (reviewerName && reviewerName !== 'Anonymous') {
            const customer = await db('customers')
              .whereRaw("LOWER(first_name || ' ' || last_name) = LOWER(?)", [reviewerName])
              .first();
            if (customer) customerId = customer.id;
          }

          const existing = await db('google_reviews').where({ google_review_id: googleId }).first();

          if (existing) {
            await db('google_reviews').where({ id: existing.id }).update({
              star_rating: rating, review_text: reviewText, review_reply: replyText,
              reply_updated_at: replyText ? db.fn.now() : null,
              reviewer_photo_url: review.reviewer?.profilePhotoUrl || null,
              customer_id: customerId || existing.customer_id,
              synced_at: db.fn.now(),
            });
            totalSynced++;
          } else {
            await db('google_reviews').insert({
              google_review_id: googleId, location_id: loc.id,
              reviewer_name: reviewerName, reviewer_photo_url: review.reviewer?.profilePhotoUrl || null,
              star_rating: rating, review_text: reviewText, review_reply: replyText,
              reply_updated_at: replyText ? new Date() : null,
              review_created_at: createdAt, customer_id: customerId, synced_at: db.fn.now(),
            });
            totalNew++;
            totalSynced++;

            if (rating <= 2) {
              await db('activity_log').insert({
                action: 'review_received',
                description: `New ${rating}-star review on ${loc.name} from ${reviewerName}: "${(reviewText || '').slice(0, 100)}"`,
                metadata: JSON.stringify({ locationId: loc.id, rating, reviewerName }),
              });
            }
          }
        }

        logger.info(`[gbp] Synced ${reviews.length} reviews for ${loc.name}`);
      } catch (err) {
        logger.error(`Review sync failed for ${loc.name}: ${err.message}`);
        errors.push({ location: loc.name, error: err.message });
      }
    }

    return { synced: totalSynced, new: totalNew, errors };
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
    const client = new google.auth.OAuth2(clientId, clientSecret, this.redirectUri);
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
    const client = new google.auth.OAuth2(clientId, clientSecret, this.redirectUri);
    const { tokens } = await client.getToken(code);
    return tokens;
  }
}

module.exports = new GoogleBusinessService();
