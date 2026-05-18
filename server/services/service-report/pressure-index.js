const db = require('../../models/db');
const { detectServiceLine } = require('./service-line-configs');

const SEVERITY_WEIGHTS = {
  info: 0,
  low: 0.5,
  medium: 1.5,
  high: 3,
  critical: 5,
};

// A callback/re-service is a real pressure signal even when the tech documents
// only light findings on the return visit. Treat it like a medium operational
// driver before the historical smoothing is applied.
const CALLBACK_PRESSURE_WEIGHT = 1.5;

function normalizePressureScore(visitScore) {
  const normalized = 5 * (1 - Math.exp(-visitScore / 4));
  return Math.round(normalized * 10) / 10;
}

function pressureFromFindings(findings, priorPressureIndex = null, options = {}) {
  const callbackPressureAdjustment = Number(options.callbackPressureAdjustment
    ?? (options.hasCallback ? CALLBACK_PRESSURE_WEIGHT : 0));
  const visitScore = (findings || []).reduce((sum, finding) => {
    return sum + (SEVERITY_WEIGHTS[finding?.severity] ?? 0);
  }, Number.isFinite(callbackPressureAdjustment) ? callbackPressureAdjustment : 0);
  const normalized = 5 * (1 - Math.exp(-visitScore / 4));
  const blended = priorPressureIndex != null
    ? 0.75 * normalized + 0.25 * Number(priorPressureIndex)
    : normalized;
  const floored = Math.max(blended, 0.3);
  return Math.round(floored * 10) / 10;
}

function isCallbackSignal(record = {}, scheduledService = null) {
  if (record.is_callback === true || scheduledService?.is_callback === true) return true;
  const text = [
    record.service_type,
    record.customer_interaction,
    scheduledService?.service_type,
    scheduledService?.internal_notes,
    scheduledService?.notes,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(callback|call back|re-?service|retreat|re-?treat|retreatment)\b/.test(text);
}

async function computePressureIndex(serviceRecordId, knex = db) {
  const findings = await knex('service_findings').where({ service_record_id: serviceRecordId });
  const record = await knex('service_records').where({ id: serviceRecordId }).first();
  if (!record) return 0;
  const scheduledService = record.scheduled_service_id
    ? await knex('scheduled_services')
      .where({ id: record.scheduled_service_id })
      .first('id', 'service_type', 'is_callback', 'internal_notes', 'notes')
      .catch(() => null)
    : null;
  const serviceLine = record.service_line || detectServiceLine(record.service_type);
  const prior = await knex('service_records')
    .where({ customer_id: record.customer_id, status: 'completed' })
    .where(function priorServiceLine() {
      this.where({ service_line: serviceLine }).orWhere(function legacyType() {
        this.whereNull('service_line').whereILike('service_type', `%${serviceLine === 'pest' ? 'pest' : serviceLine}%`);
      });
    })
    .whereNot({ id: serviceRecordId })
    .whereNotNull('pressure_index')
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .first('pressure_index');

  return pressureFromFindings(findings, prior?.pressure_index ?? null, {
    hasCallback: isCallbackSignal(record, scheduledService),
  });
}

module.exports = {
  CALLBACK_PRESSURE_WEIGHT,
  SEVERITY_WEIGHTS,
  isCallbackSignal,
  normalizePressureScore,
  pressureFromFindings,
  computePressureIndex,
};
