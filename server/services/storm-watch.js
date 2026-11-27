/**
 * Storm watch — proactive weather nudges for techs in the field.
 *
 * Every 15 minutes (scheduler.js, runExclusive) this sweeps each tech's
 * REMAINING stops for today and probes the NWS hourly forecast at the
 * CUSTOMER's stored coordinates — never the tech's GPS or an office
 * location, because a cell can sit on Venice while Bradenton is dry.
 * When heavy-rain probability inside the look-ahead window crosses the
 * threshold for an upcoming stop, the tech gets an in-app notification
 * on the same channel as the geofence prompts:
 *
 *   "⛈ 70% storms near your 1:30 PM Venice stop — review rain-out options?"
 *
 * Tapping it opens the Rain Out sheet pre-loaded for that job. The
 * HUMAN decides — this module never reschedules anything and never
 * texts customers. It only watches the sky.
 *
 * Noise control:
 *   - one alert per job per day (existence check on tech_notifications,
 *     read or dismissed rows still count)
 *   - service-hours gate (ET) — no 3 AM pings
 *   - look-ahead limited to stops starting within the next ~2.5h
 *   - fail-open weather: no NWS, no alert, no crash
 */

const db = require('../models/db');
const logger = require('./logger');
const weatherForecast = require('./weather-forecast');
const { getHourlyRainOutlook } = weatherForecast;
const { etParts, etDateString } = require('../utils/datetime-et');
const { outdoorStopRows } = require('./scheduling/rain-fit');

// Jobs a nudge makes sense for. on_site is excluded — the tech is
// standing in the weather already and has the Rain Out button in hand.
// 'rescheduled' is excluded too: it is a customer's reschedule REQUEST waiting
// for staff, with a stale date and window (auto-dispatch apply.js, eligibility.js).
const NUDGEABLE_STATUSES = ['pending', 'confirmed', 'en_route'];

const SERVICE_HOURS_ET = { start: 7, end: 19 };
const LOOKAHEAD_MINUTES = 150;          // stops starting within ~2.5h
const FORECAST_HORIZON_MS = 2 * 60 * 60 * 1000; // probe the next 2h of sky
const RAIN_CHANCE_THRESHOLD = Number(process.env.STORM_WATCH_THRESHOLD || 60);
// Thunder/lightning triggers a rain-out nudge earlier than plain rain (owner 2026-11-26).
const THUNDER_CHANCE_THRESHOLD = 50;

const NOTIFICATION_TYPE = 'storm_watch_alert';
// Heat and wind are alert-only safety banners — NEVER a rain-out move prompt (owner 2026-11-26).
const ADVISORY_NOTIFICATION_TYPE = 'weather_safety_advisory';

