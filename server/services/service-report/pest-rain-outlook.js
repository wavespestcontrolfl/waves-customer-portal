/**
 * Pest rain outlook (owner 2026-10-24, dark behind GATE_PEST_RAIN_OUTLOOK).
 *
 * Two halves, both pure apart from the one forecast call:
 *  - CAPTURE at completion: a 48-hour property forecast, frozen as a compact
 *    summary in service_records.structured_notes.rainOutlook. It is NEVER
 *    written to service_records.conditions: that column is copied verbatim
 *    into the FDACS application ledger, and a forecast is not an observation.
 *  - CARD: the pest report's Weather call card reads the frozen summary and
 *    says "Dry days ahead", or "Rain in the forecast" plus one sentence on how
 *    dried spray behaves.
 *
 * What the copy may claim is narrow on purpose. Once a spray has dried, rain
 * moves only a small part of fipronil and of the pyrethroids, because they
 * barely dissolve and bind to soil. Dinotefuran and the other soluble actives
 * dissolve far more readily, so nothing is claimed for them. The card never
 * says "rainproof", "waterproof", "rainfast" or "won't wash off", never names
 * a number of days, never invites the customer to call, text or report, and
 * never says the technician changed anything because of the weather.
 */

const { detectServiceLine } = require('./service-line-configs');
const { etParts, etDateString, formatETDay } = require('../../utils/datetime-et');

const HOUR_MS = 3600000;
const RAIN_OUTLOOK_VERSION = 1;
const RAIN_OUTLOOK_WINDOW_HOURS = 48;
// Completion must not wait long for a forecast; fetchPropertyForecast never throws.
const RAIN_OUTLOOK_FORECAST_TIMEOUT_MS = 2500;
// An hour counts as rain at 0.05 in; the window is dry under 0.05 in total and
// wet from 0.25 in total. Anything between is light rain: no statement.
const RAIN_HOUR_MIN_IN = 0.05;
const DRY_TOTAL_BELOW_IN = 0.05;
const RAIN_TOTAL_MIN_IN = 0.25;
// EPA's 2020 pyrethroid label language: 4 hours is the minimum drying time before rain.
const MIN_DRY_HOURS_BEFORE_RAIN = 4;

const DRY_HEADLINE = 'Dry days ahead';
const DRY_BODY = 'When we finished, the forecast showed dry weather for the next two days.';
const RAIN_HEADLINE = 'Rain in the forecast';
const FIPRONIL_LINE = 'Once dry, the spray around the outside of the house binds to the soil, so a storm moves only a small part of it.';
const PYRETHROID_LINE = 'Once dry, the spray around the outside of the house binds tightly to soil, mulch and plants, so a storm moves only a small part of it.';

// Only an explicit perimeter spray is an outside spray here. (pest-report-
// expectations.js keeps its own unexported set that also holds broadcast_spray;
// it cannot be imported without a require cycle through premium-experience.)
const OUTSIDE_SPRAY_METHODS = new Set(['perimeter_spray']);
const ADJUVANT_NAME_RE = /surfactant|adjuvant|spreader|sticker/i;
const SOLUBLE_RE = /\b(?:dinotefuran|imidacloprid|thiamethoxam|clothianidin|acetamiprid)\b/;
const FIPRONIL_RE = /\bfipronil\b/;
const PYRETHROID_RE = /\b(?:bifenthrin|cypermethrin|lambda cyhalothrin|deltamethrin|cyfluthrin|permethrin|esfenvalerate)\b/;

// Read at call time through the canonical reader. A suite that mocks
// feature-gates with a partial surface reads as gate-dark, never a TypeError.
function pestRainOutlookGateOn() {
  try {
    const gates = require('../../config/feature-gates');
    return typeof gates.pestRainOutlookLive === 'function' && gates.pestRainOutlookLive() === true;
  } catch {
    return false;
  }
}

// The frozen summary from a forecast result. Open-Meteo stamps an hour's rain
// at the END of that hour (application-conditions.js sliceForecast), so the
// first rain hour STARTS one hour before its stamp, and only hours wholly
// after completion count, the same intervals the window total counts.
// precipitationInTotal is null when any needed hour is missing: that is
// complete false, and the card then says nothing.
function buildRainOutlookSummary(forecast, completedAt) {
  if (!forecast || forecast.status !== 'ok') return null;
  const completedMs = completedAt.getTime();
  const complete = typeof forecast.precipitationInTotal === 'number' && Number.isFinite(forecast.precipitationInTotal);
  const firstHour = (Array.isArray(forecast.hourly) ? forecast.hourly : []).find((row) => {
    const stampMs = Date.parse(row?.at);
    return Number.isFinite(stampMs) && stampMs - HOUR_MS >= completedMs && row.precipitation_in >= RAIN_HOUR_MIN_IN;
  });
  return {
    v: RAIN_OUTLOOK_VERSION,
    source: 'open_meteo',
    fetchedAt: forecast.fetchedAt || null,
    completedAt: completedAt.toISOString(),
    windowHours: RAIN_OUTLOOK_WINDOW_HOURS,
    totalIn: complete ? Math.round(forecast.precipitationInTotal * 100) / 100 : null,
    firstRainAt: firstHour ? new Date(Date.parse(firstHour.at) - HOUR_MS).toISOString() : null,
    complete,
  };
}

