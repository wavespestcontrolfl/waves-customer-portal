/**
 * Hourly route check, shadow (owner 2026-11-19, "do whatever you reccomend", page "Ad Budget Rule v2" D2 after the
 * Codex review: "recalculate the remaining route ... each hour a tech is clocked in, and the next three staffed days").
 *
 * Every hour from 7:30 AM to 7:30 PM ET (scheduler.js) it recalculates, from the live schedule, the rest of today's
 * route and every staffed day up to STAFFED_DAYS staffed days ahead (at least DEMAND_DAYS calendar days, for the 7-day
 * demand view), for each technician who works that day. It records one row in route_check_runs:
 *   - each opening that holds a new job and its drive (close-gaps SLOT_MIN), and the jobs dispatch can place there
 *     (`slots`: each starts on the hour, AGENTS.md; `noticeSlots`: the 07:05 notice's own whole-slot count, to compare).
 *     While the occupancy check is tech-blind (one booking holds its time for every technician), a date's room is the
 *     most any one technician can take: a lower bound, never a sum. Combining technicians comes with the second
 *     technician's shift build (page D4);
 *   - what the ad budget rule WOULD do (`ad_shadow`): full budget while dispatch room exists today or in the next
 *     STAFFED_DAYS staffed days, the 1% floor when none, and `unknown` when none is found but one of those days could
 *     not be measured. It changes no budget. Every opening's start and length are stored, so another rule can be
 *     recounted from the rows.
 * It measures only: nothing here changes a visit, a time, a budget or a message. What a customer could book online
 * (the /book page's own rules) is a separate follow-up measurement.
 * It runs every hour, not only while a technician is clocked in: no technician clocks in yet (time_entries had no row
 * in the 30 days to 2026-11-19). Today's figures come from the visits' own progress instead.
 *
 * Today: the van's place and clock come from the day's progress. The latest stop done (completed_at) or the stop on
 * site now (arrived_at plus its stay as the simulator charges it, a whole physical stop together, never earlier than
 * now: a job running long) sets them; with neither, the technician's start point at the day's departure minute. The
 * stop the technician is driving to (en_route) comes first. A stop on site with no place, or two stops on site or en
 * route at once, leave the day unmeasured. Only the stops not yet done are simulated, from the later of now and that clock, back to
 * the start point, so a cancellation, an expired hold or a long job shows at the next hour.
 * Future days: the day as booked, from the start point at the departure minute, the way the 04:40 re-plan measures it
 * (close-gaps openTime). Drive minutes come from the scheduling drive clock (no paid map call).
 *
 * Which tech-days count (the 07:05 notice's own rules, open-blocks-alert.js): an assignable technician who is not
 * marked absent (absences and weekly days off), on a day that is not a blackout day. A Sunday counts only when the
 * technician has a stop that day (today: done or still to do). Bounds are the night pass's working day (candidate-slots
 * DAY_OPEN / DAY_CLOSE); per-technician shift hours come with the shift-end build (page D4).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, etParts, addETDays } = require('../../utils/datetime-et');
const { _internals: replan } = require('./index');
const { SLOT_MIN, serviceBlocks, _internals: gaps } = require('./close-gaps');
const { simulate, coVisitGroups, coVisitMinutes } = require('./app-sim');
const { promisedWindowOrder, workDuration, currentOrder, staleOrderReasons, effectiveWindowRange } = require('../route-reorder-window-fit');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { guardedCoordSelects } = require('../scheduling/day-stops');

const TABLE = 'route_check_runs';
const STAFFED_DAYS = 3;
const DEMAND_DAYS = 7;
// How far ahead to look for STAFFED_DAYS staffed days (a holiday week can close several in a row).
const SCAN_DAYS = 14;
// A job slot's parts (close-gaps SLOT_MIN: the 60-minute median job and its added drive). The drive comes first, so
// the service can start on the hour (AGENTS.md).
const JOB_MIN = 60;
const DRIVE_MIN = SLOT_MIN - JOB_MIN;

const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const toMin = (value) => {
  const [h, m] = String(value).slice(0, 5).split(':').map(Number);
  return h * 60 + (m || 0);
};
const ceilHour = (min) => Math.ceil(min / 60) * 60;
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
 * Where the van is and when it is free on `day` (pure). completed: the day's completed rows; onSite: the stops on site now, one per physical stop ({ arrived_at, stayMin, workMin, lat, lng }: the
 * services not yet done, as the simulator charges them and as work alone). The van is at that stop since its arrival, so a service finished after the arrival was
 * done there: the rest starts then. Busy until the stay ends and never before now (a job running long). Returns
 * { origin, clockMin, source }; source 'start_point' when nothing is done or under way, 'unknown' (origin null)
 * when the latest stop done has no place or a stop done has no finish time today.
 */
