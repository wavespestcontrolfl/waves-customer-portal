/**
 * Customer delivery after a confirmed lawn assessment — the one place the
 * post-confirm pipeline runs (the /confirm route queues it; the recovery
 * sweep resumes it), so a delivery can be RESUMED step by step:
 *   - each customer step is gated on its own stamp on the assessment row
 *     (recommendations payload, report_auto_generated / report_id,
 *     notification_sent) — a retry executes only the gaps, never
 *     regenerating a delivered recommendation beside an already-generated
 *     report (Codex #4150 r15);
 *   - calibration is idempotent (one tech_calibration row per assessment)
 *     and resumable from the run's immutable scores_adjusted snapshot and the
 *     row's confirmed scores when the request that confirmed is gone;
 *   - completion is what the stamps prove (lawn-visit-assessment
 *     completePipeline); an incomplete claim stays open and the sweep below
 *     resumes it once stale — no manual retry needed.
 * A legacy row (no run) delivers exactly as before: every step, once.
 */

const db = require('../models/db');
const logger = require('./logger');
const visitAssessment = require('./lawn-visit-assessment');

const RESUME_AFTER_CONFIRM_MS = 2 * 60 * 1000;

// The AI side of a calibration: the run's snapshot when there is one, else the
// legacy row's JSON. Legacy pre-stress_damage baselines have no stress in the
// AI JSON, so the calibration would write ai_stress_damage=null and skip the
// delta; seed it the way the UI/confirm fallback does — min(fungus, thatch,
// 95) — so a technician's Stress correction records a real delta, not zero.
function calibrationBaseline(runAiScores, assessment = {}) {
  const baseline = runAiScores || assessment.adjusted_scores || assessment.composite_scores;
  const aiScores = baseline ? (typeof baseline === 'string' ? JSON.parse(baseline) : { ...baseline }) : {};
  if (aiScores && aiScores.stress_damage == null) {
    const parts = [Number(aiScores.fungus_control), Number(aiScores.thatch_level), 95].filter(Number.isFinite);
    if (parts.length > 1) aiScores.stress_damage = Math.min(...parts);
  }
  return aiScores;
}

// A resumed delivery rebuilds the comparison the lost request would have
// made: the run's snapshot against the scores the row confirmed with.
function resumedCalibration(row, run) {
  const aiScores = visitAssessment.runAiScores(run);
  if (!visitAssessment.SCORE_KEYS.some((key) => aiScores[key] != null)) return null;
  const finalScores = Object.fromEntries(visitAssessment.SCORE_KEYS.map((key) => [key, row[key] == null ? null : Number(row[key])]));
  return { aiScores, finalScores };
}

