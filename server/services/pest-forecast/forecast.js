/**
 * Public Pest Pressure Forecast orchestrator.
 *
 * Resolves an inbound request (location slug / zip) to a Florida point, pulls
 * live weather signals, scores every pest for the current month, and assembles
 * the JSON payload consumed by the public route and the embeddable widget.
 *
 * computeForecast() is pure (location + signals + date in, payload out) so the
 * model is unit-testable without the network. getForecast() wraps it with the
 * live weather lookup and a 3-hour per-location response cache.
 */

const { scorePests } = require('./pests');
const { resolveLocation } = require('./locations');
const { getWeatherSignals } = require('./weather');

const SITE = 'https://www.wavespestcontrol.com';
const LANDING = `${SITE}/tools/pest-pressure-forecast/`;
const BRAND = 'Waves Pest Control';
const DISCLAIMER = 'An informational forecast based on Florida pest seasonality and local weather, not a guarantee of pest activity.';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
const _cache = new Map(); // slug -> { at, value }

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
  if (s.hot) return 'Hot, dry weather';
  if (s.warm) return 'Warm weather';
  if (s.dry) return 'Dry weather';
  return `${monthName} weather`;
}

function buildSummary(pests, s, monthName) {
  const lead = weatherLead(s, monthName);
  const rising = pests.filter((p) => p.trend === 'up').slice(0, 2).map((p) => p.shortName);
  if (rising.length) return `${lead} → ${joinList(rising)} pressure is climbing this week.`;
  const watch = pests.filter((p) => p.level === 'high' || p.level === 'elevated').slice(0, 2).map((p) => p.shortName);
  if (watch.length) return `${lead} keeps ${joinList(watch)} the pests to watch right now.`;
  return `${lead} keeps overall pest pressure on the lower side this week.`;
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
      level: p.level,
      trend: p.trend,
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
 * Live forecast: resolve location, fetch weather, compute, cache per slug.
 * Never throws — weather failures degrade to the seasonal baseline.
 */
async function getForecast({ location, zip } = {}, { now } = {}) {
  const loc = resolveLocation({ location, zip });
  const cached = _cache.get(loc.slug);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value;

  const signals = await getWeatherSignals({ lat: loc.lat, lng: loc.lng, region: loc.region });
  const value = computeForecast(loc, signals, now || new Date());
  _cache.set(loc.slug, { at: Date.now(), value });
  return value;
}

function _clearCache() { _cache.clear(); } // test hook

module.exports = { getForecast, computeForecast, _clearCache, LANDING, BRAND };
