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
const { withConcurrency, mergePhotoComposites } = require('../services/lawn-photo-merge');
const { seasonAwareAdjustment } = require('../services/service-report/lawn-seasonality');
const { fetchRecentMinTempF } = require('../services/service-report/application-conditions');

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

// Four consolidated categories: Density 0.30 / Weed Cleanliness 0.25 /
// Color 0.25 / Stress+Damage 0.20. Stress/Damage folds in fungus + thatch, so
// they no longer carry their own weight. Pre-stress_damage rows fall back to
// min(fungus_control, thatch_level) — the same worst-stressor idea.
function calculateOverallScore(scores = {}) {
  const stress = Number(scores.stress_damage);
  const resolvedStress = Number.isFinite(stress)
    ? stress
    : Math.min(Number(scores.fungus_control) || 0, Number(scores.thatch_level) || 0);
  return Math.round(
    (Number(scores.turf_density) || 0) * 0.30 +
    (Number(scores.weed_suppression) || 0) * 0.25 +
    (Number(scores.color_health) || 0) * 0.25 +
    resolvedStress * 0.20
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
    protocol_field_checks: parseJsonObject(row.protocol_field_checks, null),
  };
}

function applyServiceAssessmentOrder(query) {
  return query
    .orderBy('created_at', 'desc')
    .orderBy('updated_at', 'desc');
}

function scoreValue(value, fallback = 0) {
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
  const f = Number(fallback);
  return Number.isFinite(f) ? Math.max(0, Math.min(100, Math.round(f))) : 0;
}

function finiteNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeProtocolFieldChecks(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const errors = [];
  const irrigationStatus = source.irrigation_status || source.irrigationStatus || null;
  if (irrigationStatus != null && !['good', 'dry', 'wet', 'unknown'].includes(irrigationStatus)) {
    errors.push('irrigation_status must be one of: good, dry, wet, unknown');
  }

  const irrigationInchesPerWeek = finiteNumberOrNull(source.irrigation_inches_per_week ?? source.irrigationInchesPerWeek);
  if (irrigationInchesPerWeek != null && (irrigationInchesPerWeek < 0 || irrigationInchesPerWeek > 5)) {
    errors.push('irrigation_inches_per_week must be between 0 and 5 inches');
  }

  const thatchMeasurementIn = finiteNumberOrNull(source.thatch_measurement_in ?? source.thatchMeasurementIn);
  if (thatchMeasurementIn != null && (thatchMeasurementIn < 0 || thatchMeasurementIn > 12)) {
    errors.push('thatch_measurement_in must be between 0 and 12 inches');
  }

  const chinchCountPerSqft = finiteNumberOrNull(source.chinch_count_per_sqft ?? source.chinchCountPerSqft);
  if (chinchCountPerSqft != null && (chinchCountPerSqft < 0 || chinchCountPerSqft > 500)) {
    errors.push('chinch_count_per_sqft must be between 0 and 500');
  }

  const soilKPpm = finiteNumberOrNull(source.soil_k_ppm ?? source.soilKPpm);
  if (soilKPpm != null && (soilKPpm < 0 || soilKPpm > 5000)) {
    errors.push('soil_k_ppm must be between 0 and 5000');
  }

  const notes = source.protocol_field_notes ?? source.notes ?? null;
  if (notes != null && String(notes).length > 3000) {
    errors.push('protocol_field_notes must be 3000 characters or fewer');
  }

  const normalized = {
    irrigation_status: irrigationStatus,
    irrigation_inches_per_week: irrigationInchesPerWeek,
    thatch_measurement_in: thatchMeasurementIn,
    chinch_count_per_sqft: chinchCountPerSqft,
    chinch_float_test_done: source.chinch_float_test_done === true || source.chinchFloatTestDone === true,
    nematode_assay_flag: source.nematode_assay_flag === true || source.nematodeAssayFlag === true,
    soil_k_ppm: soilKPpm,
    large_patch_history_observed: source.large_patch_history_observed === true || source.largePatchHistoryObserved === true,
    protocol_field_notes: notes == null ? null : String(notes),
  };

  return { errors, normalized };
}

