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
 * and forth never rings twice while the notice stands; a notice whose visit
 * reads dry again is closed; at most MAX_NOTICES_PER_RUN new notices a run; a visit that starts within LEAD_MINUTES is
 * left to storm-watch.js, which nudges the technician. Never throws.
 */
const logger = require('../logger');
const {
  rainFitFor, withCatalogKeys, storedVisitServices, inRainHorizon, boundedHourlyRain,
  RAIN_AFTER_HOURS, RAIN_DAYS,
} = require('../scheduling/rain-fit');
const { etParts, etDateString, addETDays, parseETDateTime, formatETTime, dateOnlyString } = require('../../utils/datetime-et');

const GATE = 'GATE_AUTO_DISPATCH_RAIN_PASS';
const KEY_PREFIX = 'rain-pass:';
// A visit is wet at this chance; a target hour is dry below DRY_PCT.
const MOVE_PCT = 70;
const DRY_PCT = 40;
const LEAD_MINUTES = 120;
// docs/admin-notifications.md section 3: at most this many new notices a run.
// The rest ring on the next run; a standing notice never uses the budget.
const MAX_NOTICES_PER_RUN = 10;
// 'rescheduled' rows wait for a new place: their date and window are stale.
// A NULL status is a live row too (rebooker.js, visit-groups.js).
const LIVE_STATUSES = ['pending', 'confirmed'];
const VISIT_COLUMNS = ['id', 'customer_id', 'property_id', 'lat', 'lng', 'service_type', 'service_key_snapshot',
  'visit_id', 'technician_id', 'status', 'scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes'];

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
// A DATE column arrives as a Date at UTC midnight: its calendar date, not its ET day.
const dateOnly = (value) => String(dateOnlyString(value) || '');

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

