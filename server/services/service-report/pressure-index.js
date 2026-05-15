const db = require('../../models/db');
const { detectServiceLine } = require('./service-line-configs');

const SEVERITY_WEIGHTS = {
  info: 0,
  low: 0.5,
  medium: 1.5,
  high: 3,
  critical: 5,
};

function normalizePressureScore(visitScore) {
  const normalized = 5 * (1 - Math.exp(-visitScore / 4));
  return Math.round(normalized * 10) / 10;
}

function pressureFromFindings(findings, priorPressureIndex = null) {
  const visitScore = (findings || []).reduce((sum, finding) => {
    return sum + (SEVERITY_WEIGHTS[finding?.severity] ?? 0);
  }, 0);
  const normalized = 5 * (1 - Math.exp(-visitScore / 4));
  const blended = priorPressureIndex != null
    ? 0.75 * normalized + 0.25 * Number(priorPressureIndex)
    : normalized;
  return Math.round(blended * 10) / 10;
}

async function computePressureIndex(serviceRecordId, knex = db) {
  const findings = await knex('service_findings').where({ service_record_id: serviceRecordId });
  const record = await knex('service_records').where({ id: serviceRecordId }).first();
  if (!record) return 0;
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

  return pressureFromFindings(findings, prior?.pressure_index ?? null);
}

module.exports = {
  SEVERITY_WEIGHTS,
  normalizePressureScore,
  pressureFromFindings,
  computePressureIndex,
};
