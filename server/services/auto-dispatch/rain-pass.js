/**
 * Auto-dispatch rain pass (owner 2026-10-08, GATE_AUTO_DISPATCH_RAIN_PASS,
 * dark).
 *
 * The 04:10 auto-dispatch run never moves a visit inside 72 hours
 * (route-tiers.js), and the hourly rain forecast is only good for the next
 * RAIN_DAYS dates (rain-fit.js). So the run cannot see rain, and nothing
 * looked at a visit that was already booked when rain entered its forecast.
 * This pass is that look: twice a day it reads every live visit on the next
 * RAIN_DAYS dates, keeps the outdoor ones (rain-fit's classification, by
 * catalog identity) whose hourly chance of rain reaches MOVE_PCT from the
 * start of the work through RAIN_AFTER_HOURS after its end, and looks for a
 * dry, open hour on the same date.
 *
 * It only tells. Each wet visit gets ONE admin notification on the 'schedule'
 * channel, through raiseAdminAlert (docs/admin-notifications.md), naming the
 * chance and the dry hour it found; the link opens the visit, where a person
 * moves it with Quick Move. Nothing is moved and no customer is texted.
 *
 * Noise limits: outdoor work only; MOVE_PCT is above the booking ranking's
 * RAIN_PCT (in the wet season most afternoons read 60%); one notice per
 * visit at a given date and start (dedupeKey), so a forecast that goes back
 * and forth never rings twice; a visit that starts within LEAD_MINUTES is
 * left to storm-watch.js, which nudges the technician. Never throws.
 */
const logger = require('../logger');
const {
  rainFitFor, withCatalogKeys, storedVisitServices, widenToSpan, inRainHorizon, boundedHourlyRain,
  RAIN_AFTER_HOURS, RAIN_DAYS,
} = require('../scheduling/rain-fit');
const { etParts, etDateString, addETDays, parseETDateTime, formatETTime } = require('../../utils/datetime-et');

const GATE = 'GATE_AUTO_DISPATCH_RAIN_PASS';
const KEY_PREFIX = 'rain-pass:';
// A visit is wet at this chance; a target hour is dry below DRY_PCT.
const MOVE_PCT = 70;
const DRY_PCT = 40;
const LEAD_MINUTES = 120;
// 'rescheduled' rows wait for a new place: their date and window are stale.
const LIVE_STATUSES = ['pending', 'confirmed'];
const VISIT_COLUMNS = ['id', 'customer_id', 'property_id', 'lat', 'lng', 'service_type', 'service_key_snapshot',
  'visit_id', 'technician_id', 'status', 'scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes'];

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const dateOnly = (value) => (value instanceof Date ? etDateString(value) : String(value || '').slice(0, 10));

// The chance for every hour from `startMin` through RAIN_AFTER_HOURS after
// `endMin`: { peak, complete }. `complete` is false when any hour has no
// reading, so a caller never takes an unread hour for a dry one.
function spanRain(hourly, date, startMin, endMin) {
  let peak = null;
  if (!Array.isArray(hourly)) return { peak, complete: false };
  let complete = true;
  const lastMin = Math.min(24 * 60, endMin + RAIN_AFTER_HOURS * 60);
  for (let m = Math.floor(startMin / 60) * 60; m < lastMin; m += 60) {
    const key = `${date}T${String(Math.floor(m / 60)).padStart(2, '0')}`;
    const hour = hourly.find((h) => String(h.startTime).slice(0, 13) === key);
    if (!hour || !Number.isFinite(hour.rainChance)) complete = false;
    else if (peak == null || hour.rainChance > peak) peak = hour.rainChance;
  }
  return { peak, complete };
}

// The stop's reach on its date, in minutes: the stored window, or the visit's
// real length when that is longer (a two-hour treatment is stored with a
// one-hour window), widened to every service that shares the stop.
function stopSpan(visit, span) {
  const start = toMin(visit.window_start);
  if (start == null) return null;
  const length = Number(visit.estimated_duration_minutes);
  const end = Math.max(start + 60, toMin(visit.window_end) ?? 0, Number.isFinite(length) && length > 0 ? start + length : 0);
  const wide = widenToSpan({ start_time: toHHMM(start), end_time: toHHMM(Math.min(end, 24 * 60 - 1)) }, span);
  return { startMin: toMin(wide.start_time), endMin: Math.max(toMin(wide.end_time), toMin(wide.start_time) + 60), ownStartMin: start };
}

// The dry, open start on the same date that is nearest the visit's own
// start, or null. Dry: every hour of the moved stop and its drying time
// reads below DRY_PCT. Open: no other stop of that technician overlaps it.
// Today's targets start at least LEAD_MINUTES from now.
function dryStart({ hourly, date, reach, isFree, earliestMin, dayStartMin, dayEndMin }) {
  const before = reach.ownStartMin - reach.startMin;
  const length = reach.endMin - reach.startMin;
  let best = null;
  for (let own = dayStartMin; own + 60 <= dayEndMin; own += 60) {
    const start = own - before;
    if (own === reach.ownStartMin || start < dayStartMin || start + length > dayEndMin || own < earliestMin) continue;
    const rain = spanRain(hourly, date, start, start + length);
    if (!rain.complete || rain.peak >= DRY_PCT || !isFree(start, start + length)) continue;
    if (best == null || Math.abs(own - reach.ownStartMin) < Math.abs(best - reach.ownStartMin)) best = own;
  }
  return best;
}