// One service row's reach on its date, in minutes: the stored window, or
// the service's real length when that is longer (a two-hour treatment is
// stored with a one-hour window). null without a readable start.
function rowReach(row) {
  const start = toMin(row.window_start);
  if (start == null) return null;
  const length = Number(row.estimated_duration_minutes);
  const end = Math.max(start + 60, toMin(row.window_end) ?? 0, Number.isFinite(length) && length > 0 ? start + length : 0);
  return { startMin: start, endMin: Math.min(end, 24 * 60), workMin: Number.isFinite(length) && length > 0 ? length : end - start };
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
// that share a stop (visit_id) move as one.
async function loadStops(db, from, to) {
  const rows = await db('scheduled_services')
    .whereBetween('scheduled_date', [from, to])
    .where((q) => q.whereNull('status').orWhereIn('status', LIVE_STATUSES))
    .whereNotNull('customer_id')
    .whereNotNull('window_start')
    .select(...VISIT_COLUMNS)
    .orderBy(['scheduled_date', 'window_start', 'id']);
  return groupStops(rows);
}

// The earliest row stands for the stop (rows arrive in start order). The
// stop's reach covers every member's own window, and never less than the
// members' work added together from the stop's start: services on one stop
// are done one after the other, whatever their stored windows say (the sum
// visit-groups.js visitSummariesForRows and route-model.js use).
function groupStops(rows) {
  const stops = new Map();
  for (const row of rows) {
    const reach = rowReach(row);
    if (!reach) continue;
    const key = row.visit_id ? `stop:${row.visit_id}` : `row:${row.id}`;
    const stop = stops.get(key);
    if (!stop) {
      stops.set(key, { ...row, memberIds: [String(row.id)], reach: { ...reach, ownStartMin: reach.startMin } });
    } else {
      stop.memberIds.push(String(row.id));
      stop.reach.workMin += reach.workMin;
      stop.reach.endMin = Math.max(stop.reach.endMin, reach.endMin);
    }
  }
  for (const stop of stops.values()) {
    stop.reach.endMin = Math.min(24 * 60, Math.max(stop.reach.endMin, stop.reach.startMin + stop.reach.workMin));
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
  return services;
}

// One stop's verdict: { wet: false, reason } or { wet: true, peak, proposal }.
async function judgeStop(visit, ctx) {
  const { db, deps, today, nowMin, occupancy, day } = ctx;
  const date = dateOnly(visit.scheduled_date);
  if (!inRainHorizon(date, today)) return { wet: false, reason: 'past_horizon' };
  if (rainFitFor(await stopServices(visit, db, deps)) !== 'avoid') return { wet: false, reason: 'not_outdoor' };
  const { reach } = visit;
  const earliestMin = date === today ? nowMin + LEAD_MINUTES : 0;
  if (reach.ownStartMin < earliestMin) return { wet: false, reason: 'too_soon' };
  const point = await deps.visitPoint(visit, { db, deps });
  if (!point) return { wet: false, reason: 'no_point' };
  const hourly = await (deps.hourlyRain || boundedHourlyRain)(point.lat, point.lng, true);
  const { peak, complete } = spanRain(hourly, date, reach.startMin, reach.endMin);
  if (peak == null) return { wet: false, reason: 'no_forecast' };
  // `dry` only when every hour was read: a missing hour is not a dry one.
  if (peak < MOVE_PCT) return { wet: false, reason: 'not_wet', peak, dry: complete };
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

const noticeKey = (row) => `${KEY_PREFIX}${row.visit.id}:${row.date}:${row.start}`;

// The notice, by the shared composer: the customer's name in the headline, a
// spoken day and time in the why (no ISO date), a link that opens the visit.
async function sendNotice(row, { db, deps, reopen = null }) {
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
      // One notice per visit at this date and start: it rings once. A later
      // run that reads another chance or another dry hour rewrites the
      // standing notice without ringing, so the office never acts on an
      // hour that has since turned wet or been taken.
      dedupeKey: noticeKey(row),
      refreshOnDedupe: true,
      // The one refresh that rings: a notice this pass closed when the
      // forecast dried, and the rain is back. `reopen` (set only for a key
      // with no standing notice) makes that refresh happen even when the
      // chance and the dry hour read the same as before.
      ringOnRefresh: (_existing, meta) => meta?.autoCleared === true,
      ...(reopen ? { dedupeVersion: reopen } : {}),
      detail: `${name || 'A customer'}: ${service} on ${date} at ${start}. `
        + `Hourly chance of rain reaches ${peak}% from the visit start through ${RAIN_AFTER_HOURS} hours after it ends. `
        + (proposal ? `${proposal} that day reads below ${DRY_PCT}% and no other stop is in it. ` : `No hour that day is both below ${DRY_PCT}% and open. `)
        + 'Nothing was moved and the customer was not contacted. Move it with Quick Move.',
      metadata: { scheduledServiceId: visit.id, rain_chance_pct: peak, scheduled_date: date, window_start: start, proposed_start: proposal, autoCleared: false },
    },
  );
}

/**
 * The cron entry. Resolves to { ran, checked, wet, noticed, deferred, closed } (for logs and
 * tests); never rejects.
 */
async function runRainPass({ now = new Date(), db = require('../../models/db'), deps = {} } = {}) {
  try {
    const { gateEnvValue } = require('../../config/feature-gates');
    if (!gateEnvValue(GATE)) return { ran: false, reason: 'gate_off' };
    const rows = await planRainPass({ now, db, deps });
    const wet = rows.filter((row) => row.wet);
    const episodes = deps.episodes || require('../admin-alert-episodes');
    const standing = new Set(rows.length ? await episodes.openAdminAlertKeys(db, KEY_PREFIX) : []);
    // A standing notice whose visit now reads dry in every hour is closed:
    // the office must not move a visit for rain that left the forecast.
    const dried = rows.filter((row) => row.dry === true).map(noticeKey).filter((key) => standing.has(key));
    if (dried.length) {
      await episodes.closeAdminAlertKeys(db, dried, 'forecast_dry', { now, resolution: 'Cleared: the forecast for this visit is now dry' });
    }
    let noticed = 0;
    let deferred = 0;
    for (const row of wet) {
      // A standing notice is only rewritten; a new one needs room in the budget.
      const isStanding = standing.has(noticeKey(row));
      if (!isStanding && noticed >= MAX_NOTICES_PER_RUN) { deferred += 1; continue; }
      try {
        const result = await sendNotice(row, { db, deps, reopen: isStanding ? null : `run:${now.toISOString()}` });
        if (result && !result.suppressed && (!result.deduped || result.rung === true)) noticed += 1;
      } catch (err) {
        logger.warn(`[rain-pass] notice for visit ${row.visit.id} failed: ${err.message}`);
      }
    }
    if (deferred) logger.warn(`[rain-pass] notice budget hit (${MAX_NOTICES_PER_RUN}); ${deferred} wait for the next run`);
    logger.info(`[rain-pass] checked=${rows.length} wet=${wet.length} noticed=${noticed} deferred=${deferred} closed=${dried.length}`);
    return { ran: true, checked: rows.length, wet: wet.length, noticed, deferred, closed: dried.length };
  } catch (err) {
    logger.warn(`[rain-pass] run skipped: ${err.message}`);
    return { ran: false, reason: 'error' };
  }
}

module.exports = { runRainPass, planRainPass, GATE, KEY_PREFIX, MOVE_PCT, DRY_PCT, MAX_NOTICES_PER_RUN, _test: { spanRain, dryStart, groupStops } };
