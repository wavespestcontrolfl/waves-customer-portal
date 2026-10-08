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
 * "outside normal hours" notice for a phone booking already uses. It is
 * raised through raiseAdminAlert (docs/admin-notifications.md).
 *
 * It only tells. Nothing is moved, no customer is texted, and no triage card
 * is created (an audit found 356 triage cards created and 0 reviewed). On the
 * day itself storm-watch.js still nudges the technician.
 *
 * Noise limits: outdoor work only (rain-fit's classification, by catalog
 * identity), the next RAIN_DAYS dates only, the booked property's own point
 * inside the service area,
 * one notification per visit (dedupeKey). Never throws: any failure is "no
 * flag", and the booking above it is already committed.
 */
const logger = require('./logger');
const {
  rainFitFor, withCatalogKeys, isWetWindow, inRainHorizon, boundedHourlyRain, RAIN_PCT, RAIN_AFTER_HOURS,
} = require('./scheduling/rain-fit');
const { etDateString, parseETDateTime, formatETTime } = require('../utils/datetime-et');

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

// A { lat, lng } inside the service area, or null.
function areaPoint(lat, lng) {
  if (lat == null || lng == null) return null;
  const { isInServiceAreaCoarseBox } = require('./service-area');
  return isInServiceAreaCoarseBox(Number(lat), Number(lng)) ? { lat: Number(lat), lng: Number(lng) } : null;
}

async function customerPoint(db, customerId) {
  if (!customerId) return null;
  const row = await db('customers').where({ id: customerId }).first('latitude', 'longitude');
  return areaPoint(row?.latitude, row?.longitude);
}

// Where the work happens. The pipeline stamps the booked property's own
// coordinates on the visit (lat / lng), which for a multi-property customer
// differ from the customer row's primary home (Codex #6136 r1). A visit tied
// to a specific property with no stamped point has no trustworthy point:
// the customer row could be another address, so it gets no forecast. Only a
// visit with no property at all falls back to the customer's point.
async function visitPoint(visit, { db, deps }) {
  const stamped = areaPoint(visit.lat, visit.lng);
  if (stamped || visit.property_id) return stamped;
  return (deps.customerPoint || customerPoint)(db, visit.customer_id);
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
  // The end is the later of the stored window end and start + the visit's
  // real length: the pipeline writes a one-hour window even for a two-hour
  // treatment and stores the length in estimated_duration_minutes, and the
  // rain check must cover all of the work plus its drying tail (Codex #6136 r1).
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const storedEnd = hhmm(windowEnd || visit.window_end);
  const length = Number(visit.estimated_duration_minutes);
  const endMin = Math.min(24 * 60 - 1, Math.max(
    toMin(start) + 60,
    /^\d{2}:\d{2}$/.test(storedEnd) ? toMin(storedEnd) : 0,
    Number.isFinite(length) && length > 0 ? toMin(start) + length : 0,
  ));
  const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
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
  const point = await visitPoint(visit, { db, deps });
  if (!point) return { reason: 'no_point' };
  const hourly = await (deps.hourlyRain || boundedHourlyRain)(point.lat, point.lng, true);
  const wet = isWetWindow(hourly, { date: window.date, start_time: window.start, end_time: window.end }, todayYmd) === true;
  return wet ? { reason: 'wet', peak: peakChance(hourly, window) } : { reason: 'not_wet' };
}

// The notice, raised through the shared composer (docs/admin-notifications.md):
// the customer's name in the headline, a spoken day and time in the why (no
// ISO date), a link that opens the visit, and the exact values in `detail`.
// One-shot per visit: the dedupe key holds it to one row however many times
// the call is reprocessed, and the relevance sweep is its backstop.
async function sendNotice(visit, window, peak, { callSid, db, deps }) {
  const { raiseAdminAlert, cutAtWord, MAX_WHY_CHARS } = require('./admin-alert-compose');
  const { lookupCustomerName, fitAction } = require('./admin-alert-names');
  const raise = deps.raiseAdminAlert || raiseAdminAlert;
  const name = await (deps.customerName || lookupCustomerName)(db, visit.customer_id);
  const at = parseETDateTime(`${window.date}T${window.start}`);
  const spokenDay = at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }).replace(',', '');
  const service = String(visit.service_type || 'visit').replace(/\s+/g, ' ').trim();
  const chance = peak ?? RAIN_PCT;
  const tail = ` on ${spokenDay} at ${formatETTime(at)} has a rain chance of ${chance}%.`;
  return raise(
    'schedule',
    {
      area: 'Schedule',
      action: name
        ? fitAction('Schedule', name, [(who) => `check ${who}'s visit for rain`, (who) => `check ${who}'s visit`])
        : 'check a phone-booked visit for rain',
      // The service name gives up characters first; the day, time and chance stay.
      why: `Phone-booked ${cutAtWord(service, MAX_WHY_CHARS - 'Phone-booked '.length - tail.length)}${tail}`,
      severity: 'needs-you',
      link: `/admin/dispatch?tab=schedule&date=${encodeURIComponent(window.date)}&appointment=${encodeURIComponent(visit.id)}`,
      subject: { type: 'visit', id: String(visit.id) },
      doneWhen: 'visit_moved_or_done',
      who: 'person',
    },
    {
      // One notice per visit, however many times the call is reprocessed.
      dedupeKey: `call-booking-rain:${visit.id}`,
      detail: `${name || 'A customer'}: ${service} booked from a phone call for ${window.date} ${window.start}-${window.end}. `
        + `Hourly chance of rain reaches ${chance}% from the visit start through ${RAIN_AFTER_HOURS} hours after it ends. `
        + 'Nothing was moved and the customer was not contacted.',
      metadata: { scheduledServiceId: visit.id, callSid, rain_chance_pct: peak, scheduled_date: window.date, window_start: window.start },
    },
  );
}

/**
 * Flag one phone-booked visit. `visit` = the scheduled_services row the call
 * created ({ id, customer_id, property_id, lat, lng, service_type,
 * estimated_duration_minutes, ... }); `scheduledDate`,
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
    await sendNotice(visit, window, peak, { callSid, db, deps });
    return { flagged: true, reason, peak };
  } catch (err) {
    logger.warn(`[call-booking-rain-flag] skipped: ${err.message}`);
    return { flagged: false, reason: 'error' };
  }
}

module.exports = { flagCallBookingRain, GATE, _test: { peakChance } };
