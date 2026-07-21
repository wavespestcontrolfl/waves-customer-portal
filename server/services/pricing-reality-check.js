const db = require('../models/db');
const { etParts, parseETDateTime } = require('../utils/datetime-et');
const { minutesFromElapsed } = require('../utils/duration-minutes');

const LABOR_RATE_DOLLARS_PER_HOUR = 35;
const DEFAULT_LOOKBACK_DAYS = 90;
const ALLOWED_LOOKBACK_DAYS = new Set([30, 90, 365]);
const DEFAULT_GROUP_BY = 'service_type';
const GROUP_BY_OPTIONS = [
  'service_type',
  'lawn_care_track',
  'sqft_band',
  'zone',
  'technician',
  'month',
  'billing_cohort',
];
const GROUP_BY_SET = new Set(GROUP_BY_OPTIONS);
const DEFAULT_OUTLIER_LIMIT = 50;
const MAX_OUTLIER_LIMIT = 200;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const SQFT_BANDS = [
  { key: 'Unknown', label: 'Unknown', min: null, max: null },
  { key: '< 2,500', label: '< 2,500', min: 0, max: 2499 },
  { key: '2,500-4,999', label: '2,500-4,999', min: 2500, max: 4999 },
  { key: '5,000-7,499', label: '5,000-7,499', min: 5000, max: 7499 },
  { key: '7,500-7,999', label: '7,500-7,999', min: 7500, max: 7999 },
  { key: '8,000-8,499', label: '8,000-8,499', min: 8000, max: 8499 },
  { key: '8,500-9,999', label: '8,500-9,999', min: 8500, max: 9999 },
  { key: '10,000-14,999', label: '10,000-14,999', min: 10000, max: 14999 },
  { key: '15,000-19,999', label: '15,000-19,999', min: 15000, max: 19999 },
  { key: '20,000+', label: '20,000+', min: 20000, max: Infinity },
];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function parsePositiveInt(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function validateLookbackDays(value) {
  if (value == null || value === '') return DEFAULT_LOOKBACK_DAYS;
  const n = Number.parseInt(value, 10);
  if (!ALLOWED_LOOKBACK_DAYS.has(n)) {
    throw badRequest('lookbackDays must be one of 30, 90, or 365');
  }
  return n;
}

function validateGroupBy(value) {
  if (value == null || value === '') return DEFAULT_GROUP_BY;
  const groupBy = String(value);
  if (!GROUP_BY_SET.has(groupBy)) {
    throw badRequest(`groupBy must be one of: ${GROUP_BY_OPTIONS.join(', ')}`);
  }
  return groupBy;
}

function stringOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function parsePricingRealityCheckQuery(query = {}) {
  return {
    lookbackDays: validateLookbackDays(query.lookbackDays),
    groupBy: validateGroupBy(query.groupBy),
    filters: {
      serviceType: stringOrNull(query.serviceType),
      lawnCareTrack: stringOrNull(query.lawnCareTrack),
      sqftBand: stringOrNull(query.sqftBand),
      zoneId: stringOrNull(query.zoneId),
      technicianId: stringOrNull(query.technicianId),
      month: stringOrNull(query.month),
      billingCohort: stringOrNull(query.billingCohort),
    },
    outlierLimit: parsePositiveInt(query.outlierLimit, DEFAULT_OUTLIER_LIMIT, MAX_OUTLIER_LIMIT),
  };
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n != null && n > 0) return n;
  }
  return null;
}

function parseReportDate(value) {
  if (value instanceof Date) return value;
  const text = typeof value === 'string' ? value.trim() : null;
  if (DATE_ONLY_RE.test(text || '')) {
    return parseETDateTime(`${text}T12:00`);
  }
  return parseETDateTime(value);
}

