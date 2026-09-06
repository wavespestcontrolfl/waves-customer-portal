// Pure weather-evidence reader shared by the review writer and Job Card.
// The general label_verified_at stamp and all application rates stay untouched.
const { gateEnvValue } = require('../config/feature-gates');

const WEATHER_FIELDS = ['minTempF', 'maxTempF', 'maxWindMph', 'rainFreeHours'];
const SNAPSHOT_FIELDS = ['name', 'epa_reg_number', 'formulation', 'min_temp_f', 'max_temp_f', 'max_wind_mph', 'rainfast_minutes', 'rain_free_hours'];

function labelProductSnapshot(product) {
  return Object.fromEntries(SNAPSHOT_FIELDS.map((key) => [key, product[key] == null ? null : String(product[key])]));
}

function sameLabelProduct(product, snapshot) {
  const current = labelProductSnapshot(product);
  return Boolean(snapshot) && SNAPSHOT_FIELDS.every((key) => current[key] === snapshot[key]);
}

function reviewedWeather(product) {
  if (!gateEnvValue('GATE_LABEL_PIPELINE') || !product.label_weather_review?.active) return null;
  const review = product.label_weather_review.active;
  const empty = Object.fromEntries(WEATHER_FIELDS.map((key) => [key, null]));
  if (review.status !== 'approved' || !sameLabelProduct(product, review.productSnapshot)) {
    return { limits: empty, verified: false, unresolved: true };
  }
  const limits = {};
  let unresolved = false;
  for (const key of WEATHER_FIELDS) {
    const field = review.facts?.[key];
    limits[key] = field?.status === 'limit' && Number.isFinite(field.value) ? field.value : null;
    if (!['limit', 'not_stated'].includes(field?.status) || (field.status === 'limit' && limits[key] == null)) unresolved = true;
  }
  return { limits, verified: true, unresolved };
}

module.exports = { WEATHER_FIELDS, labelProductSnapshot, sameLabelProduct, reviewedWeather };
