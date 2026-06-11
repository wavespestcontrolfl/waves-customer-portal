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
const { getHourlyRainOutlook } = require('./weather-forecast');
const { etParts, etDateString } = require('../utils/datetime-et');

// Jobs a nudge makes sense for. on_site is excluded — the tech is
// standing in the weather already and has the Rain Out button in hand.
const NUDGEABLE_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route'];

const SERVICE_HOURS_ET = { start: 7, end: 19 };
const LOOKAHEAD_MINUTES = 150;          // stops starting within ~2.5h
const FORECAST_HORIZON_MS = 2 * 60 * 60 * 1000; // probe the next 2h of sky
const RAIN_CHANCE_THRESHOLD = Number(process.env.STORM_WATCH_THRESHOLD || 60);

const NOTIFICATION_TYPE = 'storm_watch_alert';

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
      'scheduled_services.status',
      'scheduled_services.window_start',
      'scheduled_services.window_end',
      'customers.latitude as customer_latitude',
      'customers.longitude as customer_longitude',
      'customers.city as customer_city',
    );

  return rows.filter((job) => {
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
async function alreadyAlertedToday(jobId, technicianId, todayStr) {
  const existing = await db('tech_notifications')
    .where({ type: NOTIFICATION_TYPE, technician_id: technicianId })
    .whereRaw("payload->>'job_id' = ?", [String(jobId)])
    .whereRaw('created_at >= ?::date', [todayStr])
    .first('id');
  return !!existing;
}

async function sweep(now = new Date()) {
  const parts = etParts(now);
  if (parts.hour < SERVICE_HOURS_ET.start || parts.hour >= SERVICE_HOURS_ET.end) {
    return { skipped: true, reason: 'outside_service_hours' };
  }

  const todayStr = etDateString(now);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const stops = await upcomingStops(todayStr, nowMinutes);
  if (stops.length === 0) return { checked: 0, alerted: 0 };

  let alerted = 0;
  for (const job of stops) {
    // No customer coordinates → nothing to probe. Quietly skip; the
    // tech still has the manual Rain Out button.
    if (job.customer_latitude == null || job.customer_longitude == null) continue;

    let peak = null;
    try {
      const hours = await getHourlyRainOutlook(job.customer_latitude, job.customer_longitude);
      peak = peakRainChance(hours, now);
    } catch (err) {
      logger.info(`[storm-watch] hourly outlook failed for job ${job.id}: ${err.message}`);
      continue;
    }
    if (peak == null || peak < RAIN_CHANCE_THRESHOLD) continue;

    if (await alreadyAlertedToday(job.id, job.technician_id, todayStr)) continue;

    const timeLabel = displayTime(job.window_start);
    const where = job.customer_city ? `${job.customer_city} stop` : 'next stop';
    try {
      await db('tech_notifications').insert({
        technician_id: job.technician_id,
        type: NOTIFICATION_TYPE,
        message: `⛈ ${peak}% storms near your ${timeLabel ? `${timeLabel} ` : ''}${where} — review rain-out options?`,
        payload: JSON.stringify({
          job_id: job.id,
          customer_id: job.customer_id,
          service_type: job.service_type,
          window_start: job.window_start,
          window_end: job.window_end,
          rain_chance: peak,
          city: job.customer_city || null,
        }),
      });
      alerted += 1;
    } catch (err) {
      logger.error(`[storm-watch] notification insert failed for job ${job.id}: ${err.message}`);
    }
  }

  if (alerted > 0) logger.info(`[storm-watch] sweep alerted ${alerted}/${stops.length} upcoming stops`);
  return { checked: stops.length, alerted };
}

module.exports = {
  sweep,
  NOTIFICATION_TYPE,
  _test: { peakRainChance, upcomingStops, RAIN_CHANCE_THRESHOLD, displayTime },
};
