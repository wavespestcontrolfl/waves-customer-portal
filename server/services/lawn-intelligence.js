/**
 * Lawn Intelligence Service
 *
 * Assessment-time helpers for the lawn intelligence pipeline:
 * - FAWN weather context on every assessment
 * - Photo quality gating
 * - Assessment notification dispatch (manual re-send/backfill only)
 * - Lawn health → customer health bridge
 * - Assessment completion rate tracking
 * - Tech calibration scoring
 * - Baseline photo re-capture protocol
 * - Auto-generate service reports
 *
 * The efficacy/protocol/benchmark/contradiction aggregations live in
 * assessment-analytics.js (weekly Sunday 4AM cron) — the duplicate copies
 * that used to sit here were unreachable and were removed 2026-08-13.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');
const { etDateString } = require('../utils/datetime-et');
const { renderRequiredSmsTemplate } = require('./sms-template-renderer');

// Structured-output contract for the photo-quality gate (llm/call.js
// jsonSchema). The weighted score and the usable flag decide the verdict.
const PHOTO_QUALITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sharpness', 'lawn_coverage_pct', 'lighting', 'issues', 'usable'],
  properties: {
    sharpness: { type: 'integer', description: '0-100' },
    lawn_coverage_pct: { type: 'integer', description: '0-100, what percent of the image is lawn' },
    lighting: { type: 'integer', description: '0-100' },
    issues: {
      type: 'array',
      items: { type: 'string', enum: ['blurry', 'too_dark', 'too_bright', 'shadow_heavy', 'feet_visible', 'not_lawn', 'too_far', 'too_close'] },
    },
    usable: { type: 'boolean' },
  },
};

function assessmentAnalytics() {
  return require('./assessment-analytics');
}

// ══════════════════════════════════════════════════════════════
// 1. FAWN WEATHER CONTEXT
// ══════════════════════════════════════════════════════════════

async function fetchFawnWeather() {
  // Delegate to the canonical FAWN service (cached, station-selected, and
  // null-safe). The previous local fetcher coerced missing readings to 0 via
  // `parseFloat(x || 0)`, which persisted 0°F / 0in into lawn_assessments and
  // polluted downstream efficacy/seasonal aggregation. getCurrent() uses
  // numberOrNull, so absent fields stay null.
  const FawnWeather = require('./fawn-weather');
  const snapshot = await FawnWeather.getCurrent();
  if (!snapshot || snapshot.station === 'unavailable') return null;
  return {
    temp_f: snapshot.temp_f,
    humidity_pct: snapshot.humidity_pct,
    rainfall_in: snapshot.rainfall_in,
    soil_temp_f: snapshot.soil_temp_f,
    station: snapshot.station,
    timestamp: snapshot.timestamp,
    // The STATION's authoritative reading time — without it the persisted
    // snapshot can only be aged by fetch time, and an old last-observation
    // row (stale station) would stamp stale measurements into a treatment
    // outcome as if fresh.
    observation_time: snapshot.observation_time ?? null,
  };
}

// ══════════════════════════════════════════════════════════════
// 2. PHOTO QUALITY ASSESSMENT
// ══════════════════════════════════════════════════════════════

async function assessPhotoQuality(base64Image, mimeType) {
  try {
    // VISION first, OpenAI Terra on a miss. A two-leg miss fails open below,
    // exactly as an SDK error did.
    const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.visionAnalysis, {
      text: 'Evaluate this lawn photo for quality: sharpness (0-100), what percent of the image is lawn (0-100), lighting (0-100), any issues from the allowed list, and whether the photo is usable.',
      images: [{ data: base64Image, mimeType }],
      jsonMode: true,
      jsonSchema: PHOTO_QUALITY_SCHEMA,
      maxTokens: 300,
    });
    if (!res.ok || !res.json) throw new Error(res.reason || 'no_json');
    const result = res.json;
    const score = Math.round((result.sharpness * 0.4 + result.lawn_coverage_pct * 0.35 + result.lighting * 0.25));
    return {
      passed: result.usable !== false && score >= 35,
      score,
      sharpness: result.sharpness,
      coverage_pct: result.lawn_coverage_pct,
      lighting: result.lighting,
      issues: result.issues || [],
    };
  } catch (err) {
    logger.error(`[lawn-intel] Photo quality check failed: ${err.message}`);
    return { passed: true, score: 50, issues: [] }; // fail open
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN SERVICE
// ══════════════════════════════════════════════════════════════

// Only the columns this database actually has; null when none of them match.
async function reportInsertData(reportData) {
  const reportCols = await db('service_reports').columnInfo().catch(() => ({}));
  const insertData = Object.fromEntries(Object.entries(reportData).filter(([key]) => reportCols[key]));
  return Object.keys(insertData).length > 0 ? insertData : null;
}

// One customer text per assessment: claimed before the wire, released only when
// the dispatcher delivered nothing at all. Rows predating the column read null.
// The claim and the outcome are separate marks, so the row always says which
// state it is in: notification_sent with a NULL notification_sent_at is a claim
// still in flight, a timestamp is a settled send (delivered, accepted, or an
// ambiguous handoff that must never be retried), and false is owed. A release
// that cannot be written therefore leaves an in-flight claim, not delivery
// evidence, and callers can tell the difference.
async function claimNotificationSend(assessmentId) {
  return db('lawn_assessments').where({ id: assessmentId })
    .where((q) => q.whereNull('notification_sent').orWhere('notification_sent', false))
    .update({ notification_sent: true, notification_sent_at: null });
}

// A pre-dispatch throw, or a handed-off result that neither delivered nor
// created a durable queue obligation and explicitly proves not_sent, frees the
// claim. sent:true includes dispatcher-owned scheduled delivery.
async function releaseUnhandedClaim(assessmentId, claimed, handedOff, result) {
  if (!claimed || (handedOff && (result?.sent || result?.deliveryOutcome !== 'not_sent'))) return;
  await releaseNotificationSend(assessmentId, null);
}

async function settleNotificationSend(assessmentId) {
  await db('lawn_assessments').where({ id: assessmentId }).update({ notification_sent_at: new Date() });
}

// Only a definite non-delivery frees the claim.
async function resolveUnsentClaim(assessmentId, result) {
  const outcome = result?.deliveryOutcome || 'not_sent';
  if (outcome !== 'not_sent') {
    logger.warn(`[lawn-intel] assessment ${assessmentId}: notification outcome ${outcome}; claim settled, never re-sent`);
    await settleNotificationSend(assessmentId);
    return;
  }
  await releaseNotificationSend(assessmentId, result);
}

async function releaseNotificationSend(assessmentId, result) {
  logger.warn(`[lawn-intel] assessment ${assessmentId}: no notification channel delivered (${JSON.stringify(result?.results || {})}); released for re-send`);
  await db('lawn_assessments').where({ id: assessmentId }).update({ notification_sent: false, notification_sent_at: null });
}

// The normal scheduled-SMS rail owns an after-hours retry even when the lawn
// recovery sweep is off. Persist identity, never a body that can outlive its
// copy seal. The registry dispatch reacquires ownership and renders on replay.
async function deferAssessmentNotification(assessment, customer, nextAllowedAt) {
  return db.transaction(async (trx) => {
    const current = await trx('lawn_assessments').where({ id: assessment.id }).forUpdate().first();
    if (!current?.notification_sent || current.notification_sent_at) return false;
    const run = await trx('lawn_assessment_runs').where({ assessment_id: assessment.id }).first('id');
    if (!run) throw new Error('Deferred lawn notification requires its stored run');
    const existing = await trx('sms_log').where({ customer_id: customer.id })
      .whereIn('status', ['scheduled', 'sending'])
      .whereRaw("metadata->>'entry_point' = ? AND metadata->>'assessment_id' = ?",
        ['lawn_assessment_notification_deferred', String(assessment.id)]).first('id');
    if (!existing) await trx('sms_log').insert({
      customer_id: customer.id,
      direction: 'outbound',
      from_phone: require('../config/twilio-numbers').getOutboundNumber(),
      to_phone: customer.phone,
      message_body: '',
      status: 'scheduled',
      scheduled_for: new Date(nextAllowedAt),
      message_type: 'service_complete',
      metadata: JSON.stringify({
        entry_point: 'lawn_assessment_notification_deferred',
        requires_registered_dispatch: true,
        assessment_id: assessment.id,
        run_id: run.id,
        customer_id: customer.id,
        replay_purpose: 'appointment',
        refresh_customer_phone: true,
      }),
    });
    // Obligation creation and proven-unsent claim release must commit together.
    await trx('lawn_assessments').where({ id: assessment.id })
      .update({ notification_sent: false, notification_sent_at: null });
    return true;
  });
}

// Delivery recovery's own preconditions — the lease and the copy seal — must
// reach the caller rather than the send-failure log, and must not release a
// claim: they say the send should not happen now, not that it failed.
const DELIVERY_CONTROL_CODES = new Set(['LAWN_DELIVERY_OWNERSHIP_LOST', 'LAWN_COPY_SEAL_LOST']);
const isOwnershipLoss = (err) => DELIVERY_CONTROL_CODES.has(err?.code);
async function runBeforeSend(options) {
  if (options?.beforeSend) return options.beforeSend();
}

const LawnIntelligence = {

  fetchFawnWeather,
  assessPhotoQuality,

  // ── Attach FAWN weather to an assessment ────────────────────
  async attachWeather(assessmentId) {
    const weather = await fetchFawnWeather();
    if (!weather) return null;
    await db('lawn_assessments').where({ id: assessmentId }).update({
      fawn_temp_f: weather.temp_f,
      fawn_humidity_pct: weather.humidity_pct,
      fawn_rainfall_7d: weather.rainfall_in,
      fawn_soil_temp_f: weather.soil_temp_f,
      fawn_station: weather.station,
      fawn_snapshot: JSON.stringify(weather),
    });
    return weather;
  },

  // ── 7. Assessment score parts (shared) ──────────────────────
  // Overall score + delta vs the previous confirmed assessment + customer tip.
  // Shared by the completion-time report SMS (score folded into the single
  // service-report text) and the legacy standalone notification below.
  async computeAssessmentScoreParts(assessment) {
    if (!assessment) return null;
    const scoreOf = (a) => a.overall_score || Math.round(
      (a.turf_density + a.weed_suppression + a.fungus_control +
        (a.color_health || 0) + (a.thatch_level || 0)) / 5
    );
    // Get previous assessment for delta
    const propertyHistoryEnabled = require('../config/feature-gates').gateEnvValue('GATE_LAWN_PROPERTY_HISTORY');
    const scopedHistory = propertyHistoryEnabled ? await require('./lawn-assessment-history').historyForAssessment(assessment, { knex: db }) : null;
    if (propertyHistoryEnabled) {
      if (!scopedHistory.current) return null;
      assessment = scopedHistory.current;
    }
    const overall = propertyHistoryEnabled ? scopedHistory.progress.score : scoreOf(assessment);
    const previous = propertyHistoryEnabled ? scopedHistory.previous : await db('lawn_assessments')
      .where({ customer_id: assessment.customer_id, confirmed_by_tech: true })
      .where('service_date', '<', assessment.service_date)
      .orderBy('service_date', 'desc')
      .first();
    const delta = propertyHistoryEnabled ? scopedHistory.progress.previousDelta : previous ? overall - scoreOf(previous) : null;

    // Parse recommendations for customer tip
    let tip = '';
    try {
      const recs = typeof assessment.recommendations === 'string'
        ? JSON.parse(assessment.recommendations) : assessment.recommendations;
      tip = recs?.customerTip ? String(recs.customerTip).trim() : '';
    } catch {}

    const deltaStr = delta != null && delta !== 0
      ? `, ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} from last visit` : '';
    return { overall, delta, deltaStr, tip };
  },

  // ── 7b. Assessment notification (legacy standalone) ─────────
  // SUPERSEDED, twice over: the lawn score was folded into the single
  // completion service-report SMS, and that fold-in was itself retired
  // 2026-08-01 (owner ruling — the completion text is a short link to the
  // report; the score lives ON the report). Still sent for STANDALONE
  // assessments only (service_id null — no completion text ever follows), by
  // the confirm route and by delivery recovery (lawn-visit-delivery.js); never
  // for a service-linked assessment. options.beforeSend runs right before the
  // claim and at the provider handoff; recovery passes its lease/copy check
  // so provider preparation cannot outlive ownership and still send.
  async sendAssessmentNotification(assessmentId, options) {
    let claimed = false;
    let handedOff = false;
    let dispatchResult = null;
    try {
      const assessment = await db('lawn_assessments').where({ id: assessmentId, confirmed_by_tech: true }).first();
      // service_id set → the visit's completion text carries the report link.
      if (!assessment || assessment.notification_sent || assessment.service_id) return null;

      const customer = await db('customers').where({ id: assessment.customer_id }).first();
      if (!customer) return null;

      const parts = await LawnIntelligence.computeAssessmentScoreParts(assessment);
      const overall = parts?.overall ?? 0;
      const deltaStr = parts?.deltaStr || '';
      const tip = parts?.tip ? `\nTip: ${parts.tip}` : '';

      const smsMessage = await renderRequiredSmsTemplate('lawn_health_report_ready', {
        first_name: customer.first_name || 'there',
        overall_score: String(overall),
        delta_line: deltaStr,
        tip_line: tip,
        portal_url: 'portal.wavespestcontrol.com',
      }, {
        workflow: 'lawn_health_report_ready',
        entity_type: 'lawn_assessment',
        entity_id: assessment.id,
      });

      await runBeforeSend(options);
      // Claim the send BEFORE it reaches the wire. A process exit between the
      // dispatcher accepting and the stamp committing used to leave the run
      // looking unsent, and delivery recovery would text the customer a second
      // time. At-most-once is the right side to fail on here: the report is in
      // the portal either way, and a duplicate text is not retractable.
      if (!(await claimNotificationSend(assessmentId))) return null;
      claimed = true;
      const NotificationDispatcher = require('./notification-dispatcher');
      const result = await NotificationDispatcher.notify(customer.id, 'service_complete', {
        smsMessage,
        emailSubject: `Your Lawn Health Report — Score: ${overall}/100`,
        emailBody: smsMessage,
        ...(typeof options?.beforeSend === 'function' ? {
          preSendCheck: async () => {
            const authority = await runBeforeSend(options);
            return { ...authority, ok: true };
          },
        } : {}),
        ...(options?.scheduledSmsLogId ? { scheduledSmsLogId: options.scheduledSmsLogId } : {}),
      });
      // Past this line the dispatcher has run, so a later throw — a failed
      // settle write, say — says nothing about whether a text went out. Only a
      // throw BEFORE this point is a definite non-delivery.
      handedOff = true;
      dispatchResult = result;

      if (typeof options?.beforeSend === 'function' && !options?.scheduledSmsLogId
        && result?.deliveryOutcome === 'not_sent' && result.smsResult?.code === 'QUIET_HOURS_HOLD'
        && result.smsResult.deferred && result.smsResult.nextAllowedAt) {
        const queued = await deferAssessmentNotification(assessment, customer, result.smsResult.nextAllowedAt);
        if (queued) return { ...result, notificationQueued: true, deferred: true, nextAllowedAt: result.smsResult.nextAllowedAt };
      }

      if (result?.sent) await settleNotificationSend(assessmentId);
      // Nothing delivered (email-preferring customer, blocked SMS) is not a
      // send: release the claim so the miss stays visible and re-sendable
      // rather than being permanently recorded as "notified". An accepted or
      // UNCERTAIN handoff keeps its claim — the carrier may already have the
      // text, and recovery must not send a second one to find out.
      if (!result?.sent) await resolveUnsentClaim(assessmentId, result);

      return result;
    } catch (err) {
      if (isOwnershipLoss(err)) throw err;
      // Preserve delivered, durably queued, accepted, or uncertain evidence.
      // Release only a proven-unsent result that transferred no delivery
      // ownership; otherwise recovery could either strand work or send twice.
      await releaseUnhandedClaim(assessmentId, claimed, handedOff, dispatchResult);
      logger.error(`[lawn-intel] sendAssessmentNotification failed: ${err.message}`);
      // A replay must retain provider evidence even when its local settlement
      // write fails. Its queue row can settle without sending a second copy.
      if (options?.scheduledSmsLogId && handedOff) return dispatchResult;
      return null;
    }
  },

  // ── Get customer's percentile in their neighborhood ─────────
  async getCustomerPercentile(customerId) {
    try {
      return await assessmentAnalytics().getCustomerBenchmark(customerId);
    } catch (err) {
      logger.error(`[lawn-intel] getCustomerPercentile failed: ${err.message}`);
      return null;
    }
  },

  // ── 10. Lawn health → customer health bridge ────────────────
  async emitHealthSignal(customerId, { knex = db, strict = false } = {}) {
    let result = null;
    try {
      const propertyHistoryEnabled = require('../config/feature-gates').gateEnvValue('GATE_LAWN_PROPERTY_HISTORY');
      const assessments = propertyHistoryEnabled
        ? (await require('./lawn-assessment-history').latestForCustomer(customerId, { limit: 4 }, knex)).reverse()
        : await knex('lawn_assessments')
        .where({ customer_id: customerId, confirmed_by_tech: true })
        .orderBy('service_date', 'desc')
        .limit(4);

      if (assessments.length < 2) return strict ? { skipped: 'insufficient_history' } : null;

      const calcOverall = (a) => a.overall_score || Math.round(
        (a.turf_density + a.weed_suppression + a.fungus_control + (a.color_health || 0) + (a.thatch_level || 0)) / 5
      );

      const scores = assessments.map(calcOverall);
      const latest = scores[0];
      const trend = scores.length >= 3 ? scores.slice(0, 3) : scores;
      const declining = trend.every((s, i) => i === 0 || s <= trend[i - 1]) && (trend[0] - trend[trend.length - 1]) > 5;
      const improving = trend.every((s, i) => i === 0 || s >= trend[i - 1]) && (trend[0] - trend[trend.length - 1]) > 10;

      result = { declining, improving, latest, trend };

      // Legacy callers retain the computed trend when signal persistence fails.
      if (declining) {
        const existing = await knex('customer_signals')
          .where({ customer_id: customerId, signal_type: 'LAWN_SCORE_DECLINING', resolved: false })
          .first();
        if (!existing) {
          await knex('customer_signals').insert({
            customer_id: customerId,
            signal_type: 'LAWN_SCORE_DECLINING',
            signal_value: JSON.stringify({ scores: trend, delta: trend[0] - trend[trend.length - 1] }),
            severity: trend[0] - trend[trend.length - 1] > 15 ? 'warning' : 'info',
            detected_at: new Date(),
          });
        }
      }

      if (improving && latest >= 75) {
        const existing = await knex('customer_signals')
          .where({ customer_id: customerId, signal_type: 'LAWN_TRANSFORMATION', resolved: false })
          .first();
        if (!existing) {
          await knex('customer_signals').insert({
            customer_id: customerId,
            signal_type: 'LAWN_TRANSFORMATION',
            signal_value: JSON.stringify({ scores: trend, latest }),
            severity: 'info',
            detected_at: new Date(),
          });
        }
      }

      // Resolve stale signals
      if (!declining) {
        await knex('customer_signals')
          .where({ customer_id: customerId, signal_type: 'LAWN_SCORE_DECLINING', resolved: false })
          .update({ resolved: true, resolved_at: new Date() });
      }
      return result;
    } catch (err) {
      if (strict) throw err;
      logger.error(`[lawn-intel] emitHealthSignal failed: ${err.message}`);
      return result;
    }
  },

  // ── 11. Assessment completion tracking ──────────────────────
  async trackAssessmentCompletion(date) {
    const trackingDate = date || etDateString();
    try {
      return await assessmentAnalytics().computeCompletionRates(trackingDate, trackingDate);
    } catch (err) {
      logger.error(`[lawn-intel] trackAssessmentCompletion failed: ${err.message}`);
      return { error: err.message };
    }
  },

  // ── 12. Tech calibration scoring ────────────────────────────
  async recordTechCalibration(assessmentId, aiScores, techScores, { knex = db, strict = false, technicianId } = {}) {
    try {
      const assessment = await knex('lawn_assessments').where({ id: assessmentId }).first();
      const techId = technicianId || assessment?.technician_id;
      if (!assessment || !techId) return strict ? { skipped: 'no_technician' } : null;

      // stress_damage is the consolidated score the tech actually corrects on the
      // completion screen now (fungus/thatch are AI-only and unchanged), so it must
      // be part of the calibration delta/bias — otherwise a real Stress correction
      // reads as zero delta.
      const fields = ['turf_density', 'weed_suppression', 'color_health', 'fungus_control', 'thatch_level', 'stress_damage'];
      const deltas = [];
      const row = { assessment_id: assessmentId, technician_id: techId };
      let higher = 0, lower = 0;

      for (const f of fields) {
        row[`ai_${f}`] = aiScores[f] ?? null;
        row[`tech_${f}`] = techScores[f] ?? null;
        if (aiScores[f] == null || techScores[f] == null) continue;
        const delta = techScores[f] - aiScores[f];
        deltas.push(Math.abs(delta));
        higher += Number(delta > 0);
        lower += Number(delta < 0);
      }

      row.avg_delta = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length * 10) / 10 : 0;
      row.bias_direction = higher > lower ? 'higher' : lower > higher ? 'lower' : 'mixed';

      await knex('tech_calibration').insert(row);
      return row;
    } catch (err) {
      if (strict) throw err;
      logger.error(`[lawn-intel] recordTechCalibration failed: ${err.message}`);
      return null;
    }
  },

  // ── 15. Auto-generate service report ────────────────────────
  async generateServiceReport(assessmentId) {
    try {
      const assessment = await db('lawn_assessments').where({ id: assessmentId }).first();
      const assessmentCols = await db('lawn_assessments').columnInfo().catch(() => ({}));
      if (!assessment || (assessmentCols.report_auto_generated && assessment.report_auto_generated)) return null;

      const customer = await db('customers').where({ id: assessment.customer_id }).first();
      if (!customer) return null;

      // Get best photo
      const bestPhoto = await db('lawn_assessment_photos')
        .where({ assessment_id: assessmentId, is_best_photo: true })
        .first();

      // Build report data
      const reportData = {
        customer_id: customer.id,
        service_date: assessment.service_date,
        service_type: 'Lawn Care',
        report_type: 'lawn_assessment',
        report_data: JSON.stringify({
          scores: {
            turf_density: assessment.turf_density,
            weed_suppression: assessment.weed_suppression,
            color_health: assessment.color_health,
            fungus_control: assessment.fungus_control,
            thatch_level: assessment.thatch_level,
            overall: assessment.overall_score,
          },
          observations: assessment.observations,
          ai_summary: assessment.ai_summary,
          recommendations: assessment.recommendations,
          season: assessment.season,
          weather: assessment.fawn_snapshot,
          photo_key: bestPhoto?.s3_key || null,
        }),
        status: 'generated',
        generated_at: new Date(),
      };

      // No service_reports table anywhere in this schema (none of the repo's
      // migrations create one) is the NORMAL case, not a lag: the assessment row
      // and Lawn Report V2 are the report. Withholding the marker there left the
      // delivery pipeline's report step owed forever, which blocked the standalone
      // notification behind it — so "nothing to insert" still completes the step.
      const reportsTable = await db.schema.hasTable('service_reports').catch(() => false);
      const insertData = reportsTable ? await reportInsertData(reportData) : null;
      // A table that exists but accepted no columns is a real migration lag: leave
      // the step owed so recovery retries once the schema catches up.
      if (reportsTable && !insertData) {
        logger.warn(`[lawn-intel] assessment ${assessmentId}: service_reports has no usable columns; report left owed`);
        return null;
      }
      // With no marker column nothing can record that this report exists, so the
      // recovery sweep would read the step as owed and insert a fresh row on
      // every pass. Skip the insert rather than pile rows up unrecorded.
      if (insertData && !assessmentCols.report_auto_generated && !assessmentCols.report_id) {
        logger.warn(`[lawn-intel] assessment ${assessmentId}: lawn_assessments has no report marker column; report generation skipped`);
        return null;
      }

      // One transaction. A process exit between the report row and its
      // assessment marker used to leave an unmarked report that delivery
      // recovery regenerated as a second row for the same assessment
      // (service_reports has no uniqueness constraint to catch it).
      const report = await db.transaction(async (trx) => {
        const row = insertData ? (await trx('service_reports').insert(insertData).returning('*'))[0] : null;
        const update = {};
        if (assessmentCols.report_auto_generated) update.report_auto_generated = true;
        if (row?.id && assessmentCols.report_id) update.report_id = row.id;
        if (assessmentCols.updated_at) update.updated_at = new Date();
        if (Object.keys(update).length > 0) await trx('lawn_assessments').where({ id: assessmentId }).update(update);
        return row;
      });

      return report || { ...reportData, skippedInsert: true };
    } catch (err) {
      logger.error(`[lawn-intel] generateServiceReport failed: ${err.message}`);
      return null;
    }
  },

  // ── 16. Baseline re-capture ─────────────────────────────────
  async flagBaselineRecapture(customerId, resetId) {
    try {
      // Flag next assessment for this customer
      await db('lawn_baseline_resets').where({ id: resetId }).update({ needs_photo_recapture: true });

      // Also flag the customer's future assessments
      const nextAssessment = await db('scheduled_services')
        .where({ customer_id: customerId })
        .where('scheduled_date', '>=', etDateString())
        .where('service_type', 'ilike', '%lawn%')
        .orderBy('scheduled_date', 'asc')
        .first();

      return { flagged: true, nextServiceDate: nextAssessment?.scheduled_date || null };
    } catch (err) {
      logger.error(`[lawn-intel] flagBaselineRecapture failed: ${err.message}`);
      return null;
    }
  },

};

module.exports = LawnIntelligence;
