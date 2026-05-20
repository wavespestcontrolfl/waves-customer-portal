/**
 * Pest Pressure config defaults + validation.
 *
 * The shape mirrors pest_pressure_configs columns. Each calculated score
 * stores a snapshot of the config it used, so historical reports stay
 * explainable when admin changes settings later.
 */

const COMPONENT_KEYS = ['client', 'technician', 'reService', 'recurring', 'risk'];

// These keys match the canonical IDs returned by
// services/service-report/service-line-configs.js#detectServiceLine —
// the gate compares against service_records.service_line || detectServiceLine(...),
// so the admin allow list MUST use the same vocabulary or the toggle
// silently does nothing. 'termite' covers termite bait monitoring;
// requireRecurringFrequency keeps one-time termite jobs out.
const SUPPORTED_SERVICE_LINES = [
  'pest',
  'mosquito',
  'rodent',
  'termite',
  'lawn',
  'tree_shrub',
  'palm',
];

const RECURRING_FREQUENCY_KEYS = new Set(['monthly', 'bimonthly', 'quarterly', 'semiannual']);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  showOnCustomerReport: true,
  showHowCalculated: true,
  showComponentBreakdownToCustomer: false,
  missingDataBehavior: 'recalculate_available_components',
  minimumDataRequired: { requireOneOf: ['technicianRating', 'clientRating', 'history'] },
  allowManualOverride: true,
  allowTechnicianClientRatingEntry: true,
  enabledServiceLines: ['pest', 'mosquito'],
  requireRecurringFrequency: true,
  weights: { client: 25, technician: 30, reService: 20, recurring: 15, risk: 10 },
  labels: [
    { key: 'very_low', name: 'Very Low', min: 0.0, max: 0.9, description: 'Little to no pest activity.' },
    { key: 'low', name: 'Low', min: 1.0, max: 1.9, description: 'Minor or occasional activity.' },
    { key: 'moderate', name: 'Moderate', min: 2.0, max: 2.9, description: 'Noticeable activity that should be watched.' },
    { key: 'elevated', name: 'Elevated', min: 3.0, max: 3.9, description: 'Recurring or spreading activity.' },
    { key: 'high', name: 'High', min: 4.0, max: 5.0, description: 'Heavy activity, repeated issues, or urgent concern.' },
  ],
  trendThresholds: {
    improvingAtOrBelow: -0.5,
    stableBand: 0.4,
    increasingFrom: 0.5,
    significantIncreaseFrom: 1.0,
  },
  serviceFrequencyWindows: {
    monthly: 30,
    bimonthly: 60,
    quarterly: 90,
    semiannual: 180,
    fallbackDays: 90,
  },
  clientQuestionText: {
    monthly: 'Since your last service, how much pest activity have you noticed?',
    bimonthly: 'Over the past 2 months, how much pest activity have you noticed?',
    quarterly: 'Over the past 3 months, how much pest activity have you noticed?',
    custom: 'Since your last service, how much pest activity have you noticed?',
  },
  customerExplanationText:
    'Pest Pressure is a 0–5 score that estimates the current level of pest activity at your property. The score combines reported activity, technician observations, re-service history, recurring issue areas, and property risk factors such as entry points, moisture, sanitation, or harborage conditions.\n\nFor monthly services, we review activity since the last visit. For bi-monthly services, we review the past two months. For quarterly services, we review the past three months. Future reports compare scores over time to show whether pest pressure is improving, stable, or increasing.',
  calculationVersion: '1.0',
});

const VALID_MISSING_DATA_BEHAVIORS = new Set([
  'recalculate_available_components',
  'treat_missing_as_zero',
  'require_minimum',
]);

const WEIGHT_TOTAL_TOLERANCE = 0.01;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateWeights(weights, errors) {
  if (!weights || typeof weights !== 'object') {
    errors.push({ field: 'weights', message: 'weights must be an object' });
    return;
  }
  let total = 0;
  for (const key of COMPONENT_KEYS) {
    const w = weights[key];
    if (!isFiniteNumber(w)) {
      errors.push({ field: `weights.${key}`, message: 'must be a finite number' });
      continue;
    }
    if (w < 0) {
      errors.push({ field: `weights.${key}`, message: 'must be non-negative' });
    }
    total += w;
  }
  if (Math.abs(total - 100) > WEIGHT_TOTAL_TOLERANCE) {
    errors.push({ field: 'weights', message: `weights must sum to 100, got ${total}` });
  }
}

