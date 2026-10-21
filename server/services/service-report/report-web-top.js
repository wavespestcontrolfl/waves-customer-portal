'use strict';

/**
 * GATE_REPORT_WEB_TOP (owner 2026-10-20, "OK BUILD THEM ALL"): the first screen of the simple web service report.
 *
 * One `webTop` object, built from data the payload already carries, plus one measured-rain read:
 *   - score   lawn only: this visit's score and the score at the visit before (an arrow on the page);
 *   - trend   lawn only: the last 6 scores, oldest first (a strip on the page);
 *   - action  the ONE thing the customer does, a sentence the report already prints;
 *   - hold    the ONE thing to keep off, a fixed sentence (the approved "once dry" idiom, no hours);
 *   - rain    measured rain (radar, gauge corrected) at the home for the days around the visit.
 *
 * Every sentence is fixed or already on the report: no model prose, no price, no product name. Pure apart from the
 * injected MRMS reader. The route calls this only for a live simple-web view while GATE_REPORT_WEB_TOP is live.
 */

const { dateOnlyString, etDateString, addETDays } = require('../../utils/datetime-et');

const TREND_POINTS = 6;
const RAIN_DAYS_EACH_SIDE = 3;
const RAIN_FETCH_TIMEOUT_MS = 3000;
const RAIN_CACHE_MS = 30 * 60 * 1000;
const RAIN_CACHE_MAX = 200;
const DAY_MS = 86400000;
const WATER_STATES = ['hold', 'water_in', 'hold_then_water_in'];
const NO_ACTION = 'Nothing needed from you today.';

const finiteScore = (value) => {
  const n = value == null || value === '' ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
};
const sentence = (value, max = 160) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= max ? text : null;
};

function treated(data) {
  return data.applicationMade === true || data.treatmentPerformed === true;
}

/** Lawn only: { score: { value, previous }, trend } from the V2 snapshot and its score history. */
function lawnScore(data) {
  const value = finiteScore(data.reportV2?.snapshot?.overallScore);
  if (data.serviceLine !== 'lawn' || value == null) return null;
  const series = (Array.isArray(data.reportV2?.trends?.overall) ? data.reportV2.trends.overall : [])
    .map((point) => ({ label: String(point?.label || ''), value: finiteScore(point?.value) }))
    .filter((point) => point.label && point.value != null);
  const out = { score: { value, previous: series.length >= 2 ? series[series.length - 2].value : null } };
  if (series.length >= 2) out.trend = series.slice(-TREND_POINTS);
  const note = sentence(data.reportV2?.trends?.seasonalNote, 240);
  if (out.trend && note) out.trendNote = note;
  return out;
}

// A lawn watering line: aftercare.watering (what "What we recommend" prints), else the banner's first line.
function lawnWatering(v2) {
  const aftercare = v2?.aftercare?.neutral === true ? null : sentence(v2?.aftercare?.watering, 240);
  if (aftercare) return aftercare;
  const banner = v2?.banner;
  if (!banner || !WATER_STATES.includes(banner.state)) return null;
  return sentence((Array.isArray(banner.lines) ? banner.lines : []).find((line) => sentence(line)));
}

// The next step as ServiceReportDocument picks it for "What we recommend": a PRIMARY termite dashboard owns the
// commitment (station evidence can replace a frozen "No action needed"), unless a re-service visit applied nothing.
// The document runs this inline on the client, so the same three checks are mirrored here.
function nextStepText(data) {
  const termite = data.termiteReportV2;
  const outcome = data.reserviceReport?.outcome;
  const primary = Boolean(termite) && termite.source !== 'companion' && !['inspection_only', 'customer_declined'].includes(outcome);
  return primary ? (termite.nextStep || data.typedReport?.todaysResult?.nextStep) : data.typedReport?.todaysResult?.nextStep;
}

/**
 * The one action. Lawn: the watering line the page already recommends, so it is worded one way (a neutral "no special
 * watering" line is not an action). Other lines: the report's own next step.
 */
function actionLine(data) {
  if (data.serviceLine === 'lawn') {
    const water = treated(data) ? lawnWatering(data.reportV2) : null;
    return water || (data.reportV2?.snapshot?.noActionNeeded === true ? NO_ACTION : null);
  }
  const step = sentence(nextStepText(data));
  if (!step) return null;
  return /^no (further )?action\b/i.test(step) ? NO_ACTION : step;
}

/** The one hold: a fixed sentence, only when something was applied and the report carries a re-entry context. */
function holdLine(data) {
  const reentry = data.dynamicContext?.reentry;
  if (!treated(data) || !(reentry || data.advisory?.pet_advisory)) return null;
  return data.serviceLine === 'lawn'
    ? 'Keep pets off the lawn until it is dry.'
    : 'Keep pets off treated areas until they are dry.';
}

function buildWebTop(data, rain = null) {
  if (!data || typeof data !== 'object') return null;
  const out = { ...(lawnScore(data) || {}) };
  const action = actionLine(data);
  const hold = holdLine(data);
  if (action) out.action = action;
  if (hold) out.hold = hold;
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
  const key = `${win.lat.toFixed(3)},${win.lng.toFixed(3)},${win.start},${win.end}`;
  const hit = rainCache.get(key);
  if (hit && hit.until > Date.now()) return hit.result;
  const timeout = new Promise((resolve) => { const t = setTimeout(() => resolve(null), RAIN_FETCH_TIMEOUT_MS); if (t.unref) t.unref(); });
  const read = Promise.resolve(fetchMrmsDailyRain({ latitude: win.lat, longitude: win.lng, start: win.start, end: win.end })).catch(() => null);
  const result = await Promise.race([read, timeout]);
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
 * radar is unreachable or fewer than 2 days are measured. `sinceVisitInches` is the total for the days after the visit
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
  const sinceVisitInches = after.length && after.every((d) => d.inches != null)
    ? roundInches(after.reduce((sum, d) => sum + d.inches, 0)) : null;
  return { days, sinceVisitInches };
}

module.exports = { buildWebTop, buildWebTopRain, NO_ACTION, _test: { rainCache } };
