/**
 * Pest Pressure scoring engine.
 *
 * Pure function. Takes structured component inputs + a validated config,
 * returns the calculated score, label, trend, and an audit-friendly
 * breakdown including a snapshot of the config used.
 *
 * Component values are 0–5 ratings (or null when missing). Weights are
 * configured as percentages (sum 100). The engine handles missing
 * components per config.missingDataBehavior and reports
 * dataCompleteness so callers can decide whether to surface the score
 * to the customer.
 *
 * Caller responsibilities:
 *   - Provide previousScore (or null) — engine does not query DB.
 *   - Provide reviewPeriodStart/End — engine does not compute the window.
 *   - Validate the config with validateConfig() before calling.
 */

const { COMPONENT_KEYS, snapshotConfig } = require('./config');
const { resolveLabel } = require('./label');
const { resolveTrend } = require('./trend');
const { resolveCustomerSummary } = require('./explanation');

const INPUT_KEY_TO_WEIGHT_KEY = Object.freeze({
  clientRating: 'client',
  technicianRating: 'technician',
  reServiceImpact: 'reService',
  recurringIssueRating: 'recurring',
  riskFactorRating: 'risk',
});

const INPUT_KEYS = Object.freeze(Object.keys(INPUT_KEY_TO_WEIGHT_KEY));

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundToOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

function isValidRating(value) {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return value >= 0 && value <= 5;
}

function buildComponents(input, weights) {
  return INPUT_KEYS.map((inputKey) => {
    const weightKey = INPUT_KEY_TO_WEIGHT_KEY[inputKey];
    const rawValue = input[inputKey];
    const present = isValidRating(rawValue);
    return {
      key: inputKey,
      weightKey,
      value: present ? Number(rawValue) : null,
      weight: Number(weights[weightKey] || 0),
      present,
    };
  });
}

function meetsMinimum(components, minimumDataRequired) {
  const requireOneOf = (minimumDataRequired && minimumDataRequired.requireOneOf) || [];
  if (requireOneOf.length === 0) {
    return components.some((c) => c.present);
  }
  return requireOneOf.some((requirement) => {
    if (requirement === 'history') {
      return components.some((c) => c.present && (c.key === 'reServiceImpact' || c.key === 'recurringIssueRating'));
    }
    return components.some((c) => c.present && c.key === requirement);
  });
}

function applyMissingDataBehavior(components, behavior, minimumDataRequired) {
  if (behavior === 'treat_missing_as_zero') {
    const filled = components.map((c) => ({ ...c, value: c.present ? c.value : 0 }));
    return { components: filled, weightDenominator: 100 };
  }

  if (behavior === 'require_minimum') {
    if (!meetsMinimum(components, minimumDataRequired)) {
      return { components: components.filter((c) => c.present), weightDenominator: 0 };
    }
    const present = components.filter((c) => c.present);
    const denom = present.reduce((s, c) => s + c.weight, 0);
    return { components: present, weightDenominator: denom };
  }

  // Default: recalculate_available_components
  const present = components.filter((c) => c.present);
  const denom = present.reduce((s, c) => s + c.weight, 0);
  return { components: present, weightDenominator: denom };
}

function computeWeightedScore(components, weightDenominator) {
  if (weightDenominator <= 0) return null;
  const sum = components.reduce((s, c) => s + c.value * (c.weight / weightDenominator), 0);
  return roundToOneDecimal(clamp(sum, 0, 5));
}

function summarizeComponents(components) {
  const out = {};
  for (const c of components) {
    out[c.key] = {
      value: c.value,
      weight: c.weight,
      present: c.present,
    };
  }
  return out;
}

function calculatePestPressureScore(input, config) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('calculatePestPressureScore: input is required');
  }
  if (!config || typeof config !== 'object') {
    throw new TypeError('calculatePestPressureScore: config is required');
  }

  for (const key of INPUT_KEYS) {
    if (input[key] !== null && input[key] !== undefined && !isValidRating(input[key])) {
      throw new RangeError(`calculatePestPressureScore: ${key} must be a number between 0 and 5`);
    }
  }

  const allComponents = buildComponents(input, config.weights);
  const missingComponents = allComponents.filter((c) => !c.present).map((c) => c.key);
  const present = allComponents.filter((c) => c.present);
  const baseSnapshot = snapshotConfig(config);
  const sharedAudit = {
    componentScores: summarizeComponents(allComponents),
    componentWeights: { ...config.weights },
    missingComponents,
    calculationVersion: config.calculationVersion,
    configSnapshot: baseSnapshot,
  };

  if (!meetsMinimum(allComponents, config.minimumDataRequired)) {
    const summary = resolveCustomerSummary({ trend: 'insufficient_data', label: null, dataCompleteness: 'insufficient' });
    return {
      score: null,
      displayedScore: null,
      label: null,
      trend: 'insufficient_data',
      trendDelta: null,
      dataCompleteness: 'insufficient',
      summary,
      ...sharedAudit,
    };
  }

  const { components: scoringComponents, weightDenominator } = applyMissingDataBehavior(
    allComponents,
    config.missingDataBehavior,
    config.minimumDataRequired,
  );

  const score = computeWeightedScore(scoringComponents, weightDenominator);

  if (score === null) {
    const summary = resolveCustomerSummary({ trend: 'insufficient_data', label: null, dataCompleteness: 'insufficient' });
    return {
      score: null,
      displayedScore: null,
      label: null,
      trend: 'insufficient_data',
      trendDelta: null,
      dataCompleteness: 'insufficient',
      summary,
      ...sharedAudit,
    };
  }

  const label = resolveLabel(score, config.labels);
  const { trend, delta } = resolveTrend(score, input.previousScore ?? null, config.trendThresholds);
  const dataCompleteness = present.length === allComponents.length ? 'complete' : 'partial';
  const summary = resolveCustomerSummary({ trend, label, dataCompleteness });

  return {
    score,
    displayedScore: score,
    label,
    trend,
    trendDelta: delta,
    dataCompleteness,
    summary,
    ...sharedAudit,
  };
}

module.exports = {
  INPUT_KEYS,
  INPUT_KEY_TO_WEIGHT_KEY,
  calculatePestPressureScore,
  // Exposed for tests
  _internal: {
    buildComponents,
    meetsMinimum,
    applyMissingDataBehavior,
    computeWeightedScore,
    roundToOneDecimal,
    clamp,
  },
};
