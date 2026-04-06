const express = require('express');
const router = express.Router();
const ReviewService = require('../services/review-request');

// GET /api/review/:token — public review page data (no auth)
router.get('/:token', async (req, res, next) => {
  try {
    const data = await ReviewService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Review link not found or expired' });
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/review/:token — submit rating (no auth)
router.post('/:token', async (req, res, next) => {
  try {
    const { rating, feedbackText } = req.body;
    if (!rating || rating < 1 || rating > 10) {
      return res.status(400).json({ error: 'Rating must be between 1 and 10' });
    }
    const result = await ReviewService.submitRating(req.params.token, { rating, feedbackText });
    res.json(result);
  } catch (err) {
    if (err.message === 'Already rated') return res.status(409).json({ error: err.message });
    if (err.message === 'Review request not found') return res.status(404).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