// Completion-time capture. Resolves to the summary, or null when the gate is
// off, the visit is not the pest line, the forecast is unavailable, or anything
// throws. With the gate off the forecast is never requested.
async function capturePestRainOutlook({ svc, now = new Date() } = {}) {
  try {
    if (!pestRainOutlookGateOn() || detectServiceLine(svc?.service_type) !== 'pest') return null;
    const { fetchPropertyForecast } = require('./application-conditions');
    const forecast = await fetchPropertyForecast({
      latitude: svc.customer_latitude,
      longitude: svc.customer_longitude,
      from: now,
      to: new Date(now.getTime() + RAIN_OUTLOOK_WINDOW_HOURS * HOUR_MS),
      timeoutMs: RAIN_OUTLOOK_FORECAST_TIMEOUT_MS,
    });
    return buildRainOutlookSummary(forecast, now);
  } catch {
    return null;
  }
}

function normalizedIngredient(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sprayClass(ingredient) {
  const text = normalizedIngredient(ingredient);
  if (SOLUBLE_RE.test(text)) return 'soluble';
  if (FIPRONIL_RE.test(text)) return 'fipronil';
  if (PYRETHROID_RE.test(text)) return 'pyrethroid';
  return 'unknown';
}

// The one sentence the visit's outside sprays support, or null. No outside
// spray, or any soluble or unknown active among them, supports none.
function driedSprayLine(applications) {
  const classes = [];
  for (const app of Array.isArray(applications) ? applications : []) {
    if (!OUTSIDE_SPRAY_METHODS.has(String(app?.method || ''))) continue;
    const cls = sprayClass(app.activeIngredient ?? app.active_ingredient);
    // A surfactant or adjuvant row carries no pesticide active: not a spray.
    if (cls === 'unknown' && ADJUVANT_NAME_RE.test(String(app.productName || app.product_name || ''))) continue;
    classes.push(cls);
  }
  if (!classes.length || classes.some((cls) => cls === 'soluble' || cls === 'unknown')) return null;
  return classes.includes('fipronil') ? FIPRONIL_LINE : PYRETHROID_LINE;
}

// "that evening" on the completion's ET day, else "on Sunday evening".
function rainWhen(firstRainAt, completedAt) {
  const first = new Date(firstRainAt);
  const { hour } = etParts(first);
  let part = 'night';
  if (hour >= 5 && hour < 12) part = 'morning';
  else if (hour >= 12 && hour < 17) part = 'afternoon';
  else if (hour >= 17 && hour < 21) part = 'evening';
  return etDateString(first) === etDateString(new Date(completedAt))
    ? `that ${part}`
    : `on ${formatETDay(first)} ${part}`;
}

// { headline, body } for the Weather call card, or null for "today's card,
// unchanged": gate off, not the pest line, no complete frozen outlook, light
// rain, rain inside the drying time, or no supported line.
function buildRainOutlookCardCopy({ outlook, serviceLine, applications } = {}) {
  if (!pestRainOutlookGateOn() || serviceLine !== 'pest') return null;
  if (!outlook || typeof outlook !== 'object' || outlook.v !== RAIN_OUTLOOK_VERSION || outlook.complete !== true) return null;
  if (typeof outlook.totalIn !== 'number' || !Number.isFinite(outlook.totalIn)) return null;
  if (outlook.totalIn < DRY_TOTAL_BELOW_IN) return { headline: DRY_HEADLINE, body: DRY_BODY };
  if (outlook.totalIn < RAIN_TOTAL_MIN_IN) return null;
  const completedMs = Date.parse(outlook.completedAt);
  const rainMs = Date.parse(outlook.firstRainAt);
  if (!Number.isFinite(completedMs) || !Number.isFinite(rainMs) || rainMs - completedMs < MIN_DRY_HOURS_BEFORE_RAIN * HOUR_MS) return null;
  const line = driedSprayLine(applications);
  if (!line) return null;
  return {
    headline: RAIN_HEADLINE,
    body: `When we finished, the forecast showed rain ${rainWhen(outlook.firstRainAt, outlook.completedAt)}. ${line}`,
  };
}

module.exports = {
  pestRainOutlookGateOn,
  capturePestRainOutlook,
  buildRainOutlookSummary,
  buildRainOutlookCardCopy,
  RAIN_OUTLOOK_WINDOW_HOURS,
  RAIN_OUTLOOK_FORECAST_TIMEOUT_MS,
  FIPRONIL_LINE,
  PYRETHROID_LINE,
};