async function persistProtocolFieldChecks({ assessment, checks, trx = db }) {
  if (!assessment?.id || !checks) return null;
  const assessmentCols = await trx('lawn_assessments').columnInfo().catch(() => ({}));
  const update = { updated_at: new Date() };
  for (const [key, value] of Object.entries(checks)) {
    if (!assessmentCols[key] || value === undefined) continue;
    // The manual irrigation_status input has been retired from the tech UI, so it
    // now arrives null. Don't clobber a previously-recorded status with that null —
    // only write it when an actual value is present (mirrors the turf-profile guard below).
    if (key === 'irrigation_status' && value == null) continue;
    update[key] = value;
  }
  if (assessmentCols.protocol_field_checks) update.protocol_field_checks = JSON.stringify(checks);
  if (Object.keys(update).length > 1) {
    await trx('lawn_assessments').where({ id: assessment.id }).update(update);
  }

  const turfCols = await trx('customer_turf_profiles').columnInfo().catch(() => ({}));
  if (!Object.keys(turfCols).length) return update;
  const profileUpdate = { updated_at: new Date() };
  if (checks.irrigation_status && turfCols.irrigation_status) profileUpdate.irrigation_status = checks.irrigation_status;
  if (checks.irrigation_inches_per_week != null && turfCols.irrigation_inches_per_week) {
    profileUpdate.irrigation_inches_per_week = checks.irrigation_inches_per_week;
  }
  if (checks.thatch_measurement_in != null && turfCols.thatch_measurement_in) {
    profileUpdate.thatch_measurement_in = checks.thatch_measurement_in;
  }
  if (checks.thatch_measurement_in != null && turfCols.last_thatch_checked_at) {
    profileUpdate.last_thatch_checked_at = assessment.service_date || new Date();
  }
  if (checks.chinch_float_test_done && turfCols.last_chinch_checked_at) {
    profileUpdate.last_chinch_checked_at = assessment.service_date || new Date();
  }
  if (checks.soil_k_ppm != null && turfCols.soil_k_ppm) profileUpdate.soil_k_ppm = checks.soil_k_ppm;
  if (checks.nematode_assay_flag && turfCols.nematode_assay_flag) profileUpdate.nematode_assay_flag = true;
  if (checks.nematode_assay_flag && turfCols.last_nematode_flagged_at) {
    profileUpdate.last_nematode_flagged_at = assessment.service_date || new Date();
  }
  if (checks.large_patch_history_observed && turfCols.large_patch_history) profileUpdate.large_patch_history = true;
  if (turfCols.last_protocol_assessment_id) profileUpdate.last_protocol_assessment_id = assessment.id;

  if (Object.keys(profileUpdate).length > 1) {
    await trx('customer_turf_profiles')
      .insert({ customer_id: assessment.customer_id, ...profileUpdate })
      .onConflict('customer_id')
      .merge(profileUpdate);
  }
  return update;
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

// Fixed namespace for the per-assessment snapshot-generation advisory lock, so
// hashtext(assessmentId) can't collide with any other advisory lock key.
const SNAPSHOT_LOCK_NAMESPACE = 0x4c41574e; // 'LAWN'

// Generate the property-health snapshot + recommendation cards as one
// serialized unit. A pg_advisory_xact_lock keyed on the assessment makes
// overlapping POST /confirm or /snapshot/regenerate requests run one-at-a-time,
// so the supersede→insert sequence can't race itself into duplicate (or
// orphaned) pre-review artifacts. The lock auto-releases when the txn ends.
async function generateSnapshotAndCards({ assessmentId, serviceId, serviceRecordId, customerId, generatedBy }) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [SNAPSHOT_LOCK_NAMESPACE, assessmentId]);
    const snapshot = await LawnSnapshot.buildLawnSnapshot({
      assessmentId,
      serviceId,
      serviceRecordId,
      generatedBy,
      trx,
    });
    const cards = await RecommendationEngine.generateRecommendationCards({
      snapshotId: snapshot.id,
      assessmentId,
      customerId,
      trx,
    });
    return { snapshot, cards };
  });
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

