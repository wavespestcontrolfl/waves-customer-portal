/**
 * Rain-day ads record. Owner 2026-11-23 ("only run ads for specific indoor services, on days before or during a
 * rain"; "we can stop at 2pm the day before"; "ok lets build this out").
 *
 * This module RECORDS what the rain rule would do. It changes nothing: it writes nothing to Google, sets no budget,
 * sends no message and pays for no lookup. A two-week record, scored against measured radar rain, comes before any
 * rule that acts on it.
 *
 * The 2-hour ad cron runs it as its own step (recordRainMode, job_health 'ads-rain-mode'), after the budget run.
 * One run:
 *   1. picks the day the ads sell, as the budget run does (budget-manager.js adjustBudgets): Sunday = Monday; before
 *      2 PM ET = today; from 2 PM ET = tomorrow. So the switch for a rain day is decided at 2 PM the day before, and
 *      the morning runs of that day check it again.
 *   2. reads the NWS hourly forecast (never the paid backup) at each forecast area of the day board
 *      (scheduling/forecast-zones.js ZONE_COORDS) and counts the work hours (DAY_OPEN to DAY_CLOSE) at RAIN_PCT or more.
 *      An area with RAIN_HOURS or more such hours is a rain area; one whose missing hours could still make it one is
 *      open and not counted. The day is a rain day when at least half of the settled areas are rain areas. Unknown is
 *      not dry: with fewer than MIN_AREAS settled the forecast is 'unknown', and the day keeps its last settled call
 *      (none yet = nothing would change). Fewer than MIN_AREAS answered fails the tick.
 *   3. decides, for each Google campaign, what the rule would set: an 'outdoor' campaign stops (the budget run's 1%
 *      floor) on a rain day, an 'indoor' campaign runs at its base on a rain day and stops on a dry day, and any other
 *      campaign (the brand campaign) is left alone. A campaign's class is ad_campaigns.metadata.rain_class
 *      ('indoor' | 'outdoor'); a campaign marked with a route line (pest, lawn: ads/route-fill.js) is outdoor.
 *   4. writes the run to system_settings 'ads.rain_mode.last' and 'ads.rain_mode.history' (last HISTORY_MAX), and the
 *      day's latest call to 'ads.rain_mode.days' (one row per sold day, kept DAYS_MAX), the record the ad results
 *      report joins on.
 *   5. scores past days: a day whose call is recorded and not yet scored reads the measured radar rain (mrms-qpe.js)
 *      at each area, least recently tried first. An area with WET_INCHES or more was wet; a wet day has half or more
 *      of all areas wet. A radar gap that could flip that waits (SCORE_GIVE_UP_DAYS, then the areas read decide,
 *      marked partial). The score is kept on the day's row: the areas measured wet, wet_day, hit (the latest call)
 *      and cutoff_hit (the first call made before the day, from 2 PM the day before: the one the ads act on).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { getNwsHourlyRain } = require('../weather-forecast');
const { fetchMrmsDailyRain } = require('../mrms-qpe');
const { ZONE_COORDS } = require('../scheduling/forecast-zones');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { etDateString, etParts, addETDays } = require('../../utils/datetime-et');

const LAST_KEY = 'ads.rain_mode.last';
const HISTORY_KEY = 'ads.rain_mode.history';
const DAYS_KEY = 'ads.rain_mode.days';
const HISTORY_MAX = 200; // 12 runs a day: about 16 days
const DAYS_MAX = 400;
// Plan v2 (owner page, 11-23): 4 or more work hours at 70% or more. A daily chance would call most summer days wet.
const RAIN_PCT = 70;
const RAIN_HOURS = 4;
const MIN_AREAS = 3;
// Measured radar rain that counts an area as wet that day.
const WET_INCHES = 0.25;
// Past days scored in one run, oldest first; the rest wait for the next run.
const SCORE_MAX = 3;
// A day still not settled by measured rain this many days later is scored from the areas read.
const SCORE_GIVE_UP_DAYS = 7;
const HOUR = 60;

function parseJson(v, fallback) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v) ?? fallback; } catch { return fallback; }
}

/** The day the ads sell at `now` (budget-manager.js adjustBudgets): Sunday -> Monday, < 2 PM -> today, else tomorrow. */
function soldDay(now) {
  const { dayOfWeek, hour } = etParts(now);
  if (dayOfWeek === 0 || hour >= 14) return etDateString(addETDays(now, 1));
  return etDateString(now);
}

