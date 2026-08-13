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
const { anthropicCreateWithSamplingRetry } = require('./llm/call');
const logger = require('./logger');
const MODELS = require('../config/models');
const { etDateString } = require('../utils/datetime-et');
const { renderRequiredSmsTemplate } = require('./sms-template-renderer');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

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
  if (!Anthropic) return { passed: true, score: 50, issues: [] };
  try {
    const client = new Anthropic();
    const response = await anthropicCreateWithSamplingRetry(client, {
      model: MODELS.VISION,
      max_tokens: 300,
      temperature: 0.2, // pin output for repeatable pass/fail decisions on the same photo
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: `Evaluate this lawn photo for quality. Return ONLY JSON, no markdown:
{
  "sharpness": <0-100>,
  "lawn_coverage_pct": <0-100 what percent of the image is lawn>,
  "lighting": <0-100>,
  "issues": [<list of: "blurry", "too_dark", "too_bright", "shadow_heavy", "feet_visible", "not_lawn", "too_far", "too_close">],
  "usable": <true/false>
}` },
        ],
      }],
    });
    const text = response.content[0].text;
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
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
    const overall = scoreOf(assessment);

    // Get previous assessment for delta
    const previous = await db('lawn_assessments')
      .where({ customer_id: assessment.customer_id, confirmed_by_tech: true })
      .where('service_date', '<', assessment.service_date)
      .orderBy('service_date', 'desc')
      .first();
    const delta = previous ? overall - scoreOf(previous) : null;

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
  // report; the score lives ON the report). Retained for manual re-send /
  // backfill; not invoked from the confirm or completion pipelines.
  async sendAssessmentNotification(assessmentId) {
    try {
      const assessment = await db('lawn_assessments').where({ id: assessmentId, confirmed_by_tech: true }).first();
      if (!assessment || assessment.notification_sent) return null;

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

      const NotificationDispatcher = require('./notification-dispatcher');
      const result = await NotificationDispatcher.notify(customer.id, 'service_complete', {
        smsMessage,
        emailSubject: `Your Lawn Health Report — Score: ${overall}/100`,
        emailBody: smsMessage,
      });

      // Stamp only when a channel actually delivered — an unconditional
      // stamp recorded "notified" even when the dispatcher sent nothing
      // (email-preferring customers, blocked SMS), permanently hiding the
      // miss because the notification_sent guard above never retries.
      if (result?.sent) {
        await db('lawn_assessments').where({ id: assessmentId }).update({
          notification_sent: true,
          notification_sent_at: new Date(),
        });
      } else {
        logger.warn(`[lawn-intel] assessment ${assessmentId}: no notification channel delivered (${JSON.stringify(result?.results || {})}); left unstamped for re-send`);
      }

      return result;
    } catch (err) {
      logger.error(`[lawn-intel] sendAssessmentNotification failed: ${err.message}`);
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
  async emitHealthSignal(customerId) {
    try {
      const assessments = await db('lawn_assessments')
        .where({ customer_id: customerId, confirmed_by_tech: true })
        .orderBy('service_date', 'desc')
        .limit(4);

      if (assessments.length < 2) return null;

      const calcOverall = (a) => a.overall_score || Math.round(
        (a.turf_density + a.weed_suppression + a.fungus_control + (a.color_health || 0) + (a.thatch_level || 0)) / 5
      );

      const scores = assessments.map(calcOverall);
      const latest = scores[0];
      const trend = scores.length >= 3 ? scores.slice(0, 3) : scores;
      const declining = trend.every((s, i) => i === 0 || s <= trend[i - 1]) && (trend[0] - trend[trend.length - 1]) > 5;
      const improving = trend.every((s, i) => i === 0 || s >= trend[i - 1]) && (trend[0] - trend[trend.length - 1]) > 10;

      // Emit signals to customer_signals if table exists
      try {
        if (declining) {
          const existing = await db('customer_signals')
            .where({ customer_id: customerId, signal_type: 'LAWN_SCORE_DECLINING', resolved: false })
            .first();
          if (!existing) {
            await db('customer_signals').insert({
              customer_id: customerId,
              signal_type: 'LAWN_SCORE_DECLINING',
              signal_value: JSON.stringify({ scores: trend, delta: trend[0] - trend[trend.length - 1] }),
              severity: trend[0] - trend[trend.length - 1] > 15 ? 'warning' : 'info',
              detected_at: new Date(),
            });
          }
        }

        if (improving && latest >= 75) {
          const existing = await db('customer_signals')
            .where({ customer_id: customerId, signal_type: 'LAWN_TRANSFORMATION', resolved: false })
            .first();
          if (!existing) {
            await db('customer_signals').insert({
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
          await db('customer_signals')
            .where({ customer_id: customerId, signal_type: 'LAWN_SCORE_DECLINING', resolved: false })
            .update({ resolved: true, resolved_at: new Date() });
        }
      } catch { /* customer_signals table may not exist */ }

      return { declining, improving, latest, trend };
    } catch (err) {
      logger.error(`[lawn-intel] emitHealthSignal failed: ${err.message}`);
      return null;
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
  async recordTechCalibration(assessmentId, aiScores, techScores) {
    try {
      const assessment = await db('lawn_assessments').where({ id: assessmentId }).first();
      if (!assessment || !assessment.technician_id) return null;

      // stress_damage is the consolidated score the tech actually corrects on the
      // completion screen now (fungus/thatch are AI-only and unchanged), so it must
      // be part of the calibration delta/bias — otherwise a real Stress correction
      // reads as zero delta.
      const fields = ['turf_density', 'weed_suppression', 'color_health', 'fungus_control', 'thatch_level', 'stress_damage'];
      const deltas = [];
      const row = { assessment_id: assessmentId, technician_id: assessment.technician_id };

      for (const f of fields) {
        const aiKey = f;
        row[`ai_${f}`] = aiScores[aiKey] ?? null;
        row[`tech_${f}`] = techScores[aiKey] ?? null;
        if (aiScores[aiKey] != null && techScores[aiKey] != null) {
          deltas.push(Math.abs(aiScores[aiKey] - techScores[aiKey]));
        }
      }

      row.avg_delta = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length * 10) / 10 : 0;

      // Determine bias direction
      let higher = 0, lower = 0;
      for (const f of fields) {
        if (techScores[f] != null && aiScores[f] != null) {
          if (techScores[f] > aiScores[f]) higher++;
          else if (techScores[f] < aiScores[f]) lower++;
        }
      }
      row.bias_direction = higher > lower ? 'higher' : lower > higher ? 'lower' : 'mixed';

      await db('tech_calibration').insert(row);
      return row;
    } catch (err) {
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

      let report = null;
      if (await db.schema.hasTable('service_reports').catch(() => false)) {
        const reportCols = await db('service_reports').columnInfo().catch(() => ({}));
        const insertData = Object.fromEntries(
          Object.entries(reportData).filter(([key]) => reportCols[key])
        );
        if (Object.keys(insertData).length > 0) {
          [report] = await db('service_reports').insert(insertData).returning('*');
        }
      }

      const update = {};
      if (assessmentCols.report_auto_generated) update.report_auto_generated = true;
      if (report?.id && assessmentCols.report_id) update.report_id = report.id;
      if (assessmentCols.updated_at) update.updated_at = new Date();
      if (Object.keys(update).length > 0) await db('lawn_assessments').where({ id: assessmentId }).update(update);

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
