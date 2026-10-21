'use strict';

/**
 * GATE_REPORT_WEB_LIVE_CHIP (owner 2026-10-20 "OK BUILD THEM ALL", idea 10): a "lawn status now" chip on the live
 * web service report. Built on every /data request, so it is never frozen, never in the PDF and never in a stored
 * record. One fixed sentence from measured rain at the home since the visit completed, or nothing:
 *
 *   rain in the last RECENT hours   "Rain fell about N hours ago. Wait until the lawn is dry."
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
  return hoursAgo === 1 ? COPY.rainHoursAgoOne : COPY.rainHoursAgo.replace('{n}', String(hoursAgo));
}

const exactInches = (row) => {
  const v = row && (row.precipitation_exact_in ?? row.precipitation_in);
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
};

/**
 * What the forecast's past-hour rows say about the time since the visit. Hour rows are stamped at the END of their hour:
 * row S holds the rain of the bucket S-1h..S. The window runs from the bucket that CONTAINS the completion (10:15 reads
 * the 11:00 row) through the last CLOSED bucket (the stamp at or before now; the hour in progress is unknown).
 *
 * The completion bucket is PARTLY before the visit, so a reading in it cannot say when the rain fell: it never supports
 * a "rain fell" claim (only buckets that start at or after the completion do), and rain in it blocks the dry state.
 * Two cutoffs, on purpose. `last` (the "rain fell about N hours ago" wording) uses the per-hour cutoff on hours that
 * start at or after the completion. `dry` ("No rain since your treatment.") needs every bucket of the window read, no
 * rainy hour AND a cumulative total under the same cutoff, so many trace hours (56 x 0.009 in) are never "dry". A
 * window with no closed bucket yet is never dry.
 */
