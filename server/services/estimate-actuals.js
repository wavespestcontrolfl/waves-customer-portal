/**
 * Estimate actuals feedback loop.
 *
 * The estimator prices from REMOTE inputs (county records, satellite vision,
 * AI search); techs then observe the TRUTH on site — how long the service
 * actually took, how much turf was actually treated, what was actually
 * applied. Until now those never met: a verified override fixed one address,
 * but systematic bias (turf consistently overestimated in one market, cage
 * burden consistently underpriced) stayed invisible.
 *
 * Nightly, this reconciles completed services that trace back to an accepted
 * estimate (scheduled_services.source_estimate_id) and writes one
 * estimate_actuals row per service: priced inputs beside observed actuals,
 * with scalar deltas for aggregation. Re-scans a trailing window and upserts
 * on service_record_id, so missed nights and re-runs are harmless.
 *
 * Positive delta = actual ran OVER the estimate (we underpriced the burden).
 *
 * Kill switch: ESTIMATE_ACTUALS_DISABLED=1.
 */

const db = require('../models/db');
const logger = require('./logger');
const { runExclusive } = require('../utils/cron-lock');

const DEFAULT_RESCAN_DAYS = 7;
const MAX_BATCH = 500;

function isReconcileDisabled() {
  const flag = process.env.ESTIMATE_ACTUALS_DISABLED;
  return flag === '1' || flag === 'true' || flag === 'on';
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Priced inputs from the persisted estimate_data. Both shapes carry the same
// core keys: the admin save's engineRequest.profile (the /calculate-estimate
// payload) and the public/lead engineInputs (already a v1 engine input).
// measuredTurfSf (tech-measured at estimate time) beats estimatedTurfSf.
function extractEstimateProfile(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return null;
  const src = (estimateData.engineRequest && typeof estimateData.engineRequest === 'object'
    ? estimateData.engineRequest.profile : null)
    || (typeof estimateData.engineInputs === 'object' ? estimateData.engineInputs : null);
  if (!src || typeof src !== 'object') return null;

  return {
    homeSqFt: positiveNumber(src.homeSqFt ?? src.squareFootage),
    lotSqFt: positiveNumber(src.lotSqFt),
    turfSqFt: positiveNumber(src.measuredTurfSf) || positiveNumber(src.estimatedTurfSf),
    stories: positiveNumber(src.stories),
  };
}

// Percentage delta, positive when actual exceeds estimated. Null unless both
// sides are present — a missing side is "no signal", never 0% or 100%.
function deltaPct(estimated, actual) {
  const est = positiveNumber(estimated);
  const act = positiveNumber(actual);
  if (!est || !act) return null;
  return Math.round(((act - est) / est) * 10000) / 100;
}

// Observed time on site, most precise source first: the dispatch tracker's
// computed actual_duration_minutes, then arrival→completion from the
// appointment lifecycle, then the service report's started/ended span.
function actualDurationMinutes(scheduledService, serviceRecord) {
  const tracked = positiveNumber(scheduledService?.actual_duration_minutes);
  if (tracked) return Math.round(tracked);

  const spans = [
    [scheduledService?.arrived_at, scheduledService?.completed_at],
    [serviceRecord?.started_at, serviceRecord?.ended_at],
  ];
  for (const [start, end] of spans) {
    if (!start || !end) continue;
    const minutes = (new Date(end).getTime() - new Date(start).getTime()) / 60000;
    if (Number.isFinite(minutes) && minutes > 0 && minutes < 24 * 60) return Math.round(minutes);
  }
  return null;
}

function buildActualsRow({ serviceRecord, scheduledService, estimate, completion, productCount }) {
  const profile = extractEstimateProfile(estimate.estimate_data) || {};
  const estimated = {
    homeSqFt: profile.homeSqFt ?? null,
    lotSqFt: profile.lotSqFt ?? null,
    turfSqFt: profile.turfSqFt ?? null,
    stories: profile.stories ?? null,
    durationMinutes: positiveNumber(scheduledService?.estimated_duration_minutes),
  };
  const actual = {
    treatedSqft: positiveNumber(completion?.treated_sqft),
    durationMinutes: actualDurationMinutes(scheduledService, serviceRecord),
    productCount: Number(productCount) || 0,
    totalCarrierGal: positiveNumber(completion?.total_carrier_gal),
  };

  return {
    estimate_id: estimate.id,
    customer_id: serviceRecord.customer_id || null,
    service_record_id: serviceRecord.id,
    scheduled_service_id: scheduledService?.id || null,
    service_line: serviceRecord.service_line || null,
    service_date: serviceRecord.service_date || null,
    estimated: JSON.stringify(estimated),
    actual: JSON.stringify(actual),
    turf_delta_pct: deltaPct(estimated.turfSqFt, actual.treatedSqft),
    duration_delta_pct: deltaPct(estimated.durationMinutes, actual.durationMinutes),
    updated_at: db.fn.now(),
  };
}

// Completed services in the trailing window whose appointment traces back to
// an accepted estimate. One query for the spine; per-service lookups for the
// completion ledger and product count (bounded by MAX_BATCH).
async function reconcileEstimateActuals({ rescanDays = DEFAULT_RESCAN_DAYS } = {}) {
  logger.info('[estimate-actuals] scan started', { rescanDays });
  const spine = await db('service_records as sr')
    .join('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .join('estimates as e', 'e.id', 'ss.source_estimate_id')
    .where('sr.status', 'completed')
    .where('sr.service_date', '>=', db.raw(`(now() at time zone 'America/New_York')::date - ?::int`, [rescanDays]))
    .select(
      'sr.id as service_record_id', 'sr.customer_id', 'sr.service_line', 'sr.service_date',
      'sr.started_at', 'sr.ended_at',
      'ss.id as scheduled_service_id', 'ss.estimated_duration_minutes',
      'ss.actual_duration_minutes', 'ss.arrived_at', 'ss.completed_at',
      'e.id as estimate_id', 'e.estimate_data',
    )
    .orderBy('sr.service_date', 'desc')
    .limit(MAX_BATCH);

  let written = 0;
  let failed = 0;
  for (const row of spine) {
    try {
      const [completion, productCountRow] = await Promise.all([
        db('lawn_protocol_service_completions')
          .where({ service_record_id: row.service_record_id })
          .first('treated_sqft', 'total_carrier_gal'),
        db('service_products')
          .where({ service_record_id: row.service_record_id })
          .count({ count: '*' })
          .first(),
      ]);

      const ledgerRow = buildActualsRow({
        serviceRecord: {
          id: row.service_record_id,
          customer_id: row.customer_id,
          service_line: row.service_line,
          service_date: row.service_date,
          started_at: row.started_at,
          ended_at: row.ended_at,
        },
        scheduledService: {
          id: row.scheduled_service_id,
          estimated_duration_minutes: row.estimated_duration_minutes,
          actual_duration_minutes: row.actual_duration_minutes,
          arrived_at: row.arrived_at,
          completed_at: row.completed_at,
        },
        estimate: { id: row.estimate_id, estimate_data: row.estimate_data },
        completion,
        productCount: productCountRow?.count,
      });

      await db('estimate_actuals')
        .insert(ledgerRow)
        .onConflict('service_record_id')
        .merge();
      written += 1;
    } catch (err) {
      // One malformed row must not abort the batch — the window re-scan
      // retries it tomorrow anyway.
      failed += 1;
      logger.warn('[estimate-actuals] row reconcile failed', { error: err.message });
    }
  }

  // Always log completion — a zero-row scan must be distinguishable from a
  // scan that never ran (silent green is weaker than measurable green).
  logger.info('[estimate-actuals] scan completed', {
    scanned: spine.length, written, failed, rescanDays,
  });
  return { written, failed, scanned: spine.length };
}

async function runEstimateActualsReconcile(options = {}) {
  if (isReconcileDisabled()) {
    logger.info('[estimate-actuals] disabled via ESTIMATE_ACTUALS_DISABLED');
    return { skipped: true, reason: 'disabled' };
  }
  return runExclusive('estimate-actuals-reconcile', () => reconcileEstimateActuals(options));
}

// Systematic-bias aggregates for the admin variance endpoint: per service
// line over a window — sample size, average and spread of each delta. The
// bias READ is intentionally compute-on-read; the ledger is the artifact.
async function varianceSummary({ days = 90 } = {}) {
  const rows = await db('estimate_actuals')
    .where('service_date', '>=', db.raw(`(now() at time zone 'America/New_York')::date - ?::int`, [days]))
    .select('service_line')
    .count({ services: '*' })
    .avg({ avg_turf_delta_pct: 'turf_delta_pct' })
    .avg({ avg_duration_delta_pct: 'duration_delta_pct' })
    .count({ turf_samples: 'turf_delta_pct' })
    .count({ duration_samples: 'duration_delta_pct' })
    .groupBy('service_line')
    .orderBy('services', 'desc');

  return rows.map((row) => ({
    serviceLine: row.service_line,
    services: Number(row.services) || 0,
    turf: {
      samples: Number(row.turf_samples) || 0,
      avgDeltaPct: row.avg_turf_delta_pct == null ? null : Math.round(Number(row.avg_turf_delta_pct) * 100) / 100,
    },
    duration: {
      samples: Number(row.duration_samples) || 0,
      avgDeltaPct: row.avg_duration_delta_pct == null ? null : Math.round(Number(row.avg_duration_delta_pct) * 100) / 100,
    },
  }));
}

module.exports = {
  reconcileEstimateActuals,
  runEstimateActualsReconcile,
  varianceSummary,
  _private: {
    actualDurationMinutes,
    buildActualsRow,
    deltaPct,
    extractEstimateProfile,
    isReconcileDisabled,
  },
};
