/**
 * Hourly route check, shadow (owner 2026-11-19, "do whatever you reccomend", page "Ad Budget Rule v2" D2 after the
 * Codex review: "recalculate the remaining route ... each hour a tech is clocked in, and the next three staffed days").
 *
 * Every hour from 7:30 AM to 7:30 PM ET (scheduler.js) it recalculates, from the live schedule, the rest of today's route
 * and every staffed day up to STAFFED_DAYS staffed days ahead (at least DEMAND_DAYS calendar days, for the 7-day demand
 * view), for each technician who works that day. It records one row in route_check_runs:
 *   - each opening that holds a new job and its drive (close-gaps SLOT_MIN), counted two ways: jobs dispatch can
 *     place (`slots`), and jobs a customer can book online (`online`: a start the customer booking rules admit, from
 *     customerWindowAdmits and the self-serve booking notice, clear of today's completed windows and the owner's
 *     interviews, Monday to Saturday, from the /book page's first day); while the occupancy check is tech-blind, a
 *     date's room is counted once across technicians, not per technician;
 *   - what the ad budget rule WOULD do (`ad_shadow`): full budget while an online-bookable opening exists today or in
 *     the next STAFFED_DAYS staffed days, the 1% floor when none, with the dispatch count beside it. It changes no
 *     budget. The online count is strict on purpose (a grid hour with the whole job slot after it); every opening's
 *     start, length and online starts are stored, so a looser rule can be recounted from the rows.
 * It measures only: nothing here changes a visit, a time, a budget or a message.
 * It runs every hour, not only while a technician is clocked in: no technician clocks in yet (time_entries had no row
 * in the 30 days to 2026-11-19). Today's figures come from the visits' own progress instead.
 *
 * Today: the van's place and clock come from the day's progress. The latest stop done (completed_at) or the stop on
 * site now (arrived_at plus its stay as the simulator charges it, co-visit siblings together, never earlier than now:
 * a job running long) sets them; with neither, the technician's start point at the day's departure minute. A stop on
 * site with no place leaves the day unmeasured. Only the stops not yet done are simulated, from the later of now and
 * that clock, so a cancellation, an expired hold or a long job shows at the next hour.
 * Future days: the day as booked, from the start point at the departure minute, the way the 04:40 re-plan measures it
 * (close-gaps openTime). Drive minutes come from the scheduling drive clock (no paid map call).
 *
 * Which tech-days count (the 07:05 notice's own rules, open-blocks-alert.js): an assignable technician who is not marked
 * absent (absences and weekly days off), on a day that is not a blackout day. A Sunday counts only when the technician
 * has a stop that day (today: done or still to do). Bounds are the night pass's working day (candidate-slots DAY_OPEN / DAY_CLOSE);
 * per-technician shift hours come with the shift-end build (page D4).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, etParts, addETDays } = require('../../utils/datetime-et');
const { _internals: replan } = require('./index');
const { SLOT_MIN, serviceBlocks, _internals: gaps } = require('./close-gaps');
const { simulate, coVisitGroups, coVisitMinutes } = require('./app-sim');
const { promisedWindowOrder, workDuration } = require('../route-reorder-window-fit');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const { CUSTOMER_GRID_MINUTES, customerWindowAdmits, refreshCustomerBookingWindowConfig } = require('../scheduling/customer-windows');
const { violatesSelfServeNotice } = require('../scheduling/self-serve-notice');
const { guardedCoordSelects } = require('../scheduling/day-stops');

const TABLE = 'route_check_runs';
const STAFFED_DAYS = 3;
const DEMAND_DAYS = 7;
// How far ahead to look for STAFFED_DAYS staffed days (a holiday week can close several in a row).
const SCAN_DAYS = 14;

const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const toMin = (value) => {
  const [h, m] = String(value).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

/** The ET minute of a timestamp, or null when it is not on `day` (ET). */
function etMinuteOn(value, day) {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || etDateString(at) !== day) return null;
  const p = etParts(at);
  return p.hour * 60 + p.minute;
}

const hasCoords = (row) => {
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  return row.lat != null && row.lng != null && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
};

/**
 * Where the van is and when it is free on `day` (pure). completed: the day's completed rows (one with no place is
 * ignored); onSite: the stops on site now, one per physical stop ({ arrived_at, stayMin, lat, lng }), busy until the
 * stay ends and never before now (a job running long). Returns { origin, clockMin, source }; source 'start_point' when
 * nothing is done or under way.
 */
