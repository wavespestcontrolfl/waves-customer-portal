const { google } = require('googleapis');
const logger = require('./logger');
const db = require('../models/db');
const { WAVES_LOCATIONS } = require('../config/locations');

/**
 * Google Business Profile service — multi-account support.
 *
 * One OAuth2 Client ID + Secret (shared across all accounts).
 * Separate refresh token per Google account (each location is owned by a different account).
 *
 * Env vars:
 *   GBP_CLIENT_ID            — OAuth2 client ID (one Google Cloud project)
 *   GBP_CLIENT_SECRET        — OAuth2 client secret
 *   GBP_REFRESH_TOKEN_LWR    — Refresh token for Lakewood Ranch account
 *   GBP_REFRESH_TOKEN_PARRISH — Refresh token for Parrish account
 *   GBP_REFRESH_TOKEN_SARASOTA — Refresh token for Sarasota account
 *   GBP_REFRESH_TOKEN_VENICE  — Refresh token for Venice account
 *
 * Legacy fallback: GOOGLE_BUSINESS_CLIENT_ID, GOOGLE_BUSINESS_CLIENT_SECRET,
 *   GOOGLE_BUSINESS_REFRESH_TOKEN (single-account mode)
 */
class GoogleBusinessService {
  constructor() {
    this.clientId = process.env.GBP_CLIENT_ID || process.env.GOOGLE_BUSINESS_CLIENT_ID;
    this.clientSecret = process.env.GBP_CLIENT_SECRET || process.env.GOOGLE_BUSINESS_CLIENT_SECRET;
    this.redirectUri = process.env.GBP_REDIRECT_URI || process.env.GOOGLE_BUSINESS_REDIRECT_URI || 'https://portal.wavespestcontrol.com/api/admin/settings/google/callback';

    this.configured = !!(this.clientId && this.clientSecret);

    // Cache of OAuth2 clients per location
    this._clients = {};

    if (!this.configured) {
      logger.warn('[gbp] GBP_CLIENT_ID or GBP_CLIENT_SECRET not set — Google Business Profile disabled');
    }
  }

  /**
   * Get an OAuth2 client for a specific location.
   * Each location may use a different Google account (different refresh token).
   */
  _getClient(locationId) {
    if (this._clients[locationId]) return this._clients[locationId];

    const loc = WAVES_LOCATIONS.find(l => l.id === locationId);
    const tokenEnvKey = loc?.googleRefreshTokenEnv;
    const refreshToken = tokenEnvKey ? process.env[tokenEnvKey] : null;

    // Legacy fallback: single token for all
    const fallbackToken = process.env.GOOGLE_BUSINESS_REFRESH_TOKEN;
    const token = refreshToken || fallbackToken;

    if (!token || !this.configured) return null;

    const client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
    client.setCredentials({ refresh_token: token });
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
   * Check which locations have tokens configured.
   */
  getConfiguredLocations() {
    return WAVES_LOCATIONS.filter(loc => {
      const tokenEnvKey = loc.googleRefreshTokenEnv;
      return (tokenEnvKey && process.env[tokenEnvKey]) || process.env.GOOGLE_BUSINESS_REFRESH_TOKEN;
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

      // Check if this location has a token
      const tokenEnvKey = loc.googleRefreshTokenEnv;
      const hasToken = (tokenEnvKey && process.env[tokenEnvKey]) || process.env.GOOGLE_BUSINESS_REFRESH_TOKEN;
      if (!hasToken) {
        errors.push({ location: loc.name, error: 'No refresh token configured' });
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
    if (!this.configured) throw new Error('OAuth not configured — set GBP_CLIENT_ID and GBP_CLIENT_SECRET');
    const client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
    return client.generateAuthUrl({
      access_type: 'offline', prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/business.manage'],
      state: locationId || '', // Pass location ID through OAuth flow
    });
  }

  async handleCallback(code) {
    const client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
    const { tokens } = await client.getToken(code);
    return tokens;
  }
}

module.exports = new GoogleBusinessService();