async function deliverConfirmedAssessment({ assessmentId, calibrate = null }, deps = {}) {
  const knex = deps.knex || db;
  const LawnIntel = deps.LawnIntel || require('./lawn-intelligence');
  const KnowledgeBridge = deps.KnowledgeBridge || require('./knowledge-bridge');
  const row = await knex('lawn_assessments').where({ id: assessmentId }).first();
  if (!row || !row.confirmed_by_tech) return { skipped: 'not_confirmed', done: [], gaps: [] };
  const run = await visitAssessment.loadRun(assessmentId, knex);
  const before = visitAssessment.deliveryGaps(row);
  const owed = visitAssessment.deliveryGaps({ ...row, recommendations: null, report_auto_generated: false, report_id: null, notification_sent: false });
  const firstAttempt = before.length === owed.length;
  // A run-backed row executes only its gaps; a legacy row every step, as before.
  const due = (step) => !run || before.includes(step);
  const done = [];

  // 1. FAWN weather context (an upsert on the row).
  await LawnIntel.attachWeather(assessmentId);

  // 3. Tech calibration — once per assessment. `calibrate` is the confirming
  //    request's comparison, or 'resume' to rebuild it from the run snapshot.
  if (calibrate) {
    const existing = await knex('tech_calibration').where({ assessment_id: assessmentId }).first('id').catch(() => null);
    const scores = existing ? null : (calibrate === 'resume' ? resumedCalibration(row, run) : calibrate);
    if (scores) {
      await LawnIntel.recordTechCalibration(assessmentId, scores.aiScores, scores.finalScores);
      done.push('calibration');
    }
  }

  // 2. AI recommendations from Knowledge Bridge (Claudeopedia + Wiki).
  if (due('recommendations')) { await KnowledgeBridge.generateAssessmentRecommendations(assessmentId); done.push('recommendations'); }

  // 4. Lawn health → customer health signal (recomputed from confirmed rows).
  await LawnIntel.emitHealthSignal(row.customer_id);

  // 5. Standalone lawn assessments (no scheduled service) have no later
  //    completion SMS, so they get the standalone "lawn health report ready"
  //    notification; service-linked rows do not (the completion text links
  //    the report — owner ruling 2026-08-01). After step 2, so the tip is
  //    populated. The service's own notification_sent guard holds too.
  if (!row.service_id && due('notification')) { await LawnIntel.sendAssessmentNotification(assessmentId); done.push('notification'); }

  // 6. Auto-generate the service report (guarded by report_auto_generated).
  if (due('report')) { await LawnIntel.generateServiceReport(assessmentId); done.push('report'); }

  // 7. Track assessment completion — once, on the first delivery attempt.
  if (firstAttempt) await LawnIntel.trackAssessmentCompletion(row.service_date);

  // Delivered — as far as the stamps prove it; an incomplete claim stays
  // open for the sweep.
  const gaps = run ? await visitAssessment.completePipeline(assessmentId, knex) : [];
  if (gaps.length) logger.warn(`[lawn-visit-delivery] delivery for ${assessmentId} left incomplete (${gaps.join(', ')}) — the recovery sweep will resume it`);
  return { done, gaps, firstAttempt };
}

// Recovery sweep (cron, every 10 minutes): every confirmed run-backed row
// whose delivery was never claimed (the process died between the commit and
// the queue) or whose claim went stale without completing (died
// mid-delivery) is claimed and resumed here — relying on a later client
// retry is not a recovery path (Codex #4150 r15). Rows confirmed in the last
// two minutes are left to their own request. A database without the claim
// columns has nothing to sweep.
async function sweepAbandonedDeliveries({ knex = db, limit = 25, staleAfterMs = visitAssessment.PIPELINE_STALE_MS, deliver = deliverConfirmedAssessment } = {}) {
  let candidates;
  try {
    candidates = await knex('lawn_assessment_runs as r')
      .join('lawn_assessments as la', 'la.id', 'r.assessment_id')
      .where('la.confirmed_by_tech', true)
      .where('la.confirmed_at', '<', new Date(Date.now() - RESUME_AFTER_CONFIRM_MS))
      .whereNull('r.pipeline_completed_at')
      .where(function abandoned() {
        this.whereNull('r.pipeline_claimed_at').orWhere('r.pipeline_claimed_at', '<', new Date(Date.now() - staleAfterMs));
      })
      .orderBy('la.confirmed_at', 'asc')
      .limit(limit)
      .select('r.assessment_id');
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) return { candidates: 0, resumed: 0, failed: 0 };
    throw err;
  }
  let resumed = 0;
  let failed = 0;
  for (const { assessment_id: assessmentId } of candidates) {
    if (!(await visitAssessment.claimPipeline(assessmentId, knex, { staleAfterMs }))) continue;
    try {
      await deliver({ assessmentId, calibrate: 'resume' }, { knex });
      resumed += 1;
    } catch (err) {
      failed += 1;
      logger.error(`[lawn-visit-delivery] resume failed for ${assessmentId}: ${err.message}`);
    }
  }
  return { candidates: candidates.length, resumed, failed };
}

module.exports = { deliverConfirmedAssessment, sweepAbandonedDeliveries, calibrationBaseline, resumedCalibration, RESUME_AFTER_CONFIRM_MS };
