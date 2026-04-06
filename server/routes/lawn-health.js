const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// =========================================================================
// GET /api/lawn-health/:customerId — Latest + initial scores from AI assessments
// =========================================================================
router.get('/:customerId', async (req, res, next) => {
  try {
    const { customerId } = req.params;

    // Only allow customers to view their own data
    if (customerId !== req.customerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Check if customer has any lawn assessments (from admin AI panel)
    const assessments = await db('lawn_assessments')
      .where({ customer_id: customerId })
      .orderBy('service_date', 'asc');

    if (!assessments.length) {
      return res.json({ hasLawnCare: false, scores: null, initialScores: null });
    }

    const initial = assessments[0];
    const latest = assessments[assessments.length - 1];

    const formatScore = (row) => ({
      assessmentDate: row.service_date,
      turfDensity: row.turf_density,
      weedSuppression: row.weed_suppression,
      fungusControl: row.fungus_control,
      thatchScore: row.thatch_level,
      thatchInches: null,
      overallScore: Math.round(
        (row.turf_density + row.weed_suppression + row.fungus_control +
          (row.color_health || 0) + (row.thatch_level || 0)) / 5
      ),
      notes: row.observations,
    });

    res.json({
      hasLawnCare: true,
      scores: formatScore(latest),
      initialScores: formatScore(initial),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/lawn-health/:customerId/history — All assessments over time
// =========================================================================
router.get('/:customerId/history', async (req, res, next) => {
  try {
    const { customerId } = req.params;

    if (customerId !== req.customerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const history = await db('lawn_assessments')
      .where({ customer_id: customerId })
      .orderBy('service_date', 'asc')
      .select(
        'service_date as assessment_date',
        'turf_density',
        'weed_suppression',
        'fungus_control',
        'thatch_level',
        'color_health',
        'observations',
        'season'
      );

    res.json({
      history: history.map(row => ({
        assessmentDate: row.assessment_date,
        turfDensity: row.turf_density,
        weedSuppression: row.weed_suppression,
        fungusControl: row.fungus_control,
        thatchScore: row.thatch_level,
        thatchInches: null,
        overallScore: Math.round(
          (row.turf_density + row.weed_suppression + row.fungus_control +
            (row.color_health || 0) + (row.thatch_level || 0)) / 5
        ),
        notes: row.observations,
        season: row.season,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
