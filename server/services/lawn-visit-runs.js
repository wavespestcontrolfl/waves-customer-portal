/** Lawn visit provenance, review/confirmation transactions, and delivery ownership. */
const { randomUUID } = require('crypto');
const { SCORE_KEYS, confirmScores } = require('./lawn-visit-scores');
const lawnAssessment = require('./lawn-assessment');
const { validateReview } = require('./lawn-visit-review-input');
const { buildReview } = require('./lawn-visit-review-evidence');
const { reviewedObservations } = require('./lawn-visit-customer-copy');

const CONTEXT_KEYS = ['season', 'month', 'region', 'grassType', 'turfHeightIn', 'irrigation', 'priorSummary'];
const parseObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
};
const storedContext = (context) => context && Object.fromEntries(CONTEXT_KEYS.filter((key) => context[key] != null).map((key) => [key, context[key]]));

function billedUsage(analysis) {
  const legs = [...(analysis.failures || []).map((leg) => leg?.usage), analysis.usage].filter(Boolean);
  if (!legs.length) return { input_tokens: null, output_tokens: null, reasoning_tokens: null };
  const sum = (key) => legs.reduce((total, usage) => total + (Number(usage[key]) || 0), 0);
  return { input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), reasoning_tokens: sum('reasoning_tokens') };
}

function runRowFor({ assessment, analysis, adjustedScores = null, photoRecords = [] }) {
  const usage = billedUsage(analysis);
  const complete = analysis.status === 'complete';
  const response = complete ? analysis : {};
  const whenComplete = (value) => (complete && value ? JSON.stringify(value) : null);
  const presented = adjustedScores ? Object.fromEntries(SCORE_KEYS.map((key) => [key, adjustedScores[key] ?? null])) : null;
  const context = parseObject(analysis.visionContext);
  return {
    assessment_id: assessment.id,
    customer_id: assessment.customer_id,
    service_id: assessment.service_id || null,
    status: analysis.status,
    provider: response.provider || null,
    requested_model: response.model || null,
    fallback_used: !!response.fallbackUsed,
    failures: JSON.stringify(analysis.failures || []),
    unavailable_reason: complete ? null : String(analysis.reason || 'error').slice(0, 80),
    prompt_version: analysis.promptVersion,
    context_hash: analysis.contextHash,
    photo_ids: JSON.stringify(photoRecords.map((row) => row.id)),
    photo_quality: JSON.stringify(analysis.photoQuality || []),
    findings: JSON.stringify(response.findings || []),
    severities: whenComplete(analysis.severities),
    scores_raw: whenComplete(analysis.scores),
    scores_adjusted: whenComplete(presented),
    // Missing provenance stays NULL; {} means a known, empty prompt context.
    vision_context: context ? JSON.stringify(storedContext(context)) : null,
    technician_notes_present: !!(analysis.technicianNotesPresent || context?.technicianNotes),
    observations: analysis.observations || null,
    raw_response: whenComplete(analysis.raw),
    // This writer creates the run alongside a NEW assessment. Capture the
    // exact initial text written there; later reviews compare before replacing
    // it and clear ownership when the technician changes the text manually.
    reconciliation: JSON.stringify({ published_observations: assessment.observations ?? null, stress_damage_override: null }),
    tokens_in: usage.input_tokens,
    tokens_out: usage.output_tokens,
    tokens_reasoning: usage.reasoning_tokens,
    latency_ms: analysis.latencyMs ?? null,
  };
}

// The caller supplies the assessment transaction: provenance is mandatory.
async function recordRun(args, knex) {
  const [row] = await knex('lawn_assessment_runs').insert(runRowFor(args)).returning('*');
  return row;
}

async function attachRunPhotos(runId, photoIds, knex) {
  const [row] = await knex('lawn_assessment_runs').where({ id: runId })
    .update({ photo_ids: JSON.stringify(photoIds), updated_at: knex.fn.now() }).returning('*');
  return row;
}

