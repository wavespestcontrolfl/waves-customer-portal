/** Resume confirmed visit delivery from its immutable comparison and step stamps. */
const db = require('../models/db');
const logger = require('./logger');
const runs = require('./lawn-visit-runs');

// Weather is fetched as CURRENT conditions, so it stands in for the visit's own
// only while the CAPTURE is recent. Past this, a run recovered late leaves the
// snapshot unset rather than recording recovery-day weather as the visit's.
const WEATHER_WINDOW_MS = 6 * 60 * 60 * 1000;
// Shorter than the seal's own TTL, so a lapse is noticed while a step still runs.
const SEAL_RENEW_MS = 45000;

function validHeartbeat(heartbeatMs, staleAfterMs) {
  const beat = heartbeatMs ?? 30000;
  if (!Number.isSafeInteger(beat) || beat < 1 || beat >= staleAfterMs) throw new TypeError('Delivery heartbeat must be shorter than its lease');
  return beat;
}

// The same seal/renew/release boundary the service-report delivery queue takes
// around its send: seal the stored copy at the version this run is about to
// render, renew while the steps run, release when they settle.
function resolveDeps(deps) {
  return {
    knex: deps.knex || db,
    LawnIntel: deps.LawnIntel || require('./lawn-intelligence'),
    KnowledgeBridge: deps.KnowledgeBridge || require('./knowledge-bridge'),
    staleAfterMs: deps.staleAfterMs ?? runs.PIPELINE_STALE_MS,
    weatherWindowMs: deps.weatherWindowMs ?? WEATHER_WINDOW_MS,
  };
}

function weatherOwed(assessment, windowMs, assessmentId) {
  if (assessment?.fawn_snapshot) return false;
  if (nearTheVisit(assessment, windowMs)) return true;
  // A fetch is current conditions, not the visit's. Recorded days later it would
  // be wrong rather than missing, and reports and outcome analysis read it as the
  // visit's weather — so leave it unset and say so.
  logger.warn('[lawn-visit-delivery] weather not attached', { assessmentId, reason: 'visit_too_old' });
  return false;
}

async function sealRefused(seal, needsSeal) {
  if (!needsSeal) return false;
  return !(await seal.ensure());
}

function sendSeal(KnowledgeBridge, knex, assessmentId, renewMs = SEAL_RENEW_MS, owner = null) {
  const versionOf = (row) => (row ? JSON.stringify([row.recommendations, row.ai_summary, row.updated_at]) : null);
  let timer = null;
  let taken = false;
  let lost = false;
  return {
    async ensure() {
      // A seal lost mid-run cannot be re-taken here: an earlier step may already
      // have rendered the copy that lapsed. The run defers and starts clean.
      if (lost) return false;
      if (taken) return true;
      if (typeof KnowledgeBridge.sealRecommendationsForSend !== 'function') return true;
      const row = await knex('lawn_assessments').where({ id: assessmentId }).first('recommendations', 'ai_summary', 'updated_at');
      taken = await KnowledgeBridge.sealRecommendationsForSend(assessmentId, versionOf(row), versionOf, owner);
      if (!taken) return false;
      // A slow step must not outlive a fixed TTL.
      timer = setInterval(() => {
        void KnowledgeBridge.renewRecommendationSendSeal(assessmentId, owner)
          .then((renewed) => { if (!renewed) lost = true; })
          .catch((err) => {
            // Unverifiable is lost: a generator may already hold the copy.
            lost = true;
            logger.warn('[lawn-visit-delivery] send-seal renew failed', { assessmentId, message: err.message });
          });
      }, renewMs);
      timer.unref?.();
      return true;
    },
    // Checked immediately before the customer dispatch, like the lease.
    async assertHeld() {
      const renewalStartedAt = Date.now();
      if (taken && !lost) {
        lost = !(await KnowledgeBridge.renewRecommendationSendSeal(assessmentId, owner).catch(() => false));
      }
      if (!taken || lost) throw Object.assign(new Error('Lawn delivery copy seal lost'), { code: 'LAWN_COPY_SEAL_LOST', retryable: true });
      return renewalStartedAt + KnowledgeBridge.SEND_SEAL_MS;
    },
    async release() {
      if (timer) { clearInterval(timer); timer = null; }
      if (!taken || typeof KnowledgeBridge.releaseRecommendationSendSeal !== 'function') return;
      taken = false;
      await KnowledgeBridge.releaseRecommendationSendSeal(assessmentId, owner)
        .catch((err) => logger.warn('[lawn-visit-delivery] send-seal release failed, expires by TTL', { assessmentId, message: err.message }));
    },
  };
}

