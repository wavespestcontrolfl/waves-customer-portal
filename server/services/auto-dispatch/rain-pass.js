/**
 * Auto-dispatch rain pass (owner 2026-10-08, GATE_AUTO_DISPATCH_RAIN_PASS,
 * dark).
 *
 * The 04:10 auto-dispatch run never moves a visit inside 72 hours
 * (route-tiers.js), and the hourly rain forecast is only good for the next
 * RAIN_DAYS dates (rain-fit.js). So the run cannot see rain, and nothing
 * looked at a visit that was already booked when rain entered its forecast.
 * This pass is that look: every hour of the working day it reads every live visit on the next
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
 * and forth never rings twice while the notice stands; every run closes the
 * notices whose visit is no longer wet at that slot; at most MAX_NOTICES_PER_DAY new notices a day; a visit that starts within LEAD_MINUTES is
 * left to storm-watch.js, which nudges the technician. Never throws.
 */
const logger = require('../logger');
const {
  rainFitFor, withCatalogKeys, inRainHorizon, boundedHourlyRain,
  RAIN_AFTER_HOURS, RAIN_DAYS,
} = require('../scheduling/rain-fit');
const { etParts, etDateString, addETDays, parseETDateTime, formatETTime, dateOnlyString } = require('../../utils/datetime-et');

const GATE = 'GATE_AUTO_DISPATCH_RAIN_PASS';
const KEY_PREFIX = 'rain-pass:';
// A visit is wet at this chance; a target hour is dry below DRY_PCT.
const MOVE_PCT = 70;
const DRY_PCT = 40;
const LEAD_MINUTES = 120;
// docs/admin-notifications.md section 3: at most this many new notices an ET
// day, over every run of that day. The rest ring on a later day's run; a
// standing notice never uses the budget.
const MAX_NOTICES_PER_DAY = 10;
// 'rescheduled' rows wait for a new place: their date and window are stale.
// A NULL status is a live row too (rebooker.js, visit-groups.js).
const LIVE_STATUSES = ['pending', 'confirmed'];
// What the route model reads to build a physical stop and its minutes (the
// arrival-route.js column list: sequence, premise identity, planning-minute
// inputs), plus what this pass reads itself.
const VISIT_COLUMNS = ['id', 'customer_id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
  'estimated_duration_minutes', 'status', 'route_order', 'created_at', 'visit_id', 'time_window',
  'service_type', 'service_id', 'source_estimate_id',
  'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip',
  'reservation_service_mix', 'reservation_policy_version', 'is_recurring', 'is_callback',
  'property_id', 'lat', 'lng', 'service_key_snapshot'];

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
// that share a stop (visit_id) move as one. Only these live rows and their
// add-ons make the stop: a parked or closed sibling is not work at it.
async function loadStops(db, from, to) {
  const rows = await db('scheduled_services')
    .whereBetween('scheduled_date', [from, to])
    .where((q) => q.whereNull('status').orWhereIn('status', LIVE_STATUSES))
    .whereNotNull('customer_id')
    .whereNotNull('window_start')
    .select(...VISIT_COLUMNS)
    .orderBy(['scheduled_date', 'window_start', 'id']);
  const addOns = rows.length
    ? await db('scheduled_service_addons').whereIn('scheduled_service_id', rows.map((row) => row.id))
      .select('scheduled_service_id', 'service_name', 'service_key_snapshot')
    : [];
  return groupStops(rows, addOns);
}

