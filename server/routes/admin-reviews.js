const express = require('express');
const router = express.Router();
const db = require('../models/db');
const gbp = require('../services/google-business');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { WAVES_LOCATIONS } = require('../config/locations');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/reviews — all reviews with filters
router.get('/', async (req, res, next) => {
  try {
    const { location, rating, responded, search, page = 1, limit = 30 } = req.query;

    let query = db('google_reviews')
      .leftJoin('customers', 'google_reviews.customer_id', 'customers.id')
      .select(
        'google_reviews.*',
        'customers.first_name as cust_first', 'customers.last_name as cust_last',
        'customers.waveguard_tier as cust_tier'
      )
      .orderBy('google_reviews.review_created_at', 'desc');

    if (location) query = query.where('google_reviews.location_id', location);
    if (rating) query = query.where('google_reviews.star_rating', parseInt(rating));
    if (responded === 'true') query = query.whereNotNull('google_reviews.review_reply');
    if (responded === 'false') query = query.whereNull('google_reviews.review_reply');
    if (search) query = query.where(function () {
      this.whereILike('google_reviews.reviewer_name', `%${search}%`)
        .orWhereILike('google_reviews.review_text', `%${search}%`);
    });

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const reviews = await query.limit(parseInt(limit)).offset(offset);

    // Aggregate stats
    const [totals, unresponded, thisMonth, perLocation] = await Promise.all([
      db('google_reviews').select(
        db.raw('COUNT(*) as total'),
        db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating'),
      ).first(),
      db('google_reviews').whereNull('review_reply').whereNotNull('review_text').count('* as count').first(),
      db('google_reviews').where('review_created_at', '>=', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()).count('* as count').first(),
      db('google_reviews').select('location_id')
        .count('* as count')
        .avg('star_rating as avg')
        .groupBy('location_id'),
    ]);

    // Star breakdown
    const breakdown = await db('google_reviews').select('star_rating').count('* as count').groupBy('star_rating').orderBy('star_rating', 'desc');

    res.json({
      reviews: reviews.map(r => ({
        id: r.id, googleReviewId: r.google_review_id, locationId: r.location_id,
        reviewerName: r.reviewer_name, reviewerPhoto: r.reviewer_photo_url,
        starRating: r.star_rating, reviewText: r.review_text,
        reply: r.review_reply, replyUpdatedAt: r.reply_updated_at,
        reviewCreatedAt: r.review_created_at,
        matchedCustomer: r.cust_first ? { name: `${r.cust_first} ${r.cust_last}`, tier: r.cust_tier, id: r.customer_id } : null,
        syncedAt: r.synced_at,
      })),
      stats: {
        totalReviews: parseInt(totals?.total || 0),
        avgRating: parseFloat(totals?.avg_rating || 0),
        unresponded: parseInt(unresponded?.count || 0),
        newThisMonth: parseInt(thisMonth?.count || 0),
        breakdown: Object.fromEntries(breakdown.map(b => [b.star_rating, parseInt(b.count)])),
        perLocation: perLocation.map(l => ({
          locationId: l.location_id,
          count: parseInt(l.count),
          avgRating: parseFloat(l.avg || 0).toFixed(1),
        })),
      },
      locations: WAVES_LOCATIONS.map(l => ({ id: l.id, name: l.name, reviewUrl: l.googleReviewUrl })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/:id/reply — reply to a review
router.post('/:id/reply', async (req, res, next) => {
  try {
    const { replyText } = req.body;
    if (!replyText) return res.status(400).json({ error: 'Reply text required' });

    const review = await db('google_reviews').where({ id: req.params.id }).first();
    if (!review) return res.status(404).json({ error: 'Review not found' });

    // Try to post to Google
    if (gbp.configured && review.google_review_id) {
      try {
        await gbp.replyToReview(review.google_review_id, replyText);
      } catch (e) {
        logger.error(`Google reply failed: ${e.message}`);
        // Still save locally even if Google API fails
      }
    }

    await db('google_reviews').where({ id: req.params.id }).update({
      review_reply: replyText, reply_updated_at: db.fn.now(),
    });

    await db('activity_log').insert({
      admin_user_id: req.technicianId, action: 'review_replied',
      description: `Replied to ${review.star_rating}-star review from ${review.reviewer_name} on ${review.location_id}`,
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/sync — manual sync
router.post('/sync', async (req, res, next) => {
  try {
    const result = await gbp.syncAllReviews();
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