function vanNow({ completed, onSite, home, departureMin, nowMin, day }) {
  const seen = [
    ...completed.filter(hasCoords).map((row) => ({ row, clockMin: etMinuteOn(row.completed_at, day), source: 'completed' })),
    ...onSite.map((row) => ({ row, clockMin: Math.max(nowMin, (etMinuteOn(row.arrived_at, day) ?? nowMin) + row.stayMin), source: 'on_site' })),
  ].filter((s) => s.clockMin != null);
  const best = seen.reduce((top, s) => (!top || s.clockMin > top.clockMin ? s : top), null);
  if (!best) return { origin: home, clockMin: departureMin, source: 'start_point' };
  return { origin: { lat: Number(best.row.lat), lng: Number(best.row.lng) }, clockMin: best.clockMin, source: best.source };
}

/**
 * The stops on site now, one per physical stop: co-visit siblings (one arrival) share one stay, charged the way the
 * simulator charges it (coVisitMinutes; one service = workDuration). rows: the live rows on site (with the co-visit
 * fields); arrivedById: row id -> arrived_at.
 */
function onSiteStays(rows, arrivedById) {
  return coVisitGroups(promisedWindowOrder(rows)).map((group) => {
    const arrivals = group.map((r) => arrivedById.get(String(r.id))).filter(Boolean).map((v) => new Date(v));
    return {
      lat: group[0].lat, lng: group[0].lng,
      arrived_at: arrivals.length ? new Date(Math.min(...arrivals.map((d) => d.getTime()))) : null,
      stayMin: group.length > 1 ? coVisitMinutes(group) : workDuration(group[0]),
    };
  });
}

const GRID = [...CUSTOMER_GRID_MINUTES].sort((a, b) => a - b);
// The customer's own visit inside a job slot: the median job (close-gaps SLOT_MIN = this job plus its drive). The
// booking paths test the visit, not the drive, against the day end (find-time.js customerWindowAdmits call).
const JOB_MIN = 60;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** A start list with no two closer than one job slot, earliest first (pure). */
function spaced(starts) {
  const out = [];
  for (const start of [...new Set(starts)].sort((a, b) => a - b)) if (!out.length || start >= out.at(-1) + SLOT_MIN) out.push(start);
  return out;
}

/**
 * The online booking test for one date at `now`, or null when the customer picker offers no day (a Sunday, find-time's
 * default). A start counts when the customer window rule admits the visit from it (customerWindowAdmits: the hour
 * grid, the customer last start, booking_config's day end) and it is outside the self-serve booking notice
 * (violatesSelfServeNotice, SELF_SERVE_NOTICE_HOURS). Read at call time.
 */
function onlineAdmit(day, now, busy = []) {
  if (weekday(day) === 0) return null;
  return (startMin) => customerWindowAdmits({ startMin, endMin: startMin + JOB_MIN })
    && !busy.some((b) => startMin < b.endMin && startMin + JOB_MIN > b.startMin)
    && !violatesSelfServeNotice({ date: day, startTime: hhmm(startMin) }, now);
}

/**
 * Every grid start in one opening that `admit` passes with a whole job slot inside the opening. Not spaced: the count
 * spaces them once, at the scope it counts (one technician, or a tech-blind date).
 */
function onlineStarts(block, admit) {
  if (!admit) return [];
  const end = block.startMin + block.min;
  return GRID.filter((start) => start >= block.startMin && start + SLOT_MIN <= end && admit(start));
}

/**
 * Dispatch jobs across several technicians' openings when one booking holds its time for all of them (pure): each job
 * fits wholly inside one opening and no two overlap in time. Earliest-finish placement, which is the largest count.
 */
function blindSlots(openings) {
  let cursor = -Infinity;
  let count = 0;
  for (;;) {
    const finishes = openings.map((o) => Math.max(o.start, cursor) + SLOT_MIN).filter((f, i) => f <= openings[i].start + openings[i].min);
    if (!finishes.length) return count;
    count += 1;
    cursor = Math.min(...finishes);
  }
}

const windowOf = (start, end) => ({ startMin: toMin(start), endMin: toMin(end) });

/**
 * What else holds time against an online booking on one date (the booking surfaces' own occupancy): today's completed
 * visits keep their booked windows (occupancy excludes only cancelled, skipped, no-show and rescheduled rows), this
 * technician's, an unassigned one's, or any while tech-blind; and the owner's booked interviews with their buffer
 * (interview-slots.js, the same read availability.js makes).
 */
