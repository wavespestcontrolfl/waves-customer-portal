const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

router.use(authenticate);

// =========================================================================
// GET /api/lawn-health/:customerId — Latest + initial scores, photos, recs
// =========================================================================
router.get('/:customerId', async (req, res, next) => {
  try {
    const { customerId } = req.params;

    if (customerId !== req.customerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const assessments = await db('lawn_assessments')
      .where({ customer_id: customerId })
      .orderBy('service_date', 'asc');

    if (!assessments.length) {
      return res.json({ hasLawnCare: false, scores: null, initialScores: null, photos: null, recommendations: null });
    }

    const initial = assessments[0];
    const latest = assessments[assessments.length - 1];

    const formatScore = (row) => ({
      assessmentDate: row.service_date,
      turfDensity: row.turf_density,
      weedSuppression: row.weed_suppression,
      fungusControl: row.fungus_control,
      colorHealth: row.color_health || 0,
      thatchScore: row.thatch_level,
      thatchInches: null,
      overallScore: Math.round(
        (row.turf_density + row.weed_suppression + row.fungus_control +
          (row.color_health || 0) + (row.thatch_level || 0)) / 5
      ),
      notes: row.observations,
      season: row.season,
    });

    // Get photos for latest assessment (signed S3 URLs)
    let photos = null;
    try {
      const hasPhotosTable = await db.schema.hasTable('lawn_assessment_photos');
      if (hasPhotosTable) {
        const photoRows = await db('lawn_assessment_photos')
          .where({ assessment_id: latest.id })
          .orderBy('quality_score', 'desc');

        if (photoRows.length > 0) {
          const PhotoService = require('../services/photos');
          photos = await Promise.all(photoRows.map(async (p) => {
            let url = null;
            if (p.s3_key) {
              try { url = await PhotoService.getViewUrl(p.s3_key); } catch { /* S3 may not be configured */ }
            }
            return {
              url,
              isBest: p.is_best,
              turfDensity: p.turf_density,
              weedCoverage: p.weed_coverage,
              colorHealth: p.color_health,
              qualityScore: p.quality_score,
            };
          }));
        }
      }
    } catch { /* photos table or S3 may not exist */ }

    // Get before/after photos from treatment_outcomes
    let beforeAfterPhotos = null;
    try {
      const outcome = await db('treatment_outcomes')
        .where({ customer_id: customerId })
        .whereNotNull('before_photo_key')
        .whereNotNull('after_photo_key')
        .orderBy('treatment_date', 'desc')
        .first();

      if (outcome) {
        const PhotoService = require('../services/photos');
        let beforeUrl = null, afterUrl = null;
        try { beforeUrl = await PhotoService.getViewUrl(outcome.before_photo_key); } catch {}
        try { afterUrl = await PhotoService.getViewUrl(outcome.after_photo_key); } catch {}
        if (beforeUrl && afterUrl) {
          beforeAfterPhotos = {
            beforeUrl, afterUrl,
            beforeDate: outcome.pre_assessment_date,
            afterDate: outcome.post_assessment_date,
          };
        }
      }
    } catch { /* treatment_outcomes columns may not exist yet */ }

    // Generate recommendations
    let recommendations = null;
    try {
      const KnowledgeBridge = require('../services/knowledge-bridge');
      recommendations = await KnowledgeBridge.generateAssessmentRecommendations(customerId);
    } catch { /* non-critical */ }

    res.json({
      hasLawnCare: true,
      scores: formatScore(latest),
      initialScores: formatScore(initial),
      photos,
      beforeAfterPhotos,
      recommendations,
      totalAssessments: assessments.length,
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
        colorHealth: row.color_health || 0,
        thatchScore: row.thatch_level,
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