// The run, not today's feature gate, selects the visit confirmation path.
// A missing table during migration lag is optional. A savepoint keeps that
// PostgreSQL error from aborting the caller's assessment transaction.
async function loadRun(assessmentId, knex) {
  const read = (connection) => connection('lawn_assessment_runs').where({ assessment_id: assessmentId }).first();
  try {
    return await (knex.isTransaction ? knex.transaction(read) : read(knex));
  } catch (err) {
    if (err?.code === '42P01') return undefined;
    throw err;
  }
}

// A pending visit run does not prevent a replacement legacy assessment from
// becoming the baseline after the feature is turned off. A database still
// waiting for the run migration retains the legacy count; isolate that failed
// optional read in a savepoint when the caller already holds a transaction.
async function priorAssessmentCount(customerId, knex) {
  const read = (connection) => connection('lawn_assessments as assessment')
    .leftJoin('lawn_assessment_runs as run', 'run.assessment_id', 'assessment.id')
    .where('assessment.customer_id', customerId)
    .where((query) => query.whereNull('run.id').orWhere('assessment.confirmed_by_tech', true))
    .count('assessment.id as count').first();
  try {
    const row = await (knex.isTransaction ? knex.transaction(read) : read(knex));
    return Number(row.count);
  } catch (err) {
    if (err?.code !== '42P01') throw err;
    const row = await knex('lawn_assessments').where({ customer_id: customerId }).count('id as count').first();
    return Number(row.count);
  }
}

// Staff response from the persisted run. Raw provider output, input hashes,
// token accounting and prompt context remain internal to the run store.
function responseForRun(run) {
  if (!run) return null;
  const array = (value) => Array.isArray(value) ? value : [];
  return {
    runId: run.id, status: run.status, unavailableReason: run.unavailable_reason || null,
    provider: run.provider, model: run.requested_model, fallbackUsed: !!run.fallback_used,
    promptVersion: run.prompt_version, findings: array(run.findings), severities: parseObject(run.severities),
    photoQuality: array(run.photo_quality), observations: run.observations,
    reviewedFindings: run.reviewed_findings == null ? null : array(run.reviewed_findings),
    addedDetails: run.added_details == null ? null : array(run.added_details),
    reconciliation: parseObject(run.reconciliation), reviewedAt: run.reviewed_at || null,
  };
}

// Always join the caller's transaction through a savepoint, or open one when
// called directly. The confirmation caller owns authorization/finalization and
// takes its customer baseline lock BEFORE this assessment -> run lock order.
// Read under those locks: a second partial review must merge the first one's
// committed decisions, not the snapshot it saw before waiting.
async function reviewRun({ assessmentId, review = {}, technicianId = null, observationEdit, stressOverride }, knex) {
  if (observationEdit !== undefined && observationEdit !== null && typeof observationEdit !== 'string') {
    throw new TypeError('Observation edit must be text or null');
  }
  if (stressOverride !== undefined && stressOverride !== null && (!Number.isFinite(stressOverride) || stressOverride < 0 || stressOverride > 100)) {
    throw new TypeError('Stress override must be a score from 0 to 100 or null');
  }
  return knex.transaction(async (trx) => {
    let assessment = await trx('lawn_assessments').where({ id: assessmentId }).forUpdate().first();
    if (!assessment) throw Object.assign(new Error('Assessment not found'), { status: 404 });
    const run = await trx('lawn_assessment_runs').where({ assessment_id: assessmentId }).forUpdate().first();
    if (!run) throw Object.assign(new Error('Visit assessment run not found'), { status: 409 });
    const validated = validateReview(review, run);
    if (validated.errors.length) throw Object.assign(new Error('Invalid visit assessment review'), { status: 400, details: validated.errors });
    const provided = validated.review.provided;
    if (!provided && observationEdit === undefined && stressOverride === undefined) return { assessment, run };

    const previous = parseObject(run.reconciliation) || {};
    const built = provided ? buildReview(run, validated.review) : {};
    const observations = observationEdit === undefined && provided
      ? reviewedObservations({
        current: assessment.observations, lastPublished: previous.published_observations,
        observations: run.observations,
        findings: [...built.reviewed_findings, ...built.added_details],
      })
      : null;
    // An explicit edit withdraws ownership even when it repeats the exact
    // generated sentence. A mismatched or absent marker never regains it.
    const published = observationEdit !== undefined || assessment.observations !== previous.published_observations
      ? null : (provided ? observations : previous.published_observations ?? null);
    const reconciliation = {
      ...previous, ...built.reconciliation, published_observations: published,
      ...(stressOverride !== undefined ? { stress_damage_override: stressOverride } : {}),
    };
    const [updatedRun] = await trx('lawn_assessment_runs').where({ id: run.id }).update({
      reconciliation: JSON.stringify(reconciliation), updated_at: trx.fn.now(),
      ...(provided ? {
        reviewed_findings: JSON.stringify(built.reviewed_findings),
        added_details: JSON.stringify(built.added_details),
        reviewed_at: trx.fn.now(), reviewed_by_technician_id: technicianId,
      } : {}),
    }).returning('*');
    const nextText = observationEdit === undefined ? observations ?? assessment.observations : observationEdit;
    if (nextText !== assessment.observations) {
      [assessment] = await trx('lawn_assessments').where({ id: assessmentId })
        .update({ observations: nextText, updated_at: trx.fn.now() }).returning('*');
    }
    return { assessment, run: updatedRun };
  });
}