function vanNow({ completed, onSite, home, departureMin, nowMin, day }) {
  // The latest stop done by its full timestamp (two in one minute: the later one), then its ET minute.
  const done = completed.filter((row) => etMinuteOn(row.completed_at, day) != null)
    .reduce((top, row) => (!top || new Date(row.completed_at) > new Date(top.completed_at) ? row : top), null);
  const lastDone = done ? etMinuteOn(done.completed_at, day) : -Infinity;
  // Busy until the stay as the simulator charges it from the arrival (a shared window counted once), and, when a
  // service of the stop finished after the arrival, until the work still to do after that finish.
  const onSiteClock = (row) => {
    const arrived = etMinuteOn(row.arrived_at, day) ?? nowMin;
    return Math.max(nowMin, arrived + row.stayMin, lastDone > arrived ? lastDone + row.workMin : -Infinity);
  };
  const seen = [
    ...(done ? [{ row: done, clockMin: lastDone, source: 'completed' }] : []),
    ...onSite.map((row) => ({ row, clockMin: onSiteClock(row), source: 'on_site' })),
  ];
  const best = seen.reduce((top, s) => (!top || s.clockMin > top.clockMin ? s : top), null);
  // A stop done with no finish time today: the van's last place and time are unknown, never home.
  if (completed.some((row) => etMinuteOn(row.completed_at, day) == null)) return { origin: null, clockMin: null, source: 'unknown' };
  if (!best) return { origin: home, clockMin: departureMin, source: 'start_point' };
  // The latest stop done has no place: the van's place is unknown (never an earlier customer's, never home).
  if (!hasCoords(best.row)) return { origin: null, clockMin: best.clockMin, source: 'unknown' };
  return { origin: { lat: Number(best.row.lat), lng: Number(best.row.lng) }, clockMin: best.clockMin, source: best.source };
}

const sameStopTuple = (a, b) => String(a.customer_id) === String(b.customer_id) && String(a.property_id || '') === String(b.property_id || '');

/**
 * The physical stops of a day's rows (pure), in promised-window order: each is a list of co-visit groups (app-sim
 * coVisitGroups). Groups of one visit (one visit_id, which promisedWindowOrder keeps adjacent) are one stop on
 * tracking's own boundary (visit-groups.js): same customer and property, and windows that form one connected chain.
 * A visit with a morning and an afternoon service is two stops, as tracking keeps them.
 */
function physicalStops(rows) {
  const { windowedMembersConnected } = require('../visit-groups');
  const stops = [];
  for (const group of coVisitGroups(promisedWindowOrder(rows))) {
    const last = stops.at(-1);
    const sofar = last ? last.flat() : [];
    const visitId = group[0].visit_id;
    const sameVisit = visitId != null && sofar.some((r) => r.visit_id != null && String(r.visit_id) === String(visitId))
      && group.every((r) => sofar.every((m) => sameStopTuple(r, m))) && windowedMembersConnected([...sofar, ...group]);
    if (sameVisit) last.push(group);
    else stops.push([group]);
  }
  return stops;
}