function rainSince(forecast, fromMs, nowMs) {
  const firstStamp = Math.floor(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  const lastStamp = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const byStamp = new Map((Array.isArray(forecast && forecast.hourly) ? forecast.hourly : []).map((r) => [toMs(r.at), exactInches(r)]));
  const buckets = [];
  for (let stamp = firstStamp; stamp <= lastStamp; stamp += HOUR_MS) buckets.push({ start: stamp - HOUR_MS, inches: byStamp.get(stamp) });
  const rainy = (b) => typeof b.inches === 'number' && b.inches >= RAIN_HOUR_INCHES;
  const after = buckets.filter((b) => b.start >= fromMs && rainy(b));
  const allRead = buckets.length > 0 && buckets.every((b) => typeof b.inches === 'number');
  const total = allRead ? buckets.reduce((sum, b) => sum + b.inches, 0) : null;
  return {
    last: after.length ? after[after.length - 1] : null,
    dry: allRead && !buckets.some(rainy) && total < RAIN_HOUR_INCHES,
  };
}

/**
 * A fetchForecast for resolveRainCoverage that answers from the series already read, so one view makes ONE weather read.
 * It returns the unrounded total of the whole-hour slots inside the asked window (the forecast's own rule: a slot
 * stamped S counts when S-1h >= from and S <= to), or null when any needed slot is missing.
 */
function seriesReader(forecast) {
  const byStamp = new Map((Array.isArray(forecast.hourly) ? forecast.hourly : []).map((r) => [toMs(r.at), exactInches(r)]));
  return async ({ from, to }) => {
    const fromMs = toMs(from);
    const toMsValue = toMs(to);
    let total = 0;
    let complete = false;
    for (let slot = Math.ceil(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS; slot <= toMsValue; slot += HOUR_MS) {
      const v = byStamp.get(slot);
      if (typeof v !== 'number') { complete = false; break; }
      complete = true;
      total += v;
    }
    return { status: 'ok', precipitationInTotalExact: complete ? total : null };
  };
}

/**
 * One weather read per /data view. The water-in banner's coverage check (GATE_LAWN_WATER_IN_RAIN, read while the report
 * is built) and the chip (read afterwards) both need rain since the completion; the banner's window stops at its
 * deadline, the chip's at now. This holds ONE completion-to-now series: whichever reader asks first fetches it (from the
 * earliest `from` it is given), the other answers from it. `now` is fixed here so both read the same closed hours.
 * A failed read is remembered as a miss, never retried within the view.
 */
function createSharedSeries(fetchForecast, now = new Date()) {
  let pending = null;
  return {
    now,
    read({ latitude, longitude, from }) {
      if (!pending) {
        pending = Promise.resolve(fetchForecast({
          latitude, longitude, from: new Date(toMs(from)), to: now, timeoutMs: FETCH_TIMEOUT_MS, now, exactTotal: true,
        })).catch(() => null);
      }
      return pending;
    },
  };
}

/** A fetchForecast for resolveRainCoverage that answers the banner's window from the shared series. */
function sharedCoverageReader(series, { latitude, longitude, from }) {
  return async ({ from: askedFrom, to }) => {
    const forecast = await series.read({ latitude, longitude, from });
    return forecast && forecast.status === 'ok' ? seriesReader(forecast)({ from: askedFrom, to }) : forecast;
  };
}

/**
 * Did rain do the water-in? True when the banner already says so (GATE_LAWN_WATER_IN_RAIN replay), or rain measured since
 * the visit reaches the amount the products ask for (the same reader the banner uses, on the TOTAL, so a long run of
 * trace hours counts). It reads the series the chip already holds: no second weather read.
 */
async function rainWateredIn({ instruction, products, forecast, nowMs, latitude, longitude }) {
  if (instruction && instruction.state === COVERED_STATE) return true;
  if (!appliesTo(instruction)) return false;
  const coverage = await resolveRainCoverage({
    instruction, products, now: new Date(nowMs), latitude, longitude, fetchForecast: seriesReader(forecast),
  });
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
 * @param {Function} input.fetchForecast    application-conditions.fetchPropertyForecast (unused when `series` is given)
 * @param {object} [input.series]           createSharedSeries(...): the view's one completion-to-now weather read
 * @returns {Promise<{state: string, text: string}|null>}
 */
async function resolveLiveChip({
  completedAt, instruction, products, latitude, longitude, now: nowIn, fetchForecast, series,
} = {}) {
  try {
    const fromMs = toMs(completedAt);
    // With a shared series the view's one clock is the series' own, so both readers judge the same closed hours.
    const now = series ? series.now : nowIn;
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    if ((!series && typeof fetchForecast !== 'function') || !Number.isFinite(fromMs)) return null;
    if (nowMs <= fromMs || nowMs - fromMs > COPY.visitWindowDays * DAY_MS) return null;

    const forecast = series
      ? await series.read({ latitude, longitude, from: fromMs })
      : await fetchForecast({
        latitude, longitude, from: new Date(fromMs), to: new Date(nowMs), timeoutMs: FETCH_TIMEOUT_MS, now: new Date(nowMs), exactTotal: true,
      });
    if (!forecast || forecast.status !== 'ok') return null;
    const { last, dry } = rainSince(forecast, fromMs, nowMs);

    // Elapsed time is told from the bucket's START (the rain fell somewhere inside the hour), so it reads "about".
    const hoursAgo = last ? Math.floor((nowMs - last.start) / HOUR_MS) : null;
    if (hoursAgo !== null && hoursAgo <= COPY.recentHours) return { state: 'recent_rain', text: rainLine(hoursAgo) };

    if (await rainWateredIn({ instruction, products, forecast, nowMs, latitude, longitude })) {
      return { state: 'watered_in', text: COPY.wateredIn };
    }

    // "No rain" needs every hour from the completion hour through the last closed hour, read and dry.
    return dry ? { state: 'no_rain', text: COPY.noRain } : null;
  } catch {
    return null;
  }
}

module.exports = { resolveLiveChip, createSharedSeries, sharedCoverageReader, RAIN_HOUR_INCHES };