/** The campaign's rain class: 'indoor' | 'outdoor' | null (left alone). */
function rainClassOf(campaign) {
  const meta = parseJson(campaign?.metadata, {});
  if (meta && ['indoor', 'outdoor'].includes(meta.rain_class)) return meta.rain_class;
  if (meta && ['pest', 'lawn'].includes(meta.route_line)) return 'outdoor';
  return null;
}

/** Work hours of `day` at RAIN_PCT or more, and the hours with no reading. */
function countWetHours(hours, day) {
  let wet = 0;
  let missing = 0;
  for (let m = DAY_OPEN; m < DAY_CLOSE; m += HOUR) {
    const key = `${day}T${String(Math.floor(m / HOUR)).padStart(2, '0')}`;
    const hour = hours.find((h) => String(h?.startTime || '').slice(0, 13) === key);
    const chance = hour && Number.isFinite(hour.rainChance) ? hour.rainChance : null;
    if (chance == null) missing += 1;
    else if (chance >= RAIN_PCT) wet += 1;
  }
  return { wet, missing };
}

/**
 * The forecast call for `day`: { day, call: 'rain' | 'dry' | 'unknown', areas: [{ zone, wet, missing, rain }],
 * unread: [zone] }. An area NWS does not answer, or answers with no hour of the day, is unread. An area whose missing
 * hours could still make it wet (wet < RAIN_HOURS <= wet + missing: NWS drops hours already over, so on the sold day's
 * morning a wet early span can be gone) is open (`rain: null`) and is not counted either way. The call needs
 * MIN_AREAS settled areas.
 */
async function forecastDay(day, { read = getNwsHourlyRain } = {}) {
  const zones = Object.keys(ZONE_COORDS);
  const areas = [];
  const unread = [];
  await Promise.all(zones.map(async (zone) => {
    const hours = await Promise.resolve().then(() => read(ZONE_COORDS[zone].lat, ZONE_COORDS[zone].lng)).catch(() => null);
    const counted = Array.isArray(hours) ? countWetHours(hours, day) : null;
    const total = (DAY_CLOSE - DAY_OPEN) / HOUR;
    if (!counted || counted.missing >= total) { unread.push(zone); return; }
    let rain = null;
    if (counted.wet >= RAIN_HOURS) rain = true;
    else if (counted.wet + counted.missing < RAIN_HOURS) rain = false;
    areas.push({ zone, wet: counted.wet, missing: counted.missing, rain });
  }));
  areas.sort((a, b) => zones.indexOf(a.zone) - zones.indexOf(b.zone));
  unread.sort((a, b) => zones.indexOf(a) - zones.indexOf(b));
  const settled = areas.filter((a) => a.rain !== null);
  let call = 'unknown';
  if (settled.length >= MIN_AREAS) call = settled.filter((a) => a.rain).length * 2 >= settled.length ? 'rain' : 'dry';
  return { day, call, areas, unread };
}

/** What the rule would set for a campaign of `rainClass` under `call`: 'base' | 'stop' | null (no change). */
function decideCampaign(rainClass, call) {
  if (!rainClass || call === 'unknown') return null;
  if (rainClass === 'outdoor') return call === 'rain' ? 'stop' : 'base';
  return call === 'rain' ? 'base' : 'stop';
}

/**
 * The day's measured score, or null while radar gaps could still change it. Wet day = half or more of all areas
 * measured wet. A gap counts both ways: the score waits until the areas still missing could not flip it, or, after
 * SCORE_GIVE_UP_DAYS, is taken from the areas read (marked partial; none read = no score).
 */
