'use strict';

// Forecast-aware water-in sentence and observed-rain close-out for the lawn
// watering banner (GATE_LAWN_WATERING_FORECAST, lawn report rebuild P30).
//
// Two pieces, both for a plain WATER-IN instruction only. A hold, and the
// hold-then-water-in mix, never get either: a forecast must not soften a
// hold, and nothing here may say that rain "counts" while a hold is on.
//
//   1. FROZEN, at completion (the write gate): when the property forecast says
//      at least the water-in amount of rain falls inside the water-in window,
//      one conditional sentence is frozen beside the instruction as
//      instruction.forecast = { line, inches, ... }. It is NEVER part of
//      instruction.lines: the PDF, the watering text, the hero task and Ask
//      Waves read `lines` and so stay exactly as written. Only the live banner
//      (banner.forecastLine) shows it, and stripLiveOnlyScheduleFields drops it
//      from every non-live render. Replays read the stored sentence verbatim.
//   2. LIVE, on the web view only: radar-measured (MRMS) rain that reached the
//      water-in amount INSIDE the window closes the banner (banner.observedRain).
//      Forecast never closes anything. MRMS here is a DAILY rollup, so only
//      whole Eastern days that lie inside the window (with a one-hour margin at
//      each edge for the day-boundary convention of the source) are counted; a
//      lower bound, never a guess about the hours of a partial day.
//
// Copy rules: inches only, never a probability or a percent; fixed sentences
// chosen by code from facts; no model; no re-entry or "keep off" wording.

const HOUR_MS = 3600000;
// Whole-day MRMS totals are labelled by calendar day; an hour of slack at each
// edge keeps a day whose source boundary differs from Eastern midnight from
// leaking rain that fell outside the window into the total.
const DAY_EDGE_MARGIN_MS = HOUR_MS;
const FORECAST_TIMEOUT_MS = 3000;
const CLOSE_OUT_DEADLINE_MS = 2500;

function finitePositive(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toMs(value) {
  if (value == null || value === '') return NaN;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
}

// "¼ inch", "½ inch", "0.27 inch", "1 inch", "1.5 inches": exact quarter
// fractions in words, otherwise up to two decimals. Singular up to one inch.
function formatInches(value) {
  const n = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(n) || n <= 0) return null;
  const quarters = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
  const text = quarters[n] || String(n);
  return `${text} ${n <= 1 ? 'inch' : 'inches'}`;
}

// The fixed sentences. Every number is in inches; none is a probability.
function forecastSentence({ forecastInches, waterInInches, byLabel }) {
  const forecast = formatInches(forecastInches);
  const amount = formatInches(waterInInches);
  if (!forecast || !amount || !byLabel) return null;
  return `About ${forecast} of rain is forecast by ${byLabel}. If at least ${amount} actually falls by then, it counts as watering in today’s treatment. If it does not, run the watering above.`;
}

function closeOutSentence({ measuredInches }) {
  const measured = formatInches(measuredInches);
  if (!measured) return null;
  return `Done: radar measured at least ${measured} of rain at your home since your visit, which counts as watering in today’s treatment. There is no need to run your sprinklers for it.`;
}

// Copy that must never reach a customer from this module.
const BANNED_COPY = /%|\bpercent\b|\bchance\b|\bprobabilit|\blikelihood\b|\bodds\b|\bkeep\s+off\b|\bstay\s+off\b|\bre-?entry\b/i;
function copyIsClean(text) {
  return typeof text === 'string' && text.trim().length > 0 && !BANNED_COPY.test(text);
}

// Only a plain water-in instruction can carry either piece.
function isPlainWaterIn(instruction) {
  return !!instruction && typeof instruction === 'object' && instruction.state === 'water_in'
    && !instruction.holdUntil && !instruction.holdUntilLabel;
}

// ── 1. Frozen at completion ─────────────────────────────────────────────

