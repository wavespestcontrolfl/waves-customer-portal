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

function parseJsonbValue(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizedEnum(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || null;
}

// Zero is a recorded observation for counts ("no palms on this property"),
// not a missing value — positiveNumber would erase exactly the evidence an
// overestimated count needs. Blank/garbage still reads as no-signal null.
function nonnegativeCount(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Measurement fields tolerate digit-grouping commas/spaces ("2,400" from
// dictation) — entry validation enforces numeric shape, this mirrors it.
function lenientMeasurement(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Priced Tree & Shrub inputs. The full engine quote survives ONLY on
// agent/IB drafts (estimate_data.engineResult.lineItems — the raw
// generateEstimate output). Admin saves run the result through
// mapV1ToLegacyShape, which reduces T&S to results.tsMeta {eb, et,
// bedAreaIsEstimated} + the selected tier row in results.ts — access and
// onSiteMin don't survive that mapping, so those read null there and the
// replay profile (engineRequest.profile) is the only access source.
function extractTreeShrubEstimate(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return null;

  const lineItems = estimateData.engineResult?.lineItems;
  if (Array.isArray(lineItems)) {
    const quote = lineItems.find((item) => item?.service === 'tree_shrub');
    if (quote) {
      const bedAreaSource = normalizedEnum(quote.bedAreaSource);
      const extracted = {
        bedSqFt: positiveNumber(quote.bedAreaUsed ?? quote.bedArea),
        bedAreaSource,
        bedAreaEstimated: bedAreaSource ? bedAreaSource !== 'explicit' : null,
        treeCount: nonnegativeCount(quote.treeCount),
        access: normalizedEnum(quote.access),
        tier: normalizedEnum(quote.tier),
        onSiteMin: positiveNumber(quote.onSiteMin),
      };
      // Quote-wizard and lead-automation drafts whitelist the lineItem down
      // to price/cadence fields — a T&S line with none of the cost drivers
      // is no signal, not a block of nulls.
      if (Object.values(extracted).some((value) => value !== null)) return extracted;
    }
  }

  const tsMeta = estimateData.result?.results?.tsMeta;
  if (tsMeta && (positiveNumber(tsMeta.eb) || positiveNumber(tsMeta.et))) {
    const profile = (estimateData.engineRequest && typeof estimateData.engineRequest === 'object'
      ? estimateData.engineRequest.profile : null) || {};
    const tierRows = estimateData.result?.results?.ts;
    const selected = Array.isArray(tierRows) ? tierRows.find((row) => row?.selected) : null;
    return {
      bedSqFt: positiveNumber(tsMeta.eb),
      // The legacy mapping collapses the four-value source enum to ONE
      // boolean (true = lot_based|fallback, false = explicit|estimated) —
      // reconstructing an enum from it would invent cohorts. The enum stays
      // null here; only the coarse boolean is real signal on this path.
      bedAreaSource: null,
      bedAreaEstimated: typeof tsMeta.bedAreaIsEstimated === 'boolean'
        ? tsMeta.bedAreaIsEstimated : null,
      treeCount: nonnegativeCount(tsMeta.et),
      access: normalizedEnum(profile.access || profile.features?.access),
      tier: normalizedEnum(selected?.tier),
      onSiteMin: null,
    };
  }

  return null;
}

// Observed Tree & Shrub cost drivers from the typed completion. The raw
// values object (internal calibration fields included) is frozen at
// service_data.typedReportSnapshot.values; on combined visits the T&S
// section may instead be a companion snapshot. Primary wins field-by-field.
function extractTreeShrubActuals(serviceData) {
  const data = parseJsonbValue(serviceData);
  if (!data) return null;

  const snapshots = [];
  if (data.typedReportSnapshot?.type === 'tree_shrub') {
    snapshots.push(data.typedReportSnapshot.values || {});
  }
  for (const companion of Array.isArray(data.companionReportSnapshots) ? data.companionReportSnapshots : []) {
    if (companion?.type === 'tree_shrub') snapshots.push(companion.values || {});
  }
  if (!snapshots.length) return null;

  const pick = (key) => {
    for (const values of snapshots) {
      const value = values?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return null;
  };

  const actuals = {
    bedSqFt: lenientMeasurement(pick('bed_sqft_serviced')),
    palmCount: nonnegativeCount(pick('palm_count_total')) ?? nonnegativeCount(pick('palms_serviced')),
    treeCount: nonnegativeCount(pick('tree_count_total')),
    shrubDensity: normalizedEnum(pick('shrub_density')),
    access: normalizedEnum(pick('access_difficulty')),
  };
  return Object.values(actuals).some((value) => value !== null) ? actuals : null;
}

// Durable backfill marker (structured_notes.backfill, frozen by the
// completion transaction — the same read job-costing and
// pricing-reality-check key their untrusted-span policies off).
function isBackfilledRecord(serviceRecord) {
  const notes = serviceRecord?.structured_notes;
  if (!notes) return false;
  try {
    const parsed = typeof notes === 'string' ? JSON.parse(notes) : notes;
    return parsed?.backfill === true;
  } catch {
    return false;
  }
}

// Observed time on site, most precise source first: the dispatch tracker's
// computed actual_duration_minutes, then arrival→completion from the
// appointment lifecycle, then the service report's started/ended span.
// Backdated quiet closeouts (structured_notes.backfill) skip the span
// fallbacks: the row keeps its real stale start as history while the
// duration policies strip the end stamps and completed_at carries only a
// day-scale service-day instant (ET noon, PR #2897 fix round 9) — pairing
// those at read time would book a fabricated duration into the estimate
// accuracy ledger. The persisted actual_duration_minutes IS trusted (the
// backfill policy writes it only from the operator's typed duration).
function actualDurationMinutes(scheduledService, serviceRecord) {
  const tracked = positiveNumber(scheduledService?.actual_duration_minutes);
  if (tracked) return Math.round(tracked);
  if (isBackfilledRecord(serviceRecord)) return null;

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

  // Tree & Shrub calibration block (reprice lane 2026-08-08): the engine's
  // cost drivers, priced vs observed. Attached whenever either side yields
  // data — not gated on service_line, which is free text and unreliable for
  // T&S rows. Deltas live inside the block (the scalar columns stay
  // lawn/pest-shaped); bedSqFtDeltaPct follows the same over-estimate-
  // positive convention as the columns.
  const treeShrubEstimate = extractTreeShrubEstimate(estimate.estimate_data);
  const treeShrubActual = extractTreeShrubActuals(serviceRecord.service_data);
  if (treeShrubEstimate) estimated.treeShrub = treeShrubEstimate;
  if (treeShrubActual) {
    actual.treeShrub = treeShrubActual;
    if (treeShrubEstimate) {
      actual.treeShrub.bedSqFtDeltaPct = deltaPct(treeShrubEstimate.bedSqFt, treeShrubActual.bedSqFt);
    }
  }

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
      'sr.started_at', 'sr.ended_at', 'sr.structured_notes', 'sr.service_data',
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
          structured_notes: row.structured_notes,
          service_data: row.service_data,
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
    extractTreeShrubEstimate,
    extractTreeShrubActuals,
    isReconcileDisabled,
  },
};
