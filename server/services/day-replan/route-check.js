/**
 * Hourly route check, shadow (owner 2026-11-19, "do whatever you reccomend", page "Ad Budget Rule v2" D2 after the
 * Codex review: "recalculate the remaining route ... each hour a tech is clocked in, and the next three staffed days").
 *
 * Every hour from 7:30 AM to 7:30 PM ET (scheduler.js) it recalculates, from the live schedule, the rest of today's route
 * and every staffed day up to STAFFED_DAYS staffed days ahead (at least DEMAND_DAYS calendar days, for the 7-day demand
 * view), for each technician who works that day. It records one row in route_check_runs:
 *   - each opening that holds a new job and its drive (close-gaps SLOT_MIN), counted two ways: jobs dispatch can
 *     place (`slots`), and jobs a customer can book online (`online`: a start the /book page's own rules admit, clear
 *     of every booked span and the owner's interviews; see onlineAdmit); while the occupancy check
 *     is tech-blind, a date's room is counted once across technicians, not per technician;
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
const { occupiedRows } = require('../scheduling/visit-capacity');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
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
// The /book page's own slot rules (routes/booking.js, shared by its offer builder and its commit check).
const booking = () => require('../../routes/booking')._internals;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** A start list with no two closer than `gap` minutes (one online job), earliest first (pure). */
function spaced(starts, gap = SLOT_MIN) {
  const out = [];
  for (const start of [...new Set(starts)].sort((a, b) => a - b)) if (!out.length || start >= out.at(-1) + gap) out.push(start);
  return out;
}

/** Minutes one online job needs in an opening: the job slot, or the /book visit when that is longer. */
const onlineNeedMin = (config) => Math.max(SLOT_MIN, booking().resolveBookingDuration(undefined, config));

/**
 * True when /book may only add a visit after the route's last stop: capacity mode on and mid-route insertion off
 * (booking.js bookInsertionOffersLive: GATE_BOOK_CAPACITY_COMMIT with GATE_SCHEDULING_CAPACITY). Read at call time.
 */
const onlineAppendOnly = () => require('../scheduling/policy').capacityEnabled() && !booking().bookInsertionOffersLive();

/** True while the /book page takes bookings at all (GATE_SELF_BOOKING and booking_config.enabled, as /availability reads them). */
const selfBookingOpen = (config) => require('../../config/feature-gates').isEnabled('selfBooking') && config.enabled !== false;

/**
 * The online booking test for one date at `now`, or null when no customer can book the date online: self-booking
 * closed (selfBookingOpen), or a date the /book page refuses (validateBookingSlotDate: before today +
 * advance_days_min, default 1). /book offers weekends (includeWeekends), so a staffed Sunday counts. A start counts when the /book page would take the visit there: its slot
 * rules (validateBookingSlotGeometry: grid, booking_config day start and end, the shift while capacity mode is on), the
 * customer window rule (customerWindowAdmits: the hour grid, the customer last start, the customer close), the
 * self-serve booking notice (violatesSelfServeNotice), and no booked time (`busy`) under the visit. The visit is
 * the /book default length (resolveBookingDuration: slot_duration_minutes, else 60). Read at call time.
 */
function onlineAdmit(day, now, busy, config) {
  const rules = booking();
  if (!selfBookingOpen(config) || rules.validateBookingSlotDate(day, config, now)) return null;
  const visitMin = rules.resolveBookingDuration(undefined, config);
  return (startMin) => customerWindowAdmits({ startMin, endMin: startMin + visitMin })
    && !rules.validateBookingSlotGeometry({ startMin, duration: visitMin, config })
    && !busy.some((b) => startMin < b.endMin && startMin + visitMin > b.startMin)
    && !violatesSelfServeNotice({ date: day, startTime: hhmm(startMin) }, now);
}

/**
 * Every grid start in one opening that `admit` passes with `needMin` (one online job) inside the opening. Not spaced:
 * the count spaces them once, at the scope it counts (one technician, or a tech-blind date).
 */
