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
const { getLatestTurfHeight, getTurfHeightTrend } = require('../services/turf-height-service');
const { buildMowingHeightContext } = require('../services/service-report/turf-height');
const logger = require('../services/logger');

const CARD_PRIORITY_RANK = { high: 1, medium: 2, low: 3 };

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
    return await PhotoService.getViewUrl(s3Key, 600);
  } catch {
    return null;
  }
}

// Consolidated Stress/Damage for customer surfaces. New rows store it directly;
// older rows fall back to the worst of the two legacy signals (fungus + thatch).
function lawnStressDamage(row = {}) {
  if (row.stress_damage != null) return row.stress_damage;
  return Math.min(row.fungus_control ?? 100, row.thatch_level ?? 100);
}

// Overall uses the stored score when present, else the four-category weighting
// (Density 0.30 / Weed 0.25 / Color 0.25 / Stress 0.20) so legacy rows without
// a stored overall_score match the four displayed bars and the service report.
function lawnOverall(row = {}) {
  // Trust a stored overall only when it was computed under the four-category
  // model (rows with stress_damage). Legacy rows keep an old five-signal
  // overall, so recompute them to match the four displayed bars.
  if (row.overall_score != null && row.stress_damage != null) return row.overall_score;
  return Math.round(
    (row.turf_density || 0) * 0.30 +
    (row.weed_suppression || 0) * 0.25 +
    (row.color_health || 0) * 0.25 +
    lawnStressDamage(row) * 0.20
  );
}

function formatScore(row) {
  return {
    assessmentId: row.id,
    assessmentDate: row.service_date,
    turfDensity: row.turf_density,
    weedSuppression: row.weed_suppression,
    colorHealth: row.color_health,
    stressDamage: lawnStressDamage(row),
    fungusControl: row.fungus_control,
    thatchScore: row.thatch_level,
    overallScore: lawnOverall(row),
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

function normalizeNeighborBenchmark(value) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== 'object') return null;

  const customerScore = row.customerScore ?? row.yourScore;
  const neighborhoodAvg = row.neighborhoodAvg ?? row.avgScore;
  if (customerScore == null || neighborhoodAvg == null) return null;

  return {
    customerScore,
    neighborhoodAvg,
    percentile: row.percentile ?? null,
    customerCount: row.customerCount ?? row.sampleSize ?? null,
    avgImprovement: row.avgImprovement ?? null,
    segmentName: row.segmentName ?? row.segment ?? null,
    segmentType: row.segmentType ?? null,
  };
}

function applyLawnServiceFilter(query, alias = 'ss') {
  return query.where(function () {
    this.whereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%lawn%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%waveguard%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%fertiliz%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%fungicide%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%turf%']);
  });
}

async function hasCustomerLawnCare(customerId) {
  const profile = await db('customer_turf_profiles')
    .where({ customer_id: customerId, active: true })
    .first('id')
    .catch(() => null);
  if (profile) return true;

  const customer = await db('customers')
    .where({ id: customerId })
    .first('id', 'waveguard_tier', 'lawn_type')
    .catch(() => null);
  if (customer?.waveguard_tier || customer?.lawn_type) return true;

  const scheduled = await applyLawnServiceFilter(
    db('scheduled_services as ss').where('ss.customer_id', customerId),
    'ss'
  ).first('ss.id').catch(() => null);
  return Boolean(scheduled);
}

function photoAssessmentLookupCriteria(customerId, assessmentId) {
  return {
    id: assessmentId,
    customer_id: customerId,
    confirmed_by_tech: true,
  };
}

function parseJsonObject(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parseJsonArray(value, fallback = []) {
  if (value == null) return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
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

    // Mowing height-of-cut (independent of a vision assessment) — latest reading
    // + trend for the card. Fail-soft helpers → null when none / feature off.
    const mowingHeight = buildMowingHeightContext(
      await getLatestTurfHeight(customerId),
      await getTurfHeightTrend(customerId, 12),
    );

    // Get all confirmed assessments
    const assessments = await db('lawn_assessments')
      .where({ customer_id: customerId, confirmed_by_tech: true })
      .orderBy('service_date', 'asc');

    if (!assessments.length) {
      const pending = await db('lawn_assessments')
        .where({ customer_id: customerId })
        .orderBy('service_date', 'asc');

      return res.json({
        hasLawnCare: pending.length > 0 || await hasCustomerLawnCare(customerId),
        hasPendingAssessment: pending.length > 0 && !pending[0].confirmed_by_tech,
        scores: null,
        initialScores: null,
        photos: [],
        beforeAfter: null,
        trend: [],
        mowingHeight,
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

      const calcOverall = (a) => lawnOverall(a);

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
          stressDamage: lawnStressDamage(latest) - lawnStressDamage(initial),
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
      stressDamage: lawnStressDamage(a),
      fungusControl: a.fungus_control,
      thatchLevel: a.thatch_level,
      overallScore: lawnOverall(a),
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
      neighborBenchmark: normalizeNeighborBenchmark(neighborBenchmark),
      mowingHeight,
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
      .where(photoAssessmentLookupCriteria(customerId, assessmentId))
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

router._test = {
  normalizeNeighborBenchmark,
  photoAssessmentLookupCriteria,
};

module.exports = router;
