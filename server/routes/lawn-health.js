const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// =========================================================================
// GET /api/lawn-health/:customerId — Latest + initial scores
// =========================================================================
router.get('/:customerId', async (req, res, next) => {
  try {
    const { customerId } = req.params;

    // Only allow customers to view their own data
    if (customerId !== req.customerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Check if customer has any lawn care service records
    const lawnCareRecord = await db('service_records')
      .where({ customer_id: customerId })
      .andWhere('service_type', 'ilike', '%lawn care%')
      .first();

    if (!lawnCareRecord) {
      return res.json({ hasLawnCare: false, scores: null, initialScores: null });
    }

    // Get all health scores ordered by date
    const allScores = await db('lawn_health_scores')
      .where({ customer_id: customerId })
      .orderBy('assessment_date', 'asc');

    if (!allScores.length) {
      return res.json({ hasLawnCare: true, scores: null, initialScores: null });
    }

    const initial = allScores[0];
    const latest = allScores[allScores.length - 1];

    const formatScore = (row) => ({
      assessmentDate: row.assessment_date,
      turfDensity: row.turf_density,
      weedSuppression: row.weed_suppression,
      fungusControl: row.fungus_control,
      thatchScore: row.thatch_score,
      thatchInches: row.thatch_inches,
      overallScore: row.overall_score,
      notes: row.notes,
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

    const history = await db('lawn_health_scores')
      .where({ customer_id: customerId })
      .orderBy('assessment_date', 'asc')
      .select(
        'assessment_date',
        'turf_density',
        'weed_suppression',
        'fungus_control',
        'thatch_score',
        'thatch_inches',
        'overall_score',
        'notes'
      );

    res.json({
      history: history.map(row => ({
        assessmentDate: row.assessment_date,
        turfDensity: row.turf_density,
        weedSuppression: row.weed_suppression,
        fungusControl: row.fungus_control,
        thatchScore: row.thatch_score,
        thatchInches: row.thatch_inches,
        overallScore: row.overall_score,
        notes: row.notes,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