function onlineBusy({ completed, techId, techBlind, interviews }) {
  const visits = completed
    .filter((p) => p.window_start && (p.technician_id == null || techBlind || String(p.technician_id) === String(techId)))
    .map((p) => {
      const startMin = toMin(p.window_start);
      return { startMin, endMin: p.window_end ? toMin(p.window_end) : startMin + (Number(p.estimated_duration_minutes) || 60) };
    });
  return [...visits, ...interviews.map((w) => windowOf(w.start, w.end))];
}

/**
 * The first date a customer can book online: today + booking_config.advance_days_min, the /book page's own bound
 * (booking.js validateBookingSlotDate, default 1 day). Read once per run; an unreadable row keeps that default.
 */
async function firstOnlineDay(conn, today) {
  try {
    const row = await conn('booking_config').first('advance_days_min');
    const min = Number(row?.advance_days_min);
    return dayAfter(today, Number.isInteger(min) && min >= 0 ? min : 1);
  } catch (err) {
    logger.warn(`[route-check] booking_config unread (${err.message}); online booking from tomorrow`);
    return dayAfter(today, 1);
  }
}

/** The owner's booked interviews on a date, best-effort like the booking surface: a failed read holds no time. */
async function interviewsOn(conn, day) {
  try {
    return await require('../interview-slots').bookedInterviewWindowsForDate(day, { conn });
  } catch (err) {
    logger.warn(`[route-check] ${day}: interviews unread (${err.message})`);
    return [];
  }
}

/** Why a tech-day cannot be simulated, or null. A stop with no time or no place leaves the day out. */
function unmeasurable(rows) {
  if (rows.some((r) => !r.window_start)) return 'UNTIMED_STOP';
  if (rows.some((r) => !hasCoords(r))) return 'STOP_WITHOUT_COORDINATES';
  return null;
}

/**
 * One tech-day's openings (pure). rows: the stops still to do, in any order (simulated in promised-window order, the
 * clock baseline); blocks: the technician's schedule blocks; held: hours other rows hold, as intervals.
 */
function measureTechDay({ rows, blocks, held, origin, departureMin, openMin, closeMin, admit }) {
  const skip = unmeasurable(rows);
  if (skip) return { stops: rows.length, skip };
  const sim = simulate(promisedWindowOrder(rows), { origin, departureMin, blockedIntervals: serviceBlocks(blocks) });
  if (!sim) return { stops: rows.length, skip: 'NO_SIMULATION' };
  const open = openMin < closeMin
    ? gaps.openBlocks(sim, { departureMin, openMin, closeMin, unavailable: [...blocks, ...held], driveBlocks: serviceBlocks(blocks) })
    : [];
  const openings = open.filter((b) => b.min >= SLOT_MIN).map((b) => {
    const starts = onlineStarts(b, admit);
    return { kind: b.kind, start: Math.round(b.startMin), min: Math.round(b.min), slots: Math.floor(b.min / SLOT_MIN), online: spaced(starts).length, starts };
  });
  return {
    stops: rows.length,
    driveMin: Math.round(sim.travelMin),
    endMin: Math.round(sim.serviceFinishMin),
    openings,
    slots: sum(openings, (o) => o.slots),
    online: sum(openings, (o) => o.online),
  };
}

/** The tech-day counts: workable (not a blackout, assignable, not absent), and a Sunday only with a stop booked. */
function staffed(elig, day, techId, hasStops) {
  if (elig.blackout.has(day) || !elig.techIds.includes(String(techId)) || elig.absent.has(`${techId}:${day}`)) return false;
  return weekday(day) !== 0 || hasStops;
}

const dayAfter = (today, n) => etDateString(addETDays(new Date(`${today}T12:00:00Z`), n));
const scanDates = (today) => Array.from({ length: SCAN_DAYS }, (_, i) => dayAfter(today, i + 1));

/**
 * The dates to measure (pure): today, every date through the STAFFED_DAYS-th staffed date after today, and at least
 * DEMAND_DAYS calendar days. A date is staffed when some technician counts on it. stopsOn: date -> the ids of the
 * technicians with a stop that day; only Sundays read it, so the caller loads the Sundays only.
 */
function datesToMeasure(elig, today, stopsOn) {
  const dates = [today];
  let found = 0;
  for (const [i, day] of scanDates(today).entries()) {
    if (found >= STAFFED_DAYS && i + 1 > DEMAND_DAYS) break;
    dates.push(day);
    const withStops = stopsOn.get(day) || new Set();
    if (elig.techIds.some((t) => staffed(elig, day, t, withStops.has(t)))) found += 1;
  }
  return dates;
}

