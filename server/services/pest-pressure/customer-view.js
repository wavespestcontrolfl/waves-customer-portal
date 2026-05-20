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


function buildPestPressureCustomerView({ config, scoreRow, serviceRecord = null }) {
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
  const submittedClientRating = hasClientRating ? Number(serviceRecord.client_pest_rating) : null;

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
