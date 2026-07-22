/**
 * Customer-facing Pest Pressure object built from a stored pest_pressure_scores
 * row + the active config. Shape matches the spec.
 *
 * Returns `null` when the feature is disabled or the customer should not
 * see it (showOnCustomerReport false). When data is insufficient, returns
 * a placeholder object with a summary the report renderer can show in
 * place of a number.
 */

const { DEFAULT_CONFIG } = require('./config');
const { detectFrequencyKey, isOneTimeServiceLabel } = require('./review-window');
const { detectServiceLine } = require('../service-report/service-line-configs');

function isServiceLineEnabled(config, serviceRecord) {
  const enabledLines = Array.isArray(config && config.enabledServiceLines) ? config.enabledServiceLines : [];
  if (enabledLines.length === 0) return true;
  if (!serviceRecord) return false;
  // Use the same service_line resolution the orchestrator uses (column,
  // then detectServiceLine(service_type) fallback). Otherwise a legacy
  // record with service_line=null + service_type='Monthly Pest Control'
  // gets scored + persisted by the engine but hidden by this gate —
  // calc path and visibility path disagree on the same record.
  const resolved = serviceRecord.service_line || detectServiceLine(serviceRecord.service_type);
  if (!resolved) return false;
  return enabledLines.includes(resolved);
}

function meetsRecurringFrequencyRequirement(config, serviceRecord) {
  if (!config || config.requireRecurringFrequency !== true) return true;
  if (!serviceRecord) return false;
  // Mirrors the orchestrator gate: skip only explicit one-time labels.
  return !isOneTimeServiceLabel(serviceRecord.service_type);
}

function formatDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
}

function formatScore(value) {
  if (value === null || value === undefined) return null;
  return Number(value).toFixed(1);
}

function resolveClientRatingQuestion(config, serviceTypeText) {
  const questions = (config && config.clientQuestionText) || DEFAULT_CONFIG.clientQuestionText;
  const key = detectFrequencyKey(serviceTypeText);
  return questions[key] || questions.custom || DEFAULT_CONFIG.clientQuestionText.custom;
}

