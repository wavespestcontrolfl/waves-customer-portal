const db = require('../models/db');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

function parseMaybeJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function normalizeReasons(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseStoredJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function lotBand(lotSqFt) {
  const lot = Number(lotSqFt) || 0;
  if (!lot) return 'unknown';
  if (lot < 10000) return '<10k';
  if (lot < 20000) return '10k-20k';
  if (lot < 40000) return '20k-40k';
  return '40k+';
}

function normalizeServiceDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return etDateString(value);
  return String(value).slice(0, 10);
}

function parseEstimateActivityDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const raw = value.trim();
    const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(raw);
    if (dateOnly) return parseETDateTime(`${dateOnly[1]}T12:00`);

    const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(raw);
    if (naive) return parseETDateTime(`${naive[1]}T${naive[2]}:${naive[3] || '00'}`);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeEstimateActivityDate(value) {
  const parsed = parseEstimateActivityDateTime(value);
  if (parsed) return etDateString(parsed);
  return String(value).slice(0, 10);
}

function hasProductionDiagnostics(estimateData) {
  const { diagnostics } = extractEstimatePayload(estimateData);
  return !!(diagnostics && diagnostics.estimatedMinutes != null);
}

function estimateIncludesPestService(estimateData) {
  const parsed = parseMaybeJson(estimateData);
  const result = parsed.result || parsed.engineResult || parsed;
  const inputs = parsed.inputs || parsed.engineInputs || {};

  if (inputs.services?.pest || inputs.services?.pest_control || inputs.svcPest) return true;
  if (result.results?.pest || result.recurring?.pest || result.recurring?.pest_control) return true;

  const lineItems = Array.isArray(result.lineItems) ? result.lineItems : [];
  if (lineItems.some((line) => {
    const raw = String(line?.service || line?.key || line?.name || line?.displayName || '').toLowerCase();
    return raw.includes('pest');
  })) return true;

  const recurringServices = Array.isArray(result.recurring?.services) ? result.recurring.services : [];
  if (recurringServices.some((service) => {
    const raw = String(service?.service || service?.key || service?.name || service?.serviceName || '').toLowerCase();
    return raw.includes('pest');
  })) return true;

  return false;
}

function extractPestPrice(result = {}, pestLine = null) {
  const recurring = result.recurring || {};
  const pest = recurring.pest || recurring.pest_control || {};
  const totals = result.totals || {};
  const line = pestLine || (Array.isArray(result.lineItems)
    ? result.lineItems.find(item => item?.service === 'pest_control' || item?.key === 'pest_control')
    : null);

  return firstFiniteNumber(
    pest.perApp,
    pest.per_app,
    pest.price,
    pest.amount,
    line?.perApp,
    line?.price,
    line?.amount,
    totals.pest_control,
    totals.pestControl,
  );
}

function extractEstimatePayload(estimateData) {
  const parsed = parseMaybeJson(estimateData);
  const result = parsed.result || parsed.engineResult || parsed;
  const pestLine = Array.isArray(result.lineItems)
    ? result.lineItems.find(line => line?.service === 'pest_control')
    : null;
  const diagnostics = result.productionDiagnostics || pestLine?.productionDiagnostics || null;
  const property = result.property || parsed.profile || parsed.inputs || parsed.engineInputs || {};
  const pestPrice = extractPestPrice(result, pestLine);
  return { parsed, result, diagnostics, property, pestPrice };
}

function isPestOnlyServiceType(serviceType) {
  const raw = String(serviceType || '').toLowerCase();
  if (!raw.includes('pest')) return false;
  return ![
    ' + ',
    'lawn',
    'tree',
    'shrub',
    'mosquito',
    'termite',
    'rodent',
    'palm',
  ].some(token => raw.includes(token));
}

