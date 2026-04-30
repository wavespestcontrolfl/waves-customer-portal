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
const KnowledgeBridge = require('../services/knowledge-bridge');
const LawnIntel = require('../services/lawn-intelligence');
const { withConcurrency, majorityVote } = require('../services/lawn-photo-merge');

let PhotoService;
try { PhotoService = require('../services/photos'); } catch { PhotoService = null; }
const config = require('../config');
const { etDateString } = require('../utils/datetime-et');

router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

// =========================================================================
// GET /customers — list lawn care customers (active lawn service)
// =========================================================================
router.get('/customers', async (req, res, next) => {
  try {
    const { q } = req.query;
    const today = etDateString();

    // Try today's scheduled services first, fall back to all customers if none found
    let query;
    const hasScheduled = await db('scheduled_services')
      .where('scheduled_date', today)
      .whereNotIn('status', ['cancelled', 'completed'])
      .first();

    if (hasScheduled) {
      // Show today's scheduled services (any type, not just lawn).
      // ss.id is exposed as serviceId so the panel can pass it back
      // through /assess and anchor the assessment to the exact visit.
      query = db('scheduled_services as ss')
        .join('customers as c', 'ss.customer_id', 'c.id')
        .where('ss.scheduled_date', today)
        .whereNotIn('ss.status', ['cancelled', 'completed'])
        .select(
          'c.id', 'c.first_name as firstName', 'c.last_name as lastName',
          'c.email', 'c.phone', 'c.address_line1 as address',
          'ss.id as serviceId',
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
// Body: { customerId, serviceId?, photos: [{ data: base64, mimeType }] }
//
// serviceId is optional for backwards compat: the fallback customer
// picker (when no scheduled services exist today) has no service to
// pass. When provided, it must belong to customerId — otherwise we
// reject so a tech can't accidentally attach one customer's assessment
// to another customer's appointment.
// =========================================================================
router.post('/assess', async (req, res, next) => {
  try {
    const { customerId, serviceId, photos } = req.body;

    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    if (!photos || !photos.length) return res.status(400).json({ error: 'At least one photo is required' });

    // Verify customer exists
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // If serviceId is provided, validate it exists AND belongs to the
    // supplied customerId. 404 for missing, 400 for ownership mismatch
    // — different errors so the panel can surface the correct message.
    if (serviceId) {
      const svc = await db('scheduled_services').where({ id: serviceId }).first();
      if (!svc) return res.status(404).json({ error: 'serviceId not found' });
      if (svc.customer_id !== customerId) {
        return res.status(400).json({ error: 'serviceId does not belong to customerId' });
      }
    }

    // Photo quality gating — runs in parallel with a small cap so a
    // 3-photo upload doesn't pay 3× the latency of a 1-photo upload.
    const qualityResults = await withConcurrency(photos, 3, (photo) =>
      LawnIntel.assessPhotoQuality(photo.data, photo.mimeType || 'image/jpeg'),
    );

    // Track quality outcomes by ORIGINAL photo index. The downstream
    // photo-storage loop iterates `photos`, but AI runs only over
    // photos that passed quality — so we need an index map to align
    // AI results back to the original photo position.
    const passedIndices = qualityResults
      .map((q, i) => (q.passed ? i : -1))
      .filter((i) => i >= 0);
    const passedPhotos = passedIndices.map((i) => photos[i]);
    const failedPhotos = photos.filter((_, i) => !qualityResults[i].passed);

    if (passedPhotos.length === 0 && failedPhotos.length > 0) {
      return res.json({
        success: false,
        message: 'All photos failed quality check. Please retake with better lighting, closer to the lawn, avoiding shadows.',
        qualityResults: qualityResults.map((q, i) => ({ photoIndex: i, ...q })),
        photoCount: photos.length,
      });
    }

    // Use only photos that passed quality. Fallback path (quality
    // gate unavailable / no passes but no fails either) analyses
    // all photos — preserves the original behavior.
    const photosToAnalyze = passedPhotos.length > 0 ? passedPhotos : photos;
    const analyzedIndices = passedPhotos.length > 0
      ? passedIndices
      : photos.map((_, i) => i);

    // Multi-photo AI runs in parallel with the same small cap. Each
    // analyzePhoto call is itself two vision-API calls (Claude +
    // Gemini) under the hood — capping at 3 keeps the upper bound
    // at 6 concurrent vision calls per /assess request, which is
    // well inside both providers' burst limits.
    const photoResults = await withConcurrency(photosToAnalyze, 3, (photo) =>
      lawnAssessment.analyzePhoto(photo.data, photo.mimeType || 'image/jpeg'),
    );

    // Map AI result back to original photo index. validResults preserves
    // the in-order list for averaging/divergence aggregation; resultByPhotoIndex
    // is the lookup the photo-storage loop uses to attach scores to the
    // correct photo row.
    const resultByPhotoIndex = {};
    for (let k = 0; k < photoResults.length; k++) {
      const result = photoResults[k];
      if (!result) continue;
      resultByPhotoIndex[analyzedIndices[k]] = result;
    }
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

      // Majority vote across photos for categorical fields. Replaces
      // first-valid-wins, which was risky: fungicide/dethatching gates
      // would unlock based on photo 0 alone even if photos 1+2 disagreed.
      // Tie resolves to first-seen — for 1-photo this is identical to
      // the prior behavior.
      mergedComposite.fungal_activity = majorityVote(
        validResults.map(r => r.composite.fungal_activity),
        validResults[0].composite.fungal_activity,
      );
      mergedComposite.thatch_visibility = majorityVote(
        validResults.map(r => r.composite.thatch_visibility),
        validResults[0].composite.thatch_visibility,
      );
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

    // Compute overall weighted score (turf density 30%, weed 25%, color 20%, fungus 15%, thatch 10%)
    const overallScore = Math.round(
      (adjustedScores.turf_density || 0) * 0.30 +
      (adjustedScores.weed_suppression || 0) * 0.25 +
      (adjustedScores.color_health || 0) * 0.20 +
      (adjustedScores.fungus_control || 0) * 0.15 +
      (adjustedScores.thatch_level || 0) * 0.10
    );

    // Build photo metadata (always stored even without S3 for backward compat)
    const photoMeta = photos.map((p, i) => ({
      filename: `lawn_${customerId}_${Date.now()}_${i}.${(p.mimeType || 'image/jpeg').split('/')[1]}`,
      uploadedAt: new Date().toISOString(),
    }));

    // Save the assessment
    const [assessment] = await db('lawn_assessments').insert({
      customer_id: customerId,
      service_id: serviceId || null,
      technician_id: req.technicianId,
      service_date: etDateString(now),
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
      overall_score: overallScore,
      is_baseline: isBaseline,
    }).returning('*');

    // ── Upload photos to S3 + create lawn_assessment_photos records ──
    const photoRecords = [];
    let bestPhotoId = null;
    let bestQuality = -1;

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      // Use the index-aligned map, not validResults[i]: when a failed-
      // quality photo sits between two passed photos, validResults[i]
      // would attach photo[2]'s AI scores to photo[1]'s row.
      const result = resultByPhotoIndex[i] || null;
      const qualityCheck = qualityResults[i] || { passed: true, issues: [] };
      const mimeType = photo.mimeType || 'image/jpeg';
      const ext = mimeType.split('/')[1] || 'jpg';

      // Compute quality score for "best photo" selection
      // Higher turf density + color health + lower weed coverage = better representative photo
      let qualityScore = 50;
      if (result?.composite) {
        const c = result.composite;
        qualityScore = Math.round(
          ((c.turf_density || 50) * 0.4) +
          ((100 - (c.weed_coverage || 50)) * 0.3) +
          (((c.color_health || 5) / 10) * 100 * 0.3)
        );
      }

      let s3Key = null;

      // Upload to S3 if configured
      if (PhotoService && config.s3?.bucket) {
        try {
          const uploadResult = await PhotoService.getUploadUrl(assessment.id, `lawn_${i}`, ext);
          s3Key = uploadResult.key;

          // Direct upload from server (base64 → S3)
          const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
          const s3 = new S3Client({
            region: config.s3.region,
            credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
          });
          await s3.send(new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: s3Key,
            Body: Buffer.from(photo.data, 'base64'),
            ContentType: mimeType,
            Metadata: {
              assessmentId: assessment.id,
              customerId,
              photoIndex: String(i),
            },
          }));
        } catch (s3Err) {
          logger.error(`[lawn-assessment] S3 upload failed for photo ${i}: ${s3Err.message}`);
          s3Key = null; // Fall back gracefully
        }
      }

      // Create photo record (even without S3 — s3_key can be populated later).
      // Failed-quality photos are still stored for audit, but with
      // quality_gate_passed=false + the issue list. They are excluded
      // from is_best_photo selection below so they can't become the
      // canonical before/after image or feed treatment-decision logic.
      try {
        const [photoRecord] = await db('lawn_assessment_photos').insert({
          assessment_id: assessment.id,
          customer_id: customerId,
          s3_key: s3Key || `pending/${assessment.id}/${photoMeta[i].filename}`,
          filename: photoMeta[i].filename,
          mime_type: mimeType,
          file_size_bytes: Math.round((photo.data.length * 3) / 4), // approx base64 → bytes
          photo_type: photos.length === 1 ? 'general' : (i === 0 ? 'front_yard' : i === 1 ? 'side_yard' : 'trouble_spot'),
          photo_order: i,
          turf_density: result?.composite?.turf_density ?? null,
          weed_coverage: result?.composite?.weed_coverage ?? null,
          color_health: result?.composite?.color_health ?? null,
          fungal_activity: result?.composite?.fungal_activity ?? null,
          thatch_visibility: result?.composite?.thatch_visibility ?? null,
          observations: result?.composite?.observations ?? null,
          quality_score: qualityScore,
          quality_gate_passed: qualityCheck.passed !== false,
          quality_issues: JSON.stringify(qualityCheck.issues || []),
          customer_visible: true,
          is_best_photo: false,
          taken_at: new Date(),
        }).returning('*');

        photoRecords.push(photoRecord);

        // Best-photo selection considers quality-gated photos only.
        // A failed photo can never become is_best_photo regardless of
        // its computed quality_score.
        if (qualityCheck.passed !== false && qualityScore > bestQuality) {
          bestQuality = qualityScore;
          bestPhotoId = photoRecord.id;
        }
      } catch (photoErr) {
        logger.error(`[lawn-assessment] Photo record insert failed: ${photoErr.message}`);
      }
    }

    // Mark best photo and update assessment
    if (bestPhotoId) {
      await db('lawn_assessment_photos').where({ id: bestPhotoId }).update({ is_best_photo: true });
      await db('lawn_assessments').where({ id: assessment.id }).update({ best_photo_id: bestPhotoId });
    }

    res.json({
      success: true,
      assessment: { ...assessment, overall_score: overallScore, best_photo_id: bestPhotoId },
      rawComposite: mergedComposite,
      displayScores,
      adjustedScores,
      overallScore,
      season,
      isBaseline,
      divergenceFlags: allDivergences,
      photoCount: photos.length,
      analyzedCount: validResults.length,
      photosStored: photoRecords.length,
      bestPhotoId,
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

    // Agronomic Wiki: link treatment outcome after assessment confirmed
    try {
      const wiki = require('../services/agronomic-wiki');
      const outcome = await wiki.linkTreatmentOutcome(updated.service_record_id || updated.id);

      // Attach best photo keys to treatment outcome for before/after display
      if (outcome) {
        try {
          const bestPhoto = await db('lawn_assessment_photos')
            .where({ assessment_id: assessmentId, is_best_photo: true })
            .first();

          if (bestPhoto) {
            await db('treatment_outcomes')
              .where({ id: outcome.id })
              .update({ post_best_photo_key: bestPhoto.s3_key });
          }

          // Find pre-assessment best photo too
          if (outcome.pre_assessment_id) {
            const preBestPhoto = await db('lawn_assessment_photos')
              .where({ assessment_id: outcome.pre_assessment_id, is_best_photo: true })
              .first();
            if (preBestPhoto) {
              await db('treatment_outcomes')
                .where({ id: outcome.id })
                .update({ pre_best_photo_key: preBestPhoto.s3_key });
            }
          }
        } catch (photoRefErr) {
          logger.error(`[lawn-assessment] Photo ref update on treatment_outcome failed: ${photoRefErr.message}`);
        }
      }
    } catch (wikiErr) {
      logger.error(`[lawn-assessment] Wiki linkTreatmentOutcome failed (non-blocking): ${wikiErr.message}`);
    }

    // Knowledge Bridge + Lawn Intelligence: fire all async intelligence (non-blocking)
    setImmediate(async () => {
      try {
        // 1. FAWN weather context
        await LawnIntel.attachWeather(assessmentId);

        // 2. AI recommendations from Knowledge Bridge (Claudeopedia + Wiki)
        await KnowledgeBridge.generateAssessmentRecommendations(assessmentId);

        // 3. Tech calibration — record AI vs tech score differences
        if (adjustedScores) {
          const aiScores = assessment.composite_scores
            ? (typeof assessment.composite_scores === 'string' ? JSON.parse(assessment.composite_scores) : assessment.composite_scores)
            : {};
          await LawnIntel.recordTechCalibration(assessmentId, aiScores, adjustedScores);
        }

        // 4. Lawn health → customer health signal
        await LawnIntel.emitHealthSignal(updated.customer_id);

        // 5. Send assessment notification (SMS/email with score + photo)
        await LawnIntel.sendAssessmentNotification(assessmentId);

        // 6. Auto-generate service report
        await LawnIntel.generateServiceReport(assessmentId);

        // 7. Track assessment completion
        await LawnIntel.trackAssessmentCompletion(updated.service_date);

      } catch (intelErr) {
        logger.error(`[lawn-assessment] Intelligence pipeline failed (non-blocking): ${intelErr.message}`);
      }
    });

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

    // Flag that next visit needs fresh baseline photos
    try {
      await LawnIntel.flagBaselineRecapture(req.params.customerId, result.newBaselineId);
    } catch (flagErr) {
      logger.error(`[lawn-assessment] flagBaselineRecapture failed (non-blocking): ${flagErr.message}`);
    }

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