// The day's rows as PHYSICAL stops, by the route model's own rule
// (route-model.js physicalStops): a visit_id group is one stop with its
// members' minutes added together, a legacy co-visit (same customer, window,
// premise and point, no visit_id) is one stop without a phantom hour, and
// each stop's minutes come from the route's duration rule. This pass adds
// only what it needs on top: every member's id and services, and the stop's
// reach on the clock.
function groupStops(rows, addOns = []) {
  const { physicalStops, stopPlanningMinutes } = require('./route-model');
  const days = new Map();
  for (const row of rows) {
    if (toMin(row.window_start) == null) continue;
    const key = `${dateOnly(row.scheduled_date)}|${row.technician_id || ''}`;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(row);
  }
  const servicesOf = (row) => [
    { name: row.service_type, serviceKey: row.service_key_snapshot || null },
    ...addOns.filter((a) => String(a.scheduled_service_id) === String(row.id))
      .map((a) => ({ name: a.service_name, serviceKey: a.service_key_snapshot || null })),
  ];
  const stops = [];
  for (const dayRows of days.values()) {
    const byId = new Map(dayRows.map((row) => [String(row.id), row]));
    for (const unit of physicalStops(dayRows)) {
      // The model names every row a stop stands for: a group's members, or
      // the rows it folded into a co-visit.
      const members = (unit.memberIds || unit.coIds).map((id) => byId.get(String(id))).filter(Boolean);
      // The stop's own row for the notice: its earliest member, then the
      // lowest id. Never the model's representative, which follows
      // route_order: a reorder of the day must not give the same stop a
      // second notice under another member's id.
      const anchor = [...members].sort((a, b) => toMin(a.window_start) - toMin(b.window_start) || (String(a.id) < String(b.id) ? -1 : 1))[0];
      const startMin = toMin(anchor.window_start);
      // The stop's minutes from its start, and never before a later member's own work is done.
      const endMin = Math.max(startMin + unit.minutes, ...members.map((m) => toMin(m.window_start) + stopPlanningMinutes(m)));
      stops.push({
        ...anchor,
        memberIds: members.map((m) => String(m.id)).sort(),
        services: members.flatMap(servicesOf),
        reach: { startMin, endMin: Math.min(24 * 60, endMin), ownStartMin: startMin },
      });
    }
  }
  return stops;
}

// One stop's verdict: { wet: false, reason } or { wet: true, peak, proposal }.
async function judgeStop(visit, ctx) {
  const { db, deps, today, nowMin, occupancy, day } = ctx;
  const date = dateOnly(visit.scheduled_date);
  if (!inRainHorizon(date, today)) return { wet: false, reason: 'past_horizon' };
  const services = await (deps.withCatalogKeys || withCatalogKeys)(visit.services, db, { gate: GATE });
  if (rainFitFor(services) !== 'avoid') return { wet: false, reason: 'not_outdoor' };
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

// Notices this pass rang today (ET), first rings and comebacks alike: what
// the day's budget has used. Each ring stamps its ET day on the row
// (`rang_on`); a comeback keeps the row's created_at, so that cannot count it.
async function noticesRaisedToday(db, now) {
  const [{ count }] = await db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [KEY_PREFIX])
    .whereRaw("metadata->>'rang_on' = ?", [etDateString(now)])
    .count('id as count');
  return Number(count) || 0;
}

// One key per physical stop at a date and start: the durable visit_id for a
// grouped stop (its members and their order can change), else the row's id.
const noticeKey = (row) => `${KEY_PREFIX}${row.visit.visit_id || row.visit.id}:${row.date}:${row.start}`;

// The notice, by the shared composer: the customer's name in the headline, a
// spoken day and time in the why (no ISO date), a link that opens the visit.
async function sendNotice(row, { db, deps, reopen = null, now = new Date() }) {
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
      // The one refresh that rings: a notice this pass closed, and whose
      // visit sits in rain at this slot again. `reopen` (set only for a key
      // with no standing notice) makes that refresh happen even when the
      // chance and the dry hour read the same as before.
      ringOnRefresh: (_existing, meta) => meta?.autoCleared === true,
      // Rings unless the owner turned the schedule category off (admin bell policy).
      bellDefault: true,
      ...(reopen ? { dedupeVersion: reopen } : {}),
      detail: `${name || 'A customer'}: ${service} on ${date} at ${start}. `
        + `Hourly chance of rain reaches ${peak}% from the visit start through ${RAIN_AFTER_HOURS} hours after it ends. `
        + (proposal ? `${proposal} that day reads below ${DRY_PCT}% and no other stop is in it. ` : `No hour that day is both below ${DRY_PCT}% and open. `)
        + 'Nothing was moved and the customer was not contacted. Move it with Quick Move.',
      metadata: { scheduledServiceId: visit.id, rain_chance_pct: peak, scheduled_date: date, window_start: start, proposed_start: proposal, autoCleared: false,
        // The central test-account suppression reads the customer from here.
        customerId: visit.customer_id,
        // Only a call that can ring stamps the day; a quiet rewrite keeps the row's own.
        ...(reopen ? { rang_on: etDateString(now) } : {}) },
    },
  );
}