/** A physical stop's stay as the simulator charges it: each co-visit group's combined minutes, one after another. */
const stayOf = (stop) => sum(stop, (group) => (group.length > 1 ? coVisitMinutes(group) : workDuration(group[0])));

/**
 * The stops on site now, from physical stops and row id -> arrived_at: { arrived_at, stayMin (as the simulator
 * charges it, a shared window's floor included), workMin (the services' own minutes, no window floor), lat, lng }.
 */
function onSiteStays(stops, arrivedById) {
  return stops.map((stop) => {
    const rows = stop.flat();
    const arrivals = rows.map((r) => arrivedById.get(String(r.id))).filter(Boolean).map((v) => new Date(v).getTime());
    return {
      lat: rows[0].lat, lng: rows[0].lng, arrived_at: arrivals.length ? new Date(Math.min(...arrivals)) : null,
      stayMin: stayOf(stop), workMin: sum(rows, (r) => workDuration({ ...r, window_end: null })),
    };
  });
}

/**
 * Jobs that fit one opening (pure): for each, the drive, then a JOB_MIN service that starts on the hour, inside the
 * opening. driveFrom: when the first drive may begin, earlier than the opening for the day's first opening (the van
 * leaves at its departure minute; the working day bounds the service, not the drive).
 */
function hourSlots(o, { driveFrom = o.start } = {}) {
  let count = 0;
  const end = o.start + o.min;
  for (let at = ceilHour(Math.max(o.start, Math.min(driveFrom, o.start) + DRIVE_MIN)); at + JOB_MIN <= end; at = ceilHour(at + JOB_MIN + DRIVE_MIN)) count += 1;
  return count;
}

/**
 * The order the technician drives (pure), the app's own rule (arrival-route.js, the 04:40 re-plan's stored baseline):
 * the stored route_order when it is a real plan (staleOrderReasons finds none; today may resume past its first
 * numbers), else each physical stop at its own promised start, each stop's rows together.
 */
function routeOrder(rows, { today = false } = {}) {
  if (rows.length && !staleOrderReasons(rows, rows, { futureDay: !today }).length) return currentOrder(rows);
  const startOf = (stop) => Math.min(...stop.flat().map((r) => promisedStart(r) ?? Infinity));
  return physicalStops(rows).map((stop, i) => ({ stop, i })).sort((a, b) => startOf(a.stop) - startOf(b.stop) || a.i - b.i)
    .flatMap(({ stop }) => stop.flat());
}

/**
 * Booked time that holds one technician (pure), from the booking surfaces' own occupancy read: the technician's own
 * rows (a stop done early still holds its booked window), unassigned rows, and every other technician's while
 * tech-blind (scheduling/occupancy.js). Each span is as listOccupiedWindows gives it (a version-2 allocation's
 * combined span, a live make-room hold's destination hours).
 */
function heldSpans(occupancy, techId, techBlind) {
  const mine = (r) => r.technician_id != null && String(r.technician_id) === String(techId);
  return occupancy.filter((r) => mine(r) || r.technician_id == null || techBlind)
    .filter((r) => Number.isFinite(r.startMin) && Number.isFinite(r.endMin) && r.endMin > r.startMin)
    .map((r) => ({ startMin: r.startMin, endMin: r.endMin }));
}

/**
 * Every span holding booked time on a date: the offer side's own read (completed rows in, expired holds out), and
 * the owner's booked interviews with their buffers (interview-slots.js), which dispatch also refuses to book over;
 * an interview holds every technician's time (no technician_id). A failed read throws: the caller marks the date.
 */
async function loadOccupancy(conn, day) {
  const visits = await require('../scheduling/occupancy').listOccupiedWindows({ db: conn, dateFrom: day, dateTo: day });
  const interviews = await require('../interview-slots').bookedInterviewWindowsForDate(day, { conn });
  return [
    ...visits,
    ...interviews.map((w) => ({ id: `interview:${w.applicationId}`, technician_id: null, startMin: toMin(w.start), endMin: toMin(w.end) })),
  ];
}