function onlineStarts(block, admit, needMin = SLOT_MIN) {
  if (!admit) return [];
  const end = block.startMin + block.min;
  return GRID.filter((start) => start >= block.startMin && start + needMin <= end && admit(start));
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

/**
 * The booked time that holds against an online booking for one technician on one date: every occupying row's booked
 * span (visit-capacity occupiedRows: a version-2 allocation holds its whole combined span; completed visits keep their
 * windows, occupancy excludes only NOT_A_ROUTE_STOP_STATUSES), this technician's, an unassigned one's, or any while
 * tech-blind (scheduling/occupancy.js); and the owner's booked interviews with their buffer (interview-slots.js, the
 * read availability.js makes). Booked spans, not the simulated route: the booking surfaces test the windows.
 */
function onlineBusy({ occupancy, techId, techBlind, interviews }) {
  return [...bookedSpans(occupancy, techId, techBlind, { own: true }), ...interviews.map((w) => ({ startMin: toMin(w.start), endMin: toMin(w.end) }))];
}

/**
 * Booked spans in occupancy's scope for one technician (pure): an unassigned row's, any other technician's while
 * tech-blind, and with `own` this technician's too; each from occupiedRows (a version-2 allocation's combined span).
 */
function bookedSpans(occupancy, techId, techBlind, { own }) {
  const mine = (r) => r.technician_id != null && String(r.technician_id) === String(techId);
  const inScope = occupancy.filter((r) => r.window_start && (mine(r) ? own : (r.technician_id == null || techBlind)));
  return occupiedRows(inScope)
    .filter((r) => Number.isFinite(r.startMin) && Number.isFinite(r.endMin) && r.endMin > r.startMin)
    .map((r) => ({ startMin: r.startMin, endMin: r.endMin }));
}

/** Every row holding booked time on a date (completed included, expired holds out), with occupiedRows' fields. */
async function loadOccupancy(conn, day) {
  const { _internals: reorder } = require('../route-reorder');
  return conn('scheduled_services')
    .where('scheduled_services.scheduled_date', day)
    .whereNotIn('scheduled_services.status', NOT_A_ROUTE_STOP_STATUSES)
    .whereRaw(reorder.LIVE_HOLD_SQL)
    .select('scheduled_services.id', 'scheduled_services.technician_id', 'scheduled_services.customer_id',
      'scheduled_services.scheduled_date', 'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.estimated_duration_minutes', 'scheduled_services.reservation_service_mix');
}

/** The /book page's booking_config row, read once per run (no row: the page's own defaults, booking.js loadBookingConfig). */
async function bookingConfig(conn) {
  return (await conn('booking_config').first()) || {
    advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00', day_end: '18:00',
  };
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
function measureTechDay({ rows, blocks, held, origin, departureMin, openMin, closeMin, admit, needMin = SLOT_MIN, appendOnly = false }) {
  const skip = unmeasurable(rows);
  if (skip) return { stops: rows.length, skip };
  const sim = simulate(promisedWindowOrder(rows), { origin, departureMin, blockedIntervals: serviceBlocks(blocks) });
  if (!sim) return { stops: rows.length, skip: 'NO_SIMULATION' };
  const open = openMin < closeMin
    ? gaps.openBlocks(sim, { departureMin, openMin, closeMin, unavailable: [...blocks, ...held], driveBlocks: serviceBlocks(blocks) })
    : [];
  const openings = open.filter((b) => b.min >= SLOT_MIN).map((b) => {
    // Append-only /book: a customer can take only the time after the route's last stop.
    const starts = appendOnly && b.kind !== 'tail' ? [] : onlineStarts(b, admit, needMin);
    return { kind: b.kind, start: Math.round(b.startMin), min: Math.round(b.min), slots: Math.floor(b.min / SLOT_MIN), online: spaced(starts, needMin).length, starts };
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
function summarize(days, today, { techBlind = false, needMin = SLOT_MIN } = {}) {
  const counted = days.filter((d) => d.staffed && !d.skip);
  const staffedDates = [...new Set(days.filter((d) => d.staffed && d.date !== today).map((d) => d.date))].sort().slice(0, STAFFED_DAYS);
  const byDate = (list, fig) => sum([...new Set(list.map((d) => d.date))], (date) => fig(list.filter((d) => d.date === date).flatMap((d) => d.openings)));
  const pick = (filter) => {
    const list = counted.filter(filter);
    if (!techBlind) return { slots: sum(list, (d) => d.slots), online: sum(list, (d) => d.online) };
    return { slots: byDate(list, blindSlots), online: byDate(list, (openings) => spaced(openings.flatMap((o) => o.starts), needMin).length) };
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
 * Today's stops done or on site, per technician (the van's progress): a completed stop's place and finish, and an
 * on-site stop's arrival (its other fields come from the live rows).
 */
async function loadProgress(conn, day) {
  return conn('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.scheduled_date', day)
    .whereIn('scheduled_services.status', ['completed', 'on_site'])
    .select('scheduled_services.id', 'scheduled_services.technician_id', 'scheduled_services.status',
      'scheduled_services.completed_at', 'scheduled_services.arrived_at', ...guardedCoordSelects(conn));
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
async function measureOne(conn, env, { day, techId, rows, progress, occupancy, interviews }) {
  try {
    const own = rows.filter((r) => String(r.technician_id) === techId);
    const blocks = await replan.loadBlocks(conn, day, techId);
    // Time other rows hold for this technician: the re-plan's whole hours (blockedHoursFor) and the booked spans
    // (occupiedRows: a version-2 allocation's combined span, completed rows included).
    const held = [
      ...replan.blockedHoursFor(rows, techId, env.techBlind).map((h) => ({ startMin: h * 60, endMin: h * 60 + 60 })),
      ...bookedSpans(occupancy, techId, env.techBlind, { own: false }),
    ];
    const home = homeFromMap(env.homes, techId);
    const busy = onlineBusy({ occupancy, techId, techBlind: env.techBlind, interviews });
    const common = {
      blocks, held, closeMin: DAY_CLOSE, admit: onlineAdmit(day, env.now, busy, env.bookingConfig), needMin: env.needMin, appendOnly: env.appendOnly,
    };
    if (day !== env.today) {
      return measureTechDay({ ...common, rows: own, origin: home, departureMin: env.departureMin, openMin: DAY_OPEN });
    }
    // The progress read comes after the rows' read, so its status wins: a stop finished in between is done (never
    // simulated again), and one the technician reached in between is on site.
    const mine = progress.filter((p) => String(p.technician_id) === techId);
    const now = new Map(mine.map((p) => [String(p.id), p.status]));
    const live = own.filter((r) => now.get(String(r.id)) !== 'completed')
      .map((r) => (now.get(String(r.id)) === 'on_site' ? { ...r, status: 'on_site' } : r));
    // On site now: the van is there, so a stop with no place leaves the day unmeasured (never free time from home).
    const onSiteRows = live.filter((r) => r.status === 'on_site');
    if (onSiteRows.some((r) => !hasCoords(r))) return { stops: live.length, skip: 'ON_SITE_WITHOUT_COORDINATES' };
    const van = vanNow({
      completed: mine.filter((p) => p.status === 'completed'),
      onSite: onSiteStays(onSiteRows, new Map(mine.map((p) => [String(p.id), p.arrived_at]))),
      home, departureMin: env.departureMin, nowMin: env.nowMin, day,
    });
    const fig = measureTechDay({
      ...common, rows: live.filter((r) => r.status !== 'on_site'), origin: van.origin,
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
  const config = await bookingConfig(conn);
  await refreshCustomerBookingWindowConfig(conn);
  const rowsOn = rowReader(conn);
  // Today's rows first, then the progress: a stop finished between the two reads shows as done, never in neither.
  await rowsOn(today);
  const progress = await loadProgress(conn, today);
  // A technician with a stop that day; today counts the stops already done too (a Sunday stays staffed after its last stop).
  const withStopsOn = async (day) => techsWithStops(day === today ? [...(await rowsOn(day)), ...progress] : await rowsOn(day));
  const stopsOn = new Map();
  for (const day of [today, ...scanDates(today)].filter((d) => weekday(d) === 0)) stopsOn.set(day, await withStopsOn(day));
  const env = {
    today,
    now,
    bookingConfig: config,
    needMin: onlineNeedMin(config),
    appendOnly: onlineAppendOnly(),
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
    const occupancy = working.length ? await loadOccupancy(conn, day) : [];
    for (const techId of working) {
      days.push({ date: day, technician_id: techId, staffed: true, ...(await measureOne(conn, env, { day, techId, rows, progress, occupancy, interviews })) });
    }
  }
  const { totals, ad } = summarize(days, today, { techBlind: env.techBlind, needMin: env.needMin });
  const status = days.some((d) => d.skip === 'FAILED') ? 'completed_with_errors' : 'completed';
  const adShadow = { ...ad, selfBooking: selfBookingOpen(config), appendOnly: env.appendOnly, live: await liveAdModes(conn) };
  await conn(TABLE).insert({
    run_at: now, service_date: today, status, days: JSON.stringify(days), totals: JSON.stringify(totals), ad_shadow: JSON.stringify(adShadow),
  });
  logger.info(`[route-check] ${status}: today slots=${totals.today.slots} online=${totals.today.online}; next ${totals.next.dates.length} staffed days slots=${totals.next.slots} online=${totals.next.online}; ad=${ad.decision}`);
  return { status, totals, ad: adShadow, days: days.length };
}

module.exports = {
  runRouteCheck,
  _internals: {
    vanNow, onSiteStays, onlineAdmit, onlineStarts, onlineBusy, bookedSpans, onlineNeedMin, onlineAppendOnly, spaced, blindSlots, measureTechDay, staffed,
    datesToMeasure, summarize, unmeasurable,
    etMinuteOn, STAFFED_DAYS, DEMAND_DAYS,
  },
};
