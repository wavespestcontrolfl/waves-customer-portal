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
const LawnSnapshot = require('../services/lawn-snapshot');
const RecommendationEngine = require('../services/lawn-recommendation-engine');
const { withConcurrency, majorityVote } = require('../services/lawn-photo-merge');

let PhotoService;
try { PhotoService = require('../services/photos'); } catch { PhotoService = null; }
const config = require('../config');
const { etDateString } = require('../utils/datetime-et');

function applyLawnServiceFilter(query, alias = 'ss') {
  return query.where(function () {
    this.whereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%lawn%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%waveguard%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%fertiliz%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%fungicide%'])
      .orWhereRaw(`LOWER(${alias}.service_type) LIKE ?`, ['%turf%']);
  });
}

function calculateOverallScore(scores = {}) {
  return Math.round(
    (Number(scores.turf_density) || 0) * 0.30 +
    (Number(scores.weed_suppression) || 0) * 0.25 +
    (Number(scores.color_health) || 0) * 0.20 +
    (Number(scores.fungus_control) || 0) * 0.15 +
    (Number(scores.thatch_level) || 0) * 0.10
  );
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

function normalizeAssessmentRow(row) {
  if (!row) return null;
  return {
    ...row,
    photos: parseJsonArray(row.photos),
    composite_scores: parseJsonObject(row.composite_scores),
    adjusted_scores: parseJsonObject(row.adjusted_scores),
    divergence_flags: parseJsonArray(row.divergence_flags),
    stress_flags: parseJsonObject(row.stress_flags, null),
  };
}

function scoreValue(value, fallback = 0) {
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
  const f = Number(fallback);
  return Number.isFinite(f) ? Math.max(0, Math.min(100, Math.round(f))) : 0;
}

function customerVisibleForQualityCheck(qualityCheck = {}) {
  if (!qualityCheck || typeof qualityCheck !== 'object') return true;
  return qualityCheck.passed !== false;
}

let hasServiceRecordColumnPromise = null;
function hasAssessmentServiceRecordColumn() {
  if (!hasServiceRecordColumnPromise) {
    hasServiceRecordColumnPromise = db.schema
      .hasColumn('lawn_assessments', 'service_record_id')
      .catch(() => false);
  }
  return hasServiceRecordColumnPromise;
}

async function resolveAssessmentServiceRecordId(assessment) {
  if (!assessment) return null;
  if (assessment.service_record_id) return assessment.service_record_id;
  if (!assessment.service_id) return null;

  const serviceRecord = await db('service_records')
    .where({ scheduled_service_id: assessment.service_id })
    .orderBy('created_at', 'desc')
    .first();
  if (!serviceRecord?.id) return null;

  if (await hasAssessmentServiceRecordColumn()) {
    await db('lawn_assessments')
      .where({ id: assessment.id })
      .update({ service_record_id: serviceRecord.id, updated_at: new Date() })
      .catch((err) => logger.error(`[lawn-assessment] service_record_id back-link failed: ${err.message}`));
  }
  return serviceRecord.id;
}

async function attachOutcomePhotoRefs(outcome, assessmentId) {
  if (!outcome) return;
  try {
    const bestPhoto = await db('lawn_assessment_photos')
      .where({ assessment_id: assessmentId, is_best_photo: true })
      .first();
    if (bestPhoto) {
      await db('treatment_outcomes')
        .where({ id: outcome.id })
        .update({ post_best_photo_key: bestPhoto.s3_key });
    }
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

router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

// =========================================================================
// GET /customers — list lawn care customers (active lawn service)
// =========================================================================
router.get('/customers', async (req, res, next) => {
  try {
    const { q } = req.query;
    const today = etDateString();

    let query;
    const hasScheduled = await applyLawnServiceFilter(
      db('scheduled_services as ss')
        .where('ss.scheduled_date', today)
        .whereNotIn('ss.status', ['cancelled', 'completed']),
      'ss'
    ).first();

    if (hasScheduled) {
      query = applyLawnServiceFilter(
        db('scheduled_services as ss')
          .join('customers as c', 'ss.customer_id', 'c.id')
          .where('ss.scheduled_date', today)
          .whereNotIn('ss.status', ['cancelled', 'completed'])
          .select(
            'c.id', 'c.first_name as firstName', 'c.last_name as lastName',
            'c.email', 'c.phone', 'c.address_line1 as address',
            'ss.id as serviceId',
            'ss.service_type as serviceType', 'ss.window_start as windowStart'
          ),
        'ss'
      ).orderBy('ss.window_start', 'asc');
    } else {
      query = db('customers as c')
        .leftJoin('customer_turf_profiles as ctp', function () {
          this.on('ctp.customer_id', '=', 'c.id').andOn(db.raw('ctp.active = true'));
        })
        .select(
          'c.id', 'c.first_name as firstName', 'c.last_name as lastName',
          'c.email', 'c.phone', 'c.address_line1 as address'
        )
        .where(function () {
          this.whereNotNull('ctp.id')
            .orWhereNotNull('c.waveguard_tier')
            .orWhereNotNull('c.lawn_type');
        })
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

    const overallScore = calculateOverallScore(adjustedScores);

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
          customer_visible: customerVisibleForQualityCheck(qualityCheck),
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
// Body: { assessmentId, adjustedScores: { turf_density, ... }, stress_flags: { drought_stress, ... } }
//
// stress_flags is per-visit transient state the future plan engine
// reads to gate hot herbicides / PGR / etc. — distinct from the
// stable known_*_history flags on customer_turf_profiles. All keys
// are booleans; any non-boolean value is rejected with 400.
// =========================================================================
const STRESS_FLAG_KEYS = [
  'drought_stress',
  'shade_stress',
  'disease_suspicion',
  'recent_scalp',
  'new_sod',
];

function normalizeStressFlags(input) {
  // Accepts: object whose keys are a subset of STRESS_FLAG_KEYS and
  // whose values are booleans. Returns { errors, normalized } where
  // normalized is a stripped object with only the allowed keys.
  if (input == null) return { errors: [], normalized: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['stress_flags must be an object'], normalized: null };
  }
  const errors = [];
  const normalized = {};
  for (const [k, v] of Object.entries(input)) {
    if (!STRESS_FLAG_KEYS.includes(k)) {
      errors.push(`stress_flags.${k} is not a recognized flag (allowed: ${STRESS_FLAG_KEYS.join(', ')})`);
      continue;
    }
    if (typeof v !== 'boolean') {
      errors.push(`stress_flags.${k} must be a boolean`);
      continue;
    }
    normalized[k] = v;
  }
  return { errors, normalized };
}

router.post('/confirm', async (req, res, next) => {
  try {
    const { assessmentId, adjustedScores, stress_flags: stressFlagsInput } = req.body;

    if (!assessmentId) return res.status(400).json({ error: 'assessmentId is required' });

    // Validate stress_flags up front so a bad payload doesn't reach
    // the DB write path.
    const { errors: stressErrors, normalized: normalizedStressFlags } = normalizeStressFlags(stressFlagsInput);
    if (stressErrors.length) {
      return res.status(400).json({ error: 'Invalid stress_flags', details: stressErrors });
    }

    const assessment = await db('lawn_assessments').where({ id: assessmentId }).first();
    if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

    const finalScores = {
      turf_density: scoreValue(adjustedScores?.turf_density, assessment.turf_density),
      weed_suppression: scoreValue(adjustedScores?.weed_suppression, assessment.weed_suppression),
      color_health: scoreValue(adjustedScores?.color_health, assessment.color_health),
      fungus_control: scoreValue(adjustedScores?.fungus_control, assessment.fungus_control),
      thatch_level: scoreValue(adjustedScores?.thatch_level, assessment.thatch_level),
    };

    const updateData = {
      confirmed_by_tech: true,
      confirmed_at: new Date(),
      updated_at: new Date(),
      ...finalScores,
      overall_score: calculateOverallScore(finalScores),
    };

    // If tech provided adjusted scores, apply them
    if (adjustedScores) {
      if (adjustedScores.observations != null) updateData.observations = adjustedScores.observations;
      updateData.adjusted_scores = JSON.stringify({
        ...parseJsonObject(assessment.adjusted_scores),
        ...finalScores,
        ...(adjustedScores.observations != null ? { observations: adjustedScores.observations } : {}),
      });
    }

    // Persist stress_flags only if any allowed key was sent. An empty
    // object {} is treated as "tech confirmed no flags set" and
    // stored — distinguishable from null (no signal).
    if (normalizedStressFlags !== null) {
      updateData.stress_flags = JSON.stringify(normalizedStressFlags);
    }

    const [updated] = await db('lawn_assessments')
      .where({ id: assessmentId })
      .update(updateData)
      .returning('*');

    // Agronomic Wiki: link only when a durable service_record exists.
    // Assessments captured inside Complete Service are back-linked after
    // completion creates that record.
    let resolvedServiceRecordId = updated.service_record_id || null;
    try {
      const wiki = require('../services/agronomic-wiki');
      const serviceRecordId = await resolveAssessmentServiceRecordId(updated);
      if (serviceRecordId) {
        resolvedServiceRecordId = serviceRecordId;
        updated.service_record_id = serviceRecordId;
        const outcome = await wiki.linkTreatmentOutcome(serviceRecordId);
        await attachOutcomePhotoRefs(outcome, assessmentId);
      }
    } catch (wikiErr) {
      logger.error(`[lawn-assessment] Wiki linkTreatmentOutcome failed (non-blocking): ${wikiErr.message}`);
    }

    // Property Health Snapshot + Smart Recommendation Cards. This is
    // intentionally isolated from confirmation success: confirmation is the
    // source-of-truth event, while snapshot generation can be retried by admin.
    let propertySnapshot = null;
    let recommendationCards = [];
    try {
      propertySnapshot = await LawnSnapshot.buildLawnSnapshot({
        assessmentId,
        serviceId: updated.service_id || null,
        serviceRecordId: resolvedServiceRecordId,
        generatedBy: req.technician?.role === 'admin' ? 'admin' : 'tech',
      });
      recommendationCards = await RecommendationEngine.generateRecommendationCards({
        snapshotId: propertySnapshot.id,
        assessmentId,
        customerId: updated.customer_id,
      });
    } catch (snapshotErr) {
      logger.error(`[lawn-assessment] Snapshot/recommendation generation failed (non-blocking): ${snapshotErr.message}`);
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
          const calibrationBaseline = assessment.adjusted_scores || assessment.composite_scores;
          const aiScores = calibrationBaseline
            ? (typeof calibrationBaseline === 'string' ? JSON.parse(calibrationBaseline) : calibrationBaseline)
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

    res.json({
      success: true,
      assessment: updated,
      propertySnapshot: propertySnapshot ? {
        id: propertySnapshot.id,
        status: propertySnapshot.status,
        customer_visible: propertySnapshot.customer_visible,
      } : null,
      recommendationCards: recommendationCards.map((card) => ({
        id: card.id,
        type: card.type,
        status: card.status,
        customer_visible: card.customer_visible,
        requires_human_approval: card.requires_human_approval,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /service/:serviceId — latest assessment captured for a scheduled visit
// =========================================================================
router.get('/service/:serviceId', async (req, res, next) => {
  try {
    const assessment = await db('lawn_assessments')
      .where({ service_id: req.params.serviceId })
      .orderByRaw('confirmed_at DESC NULLS LAST')
      .orderBy('created_at', 'desc')
      .first();

    if (!assessment) return res.json({ assessment: null });

    const photos = await db('lawn_assessment_photos')
      .where({ assessment_id: assessment.id })
      .orderBy('photo_order', 'asc')
      .catch(() => []);

    res.json({
      assessment: {
        ...normalizeAssessmentRow(assessment),
        photo_records: photos,
      },
    });
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

router._test = {
  customerVisibleForQualityCheck,
  normalizeStressFlags,
};

module.exports = router;
