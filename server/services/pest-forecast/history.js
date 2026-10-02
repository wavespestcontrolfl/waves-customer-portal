/** Daily, immutable model snapshots. Public forecast requests only READ history.
 * No customer data is stored here. Bump MODEL_VERSION when scoring or location
 * definitions change; two different models must never manufacture a trend.
 */
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays, validCalendarDate } = require('../../utils/datetime-et');
const { MODEL_VERSION, trendFor } = require('./pests');

const TABLE = 'pest_forecast_snapshots';
const historyEnabled = () => gateEnvValue('GATE_PEST_FORECAST_HISTORY');
const weekBefore = (day) => validCalendarDate(day)
  ? etDateString(addETDays(new Date(`${day}T12:00:00Z`), -7)) : null;

// Compare the same city's same model exactly seven calendar days apart. An
// outage, a missing pest, or an unversioned payload is unknown, never "flat".
function compareForecasts(current, previous) {
  const comparable = previous && current.model_version === MODEL_VERSION
    && previous.model_version === current.model_version
    && previous.location?.slug === current.location?.slug
    && previous.as_of_date === weekBefore(current.as_of_date)
    && current.weather?.available === true && previous.weather?.available === true
    && current.weather.source === previous.weather.source
    && ['temp_high_f', 'precip_chance', 'recent_rain_in'].every(key =>
      (current.weather[key] != null) === (previous.weather[key] != null))
    && new Date(previous.generated_at) < new Date(current.generated_at);
  const prior = new Map((comparable && Array.isArray(previous.pests) ? previous.pests : []).map(p => [p.key, p]));
  return {
    ...current,
    pests: current.pests.map(p => {
      const old = prior.get(p.key);
      const valid = old && Number.isFinite(old.score) && Number.isFinite(p.score);
      return { ...p, week_over_week: valid ? {
        direction: trendFor(p.score, old.score),
        delta: Math.round((p.score - old.score) * 10) / 10,
        previous_date: previous.as_of_date,
        current_date: current.as_of_date,
      } : null };
    }),
  };
}

async function readPreviousForecast(forecast, knex = require('../../models/db')) {
  let timer;
  try {
    // Knex's query timeout starts AFTER pool acquisition. Bound the entire
    // optional read so a saturated pool cannot stall the public weather feed.
    const row = await Promise.race([
      knex(TABLE).where({
        location_slug: forecast.location.slug,
        forecast_date: weekBefore(forecast.as_of_date),
        model_version: forecast.model_version,
      }).first('forecast').timeout(750, { cancel: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('History read timed out')), 750); }),
    ]);
    return row?.forecast || null;
  } finally {
    clearTimeout(timer);
  }
}

async function saveSnapshot(forecast, knex = require('../../models/db')) {
  if (forecast.weather?.available !== true) return false;
  const inserted = await knex(TABLE).insert({
    location_slug: forecast.location.slug,
    forecast_date: forecast.as_of_date,
    model_version: forecast.model_version,
    generated_at: forecast.generated_at,
    forecast: JSON.stringify(forecast),
  }).onConflict(['location_slug', 'forecast_date', 'model_version']).ignore().returning('location_slug');
  return inserted.length > 0;
}

// Twice-daily cron retries cities whose morning weather was unavailable. The
// first successful snapshot wins, including across a deploy overlap. Never
// backfill history with today's weather or overwrite a captured prediction.
async function collectDailyForecasts({ now = new Date(), knex } = {}) {
  if (!historyEnabled()) return { skipped: 'gated' };
  knex ||= require('../../models/db');
  const { LOCATIONS } = require('./locations');
  const { getWeatherSignals } = require('./weather');
  const { computeForecast } = require('./forecast');
  const day = etDateString(now);
  const existing = await knex(TABLE).where({ forecast_date: day, model_version: MODEL_VERSION }).pluck('location_slug');
  const seen = new Set(existing);
  const result = { saved: 0, existing: seen.size, unavailable: 0, errors: 0 };
  for (const location of LOCATIONS) {
    if (seen.has(location.slug)) continue;
    try {
      const signals = await getWeatherSignals(location);
      if (!signals.hasWeather) { result.unavailable += 1; continue; }
      if (await saveSnapshot(computeForecast(location, signals, now), knex)) result.saved += 1;
    } catch {
      result.errors += 1;
    }
  }
  if (result.errors || result.unavailable) {
    throw new Error(`Pest forecast history incomplete: ${result.saved} saved, ${result.unavailable} weather unavailable, ${result.errors} failed`);
  }
  return result;
}

module.exports = { TABLE, historyEnabled, weekBefore, compareForecasts, readPreviousForecast, saveSnapshot, collectDailyForecasts };