// lawn-assessment throws `{ statusCode }` while every throw in this confirm
// flow uses `{ status }` — the shape its own tests assert and a caller would
// branch on. Translate at the one delegation boundary rather than changing
// lawn-assessment, whose existing route caller already reads statusCode: an
// ownership-changed or inconsistent-visit-link 409 from the property-history
// path would otherwise reach the route with no `.status` and surface as a 500.
async function withRunErrorShape(run) {
  try {
    return await run();
  } catch (error) {
    if (error && error.status === undefined && error.statusCode !== undefined) error.status = error.statusCode;
    throw error;
  }
}

async function confirmLockedRun(args, customerId, trx) {
  const { assessmentId, adjustedScores, review, technicianId = null, observationEdit,
    stressFlags, propertyHistoryEnabled, persistChecks, scoreValue, calculateOverallScore } = args;
  const before = await trx('lawn_assessments').where({ id: assessmentId, customer_id: customerId }).forUpdate().first();
  if (!before) throw Object.assign(new Error('Assessment ownership changed'), { status: 409 });
  const originalRun = await trx('lawn_assessment_runs').where({ assessment_id: assessmentId }).forUpdate().first();
  if (!originalRun) throw Object.assign(new Error('Visit assessment run not found'), { status: 409 });
  // A retry returns the first confirmation, including its review and score
  // snapshot. Its new payload must never rewrite the completed assessment.
  if (before.confirmed_by_tech) {
    return { assessment: before, run: originalRun, confirmed: true, alreadyConfirmed: true, missingScores: [] };
  }
  const decision = confirmScores(before, originalRun, adjustedScores, { scoreValue, calculateOverallScore });
  let { assessment, run } = await reviewRun({
    assessmentId, review, technicianId, observationEdit, stressOverride: decision.stressOverride,
  }, trx);
  const update = {
    ...decision.finalScores, overall_score: decision.overallScore,
    confirmed_by_tech: decision.confirmed, updated_at: trx.fn.now(),
    ...(decision.confirmed ? { confirmed_at: trx.fn.now() } : {}),
    // Both existing clients also read observations from this JSON snapshot.
    // A copied adjustedScores.observations is not evidence of an explicit edit.
    adjusted_scores: JSON.stringify({ ...parseObject(assessment.adjusted_scores), ...decision.finalScores, observations: assessment.observations }),
    ...(stressFlags !== undefined ? { stress_flags: JSON.stringify(stressFlags) } : {}),
  };
  if (decision.confirmed && !propertyHistoryEnabled) {
    const baseline = await trx('lawn_assessments').where({ customer_id: customerId, is_baseline: true }).whereNot({ id: assessmentId }).first('id');
    if (!baseline) update.is_baseline = true;
  }
  assessment = decision.confirmed && propertyHistoryEnabled
    ? await withRunErrorShape(() => lawnAssessment.installConfirmedBaseline({ assessmentId, updateData: update }, { knex: trx }))
    : (await trx('lawn_assessments').where({ id: assessmentId }).update(update).returning('*'))[0];
  if (persistChecks) {
    await persistChecks(assessment, trx);
    assessment = await trx('lawn_assessments').where({ id: assessmentId }).first();
  }
  if (decision.confirmed) {
    // Durable input for the later delivery/recovery unit. Never derive a
    // calibration comparison from a retry's scores or today's mutable row.
    [run] = await trx('lawn_assessment_runs').where({ id: run.id }).update({
      reconciliation: JSON.stringify({
        ...parseObject(run.reconciliation),
        confirmation: {
          final_scores: decision.finalScores, ai_scores: decision.aiScores,
          calibration_eligible: decision.calibrationEligible,
          technician_id: technicianId,
        },
      }),
      updated_at: trx.fn.now(),
    }).returning('*');
  }
  return { assessment, run, confirmed: decision.confirmed, alreadyConfirmed: false, missingScores: decision.missing };
}