async function scoreDay(row, { fetchRain = fetchMrmsDailyRain, now = new Date() } = {}) {
  const zones = Object.keys(ZONE_COORDS);
  const measured = await Promise.all(zones.map(async (zone) => {
    const out = await Promise.resolve()
      .then(() => fetchRain({ latitude: ZONE_COORDS[zone].lat, longitude: ZONE_COORDS[zone].lng, start: row.day, end: row.day }))
      .catch(() => null);
    const inches = out?.days?.[0]?.inches;
    return { zone, inches: Number.isFinite(inches) ? inches : null };
  }));
  const read = measured.filter((m) => m.inches != null);
  const wetAreas = read.filter((m) => m.inches >= WET_INCHES).map((m) => m.zone);
  const missing = measured.length - read.length;
  let wetDay = null;
  if (wetAreas.length * 2 >= measured.length) wetDay = true;
  else if ((wetAreas.length + missing) * 2 < measured.length) wetDay = false;
  const partial = wetDay === null;
  if (partial) {
    const ageDays = (Date.parse(`${etDateString(now)}T00:00:00Z`) - Date.parse(`${row.day}T00:00:00Z`)) / 86400000;
    if (ageDays < SCORE_GIVE_UP_DAYS || !read.length) return null;
    wetDay = wetAreas.length * 2 >= read.length;
  }
  return {
    partial,
    scored_at: new Date().toISOString(),
    measured: Object.fromEntries(measured.map((m) => [m.zone, m.inches])),
    wet_areas: wetAreas,
    wet_day: wetDay,
    hit: row.call === 'unknown' ? null : (row.call === 'rain') === wetDay,
    cutoff_hit: ['rain', 'dry'].includes(row.cutoff_call) ? (row.cutoff_call === 'rain') === wetDay : null,
  };
}

async function loadDays(conn) {
  const row = await conn('system_settings').where({ key: DAYS_KEY }).first();
  const days = parseJson(row?.value, {});
  return days && typeof days === 'object' && !Array.isArray(days) ? days : {};
}

async function saveRun(conn, run, days, now) {
  await conn.transaction(async (trx) => {
    const prior = await trx('system_settings').where({ key: HISTORY_KEY }).first();
    const history = parseJson(prior?.value, []);
    // One entry per cron tick (ET date and hour): a retry or a second deploy instance replaces it, never adds one.
    const entry = { at: run.at, tick: run.tick, day: run.day, call: run.call, campaigns: run.campaigns.map((c) => [c.campaign_id, c.would]) };
    const others = (Array.isArray(history) ? history : []).filter((e) => !e || e.tick !== run.tick);
    const kept = [...others, entry].slice(-HISTORY_MAX);
    const keptDays = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).slice(-DAYS_MAX));
    const upsert = (key, value, description) => trx('system_settings')
      .insert({ key, value, category: 'ads', description })
      .onConflict('key')
      .merge({ value, updated_at: now });
    await upsert(LAST_KEY, JSON.stringify(run), 'Latest rain-day ads record run');
    await upsert(HISTORY_KEY, JSON.stringify(kept), `Recent rain-day ads record runs (last ${HISTORY_MAX})`);
    await upsert(DAYS_KEY, JSON.stringify(keptDays), 'Rain-day ads call and measured score, one row per sold day');
  });
}

/**
 * The day's row after a run, or null when there is still nothing to keep. The latest call moves only when the
 * forecast settles. The cutoff is taken once, at the first run from 2 PM the day before (`cutoffRun`; a Sunday run
 * sells Monday all day, only its 2 PM and later runs count): the call in force then, kept or settled, or 'unknown'
 * when there was none. cutoff_at marks it taken, so a later call never replaces it.
 */
function nextDayRow(prior, { day, forecast, call, cutoffRun, at }) {
  const next = { ...(prior || {}), day };
  if (forecast.call !== 'unknown') {
    Object.assign(next, { call: forecast.call, at, areas: forecast.areas.filter((a) => a.rain).map((a) => a.zone) });
  }
  if (!next.cutoff_at && cutoffRun) Object.assign(next, { cutoff_call: call, cutoff_at: at });
  return next.call || next.cutoff_at ? next : null;
}

/**
 * Scores up to SCORE_MAX past, unscored days (in place), least recently tried first, so a day waiting on radar gaps
 * never blocks the days after it. Returns the days scored.
 */
