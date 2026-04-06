/**
 * Admin Lawn Assessment Routes
 *
 * Endpoints for technicians/admins to run AI-powered lawn health
 * assessments, review scores, and manage baselines.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const lawnAssessment = require('../services/lawn-assessment');

router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

// =========================================================================
// GET /customers — list lawn care customers (active lawn service)
// =========================================================================
router.get('/customers', async (req, res, next) => {
  try {
    const { q } = req.query;
    const today = new Date().toISOString().split('T')[0];

    // Try today's scheduled services first, fall back to all customers if none found
    let query;
    const hasScheduled = await db('scheduled_services')
      .where('scheduled_date', today)
      .whereNotIn('status', ['cancelled', 'completed'])
      .first();

    if (hasScheduled) {
      // Show today's scheduled services (any type, not just lawn)
      query = db('scheduled_services as ss')
        .join('customers as c', 'ss.customer_id', 'c.id')
        .where('ss.scheduled_date', today)
        .whereNotIn('ss.status', ['cancelled', 'completed'])
        .select(
          'c.id', 'c.first_name as firstName', 'c.last_name as lastName',
          'c.email', 'c.phone', 'c.address_line1 as address',
          'ss.service_type as serviceType', 'ss.window_start as windowStart'
        )
        .orderBy('ss.window_start', 'asc');
    } else {
      // No services today — show all customers for manual assessment
      query = db('customers as c')
        .select(
          'c.id', 'c.first_name as firstName', 'c.last_name as lastName',
          'c.email', 'c.phone', 'c.address_line1 as address'
        )
        .orderBy('c.last_name', 'asc');
    }

    if (q && q.trim()) {
      const s = `%${q.trim().toLowerCase()}%`;
      query = query.where(function () {
        this.whereRaw("LOWER(c.first_name || ' ' || c.last_name) LIKE ?", [s])
          .orWhere('c.phone', 'like', s)
          .orWhere('c.address_line1', 'ilike', s);
      });
    }

    const customers = await query.limit(50);
    res.json({ customers });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /assess — upload photos + run AI analysis
// Body: { customerId, photos: [{ data: base64, mimeType }] }
// =========================================================================
router.post('/assess', async (req, res, next) => {
  try {
    const { customerId, photos } = req.body;

    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    if (!photos || !photos.length) return res.status(400).json({ error: 'At least one photo is required' });

    // Verify customer exists
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Run AI analysis on each photo
    const photoResults = [];
    for (const photo of photos) {
      const result = await lawnAssessment.analyzePhoto(photo.data, photo.mimeType || 'image/jpeg');
      photoResults.push(result);
    }

    // Filter out null results (both models failed for that photo)
    const validResults = photoResults.filter(Boolean);

    // If all photos failed analysis, return error but allow manual entry
    if (!validResults.length) {
      return res.json({
        success: false,
        message: 'AI analysis failed for all photos. Please enter scores manually.',
        aiAvailable: false,
        photoCount: photos.length,
      });
    }

    // Average composites across all photos
    let mergedComposite;
    if (validResults.length === 1) {
      mergedComposite = validResults[0].composite;
    } else {
      // Average all photo composites together
      const fields = ['turf_density', 'weed_coverage'];
      mergedComposite = {};
      for (const field of fields) {
        const vals = validResults.map(r => r.composite[field]).filter(v => v != null);
        mergedComposite[field] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
      }
      const colorVals = validResults.map(r => r.composite.color_health).filter(v => v != null);
      mergedComposite.color_health = colorVals.length
        ? Math.round(colorVals.reduce((a, b) => a + b, 0) / colorVals.length * 10) / 10
        : 5;

      // For categorical: take the most common or first
      mergedComposite.fungal_activity = validResults[0].composite.fungal_activity;
      mergedComposite.thatch_visibility = validResults[0].composite.thatch_visibility;
      mergedComposite.observations = validResults.map(r => r.composite.observations).filter(Boolean).join(' | ');
    }

    // Convert to display scores
    const displayScores = lawnAssessment.mapToDisplayScores(mergedComposite);

    // Determine season and apply adjustment
    const now = new Date();
    const month = now.getMonth() + 1;
    const season = lawnAssessment.getSeason(month);
    const adjustedScores = lawnAssessment.applySeasonalAdjustment(displayScores, month);

    // Check if this is the first assessment (baseline)
    const existingCount = await db('lawn_assessments')
      .where({ customer_id: customerId })
      .count('id as cnt')
      .first();
    const isBaseline = parseInt(existingCount.cnt) === 0;

    // Collect divergence flags from all photo analyses
    const allDivergences = validResults.flatMap(r => r.divergenceFlags || []);

    // Build photo metadata (store base64 references — in production you'd upload to S3)
    const photoMeta = photos.map((p, i) => ({
      filename: `lawn_${customerId}_${Date.now()}_${i}.${(p.mimeType || 'image/jpeg').split('/')[1]}`,
      uploadedAt: new Date().toISOString(),
    }));

    // Save the assessment
    const [assessment] = await db('lawn_assessments').insert({
      customer_id: customerId,
      technician_id: req.technicianId,
      service_date: now.toISOString().split('T')[0],
      season,
      photos: JSON.stringify(photoMeta),
      claude_raw: JSON.stringify(validResults.map(r => r.claude)),
      gemini_raw: JSON.stringify(validResults.map(r => r.gemini)),
      composite_scores: JSON.stringify(displayScores),
      adjusted_scores: JSON.stringify(adjustedScores),
      divergence_flags: JSON.stringify(allDivergences),
      turf_density: adjustedScores.turf_density,
      weed_suppression: adjustedScores.weed_suppression,
      color_health: adjustedScores.color_health,
      fungus_control: adjustedScores.fungus_control,
      thatch_level: adjustedScores.thatch_level,
      observations: adjustedScores.observations,
      is_baseline: isBaseline,
    }).returning('*');

    res.json({
      success: true,
      assessment,
      rawComposite: mergedComposite,
      displayScores,
      adjustedScores,
      season,
      isBaseline,
      divergenceFlags: allDivergences,
      photoCount: photos.length,
      analyzedCount: validResults.length,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /confirm — tech confirms scores (with optional adjustments)
// Body: { assessmentId, adjustedScores: { turf_density, weed_suppression, ... } }
// =========================================================================
router.post('/confirm', async (req, res, next) => {
  try {
    const { assessmentId, adjustedScores } = req.body;

    if (!assessmentId) return res.status(400).json({ error: 'assessmentId is required' });

    const assessment = await db('lawn_assessments').where({ id: assessmentId }).first();
    if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

    const updateData = {
      confirmed_by_tech: true,
      confirmed_at: new Date(),
      updated_at: new Date(),
    };

    // If tech provided adjusted scores, apply them
    if (adjustedScores) {
      if (adjustedScores.turf_density != null) updateData.turf_density = adjustedScores.turf_density;
      if (adjustedScores.weed_suppression != null) updateData.weed_suppression = adjustedScores.weed_suppression;
      if (adjustedScores.color_health != null) updateData.color_health = adjustedScores.color_health;
      if (adjustedScores.fungus_control != null) updateData.fungus_control = adjustedScores.fungus_control;
      if (adjustedScores.thatch_level != null) updateData.thatch_level = adjustedScores.thatch_level;
      if (adjustedScores.observations != null) updateData.observations = adjustedScores.observations;
      updateData.adjusted_scores = JSON.stringify(adjustedScores);
    }

    const [updated] = await db('lawn_assessments')
      .where({ id: assessmentId })
      .update(updateData)
      .returning('*');

    res.json({ success: true, assessment: updated });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /history/:customerId — assessment history with photos and scores
// =========================================================================
router.get('/history/:customerId', async (req, res, next) => {
  try {
    const history = await lawnAssessment.getCustomerHistory(req.params.customerId);
    res.json({ history });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /baseline/:customerId — get baseline assessment
// =========================================================================
router.get('/baseline/:customerId', async (req, res, next) => {
  try {
    const baseline = await lawnAssessment.getBaseline(req.params.customerId);
    res.json({ baseline: baseline || null });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /reset-baseline/:customerId — reset baseline (admin only)
// Body: { reason }
// =========================================================================
router.post('/reset-baseline/:customerId', async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason is required' });

    const adminName = req.technician?.name || req.technician?.email || 'Unknown';
    const result = await lawnAssessment.resetBaseline(req.params.customerId, adminName, reason);

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /latest/:customerId — latest assessment for customer portal widget
// =========================================================================
router.get('/latest/:customerId', async (req, res, next) => {
  try {
    const latest = await db('lawn_assessments')
      .where({ customer_id: req.params.customerId })
      .orderBy('service_date', 'desc')
      .first();

    res.json({ latest: latest || null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