function buildCalibrationRecord(row) {
  const { parsed, result, diagnostics, property, pestPrice } = extractEstimatePayload(row.estimate_data);
  if (!diagnostics || diagnostics.estimatedMinutes == null) return null;

  const predicted = round1(diagnostics.estimatedMinutes);
  const actual = round1(row.actual_minutes);
  if (!predicted || !actual) return null;

  const reasons = normalizeReasons(diagnostics.reviewReasons || diagnostics.manualReviewReasons);
  const poolCageSize = String(diagnostics.poolCageSize || property.poolCageSize || 'none').toLowerCase();
  const homeSqFt = Number(property.homeSqFt || property.squareFootage || parsed.inputs?.homeSqFt || 0) || null;
  const lotSqFt = Number(property.lotSqFt || property.lotSize || parsed.inputs?.lotSqFt || 0) || null;

  return {
    scheduled_service_id: row.scheduled_service_id,
    estimate_id: row.estimate_id || null,
    customer_id: row.customer_id || null,
    technician_id: row.technician_id || null,
    service_date: row.service_date || null,
    service_type: row.service_type || null,
    predicted_minutes: predicted,
    actual_minutes: actual,
    delta_minutes: round1(actual - predicted),
    pricing_confidence: String(diagnostics.pricingConfidence || diagnostics.confidence || 'unknown').toLowerCase(),
    pool_cage_size: poolCageSize,
    home_sqft: homeSqFt,
    lot_sqft: lotSqFt,
    review_reasons: JSON.stringify(reasons),
    production_diagnostics: JSON.stringify(diagnostics),
    property_snapshot: JSON.stringify(property || {}),
    estimate_snapshot: JSON.stringify({
      recurring: result.recurring || null,
      totals: result.totals || null,
      pestPrice,
      productionDiagnostics: diagnostics,
    }),
    source: row.source || 'estimate_time_entry',
  };
}

function calibrationReviewReasons(row) {
  const reasons = new Set();
  const delta = Math.abs(Number(row.delta_minutes) || 0);
  if (delta >= 15) reasons.add('15_min_variance');

  const confidence = String(row.pricing_confidence || '').toLowerCase();
  if (confidence === 'low') reasons.add('low_confidence');

  const lot = Number(row.lot_sqft) || 0;
  if (lot >= 20000) reasons.add('large_lot');

  const pool = String(row.pool_cage_size || '').toLowerCase();
  if (pool === 'large' || pool === 'oversized') reasons.add(`${pool}_pool_cage`);

  for (const reason of normalizeReasons(row.review_reasons)) {
    if (reason === 'pool_cage_size_inferred') reasons.add('pool_cage_size_inferred');
    if (reason === 'large_lot') reasons.add('large_lot');
    if (reason === 'low_confidence') reasons.add('low_confidence');
  }

  const diagnostics = parseStoredJson(row.production_diagnostics, {}) || {};
  if (diagnostics.poolCageSizeInferred || diagnostics.poolCageSizeSource === 'inferred') {
    reasons.add('pool_cage_size_inferred');
  }

  return [...reasons];
}

function summarizeGroup(records, keyFn) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFn(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const deltas = rows.map(r => Number(r.delta_minutes) || 0);
    const abs = deltas.map(Math.abs);
    return {
      key,
      count: rows.length,
      avgDelta: round1(deltas.reduce((s, n) => s + n, 0) / rows.length),
      avgAbsDelta: round1(abs.reduce((s, n) => s + n, 0) / rows.length),
      overPredicted: rows.filter(r => Number(r.delta_minutes) > 0).length,
      underPredicted: rows.filter(r => Number(r.delta_minutes) < 0).length,
    };
  }).sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

