/** Stored provenance for a newly created lawn visit assessment. */
const { SCORE_KEYS } = require('./lawn-visit-scores');
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

module.exports = { billedUsage, runRowFor, recordRun, attachRunPhotos, loadRun, reviewRun, replayContextForRun };