async function generationInFlight(KnowledgeBridge, assessmentId, knex) {
  const guard = KnowledgeBridge && KnowledgeBridge.treatmentGuard;
  if (!guard || typeof guard.isGenerationInFlight !== 'function') return false;
  return guard.isGenerationInFlight(assessmentId, knex);
}

function nearTheVisit(assessment, windowMs) {
  // Anchored to CAPTURE, not confirmation: an assessment taken during the visit
  // and confirmed the next day would otherwise pass this check and take on the
  // confirming day's conditions as the visit's.
  const capturedAt = new Date(assessment?.created_at ?? assessment?.confirmed_at ?? NaN).getTime();
  if (!Number.isFinite(capturedAt)) return false;
  return Date.now() - capturedAt <= windowMs;
}

const ownershipLost = () => Object.assign(new Error('Lawn delivery ownership lost'), { code: 'LAWN_DELIVERY_OWNERSHIP_LOST', retryable: true });
const stepIncomplete = (step) => Object.assign(new Error(`Lawn delivery step incomplete: ${step}`), { code: 'LAWN_DELIVERY_STEP_INCOMPLETE' });

async function deliverConfirmedAssessment({ assessmentId, scheduledSmsLogId }, deps = {}) {
  const { knex, LawnIntel, KnowledgeBridge, staleAfterMs, weatherWindowMs } = resolveDeps(deps);
  const heartbeatMs = validHeartbeat(deps.heartbeatMs, staleAfterMs);
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
  let seal = null;
  let notificationResult = null;
  try {
    await guard();
    // Weather may legitimately be unavailable. It is an enrichment, while the
    // steps below require their own durable proof before proceeding. The stored
    // snapshot is the VISIT's conditions and feeds later reports and outcome
    // analysis, so a recovery hours or days later must not overwrite it with
    // recovery-time weather — it is attached once, not refreshed per attempt.
    const attachWeatherOnce = async (assessment) => {
      if (!weatherOwed(assessment, weatherWindowMs, assessmentId)) return null;
      const weather = await LawnIntel.attachWeather(assessmentId);
      await guard(); // The lease covers every effect in the pipeline, this one included.
      return weather;
    };
    // Knowledge Bridge's durable fence owns whether stored recommendations are
    // settled. While a generation is in flight the stored copy can still be
    // replaced, so this run waits for the next sweep instead of delivering, and
    // instead of starting a second generation.
    if (await generationInFlight(KnowledgeBridge, assessmentId, knex)) {
      await runs.deferPipeline(assessmentId, owner, knex, { staleAfterMs });
      return { skipped: 'generation_in_flight', done: [], gaps: [] };
    }
    await attachWeatherOnce((await runs.deliveryState(assessmentId, knex)).assessment);
    // Scoped to this worker's lease, so a concurrent report delivery's seal is
    // never renewed or released by this run, nor this run's by it.
    seal = sendSeal(KnowledgeBridge, knex, assessmentId, deps.sealRenewMs ?? SEAL_RENEW_MS, `lawn-recovery:${owner}`);
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
      // Both of these put the stored copy in front of the customer, so they run
      // inside Knowledge Bridge's send seal (the true 'needsSeal' below).
      ['report', () => LawnIntel.generateServiceReport(assessmentId), true],
      ['notification', async () => { notificationResult = await LawnIntel.sendAssessmentNotification(assessmentId, {
        // The lease says this worker still owns the run; the seal says the copy
        // it is about to read is still the copy it sealed.
        beforeSend: async () => {
          const renewalStartedAt = Date.now();
          await guard();
          const sealDeadline = await seal.assertHeld();
          return { validUntil: Math.min(renewalStartedAt + staleAfterMs, sealDeadline) };
        },
        ...(scheduledSmsLogId ? { scheduledSmsLogId } : {}),
      }); }, true],
    ];
    for (const [step, action, needsSeal] of actions) {
      const state = await runs.deliveryState(assessmentId, knex);
      if (!state.gaps.includes(step)) continue;
      await guard();
      // The preflight fence read cannot cover a regeneration that starts after
      // it, so the steps that render copy take the same atomic seal the report
      // delivery queue uses. Unsealable copy defers the rest to a later sweep
      // rather than sending a version a generator can still replace.
      if (await sealRefused(seal, needsSeal)) {
        await runs.deferPipeline(assessmentId, owner, knex, { staleAfterMs });
        return { skipped: 'copy_unsettled', done, gaps: state.gaps };
      }
      await action(state);
      await guard();
      if (step === 'notification' && (notificationResult?.notificationQueued || scheduledSmsLogId)
        && !notificationResult?.sent && (notificationResult?.deliveryOutcome || 'not_sent') === 'not_sent') {
        await runs.deferPipeline(assessmentId, owner, knex, { staleAfterMs });
        return { done, gaps: (await runs.deliveryState(assessmentId, knex)).gaps, notificationResult };
      }
      if ((await runs.deliveryState(assessmentId, knex)).gaps.includes(step)) throw stepIncomplete(step);
      done.push(step);
    }
    await guard();
    const { assessment, notificationUnsettled, calibrationEvidenceLost } = await runs.deliveryState(assessmentId, knex);
    // The comparison is gone for good; the visit's other delivery is not.
    if (calibrationEvidenceLost) logger.warn('[lawn-visit-delivery] completing without a confirmation snapshot', { assessmentId });
    // Completing over an unsettled claim is the one outcome nobody can verify:
    // name the assessment so a person can check the messaging audit for it.
    if (notificationUnsettled) logger.warn('[lawn-visit-delivery] completing with an unsettled notification claim', { assessmentId });
    const tracked = await LawnIntel.trackAssessmentCompletion(assessment.service_date);
    if (tracked?.error) throw stepIncomplete('tracking');
    const completed = await runs.completePipeline(assessmentId, owner, knex, { staleAfterMs });
    if (!completed.owned) throw ownershipLost();
    if (completed.gaps.length) throw stepIncomplete('completion');
    return { done, gaps: [], ...(notificationResult ? { notificationResult } : {}) };
  } catch (err) {
    if (notificationResult) err.notificationResult = notificationResult;
    throw err;
  } finally {
    clearInterval(timer);
    if (renewing) await renewing;
    if (seal) await seal.release();
  }
}

