/**
 * Find-a-Time Scoring Service
 * server/services/scheduling/find-time.js
 *
 * Given a new job (lat/lng + duration) and a date range, returns a ranked list
 * of feasible slots on each tech's day, scored by detour cost (extra drive
 * time added by inserting the new stop into an existing route).
 *
 * Uses haversine × 1.4 road factor at 30 mph for drive-time estimates — same
 * approximation the route-optimizer fallback uses. No API calls per request.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { HQ, haversine } = require('../route-optimizer');

const ROAD_FACTOR = 1.4;
const AVG_MPH = 30;
const DAY_START_HOUR = 8;   // 8:00 AM
const DAY_END_HOUR = 17;    // 5:00 PM
const DEFAULT_SERVICE_MIN = 60;

/**
 * Convert straight-line miles to estimated drive minutes.
 */
function milesToDriveMinutes(miles) {
  return Math.round((miles * ROAD_FACTOR / AVG_MPH) * 60);
}

/**
 * Drive minutes between two {lat,lng} points.
 */
function driveMin(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return 0;
  return milesToDriveMinutes(haversine(
    parseFloat(a.lat), parseFloat(a.lng),
    parseFloat(b.lat), parseFloat(b.lng)
  ));
}

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function toDateStr(d) {
  if (typeof d === 'string') return d.split('T')[0];
  return d.toISOString().split('T')[0];
}

function enumerateDates(from, to) {
  const dates = [];
  const start = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0) continue; // skip Sundays
    dates.push(toDateStr(d));
  }
  return dates;
}

/**
 * Main entry. Returns ranked candidate slots.
 *
 * @param {Object} opts
 * @param {number} opts.lat                  Target job latitude
 * @param {number} opts.lng                  Target job longitude
 * @param {number} [opts.durationMinutes=60] How long the new job takes
 * @param {string} opts.dateFrom             YYYY-MM-DD
 * @param {string} opts.dateTo               YYYY-MM-DD
 * @param {string} [opts.technicianId]       Restrict to one tech
 * @param {number} [opts.topN=10]            How many slots to return
 * @param {number} [opts.dayStartHour=8]
 * @param {number} [opts.dayEndHour=17]
 * @returns {Promise<{slots: Array, evaluated: number}>}
 */