/**
 * Totals and the ad rule's shadow decision from the measured tech-days (pure). techBlind (GATE_MULTI_TECH_CONFIRM
 * off): one booking holds its hour for every technician (scheduling/occupancy.js), so a date's room is counted once
 * across technicians: jobs that each fit one opening and never overlap (dispatch), and the date's starts spaced once
 * (online), not their sum.
 */
function summarize(days, today, { techBlind = false } = {}) {
  const counted = days.filter((d) => d.staffed && !d.skip);
  const staffedDates = [...new Set(days.filter((d) => d.staffed && d.date !== today).map((d) => d.date))].sort().slice(0, STAFFED_DAYS);
  const byDate = (list, fig) => sum([...new Set(list.map((d) => d.date))], (date) => fig(list.filter((d) => d.date === date).flatMap((d) => d.openings)));
  const pick = (filter) => {
    const list = counted.filter(filter);
    if (!techBlind) return { slots: sum(list, (d) => d.slots), online: sum(list, (d) => d.online) };
    return { slots: byDate(list, blindSlots), online: byDate(list, (openings) => spaced(openings.flatMap((o) => o.starts)).length) };
  };
  const todayFig = pick((d) => d.date === today);
  const next = pick((d) => staffedDates.includes(d.date));
  const lastDemand = dayAfter(today, DEMAND_DAYS);
  const week = pick((d) => d.date > today && d.date <= lastDemand);
  const ahead = todayFig.online + next.online;
  return {
    totals: { today: todayFig, next: { dates: staffedDates, ...next }, week: { through: lastDemand, ...week } },
    // slotsAhead: the same window by dispatch openings, so the rule can be judged both ways later.
    ad: {
      decision: ahead > 0 ? 'full' : 'floor', onlineAhead: ahead, slotsAhead: todayFig.slots + next.slots, techBlind,
      unmeasured: days.filter((d) => d.staffed && d.skip).length,
    },
  };
}

/**
 * Every Google Ads campaign's recorded status and budget mode, to compare the shadow decision with (null when
 * unreadable). Not only active ones: the local status lags Google until the next sync.
 */
async function liveAdModes(conn) {
  try {
    const rows = await conn('ad_campaigns').where({ platform: 'google_ads' }).select('id', 'status', 'budget_mode');
    return rows.map((r) => ({ id: r.id, status: r.status, mode: r.budget_mode }));
  } catch (err) {
    logger.warn(`[route-check] ad campaigns unread (${err.message})`);
    return null;
  }
}

/**
 * Today's stops done or on site, per technician (the van's progress): a completed stop's place, finish and booked
 * window, and an on-site stop's arrival (its other fields come from the live rows).
 */
async function loadProgress(conn, day) {
  return conn('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.scheduled_date', day)
    .whereIn('scheduled_services.status', ['completed', 'on_site'])
    .select('scheduled_services.id', 'scheduled_services.technician_id', 'scheduled_services.status',
      'scheduled_services.completed_at', 'scheduled_services.arrived_at', 'scheduled_services.window_start',
      'scheduled_services.window_end', 'scheduled_services.estimated_duration_minutes', ...guardedCoordSelects(conn));
}

async function eligibility(conn, from, to) {
  const { getBlackoutDates } = require('../scheduling/blackout-dates');
  const blackout = await getBlackoutDates(from, to, conn, { strict: true });
  const techs = await applyAssignable(conn('technicians')).select('technicians.id');
  const techIds = techs.map((t) => String(t.id));
  const absent = techIds.length ? await absentTechDays(conn, { dateFrom: from, dateTo: to, technicianIds: techIds }) : new Set();
  return { blackout, techIds, absent };
}

/** A date's live rows (the re-plan's own read: expired holds out), read once per run. */
function rowReader(conn) {
  const cache = new Map();
  return async (day) => {
    if (!cache.has(day)) cache.set(day, await replan.loadDayStops(conn, day));
    return cache.get(day);
  };
}

const techsWithStops = (rows) => new Set(rows.filter((r) => r.technician_id).map((r) => String(r.technician_id)));

