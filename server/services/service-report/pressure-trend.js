const db = require('../../models/db');
const { detectServiceLine } = require('./service-line-configs');
const { formatVisitLabel, normalizeDate } = require('./time-format');
const { customerVisiblePressureIndex } = require('../pest-pressure/display');

const SEVERITY_RANK = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function pressureNumber(value) {
  return customerVisiblePressureIndex(value);
}

function serviceStartedAt(row) {
  const date = normalizeDate(row?.started_at)
    || normalizeDate(row?.ended_at)
    || normalizeDate(row?.service_date)
    || normalizeDate(row?.created_at);
  return date || new Date(0);
}

function highestSeverityFinding(findings = []) {
  return [...findings].sort((a, b) => {
    const left = SEVERITY_RANK[String(a?.severity || '').toLowerCase()] || 0;
    const right = SEVERITY_RANK[String(b?.severity || '').toLowerCase()] || 0;
    return right - left;
  })[0] || null;
}

function pointFromRow(row, findings = []) {
  const startedAt = serviceStartedAt(row);
  const pressureIndex = pressureNumber(row.pressure_index);
  const highest = highestSeverityFinding(findings);
  return {
    serviceRecordId: String(row.id),
    startedAt: startedAt.toISOString(),
    label: formatVisitLabel(startedAt),
    pressureIndex,
    findingsCount: findings.length,
    criticalFindingsCount: findings.filter((finding) => String(finding.severity || '').toLowerCase() === 'critical').length,
    mainDriver: highest?.title || undefined,
  };
}

function groupFindingsByRecordId(findings = []) {
  return findings.reduce((acc, finding) => {
    const key = String(finding.service_record_id || finding.serviceRecordId || '');
    if (!key) return acc;
    if (!acc[key]) acc[key] = [];
    acc[key].push(finding);
    return acc;
  }, {});
}

function buildCustomerSummary({ direction, percentChange, baseline, current }) {
  if (direction === 'first_visit') {
    return current?.pressureIndex != null
      ? `This is your first pressure marker: ${current.pressureIndex.toFixed(1)}. Future reports will show the trend.`
      : 'This is your first pressure reading. Future reports will show the trend.';
  }
  if (!baseline || !current) return 'Pressure trend will appear after more visits.';
  if (current.pressureIndex < 1) {
    return `Pest pressure remains low at ${current.pressureIndex.toFixed(1)}.`;
  }
  if (baseline.pressureIndex < 1 && direction === 'up') {
    return 'Pest pressure increased this visit. We treated the active zones and will continue monitoring.';
  }
  if (baseline.pressureIndex < 1) {
    return `Pest pressure remains low at ${current.pressureIndex.toFixed(1)}.`;
  }
  if (direction === 'down') {
    return percentChange != null
      ? `Pest pressure is down ${percentChange}% since your first WaveGuard service.`
      : 'Pest pressure is down since your first WaveGuard service.';
  }
  if (direction === 'flat') return 'Pest pressure remains steady and low.';
  if (direction === 'up') {
    return 'Pest pressure increased this visit. We treated the active zones and will continue monitoring.';
  }
  return 'Pressure trend will appear after more visits.';
}

function buildPressureTrendContextFromRows({
  record,
  priorRows = [],
  findings = [],
  currentPressureIndexOverride,
  limit = 4,
} = {}) {
  if (!record?.id) return undefined;
  const currentPressureIndex = pressureNumber(
    currentPressureIndexOverride !== undefined ? currentPressureIndexOverride : record.pressure_index,
  );
  const findingsByRecordId = groupFindingsByRecordId(findings);
  const rows = [
    ...(Array.isArray(priorRows) ? priorRows : []),
    ...(currentPressureIndex != null ? [{ ...record, pressure_index: currentPressureIndex }] : []),
  ];

  const points = rows
    .map((row) => pointFromRow(row, findingsByRecordId[String(row.id)] || []))
    .filter((point) => point.pressureIndex != null)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .slice(-limit);

  if (!points.length) return undefined;

  const baseline = points[0];
  const current = points[points.length - 1];
  const delta = points.length >= 2 ? round1(current.pressureIndex - baseline.pressureIndex) : undefined;
  const percentChange = points.length >= 2 && baseline.pressureIndex >= 1
    ? Math.round(((baseline.pressureIndex - current.pressureIndex) / baseline.pressureIndex) * 100)
    : undefined;

  let direction = 'unknown';
  if (points.length < 2) direction = 'first_visit';
  else if (Math.abs(delta) < 0.1) direction = 'flat';
  else if (delta < 0) direction = 'down';
  else direction = 'up';

  return {
    points,
    baseline,
    current,
    delta,
    percentChange,
    direction,
    customerSummary: buildCustomerSummary({ direction, percentChange, baseline, current }),
    tooltipSummary: current.mainDriver ? `Current driver: ${current.mainDriver}` : undefined,
  };
}

async function buildPressureTrendContext({
  record,
  currentPressureIndexOverride,
  limit = 4,
  beforeDate,
  knex = db,
} = {}) {
  if (!record?.id || !record.customer_id) return undefined;
  const serviceLine = record.service_line || detectServiceLine(record.service_type);
  const priorRows = await knex('service_records')
    .select('id', 'started_at', 'ended_at', 'service_date', 'created_at', 'pressure_index')
    .where({ customer_id: record.customer_id, status: 'completed' })
    .whereNot({ id: record.id })
    // Optional: restrict the trend to visits strictly before a given service date,
    // so a backfilled/late report doesn't fold in later visits. Default: no bound.
    .modify((q) => { if (beforeDate) q.where('service_date', '<', beforeDate); })
    .whereNotNull('pressure_index')
    .where(function sameServiceLine() {
      this.where({ service_line: serviceLine })
        .orWhere(function legacyType() {
          this.whereNull('service_line').where({ service_type: record.service_type });
        });
    })
    .orderBy('service_date', 'desc')
    .orderBy('started_at', 'desc')
    .limit(Math.max(0, limit - 1))
    .catch(() => []);

  const ids = [...priorRows.map((row) => row.id), record.id].filter(Boolean);
  const findings = ids.length
    ? await knex('service_findings')
      .whereIn('service_record_id', ids)
      .select('service_record_id', 'severity', 'title')
      .catch(() => [])
    : [];

  return buildPressureTrendContextFromRows({
    record,
    priorRows,
    findings,
    currentPressureIndexOverride,
    limit,
  });
}

module.exports = {
  buildPressureTrendContext,
  buildPressureTrendContextFromRows,
  buildCustomerSummary,
  SEVERITY_RANK,
};