function summarizeCalibrationRecords(records) {
  const rows = records || [];
  const deltas = rows.map(r => Number(r.delta_minutes) || 0);
  const abs = deltas.map(Math.abs);
  const outliers = rows
    .filter(r => Math.abs(Number(r.delta_minutes) || 0) >= 15)
    .sort((a, b) => Math.abs(Number(b.delta_minutes) || 0) - Math.abs(Number(a.delta_minutes) || 0))
    .slice(0, 25);
  const reviewQueue = rows
    .map(row => ({ ...row, calibration_review_reasons: calibrationReviewReasons(row) }))
    .filter(row => row.calibration_review_reasons.length > 0)
    .sort((a, b) => {
      const deltaDiff = Math.abs(Number(b.delta_minutes) || 0) - Math.abs(Number(a.delta_minutes) || 0);
      if (deltaDiff) return deltaDiff;
      return String(b.service_date || '').localeCompare(String(a.service_date || ''));
    })
    .slice(0, 25);

  return {
    count: rows.length,
    avgDelta: rows.length ? round1(deltas.reduce((s, n) => s + n, 0) / rows.length) : 0,
    avgAbsDelta: rows.length ? round1(abs.reduce((s, n) => s + n, 0) / rows.length) : 0,
    outlierCount: rows.filter(r => Math.abs(Number(r.delta_minutes) || 0) >= 15).length,
    byPoolCageSize: summarizeGroup(rows, r => r.pool_cage_size || 'unknown'),
    byLotBand: summarizeGroup(rows, r => lotBand(r.lot_sqft)),
    byConfidence: summarizeGroup(rows, r => r.pricing_confidence || 'unknown'),
    outliers,
    reviewQueueCount: rows.filter(r => calibrationReviewReasons(r).length > 0).length,
    reviewQueue,
  };
}

function applyPestOnlyServiceFilters(q, alias = 's') {
  return q
    .whereILike(`${alias}.service_type`, '%pest%')
    .whereNot(`${alias}.service_type`, 'ilike', '%lawn%')
    // "turf": commercial lawn persists as "Commercial Turf Treatment Program";
    // exclude it from pest calibration just like %lawn% (guards a combined
    // turf+pest name from polluting the pest production rate).
    .whereNot(`${alias}.service_type`, 'ilike', '%turf%')
    .whereNot(`${alias}.service_type`, 'ilike', '%tree%')
    .whereNot(`${alias}.service_type`, 'ilike', '%shrub%')
    .whereNot(`${alias}.service_type`, 'ilike', '%mosquito%')
    .whereNot(`${alias}.service_type`, 'ilike', '%termite%')
    .whereNot(`${alias}.service_type`, 'ilike', '%rodent%')
    .whereNot(`${alias}.service_type`, 'ilike', '%palm%')
    .whereNot(`${alias}.service_type`, 'ilike', '% + %');
}

function fallbackWindowForJob(row) {
  if (!row.customer_id || !row.service_date) return null;
  const serviceDate = normalizeServiceDate(row.service_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate || '')) return null;
  const serviceAnchor = parseETDateTime(`${serviceDate}T12:00`);
  return {
    customerId: row.customer_id,
    serviceDate,
    start: etDateString(addETDays(serviceAnchor, -120)),
    end: etDateString(addETDays(serviceAnchor, 14)),
  };
}

function estimateStatusRank(status) {
  if (status === 'accepted') return 0;
  if (status === 'viewed') return 1;
  return 2;
}

function estimateSortTime(estimate) {
  const values = [estimate.accepted_at, estimate.sent_at, estimate.created_at];
  for (const value of values) {
    const parsed = parseEstimateActivityDateTime(value);
    if (parsed) return parsed.getTime();
  }
  return 0;
}

function sortFallbackEstimates(estimates = []) {
  return [...estimates].sort((a, b) => {
    const rankDiff = estimateStatusRank(a.status) - estimateStatusRank(b.status);
    if (rankDiff) return rankDiff;
    return estimateSortTime(b) - estimateSortTime(a);
  });
}

