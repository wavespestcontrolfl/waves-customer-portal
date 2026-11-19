/**
 * Hourly route check, shadow (owner 2026-11-19, "do whatever you reccomend", page "Ad Budget Rule v2" D2 after the
 * Codex review: "recalculate the remaining route ... each hour a tech is clocked in, and the next three staffed days").
 *
 * Every hour from 7:30 AM to 7:30 PM ET (scheduler.js) it recalculates, from the live schedule, the rest of today's route
 * and every staffed day up to STAFFED_DAYS staffed days ahead (at least DEMAND_DAYS calendar days, for the 7-day demand
 * view), for each technician who works that day. It records one row in route_check_runs:
 *   - each opening that holds a new job and its drive (close-gaps SLOT_MIN), counted two ways: jobs dispatch can
 *     place (`slots`), and jobs a customer can book online (`online`: an hour start on the customer grid, not past the
 *     customer last start, Monday to Saturday);
 *   - what the ad budget rule WOULD do (`ad_shadow`): full budget while an online-bookable opening exists today or in
 *     the next STAFFED_DAYS staffed days, the 1% floor when none, with the dispatch count beside it. It changes no
 *     budget. The online count is strict on purpose (a grid hour with the whole job slot after it); every opening's
 *     start and length are stored, so a looser rule can be recounted from the rows.
 * It measures only: nothing here changes a visit, a time, a budget or a message.
 * It runs every hour, not only while a technician is clocked in: no technician clocks in yet (time_entries had no row
 * in the 30 days to 2026-11-19). Today's figures come from the visits' own progress instead.
 *
 * Today: the van's place and clock come from the day's progress. The latest stop done (completed_at) or the stop on
 * site now (arrived_at plus its estimated minutes, never earlier than now: a job running long) sets them; with neither,
 * the technician's start point at the day's departure minute. Only the stops not yet done are simulated, from the later
 * of now and that clock, so a cancellation, an expired hold or a long job shows at the next hour.
 * Future days: the day as booked, from the start point at the departure minute, the way the 04:40 re-plan measures it
 * (close-gaps openTime). Drive minutes come from the scheduling drive clock (no paid map call).
 *
 * Which tech-days count (the 07:05 notice's own rules, open-blocks-alert.js): an assignable technician who is not marked
 * absent (absences and weekly days off), on a day that is not a blackout day. A Sunday counts only when the technician
 * already has a stop booked that day. Bounds are the night pass's working day (candidate-slots DAY_OPEN / DAY_CLOSE);
 * per-technician shift hours come with the shift-end build (page D4).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, etParts, addETDays } = require('../../utils/datetime-et');
const { _internals: replan } = require('./index');
const { SLOT_MIN, serviceBlocks, _internals: gaps } = require('./close-gaps');
const { simulate } = require('./app-sim');
const { promisedWindowOrder } = require('../route-reorder-window-fit');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const { CUSTOMER_GRID_MINUTES, pastCustomerLastStart } = require('../scheduling/customer-windows');
const { guardedCoordSelects } = require('../scheduling/day-stops');

const TABLE = 'route_check_runs';
const STAFFED_DAYS = 3;
const DEMAND_DAYS = 7;
// How far ahead to look for STAFFED_DAYS staffed days (a holiday week can close several in a row).
const SCAN_DAYS = 14;

const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
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
 * Where the van is and when it is free on `day`, from the day's progress rows (status completed or on_site, with
 * coordinates). Pure. Returns { origin, clockMin, source } with source 'start_point' when nothing is done yet.
 */
function vanNow({ progress, home, departureMin, nowMin, day }) {
  let best = null;
  for (const row of progress) {
    if (!hasCoords(row)) continue;
    const clockMin = row.status === 'on_site'
      ? Math.max(nowMin, (etMinuteOn(row.arrived_at, day) ?? nowMin) + (Number(row.estimated_duration_minutes) || 60))
      : etMinuteOn(row.completed_at, day);
    if (clockMin == null) continue;
    if (!best || clockMin > best.clockMin) best = { origin: { lat: Number(row.lat), lng: Number(row.lng) }, clockMin, source: row.status };
  }
  return best || { origin: home, clockMin: departureMin, source: 'start_point' };
}

const GRID = [...CUSTOMER_GRID_MINUTES].sort((a, b) => a - b);

/**
 * Online-bookable jobs in one opening (pure): hour starts on the customer grid (customer-windows.js) that are not past
 * the customer last start (GATE_CUSTOMER_LAST_START_16, read at call time), each with a full job slot inside the
 * opening and no overlap with the one before.
 */