// A verdict that says nothing about the rain: the forecast or the visit's
// point could not be read. Such a stop keeps the notice it has.
const UNKNOWN = new Set(['no_forecast', 'no_point', 'error']);

// The pass owns its notices from first ring to close (docs/admin-notifications.md
// section 2): every standing notice whose stop is not wet now is closed. That
// covers a forecast that dried, work that is no longer outdoor, and a visit
// that is no longer on that slot at all (moved, parked, cancelled, under way,
// done, date passed): such a visit is not in `rows`, or has another key. Only
// an unknown verdict keeps a notice. Returns the keys closed.
async function closeSettled(rows, standing, { episodes, db, now }) {
  // Under the threshold with an hour unread is not a dry reading either.
  const unread = (row) => UNKNOWN.has(row.reason) || (row.reason === 'not_wet' && row.dry !== true);
  const keep = new Set(rows.filter((row) => row.wet || unread(row)).map(noticeKey));
  const settled = [...standing].filter((key) => !keep.has(key));
  if (settled.length) {
    await episodes.closeAdminAlertKeys(db, settled, 'no_longer_in_rain', { now, resolution: 'Cleared: this visit is no longer outdoor work in rain at that time' });
  }
  return settled;
}

// One notice per wet stop. A standing notice is only rewritten; a new one
// (or one that rings again) needs room in the day's budget.
async function ringWet(wet, standing, budget, { db, deps, now }) {
  let noticed = 0;
  let deferred = 0;
  for (const row of wet) {
    const isStanding = standing.has(noticeKey(row));
    if (!isStanding && noticed >= budget) { deferred += 1; continue; }
    try {
      const result = await sendNotice(row, { db, deps, now, reopen: isStanding ? null : `run:${now.toISOString()}` });
      if (result && !result.suppressed && (!result.deduped || result.rung === true)) noticed += 1;
    } catch (err) {
      logger.warn(`[rain-pass] notice for visit ${row.visit.id} failed: ${err.message}`);
    }
  }
  return { noticed, deferred };
}

/**
 * The cron entry. Resolves to { ran, checked, wet, noticed, deferred, closed } (for logs and
 * tests); never rejects: a failed run resolves { ran: false, reason: 'error' }
 * and the scheduler turns that into a failed job.
 */
async function runRainPass({ now = new Date(), db = require('../../models/db'), deps = {} } = {}) {
  try {
    const { gateEnvValue } = require('../../config/feature-gates');
    if (!gateEnvValue(GATE)) return { ran: false, reason: 'gate_off' };
    const rows = await planRainPass({ now, db, deps });
    const wet = rows.filter((row) => row.wet);
    const episodes = deps.episodes || require('../admin-alert-episodes');
    // Standing: every notice of this pass that it has not closed.
    const standing = new Set(await episodes.openAdminAlertKeys(db, KEY_PREFIX));
    const dried = await closeSettled(rows, standing, { episodes, db, now });
    const budget = Math.max(0, MAX_NOTICES_PER_DAY - (wet.length ? await (deps.noticesRaisedToday || noticesRaisedToday)(db, now) : 0));
    const { noticed, deferred } = await ringWet(wet, standing, budget, { db, deps, now });
    if (deferred) logger.warn(`[rain-pass] day's notice budget hit (${MAX_NOTICES_PER_DAY}); ${deferred} wait for a later run`);
    logger.info(`[rain-pass] checked=${rows.length} wet=${wet.length} noticed=${noticed} deferred=${deferred} closed=${dried.length}`);
    return { ran: true, checked: rows.length, wet: wet.length, noticed, deferred, closed: dried.length };
  } catch (err) {
    logger.warn(`[rain-pass] run skipped: ${err.message}`);
    return { ran: false, reason: 'error', error: err.message };
  }
}

module.exports = { runRainPass, planRainPass, GATE, KEY_PREFIX, MOVE_PCT, DRY_PCT, MAX_NOTICES_PER_DAY, _test: { spanRain, dryStart, groupStops, VISIT_COLUMNS } };