// Convert YYYY-MM-DD calendar string to a UTC-anchored timestamp.
// Using Date.UTC instead of `new Date(...)` keeps cadence math
// independent of the server's process timezone — Railway runs UTC
// but AGENTS.md requires ET discipline, and we don't want gaps to
// shift if the host TZ ever changes.
function calendarDateToUtcMs(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return null;
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

// Median gap-in-days between consecutive service dates → cadence label.
// Quarterly ≈ 90d, bi-monthly ≈ 60d, monthly ≈ 30d. We classify on the
// midpoints (45 / 75) so noisy data doesn't bounce between buckets.
function detectCadenceFromHistory(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const dates = history
    .map((row) => calendarDateToUtcMs(row && row.serviceDate))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (dates.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < dates.length; i += 1) {
    gaps.push((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 45) return 'monthly';
  if (median <= 75) return 'bimonthly';
  return 'quarterly';
}

function shapeHistory(historyRows) {
  if (!Array.isArray(historyRows) || historyRows.length === 0) return [];
  return historyRows
    .filter((row) => row && row.displayed_score !== null && row.displayed_score !== undefined && row.service_date)
    .map((row) => ({
      serviceDate: formatDate(row.service_date),
      score: Number(row.displayed_score),
      label: row.label_name || null,
    }))
    // store ships DESC; chart wants oldest → newest left-to-right.
    .reverse();
}

function buildPestPressureCustomerView({ config, scoreRow, serviceRecord = null, historyRows = null }) {
  const effectiveConfig = config || DEFAULT_CONFIG;
  if (!effectiveConfig.enabled || !effectiveConfig.showOnCustomerReport) {
    return null;
  }
  // Mirror orchestrator scope gates so the card disappears uniformly when
  // a service line is opted out OR the report is one-time, even if a
  // historical score row exists from a previous config.
  if (!isServiceLineEnabled(effectiveConfig, serviceRecord)) return null;
  if (!meetsRecurringFrequencyRequirement(effectiveConfig, serviceRecord)) return null;

  const showComponentBreakdown = Boolean(effectiveConfig.showComponentBreakdownToCustomer);
  const howCalculated = effectiveConfig.showHowCalculated
    ? effectiveConfig.customerExplanationText
    : null;

  // Customer is allowed to submit a rating when:
  //   - the feature is enabled (above guard)
  //   - the report hasn't already captured one
  // (We don't gate on showOnCustomerReport here — that's already true.)
  const hasClientRating = serviceRecord
    && serviceRecord.client_pest_rating !== null
    && serviceRecord.client_pest_rating !== undefined;
  const canCaptureClientRating = Boolean(serviceRecord) && !hasClientRating;
  const clientRatingQuestion = canCaptureClientRating
    ? resolveClientRatingQuestion(effectiveConfig, serviceRecord && serviceRecord.service_type)
    : null;
  // submittedClientRating drives the report's "Thanks — your input helps us
  // calibrate" copy — it must reflect only a rating the CUSTOMER submitted.
  // Tech-entered ratings (client_pest_rating_source = 'technician', set at
  // closeout) still feed the score but must not thank the customer for
  // input they never gave (owner 2026-07-21). Missing source column or
  // value defaults to customer — the customer POST predates the source
  // stamp.
  const ratingSource = String((serviceRecord && serviceRecord.client_pest_rating_source) || 'customer').toLowerCase();
  const submittedClientRating = hasClientRating && ratingSource === 'customer'
    ? Number(serviceRecord.client_pest_rating)
    : null;

  const history = shapeHistory(historyRows);
  const cadence = detectCadenceFromHistory(history);

  if (!scoreRow || scoreRow.data_completeness === 'insufficient' || scoreRow.displayed_score === null || scoreRow.displayed_score === undefined) {
    return {
      enabled: true,
      showOnCustomerReport: true,
      score: null,
      displayScore: null,
      maxScore: 5,
      label: null,
      trend: scoreRow ? scoreRow.trend : 'insufficient_data',
      trendDelta: null,
      date: scoreRow ? formatDate(scoreRow.service_date) : null,
      dataCompleteness: scoreRow ? scoreRow.data_completeness : 'insufficient',
      summary: 'Pest Pressure will appear once enough service data is available.',
      howCalculated,
      showComponentBreakdown,
      components: null,
      canCaptureClientRating,
      clientRatingQuestion,
      submittedClientRating,
      history,
      cadence,
    };
  }

  const score = Number(scoreRow.displayed_score);
  return {
    enabled: true,
    showOnCustomerReport: true,
    score,
    displayScore: formatScore(score),
    maxScore: 5,
    label: scoreRow.label_name || null,
    labelKey: scoreRow.label_key || null,
    trend: scoreRow.trend,
    trendDelta: scoreRow.trend_delta === null || scoreRow.trend_delta === undefined ? null : Number(scoreRow.trend_delta),
    date: formatDate(scoreRow.service_date),
    dataCompleteness: scoreRow.data_completeness,
    summary: scoreRow.explanation || null,
    howCalculated,
    showComponentBreakdown,
    components: showComponentBreakdown ? scoreRow.component_scores || null : null,
    canCaptureClientRating,
    clientRatingQuestion,
    submittedClientRating,
    history,
    cadence,
  };
}

function buildPestPressureAdminView({ scoreRow }) {
  if (!scoreRow) return null;
  return {
    calculatedScore: scoreRow.calculated_score === null ? null : Number(scoreRow.calculated_score),
    displayedScore: scoreRow.displayed_score === null ? null : Number(scoreRow.displayed_score),
    isOverridden: Boolean(scoreRow.is_overridden),
    overrideReason: scoreRow.override_reason || null,
    overriddenBy: scoreRow.overridden_by || null,
    overriddenAt: scoreRow.overridden_at || null,
    componentScores: scoreRow.component_scores || null,
    componentWeights: scoreRow.component_weights || null,
    missingComponents: scoreRow.missing_components || [],
    configSnapshot: scoreRow.config_snapshot || null,
    calculationVersion: scoreRow.calculation_version || null,
    reviewPeriodStart: formatDate(scoreRow.review_period_start),
    reviewPeriodEnd: formatDate(scoreRow.review_period_end),
    calculatedAt: scoreRow.calculated_at || null,
  };
}

module.exports = {
  buildPestPressureCustomerView,
  buildPestPressureAdminView,
  isServiceLineEnabled,
  meetsRecurringFrequencyRequirement,
  resolveClientRatingQuestion,
};