function normalizeSnapshotRow(row) {
  if (!row) return null;
  return {
    ...row,
    property_context: parseJsonObject(row.property_context),
    findings: parseJsonArray(row.findings),
    treatment_context: parseJsonObject(row.treatment_context),
    weather_context: parseJsonObject(row.weather_context),
    expected_window: parseJsonObject(row.expected_window),
    next_watch_items: parseJsonArray(row.next_watch_items),
    disclaimers: parseJsonArray(row.disclaimers),
  };
}

function normalizeRecommendationRow(row) {
  if (!row) return null;
  return {
    ...row,
    trigger_signals: parseJsonArray(row.trigger_signals),
    recommended_action: parseJsonObject(row.recommended_action),
    guardrails: parseJsonObject(row.guardrails),
    outcome: parseJsonObject(row.outcome),
  };
}

function assertAdminAction(req, res) {
  if (req.techRole === 'admin') return true;
  res.status(403).json({ error: 'Admin approval required' });
  return false;
}

function canShowRecommendationToCustomer(card) {
  if (!card) return false;
  if (card.approved_at) return true;
  return card.type === 'customer_education' && card.requires_human_approval === false;
}

// Statuses the customer-facing queries (lawn-health + service report) treat as
// surfaceable. Promoting a card into any of these must clear the copy-safety
// gate, exactly like the approve / customer_visible flags do.
const CUSTOMER_FACING_STATUSES = new Set(['approved', 'customer_visible', 'accepted']);

const CUSTOMER_COPY_BLOCKLIST = [
  /callback\s+risk/i,
  /\bchurn\b/i,
  /\bupsell\b/i,
  /\bmargin\b/i,
  /AI\s+predicted/i,
  /artificial\s+intelligence\s+predicted/i,
  /\bguarantee(?:d|s)?\b/i,
  /\bwill\s+recover\b/i,
  /\bpromise(?:d|s)?\b/i,
  /\bdiagnosed\b/i,
  /\bconfirmed\s+(?:fungus|disease|chinch|pest)\b/i,
];

function customerCopyViolation(copy = '') {
  const text = String(copy || '');
  const match = CUSTOMER_COPY_BLOCKLIST.find((pattern) => pattern.test(text));
  if (!match) return null;
  return `Customer-facing copy contains blocked wording: ${match.source}`;
}

function assertCustomerCopySafe(res, copy) {
  const violation = customerCopyViolation(copy);
  if (!violation) return true;
  res.status(400).json({ error: 'Unsafe customer-facing copy', details: [violation] });
  return false;
}

function recommendationEventMetadata(card = {}, extra = {}) {
  return {
    type: card.type || null,
    status: card.status || null,
    customer_visible: card.customer_visible === true,
    ...extra,
  };
}

function normalizeRecommendationEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    recommendation_id: row.recommendation_id || null,
    snapshot_id: row.snapshot_id || null,
    customer_id: row.customer_id || null,
    event_type: row.event_type,
    actor_type: row.actor_type,
    actor_id: row.actor_id || null,
    metadata: parseJsonObject(row.metadata),
    created_at: row.created_at,
  };
}