function validateLabels(labels, errors) {
  if (!Array.isArray(labels) || labels.length === 0) {
    errors.push({ field: 'labels', message: 'labels must be a non-empty array' });
    return;
  }
  const sorted = labels.slice().sort((a, b) => a.min - b.min);
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    if (!row || typeof row !== 'object') {
      errors.push({ field: `labels[${i}]`, message: 'must be an object' });
      return;
    }
    if (!isFiniteNumber(row.min) || !isFiniteNumber(row.max)) {
      errors.push({ field: `labels[${i}]`, message: 'min and max must be numbers' });
      return;
    }
    if (row.min < 0 || row.max > 5) {
      errors.push({ field: `labels[${i}]`, message: 'must stay within 0–5' });
    }
    if (row.max < row.min) {
      errors.push({ field: `labels[${i}]`, message: 'max must be >= min' });
    }
    if (!row.name || typeof row.name !== 'string') {
      errors.push({ field: `labels[${i}].name`, message: 'name is required' });
    }
  }
  if (sorted[0].min > 0) {
    errors.push({ field: 'labels', message: 'lowest label.min must be 0' });
  }
  if (sorted[sorted.length - 1].max < 5) {
    errors.push({ field: 'labels', message: 'highest label.max must be 5' });
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    // Adjacent labels must touch with no gap (within 0.05 tolerance for the
    // 0.9 -> 1.0 style boundaries) and no overlap.
    if (cur.min - prev.max > 0.15) {
      errors.push({ field: 'labels', message: `gap between "${prev.name}" and "${cur.name}"` });
    }
    if (cur.min <= prev.max - 0.01) {
      errors.push({ field: 'labels', message: `overlap between "${prev.name}" and "${cur.name}"` });
    }
  }
}

function validateTrendThresholds(t, errors) {
  if (!t || typeof t !== 'object') {
    errors.push({ field: 'trendThresholds', message: 'must be an object' });
    return;
  }
  for (const key of ['improvingAtOrBelow', 'stableBand', 'increasingFrom', 'significantIncreaseFrom']) {
    if (!isFiniteNumber(t[key])) {
      errors.push({ field: `trendThresholds.${key}`, message: 'must be a finite number' });
    }
  }
  if (errors.some((e) => e.field.startsWith('trendThresholds.'))) return;
  if (t.improvingAtOrBelow >= 0) {
    errors.push({ field: 'trendThresholds.improvingAtOrBelow', message: 'must be negative' });
  }
  if (t.stableBand < 0) {
    errors.push({ field: 'trendThresholds.stableBand', message: 'must be non-negative' });
  }
  if (t.increasingFrom <= 0) {
    errors.push({ field: 'trendThresholds.increasingFrom', message: 'must be positive' });
  }
  if (t.significantIncreaseFrom <= t.increasingFrom) {
    errors.push({ field: 'trendThresholds.significantIncreaseFrom', message: 'must be greater than increasingFrom' });
  }
}

function validateFrequencyWindows(w, errors) {
  if (!w || typeof w !== 'object') {
    errors.push({ field: 'serviceFrequencyWindows', message: 'must be an object' });
    return;
  }
  for (const key of ['monthly', 'bimonthly', 'quarterly', 'semiannual', 'fallbackDays']) {
    const v = w[key];
    if (!isFiniteNumber(v) || v <= 0) {
      errors.push({ field: `serviceFrequencyWindows.${key}`, message: 'must be a positive number of days' });
    }
  }
}

function validateEnabledServiceLines(lines, errors) {
  if (!Array.isArray(lines)) {
    errors.push({ field: 'enabledServiceLines', message: 'must be an array' });
    return;
  }
  if (lines.length === 0) {
    errors.push({ field: 'enabledServiceLines', message: 'must include at least one service line' });
    return;
  }
  for (const line of lines) {
    if (!SUPPORTED_SERVICE_LINES.includes(line)) {
      errors.push({ field: 'enabledServiceLines', message: `unknown service line "${line}"` });
    }
  }
}

function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: [{ field: '', message: 'config must be an object' }] };
  }
  validateWeights(config.weights, errors);
  validateLabels(config.labels, errors);
  validateTrendThresholds(config.trendThresholds, errors);
  validateFrequencyWindows(config.serviceFrequencyWindows, errors);
  validateEnabledServiceLines(config.enabledServiceLines, errors);
  if (typeof config.requireRecurringFrequency !== 'boolean') {
    errors.push({ field: 'requireRecurringFrequency', message: 'must be a boolean' });
  }
  if (!VALID_MISSING_DATA_BEHAVIORS.has(config.missingDataBehavior)) {
    errors.push({ field: 'missingDataBehavior', message: `must be one of ${[...VALID_MISSING_DATA_BEHAVIORS].join(', ')}` });
  }
  if (!config.calculationVersion || typeof config.calculationVersion !== 'string') {
    errors.push({ field: 'calculationVersion', message: 'is required' });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Deep clone a config so the snapshot stored with each score won't mutate
 * if the runtime config is later changed in-memory. Plain JSON shape, no
 * functions, so structuredClone-equivalent via JSON is safe and cheap.
 */
function snapshotConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

module.exports = {
  COMPONENT_KEYS,
  DEFAULT_CONFIG,
  VALID_MISSING_DATA_BEHAVIORS,
  SUPPORTED_SERVICE_LINES,
  RECURRING_FREQUENCY_KEYS,
  validateConfig,
  snapshotConfig,
};