function selectFallbackEstimateForJob(row, estimates = []) {
  const window = fallbackWindowForJob(row);
  if (!window) return null;
  return sortFallbackEstimates(estimates).find((estimate) => (
    estimate.customer_id === window.customerId
    && estimate.status === 'accepted'
    && (() => {
      const acceptedDate = normalizeEstimateActivityDate(estimate.accepted_at);
      return acceptedDate >= window.start && acceptedDate <= window.end;
    })()
    && hasProductionDiagnostics(estimate.estimate_data)
    && estimateIncludesPestService(estimate.estimate_data)
  )) || null;
}

async function fetchCompletedPestJobRows({ startDate, endDate, limit = 500 } = {}) {
  let q = db('time_entries as te')
    .join('scheduled_services as s', 'te.job_id', 's.id')
    .leftJoin('estimates as e', 's.source_estimate_id', 'e.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('te.entry_type', 'job')
    .whereIn('te.status', ['completed', 'edited'])
    .whereNotNull('te.duration_minutes')
    .groupBy(
      's.id', 's.source_estimate_id', 's.customer_id', 's.technician_id',
      's.scheduled_date', 's.service_type', 'e.estimate_data',
      'c.first_name', 'c.last_name', 'c.address_line1', 'c.city',
    )
    .select(
      's.id as scheduled_service_id',
      's.source_estimate_id as estimate_id',
      's.customer_id',
      's.technician_id',
      's.scheduled_date as service_date',
      's.service_type',
      'e.estimate_data',
      'c.first_name',
      'c.last_name',
      'c.address_line1',
      'c.city',
    )
    .sum({ actual_minutes: 'te.duration_minutes' })
    .orderBy('s.scheduled_date', 'desc')
    .limit(Math.min(Math.max(Number(limit) || 500, 1), 2000));
  q = applyPestOnlyServiceFilters(q, 's');

  if (startDate) q = q.where('s.scheduled_date', '>=', startDate);
  if (endDate) q = q.where('s.scheduled_date', '<=', endDate);
  return q;
}

async function fetchFallbackEstimatesForJobs(rows = []) {
  const windows = rows
    .filter(row => !row.estimate_data)
    .map(fallbackWindowForJob)
    .filter(Boolean);
  if (!windows.length) return new Map();

  const customerIds = [...new Set(windows.map(window => window.customerId))];
  const start = windows.reduce((min, window) => (window.start < min ? window.start : min), windows[0].start);
  const end = windows.reduce((max, window) => (window.end > max ? window.end : max), windows[0].end);

  const estimates = await db('estimates')
    .whereIn('customer_id', customerIds)
    .where('status', 'accepted')
    .whereRaw("(accepted_at AT TIME ZONE 'America/New_York')::date BETWEEN ?::date AND ?::date", [start, end])
    .orderByRaw(`
      CASE
        WHEN status = 'accepted' THEN 0
        WHEN status = 'viewed' THEN 1
        ELSE 2
      END
    `)
    .orderBy('accepted_at', 'desc')
    .orderBy('sent_at', 'desc')
    .orderBy('created_at', 'desc');

  const byCustomer = new Map();
  for (const estimate of estimates) {
    if (!hasProductionDiagnostics(estimate.estimate_data) || !estimateIncludesPestService(estimate.estimate_data)) {
      continue;
    }
    if (!byCustomer.has(estimate.customer_id)) byCustomer.set(estimate.customer_id, []);
    byCustomer.get(estimate.customer_id).push(estimate);
  }
  for (const [customerId, customerEstimates] of byCustomer.entries()) {
    byCustomer.set(customerId, sortFallbackEstimates(customerEstimates));
  }
  return byCustomer;
}

async function hydrateJobRowsWithFallbackEstimates(rows) {
  const fallbackEstimatesByCustomer = await fetchFallbackEstimatesForJobs(rows);
  const hydrated = [];
  for (const row of rows) {
    if (row.estimate_data) {
      hydrated.push({ ...row, source: 'estimate_time_entry' });
      continue;
    }
    const match = selectFallbackEstimateForJob(
      row,
      fallbackEstimatesByCustomer.get(row.customer_id) || [],
    );
    if (match) {
      hydrated.push({
        ...row,
        estimate_id: match.id,
        estimate_data: match.estimate_data,
        source: 'matched_customer_date',
      });
    } else {
      hydrated.push({ ...row, source: 'missing_estimate_link' });
    }
  }
  return hydrated;
}

async function countMissingTimerPestJobs({ startDate, endDate } = {}) {
  let q = db('scheduled_services as s')
    .where('s.status', 'completed')
    .whereNotExists(function () {
      this.select(1)
        .from('time_entries as te')
        .whereRaw('te.job_id = s.id')
        .where('te.entry_type', 'job')
        .whereIn('te.status', ['completed', 'edited'])
        .whereNotNull('te.duration_minutes');
    })
    .countDistinct('s.id as count');
  q = applyPestOnlyServiceFilters(q, 's');
  if (startDate) q = q.where('s.scheduled_date', '>=', startDate);
  if (endDate) q = q.where('s.scheduled_date', '<=', endDate);
  const row = await q.first();
  return Number(row?.count || 0);
}

function buildSampleHealth({ rows = [], hydratedRows = [], records = [], missingTimerCount = 0 } = {}) {
  const linkedEstimateCount = rows.filter(row => !!row.estimate_data).length;
  const missingEstimateLinkCount = rows.filter(row => !row.estimate_data).length;
  const fallbackMatchedCount = hydratedRows.filter(row => row.source === 'matched_customer_date').length;
  const missingDiagnosticsCount = hydratedRows.filter(row => row.estimate_data && !hasProductionDiagnostics(row.estimate_data)).length;
  const materializedCount = records.length;
  return {
    jobsEvaluated: rows.length,
    materializedCount,
    linkedEstimateCount,
    fallbackMatchedCount,
    missingEstimateLinkCount,
    missingTimerCount,
    missingDiagnosticsCount,
    skippedCount: rows.length - materializedCount,
  };
}

async function syncCalibrationRecords(options = {}) {
  const rows = await fetchCompletedPestJobRows(options);
  const hydratedRows = await hydrateJobRowsWithFallbackEstimates(rows);
  const records = hydratedRows.map(buildCalibrationRecord).filter(Boolean);
  const missingTimerCount = await countMissingTimerPestJobs(options).catch(() => 0);
  const sampleHealth = buildSampleHealth({ rows, hydratedRows, records, missingTimerCount });
  if (!records.length) return { synced: 0, skipped: rows.length, sampleHealth };

  const now = new Date();
  const withTimestamps = records.map(record => ({ ...record, updated_at: now }));
  await db('pest_production_calibration_records')
    .insert(withTimestamps)
    .onConflict('scheduled_service_id')
    .merge([
      'estimate_id', 'customer_id', 'technician_id', 'service_date', 'service_type',
      'predicted_minutes', 'actual_minutes', 'delta_minutes', 'pricing_confidence',
      'pool_cage_size', 'home_sqft', 'lot_sqft', 'review_reasons',
      'production_diagnostics', 'property_snapshot', 'estimate_snapshot',
      'source', 'updated_at',
    ]);

  return { synced: records.length, skipped: rows.length - records.length, sampleHealth };
}

async function listCalibrationRecords({ startDate, endDate, limit = 100, maxLimit = 500 } = {}) {
  let q = db('pest_production_calibration_records as p')
    .leftJoin('customers as c', 'p.customer_id', 'c.id')
    .leftJoin('technicians as t', 'p.technician_id', 't.id')
    .select(
      'p.*',
      'c.first_name',
      'c.last_name',
      'c.address_line1',
      'c.city',
      't.name as technician_name',
    )
    .orderBy('p.service_date', 'desc')
    .limit(Math.min(Math.max(Number(limit) || 100, 1), Math.max(Number(maxLimit) || 500, 1)));
  if (startDate) q = q.where('p.service_date', '>=', startDate);
  if (endDate) q = q.where('p.service_date', '<=', endDate);
  const rows = await q;
  return rows.map(row => ({
    ...row,
    predicted_minutes: Number(row.predicted_minutes),
    actual_minutes: Number(row.actual_minutes),
    delta_minutes: Number(row.delta_minutes),
    home_sqft: row.home_sqft == null ? null : Number(row.home_sqft),
    lot_sqft: row.lot_sqft == null ? null : Number(row.lot_sqft),
    review_reasons: normalizeReasons(row.review_reasons),
    calibration_review_reasons: calibrationReviewReasons(row),
    customer_name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
  }));
}

function calibrationExportRows(records = []) {
  return (records || []).map((row) => {
    const estimateSnapshot = parseStoredJson(row.estimate_snapshot, {}) || {};
    const diagnostics = parseStoredJson(row.production_diagnostics, {}) || {};
    const property = parseStoredJson(row.property_snapshot, {}) || {};
    const reviewReasons = normalizeReasons(row.review_reasons);
    const pestPrice = firstFiniteNumber(
      estimateSnapshot.pestPrice,
      estimateSnapshot.recurring?.pest?.perApp,
      estimateSnapshot.recurring?.pest_control?.perApp,
      estimateSnapshot.totals?.pest_control,
      estimateSnapshot.totals?.pestControl,
    );

    return {
      service_date: String(row.service_date || '').slice(0, 10),
      customer_name: row.customer_name || '',
      address_line1: row.address_line1 || '',
      city: row.city || '',
      technician_name: row.technician_name || '',
      service_type: row.service_type || '',
      predicted_minutes: Number(row.predicted_minutes || 0).toFixed(1),
      actual_minutes: Number(row.actual_minutes || 0).toFixed(1),
      delta_minutes: Number(row.delta_minutes || 0).toFixed(1),
      pricing_confidence: row.pricing_confidence || '',
      pool_cage_size: row.pool_cage_size || '',
      home_sqft: row.home_sqft || '',
      lot_sqft: row.lot_sqft || '',
      lot_band: lotBand(row.lot_sqft),
      pest_price: pestPrice == null ? '' : Number(pestPrice).toFixed(2),
      review_reasons: reviewReasons.join('; '),
      pool_cage_size_source: diagnostics.poolCageSizeSource || '',
      pricing_mode: diagnostics.pricingMode || '',
      source: row.source || '',
      stories: property.stories || '',
      scheduled_service_id: row.scheduled_service_id || '',
      estimate_id: row.estimate_id || '',
    };
  });
}

function csvEscape(value) {
  const raw = value == null ? '' : String(value);
  const neutralized = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (!/[",\n\r]/.test(neutralized)) return neutralized;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function calibrationRowsToCsv(records = []) {
  const rows = calibrationExportRows(records);
  const headers = [
    'service_date',
    'customer_name',
    'address_line1',
    'city',
    'technician_name',
    'service_type',
    'predicted_minutes',
    'actual_minutes',
    'delta_minutes',
    'pricing_confidence',
    'pool_cage_size',
    'home_sqft',
    'lot_sqft',
    'lot_band',
    'pest_price',
    'review_reasons',
    'pool_cage_size_source',
    'pricing_mode',
    'source',
    'stories',
    'scheduled_service_id',
    'estimate_id',
  ];
  return [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ].join('\n');
}

module.exports = {
  buildCalibrationRecord,
  summarizeCalibrationRecords,
  syncCalibrationRecords,
  listCalibrationRecords,
  calibrationExportRows,
  calibrationRowsToCsv,
  calibrationReviewReasons,
  buildSampleHealth,
  hasProductionDiagnostics,
  estimateIncludesPestService,
  selectFallbackEstimateForJob,
  lotBand,
  isPestOnlyServiceType,
};
