'use strict';

/**
 * GATE_REPORT_WEB_TOP (owner 2026-10-20, "OK BUILD THEM ALL"): the first screen of the simple web service report.
 *
 * One `webTop` object, built from data the payload already carries, plus one measured-rain read:
 *   - score   lawn only: this visit's score and the score at the assessment before it (an arrow on the page);
 *   - trend   lawn only: the last 6 scores, oldest first (a strip on the page);
 *   - rain    measured rain (radar, gauge corrected) at the home for the days around the visit.
 *
 * "Do this" and "Hold off" are NOT built here: the page picks them from the very lists ServiceReportDocument prints
 * ("What we recommend", "Re-entry & precautions"; client/src/pages/serviceReportLines.js), so there is one copy of that
 * logic. No price, no product name, no model prose. Pure apart from the injected MRMS reader. The route calls this only
 * for a live simple-web view while GATE_REPORT_WEB_TOP is live.
 */

const { dateOnlyString, etDateString, addETDays } = require('../../utils/datetime-et');
const logger = require('../logger');

const TREND_POINTS = 6;
const RAIN_DAYS_EACH_SIDE = 3;
const RAIN_FETCH_TIMEOUT_MS = 3000;
const RAIN_CACHE_MS = 30 * 60 * 1000;
const RAIN_CACHE_MAX = 200;
const DAY_MS = 86400000;

const finiteScore = (value) => {
  const n = value == null || value === '' ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
};
const sentence = (value, max = 160) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= max ? text : null;
};

// The score at the assessment just before this one. lawnAssessment.trend has one row per assessment, in order, current
// last, from the same (property-scoped) history the report builds; the V2 strip collapses assessments that share a date,
// so two the same day would compare a visit with itself. Falls back to the strip only when the raw rows are absent.
function previousScore(data, series) {
  const raw = Array.isArray(data.lawnAssessment?.trend) ? data.lawnAssessment.trend : null;
  if (!raw) return series.length >= 2 ? series[series.length - 2].value : null;
  const scored = raw.map((row) => finiteScore(row?.overallScore)).filter((n) => n != null);
  return scored.length >= 2 ? scored[scored.length - 2] : null;
}

/** Lawn only: { score: { value, previous }, trend } from the V2 snapshot and its score history. */
function lawnScore(data) {
  const value = finiteScore(data.reportV2?.snapshot?.overallScore);
  if (data.serviceLine !== 'lawn' || value == null) return null;
  const series = (Array.isArray(data.reportV2?.trends?.overall) ? data.reportV2.trends.overall : [])
    .map((point) => ({ label: String(point?.label || ''), value: finiteScore(point?.value) }))
    .filter((point) => point.label && point.value != null);
  const out = { score: { value, previous: previousScore(data, series) } };
  if (series.length >= 2) out.trend = series.slice(-TREND_POINTS);
  const note = sentence(data.reportV2?.trends?.seasonalNote, 240);
  if (out.trend && note) out.trendNote = note;
  return out;
}

function buildWebTop(data, rain = null) {
  if (!data || typeof data !== 'object') return null;
  const out = { ...(lawnScore(data) || {}) };
  if (rain) out.rain = rain;
  return Object.keys(out).length ? out : null;
}

// ── Measured rain ─────────────────────────────────────────────────────────────────────────────────────────────

const shiftYmd = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const rainCache = new Map();

const coordinate = (value) => (value == null || value === '' ? NaN : Number(value));

// The days to read: 3 each side of the visit, never past yesterday. Null when there is nothing honest to ask.
function rainWindow(service, now) {
  const lat = coordinate(service?.customer_latitude ?? service?.latitude);
  const lng = coordinate(service?.customer_longitude ?? service?.longitude);
  const visit = dateOnlyString(service?.service_date);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0) || !/^\d{4}-\d{2}-\d{2}$/.test(visit || '')) return null;
  const yesterday = etDateString(addETDays(now, -1));
  const after = shiftYmd(visit, RAIN_DAYS_EACH_SIDE);
  const end = after < yesterday ? after : yesterday;
  return end < visit ? null : { lat, lng, visit, start: shiftYmd(visit, -RAIN_DAYS_EACH_SIDE), end };
}

async function readRain(win, fetchMrmsDailyRain) {
  // 4 decimals is about 11 m, finer than the radar's 1 km cell, so two homes never share a memo entry.
  const key = `${win.lat.toFixed(4)},${win.lng.toFixed(4)},${win.start},${win.end}`;
  const hit = rainCache.get(key);
  if (hit && hit.until > Date.now()) return hit.result;
  // The read gets an AbortSignal and the deadline aborts it; the timer is cleared when the read wins.
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, RAIN_FETCH_TIMEOUT_MS); });
  const read = Promise.resolve(fetchMrmsDailyRain({ latitude: win.lat, longitude: win.lng, start: win.start, end: win.end, signal: controller.signal })).catch(() => null);
  let result;
  try {
    result = await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (result) {
    if (rainCache.size >= RAIN_CACHE_MAX) rainCache.clear();
    rainCache.set(key, { until: Date.now() + RAIN_CACHE_MS, result });
  }
  return result;
}

const roundInches = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100) / 100);

/**
 * Closed-day radar rain (MRMS, gauge corrected) at the home for the days around the visit. `days` keeps a null for a
 * day the radar has not filled in yet. Null = no honest figure: no coordinates, no visit day, the visit is today, the
 * radar is unreachable or fewer than 2 days are measured. `sinceVisitInches` is the total for the days after the visit (`sinceVisitDays` of them)
 * day, or null unless every one of them is measured.
 */
async function buildWebTopRain({ service, fetchMrmsDailyRain, now = new Date() } = {}) {
  const win = typeof fetchMrmsDailyRain === 'function' ? rainWindow(service, now) : null;
  if (!win) return null;
  const result = await readRain(win, fetchMrmsDailyRain);
  const days = (Array.isArray(result?.days) ? result.days : [])
    .map((d) => ({ date: d.date, inches: roundInches(d.inches), isVisit: d.date === win.visit }));
  if (days.filter((d) => d.inches != null).length < 2) return null;
  const after = days.filter((d) => d.date > win.visit);
  const whole = after.length > 0 && after.every((d) => d.inches != null);
  return {
    days,
    sinceVisitInches: whole ? roundInches(after.reduce((sum, d) => sum + d.inches, 0)) : null,
    // How many closed, measured days after the visit the total covers (the window never passes yesterday).
    sinceVisitDays: whole ? after.length : 0,
  };
}

/**
 * The /data route's one call: while GATE_REPORT_WEB_TOP and the simple web switch are live (a partial gates module
 * reads as off) and the report is not internal-only, put `webTop` on the payload. An object even when empty: the key is
 * what trims the web page. Best effort: any failure leaves the payload as it was.
 */
async function attachWebTop(v1Data, service, { simpleWeb, gates } = {}) {
  if (simpleWeb !== true || typeof gates?.reportWebTopLive !== 'function' || !gates.reportWebTopLive() || v1Data.internalOnly) return v1Data;
  try {
    const rain = await buildWebTopRain({ service, fetchMrmsDailyRain: require('../mrms-qpe').fetchMrmsDailyRain });
    v1Data.webTop = buildWebTop(v1Data, rain) || {};
  } catch (err) {
    logger.warn(`[reports-public] web top skipped: ${err.message}`);
  }
  return v1Data;
}

module.exports = { buildWebTop, buildWebTopRain, attachWebTop, _test: { rainCache } };
