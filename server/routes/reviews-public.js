const express = require('express');
const router = express.Router();
const db = require('../models/db');

// GET /api/reviews/featured — public, no auth
router.get('/featured', async (req, res, next) => {
  try {
    const { location, limit = 8 } = req.query;

    let query = db('google_reviews')
      .where('star_rating', '>=', 4)
      .whereNotNull('review_text')
      .orderBy('review_created_at', 'desc');

    if (location) {
      // Prioritize the requested location, then fill from others
      const locReviews = await query.clone().where('location_id', location).limit(parseInt(limit));
      if (locReviews.length < parseInt(limit)) {
        const otherReviews = await query.clone().whereNot('location_id', location)
          .limit(parseInt(limit) - locReviews.length);
        const all = [...locReviews, ...otherReviews];
        return res.json(formatFeatured(all));
      }
      return res.json(formatFeatured(locReviews));
    }

    const reviews = await query.limit(parseInt(limit));
    res.json(formatFeatured(reviews));
  } catch (err) { next(err); }
});

function formatFeatured(reviews) {
  return {
    reviews: reviews.map(r => ({
      reviewerName: sanitizeName(r.reviewer_name),
      starRating: r.star_rating,
      text: r.review_text,
      date: r.review_created_at,
      location: r.location_id?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    })),
    aggregate: {
      averageRating: reviews.length > 0 ? (reviews.reduce((s, r) => s + r.star_rating, 0) / reviews.length).toFixed(1) : '0',
      totalCount: reviews.length,
    },
  };
}

function sanitizeName(name) {
  if (!name) return 'Customer';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1][0]}.`;
  return parts[0];
}

module.exports = router;
