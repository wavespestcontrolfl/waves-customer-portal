'use strict';

/**
 * GATE_REPORT_WEB_LIVE_CHIP (owner 2026-10-20 "OK BUILD THEM ALL", idea 10): a "lawn status now" chip on the live
 * web service report. Built on every /data request, so it is never frozen, never in the PDF and never in a stored
 * record. One fixed sentence from measured rain at the home since the visit completed, or nothing:
 *
 *   rain in the last RECENT hours   "Rain fell N hours ago. Wait until the lawn is dry."
 *   rain covered the water-in       "Rain since your visit has watered the treatment in."
 *   a full dry read since the visit "No rain since your treatment."
 *   anything else (unknown, older than the window, no coordinates, no whole hour yet)  null: the chip is hidden
 *
 * Rain source: the Open-Meteo hourly past hours (application-conditions.fetchPropertyForecast, the reader the rainfast
 * watch and the water-in banner use, with its own 10-minute cache). A whole-hour LOWER bound: the hour in progress is
 * not counted, a missing hour reads unknown, never zero. The water-in line reuses lawn-water-in-rain.js (the visit's
 * frozen instruction and the products' frozen watering facts), so it agrees with the banner. No coordinate leaves
 * this module: the result is one sentence and a state word.
 */

const COPY = require('../../../shared/report-live-chip-copy.json');
const { resolveRainCoverage, appliesTo, COVERED_STATE } = require('./lawn-water-in-rain');

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const FETCH_TIMEOUT_MS = 2500;
// A reading under this is a trace the model rounds to nothing; one hundredth of an inch is "rain" for the chip.
const RAIN_HOUR_INCHES = 0.01;

const toMs = (value) => {
  if (value == null || value === '') return NaN;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
};

function rainLine(hoursAgo) {
  if (hoursAgo < 1) return COPY.rainWithinHour;
  return hoursAgo === 1 ? COPY.rainHoursAgoOne : COPY.rainHoursAgo.replace('{n}', String(hoursAgo));
}

/**
 * What the forecast's past-hour rows say about the time since the visit. Hour rows are stamped at the END of their hour:
 * row S holds the rain of S-1h..S. The window runs from the hour that CONTAINS the completion (its stamp is the first
 * hour boundary after it, so 10:15 reads the 11:00 row) through the last CLOSED hour (the stamp at or before now; the
 * hour in progress is unknown). Returns the last rainy row in that window (or null) and `dry`: true only when every row
 * of the window is present with a reading and none is rainy, so a gap or a partly read window never reads as dry.
 * A window with no closed hour yet is never dry.
 */
function rainSince(forecast, fromMs, nowMs) {
  const firstStamp = Math.floor(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  const lastStamp = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const byStamp = new Map((Array.isArray(forecast && forecast.hourly) ? forecast.hourly : []).map((r) => [toMs(r.at), r.precipitation_in]));
  const readings = [];
  for (let stamp = firstStamp; stamp <= lastStamp; stamp += HOUR_MS) readings.push({ ms: stamp, inches: byStamp.get(stamp) });
  const rainy = readings.filter((r) => typeof r.inches === 'number' && r.inches >= RAIN_HOUR_INCHES);
  return {
    last: rainy.length ? rainy[rainy.length - 1] : null,
    dry: readings.length > 0 && readings.every((r) => typeof r.inches === 'number' && r.inches < RAIN_HOUR_INCHES),
  };
}

/**
 * Did rain do the water-in? True when the banner already says so (GATE_LAWN_WATER_IN_RAIN replay), or rain measured since
 * the visit reaches the amount the products ask for (the same reader the banner uses). Needs a rainy hour to look at.
 */
async function rainWateredIn({ instruction, products, last, nowMs, latitude, longitude, fetchForecast }) {
  if (instruction && instruction.state === COVERED_STATE) return true;
  if (!last || !appliesTo(instruction)) return false;
  const coverage = await resolveRainCoverage({ instruction, products, now: new Date(nowMs), latitude, longitude, fetchForecast });
  return !!coverage && coverage.covered === true;
}

/**
 * @param {object} input
 * @param {Date|string} input.completedAt   when the visit finished
 * @param {object|null} input.instruction   the visit's frozen watering instruction (may be null)
 * @param {Array} input.products            the visit's products with approved_report_product_facts
 * @param {number|string} input.latitude
 * @param {number|string} input.longitude
 * @param {Date} [input.now]
 * @param {Function} input.fetchForecast    application-conditions.fetchPropertyForecast
 * @returns {Promise<{state: string, text: string}|null>}
 */
async function resolveLiveChip({
  completedAt, instruction, products, latitude, longitude, now, fetchForecast,
} = {}) {
  try {
    const fromMs = toMs(completedAt);
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    if (typeof fetchForecast !== 'function' || !Number.isFinite(fromMs)) return null;
    if (nowMs <= fromMs || nowMs - fromMs > COPY.visitWindowDays * DAY_MS) return null;

    const forecast = await fetchForecast({
      latitude, longitude, from: new Date(fromMs), to: new Date(nowMs), timeoutMs: FETCH_TIMEOUT_MS, now: new Date(nowMs),
    });
    if (!forecast || forecast.status !== 'ok') return null;
    const { last, dry } = rainSince(forecast, fromMs, nowMs);

    const hoursAgo = last ? Math.floor((nowMs - last.ms) / HOUR_MS) : null;
    if (hoursAgo !== null && hoursAgo <= COPY.recentHours) return { state: 'recent_rain', text: rainLine(hoursAgo) };

    if (await rainWateredIn({ instruction, products, last, nowMs, latitude, longitude, fetchForecast })) {
      return { state: 'watered_in', text: COPY.wateredIn };
    }

    // "No rain" needs every hour from the completion hour through the last closed hour, read and dry.
    return dry ? { state: 'no_rain', text: COPY.noRain } : null;
  } catch {
    return null;
  }
}

module.exports = { resolveLiveChip, RAIN_HOUR_INCHES };