/**
 * The forecast block to freeze beside a water-in instruction, or null (the
 * caller then writes exactly today's instruction). Fail-open: any miss, an
 * incomplete hourly series, a forecast below the water-in amount, or a thrown
 * fetch returns null.
 *
 * @param {object} input
 * @param {object} input.instruction  buildWateringInstruction result
 * @param {number|string|null} input.latitude
 * @param {number|string|null} input.longitude
 * @param {Function} input.fetchForecast  fetchPropertyForecast
 */
async function resolveWaterInForecast({ instruction, latitude, longitude, fetchForecast } = {}) {
  try {
    if (!isPlainWaterIn(instruction) || typeof fetchForecast !== 'function') return null;
    const amount = finitePositive(instruction.waterInInches);
    const fromMs = toMs(instruction.completedAt);
    const toMsValue = toMs(instruction.waterInBy);
    if (amount == null || !Number.isFinite(fromMs) || !Number.isFinite(toMsValue) || toMsValue <= fromMs) return null;
    if (typeof instruction.waterInByLabel !== 'string' || !instruction.waterInByLabel) return null;

    const result = await fetchForecast({
      latitude, longitude, from: new Date(fromMs), to: new Date(toMsValue), timeoutMs: FORECAST_TIMEOUT_MS,
    });
    if (!result || result.status !== 'ok') return null;
    const total = result.precipitationInTotal;
    // null = a needed hour had no reading (or no whole hour in the window):
    // never read as zero, never as rain.
    if (typeof total !== 'number' || !Number.isFinite(total)) return null;
    // The sentence only exists when the forecast reaches the label amount.
    if (total < amount) return null;
    const line = forecastSentence({ forecastInches: total, waterInInches: amount, byLabel: instruction.waterInByLabel });
    if (!copyIsClean(line)) return null;
    return {
      line,
      inches: Math.round(total * 100) / 100,
      source: 'open_meteo',
      fetchedAt: typeof result.fetchedAt === 'string' ? result.fetchedAt : null,
      windowFrom: new Date(fromMs).toISOString(),
      windowTo: new Date(toMsValue).toISOString(),
    };
  } catch {
    return null;
  }
}

// The frozen sentence, shape-checked, for the banner. Anything unexpected is
// ignored (today's banner), never repaired.
function frozenForecastLine(instruction) {
  if (!isPlainWaterIn(instruction)) return null;
  const forecast = instruction.forecast;
  if (!forecast || typeof forecast !== 'object' || Array.isArray(forecast)) return null;
  if (!Number.isFinite(Number(forecast.inches)) || Number(forecast.inches) <= 0) return null;
  return copyIsClean(forecast.line) ? forecast.line : null;
}

// ── 2. Live close-out ───────────────────────────────────────────────────

/**
 * The Eastern calendar days that lie wholly inside [completedAt, waterInBy]
 * (one-hour margin at each edge) and have already ended. Pure.
 *
 * @param {object} instruction
 * @param {Date} now
 * @param {Function} etDayWindow  application-conditions etDayWindow(ymd) -> {from,to}
 * @param {Function} etDateString utils/datetime-et etDateString(date) -> ymd
 * @returns {string[]} YYYY-MM-DD
 */
function wholeDaysInsideWindow(instruction, now, { etDayWindow, etDateString }) {
  const startMs = toMs(instruction?.completedAt);
  const endMs = toMs(instruction?.waterInBy);
  const nowMs = now instanceof Date ? now.getTime() : toMs(now);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !Number.isFinite(nowMs)) return [];
  const days = [];
  let cursor = new Date(startMs);
  // At most 8 days (the rule's longest window is 168 h); the loop bound keeps
  // a malformed window from spinning.
  for (let i = 0; i < 9; i += 1) {
    const ymd = etDateString(cursor);
    const win = etDayWindow(ymd);
    if (win) {
      const from = win.from.getTime();
      const to = win.to.getTime();
      if (from - DAY_EDGE_MARGIN_MS >= startMs && to + DAY_EDGE_MARGIN_MS <= endMs && to <= nowMs && !days.includes(ymd)) days.push(ymd);
      if (from > endMs) break;
      cursor = new Date(to + 60000);
    } else {
      cursor = new Date(cursor.getTime() + 24 * HOUR_MS);
    }
  }
  return days;
}

