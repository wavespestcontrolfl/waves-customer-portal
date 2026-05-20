/**
 * Pest Pressure persistence layer.
 *
 * Responsible for reading the active admin config, persisting calculated
 * scores, looking up the previous score for trend resolution, and reading
 * back history for admin views.
 *
 * Knex rows store JSON config columns as jsonb — node-postgres returns
 * those as already-parsed JS objects, so no JSON.parse() needed on read.
 * Insert path JSON.stringify()s for consistency with the migration seed.
 */

const db = require('../../models/db');
const { DEFAULT_CONFIG } = require('./config');

const CONFIG_COLUMNS = [
  'id', 'scope', 'enabled',
  'show_on_customer_report', 'show_how_calculated', 'show_component_breakdown_to_customer',
  'missing_data_behavior', 'minimum_data_required',
  'allow_manual_override', 'allow_technician_client_rating_entry',
  'weights', 'labels', 'trend_thresholds',
  'service_frequency_windows', 'client_question_text',
  'customer_explanation_text', 'calculation_version',
  'created_by', 'updated_by', 'created_at', 'updated_at',
];

function rowToConfig(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    enabled: row.enabled,
    showOnCustomerReport: row.show_on_customer_report,
    showHowCalculated: row.show_how_calculated,
    showComponentBreakdownToCustomer: row.show_component_breakdown_to_customer,
    missingDataBehavior: row.missing_data_behavior,
    minimumDataRequired: row.minimum_data_required || {},
    allowManualOverride: row.allow_manual_override,
    allowTechnicianClientRatingEntry: row.allow_technician_client_rating_entry,
    weights: row.weights,
    labels: row.labels,
    trendThresholds: row.trend_thresholds,
    serviceFrequencyWindows: row.service_frequency_windows,
    clientQuestionText: row.client_question_text,
    customerExplanationText: row.customer_explanation_text,
    calculationVersion: row.calculation_version,
  };
}

/**
 * Load the active config for the given scope. Falls back to DEFAULT_CONFIG
 * when the configs table is absent (early rollout / fresh DB) or no row
 * exists yet — preserves "engine runs even without admin config" behavior.
 */
async function loadActiveConfig(knex = db, { scope = 'global' } = {}) {
  const hasTable = await knex.schema.hasTable('pest_pressure_configs').catch(() => false);
  if (!hasTable) return { ...DEFAULT_CONFIG, _source: 'default_no_table' };

  const row = await knex('pest_pressure_configs')
    .where({ scope })
    .first(CONFIG_COLUMNS)
    .catch(() => null);
  if (!row) return { ...DEFAULT_CONFIG, _source: 'default_no_row' };

  const parsed = rowToConfig(row);
  return { ...DEFAULT_CONFIG, ...parsed, _source: 'db' };
}

/**
 * Read the most recent prior Pest Pressure score for trend resolution.
 * Filters by service_line when provided so quarterly pest reports don't
 * use a lawn baseline.
 */
async function loadPreviousScore(knex, { customerId, serviceLine = null, beforeServiceRecordId = null, beforeServiceDate = null }) {
  const q = knex('pest_pressure_scores')
    .where('customer_id', customerId)
    .whereNotNull('displayed_score')
    .whereNot('data_completeness', 'insufficient')
    .orderBy('service_date', 'desc')
    .orderBy('calculated_at', 'desc')
    .limit(1);
  if (serviceLine) q.where('service_line', serviceLine);
  if (beforeServiceRecordId) q.whereNot('service_record_id', beforeServiceRecordId);
  if (beforeServiceDate) q.where('service_date', '<=', beforeServiceDate);
  const row = await q.first('displayed_score', 'service_date', 'service_record_id');
  if (!row || row.displayed_score === null) return { value: null };
  return {
    value: Number(row.displayed_score),
    serviceDate: row.service_date,
    serviceRecordId: row.service_record_id,
  };
}

async function loadScoreForServiceRecord(knex, serviceRecordId) {
  if (!serviceRecordId) return null;
  return knex('pest_pressure_scores').where({ service_record_id: serviceRecordId }).first();
}

/**
 * Upsert a calculated score for one service_record. UNIQUE(service_record_id)
 * means recalculation on the same report overwrites the prior row; the
 * override fields (overridden_by, overridden_at, override_reason,
 * original_calculated_score) are preserved if currently set unless the
 * caller explicitly clears them via `clearOverride`.
 */
