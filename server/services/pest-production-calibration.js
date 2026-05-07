const db = require('../models/db');

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

function lotBand(lotSqFt) {
  const lot = Number(lotSqFt) || 0;
  if (!lot) return 'unknown';
  if (lot < 10000) return '<10k';
  if (lot < 20000) return '10k-20k';
  if (lot < 40000) return '20k-40k';
  return '40k+';
}

function extractEstimatePayload(estimateData) {
  const parsed = parseMaybeJson(estimateData);
  const result = parsed.result || parsed.engineResult || parsed;
  const pestLine = Array.isArray(result.lineItems)
    ? result.lineItems.find(line => line?.service === 'pest_control')
    : null;
  const diagnostics = result.productionDiagnostics || pestLine?.productionDiagnostics || null;
  const property = result.property || parsed.profile || parsed.inputs || parsed.engineInputs || {};
  return { parsed, result, diagnostics, property };
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
  const { parsed, result, diagnostics, property } = extractEstimatePayload(row.estimate_data);
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
      productionDiagnostics: diagnostics,
    }),
    source: 'estimate_time_entry',
  };
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

  return {
    count: rows.length,
    avgDelta: rows.length ? round1(deltas.reduce((s, n) => s + n, 0) / rows.length) : 0,
    avgAbsDelta: rows.length ? round1(abs.reduce((s, n) => s + n, 0) / rows.length) : 0,
    outlierCount: rows.filter(r => Math.abs(Number(r.delta_minutes) || 0) >= 15).length,
    byPoolCageSize: summarizeGroup(rows, r => r.pool_cage_size || 'unknown'),
    byLotBand: summarizeGroup(rows, r => lotBand(r.lot_sqft)),
    byConfidence: summarizeGroup(rows, r => r.pricing_confidence || 'unknown'),
    outliers,
  };
}

async function fetchCompletedPestJobRows({ startDate, endDate, limit = 500 } = {}) {
  let q = db('time_entries as te')
    .join('scheduled_services as s', 'te.job_id', 's.id')
    .join('estimates as e', 's.source_estimate_id', 'e.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('te.entry_type', 'job')
    .whereIn('te.status', ['completed', 'edited'])
    .whereNotNull('te.duration_minutes')
    .whereNotNull('s.source_estimate_id')
    .whereILike('s.service_type', '%pest%')
    .whereNot('s.service_type', 'ilike', '%lawn%')
    .whereNot('s.service_type', 'ilike', '%tree%')
    .whereNot('s.service_type', 'ilike', '%shrub%')
    .whereNot('s.service_type', 'ilike', '%mosquito%')
    .whereNot('s.service_type', 'ilike', '%termite%')
    .whereNot('s.service_type', 'ilike', '%rodent%')
    .whereNot('s.service_type', 'ilike', '%palm%')
    .whereNot('s.service_type', 'ilike', '% + %')
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

  if (startDate) q = q.where('s.scheduled_date', '>=', startDate);
  if (endDate) q = q.where('s.scheduled_date', '<=', endDate);
  return q;
}

async function syncCalibrationRecords(options = {}) {
  const rows = await fetchCompletedPestJobRows(options);
  const records = rows.map(buildCalibrationRecord).filter(Boolean);
  if (!records.length) return { synced: 0, skipped: rows.length };

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

  return { synced: records.length, skipped: rows.length - records.length };
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
    customer_name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
  }));
}

module.exports = {
  buildCalibrationRecord,
  summarizeCalibrationRecords,
  syncCalibrationRecords,
  listCalibrationRecords,
  lotBand,
  isPestOnlyServiceType,
};
