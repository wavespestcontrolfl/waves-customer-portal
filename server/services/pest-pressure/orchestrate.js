/**
 * Pest Pressure orchestration.
 *
 * Single entry point called from the service-report completion flow.
 * Loads config, runs all five component extractors against the current
 * service record, calls the pure scoring engine, persists the result to
 * pest_pressure_scores, and mirrors the displayed score back to
 * service_records.pressure_index so legacy trend/neighborhood/chart code
 * keeps working without modification.
 *
 * Safe to call inside an existing knex transaction by passing the
 * transaction as `knex`. Failures should NOT roll back the surrounding
 * service-report transaction — Pest Pressure is a derived/computed
 * artifact and a failure here must not block a tech from completing a
 * report. The caller decides; see `runAndSwallowErrors` for the
 * recommended wrapper.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { detectServiceLine } = require('../service-report/service-line-configs');
const { calculatePestPressureScore } = require('./calculate');
const { resolveReviewWindow, isOneTimeServiceLabel } = require('./review-window');
const {
  loadActiveConfig,
  loadPreviousScore,
  persistScore,
} = require('./store');
const { extractClientRating } = require('./components/client-rating');
const { extractTechnicianRating } = require('./components/technician-rating');
const { extractReServiceImpact } = require('./components/re-service-impact');
const { extractRecurringIssue } = require('./components/recurring-issue');
const { extractRiskFactorRating } = require('./components/risk-factor');

function pickValue(extractorResult) {
  if (!extractorResult || !extractorResult.present) return null;
  return extractorResult.value;
}

function isoDate(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function gatherInputs(knex, serviceRecord, config) {
  const serviceLine = serviceRecord.service_line || detectServiceLine(serviceRecord.service_type);

  const lastCompletedRow = await knex('service_records')
    .where('customer_id', serviceRecord.customer_id)
    .where('status', 'completed')
    .whereNot('id', serviceRecord.id)
    .where(function priorServiceLine() {
      if (serviceLine) {
        this.where('service_line', serviceLine).orWhereNull('service_line');
      }
    })
    .orderBy('service_date', 'desc')
    .first('service_date');

  const window = resolveReviewWindow({
    serviceFrequency: serviceRecord.service_type,
    serviceDate: serviceRecord.service_date,
    lastCompletedServiceDate: lastCompletedRow ? lastCompletedRow.service_date : null,
    windows: config.serviceFrequencyWindows,
  });

  const [client, technician, reService, recurring, risk, previous] = await Promise.all([
    extractClientRating({ knex, serviceRecordId: serviceRecord.id }),
    extractTechnicianRating({ knex, serviceRecordId: serviceRecord.id }),
    extractReServiceImpact({
      knex,
      customerId: serviceRecord.customer_id,
      serviceRecordId: serviceRecord.id,
      reviewPeriodStart: isoDate(window.start),
      reviewPeriodEnd: isoDate(window.end),
      serviceLine,
    }),
    extractRecurringIssue({
      knex,
      customerId: serviceRecord.customer_id,
      serviceRecordId: serviceRecord.id,
      serviceLine,
    }),
    extractRiskFactorRating({ knex, serviceRecordId: serviceRecord.id }),
    loadPreviousScore(knex, {
      customerId: serviceRecord.customer_id,
      serviceLine,
      beforeServiceRecordId: serviceRecord.id,
      beforeServiceDate: serviceRecord.service_date,
    }),
  ]);

  return {
    serviceLine,
    window,
    inputs: {
      clientRating: pickValue(client),
      technicianRating: pickValue(technician),
      reServiceImpact: pickValue(reService),
      recurringIssueRating: pickValue(recurring),
      riskFactorRating: pickValue(risk),
      previousScore: previous.value,
    },
    extractorResults: { client, technician, reService, recurring, risk, previous },
  };
}

/**
 * Calculate + persist a Pest Pressure score for one service record.
 * Returns the full engine result (caller may also surface it inline).
 *
 * Mirrors displayed_score back to service_records.pressure_index so the
 * legacy customer report rendering keeps working pre-Phase-5.
 */
async function calculateAndPersistForServiceRecord(serviceRecordId, knex = db) {
  if (!serviceRecordId) {
    throw new TypeError('calculateAndPersistForServiceRecord: serviceRecordId is required');
  }
  const serviceRecord = await knex('service_records')
    .where({ id: serviceRecordId })
    .first('id', 'customer_id', 'service_type', 'service_line', 'service_date', 'status');
  if (!serviceRecord) {
    return null;
  }

  const config = await loadActiveConfig(knex);
  if (!config.enabled) {
    return null;
  }

  // Service-line scope: by default Pest Pressure runs only on the lines
  // where the multi-visit-trend model makes sense (pest + mosquito).
  const serviceLineGuess = serviceRecord.service_line || detectServiceLine(serviceRecord.service_type);
  const enabledLines = Array.isArray(config.enabledServiceLines) ? config.enabledServiceLines : [];
  if (enabledLines.length > 0 && !enabledLines.includes(serviceLineGuess)) {
    return null;
  }

  // Recurring-frequency scope: skip only EXPLICIT one-time service labels.
  // Unknown-frequency recurring jobs (e.g. "General Pest Control",
  // "Recurring Pest Control") fall through and use the engine's fallback
  // review window — they're real recurring jobs that just don't include
  // a cadence word in the label.
  if (config.requireRecurringFrequency && isOneTimeServiceLabel(serviceRecord.service_type)) {
    return null;
  }

  const { serviceLine, window, inputs } = await gatherInputs(knex, serviceRecord, config);
  const result = calculatePestPressureScore(inputs, config);

  const persisted = await persistScore(knex, {
    customerId: serviceRecord.customer_id,
    serviceRecordId: serviceRecord.id,
    serviceLine,
    serviceDate: serviceRecord.service_date,
    reviewPeriodStart: isoDate(window.start),
    reviewPeriodEnd: isoDate(window.end),
    result,
  });

  // Mirror the persisted row's displayed_score — NOT result.displayedScore.
  // persistScore preserves an existing manual override, so a recalculation
  // can produce a fresh calculated_score while displayed_score stays at
  // the admin-set override. Legacy report metrics + the trend chart read
  // service_records.pressure_index, so they must see the same number the
  // customer sees (override-aware). When the persisted row has no displayed
  // value (insufficient data, brand-new), clear pressure_index too so
  // legacy consumers don't read a stale prior number.
  const displayedScoreToMirror = persisted && persisted.displayed_score !== undefined
    ? persisted.displayed_score
    : result.displayedScore;
  await knex('service_records')
    .where({ id: serviceRecord.id })
    .update({ pressure_index: displayedScoreToMirror == null ? null : displayedScoreToMirror });

  return { result, serviceLine, window };
}

/**
 * Convenience wrapper for the completion-flow hook: never throws. A
 * failing Pest Pressure calculation must not block report completion.
 */
async function runAndSwallowErrors(serviceRecordId, knex = db) {
  try {
    return await calculateAndPersistForServiceRecord(serviceRecordId, knex);
  } catch (err) {
    logger.error(`[pest-pressure] orchestrate failed for service_record ${serviceRecordId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  calculateAndPersistForServiceRecord,
  runAndSwallowErrors,
  // Exposed for tests
  _internal: { gatherInputs, isoDate },
};