async function persistScore(knex, payload) {
  if (!payload || !payload.serviceRecordId) {
    throw new TypeError('persistScore: payload.serviceRecordId is required');
  }
  const existing = await loadScoreForServiceRecord(knex, payload.serviceRecordId);

  const baseRow = {
    customer_id: payload.customerId,
    service_record_id: payload.serviceRecordId,
    service_line: payload.serviceLine || null,
    service_date: payload.serviceDate,
    review_period_start: payload.reviewPeriodStart || null,
    review_period_end: payload.reviewPeriodEnd || null,
    calculated_score: payload.result.score,
    label_key: payload.result.label ? payload.result.label.key : null,
    label_name: payload.result.label ? payload.result.label.name : null,
    trend: payload.result.trend,
    trend_delta: payload.result.trendDelta,
    data_completeness: payload.result.dataCompleteness,
    component_scores: JSON.stringify(payload.result.componentScores),
    component_weights: JSON.stringify(payload.result.componentWeights),
    missing_components: JSON.stringify(payload.result.missingComponents),
    explanation: payload.result.summary || null,
    config_snapshot: JSON.stringify(payload.result.configSnapshot),
    calculation_version: payload.result.calculationVersion,
    calculated_at: knex.fn.now(),
  };

  // Preserve existing override when recalculating; clearOverride explicitly resets it.
  const preserveOverride = existing && existing.is_overridden && !payload.clearOverride;
  const row = preserveOverride
    ? {
      ...baseRow,
      is_overridden: true,
      original_calculated_score: existing.original_calculated_score || existing.calculated_score,
      displayed_score: existing.displayed_score,
      override_reason: existing.override_reason,
      overridden_by: existing.overridden_by,
      overridden_at: existing.overridden_at,
    }
    : {
      ...baseRow,
      is_overridden: false,
      original_calculated_score: null,
      displayed_score: payload.result.score,
      override_reason: null,
      overridden_by: null,
      overridden_at: null,
    };

  if (existing) {
    await knex('pest_pressure_scores').where({ id: existing.id }).update({ ...row, updated_at: knex.fn.now() });
    return { ...existing, ...row };
  }
  const [inserted] = await knex('pest_pressure_scores').insert(row).returning('*');
  return inserted;
}

/**
 * Update the active config for the given scope. Caller must have already
 * called validateConfig and confirmed it's valid. Returns the row that
 * was actually persisted so the route layer can return it to the client
 * and pass it (with the previous row) to the audit helper.
 *
 * Stores the camelCase config back as snake_case jsonb columns.
 */
async function updateActiveConfig(knex, { scope = 'global', updatedBy = null, config }) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('updateActiveConfig: config is required');
  }
  const row = {
    enabled: Boolean(config.enabled),
    show_on_customer_report: Boolean(config.showOnCustomerReport),
    show_how_calculated: Boolean(config.showHowCalculated),
    show_component_breakdown_to_customer: Boolean(config.showComponentBreakdownToCustomer),
    missing_data_behavior: config.missingDataBehavior,
    minimum_data_required: JSON.stringify(config.minimumDataRequired || {}),
    allow_manual_override: Boolean(config.allowManualOverride),
    allow_technician_client_rating_entry: Boolean(config.allowTechnicianClientRatingEntry),
    weights: JSON.stringify(config.weights),
    labels: JSON.stringify(config.labels),
    trend_thresholds: JSON.stringify(config.trendThresholds),
    service_frequency_windows: JSON.stringify(config.serviceFrequencyWindows),
    client_question_text: JSON.stringify(config.clientQuestionText),
    customer_explanation_text: config.customerExplanationText,
    calculation_version: config.calculationVersion,
    updated_by: updatedBy || null,
    updated_at: knex.fn.now(),
  };

  const existing = await knex('pest_pressure_configs').where({ scope }).first('id');
  if (existing) {
    await knex('pest_pressure_configs').where({ id: existing.id }).update(row);
    return knex('pest_pressure_configs').where({ id: existing.id }).first(CONFIG_COLUMNS).then(rowToConfig);
  }
  const [inserted] = await knex('pest_pressure_configs')
    .insert({ ...row, scope, created_by: updatedBy || null })
    .returning(CONFIG_COLUMNS);
  return rowToConfig(inserted);
}

async function loadHistoryForCustomer(knex, customerId, { serviceLine = null, limit = 12 } = {}) {
  const q = knex('pest_pressure_scores')
    .where('customer_id', customerId)
    .orderBy('service_date', 'desc')
    .limit(limit);
  if (serviceLine) q.where('service_line', serviceLine);
  return q.select(
    'id', 'service_record_id', 'service_date', 'service_line',
    'displayed_score', 'calculated_score', 'label_key', 'label_name',
    'trend', 'trend_delta', 'data_completeness', 'is_overridden',
    'override_reason', 'overridden_by', 'overridden_at',
    'calculation_version', 'calculated_at',
  );
}

module.exports = {
  loadActiveConfig,
  updateActiveConfig,
  loadPreviousScore,
  loadScoreForServiceRecord,
  persistScore,
  loadHistoryForCustomer,
  rowToConfig,
};