/** One technician on one date: today from the van's progress, a later day as booked. Never throws. */
async function measureOne(conn, env, { day, techId, rows, progress, interviews }) {
  try {
    const own = rows.filter((r) => String(r.technician_id) === techId);
    const blocks = await replan.loadBlocks(conn, day, techId);
    const held = replan.blockedHoursFor(rows, techId, env.techBlind).map((h) => ({ startMin: h * 60, endMin: h * 60 + 60 }));
    const home = homeFromMap(env.homes, techId);
    const completed = day === env.today ? progress.filter((p) => p.status === 'completed') : [];
    const busy = onlineBusy({ completed, techId, techBlind: env.techBlind, interviews });
    const admit = day >= env.firstOnlineDay ? onlineAdmit(day, env.now, busy) : null;
    const common = { blocks, held, closeMin: DAY_CLOSE, admit };
    if (day !== env.today) {
      return measureTechDay({ ...common, rows: own, origin: home, departureMin: env.departureMin, openMin: DAY_OPEN });
    }
    // On site now: the van is there, so a stop with no place leaves the day unmeasured (never free time from home).
    const onSiteRows = own.filter((r) => r.status === 'on_site');
    if (onSiteRows.some((r) => !hasCoords(r))) return { stops: own.length, skip: 'ON_SITE_WITHOUT_COORDINATES' };
    const mine = progress.filter((p) => String(p.technician_id) === techId);
    const van = vanNow({
      completed: mine.filter((p) => p.status === 'completed'),
      onSite: onSiteStays(onSiteRows, new Map(mine.map((p) => [String(p.id), p.arrived_at]))),
      home, departureMin: env.departureMin, nowMin: env.nowMin, day,
    });
    const fig = measureTechDay({
      ...common, rows: own.filter((r) => r.status !== 'on_site'), origin: van.origin,
      departureMin: Math.max(env.nowMin, van.clockMin), openMin: Math.max(DAY_OPEN, env.nowMin),
    });
    return { ...fig, van: van.source };
  } catch (err) {
    logger.warn(`[route-check] ${day} tech ${techId}: measure failed (${err.message})`);
    return { skip: 'FAILED' };
  }
}

async function runRouteCheck({ conn = db, now = new Date() } = {}) {
  const today = etDateString(now);
  const p = etParts(now);
  const elig = await eligibility(conn, today, dayAfter(today, SCAN_DAYS));
  await refreshCustomerBookingWindowConfig(conn);
  const progress = await loadProgress(conn, today);
  const rowsOn = rowReader(conn);
  // A technician with a stop that day; today counts the stops already done too (a Sunday stays staffed after its last stop).
  const withStopsOn = async (day) => techsWithStops(day === today ? [...(await rowsOn(day)), ...progress] : await rowsOn(day));
  const stopsOn = new Map();
  for (const day of [today, ...scanDates(today)].filter((d) => weekday(d) === 0)) stopsOn.set(day, await withStopsOn(day));
  const env = {
    today,
    now,
    firstOnlineDay: await firstOnlineDay(conn, today),
    nowMin: p.hour * 60 + p.minute,
    homes: await loadTechStartPoints(conn),
    departureMin: await dayDepartureMinutes(conn),
    techBlind: !require('../scheduling/occupancy').techScopedConfirmActive(),
  };
  const days = [];
  for (const day of datesToMeasure(elig, today, stopsOn)) {
    const rows = await rowsOn(day);
    const withStops = await withStopsOn(day);
    const working = elig.techIds.filter((techId) => staffed(elig, day, techId, withStops.has(techId)));
    const interviews = working.length ? await interviewsOn(conn, day) : [];
    for (const techId of working) {
      days.push({ date: day, technician_id: techId, staffed: true, ...(await measureOne(conn, env, { day, techId, rows, progress, interviews })) });
    }
  }
  const { totals, ad } = summarize(days, today, { techBlind: env.techBlind });
  const status = days.some((d) => d.skip === 'FAILED') ? 'completed_with_errors' : 'completed';
  const adShadow = { ...ad, live: await liveAdModes(conn) };
  await conn(TABLE).insert({
    run_at: now, service_date: today, status, days: JSON.stringify(days), totals: JSON.stringify(totals), ad_shadow: JSON.stringify(adShadow),
  });
  logger.info(`[route-check] ${status}: today slots=${totals.today.slots} online=${totals.today.online}; next ${totals.next.dates.length} staffed days slots=${totals.next.slots} online=${totals.next.online}; ad=${ad.decision}`);
  return { status, totals, ad: adShadow, days: days.length };
}

module.exports = {
  runRouteCheck,
  _internals: {
    vanNow, onSiteStays, onlineAdmit, onlineStarts, onlineBusy, spaced, blindSlots, measureTechDay, staffed, datesToMeasure, summarize, unmeasurable,
    etMinuteOn, STAFFED_DAYS, DEMAND_DAYS,
  },
};