function firstFiniteDate(...values) {
  for (const value of values) {
    if (!value) continue;
    const d = parseReportDate(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function minutesBetween(start, end) {
  const a = firstFiniteDate(start);
  const b = firstFiniteDate(end);
  if (!a || !b) return null;
  return (b.getTime() - a.getTime()) / 60000;
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function serviceFamily(value) {
  const text = normalizeKey(value);
  if (!text) return 'unknown';
  if (/\blawn|turf|grass|weed|fertil|dethatch|top dress|overseed|plug/.test(text)) return 'lawn_care';
  if (/\bmosquito/.test(text)) return 'mosquito';
  if (/\btree|shrub|palm/.test(text)) return 'tree_shrub';
  if (/\btermite|bait station|termidor|bora/.test(text)) return 'termite';
  if (/\brodent|rat|mouse|exclusion/.test(text)) return 'rodent';
  if (/\bflea/.test(text)) return 'flea';
  if (/\broach|cockroach/.test(text)) return 'roach';
  if (/\bpest|perimeter/.test(text)) return 'pest_control';
  return text.replace(/\s+/g, '_');
}

function candidateMinuteFields(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return [
    obj.quotedMinutes,
    obj.quoted_minutes,
    obj.estimatedMinutes,
    obj.estimated_minutes,
    obj.onSiteMin,
    obj.on_site_min,
    obj.durationMin,
    obj.duration_min,
    obj.durationMinutes,
    obj.duration_minutes,
    obj.defaultDurationMinutes,
    obj.default_duration_minutes,
    obj.productionDiagnostics?.estimatedMinutes,
    obj.production_diagnostics?.estimatedMinutes,
  ];
}

function serviceLineMatches(line, serviceType) {
  const targetFamily = serviceFamily(serviceType);
  const fields = [
    line?.service,
    line?.service_type,
    line?.key,
    line?.name,
    line?.label,
    line?.serviceName,
    line?.service_name,
  ].filter(Boolean);
  if (!fields.length) return false;
  return fields.some((field) => {
    const source = normalizeKey(field);
    const target = normalizeKey(serviceType);
    return source === target ||
      source.includes(target) ||
      target.includes(source) ||
      serviceFamily(field) === targetFamily;
  });
}

function collectEstimateLineItems(result = {}) {
  return [
    ...(Array.isArray(result.lineItems) ? result.lineItems : []),
    ...(Array.isArray(result.results?.lineItems) ? result.results.lineItems : []),
    ...(Array.isArray(result.recurring?.services) ? result.recurring.services : []),
    ...(Array.isArray(result.results?.recurring?.services) ? result.results.recurring.services : []),
    ...(Array.isArray(result.oneTime?.items) ? result.oneTime.items : []),
    ...(Array.isArray(result.oneTime?.specItems) ? result.oneTime.specItems : []),
    ...(Array.isArray(result.results?.oneTime?.items) ? result.results.oneTime.items : []),
  ];
}

function extractQuotedMinutesFromEstimate(estimateData, serviceType) {
  const data = parseJson(estimateData);
  if (!data) return null;
  const result = data.result || data.engineResult || data;
  const direct = firstPositiveNumber(
    ...candidateMinuteFields(data),
    ...candidateMinuteFields(result),
  );
  const directMatchesService = serviceLineMatches(data, serviceType) || serviceLineMatches(result, serviceType);

  const lines = collectEstimateLineItems(result);
  const matchingLines = lines.filter((line) => serviceLineMatches(line, serviceType));
  for (const line of matchingLines) {
    const n = firstPositiveNumber(...candidateMinuteFields(line));
    if (n != null) return n;
  }

  if (serviceFamily(serviceType) === 'pest_control') {
    const pestDiagnostics = firstPositiveNumber(
      result.productionDiagnostics?.estimatedMinutes,
      result.results?.pest?.productionDiagnostics?.estimatedMinutes,
      result.results?.pest_control?.productionDiagnostics?.estimatedMinutes,
    );
    if (pestDiagnostics != null) return pestDiagnostics;
  }

  if (matchingLines.length === 0 && lines.length === 1) {
    const onlyLineMinutes = firstPositiveNumber(...candidateMinuteFields(lines[0]));
    if (onlyLineMinutes != null) return onlyLineMinutes;
  }

  if (direct != null && (lines.length === 0 || directMatchesService)) {
    return direct;
  }

  return null;
}

function resolveQuotedMinutes(row) {
  const fromEstimate = extractQuotedMinutesFromEstimate(row.estimate_data, row.service_type);
  return firstPositiveNumber(fromEstimate, row.estimated_duration_minutes);
}

// Backdated quiet closeout marker (structured_notes.backfill — frozen by the
// completion transaction; the same durable read job-costing keys its
// untrusted-span policy off). A backfilled row's lifecycle timestamps are
// artifacts of the forgotten closeout: the duration policies strip its end
// stamps, but the row KEEPS its real stale start (historical truth) and —
// since PR #2897 fix round 9 — a day-scale completed_at (ET noon of the
// service day, so Billing Recovery's completed_at window can see the visit).
// Pairing that kept start against the noon instant (or any surviving stamp)
// at read time would fabricate an on-site duration, so for marked rows the
// minutesBetween fallback rungs are skipped entirely: the only trusted
// durations are operator/clock statements, which all live in the persisted
// tier (service_time_minutes / actual_duration_minutes from the typed
// duration, summed time_entry_minutes, structured timeOnSite). A marked row
// with none of those reads as missing_actual — the honest unknown.
function isBackfilledServiceRecordRow(row) {
  return parseJson(row.service_record_structured_notes)?.backfill === true;
}

function resolveActualMinutes(row) {
  const persisted = firstPositiveNumber(
    row.service_time_minutes,
    row.actual_duration_minutes,
    row.time_entry_minutes,
    serviceRecordTimeOnSiteMinutes(row),
  );
  if (persisted != null) return persisted;
  if (isBackfilledServiceRecordRow(row)) return null;

  return firstPositiveNumber(
    minutesBetween(row.actual_start_time, row.actual_end_time),
    minutesBetween(row.check_in_time, row.check_out_time),
    minutesBetween(row.arrived_at, row.completed_at),
    minutesBetween(row.time_entry_clock_in, row.time_entry_clock_out),
    minutesBetween(row.service_record_started_at, row.service_record_ended_at),
  );
}

function hasInvalidActualDuration(row) {
  // Backfilled rows: judge only the persisted statements — a fabricated
  // negative pair (stale start after the noon instant) must not reclassify
  // the honest unknown as invalid_duration.
  const pairs = isBackfilledServiceRecordRow(row) ? [] : [
    minutesBetween(row.actual_start_time, row.actual_end_time),
    minutesBetween(row.check_in_time, row.check_out_time),
    minutesBetween(row.arrived_at, row.completed_at),
    minutesBetween(row.time_entry_clock_in, row.time_entry_clock_out),
    minutesBetween(row.service_record_started_at, row.service_record_ended_at),
  ];
  return [
    row.service_time_minutes,
    row.actual_duration_minutes,
    row.time_entry_minutes,
    serviceRecordTimeOnSiteMinutes(row),
    ...pairs,
  ].some((value) => {
    const n = finiteNumber(value);
    return n != null && n <= 0;
  });
}

function serviceRecordTimeOnSiteMinutes(row) {
  const notes = parseJson(row.service_record_structured_notes);
  return minutesFromElapsed(notes?.timeOnSite);
}

function sqftBand(value) {
  const sqft = finiteNumber(value);
  if (sqft == null || sqft < 0) return 'Unknown';
  if (sqft < 2500) return '< 2,500';
  if (sqft < 5000) return '2,500-4,999';
  if (sqft < 7500) return '5,000-7,499';
  if (sqft < 8000) return '7,500-7,999';
  if (sqft < 8500) return '8,000-8,499';
  if (sqft < 10000) return '8,500-9,999';
  if (sqft < 15000) return '10,000-14,999';
  if (sqft < 20000) return '15,000-19,999';
  return '20,000+';
}

function displayLabel(value) {
  const text = stringOrNull(value);
  if (!text) return 'Unknown';
  return text
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function monthKey(date) {
  const d = firstFiniteDate(date);
  if (!d) return null;
  const { year, month } = etParts(d);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function resolveLawnCareTrack(row, estimateData) {
  if (row.turf_track_key) return displayLabel(row.turf_track_key);
  const data = parseJson(estimateData);
  const result = data?.result || data?.engineResult || data || {};
  const lawnLines = collectEstimateLineItems(result).filter((line) => serviceFamily(line?.service || line?.name || line?.label) === 'lawn_care');
  for (const line of lawnLines) {
    const track = stringOrNull(line.track || line.trackKey || line.grassCode || line.grassType);
    if (track) return displayLabel(track);
  }
  const raw = stringOrNull(row.lawn_type);
  return raw ? displayLabel(raw) : 'Unknown';
}

function resolveSquareFeet(row) {
  const data = parseJson(row.estimate_data);
  const result = data?.result || data?.engineResult || {};
  const property = result.property || data?.inputs || data?.engineInputs || {};
  return firstPositiveNumber(
    row.turf_lawn_sqft,
    row.property_sqft,
    property.lawnSqFt,
    property.turfSf,
    property.estimatedTurfSf,
    property.estimatedTurfSqFt,
    data?.inputs?.lawnSqFt,
    data?.engineInputs?.lawnSqFt,
    row.lot_sqft,
  );
}

function billingCohort(row) {
  if (row.annual_prepay_term_id || row.annual_prepay_status || row.payment_method_preference === 'prepay_annual') {
    return 'Annual Prepay';
  }
  const data = parseJson(row.estimate_data);
  const frequency = data?.customerSelection?.frequency || data?.preferences?.billingTerm || data?.billingTerm;
  if (frequency === 'prepay_annual') return 'Annual Prepay';
  return 'Standard';
}

function normalizeServiceRow(row) {
  const completedAt = firstFiniteDate(
    row.completed_at,
    row.actual_end_time,
    row.check_out_time,
    row.time_entry_clock_out,
    row.service_record_ended_at,
    row.scheduled_date,
  );
  const quotedMinutes = resolveQuotedMinutes(row);
  const actualMinutes = resolveActualMinutes(row);
  const varianceMinutes = actualMinutes != null && quotedMinutes != null
    ? actualMinutes - quotedMinutes
    : null;
  const sqft = resolveSquareFeet(row);
  const serviceType = stringOrNull(row.service_type) || 'Unknown';
  const lawnCareTrack = resolveLawnCareTrack(row, row.estimate_data);
  const zone = stringOrNull(row.zone) || 'Unknown';
  const technician = stringOrNull(row.technician_name) || 'Unassigned';
  const month = monthKey(completedAt);
  const cohort = billingCohort(row);

  let exclusionReason = null;
  if (quotedMinutes == null || quotedMinutes <= 0) exclusionReason = 'missing_quote';
  else if (actualMinutes == null) exclusionReason = hasInvalidActualDuration(row) ? 'invalid_duration' : 'missing_actual';
  else if (!Number.isFinite(actualMinutes) || actualMinutes <= 0) exclusionReason = 'invalid_duration';
  else if (!Number.isFinite(varianceMinutes)) exclusionReason = 'invalid_duration';

  return {
    serviceId: row.service_id,
    completedAt: completedAt ? completedAt.toISOString() : null,
    serviceType,
    lawnCareTrack,
    sqftValue: sqft,
    sqftBand: sqftBand(sqft),
    zoneId: stringOrNull(row.zone) || 'unknown',
    zone,
    technicianId: row.technician_id || 'unassigned',
    technician,
    quotedMinutes,
    actualMinutes,
    varianceMinutes,
    percentVariance: quotedMinutes && varianceMinutes != null ? (varianceMinutes / quotedMinutes) * 100 : null,
    dollarMarginImpact: quotedMinutes != null && actualMinutes != null
      ? ((quotedMinutes - actualMinutes) / 60) * LABOR_RATE_DOLLARS_PER_HOUR
      : null,
    propertyId: null,
    customerId: row.customer_id || null,
    customerName: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null,
    propertyLabel: [row.address_line1, row.city].filter(Boolean).join(', ') || null,
    billingCohort: cohort,
    month,
    exclusionReason,
  };
}

function serviceMetric(row) {
  const varianceMinutes = row.actualMinutes - row.quotedMinutes;
  return {
    ...row,
    varianceMinutes,
    percentVariance: (varianceMinutes / row.quotedMinutes) * 100,
    dollarMarginImpact: ((row.quotedMinutes - row.actualMinutes) / 60) * LABOR_RATE_DOLLARS_PER_HOUR,
  };
}

function aggregateMetrics(rows) {
  const serviceCount = rows.length;
  const sumQuoted = rows.reduce((sum, row) => sum + row.quotedMinutes, 0);
  const sumActual = rows.reduce((sum, row) => sum + row.actualMinutes, 0);
  const sumVariance = rows.reduce((sum, row) => sum + row.varianceMinutes, 0);
  const totalDollarMarginImpact = rows.reduce((sum, row) => sum + row.dollarMarginImpact, 0);
  return {
    serviceCount,
    avgQuotedMinutes: serviceCount ? sumQuoted / serviceCount : 0,
    avgActualMinutes: serviceCount ? sumActual / serviceCount : 0,
    avgVarianceMinutes: serviceCount ? sumVariance / serviceCount : 0,
    weightedPercentVariance: sumQuoted > 0 ? (sumVariance / sumQuoted) * 100 : 0,
    totalDollarMarginImpact,
    avgDollarMarginImpact: serviceCount ? totalDollarMarginImpact / serviceCount : 0,
    outlierCount: rows.filter((row) => row.isOutlier).length,
  };
}

function withOutliers(rows) {
  if (rows.length < 3) {
    return rows.map((row) => ({ ...row, zScore: null, isOutlier: false }));
  }
  const mean = rows.reduce((sum, row) => sum + row.varianceMinutes, 0) / rows.length;
  const variance = rows.reduce((sum, row) => {
    const diff = row.varianceMinutes - mean;
    return sum + diff * diff;
  }, 0) / (rows.length - 1);
  const stddev = Math.sqrt(variance);
  if (!Number.isFinite(stddev) || stddev === 0) {
    return rows.map((row) => ({ ...row, zScore: null, isOutlier: false }));
  }
  return rows.map((row) => {
    const zScore = (row.varianceMinutes - mean) / stddev;
    return { ...row, zScore, isOutlier: Math.abs(zScore) > 2 };
  });
}

function groupValue(row, groupBy) {
  switch (groupBy) {
    case 'service_type':
      return { key: row.serviceType || 'Unknown', label: row.serviceType || 'Unknown' };
    case 'lawn_care_track':
      return { key: row.lawnCareTrack || 'Unknown', label: row.lawnCareTrack || 'Unknown' };
    case 'sqft_band':
      return { key: row.sqftBand || 'Unknown', label: row.sqftBand || 'Unknown' };
    case 'zone':
      return { key: row.zoneId || 'unknown', label: row.zone || 'Unknown' };
    case 'technician':
      return { key: row.technicianId || 'unassigned', label: row.technician || 'Unassigned' };
    case 'month':
      return { key: row.month || 'Unknown', label: row.month || 'Unknown' };
    case 'billing_cohort':
      return { key: row.billingCohort || 'Unknown', label: row.billingCohort || 'Unknown' };
    default:
      return { key: row.serviceType || 'Unknown', label: row.serviceType || 'Unknown' };
  }
}

function aggregateSegments(rows, groupBy) {
  const groups = new Map();
  for (const row of rows) {
    const group = groupValue(row, groupBy);
    if (!groups.has(group.key)) groups.set(group.key, { ...group, rows: [] });
    groups.get(group.key).rows.push(row);
  }
  return Array.from(groups.values())
    .map((group) => ({
      key: group.key,
      label: group.label,
      ...aggregateMetrics(group.rows),
    }))
    .sort((a, b) => a.totalDollarMarginImpact - b.totalDollarMarginImpact);
}

function filterRows(rows, filters = {}) {
  return rows.filter((row) => {
    if (filters.serviceType && row.serviceType !== filters.serviceType) return false;
    if (filters.lawnCareTrack && row.lawnCareTrack !== filters.lawnCareTrack) return false;
    if (filters.sqftBand && row.sqftBand !== filters.sqftBand) return false;
    if (filters.zoneId && row.zoneId !== filters.zoneId) return false;
    if (filters.technicianId && row.technicianId !== filters.technicianId) return false;
    if (filters.month && row.month !== filters.month) return false;
    if (filters.billingCohort && row.billingCohort !== filters.billingCohort) return false;
    return true;
  });
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function uniqueObjects(rows, idKey, labelKey) {
  const map = new Map();
  for (const row of rows) {
    const id = row[idKey];
    if (!id || id === 'unknown' || id === 'unassigned') continue;
    if (!map.has(id)) map.set(id, { id, label: row[labelKey] || id });
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function buildAvailableFilters(rows) {
  return {
    serviceTypes: uniqueSorted(rows.map((row) => row.serviceType)),
    lawnCareTracks: uniqueSorted(rows.map((row) => row.lawnCareTrack)),
    sqftBands: SQFT_BANDS.map((band) => band.key),
    zones: uniqueObjects(rows, 'zoneId', 'zone'),
    technicians: uniqueObjects(rows, 'technicianId', 'technician'),
    months: uniqueSorted(rows.map((row) => row.month)).reverse(),
    billingCohorts: uniqueSorted(rows.map((row) => row.billingCohort)),
  };
}

function coverageFor(rows) {
  return {
    completedServiceCount: rows.length,
    includedServiceCount: rows.filter((row) => !row.exclusionReason).length,
    excludedMissingQuoteCount: rows.filter((row) => row.exclusionReason === 'missing_quote').length,
    excludedMissingActualCount: rows.filter((row) => row.exclusionReason === 'missing_actual').length,
    excludedInvalidDurationCount: rows.filter((row) => row.exclusionReason === 'invalid_duration').length,
  };
}

function shapeOutlier(row) {
  return {
    serviceId: row.serviceId,
    completedAt: row.completedAt,
    serviceType: row.serviceType,
    lawnCareTrack: row.lawnCareTrack,
    sqftBand: row.sqftBand,
    zone: row.zone,
    technician: row.technician,
    quotedMinutes: row.quotedMinutes,
    actualMinutes: row.actualMinutes,
    varianceMinutes: row.varianceMinutes,
    percentVariance: row.percentVariance,
    dollarMarginImpact: row.dollarMarginImpact,
    zScore: row.zScore,
    propertyId: row.propertyId,
    customerId: row.customerId,
    customerName: row.customerName,
    propertyLabel: row.propertyLabel,
    billingCohort: row.billingCohort,
  };
}

function buildPricingRealityCheckFromRows(rows, params = {}) {
  const lookbackDays = params.lookbackDays || DEFAULT_LOOKBACK_DAYS;
  const groupBy = params.groupBy || DEFAULT_GROUP_BY;
  const outlierLimit = params.outlierLimit || DEFAULT_OUTLIER_LIMIT;
  const normalized = rows.map(normalizeServiceRow);
  const availableFilters = buildAvailableFilters(normalized);
  const filtered = filterRows(normalized, params.filters || {});
  const coverage = coverageFor(filtered);
  const included = withOutliers(
    filtered
      .filter((row) => !row.exclusionReason)
      .map(serviceMetric),
  );
  const summary = aggregateMetrics(included);
  const segments = aggregateSegments(included, groupBy);
  const outliers = included
    .filter((row) => row.isOutlier)
    .sort((a, b) => Math.abs(b.zScore || 0) - Math.abs(a.zScore || 0))
    .slice(0, outlierLimit)
    .map(shapeOutlier);

  return {
    lookbackDays,
    laborRateDollarsPerHour: LABOR_RATE_DOLLARS_PER_HOUR,
    generatedAt: new Date().toISOString(),
    coverage,
    summary,
    segments,
    outliers,
    availableFilters,
  };
}

async function fetchPricingRealityRows({ lookbackDays }) {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const timeEntries = db('time_entries')
    .select('job_id')
    .sum({ time_entry_minutes: 'duration_minutes' })
    .min({ time_entry_clock_in: 'clock_in' })
    .max({ time_entry_clock_out: 'clock_out' })
    .where({ entry_type: 'job' })
    .whereIn('status', ['completed', 'edited'])
    .whereNotNull('job_id')
    .groupBy('job_id')
    .as('te');
  const serviceRecords = db.raw(`(
    SELECT DISTINCT ON (scheduled_service_id)
      scheduled_service_id,
      started_at AS service_record_started_at,
      ended_at AS service_record_ended_at,
      structured_notes AS service_record_structured_notes
    FROM service_records
    WHERE scheduled_service_id IS NOT NULL
    ORDER BY scheduled_service_id, created_at DESC
  ) AS sr`);

  return db('scheduled_services as s')
    .leftJoin(timeEntries, 'te.job_id', 's.id')
    .leftJoin(serviceRecords, 'sr.scheduled_service_id', 's.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .leftJoin('technicians as tech', 's.technician_id', 'tech.id')
    .leftJoin('estimates as e', 's.source_estimate_id', 'e.id')
    .leftJoin('annual_prepay_terms as apt', 's.annual_prepay_term_id', 'apt.id')
    .leftJoin('customer_turf_profiles as turf', function joinTurf() {
      this.on('turf.customer_id', '=', 's.customer_id')
        .andOn('turf.active', '=', db.raw('?', [true]));
    })
    .where('s.status', 'completed')
    .whereRaw(
      'COALESCE(s.completed_at, s.actual_end_time, s.check_out_time, te.time_entry_clock_out, sr.service_record_ended_at, s.scheduled_date::timestamp) >= ?',
      [cutoff],
    )
    .select({
      service_id: 's.id',
      customer_id: 's.customer_id',
      technician_id: 's.technician_id',
      scheduled_date: 's.scheduled_date',
      service_type: 's.service_type',
      status: 's.status',
      zone: 's.zone',
      estimated_duration_minutes: 's.estimated_duration_minutes',
      actual_duration_minutes: 's.actual_duration_minutes',
      service_time_minutes: 's.service_time_minutes',
      actual_start_time: 's.actual_start_time',
      actual_end_time: 's.actual_end_time',
      check_in_time: 's.check_in_time',
      check_out_time: 's.check_out_time',
      arrived_at: 's.arrived_at',
      completed_at: 's.completed_at',
      payment_method_preference: 's.payment_method_preference',
      annual_prepay_term_id: 's.annual_prepay_term_id',
      estimate_data: 'e.estimate_data',
      first_name: 'c.first_name',
      last_name: 'c.last_name',
      address_line1: 'c.address_line1',
      city: 'c.city',
      lawn_type: 'c.lawn_type',
      property_sqft: 'c.property_sqft',
      lot_sqft: 'c.lot_sqft',
      technician_name: 'tech.name',
      turf_track_key: 'turf.track_key',
      turf_lawn_sqft: 'turf.lawn_sqft',
      annual_prepay_status: 'apt.status',
      time_entry_minutes: 'te.time_entry_minutes',
      time_entry_clock_in: 'te.time_entry_clock_in',
      time_entry_clock_out: 'te.time_entry_clock_out',
      service_record_started_at: 'sr.service_record_started_at',
      service_record_ended_at: 'sr.service_record_ended_at',
      service_record_structured_notes: 'sr.service_record_structured_notes',
    });
}

async function getPricingRealityCheck(params) {
  const rows = await fetchPricingRealityRows({ lookbackDays: params.lookbackDays });
  return buildPricingRealityCheckFromRows(rows, params);
}

module.exports = {
  LABOR_RATE_DOLLARS_PER_HOUR,
  GROUP_BY_OPTIONS,
  SQFT_BANDS,
  aggregateMetrics,
  buildPricingRealityCheckFromRows,
  extractQuotedMinutesFromEstimate,
  getPricingRealityCheck,
  parsePricingRealityCheckQuery,
  resolveActualMinutes,
  resolveQuotedMinutes,
  serviceMetric,
  sqftBand,
  validateGroupBy,
  validateLookbackDays,
  withOutliers,
};
