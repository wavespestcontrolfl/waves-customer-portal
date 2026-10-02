/**
 * Public Pest Pressure Forecast orchestrator.
 *
 * Resolves an inbound request (location slug / zip) to a Florida point, pulls
 * live weather signals, scores every pest for the current month, and assembles
 * the JSON payload consumed by the public route and the embeddable widget.
 *
 * computeForecast() is pure (location + signals + date in, payload out) so the
 * model is unit-testable without the network. getForecast() wraps it with the
 * live weather lookup and a per-location response cache that lasts exactly
 * as long as the weather signals it was computed from (their freshUntil).
 */

const { scorePests, MODEL_VERSION } = require('./pests');
const { resolveLocation } = require('./locations');
const { getWeatherSignals } = require('./weather');
const { historyEnabled, compareForecasts, readPreviousForecast } = require('./history');
const logger = require('../logger');

const SITE = 'https://www.wavespestcontrol.com';
const LANDING = `${SITE}/tools/pest-pressure-forecast/`;
const BRAND = 'Waves Pest Control';
const DISCLAIMER = 'A seasonal and weather-based model, not a measurement or guarantee of pest activity. Local observation accuracy has not yet been validated.';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const _cache = new Map(); // slug -> { forecast, freshUntil }

// Portal runs on Eastern Time end-to-end; derive the calendar month/day there
// so the seasonal curve and the "as of" label don't shift around UTC midnight.
function etParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { year: parts.year, month: Number(parts.month), dateStr: `${parts.year}-${parts.month}-${parts.day}` };
}

function joinList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function weatherLead(s, monthName) {
  if (!s.hasWeather) return `${monthName} in Florida`;
  if (s.hot && s.wet) return 'Hot and wet weather';
  if (s.warm && s.wet) return 'Warm, wet weather';
  if (s.wet) return 'A wet stretch';
  if (s.coolSnap) return 'A cool snap';
  if (s.hot) return s.dry ? 'Hot, dry weather' : 'Hot weather';
  if (s.warm) return 'Warm weather';
  if (s.dry) return 'Dry weather';
  return `${monthName} weather`;
}

function buildSummary(pests, s, monthName) {
  const lead = weatherLead(s, monthName);
  const above = pests.filter((p) => p.baseline_comparison === 'above').slice(0, 2).map((p) => p.shortName);
  if (above.length) return `${lead} puts the modeled outlook for ${joinList(above)} above the usual ${monthName} baseline.`;
  const watch = pests.filter((p) => p.level === 'high' || p.level === 'elevated').slice(0, 2).map((p) => p.shortName);
  if (watch.length) return `${lead}: the model rates ${joinList(watch)} as elevated for current conditions.`;
  return `${lead}: the model rates overall pest pressure on the lower side for current conditions.`;
}

function weatherSummary(s) {
  if (!s.hasWeather) return 'Seasonal outlook (live weather unavailable)';
  const parts = [];
  if (s.tempHighF != null) parts.push(`${s.tempHighF}°F`);
  if (s.precipChance != null) parts.push(`${s.precipChance}% chance of rain`);
  return parts.join(' · ') || 'Seasonal outlook';
}

/**
 * Pure forecast assembly. location: resolved location object; signals: from
 * weather.flags(); date: JS Date (defaults handled by caller). Deterministic.
 */
function computeForecast(location, signals, date) {
  const { month, dateStr } = etParts(date);
  const monthName = MONTHS[month - 1];
  const ranked = scorePests(month, signals);

  return {
    model_version: MODEL_VERSION,
    evidence: { kind: 'seasonal_weather_model', observation_validation: 'not_validated' },
    location: {
      slug: location.slug,
      label: location.label,
      region: location.region,
      county: location.county || null,
    },
    as_of_date: dateStr,
    generated_at: date.toISOString(),
    month,
    month_name: monthName,
    weather: {
      available: !!signals.hasWeather,
      temp_high_f: signals.tempHighF ?? null,
      precip_chance: signals.precipChance ?? null,
      recent_rain_in: signals.recentRainIn ?? null,
      source: signals.source ?? null,
      summary: weatherSummary(signals),
    },
    summary: buildSummary(ranked, signals, monthName),
    pests: ranked.map((p) => ({
      key: p.key,
      label: p.label,
      emoji: p.emoji,
      category: p.category,
      score: p.score,
      score10: p.score10,
      baseline: p.baseline,
      baseline_comparison: p.baseline_comparison,
      level: p.level,
      trend: p.trend,
      trend_basis: 'seasonal_baseline',
      week_over_week: null,
      note: p.note,
    })),
    attribution: {
      brand: BRAND,
      text: `Florida Pest Pressure Forecast by ${BRAND}`,
      url: `${LANDING}?utm_source=embed&utm_medium=widget&utm_campaign=pest-forecast&utm_content=${encodeURIComponent(location.slug)}`,
    },
    disclaimer: DISCLAIMER,
  };
}

/**
 * Live forecast plus the epoch ms it stays fresh until — the weather signals'
 * freshUntil (3 hours; 15 minutes while a SWFL city's rain reading is
 * missing; never past ET midnight). Cached per slug for exactly that long;
 * the public route derives its HTTP cache lifetimes from it. Never throws —
 * weather failures degrade to the seasonal baseline.
 */
async function getForecastWithFreshness({ location, zip } = {}, { now } = {}) {
  const loc = resolveLocation({ location, zip });
  const withHistory = historyEnabled();
  // A kill-switch change must not keep serving a history-enriched cached row.
  const cacheKey = `${loc.slug}:${withHistory}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() < cached.freshUntil) return cached;

  const signals = await getWeatherSignals({ lat: loc.lat, lng: loc.lng, region: loc.region });
  let forecast = computeForecast(loc, signals, now || new Date());
  if (withHistory) {
    try {
      forecast = compareForecasts(forecast, await readPreviousForecast(forecast));
    } catch (err) {
      // Missing migration / DB outage must not take the weather outlook down
      // or turn an unavailable comparison into an invented "flat" trend.
      logger.warn(`[pest-forecast] history unavailable: ${err.message}`);
    }
  }
  const entry = { forecast, freshUntil: signals.freshUntil };
  _cache.set(cacheKey, entry);
  return entry;
}

/** The live forecast payload alone (see getForecastWithFreshness). */
async function getForecast(request, options) {
  return (await getForecastWithFreshness(request, options)).forecast;
}

function _clearCache() { _cache.clear(); } // test hook

module.exports = { getForecast, getForecastWithFreshness, computeForecast, _clearCache, LANDING, BRAND };