// The scheduled-SMS executor owns timing/retries; this entry owns only the
// assessment send and its normal lease/seal. Never fall back to a frozen body.
async function replayDeferredNotification(meta, deps = {}) {
  const knex = deps.knex || db;
  const staleAfterMs = deps.staleAfterMs ?? runs.PIPELINE_STALE_MS;
  const loadSnapshot = () => knex('lawn_assessments as assessment')
    .leftJoin('lawn_assessment_runs as run', 'run.assessment_id', 'assessment.id')
    .where('assessment.id', meta.assessment_id)
    .first(
      'assessment.id as assessment_id', 'assessment.customer_id', 'assessment.confirmed_by_tech',
      'assessment.service_id', 'assessment.notification_sent', 'run.id as run_id',
      'run.pipeline_owner_token', 'run.pipeline_claimed_at',
      knex.raw(`COALESCE(
        run.pipeline_owner_token IS NOT NULL
        AND run.pipeline_completed_at IS NULL
        AND run.pipeline_claimed_at >= clock_timestamp() - (? * interval '1 millisecond'),
        false
      ) AS pipeline_live`, [staleAfterMs]),
      knex.raw('clock_timestamp() AS database_now'),
    );
  const snapshot = await loadSnapshot();
  const blocked = (code) => ({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code });
  const busy = (state) => {
    const base = state?.pipeline_live ? state.pipeline_claimed_at : (state?.database_now ?? new Date());
    const retryAt = new Date(base).getTime() + staleAfterMs;
    return {
      ...blocked('LAWN_NOTIFICATION_BUSY'), retryable: true, deferred: true,
      ...(Number.isFinite(retryAt) ? { nextAllowedAt: new Date(retryAt).toISOString() } : {}),
    };
  };
  if (!snapshot?.confirmed_by_tech || snapshot.service_id
    || String(snapshot.customer_id) !== String(meta.customer_id)
    || !snapshot.run_id || String(snapshot.run_id) !== String(meta.run_id) || !meta.scheduled_sms_log_id) {
    return blocked('LAWN_NOTIFICATION_UNAVAILABLE');
  }
  // A live pipeline may have claimed the assessment while this SAME scheduled
  // row was already sending. Its quiet-hours deferral dedupes against that row
  // and then releases the assessment claim, so the scheduler must wait for the
  // live owner instead of terminally consuming its own obligation. The DB-clock
  // ownership check distinguishes that race from an accepted or abandoned
  // claim, which remains uncertain and must never be resent.
  if (snapshot.notification_sent) {
    if (snapshot.pipeline_live) return busy(snapshot);
    return { ...blocked('LAWN_NOTIFICATION_ALREADY_CLAIMED'), deliveryOutcome: 'uncertain' };
  }
  let notification;
  try {
    const result = await deliverConfirmedAssessment({
      assessmentId: snapshot.assessment_id, scheduledSmsLogId: meta.scheduled_sms_log_id,
    }, deps);
    notification = result.notificationResult;
    // Losing the claim proves this replay performed no delivery work. Return a
    // refunded scheduler hold even if the winner has already handed ownership
    // back; the next joined snapshot will decide whether the send was accepted,
    // remains owned, or is owed again.
    if (!notification && result.skipped === 'not_claimed') return busy(await loadSnapshot());
    if (!notification) return { ...blocked('LAWN_NOTIFICATION_BUSY'), retryable: true };
  } catch (err) {
    notification = err.notificationResult;
    if (!notification) return { ...blocked(err.code || 'LAWN_NOTIFICATION_RETRY'), retryable: true };
  }
  const outcome = notification.deliveryOutcome;
  // Scheduler retries must not reinterpret an ambiguous SDK handoff as a
  // non-send. Its existing terminal rail retains the assessment's send claim.
  if (outcome === 'uncertain') {
    return { ...blocked('LAWN_NOTIFICATION_UNCERTAIN'), deliveryOutcome: 'uncertain' };
  }
  if (notification.sent || outcome === 'accepted') {
    return { ...notification.smsResult, sent: true, deliveryOutcome: 'accepted' };
  }
  return notification.smsResult || blocked('LAWN_NOTIFICATION_SUPPRESSED');
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
      // Never-attempted runs first, then least-recently-attempted. Ordering by
      // confirmation time alone let a pool of permanently failing runs refill
      // every batch as their leases expired, starving both fresh deliveries and
      // newer transient failures until the horizon dropped the poison rows.
      .orderByRaw('(run.pipeline_claimed_at IS NOT NULL), run.pipeline_claimed_at ASC, assessment.confirmed_at ASC')
      .limit(limit).select('run.assessment_id');
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

module.exports = { deliverConfirmedAssessment, replayDeferredNotification, sweepAbandonedDeliveries, scheduleRecovery, RECOVERY_RETRY_HORIZON_MS, WEATHER_WINDOW_MS };