/**
 * The day's departure minute, read strictly: with the day rules on, a failed read throws (the run is then recorded
 * as unknown) instead of the 08:00 guess dayDepartureMinutes falls back to. Gate off: the legacy 08:00, as before.
 */
async function departureMinutes(conn) {
  const departure = require('../scheduling/departure-time');
  if (require('../../config/feature-gates').autoDispatchDayRulesLive() !== true) return departure.LEGACY_DEPARTURE_MINUTES;
  return departure.effectiveDepartureMinutes(await departure.readDepartureSetting(conn));
}

/** A stop's promised start minute (the shared resolver: window_start, or a legacy time_window), or null. */
const promisedStart = (row) => {
  const start = (row.arrivalRange || effectiveWindowRange(row))?.startMin;
  return Number.isFinite(start) ? start : null;
};

/** Why a tech-day cannot be simulated, or null. A stop with no promised time or no place leaves the day out. */
function unmeasurable(rows) {
  if (rows.some((r) => promisedStart(r) == null)) return 'UNTIMED_STOP';
  if (rows.some((r) => !hasCoords(r))) return 'STOP_WITHOUT_COORDINATES';
  return null;
}

/**
 * One tech-day's openings (pure). rows: the stops still to do, in any order (simulated in promised-window order, the
 * clock baseline), after `first` (the stop the van is driving to now: no opening before it, since a job there would
 * go ahead of that customer); blocks: the technician's schedule blocks; held: booked time, as intervals; origin:
 * where the van sets off; end: where it returns (the start point); the rest run in the order the technician drives
 * (routeOrder). slots: jobs that start on the hour after their drive (hourSlots);
 * noticeSlots: the 07:05 notice's own count (close-gaps: whole SLOT_MIN slots), so the two can be compared.
 */