function summarizeRecommendationEvents(events = [], card = {}) {
  const counts = {
    generated: 0,
    approved: 0,
    shown: 0,
    recommendation_shown: 0,
    clicked: 0,
    recommendation_clicked: 0,
    follow_up_requested: 0,
    accepted: 0,
    dismissed: 0,
  };
  let latestEventAt = null;
  for (const event of events || []) {
    const type = String(event.event_type || '');
    if (Object.prototype.hasOwnProperty.call(counts, type)) counts[type] += 1;
    if (type === 'recommendation_clicked') counts.clicked += 1;
    if (type === 'recommendation_shown') counts.shown += 1;
    const createdAt = event.created_at ? new Date(event.created_at).toISOString() : null;
    if (createdAt && (!latestEventAt || createdAt > latestEventAt)) latestEventAt = createdAt;
  }
  if (card.status === 'accepted') counts.accepted = Math.max(counts.accepted, 1);
  if (card.status === 'dismissed') counts.dismissed = Math.max(counts.dismissed, 1);
  if (card.approved_at) counts.approved = Math.max(counts.approved, 1);
  const shown = counts.recommendation_shown || counts.shown;
  const clicked = counts.recommendation_clicked || counts.clicked;
  return {
    counts,
    latestEventAt,
    clickThroughRate: shown > 0 ? Number((clicked / shown).toFixed(3)) : null,
  };
}

async function logRecommendationEvent({ recommendationId, snapshotId, customerId, eventType, req, metadata = {} }) {
  await db('property_recommendation_events').insert({
    recommendation_id: recommendationId || null,
    snapshot_id: snapshotId || null,
    customer_id: customerId || null,
    event_type: eventType,
    actor_type: req?.techRole === 'admin' ? 'admin' : 'tech',
    actor_id: req?.technicianId || null,
    metadata: JSON.stringify(metadata),
  }).catch((err) => logger.error(`[lawn-assessment] Recommendation event log failed: ${err.message}`));
}

async function getSnapshotReviewPayload(assessmentId) {
  const snapshot = await db('property_health_snapshots')
    .where({ assessment_id: assessmentId, domain: 'lawn' })
    .orderBy('created_at', 'desc')
    .first();
  if (!snapshot) return { snapshot: null, recommendationCards: [] };

  const cards = await db('property_recommendation_cards')
    .where({ snapshot_id: snapshot.id })
    .orderByRaw(`
      CASE priority
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        ELSE 3
      END
    `)
    .orderBy('created_at', 'asc');
  const cardIds = cards.map((card) => card.id).filter(Boolean);
  const events = cardIds.length
    ? await db('property_recommendation_events')
      .whereIn('recommendation_id', cardIds)
      .orderBy('created_at', 'desc')
      .catch(() => [])
    : [];
  const eventsByCard = events.reduce((acc, event) => {
    const key = event.recommendation_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(event);
    return acc;
  }, {});

  return {
    snapshot: normalizeSnapshotRow(snapshot),
    recommendationCards: cards.map((card) => ({
      ...normalizeRecommendationRow(card),
      performance: summarizeRecommendationEvents(eventsByCard[card.id] || [], card),
    })),
  };
}

router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