async function scorePastDays(days, now, opts) {
  const today = etDateString(now);
  const tried = (d) => days[d].score_tried_at || '';
  const due = Object.keys(days)
    .filter((d) => d < today && !days[d].score && days[d].call)
    .sort((a, b) => tried(a).localeCompare(tried(b)) || a.localeCompare(b))
    .slice(0, SCORE_MAX);
  const scored = [];
  for (const day of due) {
    const score = await scoreDay(days[day], { ...opts, now });
    if (score) { days[day] = { ...days[day], score }; scored.push(day); }
    else days[day] = { ...days[day], score_tried_at: now.toISOString() };
  }
  return scored;
}

/**
 * One run. Returns { day, call, campaigns, scored, problems }. Problems: an unknown call, a failed save.
 */
async function recordRun({ now = new Date(), conn = db, read, fetchRain } = {}) {
  const problems = [];
  const day = soldDay(now);
  const forecast = await forecastDay(day, { read });
  const days = await loadDays(conn);
  // An unknown forecast never replaces the day's last settled call (made at 2 PM the day before, or later).
  const call = forecast.call === 'unknown' ? (days[day]?.call || 'unknown') : forecast.call;
  const rows = await conn('ad_campaigns').where('platform', 'google_ads');
  const campaigns = rows
    .filter((c) => ['active', 'paused'].includes(c.status))
    .map((c) => {
      const rainClass = rainClassOf(c);
      return {
        campaign_id: c.id,
        campaign_name: c.campaign_name,
        status: c.status,
        rain_class: rainClass,
        would: decideCampaign(rainClass, call),
      };
    });
  // No call in force (none settled now, none kept from earlier) is a failed tick: every campaign would get nothing.
  // A sold-day morning whose early hours left the feed keeps its earlier settled call and is not a fault.
  if (call === 'unknown') {
    problems.push(`forecast unsettled for ${day}: ${forecast.areas.filter((a) => a.rain !== null).length} settled, `
      + `${forecast.areas.length} of ${Object.keys(ZONE_COORDS).length} areas read`);
  }
  if (!campaigns.some((c) => c.rain_class === 'indoor')) logger.info('[ads-rain-mode] no indoor campaign is marked yet');

  // mode: this module only records ("shadow"), so later live runs can be told apart.
  const tick = `${etDateString(now)}T${String(etParts(now).hour).padStart(2, '0')}`;
  const run = { at: now.toISOString(), tick, mode: 'shadow', ...forecast, call, forecast_call: forecast.call, campaigns };
  let scored = [];
  try {
    // The day's latest settled call stands. A call already scored is never rewritten.
    if (!days[day]?.score) {
      const next = nextDayRow(days[day], { day, forecast, call, cutoffRun: day > etDateString(now) && etParts(now).hour >= 14, at: run.at });
      if (next) days[day] = next;
    }
    scored = await scorePastDays(days, now, { fetchRain });
    await saveRun(conn, run, days, now);
  } catch (err) {
    problems.push(`the run was not saved: ${err.message}`);
  }
  logger.info(`[ads-rain-mode] ${day}: ${call}${forecast.call === call ? '' : ' (kept)'} (${forecast.areas.filter((a) => a.rain).length}/${forecast.areas.length} areas wet`
    + `${forecast.unread.length ? `, unread ${forecast.unread.join(', ')}` : ''}); scored ${scored.length}`);
  return { day, call, forecast_call: forecast.call, campaigns, scored, problems };
}

/** The cron's step: throws when the run had a problem, so job_health shows the failed tick with its cause. */
async function recordRainMode(opts) {
  const run = await recordRun(opts);
  for (const problem of run.problems) logger.error(`[ads-rain-mode] ${run.day}: ${problem}`);
  if (run.problems.length) throw new Error(`rain mode record: ${run.problems[0]}`);
  return run;
}

module.exports = {
  LAST_KEY,
  HISTORY_KEY,
  DAYS_KEY,
  RAIN_PCT,
  RAIN_HOURS,
  WET_INCHES,
  soldDay,
  rainClassOf,
  countWetHours,
  forecastDay,
  decideCampaign,
  scoreDay,
  nextDayRow,
  recordRun,
  recordRainMode,
};