// The route owns authorization and validates its stress/protocol fields; this
// existing run store owns the atomic score/review/baseline write. The route
// passes its existing protocol writer so it commits in this transaction too.
async function confirmRun(args, knex) {
  return knex.transaction(async (trx) => {
    const original = await trx('lawn_assessments').where({ id: args.assessmentId }).first('customer_id');
    if (!original) throw Object.assign(new Error('Assessment not found'), { status: 404 });
    await lawnAssessment.lockCustomerBaseline(original.customer_id, trx);
    // Match the baseline installer's order and the assess property stamper:
    // baseline advisory -> property fence/customer -> assessment -> run.
    const write = (connection) => confirmLockedRun(args, original.customer_id, connection);
    // Protocol persistence also writes the turf profile, regardless of history.
    if (args.propertyHistoryEnabled || args.persistChecks) {
      const { withTurfProfileFence } = require('./customer-pricing-ai');
      return withTurfProfileFence(trx, original.customer_id, write);
    }
    return write(trx);
  });
}

const PIPELINE_STALE_MS = 15 * 60 * 1000;
function leaseDuration(staleAfterMs) {
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) throw new TypeError('Pipeline lease duration must be positive milliseconds');
  return staleAfterMs;
}

// One conditional write elects the owner across instances. The database clock
// defines the lease, so pod clock skew cannot reclaim an active delivery. Old
// timestamp-only claims wait out their lease; missing DDL fails closed instead
// of letting every caller deliver. A savepoint protects an enclosing writer.
async function claimPipeline(assessmentId, knex, { staleAfterMs = PIPELINE_STALE_MS } = {}) {
  leaseDuration(staleAfterMs);
  return knex.transaction(async (trx) => {
    const [run] = await trx('lawn_assessment_runs')
      .where({ assessment_id: assessmentId }).whereNull('pipeline_completed_at')
      .whereExists(trx('lawn_assessments').select(trx.raw('1'))
        .whereColumn('lawn_assessments.id', 'lawn_assessment_runs.assessment_id').where({ confirmed_by_tech: true }))
      .where((q) => q.whereNull('pipeline_claimed_at')
        .orWhereRaw("pipeline_claimed_at < clock_timestamp() - (? * interval '1 millisecond')", [staleAfterMs]))
      .update({ pipeline_owner_token: randomUUID(), pipeline_claimed_at: trx.raw('clock_timestamp()'), updated_at: trx.raw('clock_timestamp()') })
      .returning('*');
    return run || null;
  });
}