// Live visits on the dates the forecast can read, one row per stop: services
// that share a stop (visit_id) move as one, so the earliest row stands for
// all of them.
async function loadStops(db, from, to) {
  const rows = await db('scheduled_services')
    .whereBetween('scheduled_date', [from, to])
    .whereIn('status', LIVE_STATUSES)
    .whereNotNull('customer_id')
    .whereNotNull('window_start')
    .select(...VISIT_COLUMNS)
    .orderBy(['scheduled_date', 'window_start', 'id']);
  const stops = new Map();
  for (const row of rows) {
    const key = row.visit_id ? `stop:${row.visit_id}` : `row:${row.id}`;
    if (stops.has(key)) stops.get(key).memberIds.push(String(row.id));
    else stops.set(key, { ...row, memberIds: [String(row.id)] });
  }
  return [...stops.values()];
}

// Every service at the stop, with its catalog identity, for rainFitFor.
async function stopServices(visit, db, deps) {
  const stored = await (deps.storedVisitServices || storedVisitServices)(visit.id, {}, db);
  const list = stored ? [...stored.own, ...stored.siblings]
    : [{ name: visit.service_type, key: visit.service_key_snapshot }];
  const services = await (deps.withCatalogKeys || withCatalogKeys)(
    list.map((item) => ({ name: item.name, serviceKey: item.key || null })), db, { gate: GATE },
  );
  return { services, span: stored?.span || null };
}

// One stop's verdict: { wet: false, reason } or { wet: true, peak, proposal }.
async function judgeStop(visit, ctx) {
  const { db, deps, today, nowMin, occupancy, day } = ctx;
  const date = dateOnly(visit.scheduled_date);
  if (!inRainHorizon(date, today)) return { wet: false, reason: 'past_horizon' };
  const { services, span } = await stopServices(visit, db, deps);
  if (rainFitFor(services) !== 'avoid') return { wet: false, reason: 'not_outdoor' };
  const reach = stopSpan(visit, span);
  if (!reach) return { wet: false, reason: 'no_window' };
  const earliestMin = date === today ? nowMin + LEAD_MINUTES : 0;
  if (reach.ownStartMin < earliestMin) return { wet: false, reason: 'too_soon' };
  const point = await deps.visitPoint(visit, { db, deps });
  if (!point) return { wet: false, reason: 'no_point' };
  const hourly = await (deps.hourlyRain || boundedHourlyRain)(point.lat, point.lng, true);
  const { peak } = spanRain(hourly, date, reach.startMin, reach.endMin);
  if (peak == null) return { wet: false, reason: 'no_forecast' };
  if (peak < MOVE_PCT) return { wet: false, reason: 'not_wet', peak };
  const isFree = (startMin, endMin) => !occupancy.conflicts(visit, date, startMin, endMin);
  const proposal = dryStart({ hourly, date, reach, isFree, earliestMin, dayStartMin: day.startMin, dayEndMin: day.endMin });
  return { wet: true, reason: 'wet', peak, proposal: proposal == null ? null : toHHMM(proposal) };
}

// The technician's other stops, from Rain Out's own occupancy probe (the one
// the Quick Move sheet warns with). A failed read answers "not free": the
// pass then names no hour rather than one it could not check.
async function loadDayOccupancy(from, to, deps) {
  try {
    const RainOut = deps.rainOut || require('../rain-out');
    const snapshot = await RainOut.loadOccupancy({ dateFrom: from, dateTo: to });
    return {
      conflicts: (visit, date, startMin, endMin) => RainOut.conflictsForTarget(
        snapshot, visit.id, date, { start: toHHMM(startMin), end: toHHMM(endMin) },
        { excludeServiceIds: visit.memberIds, technicianId: visit.technician_id },
      ).length > 0,
    };
  } catch (err) {
    logger.warn(`[rain-pass] occupancy read failed (no hour proposed): ${err.message}`);
    return { conflicts: () => true };
  }
}

function serviceDay(deps) {
  const { DAY_START_HOUR, DAY_END_HOUR } = deps.dayHours || require('../scheduling/find-time');
  return { startMin: DAY_START_HOUR * 60, endMin: DAY_END_HOUR * 60 };
}

/**
 * Read-only: every stop on the forecast dates with its verdict. Wet stops
 * first, highest chance first. `deps` stand in for the reads in unit tests.
 */
