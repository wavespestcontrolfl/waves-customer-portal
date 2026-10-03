'use strict';

// Rainfast breach watch (GATE_LAWN_RAINFAST_WATCH, lawn report rebuild P31).
//
// A product whose catalog row states a rainfast interval (rainfast_minutes,
// from the label) is judged against measured rain: when at least 0.25 inch fell
// at the property INSIDE that interval after the visit completed, the visit's
// memory gets ONE retreat-check item and the live report's Watching line gets
// ONE fixed sentence. No interval stated = never judged (nothing is invented
// from a product's category or a generic default).
//
// Source: the Open-Meteo hourly series (fetchPropertyForecast, the same client
// and cache as the watering forecast), asked for hours that are already past.
// That is a weather MODEL's analysis of the hour (radar and station data
// assimilated into a ~3 km grid), not a gauge at the lawn. The only other
// observed source in the repo, MRMS radar (mrms-qpe.js), returns DAILY totals
// and cannot place rain inside a window of a few hours, so it cannot support
// this question. The customer sentence says what the source can support: that
// "our weather data" shows rain soon after the treatment, never that it rained
// on this lawn.
//
// Honesty rules, all fail closed (no item, no sentence):
//   - the total is the rain in the whole slots lying wholly INSIDE
//     [completion, completion + interval], a LOWER bound of the true rain in
//     the window: whole hours for an interval of 2 hours or more
//     (fetchPropertyForecast), whole quarter-hours for a shorter one
//     (fetchPropertyRainQuarterHours, same model, finer stamps). A window with
//     no whole slot inside it reads null and is never judged;
//   - the 0.25 inch test is on the UNROUNDED sum of the readings; the stored
//     figure is rounded to hundredths only after the test;
//   - any needed hour missing, a failed or slow fetch, no coordinates and no
//     completion time all read null, never as "no rain" and never as rain;
//   - nothing is judged until one hour after the interval ended (the last hour
//     counted is then a finished hour), and not after LOOKBACK_DAYS;
//   - the verdict is written to the visit memory once (first writer wins) and
//     every later render replays the stored item without a fetch.

const logger = require('../logger');

const HOUR_MS = 3600000;
const BREACH_INCHES = 0.25;
// Float slack only (0.15 + 0.1 must read as 0.25); far below any reading step.
const EPSILON = 1e-9;
// Windows shorter than this are read from the quarter-hour series.
const QUARTER_HOUR_BELOW_MINUTES = 120;
const SETTLE_MS = HOUR_MS;
const LOOKBACK_DAYS = 7;
const MAX_INTERVAL_MINUTES = 48 * 60;
const FETCH_TIMEOUT_MS = 2500;
const ITEM_VERSION = 1;
const ITEM_KIND = 'rainfast_breach';
const UNREAD = Symbol('window could not be read');

// The one customer sentence. Says what the source supports (weather data, soon
// after), promises no action beyond looking at the next visit, no probability,
// no free re-treatment, no product name, no number.
const RAINFAST_WATCH_LINE = 'Our weather data shows rain soon after your treatment, so we will re-check it at your next visit.';

function toMs(value) {
  if (value == null || value === '') return NaN;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * The distinct rainfast intervals of the products applied, each with the
 * names that carry it: [{ minutes, products: [name...] }]. A product with no
 * positive, plausible rainfast_minutes is skipped (never judged). Pure.
 * @param {Array<{product_name?: string, approved_report_product_facts?: {rainfastMinutes?: number|null}}>} products
 */
function rainfastWindows(products) {
  const byMinutes = new Map();
  for (const product of Array.isArray(products) ? products : []) {
    const raw = product?.approved_report_product_facts?.rainfastMinutes;
    if (raw == null || raw === '') continue;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_INTERVAL_MINUTES) continue;
    const name = typeof product.product_name === 'string' ? product.product_name.trim().slice(0, 200) : '';
    if (!byMinutes.has(minutes)) byMinutes.set(minutes, []);
    if (name && !byMinutes.get(minutes).includes(name)) byMinutes.get(minutes).push(name);
  }
  return [...byMinutes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minutes, names]) => ({ minutes, products: names }));
}

/**
 * Judge the visit against measured rain. Returns the retreat-check item, or
 * null (nothing to say, not yet judgeable, or any input missing).
 *
 * @param {object} input
 * @param {Array} input.products       the visit's products (rainfastWindows shape)
 * @param {Date|string} input.completedAt
 * @param {Date} [input.now]
 * @param {number|string} input.latitude
 * @param {number|string} input.longitude
 * @param {Function} input.fetchForecast  application-conditions fetchPropertyForecast
 */