function ownedPipelineQuery(assessmentId, ownerToken, knex, staleAfterMs) {
  leaseDuration(staleAfterMs);
  if (typeof ownerToken !== 'string' || !ownerToken) throw new TypeError('Pipeline ownership token is required');
  return knex('lawn_assessment_runs').where({ assessment_id: assessmentId, pipeline_owner_token: ownerToken })
    .whereNull('pipeline_completed_at')
    .whereRaw("pipeline_claimed_at >= clock_timestamp() - (? * interval '1 millisecond')", [staleAfterMs]);
}

// Renew while external work runs, and check ownership before each next step.
// An expired owner cannot revive itself or release its replacement's claim.
async function renewPipeline(assessmentId, ownerToken, knex, { staleAfterMs = PIPELINE_STALE_MS } = {}) {
  const rows = await ownedPipelineQuery(assessmentId, ownerToken, knex, staleAfterMs)
    .update({ pipeline_claimed_at: knex.raw('clock_timestamp()'), updated_at: knex.raw('clock_timestamp()') }).returning('id');
  return rows.length === 1;
}

async function ownsPipeline(assessmentId, ownerToken, knex, { staleAfterMs = PIPELINE_STALE_MS } = {}) {
  return !!(await ownedPipelineQuery(assessmentId, ownerToken, knex, staleAfterMs).first('id'));
}

async function releasePipeline(assessmentId, ownerToken, knex, { staleAfterMs = PIPELINE_STALE_MS } = {}) {
  const rows = await ownedPipelineQuery(assessmentId, ownerToken, knex, staleAfterMs)
    .update({ pipeline_owner_token: null, pipeline_claimed_at: null, updated_at: knex.raw('clock_timestamp()') }).returning('id');
  return rows.length === 1;
}

// An intentional wait is not a never-attempted run. Drop exclusive ownership
// while retaining a recent attempt timestamp, so the normal lease interval is
// its retry backoff and the sweep's NULL-first ordering cannot let a batch of
// deferred old runs starve fresh confirmation work.
async function deferPipeline(assessmentId, ownerToken, knex, { staleAfterMs = PIPELINE_STALE_MS } = {}) {
  const rows = await ownedPipelineQuery(assessmentId, ownerToken, knex, staleAfterMs)
    .update({ pipeline_owner_token: null, pipeline_claimed_at: knex.raw('clock_timestamp()'), updated_at: knex.raw('clock_timestamp()') })
    .returning('id');
  return rows.length === 1;
}

function calibrationForRun(assessment, run) {
  const snapshot = parseObject(run?.reconciliation)?.confirmation;
  const technicianId = snapshot?.technician_id || assessment?.technician_id;
  if (snapshot?.calibration_eligible !== true || !technicianId) return null;
  return { aiScores: snapshot.ai_scores, finalScores: snapshot.final_scores, technicianId };
}

// A confirmation snapshot is the only record of what the technician changed. A
// run without one cannot have its comparison reconstructed — the assessment row
// may have been edited since — so the loss is surfaced at completion rather
// than silently passing as a visit that owed no calibration.
function calibrationEvidenceMissing(run) {
  return !parseObject(run?.reconciliation)?.confirmation;
}

function completedRecommendations(value) {
  const parsed = parseObject(value);
  return !!parsed && (parsed._sanitizationFinal === true || parsed._groundedInApplications === true
    || (typeof parsed.summary === 'string' && parsed.summary.trim().length > 0)
    || (Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0));
}

