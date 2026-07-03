/**
 * Deterministic customer-safe lawn snapshot builder.
 *
 * This service packages confirmed lawn assessment facts into a structured
 * object for admin review. It does not call an LLM and does not make claims
 * that are not backed by assessment, photo, service, weather, or turf-profile
 * data.
 */

const db = require('../models/db');

const SNAPSHOT_VERSION = 'lawn_snapshot_v1';

const SCORE_FINDINGS = [
  {
    key: 'weed_pressure',
    label: 'Weed pressure',
    scoreKey: 'weed_suppression',
    threshold: 75,
    severeThreshold: 45,
    customerLabel: 'weed pressure',
  },
  {
    key: 'turf_thinning',
    label: 'Turf thinning',
    scoreKey: 'turf_density',
    threshold: 72,
    severeThreshold: 45,
    customerLabel: 'turf thinning',
  },
  {
    key: 'color_stress',
    label: 'Color stress',
    scoreKey: 'color_health',
    threshold: 72,
    severeThreshold: 45,
    customerLabel: 'turf color stress',
  },
  {
    key: 'possible_disease_pressure',
    label: 'Possible disease pressure',
    scoreKey: 'fungus_control',
    threshold: 70,
    severeThreshold: 45,
    customerLabel: 'possible disease pressure',
    cautious: true,
    // Disease + thatch are the signals the tech's consolidated Stress score folds
    // in. The completion screen now lets the tech correct Stress directly (without
    // touching fungus/thatch), so these findings must defer to that confirmed
    // Stress — otherwise a stale AI fungus/thatch can raise a customer finding the
    // tech already overruled.
    foldedIntoStress: true,
  },
  {
    key: 'thatch_watch',
    label: 'Thatch watch',
    scoreKey: 'thatch_level',
    threshold: 68,
    severeThreshold: 42,
    customerLabel: 'thatch buildup indicators',
    cautious: true,
    foldedIntoStress: true,
  },
];

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

function scoreValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function severityFromScore(score) {
  const n = scoreValue(score);
  if (n == null) return 0;
  if (n >= 82) return 0;
  if (n >= 70) return 1;
  if (n >= 50) return 2;
  if (n >= 35) return 3;
  return 4;
}

function severityLabel(severity) {
  if (severity >= 4) return 'High-priority issue needing office review';
  if (severity >= 3) return 'Significant issue requiring follow-up';
  if (severity >= 2) return 'Moderate issue being treated';
  if (severity >= 1) return 'Minor condition to monitor';
  return 'No major issue observed';
}

function articleFor(text) {
  return /^[aeiou]/i.test(text) ? 'an' : 'a';
}

