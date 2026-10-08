/**
 * Rain flag for phone bookings (owner 2026-10-08, GATE_CALL_BOOKING_RAIN_FLAG,
 * dark).
 *
 * The call pipeline books the time a person agreed with the caller; it never
 * chooses a time, so the rain ranking (rain-fit.js) has nothing to order
 * there. In 90 days 35 of 39 such bookings came from calls a person answered,
 * and 30 of 39 were for a date inside the 3-day rain horizon. This module is
 * the lever that reaches them: after the visit is written, when it is outdoor
 * work in a rain window, the office gets ONE admin notification on the
 * 'schedule' channel, the channel the existing "overlaps the schedule" /
 * "outside normal hours" notice for a phone booking already uses.
 *
 * It only tells. Nothing is moved, no customer is texted, and no triage card
 * is created (an audit found 356 triage cards created and 0 reviewed). On the
 * day itself storm-watch.js still nudges the technician.
 *
 * Noise limits: outdoor work only (rain-fit's classification, by catalog
 * identity), the next RAIN_DAYS dates only, a point inside the service area,
 * one notification per visit (dedupeKey). Never throws: any failure is "no
 * flag", and the booking above it is already committed.
 */
const logger = require('./logger');
const {
  rainFitFor, withCatalogKeys, isWetWindow, inRainHorizon, boundedHourlyRain, RAIN_PCT, RAIN_AFTER_HOURS,
} = require('./scheduling/rain-fit');
const { etDateString } = require('../utils/datetime-et');

const GATE = 'GATE_CALL_BOOKING_RAIN_FLAG';

const dateOnly = (value) => (value instanceof Date ? etDateString(value) : String(value || '').slice(0, 10));
const hhmm = (value) => String(value || '').slice(0, 5);

// The highest hourly chance from the visit's start through RAIN_AFTER_HOURS
// after its end: the number the notice quotes.
function peakChance(hourly, { date, start, end }) {
  const startHour = Number(start.slice(0, 2));
  const endHour = Math.max(startHour + 1, Math.ceil(Number(end.slice(0, 2)) + Number(end.slice(3, 5)) / 60));
  let peak = null;
  for (let hour = startHour; hour < endHour + RAIN_AFTER_HOURS && hour < 24; hour += 1) {
    const key = `${date}T${String(hour).padStart(2, '0')}`;
    const reading = hourly.find((h) => String(h.startTime).slice(0, 13) === key);
    if (reading && Number.isFinite(reading.rainChance) && (peak == null || reading.rainChance > peak)) peak = reading.rainChance;
  }
  return peak;
}

async function customerPoint(db, customerId) {
  if (!customerId) return null;
  const row = await db('customers').where({ id: customerId }).first('latitude', 'longitude');
  const lat = Number(row?.latitude);
  const lng = Number(row?.longitude);
  const { isInServiceAreaCoarseBox } = require('./service-area');
  return row?.latitude != null && row?.longitude != null && isInServiceAreaCoarseBox(lat, lng) ? { lat, lng } : null;
}

// The visit's date and window: the pipeline's own values when it passes them
// (what the row was written with), else the row's; the pipeline's 09:00
// default when neither has a start, and a one-hour visit when neither has an
// end. Null when there is no usable visit.
function visitWindow({ visit, scheduledDate, windowStart, windowEnd }) {
  if (!visit || !visit.id) return null;
  const date = dateOnly(scheduledDate || visit.scheduled_date);
  const start = hhmm(windowStart || visit.window_start || '09:00');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start)) return null;
  const end = hhmm(windowEnd || visit.window_end) || `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:${start.slice(3, 5)}`;
  return { date, start, end };
}

// Outdoor by rain-fit's classification, on the catalog row the pipeline
// resolved (its service_key is the identity), else the visit's name.
async function isOutdoorVisit(visit, catalogRow, db) {
  const serviceKey = (catalogRow && catalogRow.service_key) || null;
  const services = await withCatalogKeys([{ name: visit.service_type || 'visit', serviceKey }], db, { gate: GATE });
  return rainFitFor(services) === 'avoid';
}

// The peak chance when the window is wet at the customer's point; undefined
// when it is not (dry, unreadable, or no forecast). `reason` says which.
async function wetPeak(visit, window, todayYmd, { db, deps }) {
  const point = await (deps.customerPoint || customerPoint)(db, visit.customer_id);
  if (!point) return { reason: 'no_point' };
  const hourly = await (deps.hourlyRain || boundedHourlyRain)(point.lat, point.lng, true);
  const wet = isWetWindow(hourly, { date: window.date, start_time: window.start, end_time: window.end }, todayYmd) === true;
  return wet ? { reason: 'wet', peak: peakChance(hourly, window) } : { reason: 'not_wet' };
}

function sendNotice(visit, window, peak, { callSid, deps }) {
  const notify = deps.notifyAdmin || ((...args) => require('./notification-service').notifyAdmin(...args));
  return notify(
    'schedule',
    'Call booking in a rain window',
    `Phone-booked ${visit.service_type || 'visit'} on ${window.date} at ${window.start} has a ${peak ?? RAIN_PCT}% chance of rain — review it on the dispatch board.`,
    {
      link: '/admin/dispatch',
      // One notice per visit, however many times the call is reprocessed.
      dedupeKey: `call-booking-rain:${visit.id}`,
      metadata: { scheduledServiceId: visit.id, callSid, rain_chance_pct: peak, scheduled_date: window.date, window_start: window.start },
    },
  );
}

/**
 * Flag one phone-booked visit. `visit` = the scheduled_services row the call
 * created ({ id, customer_id, service_type, ... }); `scheduledDate`,
 * `windowStart`, `windowEnd` = what the pipeline wrote it with; `catalogRow`
 * = the catalog row the pipeline resolved (its service_key is the identity).
 * Resolves to { flagged, reason } (for tests and logs); never rejects.
 */
async function flagCallBookingRain({
  visit, scheduledDate, windowStart, windowEnd, catalogRow = null, callSid = null, today = new Date(), db, deps = {},
} = {}) {
  try {
    const { gateEnvValue } = require('../config/feature-gates');
    if (!gateEnvValue(GATE)) return { flagged: false, reason: 'gate_off' };
    const window = visitWindow({ visit, scheduledDate, windowStart, windowEnd });
    if (!window) return { flagged: false, reason: 'no_window' };
    const todayYmd = etDateString(today);
    if (!inRainHorizon(window.date, todayYmd)) return { flagged: false, reason: 'past_horizon' };
    if (!(await isOutdoorVisit(visit, catalogRow, db))) return { flagged: false, reason: 'not_outdoor' };
    const { reason, peak } = await wetPeak(visit, window, todayYmd, { db, deps });
    if (reason !== 'wet') return { flagged: false, reason };
    await sendNotice(visit, window, peak, { callSid, deps });
    return { flagged: true, reason, peak };
  } catch (err) {
    logger.warn(`[call-booking-rain-flag] skipped: ${err.message}`);
    return { flagged: false, reason: 'error' };
  }
}

module.exports = { flagCallBookingRain, GATE, _test: { peakChance } };