async function planRainPass({ now = new Date(), db, deps = {} } = {}) {
  const today = etDateString(now);
  const last = etDateString(addETDays(parseETDateTime(`${today}T12:00`), RAIN_DAYS - 1));
  const parts = etParts(now);
  const withDeps = { visitPoint: require('../call-booking-rain-flag').visitPoint, ...deps };
  const stops = await (deps.loadStops || loadStops)(db, today, last);
  const ctx = {
    db, deps: withDeps, today, nowMin: parts.hour * 60 + parts.minute,
    occupancy: await loadDayOccupancy(today, last, withDeps), day: serviceDay(withDeps),
  };
  const rows = [];
  for (const visit of stops) {
    let verdict;
    try {
      verdict = await judgeStop(visit, ctx);
    } catch (err) {
      logger.warn(`[rain-pass] visit ${visit.id} skipped: ${err.message}`);
      verdict = { wet: false, reason: 'error' };
    }
    rows.push({ visit, date: dateOnly(visit.scheduled_date), start: String(visit.window_start).slice(0, 5), ...verdict });
  }
  return rows.sort((a, b) => Number(b.wet) - Number(a.wet) || (b.peak ?? 0) - (a.peak ?? 0));
}

// The notice, by the shared composer: the customer's name in the headline, a
// spoken day and time in the why (no ISO date), a link that opens the visit.
async function sendNotice(row, { db, deps }) {
  const { raiseAdminAlert, cutAtWord, MAX_WHY_CHARS } = require('../admin-alert-compose');
  const { lookupCustomerName, fitAction } = require('../admin-alert-names');
  const { visit, date, start, peak, proposal } = row;
  const name = await (deps.customerName || lookupCustomerName)(db, visit.customer_id);
  const at = parseETDateTime(`${date}T${start}`);
  const spokenDay = at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }).replace(',', '');
  const service = String(visit.service_type || 'visit').replace(/\s+/g, ' ').trim();
  const dry = proposal ? `; ${formatETTime(parseETDateTime(`${date}T${proposal}`))} is dry and open` : '; no dry open hour that day';
  const tail = ` ${spokenDay} ${formatETTime(at)} has ${peak}% rain${dry}.`;
  return (deps.raiseAdminAlert || raiseAdminAlert)(
    'schedule',
    {
      area: 'Schedule',
      action: name
        ? fitAction('Schedule', name, [(who) => `move ${who}'s visit out of rain`, (who) => `check ${who}'s visit for rain`, (who) => `check ${who}'s visit`])
        : 'move a visit out of rain',
      // The service name gives up characters first; the day, time, chance and dry hour stay.
      why: `${cutAtWord(service, MAX_WHY_CHARS - tail.length)}${tail}`,
      severity: 'needs-you',
      link: `/admin/dispatch?tab=schedule&date=${encodeURIComponent(date)}&appointment=${encodeURIComponent(visit.id)}`,
      subject: { type: 'visit', id: String(visit.id) },
      doneWhen: 'visit_moved_or_done',
      who: 'person',
    },
    {
      // One notice per visit at this date and start: the same forecast read
      // again, or a forecast that dried and turned wet again, adds nothing.
      dedupeKey: `${KEY_PREFIX}${visit.id}:${date}:${start}`,
      detail: `${name || 'A customer'}: ${service} on ${date} at ${start}. `
        + `Hourly chance of rain reaches ${peak}% from the visit start through ${RAIN_AFTER_HOURS} hours after it ends. `
        + (proposal ? `${proposal} that day reads below ${DRY_PCT}% and no other stop is in it. ` : `No hour that day is both below ${DRY_PCT}% and open. `)
        + 'Nothing was moved and the customer was not contacted. Move it with Quick Move.',
      metadata: { scheduledServiceId: visit.id, rain_chance_pct: peak, scheduled_date: date, window_start: start, proposed_start: proposal },
    },
  );
}

/**
 * The cron entry. Resolves to { ran, checked, wet, noticed } (for logs and
 * tests); never rejects.
 */
async function runRainPass({ now = new Date(), db = require('../../models/db'), deps = {} } = {}) {
  try {
    const { gateEnvValue } = require('../../config/feature-gates');
    if (!gateEnvValue(GATE)) return { ran: false, reason: 'gate_off' };
    const rows = await planRainPass({ now, db, deps });
    const wet = rows.filter((row) => row.wet);
    let noticed = 0;
    for (const row of wet) {
      try {
        const result = await sendNotice(row, { db, deps });
        if (result && !result.deduped && !result.suppressed) noticed += 1;
      } catch (err) {
        logger.warn(`[rain-pass] notice for visit ${row.visit.id} failed: ${err.message}`);
      }
    }
    logger.info(`[rain-pass] checked=${rows.length} wet=${wet.length} noticed=${noticed}`);
    return { ran: true, checked: rows.length, wet: wet.length, noticed };
  } catch (err) {
    logger.warn(`[rain-pass] run skipped: ${err.message}`);
    return { ran: false, reason: 'error' };
  }
}

module.exports = { runRainPass, planRainPass, GATE, KEY_PREFIX, MOVE_PCT, DRY_PCT, _test: { spanRain, dryStart, stopSpan } };
