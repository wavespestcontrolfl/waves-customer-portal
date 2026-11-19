/**
 * Hourly route check, shadow (owner 2026-11-19, "do whatever you reccomend", page "Ad Budget Rule v2" D2 after the
 * Codex review: "recalculate the remaining route ... each hour a tech is clocked in, and the next three staffed days").
 *
 * Every hour from 7:30 AM to 7:30 PM ET (scheduler.js) it recalculates, from the live schedule, the rest of today's
 * route and every staffed day up to STAFFED_DAYS staffed days ahead (at least DEMAND_DAYS calendar days, for the 7-day
 * demand view), for each technician who works that day. It records one row in route_check_runs:
 *   - each opening that holds a new job and its drive (close-gaps SLOT_MIN), and the jobs dispatch can place there
 *     (`slots`: each starts on the hour, AGENTS.md; `noticeSlots`: the 07:05 notice's own whole-slot count, to compare).
 *     While the occupancy check is tech-blind, a date's room is counted once across technicians;
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
const { promisedWindowOrder, workDuration } = require('../route-reorder-window-fit');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const { guardedCoordSelects } = require('../scheduling/day-stops');

const TABLE = 'route_check_runs';
const STAFFED_DAYS = 3;
const DEMAND_DAYS = 7;
// How far ahead to look for STAFFED_DAYS staffed days (a holiday week can close several in a row).
const SCAN_DAYS = 14;

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
 * Where the van is and when it is free on `day` (pure). completed: the day's completed rows; onSite: the stops on site now, one per physical stop ({ arrived_at, stayMin, lat, lng }; stayMin = the
 * services not yet done). The van is at that stop since its arrival, so a service finished after the arrival was
 * done there: the rest starts then. Busy until the stay ends and never before now (a job running long). Returns
 * { origin, clockMin, source }; source 'start_point' when nothing is done or under way, 'unknown' (origin null)
 * when the latest stop done has no place.
 */