async function findAvailableSlots(opts) {
  const {
    lat, lng,
    durationMinutes = DEFAULT_SERVICE_MIN,
    dateFrom, dateTo,
    technicianId,
    topN = 10,
    dayStartHour = DAY_START_HOUR,
    dayEndHour = DAY_END_HOUR,
  } = opts;

  if (lat == null || lng == null) {
    return { error: 'lat/lng required', slots: [] };
  }
  if (!dateFrom || !dateTo) {
    return { error: 'dateFrom and dateTo required', slots: [] };
  }

  const newStop = { lat: parseFloat(lat), lng: parseFloat(lng) };
  const dayOpen = dayStartHour * 60;
  const dayClose = dayEndHour * 60;

  // Load techs
  let techQuery = db('technicians').where({ active: true }).select('id', 'name');
  if (technicianId) techQuery = techQuery.where('id', technicianId);
  const techs = await techQuery;
  if (!techs.length) return { slots: [], evaluated: 0, note: 'No active technicians found' };

  // Load all scheduled services in date range, per tech, with coords
  const services = await db('scheduled_services')
    .whereBetween('scheduled_date', [dateFrom, dateTo])
    .whereNotIn('scheduled_services.status', ['cancelled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.id',
      'scheduled_services.scheduled_date',
      'scheduled_services.technician_id',
      'scheduled_services.window_start',
      'scheduled_services.window_end',
      'scheduled_services.service_type',
      'scheduled_services.estimated_duration_minutes',
      'scheduled_services.lat as svc_lat',
      'scheduled_services.lng as svc_lng',
      'customers.first_name',
      'customers.last_name',
      'customers.city',
      // Canonical columns on customers are latitude/longitude (added
      // by 20260414000029_geofence_timers.js). customers.lat / customers.lng
      // don't exist on prod — reading them throws and kills the whole
      // /available-slots query. Aliased back to cust_lat/cust_lng for
      // the downstream code that consumes those names.
      'customers.latitude as cust_lat',
      'customers.longitude as cust_lng',
    );

  const dates = enumerateDates(dateFrom, dateTo);
  const candidates = [];
  let evaluated = 0;

  for (const date of dates) {
    for (const tech of techs) {
      // Pull this tech's stops for this day
      const dayStops = services
        .filter(s => {
          const sd = toDateStr(s.scheduled_date);
          return sd === date && s.technician_id === tech.id;
        })
        .map(s => ({
          id: s.id,
          lat: s.cust_lat || s.svc_lat,
          lng: s.cust_lng || s.svc_lng,
          startMin: timeToMinutes(s.window_start) || dayOpen,
          endMin: timeToMinutes(s.window_end) || (timeToMinutes(s.window_start) || dayOpen) + (s.estimated_duration_minutes || DEFAULT_SERVICE_MIN),
          customer: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown',
          city: s.city,
          service_type: s.service_type,
        }))
        .sort((a, b) => a.startMin - b.startMin);

      // Build virtual stop list: HQ ... stops ... HQ
      // "Stops" include timing. For gaps we evaluate between consecutive anchors.
      const anchors = [
        { id: 'HQ_START', lat: HQ.lat, lng: HQ.lng, startMin: dayOpen, endMin: dayOpen, customer: 'HQ (start)' },
        ...dayStops,
        { id: 'HQ_END', lat: HQ.lat, lng: HQ.lng, startMin: dayClose, endMin: dayClose, customer: 'HQ (end)' },
      ];

      // Evaluate each gap between anchor[i] and anchor[i+1]
      for (let i = 0; i < anchors.length - 1; i++) {
        const prev = anchors[i];
        const next = anchors[i + 1];
        evaluated++;

        const baselineDrive = driveMin(prev, next);
        const detourDrive = driveMin(prev, newStop) + driveMin(newStop, next);
        const extraDrive = Math.max(0, detourDrive - baselineDrive);

        // Earliest the new job could start: after prev.endMin + drive from prev → new
        const earliestStart = Math.max(dayOpen, prev.endMin + driveMin(prev, newStop));
        const earliestEnd = earliestStart + durationMinutes;
        // Must allow drive from new → next before next.startMin
        const latestEnd = next.startMin - driveMin(newStop, next);

        if (earliestEnd > latestEnd) continue; // doesn't fit
        if (earliestEnd > dayClose) continue;  // past end of day
        if (!prev.lat || !next.lat) continue;  // missing coords — skip

        // Day delay penalty — prefer sooner days (0.5 min/day)
        const daysOut = Math.max(0, (new Date(date + 'T12:00:00') - new Date(dateFrom + 'T12:00:00')) / (1000 * 60 * 60 * 24));
        const score = extraDrive + daysOut * 0.5;

        candidates.push({
          date,
          technician: { id: tech.id, name: tech.name },
          start_time: minutesToTime(earliestStart),
          end_time: minutesToTime(earliestEnd),
          detour_minutes: extraDrive,
          baseline_drive_minutes: baselineDrive,
          total_drive_minutes: detourDrive,
          score,
          insertion: {
            after: prev.id === 'HQ_START' ? 'HQ (start of day)' : `${prev.customer} (${minutesToTime(prev.endMin)})`,
            before: next.id === 'HQ_END' ? 'HQ (end of day)' : `${next.customer} (${minutesToTime(next.startMin)})`,
            after_stop_id: prev.id === 'HQ_START' || prev.id === 'HQ_END' ? null : prev.id,
            before_stop_id: next.id === 'HQ_START' || next.id === 'HQ_END' ? null : next.id,
          },
          stops_that_day: dayStops.length,
        });
      }
    }
  }

  // Sort by score ascending (lower = better)
  candidates.sort((a, b) => a.score - b.score);

  return {
    slots: candidates.slice(0, topN).map((c, i) => ({ rank: i + 1, ...c })),
    evaluated,
    total_feasible: candidates.length,
  };
}

module.exports = { findAvailableSlots };