function sentenceList(items) {
  const clean = items.filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLabel(value) {
  return String(value || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function locationLabelFromPhoto(photo) {
  if (!photo || typeof photo !== 'object') return null;
  const explicitZone = normalizeLabel(photo.zone);
  if (explicitZone) return explicitZone;

  const photoType = normalizeLabel(photo.photo_type);
  if (!photoType || photoType === 'general') return null;
  if (photoType === 'front yard') return 'front yard';
  if (photoType === 'back yard') return 'back yard';
  if (photoType === 'side yard') return 'side yard';
  if (photoType === 'trouble spot') return 'trouble area';
  return photoType;
}

function chooseEvidencePhoto(photos = []) {
  const customerVisible = photos.filter((photo) => photo.customer_visible !== false && photo.quality_gate_passed !== false);
  return customerVisible.find((photo) => photo.is_best_photo) || customerVisible[0] || null;
}

function customerCopyForFinding({ finding, locationLabel }) {
  const location = locationLabel ? ` in the ${locationLabel}` : ' in one area of the lawn';
  const severityWord = finding.severity >= 3 ? 'significant' : finding.severity >= 2 ? 'moderate' : 'minor';
  const prefix = finding.cautious ? 'We saw signs consistent with' : 'We saw';
  return `${prefix} ${severityWord} ${finding.customerLabel}${location}.`;
}

function deriveFindings(inputs = {}) {
  const assessment = inputs.assessment || {};
  const scores = {
    turf_density: scoreValue(assessment.turf_density),
    weed_suppression: scoreValue(assessment.weed_suppression),
    color_health: scoreValue(assessment.color_health),
    fungus_control: scoreValue(assessment.fungus_control),
    thatch_level: scoreValue(assessment.thatch_level),
  };
  // The tech's confirmed consolidated Stress score (explicit column, else the
  // worst of fungus/thatch for legacy rows). Findings folded into Stress defer to
  // this so a Stress correction the tech made isn't contradicted.
  const stressDamage = assessment.stress_damage != null
    ? scoreValue(assessment.stress_damage)
    : Math.min(scores.fungus_control ?? 100, scores.thatch_level ?? 100);
  const evidencePhoto = chooseEvidencePhoto(inputs.photos || []);
  const locationLabel = locationLabelFromPhoto(evidencePhoto);

  const findings = [];
  for (const rule of SCORE_FINDINGS) {
    const score = scores[rule.scoreKey];
    if (score == null || score >= rule.threshold) continue;
    // Folded findings (disease/thatch) fire only when the confirmed Stress also
    // reads below the threshold — so a tech who raised Stress above it (overruling
    // a stale AI fungus/thatch) doesn't get a contradicting customer finding.
    if (rule.foldedIntoStress && stressDamage != null && stressDamage >= rule.threshold) continue;
    const severity = score < rule.severeThreshold ? Math.max(3, severityFromScore(score)) : severityFromScore(score);
    const finding = {
      key: rule.key,
      label: rule.label,
      severity,
      confidence: assessment.confirmed_by_tech ? 0.85 : 0.55,
      location_label: locationLabel,
      metric: rule.scoreKey,
      value: score,
      customerLabel: rule.customerLabel,
      cautious: Boolean(rule.cautious),
      evidence_refs: [`assessment:${assessment.id}`],
    };
    findings.push({
      key: finding.key,
      label: finding.label,
      severity: finding.severity,
      confidence: finding.confidence,
      location_label: finding.location_label,
      customer_copy: customerCopyForFinding({ finding, locationLabel }),
      internal_copy: `${finding.label} score ${score}/100 from confirmed lawn assessment.`,
      evidence_refs: finding.evidence_refs,
      metric: finding.metric,
      value: finding.value,
    });
  }

  return findings.sort((a, b) => b.severity - a.severity);
}

function buildPropertyContext({ customer = {}, turfProfile = {}, assessment = {} } = {}) {
  const fawn = parseJsonObject(assessment.fawn_snapshot, {});
  return {
    grass_type: turfProfile.grass_type || customer.lawn_type || null,
    cultivar: turfProfile.cultivar || null,
    sun_exposure: turfProfile.sun_exposure || null,
    lawn_sqft: turfProfile.lawn_sqft || null,
    irrigation_type: turfProfile.irrigation_type || null,
    irrigation_status: turfProfile.irrigation_status || assessment.irrigation_status || null,
    irrigation_inches_per_week: turfProfile.irrigation_inches_per_week || assessment.irrigation_inches_per_week || null,
    rainfall_inches_today: numberOrNull(fawn.rainfall_in ?? fawn.rain_24h_in ?? assessment.fawn_rainfall_7d),
    waveguard_tier: customer.waveguard_tier || null,
    city: customer.city || null,
    zip: customer.zip || customer.postal_code || null,
    fawn_station: fawn.station || null,
  };
}

function productSummary(products = []) {
  const names = products
    .map((product) => product.product_name || product.name || product.product || product.material_name)
    .filter(Boolean);
  if (!names.length) return null;
  return sentenceList([...new Set(names)].slice(0, 4));
}

function buildTreatmentContext({ assessment = {}, serviceRecord = {}, scheduledService = {}, products = [] } = {}) {
  const productsAppliedSummary = productSummary(products);
  return {
    completed_today: Boolean(serviceRecord?.id),
    service_type: serviceRecord?.service_type || scheduledService?.service_type || null,
    products_applied_summary: productsAppliedSummary,
    technician_id: assessment.technician_id || serviceRecord?.technician_id || null,
    treatment_plan_id: serviceRecord?.treatment_plan_id || scheduledService?.treatment_plan_id || null,
  };
}

function buildWeatherContext(assessment = {}) {
  const fawn = parseJsonObject(assessment.fawn_snapshot, null);
  if (!fawn) return {};
  const label = fawn.label || fawn.condition_label || fawn.summary || 'Recent weather context';
  const rainfallInchesToday = numberOrNull(fawn.rainfall_in ?? fawn.rain_24h_in ?? assessment.fawn_rainfall_7d);
  return {
    label,
    rainfall_inches_today: rainfallInchesToday,
    customer_copy: rainfallInchesToday != null
      ? `Recent rainfall near the property was about ${rainfallInchesToday}" and can influence turf stress, weed pressure, and visible recovery time.`
      : 'Recent weather can influence turf stress, weed pressure, and visible recovery time.',
    source: 'fawn_snapshot',
  };
}

function getExpectedWindow() {
  return {
    min_days: 14,
    max_days: 21,
    basis: 'service_protocol_default',
  };
}

function buildNextWatchItems(findings = []) {
  if (!findings.length) return ['Compare the lawn condition against today\'s review on the next service.'];
  return findings.slice(0, 2).map((finding) => {
    const area = finding.location_label ? ` in the ${finding.location_label}` : '';
    return `Monitor ${finding.label.toLowerCase()}${area} on the next service.`;
  });
}

function buildHeadline(findings = []) {
  const maxSeverity = findings.reduce((max, finding) => Math.max(max, finding.severity || 0), 0);
  return severityLabel(maxSeverity);
}

function buildCustomerSummary(snapshotDraft = {}) {
  const findings = snapshotDraft.findings || [];
  const treatment = snapshotDraft.treatment_context || {};
  const window = snapshotDraft.expected_window || getExpectedWindow();
  if (!findings.length) {
    return `Today's lawn review did not show a major issue. Your technician completed the scheduled service, and we'll continue watching the lawn on the next visit.`;
  }

  const findingText = sentenceList(findings.slice(0, 2).map((finding) => finding.customer_copy.replace(/\.$/, '')));
  const actionText = treatment.completed_today
    ? 'Your technician completed today\'s scheduled lawn service and documented the condition for comparison.'
    : 'We documented the condition for comparison during the next lawn review.';
  return `${findingText}. ${actionText} Visible improvement usually takes ${window.min_days}-${window.max_days} days depending on irrigation, mowing, rainfall, and site conditions.`;
}

function buildInternalSummary(snapshotDraft = {}) {
  const findings = snapshotDraft.findings || [];
  if (!findings.length) return 'Confirmed assessment generated no material lawn findings for customer display.';
  return `Confirmed assessment generated ${findings.length} finding(s): ${findings.map((finding) => `${finding.key}:${finding.severity}`).join(', ')}.`;
}

function buildEvidenceRefs(inputs = {}) {
  const assessment = inputs.assessment || {};
  return deriveFindings(inputs).map((finding) => ({
    customer_id: assessment.customer_id,
    source_table: 'lawn_assessments',
    source_id: assessment.id,
    evidence_key: finding.key,
    metric: finding.metric,
    value: { score: finding.value },
    comparison: 'below customer-safe threshold',
    confidence: finding.confidence,
    customer_label: finding.label,
  }));
}

async function getSnapshotInputs({ assessmentId }) {
  const assessment = await db('lawn_assessments').where({ id: assessmentId }).first();
  if (!assessment) {
    const err = new Error('Assessment not found');
    err.code = 'assessment_not_found';
    throw err;
  }
  if (assessment.confirmed_by_tech !== true) {
    const err = new Error('Cannot build a customer snapshot from an unconfirmed assessment');
    err.code = 'assessment_not_confirmed';
    throw err;
  }

  const [customer, turfProfile, photos] = await Promise.all([
    db('customers').where({ id: assessment.customer_id }).first(),
    db('customer_turf_profiles').where({ customer_id: assessment.customer_id, active: true }).first().catch(() => null),
    db('lawn_assessment_photos').where({ assessment_id: assessmentId }).orderBy('photo_order', 'asc').catch(() => []),
  ]);

  const [serviceRecord, scheduledService] = await Promise.all([
    assessment.service_record_id
      ? db('service_records').where({ id: assessment.service_record_id }).first().catch(() => null)
      : Promise.resolve(null),
    assessment.service_id
      ? db('scheduled_services').where({ id: assessment.service_id }).first().catch(() => null)
      : Promise.resolve(null),
  ]);

  const products = serviceRecord?.id
    ? await db('service_products').where({ service_record_id: serviceRecord.id }).catch(() => [])
    : [];

  return {
    assessment,
    customer: customer || {},
    turfProfile: turfProfile || {},
    photos: photos || [],
    serviceRecord: serviceRecord || {},
    scheduledService: scheduledService || {},
    products,
  };
}

// Card statuses that mean "not yet reviewed by an admin". Anything else
// (dismissed, accepted, approved, customer_visible, …) is a recorded admin
// decision and must never be deleted by the supersede path.
const PRE_REVIEW_CARD_STATUSES = ['needs_admin_review', 'draft'];

// Remove prior PRE-REVIEW snapshots (and their pre-review cards) for an
// assessment so repeated confirms / regenerations don't stack duplicates.
// A snapshot is left untouched if it (or any of its cards) has been approved,
// made customer-visible, OR carries a reviewed status such as 'dismissed' —
// preserving the admin decision and its event history. Cards have no FK
// cascade to snapshots, so they're deleted explicitly; snapshot evidence
// cascades on snapshot delete.
async function supersedePriorSnapshots(assessmentId, exec = db) {
  const priorIds = await exec('property_health_snapshots')
    .where({ assessment_id: assessmentId, domain: 'lawn', customer_visible: false })
    .whereNull('approved_at')
    .pluck('id');
  if (!priorIds.length) return;

  const lockedIds = await exec('property_recommendation_cards')
    .whereIn('snapshot_id', priorIds)
    .where(function () {
      this.where('customer_visible', true)
        .orWhereNotNull('approved_at')
        .orWhereNotIn('status', PRE_REVIEW_CARD_STATUSES);
    })
    .distinct('snapshot_id')
    .pluck('snapshot_id');

  const removableIds = priorIds.filter((id) => !lockedIds.includes(id));
  if (!removableIds.length) return;

  // Delete only the still-pre-review cards on these snapshots (by definition
  // all of their cards are pre-review, but scope it defensively).
  await exec('property_recommendation_cards')
    .whereIn('snapshot_id', removableIds)
    .where('customer_visible', false)
    .whereNull('approved_at')
    .whereIn('status', PRE_REVIEW_CARD_STATUSES)
    .del();
  await exec('property_health_snapshots').whereIn('id', removableIds).del();
}

async function buildLawnSnapshot({ assessmentId, serviceId = null, serviceRecordId = null, generatedBy = 'system', trx = null } = {}) {
  if (!assessmentId) throw new Error('assessmentId is required');
  // When a transaction is supplied, the supersede + insert run inside it so a
  // per-assessment advisory lock (held by the caller) serializes concurrent
  // confirms/regenerations. Source-fact reads can stay on the base connection.
  const exec = trx || db;
  const inputs = await getSnapshotInputs({ assessmentId });
  const assessment = inputs.assessment;

  const findings = deriveFindings(inputs);
  const expectedWindow = getExpectedWindow(inputs);
  const draft = {
    customer_id: assessment.customer_id,
    domain: 'lawn',
    source_type: 'lawn_assessment',
    source_id: assessment.id,
    assessment_id: assessment.id,
    service_id: serviceId || assessment.service_id || null,
    service_record_id: serviceRecordId || assessment.service_record_id || null,
    status: 'tech_confirmed',
    customer_visible: false,
    snapshot_version: SNAPSHOT_VERSION,
    generated_by: generatedBy,
    generated_by_technician_id: assessment.technician_id || null,
    headline: buildHeadline(findings),
    property_context: buildPropertyContext(inputs),
    findings,
    treatment_context: buildTreatmentContext(inputs),
    weather_context: buildWeatherContext(assessment),
    expected_window: expectedWindow,
    next_watch_items: buildNextWatchItems(findings),
    disclaimers: [
      'Visible improvement depends on irrigation, mowing, rainfall, and site conditions.',
      'Possible pest or disease indicators require technician confirmation before they are treated as a diagnosis.',
    ],
  };
  draft.summary_customer = buildCustomerSummary(draft);
  draft.summary_internal = buildInternalSummary(draft);

  // Idempotency: collapse repeated confirms / regenerations to a single
  // pre-review snapshot before inserting the fresh one.
  await supersedePriorSnapshots(assessment.id, exec);

  const [snapshot] = await exec('property_health_snapshots').insert({
    ...draft,
    property_context: JSON.stringify(draft.property_context),
    findings: JSON.stringify(draft.findings),
    treatment_context: JSON.stringify(draft.treatment_context),
    weather_context: JSON.stringify(draft.weather_context),
    expected_window: JSON.stringify(draft.expected_window),
    next_watch_items: JSON.stringify(draft.next_watch_items),
    disclaimers: JSON.stringify(draft.disclaimers),
  }).returning('*');

  const evidenceRows = buildEvidenceRefs(inputs).map((row) => ({
    ...row,
    snapshot_id: snapshot.id,
    value: JSON.stringify(row.value),
  }));
  if (evidenceRows.length) {
    await exec('property_snapshot_evidence').insert(evidenceRows);
  }

  return {
    ...snapshot,
    property_context: draft.property_context,
    findings: draft.findings,
    treatment_context: draft.treatment_context,
    weather_context: draft.weather_context,
    expected_window: draft.expected_window,
    next_watch_items: draft.next_watch_items,
    disclaimers: draft.disclaimers,
  };
}

module.exports = {
  SNAPSHOT_VERSION,
  buildLawnSnapshot,
  supersedePriorSnapshots,
  getSnapshotInputs,
  deriveFindings,
  buildCustomerSummary,
  buildInternalSummary,
  getExpectedWindow,
  buildEvidenceRefs,
  _test: {
    parseJsonObject,
    parseJsonArray,
    scoreValue,
    severityFromScore,
    severityLabel,
    locationLabelFromPhoto,
    chooseEvidencePhoto,
    customerCopyForFinding,
    buildHeadline,
    buildNextWatchItems,
    buildWeatherContext,
  },
};