function onlineSlots(block, onlineDay) {
  if (!onlineDay) return 0;
  const end = block.startMin + block.min;
  let count = 0;
  let next = block.startMin;
  for (const start of GRID) {
    if (start < next || start + SLOT_MIN > end || pastCustomerLastStart(start)) continue;
    count += 1;
    next = start + SLOT_MIN;
  }
  return count;
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
function measureTechDay({ rows, blocks, held, origin, departureMin, openMin, closeMin, onlineDay }) {
  const skip = unmeasurable(rows);
  if (skip) return { stops: rows.length, skip };
  const sim = simulate(promisedWindowOrder(rows), { origin, departureMin, blockedIntervals: serviceBlocks(blocks) });
  if (!sim) return { stops: rows.length, skip: 'NO_SIMULATION' };
  const open = openMin < closeMin
    ? gaps.openBlocks(sim, { departureMin, openMin, closeMin, unavailable: [...blocks, ...held], driveBlocks: serviceBlocks(blocks) })
    : [];
  const openings = open.filter((b) => b.min >= SLOT_MIN).map((b) => ({
    kind: b.kind, start: Math.round(b.startMin), min: Math.round(b.min),
    slots: Math.floor(b.min / SLOT_MIN), online: onlineSlots(b, onlineDay),
  }));
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

/** Totals and the ad rule's shadow decision from the measured tech-days (pure). */
function summarize(days, today) {
  const counted = days.filter((d) => d.staffed && !d.skip);
  const staffedDates = [...new Set(days.filter((d) => d.staffed && d.date !== today).map((d) => d.date))].sort().slice(0, STAFFED_DAYS);
  const pick = (filter) => {
    const list = counted.filter(filter);
    return { slots: sum(list, (d) => d.slots), online: sum(list, (d) => d.online) };
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
      decision: ahead > 0 ? 'full' : 'floor', onlineAhead: ahead, slotsAhead: todayFig.slots + next.slots,
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

/** Today's stops done or on site, per technician, with their place (the van's progress). */
async function loadProgress(conn, day) {
  return conn('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.scheduled_date', day)
    .whereIn('scheduled_services.status', ['completed', 'on_site'])
    .select('scheduled_services.technician_id', 'scheduled_services.status', 'scheduled_services.completed_at',
      'scheduled_services.arrived_at', 'scheduled_services.estimated_duration_minutes', ...guardedCoordSelects(conn));
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
async function measureOne(conn, env, { day, techId, rows, progress }) {
  try {
    const own = rows.filter((r) => String(r.technician_id) === techId);
    const blocks = await replan.loadBlocks(conn, day, techId);
    const held = replan.blockedHoursFor(rows, techId, env.techBlind).map((h) => ({ startMin: h * 60, endMin: h * 60 + 60 }));
    const home = homeFromMap(env.homes, techId);
    const common = { blocks, held, closeMin: DAY_CLOSE, onlineDay: weekday(day) !== 0 };
    if (day !== env.today) {
      return measureTechDay({ ...common, rows: own, origin: home, departureMin: env.departureMin, openMin: DAY_OPEN });
    }
    const van = vanNow({ progress: progress.filter((p) => String(p.technician_id) === techId), home, departureMin: env.departureMin, nowMin: env.nowMin, day });
    const departureMin = Math.max(env.nowMin, van.clockMin);
    const fig = measureTechDay({
      ...common, rows: own.filter((r) => r.status !== 'on_site'), origin: van.origin, departureMin, openMin: Math.max(DAY_OPEN, env.nowMin),
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
  const rowsOn = rowReader(conn);
  const stopsOn = new Map();
  for (const day of [today, ...scanDates(today)].filter((d) => weekday(d) === 0)) stopsOn.set(day, techsWithStops(await rowsOn(day)));
  const env = {
    today,
    nowMin: p.hour * 60 + p.minute,
    homes: await loadTechStartPoints(conn),
    departureMin: await dayDepartureMinutes(conn),
    techBlind: !require('../scheduling/occupancy').techScopedConfirmActive(),
  };
  const progress = await loadProgress(conn, today);
  const days = [];
  for (const day of datesToMeasure(elig, today, stopsOn)) {
    const rows = await rowsOn(day);
    const withStops = techsWithStops(rows);
    for (const techId of elig.techIds) {
      if (!staffed(elig, day, techId, withStops.has(techId))) continue;
      days.push({ date: day, technician_id: techId, staffed: true, ...(await measureOne(conn, env, { day, techId, rows, progress })) });
    }
  }
  const { totals, ad } = summarize(days, today);
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
  _internals: { vanNow, onlineSlots, measureTechDay, staffed, datesToMeasure, summarize, unmeasurable, etMinuteOn, STAFFED_DAYS, DEMAND_DAYS },
};
