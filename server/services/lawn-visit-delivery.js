/** Resume confirmed visit delivery from its immutable comparison and step stamps. */
const db = require('../models/db');
const logger = require('./logger');
const runs = require('./lawn-visit-runs');

// Weather is fetched as CURRENT conditions, so it stands in for the visit's own
// only while the visit is recent. Past this, a run recovered late leaves the
// snapshot unset rather than recording recovery-day weather as the visit's.
const WEATHER_WINDOW_MS = 6 * 60 * 60 * 1000;

function nearTheVisit(assessment, windowMs) {
  const confirmedAt = assessment?.confirmed_at ? new Date(assessment.confirmed_at).getTime() : NaN;
  if (!Number.isFinite(confirmedAt)) return false;
  return Date.now() - confirmedAt <= windowMs;
}

const ownershipLost = () => Object.assign(new Error('Lawn delivery ownership lost'), { code: 'LAWN_DELIVERY_OWNERSHIP_LOST' });
const stepIncomplete = (step) => Object.assign(new Error(`Lawn delivery step incomplete: ${step}`), { code: 'LAWN_DELIVERY_STEP_INCOMPLETE' });

async function deliverConfirmedAssessment({ assessmentId }, deps = {}) {
  const knex = deps.knex || db;
  const LawnIntel = deps.LawnIntel || require('./lawn-intelligence');
  const KnowledgeBridge = deps.KnowledgeBridge || require('./knowledge-bridge');
  const staleAfterMs = deps.staleAfterMs ?? runs.PIPELINE_STALE_MS;
  const weatherWindowMs = deps.weatherWindowMs ?? WEATHER_WINDOW_MS;
  const heartbeatMs = deps.heartbeatMs ?? 30000;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= staleAfterMs) throw new TypeError('Delivery heartbeat must be shorter than its lease');
  const claim = await runs.claimPipeline(assessmentId, knex, { staleAfterMs });
  if (!claim) return { skipped: 'not_claimed', done: [], gaps: [] };
  const owner = claim.pipeline_owner_token;
  let lost = false;
  let renewing = null;
  const renew = () => runs.renewPipeline(assessmentId, owner, knex, { staleAfterMs });
  const timer = setInterval(() => {
    if (renewing || lost) return;
    renewing = renew().then((ok) => { if (!ok) lost = true; })
      .catch(() => { lost = true; }).finally(() => { renewing = null; });
  }, heartbeatMs);
  timer.unref?.();
  const guard = async () => { if (lost || !(await renew())) throw ownershipLost(); };
  const done = [];
  try {
    await guard();
    // Weather may legitimately be unavailable. It is an enrichment, while the
    // steps below require their own durable proof before proceeding. The stored
    // snapshot is the VISIT's conditions and feeds later reports and outcome
    // analysis, so a recovery hours or days later must not overwrite it with
    // recovery-time weather — it is attached once, not refreshed per attempt.
    const attachWeatherOnce = async (assessment) => {
      if (assessment?.fawn_snapshot) return null;
      if (!nearTheVisit(assessment, weatherWindowMs)) {
        // A fetch is current conditions, not the visit's. Recorded days later it
        // would be wrong rather than missing, and reports and outcome analysis
        // read it as the visit's weather — so leave it unset and say so.
        logger.warn('[lawn-visit-delivery] weather not attached', { assessmentId, reason: 'visit_too_old' });
        return null;
      }
      const weather = await LawnIntel.attachWeather(assessmentId);
      await guard(); // The lease covers every effect in the pipeline, this one included.
      return weather;
    };
    await attachWeatherOnce((await runs.deliveryState(assessmentId, knex)).assessment);
    const actions = [
      ['calibration', async (state) => {
        const { aiScores, finalScores, technicianId } = state.calibration;
        await LawnIntel.recordTechCalibration(assessmentId, aiScores, finalScores, { knex, strict: true, technicianId });
      }],
      ['recommendations', () => KnowledgeBridge.generateAssessmentRecommendations(assessmentId)],
      ['health', async (state) => {
        const result = await LawnIntel.emitHealthSignal(state.assessment.customer_id, { knex, strict: true });
        if (!result) throw stepIncomplete('health');
        if (!(await runs.markPipelineHealthComplete(assessmentId, owner, knex, { staleAfterMs }))) throw ownershipLost();
      }],
      // The customer send is the one non-idempotent effect: the sender re-checks
      // this worker's lease immediately before dispatching, so a stale worker
      // cannot text a customer the replacement is already notifying.
      // The report comes BEFORE the text that announces it. A customer no
      // channel will deliver to leaves the notification step permanently owed,
      // and running it first starved the report — which stands on its own in
      // the portal — behind a send that can never succeed.
      ['report', () => LawnIntel.generateServiceReport(assessmentId)],
      ['notification', () => LawnIntel.sendAssessmentNotification(assessmentId, { beforeSend: guard })],
    ];
    for (const [step, action] of actions) {
      const state = await runs.deliveryState(assessmentId, knex);
      if (!state.gaps.includes(step)) continue;
      await guard();
      await action(state);
      await guard();
      if ((await runs.deliveryState(assessmentId, knex)).gaps.includes(step)) throw stepIncomplete(step);
      done.push(step);
    }
    await guard();
    const { assessment } = await runs.deliveryState(assessmentId, knex);
    const tracked = await LawnIntel.trackAssessmentCompletion(assessment.service_date);
    if (tracked?.error) throw stepIncomplete('tracking');
    const completed = await runs.completePipeline(assessmentId, owner, knex, { staleAfterMs });
    if (!completed.owned) throw ownershipLost();
    if (completed.gaps.length) throw stepIncomplete('completion');
    return { done, gaps: [] };
  } finally {
    clearInterval(timer);
    if (renewing) await renewing;
  }
}