async function judgeRainfastBreach({
  products, completedAt, now, latitude, longitude, fetchForecast, fetchQuarterHours,
} = {}) {
  try {
    if (typeof fetchForecast !== 'function') return null;
    const fromMs = toMs(completedAt);
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs)) return null;
    // ONE verdict per visit, so nothing is judged until EVERY applicable window
    // is ready (the longest interval plus the settle hour): a verdict stored
    // after the short window alone would be first-writer-wins and the longer
    // window's breach could never be added.
    const ready = rainfastWindows(products);
    if (!ready.length) return null;
    const lastEndMs = fromMs + Math.max(...ready.map(({ minutes }) => minutes)) * 60000;
    if (nowMs < lastEndMs + SETTLE_MS || nowMs > lastEndMs + LOOKBACK_DAYS * 24 * HOUR_MS) return null;

    const results = await Promise.all(ready.map(async (window) => {
      const toMsValue = fromMs + window.minutes * 60000;
      // A short window (a 60-minute label) holds no whole hour when it starts
      // off the hour, so it is read from the quarter-hour series; longer ones
      // from the hourly series. Both return the UNROUNDED total.
      const args = { latitude, longitude, from: new Date(fromMs), to: new Date(toMsValue), timeoutMs: FETCH_TIMEOUT_MS };
      const result = window.minutes < QUARTER_HOUR_BELOW_MINUTES
        ? (typeof fetchQuarterHours === 'function' ? await fetchQuarterHours(args).catch(() => null) : null)
        : await fetchForecast({ ...args, now: new Date(nowMs), exactTotal: true }).catch(() => null);
      if (!result || result.status !== 'ok') return UNREAD;
      // Judged on the unrounded total: 0.246 inch is not 0.25 inch. null = a
      // needed slot had no reading, or no whole slot lies inside: unread.
      const total = result.precipitationInTotalExact;
      if (typeof total !== 'number' || !Number.isFinite(total)) return UNREAD;
      if (total + EPSILON < BREACH_INCHES) return null;
      return {
        minutes: window.minutes,
        inches: round2(total),
        windowTo: new Date(toMsValue).toISOString(),
        products: window.products,
        fetchedAt: typeof result.fetchedAt === 'string' ? result.fetchedAt : null,
      };
    }));
    // A window that could not be read blocks the whole verdict (a later view
    // tries again): the one stored item must name every breached product.
    if (results.includes(UNREAD)) return null;
    const breaches = results.filter(Boolean);
    if (!breaches.length) return null;
    return {
      v: ITEM_VERSION,
      kind: ITEM_KIND,
      source: 'open_meteo',
      windowFrom: new Date(fromMs).toISOString(),
      breaches: breaches.map(({ fetchedAt, ...rest }) => rest),  
      recordedAt: new Date(nowMs).toISOString(),
    };
  } catch {
    return null;
  }
}

/** Shape check for a stored item. Anything unexpected reads as no item. */
function validRetreatCheck(item) {
  return !!item && typeof item === 'object' && !Array.isArray(item)
    && item.v === ITEM_VERSION && item.kind === ITEM_KIND
    && Array.isArray(item.breaches) && item.breaches.length > 0
    && item.breaches.every((b) => b && Number.isFinite(Number(b.inches)) && Number(b.inches) >= BREACH_INCHES);
}

/**
 * The Watching sentence for this visit on a live render, or null.
 * Replays the stored item; otherwise judges once and records the verdict
 * (first writer wins). Needs the visit's frozen memory entry: with none there
 * is nowhere to keep the verdict, so nothing is said (a sentence that could
 * vanish on the next view is worse than none).
 *
 * @returns {Promise<{line: string}|null>}
 */
async function resolveRainfastWatch({
  structuredNotes, serviceRecordId, assessmentId, products, completedAt, latitude, longitude, now, knex, fetchForecast, fetchQuarterHours, degraded = false,
} = {}) {
  try {
    if (!serviceRecordId || !assessmentId || !knex) return null;
    const { storedVisitMemoryFor, recordRetreatCheck } = require('./lawn-visit-memory');
    const entry = storedVisitMemoryFor(structuredNotes, assessmentId);
    if (!entry) return null;
    if (entry.retreatCheck != null) return validRetreatCheck(entry.retreatCheck) ? { line: RAINFAST_WATCH_LINE } : null;

    // Input products not read cleanly: a stored verdict replayed above, but no
    // NEW judgment and no write (a later healthy view tries again).
    if (degraded) return null;
    const item = await judgeRainfastBreach({
      products, completedAt, now, latitude, longitude, fetchForecast, fetchQuarterHours,
    });
    if (!item) return null;
    const stored = await recordRetreatCheck(serviceRecordId, assessmentId, item, knex);
    return validRetreatCheck(stored) ? { line: RAINFAST_WATCH_LINE } : null;
  } catch (err) {
    logger.warn(`[lawn-rainfast-watch] failed for ${serviceRecordId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  BREACH_INCHES,
  ITEM_KIND,
  ITEM_VERSION,
  RAINFAST_WATCH_LINE,
  rainfastWindows,
  judgeRainfastBreach,
  validRetreatCheck,
  resolveRainfastWatch,
};