function measureTechDay({ rows, first = [], blocks, held, origin, end = origin, departureMin, openMin, closeMin, today = false }) {
  const all = [...first, ...rows];
  const skip = unmeasurable(all);
  if (skip) return { stops: all.length, skip };
  const seq = [...first, ...routeOrder(rows, { today })];
  const sim = simulate(seq, { origin, end, departureMin, blockedIntervals: serviceBlocks(blocks) });
  if (!sim) return { stops: all.length, skip: 'NO_SIMULATION' };
  const open = openMin < closeMin
    ? gaps.openBlocks(sim, { departureMin, openMin, closeMin, unavailable: [...blocks, ...held], driveBlocks: serviceBlocks(blocks) })
    : [];
  // Kept: an opening that holds a job either way. The one at the start of the working day may begin its drive at the
  // departure minute, before the day, so it can hold a job in under SLOT_MIN.
  // The early drive uses the free minutes between the departure (or a block or booking) and the opening.
  const driveFrom = (o) => {
    if (!(o.start <= openMin && departureMin < o.start)) return o.start;
    // From the end of the last block or booking before the opening: only the free minutes right before it count.
    const busyEnd = [...blocks, ...held].filter((b) => b.startMin < o.start && b.endMin > departureMin)
      .reduce((end, b) => Math.max(end, b.endMin), departureMin);
    return Math.min(o.start, busyEnd);
  };
  const openings = open.filter((b) => !(first.length && b.kind === 'start'))
    .map((b) => ({ kind: b.kind, start: Math.round(b.startMin), min: Math.round(b.min) }))
    .map((o) => ({ ...o, slots: hourSlots(o, { driveFrom: driveFrom(o) }), noticeSlots: Math.floor(o.min / SLOT_MIN) }))
    .filter((o) => o.slots > 0 || o.noticeSlots > 0);
  return {
    stops: all.length,
    driveMin: Math.round(sim.travelMin),
    endMin: Math.round(sim.serviceFinishMin),
    openings,
    slots: sum(openings, (o) => o.slots),
    noticeSlots: sum(openings, (o) => o.noticeSlots),
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
 * technicians with a stop that day, or null when the read failed; only Sundays read it, so the caller loads the
 * Sundays only.
 */
function datesToMeasure(elig, today, stopsOn) {
  const dates = [today];
  let found = 0;
  for (const [i, day] of scanDates(today).entries()) {
    if (found >= STAFFED_DAYS && i + 1 > DEMAND_DAYS) break;
    dates.push(day);
    // A Sunday whose read failed counts as staffed: its room is then unknown (FAILED), never left out.
    const withStops = stopsOn.get(day);
    if (elig.techIds.some((t) => staffed(elig, day, t, withStops === null || Boolean(withStops && withStops.has(t))))) found += 1;
  }
  return dates;
}

/**
 * Totals and the ad rule's shadow decision from the measured tech-days (pure). techBlind (GATE_MULTI_TECH_CONFIRM
 * off): one booking holds its time for every technician (scheduling/occupancy.js), so a date's room is the most any
 * one technician can take (each technician's count already holds the others' booked time), never the sum.
 */
function summarize(days, today, { techBlind = false } = {}) {
  const counted = days.filter((d) => d.staffed && !d.skip);
  const staffedDates = [...new Set(days.filter((d) => d.staffed && d.date !== today).map((d) => d.date))].sort().slice(0, STAFFED_DAYS);
  const slotsOf = (list) => {
    if (!techBlind) return sum(list, (d) => d.slots);
    const dates = [...new Set(list.map((d) => d.date))];
    return sum(dates, (date) => Math.max(...list.filter((d) => d.date === date).map((d) => d.slots)));
  };
  const pick = (filter) => ({ slots: slotsOf(counted.filter(filter)) });
  const todayFig = pick((d) => d.date === today);
  const next = pick((d) => staffedDates.includes(d.date));
  const lastDemand = dayAfter(today, DEMAND_DAYS);
  const week = pick((d) => d.date > today && d.date <= lastDemand);
  const ahead = todayFig.slots + next.slots;
  // A staffed day in the rule's window (today and the next staffed days) that could not be measured, or a scan that
  // found fewer than STAFFED_DAYS staffed days (a long closure): with no room found, the room is unknown, never a
  // measured floor.
  const unmeasured = days.filter((d) => d.staffed && d.skip && (d.date === today || staffedDates.includes(d.date))).length;
  let decision = 'floor';
  if (ahead > 0) decision = 'full';
  else if (unmeasured || staffedDates.length < STAFFED_DAYS) decision = 'unknown';
  return {
    totals: { today: todayFig, next: { dates: staffedDates, ...next }, week: { through: lastDemand, ...week } },
    ad: { decision, slotsAhead: ahead, techBlind, unmeasured },
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
 * Today's stops done, on site or en route, per technician (the van's progress): a completed stop's place and finish,
 * an on-site stop's arrival, and when the van set off for the stop en route (its other fields come from the live rows). Finish and arrival follow the completion
 * writer's own precedence (service-duration-capture.js): the dispatch end/start fields first, then the tracker's,
 * so a completion whose tracker update failed still has its finish.
 */
async function loadProgress(conn, day) {
  const { firstFiniteDate } = require('../../utils/service-duration-capture');
  const rows = await conn('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.scheduled_date', day)
    .whereIn('scheduled_services.status', ['completed', 'on_site', 'en_route'])
    .select('scheduled_services.id', 'scheduled_services.technician_id', 'scheduled_services.status',
      'scheduled_services.completed_at', 'scheduled_services.actual_end_time', 'scheduled_services.check_out_time',
      'scheduled_services.arrived_at', 'scheduled_services.actual_start_time', 'scheduled_services.check_in_time',
      'scheduled_services.en_route_at', ...guardedCoordSelects(conn));
  return rows.map((r) => ({
    id: r.id, technician_id: r.technician_id, status: r.status, lat: r.lat, lng: r.lng, en_route_at: r.en_route_at,
    completed_at: firstFiniteDate(r.actual_end_time, r.check_out_time, r.completed_at),
    arrived_at: firstFiniteDate(r.actual_start_time, r.check_in_time, r.arrived_at),
  }));
}

async function eligibility(conn, from, to) {
  const { getBlackoutDates } = require('../scheduling/blackout-dates');
  const blackout = await getBlackoutDates(from, to, conn, { strict: true });
  const techs = await applyAssignable(conn('technicians')).select('technicians.id');
  const techIds = techs.map((t) => String(t.id));
  const absent = techIds.length ? await absentTechDays(conn, { dateFrom: from, dateTo: to, technicianIds: techIds }) : new Set();
  return { blackout, techIds, absent };
}

// Today's stops and their progress read as of one moment (the FINAL_CHECK_SNAPSHOT pattern, visit-prep.js).
const TODAY_SNAPSHOT = { isolationLevel: 'repeatable read', readOnly: true };

/**
 * Today's rows and progress from one consistent snapshot, so a stop finished, cancelled or moved between two reads
 * shows the same in both. Either read failing returns nulls (today is then FAILED). A transaction or a test double
 * reads on its own connection.
 */
async function readToday(conn, today) {
  const read = async (c) => ({ rows: await replan.loadDayStops(c, today), progress: await loadProgress(c, today) });
  try {
    if (typeof conn.transaction !== 'function' || conn.isTransaction) return await read(conn);
    return await conn.transaction((trx) => read(trx), TODAY_SNAPSHOT);
  } catch (err) {
    logger.warn(`[route-check] ${today}: today's read failed (${err.message})`);
    return { rows: null, progress: null };
  }
}

/**
 * A date's live rows (the re-plan's own read: expired holds out), read once per run; null when the read failed.
 * seed: rows already read (today's, from the snapshot).
 */
function rowReader(conn, seed = new Map()) {
  const cache = new Map(seed);
  return async (day) => {
    if (!cache.has(day)) {
      try {
        cache.set(day, await replan.loadDayStops(conn, day));
      } catch (err) {
        logger.warn(`[route-check] ${day}: stops read failed (${err.message})`);
        cache.set(day, null);
      }
    }
    return cache.get(day);
  };
}

const techsWithStops = (rows) => new Set(rows.filter((r) => r.technician_id).map((r) => String(r.technician_id)));

/**
 * Today for one technician: the stops still to do, split into the physical stop on site now, the one the van is
 * driving to, and the rest. The progress read comes after the rows' read, so its status wins by id: a stop finished in
 * between is done (never simulated again), one reached in between is on site (or en route). A physical stop is on site (or en
 * route) when any of its rows is: tracking moves rows one at a time.
 */
function todaysStops(own, mine) {
  const now = new Map(mine.map((p) => [String(p.id), p.status]));
  const live = own.filter((r) => now.get(String(r.id)) !== 'completed')
    .map((r) => (['on_site', 'en_route'].includes(now.get(String(r.id))) ? { ...r, status: now.get(String(r.id)) } : r));
  const stops = physicalStops(live);
  const has = (stop, status) => stop.flat().some((r) => r.status === status);
  const onSite = stops.filter((s) => has(s, 'on_site'));
  const enRoute = stops.filter((s) => !onSite.includes(s) && has(s, 'en_route'));
  const rest = stops.filter((s) => !onSite.includes(s) && !enRoute.includes(s));
  return { live, onSite, enRoute, rest: rest.flatMap((s) => s.flat()) };
}

/**
 * When today's simulation sets off. En route: the van left at en_route_at, so the drive under way is credited, but
 * the van reaches the stop no earlier than now (a drive running long): it departs at the latest of its clock, when
 * it set off, and now less the drive. Otherwise: the later of now and the van's clock.
 */
function enRouteDeparture({ first, mine, van, origin, nowMin, day }) {
  const setOff = first.map((r) => etMinuteOn(mine.find((p) => String(p.id) === String(r.id))?.en_route_at, day)).filter((m) => m != null);
  if (!first.length || !setOff.length) return Math.max(nowMin, van.clockMin);
  const leg = simulate(first.slice(0, 1), { origin, departureMin: 0 });
  const driveMin = leg?.arrivals?.[0]?.driveMin ?? 0;
  return Math.max(van.clockMin, Math.min(nowMin, ...setOff), nowMin - driveMin);
}

/** One technician on one date: today from the van's progress, a later day as booked. Never throws. */
async function measureOne(conn, env, { day, techId, rows, progress, occupancy }) {
  try {
    const own = rows.filter((r) => String(r.technician_id) === techId);
    const blocks = await replan.loadBlocks(conn, day, techId);
    // Time held for this technician: every booked span the booking surfaces count, exact to the minute
    // (listOccupiedWindows: completed rows and make-room destinations included; a window may end off the hour).
    const held = heldSpans(occupancy, techId, env.techBlind);
    const home = homeFromMap(env.homes, techId);
    const common = { blocks, held, closeMin: DAY_CLOSE };
    if (day !== env.today) {
      return measureTechDay({ ...common, rows: own, origin: home, departureMin: env.departureMin, openMin: DAY_OPEN });
    }
    if (!progress) return { stops: own.length, skip: 'FAILED' };
    const mine = progress.filter((p) => String(p.technician_id) === techId);
    // A stop put on site or en route for this technician after the rows' read: its place and length are not in hand.
    const ownIds = new Set(own.map((r) => String(r.id)));
    const active = (p) => p.status === 'on_site' || p.status === 'en_route';
    if (mine.some((p) => active(p) && !ownIds.has(String(p.id)))) return { stops: own.length, skip: 'ACTIVE_STOP_NOT_IN_ROUTE' };
    const { live, onSite, enRoute, rest } = todaysStops(own, mine);
    // The van is at the stop on site, so one with no place leaves the day unmeasured (never free time from home).
    if (onSite.flat(2).some((r) => !hasCoords(r))) return { stops: live.length, skip: 'ON_SITE_WITHOUT_COORDINATES' };
    // The statuses must name one place for the van: never two stops on site, two en route, or one of each.
    if (onSite.length > 1) return { stops: live.length, skip: 'SEVERAL_ON_SITE' };
    if (enRoute.length > 1) return { stops: live.length, skip: 'SEVERAL_EN_ROUTE' };
    if (onSite.length && enRoute.length) return { stops: live.length, skip: 'ON_SITE_AND_EN_ROUTE' };
    const van = vanNow({
      completed: mine.filter((p) => p.status === 'completed'),
      onSite: onSiteStays(onSite, new Map(mine.map((p) => [String(p.id), p.arrived_at]))),
      home, departureMin: env.departureMin, nowMin: env.nowMin, day,
    });
    if (!van.origin) return { stops: live.length, skip: van.clockMin == null ? 'COMPLETION_WITHOUT_TIME' : 'LAST_STOP_WITHOUT_COORDINATES' };
    const first = enRoute.flatMap((s) => s.flat());
    const departureMin = enRouteDeparture({ first, mine, van, origin: van.origin, nowMin: env.nowMin, day });
    const fig = measureTechDay({
      ...common, rows: rest, first, origin: van.origin, end: home, departureMin, openMin: Math.max(DAY_OPEN, env.nowMin), today: true,
    });
    return { ...fig, van: van.source };
  } catch (err) {
    logger.warn(`[route-check] ${day} tech ${techId}: measure failed (${err.message})`);
    return { skip: 'FAILED' };
  }
}

/**
 * One hourly run: one route_check_runs row. A run-wide read failing (technicians, blackout days, absences, start
 * points, departure time) still writes the hour's row, status 'failed' and decision 'unknown'.
 */
async function runRouteCheck({ conn = db, now = new Date() } = {}) {
  try {
    return await measureRun(conn, now);
  } catch (err) {
    const today = etDateString(now);
    logger.warn(`[route-check] ${today}: run failed (${err.message}); recorded as unknown`);
    const ad = { decision: 'unknown', error: String(err.message).slice(0, 200) };
    await conn(TABLE).insert({
      run_at: now, service_date: today, status: 'failed', days: JSON.stringify([]), totals: JSON.stringify({}), ad_shadow: JSON.stringify(ad),
    });
    return { status: 'failed', totals: {}, ad, days: 0 };
  }
}

async function measureRun(conn, now) {
  const today = etDateString(now);
  const p = etParts(now);
  const elig = await eligibility(conn, today, dayAfter(today, SCAN_DAYS));
  // Today's rows and progress from one snapshot. A failed read marks what it affects (FAILED), never loses the row.
  const { rows: todayRows, progress } = await readToday(conn, today);
  const rowsOn = rowReader(conn, new Map([[today, todayRows]]));
  // A technician with a stop that day (null when the read failed); today counts the stops already done too (a Sunday
  // stays staffed after its last stop).
  const withStopsOn = async (day) => {
    const rows = await rowsOn(day);
    // Today without the progress read: a Sunday's stops done may be the only sign a technician worked.
    if (!rows || (day === today && !progress)) return null;
    return techsWithStops(day === today ? [...rows, ...(progress || [])] : rows);
  };
  const stopsOn = new Map();
  for (const day of [today, ...scanDates(today)].filter((d) => weekday(d) === 0)) stopsOn.set(day, await withStopsOn(day));
  const env = {
    today,
    nowMin: p.hour * 60 + p.minute,
    homes: await loadTechStartPoints(conn),
    departureMin: await departureMinutes(conn),
    techBlind: !require('../scheduling/occupancy').techScopedConfirmActive(),
  };
  const days = [];
  for (const day of datesToMeasure(elig, today, stopsOn)) {
    const rows = await rowsOn(day);
    const withStops = await withStopsOn(day);
    const working = elig.techIds.filter((techId) => staffed(elig, day, techId, !withStops || withStops.has(techId)));
    if (!rows) {
      for (const techId of working) days.push({ date: day, technician_id: techId, staffed: true, skip: 'FAILED' });
      continue;
    }
    let occupancy = [];
    try {
      if (working.length) occupancy = await loadOccupancy(conn, day);
    } catch (err) {
      // One date's read failing marks that date, never loses the hour's row.
      logger.warn(`[route-check] ${day}: occupancy read failed (${err.message})`);
      for (const techId of working) days.push({ date: day, technician_id: techId, staffed: true, skip: 'FAILED' });
      continue;
    }
    for (const techId of working) {
      days.push({ date: day, technician_id: techId, staffed: true, ...(await measureOne(conn, env, { day, techId, rows, progress, occupancy })) });
    }
  }
  const { totals, ad } = summarize(days, today, { techBlind: env.techBlind });
  const status = days.some((d) => d.skip === 'FAILED') ? 'completed_with_errors' : 'completed';
  const adShadow = { ...ad, live: await liveAdModes(conn) };
  await conn(TABLE).insert({
    run_at: now, service_date: today, status, days: JSON.stringify(days), totals: JSON.stringify(totals), ad_shadow: JSON.stringify(adShadow),
  });
  logger.info(`[route-check] ${status}: today slots=${totals.today.slots}; next ${totals.next.dates.length} staffed days slots=${totals.next.slots}; ad=${ad.decision}`);
  return { status, totals, ad: adShadow, days: days.length };
}

module.exports = {
  runRouteCheck,
  _internals: {
    vanNow, physicalStops, onSiteStays, todaysStops, heldSpans, hourSlots, routeOrder, enRouteDeparture, measureTechDay, staffed, datesToMeasure, summarize, unmeasurable,
    etMinuteOn, STAFFED_DAYS, DEMAND_DAYS,
  },
};
