/**
 * Customer-Facing Lawn Health Routes
 *
 * Returns lawn assessment scores, photos with signed S3 URLs,
 * before/after comparisons, trend history, and AI recommendations
 * from the Knowledge Bridge (Claudeopedia + Agronomic Wiki).
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

let PhotoService;
try { PhotoService = require('../services/photos'); } catch { PhotoService = null; }

let LawnIntel;
try { LawnIntel = require('../services/lawn-intelligence'); } catch { LawnIntel = null; }

router.use(authenticate);

// =========================================================================
// Helper: generate signed URL for a photo record
// =========================================================================
async function signedUrl(s3Key) {
  if (!s3Key || !PhotoService || s3Key.startsWith('pending/')) return null;
  try {
    return await PhotoService.getViewUrl(s3Key, 7200);
  } catch {
    return null;
  }
}

function formatScore(row) {
  return {
    assessmentId: row.id,
    assessmentDate: row.service_date,
    turfDensity: row.turf_density,
    weedSuppression: row.weed_suppression,
    colorHealth: row.color_health,
    fungusControl: row.fungus_control,
    thatchScore: row.thatch_level,
    overallScore: row.overall_score || Math.round(
      (row.turf_density + row.weed_suppression + row.fungus_control +
        (row.color_health || 0) + (row.thatch_level || 0)) / 5
    ),
    season: row.season,
    observations: row.observations,
    aiSummary: row.ai_summary || null,
    recommendations: row.recommendations ? safeJsonParse(row.recommendations) : null,
  };
}

function safeJsonParse(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return null; }
}

// =========================================================================
// GET /api/lawn-health/:customerId — Full lawn health dashboard data
// =========================================================================
router.get('/:customerId', async (req, res, next) => {
  try {
    const { customerId } = req.params;

    if (customerId !== req.customerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get all confirmed assessments
    const assessments = await db('lawn_assessments')
      .where({ customer_id: customerId, confirmed_by_tech: true })
      .orderBy('service_date', 'asc');

    if (!assessments.length) {
      const pending = await db('lawn_assessments')
        .where({ customer_id: customerId })
        .orderBy('service_date', 'asc');

      return res.json({
        hasLawnCare: pending.length > 0,
        hasPendingAssessment: pending.length > 0 && !pending[0].confirmed_by_tech,
        scores: null,
        initialScores: null,
        photos: [],
        beforeAfter: null,
        trend: [],
      });
    }

    const initial = assessments[0];
    const latest = assessments[assessments.length - 1];

    // Get photos for the latest assessment (customer-visible only)
    const latestPhotos = await db('lawn_assessment_photos')
      .where({ assessment_id: latest.id, customer_visible: true })
      .orderByRaw('is_best_photo DESC, quality_score DESC, photo_order ASC')
      .limit(5);

    // Sign photo URLs
    const photosWithUrls = await Promise.all(
      latestPhotos.map(async (p) => ({
        id: p.id,
        url: await signedUrl(p.s3_key),
        type: p.photo_type,
        zone: p.zone,
        isBest: p.is_best_photo,
        qualityScore: p.quality_score,
        scores: {
          turfDensity: p.turf_density,
          weedCoverage: p.weed_coverage,
          colorHealth: p.color_health,
        },
        takenAt: p.taken_at,
      }))
    );

    // Build before/after data
    let beforeAfter = null;
    if (assessments.length >= 2) {
      const initialPhotos = await db('lawn_assessment_photos')
        .where({ assessment_id: initial.id, customer_visible: true })
        .orderByRaw('is_best_photo DESC, quality_score DESC')
        .limit(1);

      const latestBest = latestPhotos.find(p => p.is_best_photo) || latestPhotos[0];
      const initialBest = initialPhotos[0] || null;

      const calcOverall = (a) => a.overall_score || Math.round(
        (a.turf_density + a.weed_suppression + a.fungus_control +
          (a.color_health || 0) + (a.thatch_level || 0)) / 5
      );

      beforeAfter = {
        before: {
          date: initial.service_date,
          photoUrl: initialBest ? await signedUrl(initialBest.s3_key) : null,
          overallScore: calcOverall(initial),
          notes: initial.observations,
        },
        after: {
          date: latest.service_date,
          photoUrl: latestBest ? await signedUrl(latestBest.s3_key) : null,
          overallScore: calcOverall(latest),
          notes: latest.observations,
        },
        improvement: {
          turfDensity: (latest.turf_density || 0) - (initial.turf_density || 0),
          weedSuppression: (latest.weed_suppression || 0) - (initial.weed_suppression || 0),
          colorHealth: (latest.color_health || 0) - (initial.color_health || 0),
          fungusControl: (latest.fungus_control || 0) - (initial.fungus_control || 0),
          thatchLevel: (latest.thatch_level || 0) - (initial.thatch_level || 0),
          overall: calcOverall(latest) - calcOverall(initial),
          daysSinceStart: Math.round(
            (new Date(latest.service_date) - new Date(initial.service_date)) / (1000 * 60 * 60 * 24)
          ),
        },
      };
    }

    // Build trend data for chart
    const trend = assessments.map(a => ({
      date: a.service_date,
      turfDensity: a.turf_density,
      weedSuppression: a.weed_suppression,
      colorHealth: a.color_health,
      fungusControl: a.fungus_control,
      thatchLevel: a.thatch_level,
      overallScore: a.overall_score || Math.round(
        (a.turf_density + a.weed_suppression + a.fungus_control +
          (a.color_health || 0) + (a.thatch_level || 0)) / 5
      ),
      season: a.season,
    }));

    const recommendations = safeJsonParse(latest.recommendations);

    // Seasonal context from FAWN weather
    let seasonalContext = null;
    try {
      const FawnWeather = require('../services/fawn-weather');
      const month = new Date().getMonth() + 1;
      const weather = {
        fawn_temp_f: latest.fawn_temp_f,
        fawn_humidity_pct: latest.fawn_humidity_pct,
        fawn_rainfall_7d: latest.fawn_rainfall_7d,
        fawn_soil_temp_f: latest.fawn_soil_temp_f,
      };
      // Use assessment weather if available, otherwise fetch current
      if (!weather.fawn_temp_f) {
        const current = await FawnWeather.getCurrent();
        Object.assign(weather, current);
      }
      seasonalContext = FawnWeather.getSeasonalContext(month, weather);
      seasonalContext.pressureSignals = FawnWeather.getPressureSignals(month);
    } catch { /* ignore */ }

    // Neighbor comparison benchmark
    let neighborBenchmark = null;
    try {
      if (LawnIntel?.getCustomerPercentile) {
        neighborBenchmark = await LawnIntel.getCustomerPercentile(customerId);
      } else {
        const analytics = require('../services/assessment-analytics');
        neighborBenchmark = await analytics.getCustomerBenchmark(customerId);
      }
    } catch { /* ignore */ }

    res.json({
      hasLawnCare: true,
      scores: formatScore(latest),
      initialScores: formatScore(initial),
      photos: photosWithUrls,
      beforeAfter,
      trend,
      recommendations,
      seasonalContext,
      neighborBenchmark,
      assessmentCount: assessments.length,
      nextMilestone: assessments.length < 3
        ? { message: `${3 - assessments.length} more visit${assessments.length < 2 ? 's' : ''} until full trend data`, type: 'visits' }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/lawn-health/:customerId/history — All assessments with photos
// =========================================================================
router.get('/:customerId/history', async (req, res, next) => {
  try {
    const { customerId } = req.params;

    if (customerId !== req.customerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const assessments = await db('lawn_assessments')
      .where({ customer_id: customerId, confirmed_by_tech: true })
      .orderBy('service_date', 'asc');

    // Get best photo for each assessment
    const assessmentIds = assessments.map(a => a.id);
    const bestPhotos = assessmentIds.length
      ? await db('lawn_assessment_photos')
          .whereIn('assessment_id', assessmentIds)
          .where({ is_best_photo: true, customer_visible: true })
      : [];

    const photoMap = {};
    for (const p of bestPhotos) {
      photoMap[p.assessment_id] = p;
    }

    const history = await Promise.all(
      assessments.map(async (a) => {
        const photo = photoMap[a.id];
        return {
          ...formatScore(a),
          photoUrl: photo ? await signedUrl(photo.s3_key) : null,
          isBaseline: a.is_baseline,
        };
      })
    );

    res.json({ history });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/lawn-health/:customerId/photos/:assessmentId — All photos for one visit
// =========================================================================
router.get('/:customerId/photos/:assessmentId', async (req, res, next) => {
  try {
    const { customerId, assessmentId } = req.params;

    if (customerId !== req.customerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const assessment = await db('lawn_assessments')
      .where({ id: assessmentId, customer_id: customerId })
      .first();

    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    const photos = await db('lawn_assessment_photos')
      .where({ assessment_id: assessmentId, customer_visible: true })
      .orderByRaw('is_best_photo DESC, photo_order ASC');

    const photosWithUrls = await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        url: await signedUrl(p.s3_key),
        type: p.photo_type,
        zone: p.zone,
        isBest: p.is_best_photo,
        scores: {
          turfDensity: p.turf_density,
          weedCoverage: p.weed_coverage,
          colorHealth: p.color_health,
          fungalActivity: p.fungal_activity,
          thatchVisibility: p.thatch_visibility,
        },
        observations: p.observations,
        takenAt: p.taken_at,
      }))
    );

    res.json({
      assessment: formatScore(assessment),
      photos: photosWithUrls,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
