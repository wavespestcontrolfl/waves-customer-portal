const db = require('../../models/db');
const { detectServiceLine } = require('./service-line-configs');
const { customerVisiblePressureIndex } = require('./pressure-index');

function pressureValue(value) {
  const n = customerVisiblePressureIndex(value);
  return Number.isFinite(n) ? n.toFixed(1) : null;
}

function firstRecommendation(findings = []) {
  return findings.find((finding) => String(finding.recommendation || '').trim()) || null;
}

function readableActivityLine(currentFindings = [], priorFindings = []) {
  const current = currentFindings.find((finding) => String(finding.title || '').trim());
  if (!current) return undefined;
  const title = String(current.title || '').trim();
  const lower = title.toLowerCase();
  if (lower.includes('ant') && priorFindings.some((finding) => String(finding.title || '').toLowerCase().includes('ant'))) {
    return 'Ant activity reduced to a small trail at the front entry.';
  }
  return title;
}

async function buildSinceLastVisitContext({ record, currentPressureIndexOverride, knex = db } = {}) {
  if (!record?.id || !record.customer_id) return undefined;
  const serviceLine = record.service_line || detectServiceLine(record.service_type);
  const prior = await knex('service_records')
    .where({ customer_id: record.customer_id, status: 'completed' })
    .whereNot({ id: record.id })
    .where(function sameServiceLine() {
      this.where({ service_line: serviceLine })
        .orWhere(function legacyType() {
          this.whereNull('service_line').where({ service_type: record.service_type });
        });
    })
    .orderBy('service_date', 'desc')
    .orderBy('started_at', 'desc')
    .first('id', 'pressure_index')
    .catch(() => null);

  const ids = [prior?.id, record.id].filter(Boolean);
  const findings = ids.length
    ? await knex('service_findings')
      .whereIn('service_record_id', ids)
      .select('id', 'service_record_id', 'title', 'detail', 'recommendation', 'severity')
      .catch(() => [])
    : [];

  const currentFindings = findings.filter((finding) => String(finding.service_record_id) === String(record.id));
  const priorFindings = findings.filter((finding) => String(finding.service_record_id) === String(prior?.id));
  const currentPressure = pressureValue(currentPressureIndexOverride !== undefined ? currentPressureIndexOverride : record.pressure_index);
  const priorPressure = pressureValue(prior?.pressure_index);
  const recommendation = firstRecommendation(currentFindings);

  if (!prior && !currentFindings.length && !recommendation) return undefined;

  return {
    priorServiceRecordId: prior?.id,
    pressureLine: priorPressure && currentPressure ? `Pressure: ${priorPressure} -> ${currentPressure}` : undefined,
    activityLine: readableActivityLine(currentFindings, priorFindings),
    actionLine: recommendation?.recommendation
      ? `Customer action: ${String(recommendation.recommendation).trim()}`
      : undefined,
  };
}

module.exports = {
  buildSinceLastVisitContext,
  readableActivityLine,
};
