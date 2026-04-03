const { google } = require('googleapis');
const config = require('../config');
const logger = require('./logger');
const db = require('../models/db');
const { WAVES_LOCATIONS } = require('../config/locations');

class GoogleBusinessService {
  constructor() {
    this.configured = !!(process.env.GOOGLE_BUSINESS_CLIENT_ID && process.env.GOOGLE_BUSINESS_REFRESH_TOKEN);

    if (this.configured) {
      this.oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_BUSINESS_CLIENT_ID,
        process.env.GOOGLE_BUSINESS_CLIENT_SECRET,
        process.env.GOOGLE_BUSINESS_REDIRECT_URI || 'http://localhost:3001/api/admin/settings/google/callback'
      );
      this.oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_BUSINESS_REFRESH_TOKEN });
    }
  }

  async getHeaders() {
    if (!this.configured) throw new Error('Google Business Profile not configured');
    const { token } = await this.oauth2Client.getAccessToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  // =========================================================================
  // REVIEWS
  // =========================================================================
  async getReviews(locationResourceName, pageSize = 50) {
    const headers = await this.getHeaders();
    const url = `https://mybusiness.googleapis.com/v4/${locationResourceName}/reviews?pageSize=${pageSize}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GBP API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.reviews || [];
  }

  async getAllReviews(pageSize = 50) {
    const allReviews = [];
    for (const loc of WAVES_LOCATIONS) {
      if (!loc.googleLocationResourceName) continue;
      try {
        const reviews = await this.getReviews(loc.googleLocationResourceName, pageSize);
        reviews.forEach(r => allReviews.push({ ...r, _locationId: loc.id, _locationName: loc.name }));
      } catch (err) {
        logger.error(`Failed to fetch reviews for ${loc.name}: ${err.message}`);
      }
    }
    return allReviews;
  }

  async replyToReview(reviewResourceName, replyText) {
    const headers = await this.getHeaders();
    const url = `https://mybusiness.googleapis.com/v4/${reviewResourceName}/reply`;
    const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ comment: replyText }) });
    if (!res.ok) throw new Error(`Reply failed: ${res.status}`);
    return res.json();
  }

  async deleteReply(reviewResourceName) {
    const headers = await this.getHeaders();
    const url = `https://mybusiness.googleapis.com/v4/${reviewResourceName}/reply`;
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok) throw new Error(`Delete reply failed: ${res.status}`);
    return true;
  }

  // =========================================================================
  // LOCATION METRICS
  // =========================================================================
  async getLocationDetails(locationResourceName) {
    const headers = await this.getHeaders();
    const url = `https://mybusiness.googleapis.com/v4/${locationResourceName}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Location fetch failed: ${res.status}`);
    return res.json();
  }

  // =========================================================================
  // GOOGLE POSTS
  // =========================================================================
  async createPost(locationResourceName, { summary, callToAction, mediaUrl }) {
    const headers = await this.getHeaders();
    const url = `https://mybusiness.googleapis.com/v4/${locationResourceName}/localPosts`;
    const body = {
      languageCode: 'en',
      summary,
      topicType: 'STANDARD',
    };
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
      return { synced: 0, new: 0 };
    }

    let totalSynced = 0, totalNew = 0;

    for (const loc of WAVES_LOCATIONS) {
      if (!loc.googleLocationResourceName) continue;
      try {
        const reviews = await this.getReviews(loc.googleLocationResourceName, 50);

        for (const review of reviews) {
          const googleId = review.name; // resource name = unique ID
          const rating = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 }[review.starRating] || 0;
          const reviewerName = review.reviewer?.displayName || 'Anonymous';
          const reviewText = review.comment || null;
          const replyText = review.reviewReply?.comment || null;
          const createdAt = review.createTime;

          // Try to match to a customer
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

            // Alert on low ratings
            if (rating <= 2) {
              await db('activity_log').insert({
                action: 'review_received',
                description: `⚠️ New ${rating}-star review on ${loc.name} from ${reviewerName}: "${(reviewText || '').slice(0, 100)}"`,
                metadata: JSON.stringify({ locationId: loc.id, rating, reviewerName }),
              });
            }
          }
        }
      } catch (err) {
        logger.error(`Review sync failed for ${loc.name}: ${err.message}`);
      }
    }

    return { synced: totalSynced, new: totalNew };
  }

  // =========================================================================
  // OAUTH HELPERS
  // =========================================================================
  getAuthUrl() {
    if (!this.oauth2Client) throw new Error('OAuth not configured');
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline', prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/business.manage'],
    });
  }

  async handleCallback(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    return tokens;
  }
}

module.exports = new GoogleBusinessService();
