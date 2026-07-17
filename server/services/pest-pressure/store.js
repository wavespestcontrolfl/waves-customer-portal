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

const crypto = require('crypto');
const db = require('../../models/db');
const { DEFAULT_CONFIG } = require('./config');

// Fields whose values change what the customer sees on a Pest Pressure
// surface (card visibility, narrative text, breakdown table, explanation
// copy). Used to derive a short signature embedded in the PDF storage
// key — when admin flips any of these, the key changes, cached PDFs
// become cache-miss, and the next request re-renders against the new
// config. Anything outside this set (weights, labels, trend thresholds)
// affects the calculated score, NOT visible rendering, and falls in the
// next natural pest_pressure_scores recalculation.
const VISIBILITY_AFFECTING_FIELDS = [
  'enabled',
  'showOnCustomerReport',
  'enabledServiceLines',
  'requireRecurringFrequency',
  // Toggles the "How we calculate Pest Pressure" disclosure in the card.
  'showHowCalculated',
  // The actual paragraph rendered inside that disclosure — admin-editable.
  // Hash the verbatim string so a copy edit invalidates caches.
  'customerExplanationText',
  // Toggles the per-component breakdown table rendered to customers.
  'showComponentBreakdownToCustomer',
];

function pestPressureVisibilitySignature(config) {
  // Stable hash: sort the allow list so e.g. ['mosquito','pest'] and
  // ['pest','mosquito'] produce the same signature.
  const enabledLines = Array.isArray(config && config.enabledServiceLines)
    ? config.enabledServiceLines.slice().sort()
    : null;
  const payload = JSON.stringify({
    enabled: Boolean(config && config.enabled),
    showOnCustomerReport: Boolean(config && config.showOnCustomerReport),
    enabledServiceLines: enabledLines,
    requireRecurringFrequency: Boolean(config && config.requireRecurringFrequency),
    showHowCalculated: Boolean(config && config.showHowCalculated),
    showComponentBreakdownToCustomer: Boolean(config && config.showComponentBreakdownToCustomer),
    customerExplanationText: (config && typeof config.customerExplanationText === 'string')
      ? config.customerExplanationText
      : null,
  });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

const CONFIG_COLUMNS = [
  'id', 'scope', 'enabled',
  'show_on_customer_report', 'show_how_calculated', 'show_component_breakdown_to_customer',
  'missing_data_behavior', 'minimum_data_required',
  'allow_manual_override', 'allow_technician_client_rating_entry',
  'enabled_service_lines', 'require_recurring_frequency',
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
    enabledServiceLines: Array.isArray(row.enabled_service_lines)
      ? row.enabled_service_lines
      : DEFAULT_CONFIG.enabledServiceLines,
    requireRecurringFrequency: typeof row.require_recurring_frequency === 'boolean'
      ? row.require_recurring_frequency
      : DEFAULT_CONFIG.requireRecurringFrequency,
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
 * Null out service_records.pdf_storage_key so the next /report/:token/pdf
 * request treats the cached PDF as a miss and re-renders. Called after any
 * write to pest_pressure_scores that changes the customer-visible score
 * (persist, override set, override remove). Without this, the cached PDF
 * shows the old displayed_score even after admin overrides or recalcs.
 *
 * Best-effort: a failed UPDATE doesn't block the score write — at worst
 * the customer sees a stale PDF until the next visibility-config edit
 * or the next service-record completion writes a new pdf_storage_key.
 */
async function invalidatePdfCacheForServiceRecord(knex, serviceRecordId) {
  if (!serviceRecordId) return;
  try {
    await knex('service_records')
      .where({ id: serviceRecordId })
      .update({ pdf_storage_key: null });
  } catch (err) {
    // Don't propagate — derived/secondary side effect.
  }
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
    await invalidatePdfCacheForServiceRecord(knex, payload.serviceRecordId);
    return { ...existing, ...row };
  }
  const [inserted] = await knex('pest_pressure_scores').insert(row).returning('*');
  await invalidatePdfCacheForServiceRecord(knex, payload.serviceRecordId);
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
    enabled_service_lines: JSON.stringify(Array.isArray(config.enabledServiceLines) ? config.enabledServiceLines : []),
    require_recurring_frequency: Boolean(config.requireRecurringFrequency),
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

/**
 * Apply a manual override to a calculated score. Records the
 * original_calculated_score for later restoration, sets displayed_score
 * to the override value, captures actor + reason + timestamp, and
 * mirrors displayed_score back to service_records.pressure_index so the
 * customer-facing report immediately shows the overridden number.
 *
 * Throws if the row doesn't exist or if the supplied displayedScore is
 * out of the 0–5 range. Validation of the reason field is the caller's
 * responsibility (route layer enforces non-empty + length cap).
 */
async function applyOverride(knex, { serviceRecordId, displayedScore, reason, overriddenBy }) {
  if (!serviceRecordId) throw new TypeError('applyOverride: serviceRecordId is required');
  const num = Number(displayedScore);
  if (!Number.isFinite(num) || num < 0 || num > 5) {
    throw new RangeError('applyOverride: displayedScore must be a number between 0 and 5');
  }
  const existing = await loadScoreForServiceRecord(knex, serviceRecordId);
  if (!existing) {
    const err = new Error('score_not_found');
    err.statusCode = 404;
    throw err;
  }
  const rounded = Math.round(num * 10) / 10;
  const original = existing.is_overridden
    ? (existing.original_calculated_score !== null && existing.original_calculated_score !== undefined
      ? existing.original_calculated_score
      : existing.calculated_score)
    : existing.calculated_score;

  await knex('pest_pressure_scores').where({ id: existing.id }).update({
    is_overridden: true,
    displayed_score: rounded,
    original_calculated_score: original,
    override_reason: reason || null,
    overridden_by: overriddenBy || null,
    overridden_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });

  await knex('service_records')
    .where({ id: serviceRecordId })
    .update({ pressure_index: rounded, pdf_storage_key: null });

  return loadScoreForServiceRecord(knex, serviceRecordId);
}

/**
 * Remove a manual override. Restores displayed_score to the most recent
 * calculated_score (which is still on the row from the last engine run)
 * and re-mirrors that to service_records.pressure_index. Returns null
 * when no row exists or when the row isn't overridden.
 */
async function removeOverride(knex, { serviceRecordId }) {
  if (!serviceRecordId) throw new TypeError('removeOverride: serviceRecordId is required');
  const existing = await loadScoreForServiceRecord(knex, serviceRecordId);
  if (!existing) return null;
  if (!existing.is_overridden) return existing;

  const restored = existing.calculated_score;
  await knex('pest_pressure_scores').where({ id: existing.id }).update({
    is_overridden: false,
    displayed_score: restored,
    original_calculated_score: null,
    override_reason: null,
    overridden_by: null,
    overridden_at: null,
    updated_at: knex.fn.now(),
  });

  // Always mirror the override removal to service_records.pressure_index,
  // including the null case. With the previous guard, removing an override
  // from an "insufficient data" score left the old overridden value in
  // pressure_index — so customer/report surfaces reading pressure_index
  // would continue showing the stale score after the override was cleared.
  await knex('service_records')
    .where({ id: serviceRecordId })
    .update({ pressure_index: restored ?? null, pdf_storage_key: null });

  return loadScoreForServiceRecord(knex, serviceRecordId);
}

async function listRecentScores(knex, { limit = 25 } = {}) {
  return knex('pest_pressure_scores as p')
    .leftJoin('customers as c', 'p.customer_id', 'c.id')
    .orderBy('p.service_date', 'desc')
    .orderBy('p.calculated_at', 'desc')
    .limit(limit)
    .select(
      'p.id', 'p.service_record_id', 'p.customer_id', 'p.service_date',
      'p.service_line', 'p.calculated_score', 'p.displayed_score',
      'p.label_key', 'p.label_name', 'p.trend', 'p.trend_delta',
      'p.data_completeness', 'p.is_overridden', 'p.override_reason',
      'p.overridden_by', 'p.overridden_at', 'p.calculation_version',
      'p.calculated_at',
      knex.raw("trim(both ' ' from concat_ws(' ', c.first_name, c.last_name)) as customer_name"),
    );
}

async function listAuditEvents(knex, { limit = 50 } = {}) {
  const hasTable = await knex.schema.hasTable('audit_log').catch(() => false);
  if (!hasTable) return [];
  return knex('audit_log')
    .where('action', 'like', 'pest_pressure.%')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('id', 'actor_type', 'actor_id', 'action', 'resource_type', 'resource_id', 'metadata', 'created_at');
}

async function loadHistoryForCustomer(knex, customerId, { serviceLine = null, limit = 12, beforeOrOnServiceDate = null, currentServiceRecordId = null } = {}) {
  const q = knex('pest_pressure_scores as pps')
    .leftJoin('service_records as sr', 'sr.id', 'pps.service_record_id')
    .where('pps.customer_id', customerId)
    .orderBy('pps.service_date', 'desc')
    // Deterministic same-day chronology, on IMMUTABLE visit time: the trim
    // below slices at the current row's position, so tied service_date rows
    // must order by when the visit actually happened. calculated_at can't be
    // the tie-break — admin recalculation rewrites it, which would re-sort an
    // older recalculated report ahead of its later sibling and leak that
    // sibling (codex P2 #2824 r2). started_at is stamped at visit time and
    // never rewritten; NULLS LAST keeps legacy no-timestamp rows oldest
    // within the day; pps.id is the final immutable tie-break.
    .orderByRaw('sr.started_at DESC NULLS LAST')
    .orderBy('pps.id', 'desc')
    // Over-fetch when a same-day trim is requested so the trim can't starve
    // the window below `limit`.
    .limit(currentServiceRecordId ? limit + 8 : limit);
  if (serviceLine) q.where('pps.service_line', serviceLine);
  // Token-scoped callers (customer-facing report views) must pass
  // beforeOrOnServiceDate set to the report's own service_date so a
  // long-lived `/api/reports/:token` bearer can't reveal later visits
  // recorded after the report was generated.
  if (beforeOrOnServiceDate) q.where('pps.service_date', '<=', beforeOrOnServiceDate);
  const rows = await q.select(
    'pps.id', 'pps.service_record_id', 'pps.service_date', 'pps.service_line',
    'pps.displayed_score', 'pps.calculated_score', 'pps.label_key', 'pps.label_name',
    'pps.trend', 'pps.trend_delta', 'pps.data_completeness', 'pps.is_overridden',
    'pps.override_reason', 'pps.overridden_by', 'pps.overridden_at',
    'pps.calculation_version', 'pps.calculated_at',
  );
  // The date bound alone leaks same-day sibling visits: viewing the earlier
  // report after a later same-day visit completes would chart the later
  // score. Trim at this report's own row whenever it's stored (mirrors
  // activity-scores-store); the legacy no-row fallback keeps the date bound.
  if (currentServiceRecordId) {
    const currentIdx = rows.findIndex((row) => String(row.service_record_id) === String(currentServiceRecordId));
    if (currentIdx >= 0) return rows.slice(currentIdx).slice(0, limit);
    // Current row absent from the fetched window: either it was never stored
    // (legacy report) or enough later same-day siblings exist to push it past
    // the limit+8 cap. Check directly and FAIL CLOSED in the stored case —
    // chart the current row plus strictly-earlier days only — instead of
    // falling back to the newest rows, which would include the very visits
    // the trim exists to hide (codex P2 #2824 r3).
    const currentRow = await knex('pest_pressure_scores as pps')
      .where('pps.customer_id', customerId)
      .where('pps.service_record_id', currentServiceRecordId)
      .select(
        'pps.id', 'pps.service_record_id', 'pps.service_date', 'pps.service_line',
        'pps.displayed_score', 'pps.calculated_score', 'pps.label_key', 'pps.label_name',
        'pps.trend', 'pps.trend_delta', 'pps.data_completeness', 'pps.is_overridden',
        'pps.override_reason', 'pps.overridden_by', 'pps.overridden_at',
        'pps.calculation_version', 'pps.calculated_at',
      )
      .first();
    if (currentRow) {
      const dayKey = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
      const currentDay = dayKey(currentRow.service_date);
      // Dropping the whole tied day also drops legitimate earlier same-day
      // siblings — accepted: this branch only fires in the pathological
      // ≥limit+8-same-day-rows case, and closed beats leaking later visits.
      const earlierDays = rows.filter((row) => dayKey(row.service_date) !== currentDay);
      return [currentRow, ...earlierDays].slice(0, limit);
    }
    return rows.slice(0, limit);
  }
  return rows;
}

module.exports = {
  loadActiveConfig,
  updateActiveConfig,
  loadPreviousScore,
  loadScoreForServiceRecord,
  persistScore,
  applyOverride,
  removeOverride,
  listRecentScores,
  listAuditEvents,
  loadHistoryForCustomer,
  rowToConfig,
  pestPressureVisibilitySignature,
  invalidatePdfCacheForServiceRecord,
  VISIBILITY_AFFECTING_FIELDS,
};