/**
 * The close-out for a water-in instruction given MRMS daily totals for the
 * days inside its window, or null. Pure. Measured rain only; the sum of the
 * known days is a lower bound (a gap day is unknown, never zero-filled and
 * never guessed), and it must reach the water-in amount.
 *
 * @param {object} instruction
 * @param {Array<{date: string, inches: number|null}>} mrmsDays
 * @param {string[]} insideDays  wholeDaysInsideWindow result
 */
function observedCloseOut(instruction, mrmsDays, insideDays) {
  if (!isPlainWaterIn(instruction) || !Array.isArray(mrmsDays) || !Array.isArray(insideDays) || !insideDays.length) return null;
  const amount = finitePositive(instruction.waterInInches);
  if (amount == null) return null;
  let total = 0;
  const used = [];
  for (const day of mrmsDays) {
    if (!day || !insideDays.includes(day.date)) continue;
    if (typeof day.inches !== 'number' || !Number.isFinite(day.inches) || day.inches < 0) continue;
    total += day.inches;
    used.push(day.date);
  }
  total = Math.round(total * 100) / 100;
  if (total < amount) return null;
  const line = closeOutSentence({ measuredInches: total });
  if (!copyIsClean(line)) return null;
  return { inches: total, line, source: 'mrms', days: used };
}

/**
 * Attach the live close-out to the payload's banner (LIVE web view only; the
 * caller guards the mode). Fail-open: any miss leaves the banner as it was.
 * Never runs for a hold or hold-then-water-in, for an already-expired banner,
 * or when no whole day lies inside the window (no network call then).
 *
 * @param {object} data      the /data payload (mutated: reportV2.banner.observedRain)
 * @param {object} deps      { instruction (the FROZEN one), latitude, longitude, now,
 *                             fetchMrmsDailyRain, etDayWindow, etDateString }
 */
async function attachLiveCloseOut(data, deps = {}) {
  try {
    const banner = data?.reportV2?.banner;
    const instruction = deps.instruction;
    if (!banner || banner.state !== 'water_in' || !isPlainWaterIn(instruction)) return data;
    const now = deps.now instanceof Date ? deps.now : new Date();
    const expiresMs = toMs(banner.expiresAt);
    // The banner already ended: the "ended" note stands, no lookup.
    if (Number.isFinite(expiresMs) && now.getTime() > expiresMs) return data;
    const inside = wholeDaysInsideWindow(instruction, now, deps);
    if (!inside.length) return data;
    if (deps.latitude == null || deps.longitude == null || deps.latitude === '' || deps.longitude === '') return data;
    const lat = Number(deps.latitude);
    const lon = Number(deps.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return data;
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CLOSE_OUT_DEADLINE_MS); });
    const mrms = await Promise.race([
      Promise.resolve(deps.fetchMrmsDailyRain({ latitude: lat, longitude: lon, start: inside[0], end: inside[inside.length - 1] })).catch(() => null),
      deadline,
    ]).finally(() => clearTimeout(timer));
    const closeOut = observedCloseOut(instruction, mrms?.days, inside);
    if (closeOut) banner.observedRain = closeOut;
  } catch {
    /* fail open: the banner stays as it was */
  }
  return data;
}

module.exports = {
  formatInches,
  forecastSentence,
  closeOutSentence,
  copyIsClean,
  isPlainWaterIn,
  resolveWaterInForecast,
  frozenForecastLine,
  wholeDaysInsideWindow,
  observedCloseOut,
  attachLiveCloseOut,
};
