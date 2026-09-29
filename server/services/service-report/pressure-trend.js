const db = require('../../models/db');
const { reserviceReportCopyGateOn } = require('./reservice-report');
const { detectServiceLine } = require('./service-line-configs');
const { dateOnlyToNoonUtc, formatVisitLabel, normalizeDate } = require('./time-format');
const { customerVisiblePressureIndex } = require('../pest-pressure/display');
const {
  SCALE_TECHNICIAN_RATING,
  SCALE_BLENDED,
  SCALE_UNKNOWN,
  loadScaleMap,
  scaleWithoutProvenance,
  isComparable,
} = require('../pest-pressure/score-scale');

// Readings recorded before/after the #4741 tech-rating cutover sit on
// different scales (see pest-pressure/score-scale.js) and are never compared
// or charted together.

const PRIOR_SCAN_LIMIT = 25; // same bound as store.loadPreviousScore

function pressureScaleOf(row) {
  if ([SCALE_TECHNICIAN_RATING, SCALE_BLENDED, SCALE_UNKNOWN].includes(row?.pressure_scale)) {
    return row.pressure_scale;
  }
  // No provenance: blended before the cutover, unknown (fail closed) after it.
  return scaleWithoutProvenance(serviceStartedAt(row));
}

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
  // service_date is DATE-only: anchored at noon UTC so the NY-formatted
  // visit label can't roll back a day for rows without a real timestamp.
  const date = normalizeDate(row?.started_at)
    || normalizeDate(row?.ended_at)
    || dateOnlyToNoonUtc(row?.service_date)
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
    scale: pressureScaleOf(row),
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
  // 'rescaled': earlier visits exist but were scored on the pre-#4741 scale,
  // so there is nothing comparable yet. Not a first visit, and no up/down.
  if (direction === 'rescaled') return 'Pressure trend will appear after more visits.';
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
    // baseline is the oldest of the last `limit` visits (the series is
    // sliced to a recent window and we only fetch limit-1 priors), so it is
    // NOT necessarily the customer's first-ever service — word it honestly.
    return percentChange != null
      ? `Pest pressure is down ${percentChange}% over your recent visits.`
      : 'Pest pressure is down over your recent visits.';
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

  const dated = rows
    .map((row) => pointFromRow(row, findingsByRecordId[String(row.id)] || []))
    .filter((point) => point.pressureIndex != null)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  // Only readings on the newest reading's scale are comparable (and chartable):
  // when the newest is a technician tap and every earlier one is a pre-#4741
  // blended score, the series is just the newest point - never a fake up/down
  // and never a fake jump on the report chart. Those earlier visits DO exist,
  // so this is not a first visit either: direction 'rescaled' (below).
  const newest = dated[dated.length - 1];
  const points = dated
    .filter((point) => point === newest || isComparable(point.scale, newest?.scale))
    .slice(-limit)
    .map(({ scale, ...point }) => point);

  if (!points.length) return undefined;

  const baseline = points[0];
  const current = points[points.length - 1];
  const delta = points.length >= 2 ? round1(current.pressureIndex - baseline.pressureIndex) : undefined;
  const percentChange = points.length >= 2 && baseline.pressureIndex >= 1
    ? Math.round(((baseline.pressureIndex - current.pressureIndex) / baseline.pressureIndex) * 100)
    : undefined;

  let direction = 'unknown';
  if (points.length < 2) direction = dated.length > points.length ? 'rescaled' : 'first_visit';
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
  beforeStartedAt,
  knex = db,
} = {}) {
  if (!record?.id || !record.customer_id) return undefined;
  const serviceLine = record.service_line || detectServiceLine(record.service_type);
  const priorRows = await knex('service_records')
    .select('id', 'started_at', 'ended_at', 'service_date', 'created_at', 'pressure_index')
    .where({ customer_id: record.customer_id, status: 'completed' })
    .whereNot({ id: record.id })
    // Customer-facing trend line: callback visits are not data points while
    // the re-service gate is on (owner-delegated ruling 2026-08-30, #3623);
    // pest-pressure SCORING elsewhere still counts them by design.
    .modify((q) => {
      if (reserviceReportCopyGateOn()) {
        q.where(function notCallback() {
          this.where('is_callback', false).orWhereNull('is_callback');
        });
      }
    })
    // Optional: restrict the trend to visits before a given service date, so a
    // permanent token doesn't fold in later visits. beforeStartedAt keeps
    // legitimate same-day EARLIER visits (a morning visit before an afternoon
    // revisit) via the same started_at tie-break since-last-visit uses
    // (codex P2 #2797). Default: no bound.
    .modify((q) => {
      if (!beforeDate) return;
      q.where(function beforeBoundary() {
        this.where('service_date', '<', beforeDate);
        if (beforeStartedAt) {
          this.orWhere(function sameDayEarlier() {
            this.where('service_date', beforeDate).where('started_at', '<', beforeStartedAt);
          });
        }
      });
    })
    .whereNotNull('pressure_index')
    .where(function sameServiceLine() {
      this.where({ service_line: serviceLine })
        .orWhere(function legacyType() {
          this.whereNull('service_line').where({ service_type: record.service_type });
        });
    })
    .orderBy('service_date', 'desc')
    .orderBy('started_at', 'desc')
    // Fetch a bounded window wider than the chart needs: the scale filter runs
    // afterwards, and alternating tap/blended visits would otherwise starve
    // the comparable older readings out of a limit-1 window.
    .limit(limit > 1 ? Math.max(limit - 1, PRIOR_SCAN_LIMIT) : 0)
    .catch(() => []);

  const ids = [...priorRows.map((row) => row.id), record.id].filter(Boolean);
  const scales = await loadScaleMap(knex, ids);
  const withScale = (row) => (scales.has(String(row.id)) ? { ...row, pressure_scale: scales.get(String(row.id)) } : row);
  const findings = ids.length
    ? await knex('service_findings')
      .whereIn('service_record_id', ids)
      .select('service_record_id', 'severity', 'title')
      .catch(() => [])
    : [];

  return buildPressureTrendContextFromRows({
    record: withScale(record),
    priorRows: priorRows.map(withScale),
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
