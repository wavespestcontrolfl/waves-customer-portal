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
const { reentryCondition, TECHNICIAN_CONFIRMS } = require('./lawn-report-facts');
const logger = require('../logger');

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

// Something was applied, or the evidence is unknown (applicationMade null): fail closed like the document's
// hasActualTreatment, so a hold is never dropped on a visit that may have treated.
function treated(data) {
  return data.applicationMade === true || data.treatmentPerformed === true || data.applicationMade === null;
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

// Rain that watered the treatment in completes the watering task only: a hold on the sprinklers the visit set stays
// (the banner keeps that line), and the report may still hold another customer task.
const KEPT_HOLD_LINE = /^Skip your turf watering until /;
function remainingTask(v2) {
  const lines = Array.isArray(v2?.banner?.lines) ? v2.banner.lines : [];
  return sentence(lines.find((line) => typeof line === 'string' && KEPT_HOLD_LINE.test(line)))
    || sentence(v2?.snapshot?.customerAction, 240);
}

// The lawn action. Covered by rain: what is left to do, else "Nothing needed". A report that says nothing is needed
// reads the same. Otherwise the watering line the page recommends.
function lawnAction(data) {
  const v2 = data.reportV2;
  if (v2?.banner?.state === 'water_in_by_rain') return remainingTask(v2) || NO_ACTION;
  if (v2?.snapshot?.noActionNeeded === true) return NO_ACTION;
  return treated(data) ? lawnWatering(v2) : null;
}

// The non-lawn next step, read in the order ServiceReportDocument builds "What we recommend" (that selector runs inline
// on the client, so the order is mirrored here): the typed step (a PRIMARY termite dashboard owns it unless a
// re-service visit applied nothing), the report's own recommendations, a pest or mosquito primary move, then the V2
// snapshot's customer action (tree & shrub). The first real action wins; if every candidate says "no action", so does
// the card.
const NO_ACTION_RX = /^no (further )?action\b/i;
const moveText = (move) => sentence(move?.title ? [move.title, move.why, move.impact].filter(Boolean).join(' ') + (move.dueLabel ? ` (${move.dueLabel})` : '') : null, 240)
  || sentence(move?.title);

function nextStepCandidates(data) {
  const termite = data.termiteReportV2;
  const outcome = data.reserviceReport?.outcome;
  const primary = Boolean(termite) && termite.source !== 'companion' && !['inspection_only', 'customer_declined'].includes(outcome);
  const typed = data.typedReport?.todaysResult?.nextStep;
  const ownFindings = new Set((data.findings || []).map((f) => String(f?.recommendation || '').trim()).filter(Boolean));
  return [
    primary ? (termite.nextStep || typed) : typed,
    ...(Array.isArray(data.recommendations) ? data.recommendations : []).filter((r) => !ownFindings.has(String(r || '').trim())),
    moveText(data.pestReportV2?.primaryMove),
    moveText(data.mosquitoReportV2?.primaryMove),
    data.reportV2?.snapshot?.customerAction,
  ].map((text) => sentence(text, 240)).filter(Boolean);
}

/**
 * The one action. Lawn: the watering line the page already recommends, so it is worded one way (a neutral "no special
 * watering" line is not an action). Other lines: the report's own next step.
 */
function actionLine(data) {
  if (data.serviceLine === 'lawn') return lawnAction(data);
  const steps = nextStepCandidates(data);
  const real = steps.find((step) => !NO_ACTION_RX.test(step));
  return real || (steps.length ? NO_ACTION : null);
}

// The keep-off sentences, with the approved clause every re-entry line carries ("your technician confirms timing",
// lawn-report-facts). "dry" is once dry; a granular "watered_in_and_dry" needs the watering in AND the grass dry again.
// No hours.
const holdWith = (text) => `${text} \u2014 ${TECHNICIAN_CONFIRMS}.`;
const LAWN_HOLD = Object.freeze({
  dry: holdWith('Keep pets off the lawn until it is dry'),
  watered_in_and_dry: holdWith('Keep pets off the lawn until the treatment has dried, you have watered it in, and the grass is dry again'),
});
const OTHER_HOLD = holdWith('Keep pets off treated areas until they are dry');

// A clock-based re-entry whose every target had already passed its ready time when the report was built has nothing
// left to hold. A condition-based (frozen lawn) re-entry has no targets and always holds.
function clockElapsed(reentry) {
  const targets = Array.isArray(reentry?.targets) ? reentry.targets : [];
  return !reentry?.condition && targets.length > 0 && targets.every((t) => t?.statusAtGeneratedAt === 'ready');
}

/** The one hold: a fixed sentence, only when something was applied and the report carries a re-entry context. */
function holdLine(data) {
  const reentry = data.dynamicContext?.reentry;
  if (!treated(data) || !(reentry || data.advisory?.pet_advisory) || clockElapsed(reentry)) return null;
  if (data.serviceLine !== 'lawn') return OTHER_HOLD;
  return LAWN_HOLD[reentryCondition(reentry?.condition)?.rule] || LAWN_HOLD.dry;
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

module.exports = { buildWebTop, buildWebTopRain, attachWebTop, NO_ACTION, _test: { rainCache } };