function vanNow({ completed, onSite, home, departureMin, nowMin, day }) {
  // The latest stop done by its full timestamp (two in one minute: the later one), then its ET minute.
  const done = completed.filter((row) => etMinuteOn(row.completed_at, day) != null)
    .reduce((top, row) => (!top || new Date(row.completed_at) > new Date(top.completed_at) ? row : top), null);
  const lastDone = done ? etMinuteOn(done.completed_at, day) : -Infinity;
  const onSiteClock = (row) => Math.max(nowMin, Math.max(etMinuteOn(row.arrived_at, day) ?? nowMin, lastDone) + row.stayMin);
  const seen = [
    ...(done ? [{ row: done, clockMin: lastDone, source: 'completed' }] : []),
    ...onSite.map((row) => ({ row, clockMin: onSiteClock(row), source: 'on_site' })),
  ];
  const best = seen.reduce((top, s) => (!top || s.clockMin > top.clockMin ? s : top), null);
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

/** The stops on site now ({ arrived_at, stayMin, lat, lng } each), from physical stops and row id -> arrived_at. */
function onSiteStays(stops, arrivedById) {
  return stops.map((stop) => {
    const rows = stop.flat();
    const arrivals = rows.map((r) => arrivedById.get(String(r.id))).filter(Boolean).map((v) => new Date(v).getTime());
    return { lat: rows[0].lat, lng: rows[0].lng, arrived_at: arrivals.length ? new Date(Math.min(...arrivals)) : null, stayMin: stayOf(stop) };
  });
}

/** Jobs that fit one opening (pure): each a whole SLOT_MIN slot (job and drive) whose service starts on the hour. */
function hourSlots(o) {
  let count = 0;
  for (let at = ceilHour(o.start); at + SLOT_MIN <= o.start + o.min; at = ceilHour(at + SLOT_MIN)) count += 1;
  return count;
}

/**
 * Dispatch jobs across several technicians' openings when one booking holds its time for all of them (pure): each job
 * starts on the hour, fits wholly inside one opening, and no two overlap in time. Earliest-finish placement.
 */
function blindSlots(openings) {
  let cursor = -Infinity;
  let count = 0;
  for (;;) {
    const finishes = openings.map((o) => ceilHour(Math.max(o.start, cursor)) + SLOT_MIN).filter((f, i) => f <= openings[i].start + openings[i].min);
    if (!finishes.length) return count;
    count += 1;
    cursor = Math.min(...finishes);
  }
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

/** Every span holding booked time on a date: the offer side's own read (completed rows in, expired holds out). */
async function loadOccupancy(conn, day) {
  return require('../scheduling/occupancy').listOccupiedWindows({ db: conn, dateFrom: day, dateTo: day });
}

/** Why a tech-day cannot be simulated, or null. A stop with no time or no place leaves the day out. */
function unmeasurable(rows) {
  if (rows.some((r) => !r.window_start)) return 'UNTIMED_STOP';
  if (rows.some((r) => !hasCoords(r))) return 'STOP_WITHOUT_COORDINATES';
  return null;
}

/**
 * One tech-day's openings (pure). rows: the stops still to do, in any order (simulated in promised-window order, the
 * clock baseline), after `first` (the stop the van is driving to now: no opening before it, since a job there would
 * go ahead of that customer); blocks: the technician's schedule blocks; held: booked time, as intervals; origin:
 * where the van sets off; end: where it returns (the start point). slots: jobs that start on the hour (hourSlots);
 * noticeSlots: the 07:05 notice's own count (close-gaps: whole SLOT_MIN slots), so the two can be compared.
 */
function measureTechDay({ rows, first = [], blocks, held, origin, end = origin, departureMin, openMin, closeMin }) {
  const all = [...first, ...rows];
  const skip = unmeasurable(all);
  if (skip) return { stops: all.length, skip };
  // Each physical stop at its own promised start (a visit's afternoon service is not pulled up to its morning one),
  // each stop's rows together.
  const startOf = (stop) => Math.min(...stop.flat().map((r) => toMin(r.window_start)));
  const seq = [...first, ...physicalStops(rows).map((stop, i) => ({ stop, i })).sort((a, b) => startOf(a.stop) - startOf(b.stop) || a.i - b.i)
    .flatMap(({ stop }) => stop.flat())];
  const sim = simulate(seq, { origin, end, departureMin, blockedIntervals: serviceBlocks(blocks) });
  if (!sim) return { stops: all.length, skip: 'NO_SIMULATION' };
  const open = openMin < closeMin
    ? gaps.openBlocks(sim, { departureMin, openMin, closeMin, unavailable: [...blocks, ...held], driveBlocks: serviceBlocks(blocks) })
    : [];
  const openings = open.filter((b) => b.min >= SLOT_MIN && !(first.length && b.kind === 'start'))
    .map((b) => ({ kind: b.kind, start: Math.round(b.startMin), min: Math.round(b.min) }))
    .map((o) => ({ ...o, slots: hourSlots(o), noticeSlots: Math.floor(o.min / SLOT_MIN) }));
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
 * off): one booking holds its time for every technician (scheduling/occupancy.js), so a date's room is the jobs that
 * each fit one technician's opening and never overlap (blindSlots), not the sum per technician.
 */
function summarize(days, today, { techBlind = false } = {}) {
  const counted = days.filter((d) => d.staffed && !d.skip);
  const staffedDates = [...new Set(days.filter((d) => d.staffed && d.date !== today).map((d) => d.date))].sort().slice(0, STAFFED_DAYS);
  const slotsOf = (list) => {
    if (!techBlind) return sum(list, (d) => d.slots);
    const dates = [...new Set(list.map((d) => d.date))];
    return sum(dates, (date) => blindSlots(list.filter((d) => d.date === date).flatMap((d) => d.openings)));
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

/** A date's live rows (the re-plan's own read: expired holds out), read once per run; null when the read failed. */
function rowReader(conn) {
  const cache = new Map();
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
 * between is done (never simulated again), one reached in between is on site. A physical stop is on site (or en
 * route) when any of its rows is: tracking moves rows one at a time.
 */
function todaysStops(own, mine) {
  const now = new Map(mine.map((p) => [String(p.id), p.status]));
  const live = own.filter((r) => now.get(String(r.id)) !== 'completed')
    .map((r) => (now.get(String(r.id)) === 'on_site' ? { ...r, status: 'on_site' } : r));
  const stops = physicalStops(live);
  const has = (stop, status) => stop.flat().some((r) => r.status === status);
  const onSite = stops.filter((s) => has(s, 'on_site'));
  const enRoute = stops.filter((s) => !onSite.includes(s) && has(s, 'en_route'));
  const rest = stops.filter((s) => !onSite.includes(s) && !enRoute.includes(s));
  return { live, onSite, enRoute, rest: rest.flatMap((s) => s.flat()) };
}

/** One technician on one date: today from the van's progress, a later day as booked. Never throws. */
async function measureOne(conn, env, { day, techId, rows, progress, occupancy }) {
  try {
    const own = rows.filter((r) => String(r.technician_id) === techId);
    const blocks = await replan.loadBlocks(conn, day, techId);
    // Time held for this technician: the re-plan's whole hours (blockedHoursFor) and every booked span the booking
    // surfaces count (listOccupiedWindows: completed rows and make-room destinations included).
    const held = [
      ...replan.blockedHoursFor(rows, techId, env.techBlind).map((h) => ({ startMin: h * 60, endMin: h * 60 + 60 })),
      ...heldSpans(occupancy, techId, env.techBlind),
    ];
    const home = homeFromMap(env.homes, techId);
    const common = { blocks, held, closeMin: DAY_CLOSE };
    if (day !== env.today) {
      return measureTechDay({ ...common, rows: own, origin: home, departureMin: env.departureMin, openMin: DAY_OPEN });
    }
    if (!progress) return { stops: own.length, skip: 'FAILED' };
    const mine = progress.filter((p) => String(p.technician_id) === techId);
    // A stop put on site for this technician after the rows' read: its place and length are not in hand.
    const ownIds = new Set(own.map((r) => String(r.id)));
    if (mine.some((p) => p.status === 'on_site' && !ownIds.has(String(p.id)))) return { stops: own.length, skip: 'ON_SITE_NOT_IN_ROUTE' };
    const { live, onSite, enRoute, rest } = todaysStops(own, mine);
    // The van is at the stop on site, so one with no place leaves the day unmeasured (never free time from home).
    if (onSite.flat(2).some((r) => !hasCoords(r))) return { stops: live.length, skip: 'ON_SITE_WITHOUT_COORDINATES' };
    if (onSite.length > 1) return { stops: live.length, skip: 'SEVERAL_ON_SITE' };
    if (enRoute.length > 1) return { stops: live.length, skip: 'SEVERAL_EN_ROUTE' };
    const van = vanNow({
      completed: mine.filter((p) => p.status === 'completed'),
      onSite: onSiteStays(onSite, new Map(mine.map((p) => [String(p.id), p.arrived_at]))),
      home, departureMin: env.departureMin, nowMin: env.nowMin, day,
    });
    if (!van.origin) return { stops: live.length, skip: 'LAST_STOP_WITHOUT_COORDINATES' };
    const fig = measureTechDay({
      ...common, rows: rest, first: enRoute.flatMap((s) => s.flat()), origin: van.origin, end: home,
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
  const rowsOn = rowReader(conn);
  // Today's rows first, then the progress: a stop finished between the two reads shows as done, never in neither.
  // A failed read marks what it affects (FAILED), never loses the hour's row.
  await rowsOn(today);
  let progress = null;
  try {
    progress = await loadProgress(conn, today);
  } catch (err) {
    logger.warn(`[route-check] ${today}: progress read failed (${err.message})`);
  }
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
    departureMin: await dayDepartureMinutes(conn),
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
    vanNow, physicalStops, onSiteStays, todaysStops, heldSpans, hourSlots, blindSlots, measureTechDay, staffed, datesToMeasure, summarize, unmeasurable,
    etMinuteOn, STAFFED_DAYS, DEMAND_DAYS,
  },
};
