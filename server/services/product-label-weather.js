// Weather-evidence reader and source checks shared by Inventory and Job Card.
// The general label_verified_at stamp and all application rates stay untouched.
const { gateEnvValue } = require('../config/feature-gates');
const { keptEpaSourceStatus } = require('./epa-label-check-keep');

const WEATHER_FIELDS = ['minTempF', 'maxTempF', 'maxWindMph', 'rainFreeHours'];
// Why a reviewed label is not current, for each EPA answer; no answer at all says "try again".
const SOURCE_REASONS = {
  superseded: 'EPA label changed — read and review the latest label',
  inactive: 'EPA registration cancelled or label removed — review the product',
};
const SNAPSHOT_FIELDS = ['name', 'epa_reg_number', 'formulation', 'min_temp_f', 'max_temp_f', 'max_wind_mph', 'rainfast_minutes', 'rain_free_hours'];

function labelProductSnapshot(product) {
  return Object.fromEntries(SNAPSHOT_FIELDS.map((key) => [key, product[key] == null ? null : String(product[key])]));
}

function sameLabelProduct(product, snapshot) {
  const current = labelProductSnapshot(product);
  return Boolean(snapshot) && SNAPSHOT_FIELDS.every((key) => current[key] === snapshot[key]);
}

function reviewedWeather(product, sourceStatus) {
  if (!gateEnvValue('GATE_LABEL_PIPELINE') || !product.label_weather_review?.active) return null;
  const review = product.label_weather_review.active;
  const empty = Object.fromEntries(WEATHER_FIELDS.map((key) => [key, null]));
  if (review.status !== 'approved' || !sameLabelProduct(product, review.productSnapshot)) {
    return { limits: empty, verified: false, unresolved: true, reason: 'Label review revoked or product changed' };
  }
  if (sourceStatus !== 'current') {
    return { limits: empty, verified: false, unresolved: true, reason: SOURCE_REASONS[sourceStatus] || 'Current EPA label could not be verified — try again' };
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

async function checkReviewedWeatherSources(products) {
  if (!gateEnvValue('GATE_LABEL_PIPELINE')) return {};
  const approved = products.filter((product) => product.label_weather_review?.active?.status === 'approved'
    && sameLabelProduct(product, product.label_weather_review.active.productSnapshot));
  // A failed EPA check uses the last check that got an answer, up to 7 days old (epa-label-check-keep.js).
  return Object.fromEntries(await Promise.all(approved.map(async (product) => [product.id, await keptEpaSourceStatus(product.label_weather_review.active.source)])));
}

module.exports = { WEATHER_FIELDS, SOURCE_REASONS, labelProductSnapshot, sameLabelProduct, reviewedWeather, checkReviewedWeatherSources };