// =========================================================================
// GET /recommendation-performance — aggregate recommendation event performance
// =========================================================================
router.get('/recommendation-performance', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 90));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const customerId = String(req.query.customerId || '').trim();

    const cardQuery = db('property_recommendation_cards')
      .where({ domain: 'lawn' })
      .where('created_at', '>=', since);
    if (customerId) cardQuery.where({ customer_id: customerId });
    const cards = await cardQuery.select(
      'id',
      'customer_id',
      'snapshot_id',
      'type',
      'priority',
      'status',
      'customer_visible',
      'approved_at',
      'created_at',
    );
    const cardIds = cards.map((card) => card.id).filter(Boolean);
    const events = cardIds.length
      ? await db('property_recommendation_events')
        .whereIn('recommendation_id', cardIds)
        .where('created_at', '>=', since)
        .orderBy('created_at', 'desc')
      : [];
    const eventsByCard = events.reduce((acc, event) => {
      const key = event.recommendation_id;
      if (!acc[key]) acc[key] = [];
      acc[key].push(event);
      return acc;
    }, {});
    const cardsWithPerformance = cards.map((card) => ({
      id: card.id,
      customer_id: card.customer_id,
      snapshot_id: card.snapshot_id,
      type: card.type,
      priority: card.priority,
      status: card.status,
      customer_visible: card.customer_visible === true,
      approved_at: card.approved_at || null,
      created_at: card.created_at,
      performance: summarizeRecommendationEvents(eventsByCard[card.id] || [], card),
    }));
    const totals = cardsWithPerformance.reduce((acc, card) => {
      acc.cards += 1;
      for (const [key, value] of Object.entries(card.performance.counts)) {
        acc.counts[key] = (acc.counts[key] || 0) + Number(value || 0);
      }
      if (card.status === 'approved' || card.status === 'customer_visible' || card.approved_at) acc.approvedCards += 1;
      if (card.customer_visible) acc.visibleCards += 1;
      if (card.performance.latestEventAt && (!acc.latestEventAt || card.performance.latestEventAt > acc.latestEventAt)) {
        acc.latestEventAt = card.performance.latestEventAt;
      }
      return acc;
    }, {
      cards: 0,
      approvedCards: 0,
      visibleCards: 0,
      counts: {},
      latestEventAt: null,
    });
    const shown = totals.counts.recommendation_shown || totals.counts.shown || 0;
    const clicked = totals.counts.recommendation_clicked || totals.counts.clicked || 0;
    totals.clickThroughRate = shown > 0 ? Number((clicked / shown).toFixed(3)) : null;

    res.json({ days, customerId: customerId || null, totals, cards: cardsWithPerformance });
  } catch (err) {
    next(err);
  }
});

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
    // Merge per-photo composites: average numeric, majority-vote categorical,
    // single-voice observations, and OR the overwatering_signal across photos.
    // (See mergePhotoComposites — majority vote replaced first-valid-wins so a
    // fungicide/dethatch gate can't unlock on photo 0 alone.)
    const mergedComposite = mergePhotoComposites(validResults);

    // Convert to display scores
    const displayScores = lawnAssessment.mapToDisplayScores(mergedComposite);

    // Determine season and apply adjustment. Prefer a WEATHER-driven normalization —
    // St. Augustine slows by actual cold, not the calendar — using the customer's
    // recent overnight lows. Falls back to the legacy month bucket on any miss.
    const now = new Date();
    const month = now.getMonth() + 1;
    const season = lawnAssessment.getSeason(month);
    let recentMinTempF = null;
    try {
      const cust = await db('customers').where({ id: customerId }).select('latitude', 'longitude').first();
      if (cust && Number.isFinite(Number(cust.latitude)) && Number.isFinite(Number(cust.longitude))) {
        recentMinTempF = await fetchRecentMinTempF({ latitude: Number(cust.latitude), longitude: Number(cust.longitude) });
      }
    } catch (err) { logger.warn(`[lawn-assessment] recent-temp lookup failed: ${err.message}`); }
    const adjustedScores = Number.isFinite(recentMinTempF)
      ? seasonAwareAdjustment(displayScores, { month, recentMinTempF })
      : lawnAssessment.applySeasonalAdjustment(displayScores, month);

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
      stress_damage: adjustedScores.stress_damage,
      observations: adjustedScores.observations,
      overall_score: overallScore,
      is_baseline: isBaseline,
    }).returning('*');

    // Auto-capture grass type from the AI read into the turf profile so lawn
    // reports use the real turf instead of the St. Augustine default. COALESCE-
    // guarded: only fills a blank value, never overrides a real one (tech/admin
    // edit or estimate). Fail-soft — never break the assessment.
    if (mergedComposite.grass_type) {
      try {
        await db('customer_turf_profiles')
          .insert({ customer_id: customerId, grass_type: mergedComposite.grass_type })
          .onConflict('customer_id')
          .merge({
            grass_type: db.raw('COALESCE(customer_turf_profiles.grass_type, ?)', [mergedComposite.grass_type]),
            updated_at: new Date(),
          });
      } catch (grassErr) {
        logger.warn?.(`[lawn-assessment] grass-type auto-capture skipped for ${customerId}: ${grassErr.message}`);
      }
    }

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
      detectedGrassType: mergedComposite.grass_type || null,
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
  // Consumed by lawn-recommendation-engine.evaluateFollowUp to trigger a
  // follow-up card; must be an accepted key or /confirm rejects it (400).
  'follow_up_needed',
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
    const {
      assessmentId,
      adjustedScores,
      stress_flags: stressFlagsInput,
      protocol_field_checks: protocolFieldChecksInput,
    } = req.body;

    if (!assessmentId) return res.status(400).json({ error: 'assessmentId is required' });

    // Validate stress_flags up front so a bad payload doesn't reach
    // the DB write path.
    const { errors: stressErrors, normalized: normalizedStressFlags } = normalizeStressFlags(stressFlagsInput);
    if (stressErrors.length) {
      return res.status(400).json({ error: 'Invalid stress_flags', details: stressErrors });
    }
    const protocolFieldChecksProvided = Object.prototype.hasOwnProperty.call(req.body, 'protocol_field_checks');
    let protocolFieldChecks = null;
    if (protocolFieldChecksProvided) {
      const { errors: protocolCheckErrors, normalized } = normalizeProtocolFieldChecks(protocolFieldChecksInput);
      if (protocolCheckErrors.length) {
        return res.status(400).json({ error: 'Invalid protocol_field_checks', details: protocolCheckErrors });
      }
      protocolFieldChecks = normalized;
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
    // Stress/Damage = worst of the tech-corrected fungus + thatch and the AI
    // worst-spot floor stored at /assess (which already folds in insect/drought/
    // mechanical and the worst per-photo disease/thatch). A tech correcting the
    // overall fungus/thatch can push it lower; the AI worst-spot floor holds so
    // a trouble spot isn't lost. Pre-stress_damage rows (null floor) fall back
    // to worst-of(fungus, thatch) — never 0.
    {
      const aiFloor = Number.isFinite(Number(assessment.stress_damage))
        ? Number(assessment.stress_damage)
        : 95;
      finalScores.stress_damage = Math.min(
        Number(finalScores.fungus_control),
        Number(finalScores.thatch_level),
        aiFloor,
      );
    }

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
    if (protocolFieldChecksProvided) {
      await persistProtocolFieldChecks({ assessment: updated, checks: protocolFieldChecks });
      Object.assign(updated, protocolFieldChecks, { protocol_field_checks: protocolFieldChecks });
    }

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
      const generated = await generateSnapshotAndCards({
        assessmentId,
        serviceId: updated.service_id || null,
        serviceRecordId: resolvedServiceRecordId,
        customerId: updated.customer_id,
        generatedBy: req.technician?.role === 'admin' ? 'admin' : 'tech',
      });
      propertySnapshot = generated.snapshot;
      recommendationCards = generated.cards;
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
// GET /:assessmentId/snapshot — snapshot + recommendation review payload
// =========================================================================
router.get('/:assessmentId/snapshot', async (req, res, next) => {
  try {
    const assessment = await db('lawn_assessments')
      .where({ id: req.params.assessmentId })
      .first('id');
    if (!assessment) return res.status(404).json({ error: 'Assessment not found' });

    res.json(await getSnapshotReviewPayload(req.params.assessmentId));
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /:assessmentId/snapshot/regenerate — rebuild internal snapshot/cards
// =========================================================================
router.post('/:assessmentId/snapshot/regenerate', async (req, res, next) => {
  try {
    if (!assertAdminAction(req, res)) return;

    const assessment = await db('lawn_assessments')
      .where({ id: req.params.assessmentId })
      .first();
    if (!assessment) return res.status(404).json({ error: 'Assessment not found' });
    if (assessment.confirmed_by_tech !== true) {
      return res.status(400).json({ error: 'Cannot generate a snapshot from an unconfirmed assessment' });
    }

    await generateSnapshotAndCards({
      assessmentId: assessment.id,
      serviceId: assessment.service_id || null,
      serviceRecordId: assessment.service_record_id || null,
      customerId: assessment.customer_id,
      generatedBy: 'admin',
    });

    res.json({ success: true, ...(await getSnapshotReviewPayload(assessment.id)) });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PATCH /snapshots/:snapshotId — edit/approve/hide customer snapshot
// =========================================================================
router.patch('/snapshots/:snapshotId', async (req, res, next) => {
  try {
    if (!assertAdminAction(req, res)) return;

    const snapshot = await db('property_health_snapshots')
      .where({ id: req.params.snapshotId, domain: 'lawn' })
      .first();
    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });

    const allowedStatuses = new Set(['draft', 'tech_confirmed', 'admin_approved', 'customer_visible', 'archived']);
    const patch = { updated_at: new Date() };
    const { headline, summary_customer, summary_internal, status, customer_visible: customerVisible } = req.body || {};

    if (headline != null) patch.headline = String(headline).slice(0, 180);
    if (summary_customer != null) {
      if (!assertCustomerCopySafe(res, summary_customer)) return;
      patch.summary_customer = String(summary_customer);
    }
    if (summary_internal != null) patch.summary_internal = String(summary_internal);
    if (status != null) {
      if (!allowedStatuses.has(status)) return res.status(400).json({ error: 'Invalid snapshot status' });
      patch.status = status;
    }
    if (customerVisible != null) {
      patch.customer_visible = customerVisible === true;
      if (customerVisible === true) {
        const effectiveSummary = patch.summary_customer ?? snapshot.summary_customer ?? '';
        if (!assertCustomerCopySafe(res, effectiveSummary)) return;
        patch.status = 'customer_visible';
        patch.approved_by = req.technicianId;
        patch.approved_at = new Date();
      }
    }
    if (req.body?.approve === true) {
      const effectiveSummary = patch.summary_customer ?? snapshot.summary_customer ?? '';
      if (!assertCustomerCopySafe(res, effectiveSummary)) return;
      patch.status = 'admin_approved';
      patch.approved_by = req.technicianId;
      patch.approved_at = new Date();
    }
    if (req.body?.hide === true) {
      patch.customer_visible = false;
      patch.status = 'archived';
    }

    const [updated] = await db('property_health_snapshots')
      .where({ id: snapshot.id })
      .update(patch)
      .returning('*');

    res.json({ success: true, snapshot: normalizeSnapshotRow(updated) });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PATCH /recommendations/:recommendationId — edit/approve/dismiss cards
// =========================================================================
router.patch('/recommendations/:recommendationId', async (req, res, next) => {
  try {
    if (!assertAdminAction(req, res)) return;

    const card = await db('property_recommendation_cards')
      .where({ id: req.params.recommendationId, domain: 'lawn' })
      .first();
    if (!card) return res.status(404).json({ error: 'Recommendation not found' });

    const allowedStatuses = new Set([
      'draft',
      'needs_admin_review',
      'approved',
      'customer_visible',
      'dismissed',
      'accepted',
      'expired',
    ]);
    const patch = { updated_at: new Date() };
    const body = req.body || {};

    if (body.title != null) patch.title = String(body.title).slice(0, 180);
    if (body.customer_copy != null) {
      if (!assertCustomerCopySafe(res, body.customer_copy)) return;
      patch.customer_copy = String(body.customer_copy);
    }
    if (body.internal_reason != null) patch.internal_reason = String(body.internal_reason);
    if (body.priority != null) {
      if (!['low', 'medium', 'high'].includes(body.priority)) return res.status(400).json({ error: 'Invalid priority' });
      patch.priority = body.priority;
    }
    if (body.status != null) {
      if (!allowedStatuses.has(body.status)) return res.status(400).json({ error: 'Invalid recommendation status' });
      // A direct status set into a customer-facing status must clear the same
      // copy-safety blocklist as the approve / customer_visible flags — don't
      // let it be a side door around the gate.
      if (CUSTOMER_FACING_STATUSES.has(body.status)) {
        const effectiveCopy = patch.customer_copy ?? card.customer_copy ?? '';
        if (!assertCustomerCopySafe(res, effectiveCopy)) return;
      }
      patch.status = body.status;
    }

    if (body.approve === true) {
      const effectiveCopy = patch.customer_copy ?? card.customer_copy ?? '';
      if (!assertCustomerCopySafe(res, effectiveCopy)) return;
      patch.status = 'approved';
      patch.approved_by = req.technicianId;
      patch.approved_at = new Date();
    }
    if (body.dismiss === true) {
      patch.status = 'dismissed';
      patch.customer_visible = false;
      patch.outcome = JSON.stringify({
        ...parseJsonObject(card.outcome),
        dismissed_at: new Date().toISOString(),
      });
    }
    if (body.customer_visible != null) {
      const nextVisible = body.customer_visible === true;
      const candidate = { ...card, ...patch, customer_visible: nextVisible };
      const effectiveCopy = patch.customer_copy ?? card.customer_copy ?? '';
      if (nextVisible && !assertCustomerCopySafe(res, effectiveCopy)) return;
      if (nextVisible && !canShowRecommendationToCustomer(candidate)) {
        patch.approved_by = req.technicianId;
        patch.approved_at = new Date();
      }
      patch.customer_visible = nextVisible;
      if (nextVisible) patch.status = 'customer_visible';
    }

    const [updated] = await db('property_recommendation_cards')
      .where({ id: card.id })
      .update(patch)
      .returning('*');

    const eventType = body.dismiss === true
      ? 'dismissed'
      : body.customer_visible === true
        ? 'shown'
        : body.approve === true
          ? 'approved'
          : 'edited';
    await logRecommendationEvent({
      recommendationId: updated.id,
      snapshotId: updated.snapshot_id,
      customerId: updated.customer_id,
      eventType,
      req,
      metadata: recommendationEventMetadata(updated),
    });

    res.json({ success: true, recommendation: normalizeRecommendationRow(updated) });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /recommendations/:recommendationId/events — read outcome event history
// =========================================================================
router.get('/recommendations/:recommendationId/events', async (req, res, next) => {
  try {
    const card = await db('property_recommendation_cards')
      .where({ id: req.params.recommendationId, domain: 'lawn' })
      .first();
    if (!card) return res.status(404).json({ error: 'Recommendation not found' });

    const events = await db('property_recommendation_events')
      .where({ recommendation_id: card.id })
      .orderBy('created_at', 'desc')
      .limit(100)
      .catch(() => []);

    res.json({
      recommendation: normalizeRecommendationRow(card),
      performance: summarizeRecommendationEvents(events, card),
      events: events.map(normalizeRecommendationEventRow).filter(Boolean),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /recommendations/:recommendationId/events — append outcome event
// =========================================================================
router.post('/recommendations/:recommendationId/events', async (req, res, next) => {
  try {
    const card = await db('property_recommendation_cards')
      .where({ id: req.params.recommendationId, domain: 'lawn' })
      .first();
    if (!card) return res.status(404).json({ error: 'Recommendation not found' });

    const eventType = String(req.body?.event_type || '').trim();
    if (!eventType) return res.status(400).json({ error: 'event_type is required' });

    await logRecommendationEvent({
      recommendationId: card.id,
      snapshotId: card.snapshot_id,
      customerId: card.customer_id,
      eventType,
      req,
      metadata: parseJsonObject(req.body?.metadata),
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /service/:serviceId — latest assessment captured for a scheduled visit
// =========================================================================
router.get('/service/:serviceId', async (req, res, next) => {
  try {
    const assessment = await applyServiceAssessmentOrder(
      db('lawn_assessments').where({ service_id: req.params.serviceId }),
    ).first();

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
  normalizeSnapshotRow,
  normalizeRecommendationRow,
  applyServiceAssessmentOrder,
  canShowRecommendationToCustomer,
  CUSTOMER_FACING_STATUSES,
  customerCopyViolation,
  summarizeRecommendationEvents,
  normalizeRecommendationEventRow,
};

module.exports = router;