// Customer steps retain their canonical stamps. Only health needs a new
// success stamp; calibration is proven by its persisted comparison row.
async function deliveryState(assessmentId, knex) {
  const assessment = await knex('lawn_assessments').where({ id: assessmentId }).first();
  const run = await loadRun(assessmentId, knex);
  if (!assessment?.confirmed_by_tech || !run) return { assessment, run, gaps: ['assessment'], calibration: null };
  const calibration = calibrationForRun(assessment, run);
  const gaps = [];
  const calibrationRecorded = await knex('tech_calibration').where({ assessment_id: assessmentId }).first('id');
  if (calibration && !calibrationRecorded) gaps.push('calibration');
  // Reported, not owed. A run with no snapshot has no recoverable comparison —
  // blocking on it would strand every other step behind evidence this runner
  // cannot produce — so completion says so instead of pretending it was fine.
  const calibrationEvidenceLost = !calibrationRecorded && calibrationEvidenceMissing(run);
  if (!completedRecommendations(assessment.recommendations)) gaps.push('recommendations');
  if (!run.pipeline_health_completed_at) gaps.push('health');
  if (!assessment.service_id && !assessment.notification_sent) gaps.push('notification');
  // A claim with no settle mark is a send whose outcome was never recorded — the
  // release could not be written, or the worker died mid-flight. It is NOT owed
  // (the carrier may hold the message) and it is NOT proof of delivery either,
  // so surface it rather than letting completion read it as a delivered text.
  const notificationUnsettled = !assessment.service_id
    && assessment.notification_sent === true && !assessment.notification_sent_at;
  if (!(assessment.report_auto_generated === true || assessment.report_id)) gaps.push('report');
  return { assessment, run, gaps, calibration, notificationUnsettled, calibrationEvidenceLost };
}

async function markPipelineHealthComplete(assessmentId, ownerToken, knex, { staleAfterMs = PIPELINE_STALE_MS } = {}) {
  const rows = await ownedPipelineQuery(assessmentId, ownerToken, knex, staleAfterMs)
    .update({ pipeline_health_completed_at: knex.raw('clock_timestamp()'), updated_at: knex.raw('clock_timestamp()') }).returning('id');
  return rows.length === 1;
}

async function completePipeline(assessmentId, ownerToken, knex, { staleAfterMs = PIPELINE_STALE_MS } = {}) {
  return knex.transaction(async (trx) => {
    await trx('lawn_assessments').where({ id: assessmentId }).forUpdate().first('id');
    const owned = await ownedPipelineQuery(assessmentId, ownerToken, trx, staleAfterMs).forUpdate().first('id');
    if (!owned) return { owned: false, gaps: [] };
    const { gaps } = await deliveryState(assessmentId, trx);
    if (gaps.length) return { owned: true, gaps };
    const rows = await ownedPipelineQuery(assessmentId, ownerToken, trx, staleAfterMs)
      .update({ pipeline_completed_at: trx.raw('clock_timestamp()'), updated_at: trx.raw('clock_timestamp()') }).returning('id');
    return { owned: rows.length === 1, gaps };
  });
}

// Eligibility to compare a reconstructed prompt with the original input
// hash, not proof that the photos or current rubric still match that hash.
function replayContextForRun(run) {
  const context = parseObject(run?.vision_context);
  const omitted = [];
  if (!context) omitted.push({ field: 'visionContext', reason: 'analysis_time_context_unavailable' });
  if (run?.technician_notes_present === true || context?.technicianNotes) {
    omitted.push({ field: 'technicianNotes', reason: 'intentionally_not_stored' });
  } else if (run?.technician_notes_present !== false) {
    omitted.push({ field: 'technicianNotes', reason: 'presence_unknown' });
  }
  return { visionContext: storedContext(context), omitted, exactInputEligible: omitted.length === 0 };
}

module.exports = {
  billedUsage, runRowFor, recordRun, attachRunPhotos, loadRun, priorAssessmentCount, responseForRun,
  reviewRun, confirmRun, replayContextForRun, PIPELINE_STALE_MS, claimPipeline, renewPipeline, ownsPipeline, releasePipeline, deferPipeline,
  calibrationForRun, deliveryState, markPipelineHealthComplete, completePipeline,
};