function hhmmToMinutes(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function displayTime(hhmm) {
  const minutes = hhmmToMinutes(hhmm);
  if (minutes == null) return '';
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Max rain chance across the hourly periods that overlap the next
// FORECAST_HORIZON_MS. Returns null when no period qualifies.
function peakRainChance(hours, now = new Date()) {
  if (!Array.isArray(hours)) return null;
  const horizonEnd = now.getTime() + FORECAST_HORIZON_MS;
  let peak = null;
  for (const hour of hours) {
    const start = new Date(hour.startTime).getTime();
    if (!Number.isFinite(start)) continue;
    const end = start + 60 * 60 * 1000;
    if (end <= now.getTime() || start >= horizonEnd) continue;
    if (hour.rainChance != null && (peak == null || hour.rainChance > peak)) {
      peak = hour.rainChance;
    }
  }
  return peak;
}

const { heatIndexF } = require('./heat-index');

const HEAT_ADVISORY_INDEX_F = 105;
const WIND_ADVISORY_MPH = 25;
const WIND_GUST_ADVISORY_MPH = 30;
const FAWN_TIMEOUT_MS = 2500;

const maxNum = (cur, val) => (Number.isFinite(val) && (cur == null || val > cur) ? val : cur);

function hourlySafetyAdvisories(hours, now, existing) {
  const out = [...existing];
  const cats = new Set(out.map((a) => a.category));
  const horizonEnd = now.getTime() + FORECAST_HORIZON_MS;
  const inWindow = (Array.isArray(hours) ? hours : []).filter((h) => {
    const start = new Date(h?.startTime).getTime();
    return Number.isFinite(start) && start + 3600_000 > now.getTime() && start < horizonEnd;
  });
  let peakHi = null;
  let peakGust = null;
  let peakWind = null;
  for (const h of inWindow) {
    peakHi = maxNum(peakHi, heatIndexF(h.temperatureF, h.relativeHumidity));
    peakGust = maxNum(peakGust, h.windGustMph);
    peakWind = maxNum(peakWind, h.windMph);
  }
  const sawReadings = inWindow.some((h) => [h.temperatureF, h.windMph, h.windGustMph].some(Number.isFinite));
  if (!cats.has('heat_advisory') && peakHi >= HEAT_ADVISORY_INDEX_F) {
    out.push({ event: `High Heat (${Math.round(peakHi)}°F heat index)`, category: 'heat_advisory', moveTrigger: false });
  }
  if (!cats.has('wind_advisory') && (peakGust >= WIND_GUST_ADVISORY_MPH || peakWind >= WIND_ADVISORY_MPH)) {
    const label = peakGust >= WIND_GUST_ADVISORY_MPH ? `${Math.round(peakGust)} mph gusts` : `${Math.round(peakWind)} mph wind`;
    out.push({ event: `High Wind (${label})`, category: 'wind_advisory', moveTrigger: false });
  }
  return { advisories: out, sawReadings };
}

function fawnSafetyAdvisories(fawn, existing) {
  if (!fawn || fawn.station === 'unavailable') return existing;
  const out = [...existing];
  const cats = new Set(out.map((a) => a.category));
  const where = fawn.station ? ` at ${fawn.station}` : '';
  const hi = heatIndexF(fawn.temp_f, fawn.humidity_pct);
  if (!cats.has('heat_advisory') && hi != null && Math.round(hi) >= HEAT_ADVISORY_INDEX_F) {
    out.push({ event: `High Heat (${Math.round(hi)}°F heat index${where})`, category: 'heat_advisory', moveTrigger: false, source: 'fawn' });
  }
  if (!cats.has('wind_advisory') && Number.isFinite(fawn.wind_mph) && fawn.wind_mph >= WIND_ADVISORY_MPH) {
    out.push({ event: `High Wind (${Math.round(fawn.wind_mph)} mph${where})`, category: 'wind_advisory', moveTrigger: false, source: 'fawn' });
  }
  return out;
}

// Evaluate move triggers (rain >= 60%, thunder >= 50%, or active NWS severe/tropical/thunderstorm
// warning) vs alert-only advisories (heat/wind from NWS alerts, hourly metrics, or FAWN ground fallback).
function stormSignal(hours, alerts, now = new Date(), fawn = null) {
  const peak = peakRainChance(hours, now);
  const horizonEnd = now.getTime() + FORECAST_HORIZON_MS;
  let hasThunder = false;
  if (Array.isArray(hours)) {
    for (const hour of hours) {
      const start = new Date(hour.startTime).getTime();
      if (!Number.isFinite(start) || start + 3600_000 <= now.getTime() || start >= horizonEnd) continue;
      if (hour.hasThunder === true && Number.isFinite(hour.rainChance) && hour.rainChance >= THUNDER_CHANCE_THRESHOLD) {
        hasThunder = true;
      }
    }
  }
  const overlaps = typeof weatherForecast.alertOverlapsWindow === 'function'
    ? (a) => weatherForecast.alertOverlapsWindow(a, now.getTime(), horizonEnd)
    : () => true;
  const active = (Array.isArray(alerts) ? alerts : []).filter(overlaps);
  const severeAlerts = active.filter((a) => a.moveTrigger === true);
  const nwsAdvisories = active.filter((a) => a.category === 'heat_advisory' || a.category === 'wind_advisory');
  const { advisories: withHourly, sawReadings } = hourlySafetyAdvisories(hours, now, nwsAdvisories);
  const advisories = sawReadings ? withHourly : fawnSafetyAdvisories(fawn, withHourly);
  const shouldNudge = severeAlerts.length > 0 || hasThunder || (peak != null && peak >= RAIN_CHANCE_THRESHOLD);
  return { peak, hasThunder, severeAlerts, advisories, shouldNudge };
}

function stormMessage(signal, timeLabel, where) {
  const whenWhere = `${timeLabel ? `${timeLabel} ` : ''}${where}`;
  if (signal.severeAlerts.length > 0) {
    return `⛈ ${signal.severeAlerts[0].event} near your ${whenWhere} — review rain-out options?`;
  }
  if (signal.hasThunder && (signal.peak == null || signal.peak < RAIN_CHANCE_THRESHOLD)) {
    const pct = signal.peak != null ? ` (${signal.peak}%)` : '';
    return `⚡ Thunderstorms${pct} near your ${whenWhere} — review rain-out options?`;
  }
  return `⛈ ${signal.peak}% storms near your ${whenWhere} — review rain-out options?`;
}

// Remaining nudgeable stops today whose window starts inside the
// look-ahead (or is already open). Joined to customers for the
// COORDINATES THE PROBE USES — customer lat/lng, nothing else.
async function upcomingStops(todayStr, nowMinutes) {
  const rows = await db('scheduled_services')
    .where('scheduled_services.scheduled_date', todayStr)
    .whereIn('scheduled_services.status', NUDGEABLE_STATUSES)
    .whereNotNull('scheduled_services.technician_id')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.id',
      'scheduled_services.technician_id',
      'scheduled_services.customer_id',
      'scheduled_services.service_type',
      'scheduled_services.service_key_snapshot',
      'scheduled_services.visit_id',
      'scheduled_services.status',
      'scheduled_services.window_start',
      'scheduled_services.window_end',
      'customers.latitude as customer_latitude',
      'customers.longitude as customer_longitude',
      'customers.city as customer_city',
    );

  // Rain does not spoil rain-OK work (inspections, trapping, bait stations,
  // indoor work): no nudge for a stop whose services are all of that kind. A
  // grouped stop with any outdoor service keeps its nudge.
  const outdoorRows = await outdoorStopRows(rows, db);

  return outdoorRows.filter((job) => {
    const startMin = hhmmToMinutes(job.window_start);
    const endMin = hhmmToMinutes(job.window_end);
    if (startMin == null) return false;
    if (endMin != null && endMin < nowMinutes) return false; // window already over
    return startMin <= nowMinutes + LOOKAHEAD_MINUTES;
  });
}

// One alert per job per day PER TECH — read/dismissed rows still
// suppress. Scoped to the CURRENT technician_id so a mid-day
// reassignment alerts the tech who actually owns the stop now; the
// old tech's notification stays consumed and doesn't block them.
async function alreadyAlertedToday(jobId, technicianId, todayStr, type = NOTIFICATION_TYPE) {
  const existing = await db('tech_notifications')
    .where({ type, technician_id: technicianId })
    .whereRaw("payload->>'job_id' = ?", [String(jobId)])
    .whereRaw('created_at >= ?::date', [todayStr])
    .first('id');
  return !!existing;
}

// Track advisory hazard categories already sent today for this (job, tech) so
// both Heat Advisory and Wind Advisory can notify independently when a second
// hazard appears later in the day.
async function sentAdvisoryCategoriesToday(jobId, technicianId, todayStr) {
  const query = db('tech_notifications')
    .where({ type: ADVISORY_NOTIFICATION_TYPE, technician_id: technicianId })
    .whereRaw("payload->>'job_id' = ?", [String(jobId)])
    .whereRaw('created_at >= ?::date', [todayStr]);
  const rows = typeof query.select === 'function'
    ? await query.select('payload')
    : ((await query.first('id', 'payload')) ? [await query.first('id', 'payload')] : []);
  const seen = new Set();
  for (const row of rows || []) {
    if (!row) continue;
    let payload = row.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    if (Array.isArray(payload?.advisories) && payload.advisories.length) {
      for (const a of payload.advisories) {
        if (a?.category) seen.add(String(a.category));
      }
    } else if (payload?.category) {
      seen.add(String(payload.category));
    } else {
      seen.add('__legacy__');
    }
  }
  return seen;
}

async function readActiveAlertsSafe(lat, lng, cache) {
  if (typeof weatherForecast.getNwsActiveAlerts !== 'function') return null;
  const key = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
  if (!cache.has(key)) {
    cache.set(key, weatherForecast.getNwsActiveAlerts(lat, lng).catch(() => null));
  }
  return cache.get(key);
}

async function readFawnSafe(lat, lng, cache, readFawn) {
  const key = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
  if (!cache.has(key)) {
    const loader = readFawn || ((coords) => require('./fawn-weather').getCurrent(coords));
    let timer;
    const bounded = Promise.race([
      Promise.resolve().then(() => loader({ latitude: lat, longitude: lng })).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), FAWN_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    cache.set(key, bounded);
  }
  return cache.get(key);
}

async function sweep(now = new Date(), { readFawn } = {}) {
  const parts = etParts(now);
  if (parts.hour < SERVICE_HOURS_ET.start || parts.hour >= SERVICE_HOURS_ET.end) {
    return { skipped: true, reason: 'outside_service_hours' };
  }

  const todayStr = etDateString(now);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const stops = await upcomingStops(todayStr, nowMinutes);
  if (stops.length === 0) return { checked: 0, alerted: 0 };

  const alertsCache = new Map();
  const fawnCache = new Map();
  let alerted = 0;
  let advisoriesSent = 0;
  for (const job of stops) {
    // No customer coordinates → nothing to probe. Quietly skip; the
    // tech still has the manual Rain Out button.
    if (job.customer_latitude == null || job.customer_longitude == null) continue;

    let hours = null;
    try {
      hours = await getHourlyRainOutlook(job.customer_latitude, job.customer_longitude);
    } catch (err) {
      logger.info(`[storm-watch] hourly outlook failed for job ${job.id}: ${err.message}`);
    }
    const alerts = await readActiveAlertsSafe(job.customer_latitude, job.customer_longitude, alertsCache);
    // FAWN ground-truth fallback only when hourly forecast is unavailable (avoids redundant calls).
    const fawn = (!Array.isArray(hours) || hours.length === 0)
      ? await readFawnSafe(job.customer_latitude, job.customer_longitude, fawnCache, readFawn)
      : null;
    const signal = stormSignal(hours, alerts, now, fawn);
    const timeLabel = displayTime(job.window_start);
    const where = job.customer_city ? `${job.customer_city} stop` : 'next stop';

    if (signal.shouldNudge && !(await alreadyAlertedToday(job.id, job.technician_id, todayStr, NOTIFICATION_TYPE))) {
      try {
        await db('tech_notifications').insert({
          technician_id: job.technician_id,
          type: NOTIFICATION_TYPE,
          message: stormMessage(signal, timeLabel, where),
          payload: JSON.stringify({
            job_id: job.id,
            customer_id: job.customer_id,
            service_type: job.service_type,
            window_start: job.window_start,
            window_end: job.window_end,
            rain_chance: signal.peak,
            has_thunder: signal.hasThunder,
            ...(signal.severeAlerts.length ? { severe_alerts: signal.severeAlerts.map((a) => a.event) } : {}),
            ...(signal.advisories.length ? { advisories: signal.advisories.map((a) => a.event) } : {}),
            city: job.customer_city || null,
          }),
        });
        alerted += 1;
      } catch (err) {
        logger.error(`[storm-watch] notification insert failed for job ${job.id}: ${err.message}`);
      }
    }
    if (signal.advisories.length > 0) {
      // Heat / wind advisories are alert-only safety banners — NEVER a rain-out reschedule prompt.
      // Evaluated independently of storm nudges so a simultaneous heat/wind advisory is not hidden
      // behind a storm card, and deduped per hazard category.
      const sentCategories = await sentAdvisoryCategoriesToday(job.id, job.technician_id, todayStr);
      const unseenAdvisories = sentCategories.has('__legacy__')
        ? []
        : signal.advisories.filter((a) => !sentCategories.has(String(a.category || a.event)));
      if (unseenAdvisories.length > 0) {
        const eventsLabel = unseenAdvisories.map((a) => a.event).join(' & ');
        try {
          await db('tech_notifications').insert({
            technician_id: job.technician_id,
            type: ADVISORY_NOTIFICATION_TYPE,
            message: `⚠️ ${eventsLabel} near your ${timeLabel ? `${timeLabel} ` : ''}${where} — safety advisory only (no schedule move).`,
            payload: JSON.stringify({
              job_id: job.id,
              customer_id: job.customer_id,
              service_type: job.service_type,
              window_start: job.window_start,
              window_end: job.window_end,
              advisory_only: true,
              advisories: unseenAdvisories.map((a) => ({ event: a.event, category: a.category })),
              city: job.customer_city || null,
            }),
          });
          advisoriesSent += 1;
        } catch (err) {
          logger.error(`[storm-watch] advisory insert failed for job ${job.id}: ${err.message}`);
        }
      }
    }
  }

  if (alerted > 0) logger.info(`[storm-watch] sweep alerted ${alerted}/${stops.length} upcoming stops`);
  return advisoriesSent > 0 ? { checked: stops.length, alerted, advisories: advisoriesSent } : { checked: stops.length, alerted };
}

module.exports = {
  sweep,
  NOTIFICATION_TYPE,
  ADVISORY_NOTIFICATION_TYPE,
  _test: { peakRainChance, stormSignal, stormMessage, upcomingStops, RAIN_CHANCE_THRESHOLD, THUNDER_CHANCE_THRESHOLD, displayTime },
};
