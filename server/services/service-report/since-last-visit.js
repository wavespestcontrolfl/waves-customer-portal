const db = require('../../models/db');
const { detectServiceLine } = require('./service-line-configs');
const { customerVisiblePressureIndex } = require('../pest-pressure/display');

function pressureValue(value) {
  const n = customerVisiblePressureIndex(value);
  return Number.isFinite(n) ? n.toFixed(1) : null;
}

function firstRecommendation(findings = []) {
  return findings.find((finding) => String(finding.recommendation || '').trim()) || null;
}

function readableActivityLine(currentFindings = []) {
  // Report the technician's actual finding title. Never assert a magnitude,
  // location, or direction ("reduced", "front entry") that wasn't recorded —
  // this line is shown verbatim to the customer.
  const current = currentFindings.find((finding) => String(finding.title || '').trim());
  if (!current) return undefined;
  return String(current.title || '').trim();
}

async function buildSinceLastVisitContext({ record, currentPressureIndexOverride, knex = db } = {}) {
  if (!record?.id || !record.customer_id) return undefined;
  const serviceLine = record.service_line || detectServiceLine(record.service_type);
  let priorQuery = knex('service_records')
    .where({ customer_id: record.customer_id, status: 'completed' })
    .whereNot({ id: record.id })
    .where(function sameServiceLine() {
      this.where({ service_line: serviceLine })
        .orWhere(function legacyType() {
          this.whereNull('service_line').where({ service_type: record.service_type });
        });
    });
  // Only consider visits strictly before this one. Report tokens are permanent
  // and sinceLastVisit is computed at render time, so without this bound a newer
  // visit completed after this report would be picked as the "prior" baseline —
  // reversing the "Pressure: X -> Y" delta the customer reads. started_at breaks
  // ties on the same service date; when it's missing we fall back to a strict
  // date bound so a later same-day visit still can't slip in as the baseline.
  if (record.service_date) {
    priorQuery = priorQuery.where(function priorBoundary() {
      this.where('service_date', '<', record.service_date);
      if (record.started_at) {
        this.orWhere(function sameDayEarlier() {
          this.where('service_date', record.service_date)
            .where('started_at', '<', record.started_at);
        });
      }
    });
  }
  const prior = await priorQuery
    .orderBy('service_date', 'desc')
    .orderBy('started_at', 'desc')
    .first('id', 'pressure_index')
    .catch(() => null);

  const currentFindings = await knex('service_findings')
    .where({ service_record_id: record.id })
    .select('id', 'service_record_id', 'title', 'detail', 'recommendation', 'severity')
    .catch(() => []);
  const currentPressure = pressureValue(currentPressureIndexOverride !== undefined ? currentPressureIndexOverride : record.pressure_index);
  const priorPressure = pressureValue(prior?.pressure_index);
  const recommendation = firstRecommendation(currentFindings);

  if (!prior && !currentFindings.length && !recommendation) return undefined;

  return {
    priorServiceRecordId: prior?.id,
    pressureLine: priorPressure && currentPressure ? `Pressure: ${priorPressure} -> ${currentPressure}` : undefined,
    activityLine: readableActivityLine(currentFindings),
    actionLine: recommendation?.recommendation
      ? `Customer action: ${String(recommendation.recommendation).trim()}`
      : undefined,
  };
}

module.exports = {
  buildSinceLastVisitContext,
  readableActivityLine,
};