const RECOVERY_RETRY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

// Read at call time, like every other customer-send gate.
const gateOpen = () => require('../config/feature-gates').gateEnvValue('GATE_LAWN_DELIVERY_RECOVERY');

function validateSweepBounds(limit, retryHorizonMs, staleAfterMs) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Delivery recovery limit must be from 1 to 100');
  if (!Number.isSafeInteger(retryHorizonMs) || retryHorizonMs <= staleAfterMs) throw new TypeError('Delivery recovery horizon must outlast its lease');
}

async function sweepAbandonedDeliveries({ knex = db, limit = 25, staleAfterMs = runs.PIPELINE_STALE_MS, retryHorizonMs = RECOVERY_RETRY_HORIZON_MS, deliver = deliverConfirmedAssessment } = {}) {
  validateSweepBounds(limit, retryHorizonMs, staleAfterMs);
  let candidates;
  try {
    candidates = await knex('lawn_assessment_runs as run')
      .join('lawn_assessments as assessment', 'assessment.id', 'run.assessment_id')
      .where('assessment.confirmed_by_tech', true).whereNull('run.pipeline_completed_at')
      // The confirm route still runs its own delivery inline, without claiming
      // the run (it moves onto this leased runner in the confirm-route unit),
      // so quarantine a confirmation for a full lease before recovery may touch
      // it — otherwise a slow request-path delivery and a sweep could both run.
      .whereRaw("assessment.confirmed_at < clock_timestamp() - (? * interval '1 millisecond')", [staleAfterMs])
      // A run that cannot finish — a customer no channel will ever deliver to,
      // say — must not be reclaimed every ten minutes forever. Each attempt is
      // already logged; after the horizon the row stops being swept.
      .whereRaw("assessment.confirmed_at > clock_timestamp() - (? * interval '1 millisecond')", [retryHorizonMs])
      .where((q) => q.whereNull('run.pipeline_claimed_at')
        .orWhereRaw("run.pipeline_claimed_at < clock_timestamp() - (? * interval '1 millisecond')", [staleAfterMs]))
      .orderBy('assessment.confirmed_at', 'asc').limit(limit).select('run.assessment_id');
  } catch (err) {
    if (err?.code === '42P01' || err?.code === '42703') return { candidates: 0, resumed: 0, failed: 0, skipped: 'schema_unavailable' };
    throw err;
  }
  // Fails closed: an ungated environment counts the work and sends nothing.
  if (!gateOpen()) return { candidates: candidates.length, resumed: 0, failed: 0, skipped: 'gate_closed' };
  let resumed = 0;
  let failed = 0;
  for (const { assessment_id: assessmentId } of candidates) {
    try {
      const result = await deliver({ assessmentId }, { knex, staleAfterMs });
      if (!result.skipped) resumed += 1;
    } catch (err) {
      failed += 1;
      logger.error('[lawn-visit-delivery] recovery failed', { assessmentId, code: err?.code || 'DELIVERY_FAILED' });
    }
  }
  return { candidates: candidates.length, resumed, failed };
}

// Request recovery follows persisted runs, including after the feature is
// turned off. Its registration is independent of the cron master gate.
function scheduleRecovery(cron, { sweep = sweepAbandonedDeliveries } = {}) {
  return cron.schedule('*/10 * * * *', async () => {
    try {
      const result = await sweep();
      if (result.skipped) logger.warn('[lawn-visit-delivery] recovery sweep skipped', result);
      else if (result.candidates) logger.info('[lawn-visit-delivery] recovery sweep', result);
    } catch (err) {
      logger.error('[lawn-visit-delivery] recovery sweep failed', { code: err?.code || 'DELIVERY_FAILED' });
    }
  }, { timezone: 'America/New_York' });
}

module.exports = { deliverConfirmedAssessment, sweepAbandonedDeliveries, scheduleRecovery, RECOVERY_RETRY_HORIZON_MS, WEATHER_WINDOW_MS };
