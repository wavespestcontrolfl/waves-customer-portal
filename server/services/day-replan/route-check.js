/**
 * Hourly route check, shadow (owner 2026-11-19, "do whatever you reccomend", page "Ad Budget Rule v2" D2 after the
 * Codex review: "recalculate the remaining route ... each hour a tech is clocked in, and the next three staffed days").
 *
 * Every hour from 7:30 AM to 7:30 PM ET (scheduler.js) it recalculates, from the live schedule, every staffed day after
 * today up to STAFFED_DAYS staffed days ahead (at least DEMAND_DAYS calendar days, for the 7-day demand view), for each
 * technician who works that day. It records one row per ET hour in route_check_runs:
 *   - each opening that holds a new job and its drive (close-gaps SLOT_MIN), and the jobs that fit there (`slots`: the
 *     drive, then a 60-minute service that starts on the hour, AGENTS.md; `noticeSlots`: the 07:05 notice's own
 *     whole-slot count, to compare). While the occupancy check is tech-blind (one booking holds its time for every
 *     technician), a date's room is the most any one technician can take: a lower bound, never a sum. Combining
 *     technicians comes with the second technician's shift build (page D4);
 *   - the totals for the next STAFFED_DAYS staffed days and the 7-day view, with the staffed days it could not
 *     measure;
 *   - the live ad rule's campaigns at that hour (`ad_shadow.live`), to compare the counts with;
 *   - the slot rule's decision (`ad_shadow.decision`, decideSlotRule): full or the 1% floor, from the booking engine.
 * It measures only: nothing here changes a visit, a time, a budget or a message. Every opening's start and length are
 * stored, so a rule can be counted again from the rows.
 *
 * The counts are room in the route as booked, not a booking engine's answer. A count has no customer address, so it
 * cannot say whether the dispatch picker (scheduling/arrival-route.js) or the /book page would place a job. Either can
 * refuse a counted job (a stop already late, a route through unassigned work) or place one the count leaves out (a
 * customer near the route, a reordered route). So the decision is not taken from the counts: decideSlotRule asks the
 * booking engine itself about one stated job at stated addresses (each service zone's center).
 *
 * Today is not measured here. Its room depends on where the van is now, which comes in a follow-up that reuses the
 * staff placement's own reading of the stop under way (scheduling/arrival-route.js) and leaves every state it cannot
 * read unmeasured. The /book page's first day is advance_days_min days out (1 by default), so the room an ad click can
 * book online starts after today too.
 * Each day is measured as booked, from the start point at the departure minute, as dispatch's capacity model simulates
 * it (simulateBookedDay: its grouping, its order rule, its work minutes and the free scheduling drive clock, with no
 * paid map call). Its open time is found the way the 04:40 re-plan finds it (close-gaps openBlocks). It runs every
 * hour, so a booking or a cancellation made during the day shows at the next hour.
 *
 * Which tech-days count (the 07:05 notice's own rules, open-blocks-alert.js): an assignable technician who is not
 * marked absent (absences and weekly days off), on a day that is not a blackout day. A Sunday counts only when the
 * technician has a stop that day. Bounds are the night pass's working day (candidate-slots DAY_OPEN / DAY_CLOSE);
 * per-technician shift hours come with the shift-end build (page D4).
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays, etParts } = require('../../utils/datetime-et');
const { _internals: replan } = require('./index');
const { SLOT_MIN, serviceBlocks, _internals: gaps } = require('./close-gaps');
const { coVisitGroups } = require('./app-sim');
const RouteOptimizer = require('../route-optimizer');
const { _internals: { groupRouteStops, storedOrderStale, clockOrder } } = require('../scheduling/arrival-route');
const {
  promisedWindowOrder, currentOrder, effectiveWindowRange, simulateArrivalRoute, workDuration,
} = require('../route-reorder-window-fit');
const { SHIFT } = require('../scheduling/policy');
const { customerWindowAdmits } = require('../scheduling/customer-windows');
const { parseHHMM } = require('../scheduling/window-rules');
const { allocationKey } = require('../scheduling/visit-capacity');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');

const TABLE = 'route_check_runs';
const STAFFED_DAYS = 3;
const DEMAND_DAYS = 7;
// How far ahead to look for STAFFED_DAYS staffed days (a holiday week can close several in a row).
const SCAN_DAYS = 14;
// The slot rule's stated job (decideSlotRule): the catalog's quarterly pest visit, at its catalog length.
const STANDARD_JOB_KEY = 'pest_general_quarterly';
// A job slot's parts (close-gaps SLOT_MIN: the 60-minute median job and its added drive). The drive comes first, so
// the service can start on the hour (AGENTS.md).
const JOB_MIN = 60;
const DRIVE_MIN = SLOT_MIN - JOB_MIN;
// Dispatch's capacity day end (arrival-route.js evaluateArrivalPlacement: its 20:00 default, capped at the shift end).
// The van is home by then.
const DISPATCH_DAY_END = Math.min(20 * 60, SHIFT.endMinutes);

const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const toMin = (value) => {
  const [h, m] = String(value).slice(0, 5).split(':').map(Number);
  return h * 60 + (m || 0);
};
const ceilHour = (min) => Math.ceil(min / 60) * 60;
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

const hasCoords = (row) => {
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  return row.lat != null && row.lng != null && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
};

const sameStopTuple = (a, b) => String(a.customer_id) === String(b.customer_id) && String(a.property_id || '') === String(b.property_id || '');
const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Tracking's chain rule (visit-groups.js windowedMembersConnected) reads window_start and window_end only, so a row
// promised by a legacy time_window alone ('morning', '3 PM') would join any chain. Such a row takes part with its
// promised interval resolved (effectiveWindowRange: the band, or the clock time and its arrival window).
const withResolvedWindow = (row) => {
  if (row.window_start) return row;
  const range = effectiveWindowRange(row);
  return range ? { ...row, window_start: clock(range.startMin), window_end: clock(range.endMin) } : row;
};

/**
 * The physical stops of a day's rows (pure), in promised-window order: each is a list of co-visit groups (app-sim
 * coVisitGroups). Groups of one visit (one visit_id, which promisedWindowOrder keeps adjacent) are one stop on
 * tracking's own boundary (visit-groups.js): same customer and property, and windows that form one connected chain.
 * A visit with a morning and an afternoon service is two stops, as tracking keeps them; a legacy promised time
 * counts as its resolved interval (withResolvedWindow). A version-2 allocation's services are one stop too, by the key
 * dispatch groups them by (visit-capacity allocationKey; pre-push audit round 31).
 */
function physicalStops(rows) {
  const { windowedMembersConnected } = require('../visit-groups');
  const stops = [];
  for (const group of coVisitGroups(promisedWindowOrder(rows))) {
    const last = stops.at(-1);
    const sofar = last ? last.flat() : [];
    const visitId = group[0].visit_id;
    const sameVisit = visitId != null && sofar.some((r) => r.visit_id != null && String(r.visit_id) === String(visitId))
      && group.every((r) => sofar.every((m) => sameStopTuple(r, m))) && windowedMembersConnected([...sofar, ...group].map(withResolvedWindow));
    if (sameVisit) last.push(group);
    else stops.push([group]);
  }
  const merged = [];
  const byAllocation = new Map();
  for (const stop of stops) {
    const key = stop.flat().map(allocationKey).find((k) => k != null);
    const earlier = key == null ? null : byAllocation.get(key);
    if (earlier) earlier.push(...stop);
    else {
      if (key != null) byAllocation.set(key, stop);
      merged.push(stop);
    }
  }
  return merged;
}

/**
 * Jobs that fit one opening (pure): for each, the drive, then a JOB_MIN service that starts on the hour, inside the
 * opening. The drive never starts before the opening, so a first job's drive before the working day is not credited
 * (a lower bound).
 */
function hourSlots(o) {
  let count = 0;
  const end = o.start + o.min;
  for (let at = ceilHour(o.start + DRIVE_MIN); at + JOB_MIN <= end; at = ceilHour(at + JOB_MIN + DRIVE_MIN)) count += 1;
  return count;
}

/**
 * The booked day as dispatch's capacity model simulates it (pure; the baseline of arrival-route.js
 * evaluateArrivalPlacement). Dispatch runs that model with the scheduling gate on, and with it off for a version-2
 * booking and for find-time's arrival search (preserveCapacity):
 *   - its grouping (groupRouteStops): a visit's or a version-2 allocation's services are one stop at one arrival,
 *     their work summed;
 *   - each stop's planned minutes (planning-minutes.js plannedWorkMinutes): every row carries preserveCapacity, as
 *     dispatch stamps it (pre-push audit round 30), and the stops read selects every input the table reads;
 *   - its order rule (its sequencers): the stored order; when that is stale (storedOrderStale), promised-window order
 *     too. Dispatch keeps only an order that keeps every promise, so one that does wins over a late one (round 32);
 *     between those, dispatch's own choice (selectWinningOrder): the least drive, then the least waiting, the stored
 *     order on a tie (round 31). A day where every order misses a promise is still measured, in its least-drive order;
 *   - its row mapping (a grouped stop's raw estimate is its summed work; an ordinary row keeps its raw estimate and
 *     is charged its work minutes);
 *   - its day end: the van home by DISPATCH_DAY_END, the drive home included (round 30);
 *   - the free scheduling drive clock with no requests (createSchedulingTravel: the conservative model; lookup never
 *     fetches).
 * This is the model dispatch places a new booking with when capacity applies. When planned minutes apply on every
 * path (GATE_SCHEDULING_CAPACITY=plan, production on 11-19), hour mode charges no stop more work or drive than this:
 * it runs a visit's services one by one, sums co-visit siblings' raw estimates and drives on the plain model.
 * Pre-push audit rounds 26, 28, 29 and 30 each found a part of this model that the check's own copy lacked.
 * { skip: 'GROUP_UNMODELED' } when dispatch cannot group the day either (its own code: a visit's services apart in the
 * order or at two places, or promises that do not overlap); { skip: 'NO_SIMULATION' } when no order runs (dispatch's
 * dayIsOvercommitted), including a booked day that ends after DISPATCH_DAY_END (dispatch refuses every placement on it).
 */
function simulateBookedDay(rows, { origin, departureMin, blocks, date }) {
  const stamped = rows.map((row) => ({ ...row, preserveCapacity: true }));
  const grouped = groupRouteStops(stamped);
  if (!grouped) return { skip: 'GROUP_UNMODELED' };
  const orders = storedOrderStale(grouped, stamped) ? [currentOrder(grouped), clockOrder(grouped)] : [currentOrder(grouped)];
  const travel = RouteOptimizer.createSchedulingTravel({ maxRequests: 0 });
  const run = (order) => simulateArrivalRoute(RouteOptimizer, (row) => row.arrivalRange || effectiveWindowRange(row),
    order.map((stop) => ({ ...stop,
      raw_estimate_minutes: stop.memberIds ? stop.estimated_duration_minutes
        : ('raw_estimate_minutes' in stop ? stop.raw_estimate_minutes : stop.estimated_duration_minutes),
      estimated_duration_minutes: stop.memberIds ? stop.estimated_duration_minutes : workDuration(stop) })), {
      startMin: departureMin, origin, end: origin, reportLate: true,
      // Every block, unfiltered, as dispatch passes them: one with no valid span makes the simulation refuse the day.
      blockedIntervals: blocks.map(({ startMin, endMin }) => ({ startMin, endMin })),
      dayEndMin: DISPATCH_DAY_END, includeReturnInFinish: true,
      legMinutes: (from, to, departMin) => travel.lookup({ date, from, to, departureMin: departMin }).minutes,
    });
  const sims = orders.map(run).filter(Boolean);
  if (!sims.length) return { skip: 'NO_SIMULATION' };
  const onTime = sims.filter((s) => s.arrivals.every((a) => !(a.lateMinutes > 0)));
  const sim = (onTime.length ? onTime : sims).reduce((best, s) => (s.travelMin < best.travelMin
    || (s.travelMin === best.travelMin && s.waitingMin < best.waitingMin) ? s : best));
  return { sim };
}

/**
 * The latest minute the van can leave for home and be there by dayEnd (pure): leg = the drive home; a drive may not
 * run through a block, so a block on the way moves the departure before it.
 */
function latestHomeDeparture(dayEnd, leg, blocks) {
  let leave = dayEnd - leg;
  for (const b of [...blocks].sort((x, y) => y.endMin - x.endMin)) {
    if (leave < b.endMin && leave + leg > b.startMin) leave = b.startMin - leg;
  }
  return leave;
}

/**
 * Booked time that holds one technician (pure), from the booking surfaces' own occupancy read: the technician's own
 * rows, unassigned rows, and every other technician's while
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
 * Every span holding booked time on a date: the offer side's own read (completed rows in) with every visit staff have
 * booked, also one that keeps an old hold timestamp (an unclaimed hold counts until it expires), and
 * the owner's booked interviews with their buffers (interview-slots.js), which dispatch also refuses to book over;
 * an interview holds every technician's time (no technician_id). A failed read throws: the caller marks the date.
 */
async function loadOccupancy(conn, day) {
  // Every visit staff have booked, as the stops read counts them (pre-push audit round 34): an unassigned one that keeps
  // an old hold timestamp still holds every technician's time, and an assigned one keeps its version-2 allocation.
  const visits = await require('../scheduling/occupancy').listOccupiedWindows({
    db: conn, dateFrom: day, dateTo: day, includeClaimedReservations: true,
  });
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
 * One tech-day's openings (pure). rows: the day's stops, in any order (they run in dispatch's order,
 * simulateBookedDay); blocks: the technician's schedule blocks; held: booked time, as intervals; origin: the start point,
 * where the van sets off and returns. slots: jobs that start on the hour after their drive (hourSlots);
 * noticeSlots: the 07:05 notice's own count rule on the same openings (close-gaps: whole SLOT_MIN slots), so the two
 * can be compared.
 * The day's last opening (the tail) ends when a job there still leaves the drive home before DISPATCH_DAY_END
 * (pre-push audit round 30). The job's place is unknown, so its drive home is taken as the booked day's own drive home
 * from its last stop (the simulator's return leg). A job between two stops leaves the drive home as it is.
 */
function measureTechDay({ rows, blocks, held, origin, departureMin, openMin, closeMin, date }) {
  // Physical stops, not services: one visit's services at one place are one stop (physicalStops).
  const stops = physicalStops(rows).length;
  const skip = unmeasurable(rows);
  if (skip) return { stops, skip };
  const booked = simulateBookedDay(rows, { origin, departureMin, blocks, date });
  if (booked.skip) return { stops, skip: booked.skip };
  const { sim } = booked;
  const homeLeg = sim.travelMin - sum(sim.arrivals, (a) => a.driveMin || 0);
  const lastLeave = latestHomeDeparture(DISPATCH_DAY_END, homeLeg, serviceBlocks(blocks));
  const open = (openMin < closeMin
    ? gaps.openBlocks(sim, { departureMin, openMin, closeMin, unavailable: [...blocks, ...held], driveBlocks: serviceBlocks(blocks) })
    : [])
    .map((b) => (b.kind === 'tail' ? { ...b, min: Math.min(b.startMin + b.min, lastLeave) - b.startMin } : b))
    .filter((b) => b.min > 0);
  // Kept: an opening that holds at least one whole job slot (the 07:05 notice's floor); `slots` then counts the jobs
  // in it that start on the hour.
  const openings = open.map((b) => ({ kind: b.kind, start: Math.round(b.startMin), min: Math.round(b.min) }))
    .map((o) => ({ ...o, slots: hourSlots(o), noticeSlots: Math.floor(o.min / SLOT_MIN) }))
    .filter((o) => o.noticeSlots > 0);
  return {
    stops,
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
 * The dates to measure (pure): every date after today through the STAFFED_DAYS-th staffed date, and at least
 * DEMAND_DAYS calendar days. A date is staffed when some technician counts on it. stopsOn: date -> the ids of the
 * technicians with a stop that day, or null when the read failed; only Sundays read it, so the caller loads the
 * Sundays only.
 */
function datesToMeasure(elig, today, stopsOn) {
  const dates = [];
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
 * Totals from the measured tech-days (pure). techBlind (GATE_MULTI_TECH_CONFIRM off): one booking holds its time for
 * every technician (scheduling/occupancy.js), so a date's room is the most any one technician can take (each
 * technician's count already holds the others' booked time), never the sum. `unmeasured`, in each window: the dates
 * with a staffed tech-day that could not be measured (each date once), so no room found there is not a measured zero.
 */
function summarize(days, today, { techBlind = false } = {}) {
  const ahead = days.filter((d) => d.date > today);
  const counted = ahead.filter((d) => d.staffed && !d.skip);
  const staffedDates = [...new Set(ahead.filter((d) => d.staffed).map((d) => d.date))].sort().slice(0, STAFFED_DAYS);
  const slotsOf = (list) => {
    if (!techBlind) return sum(list, (d) => d.slots);
    const dates = [...new Set(list.map((d) => d.date))];
    return sum(dates, (date) => Math.max(...list.filter((d) => d.date === date).map((d) => d.slots)));
  };
  const unmeasuredDates = (filter) => [...new Set(ahead.filter((d) => d.staffed && d.skip && filter(d)).map((d) => d.date))].sort();
  const pick = (filter) => ({ slots: slotsOf(counted.filter(filter)), unmeasured: unmeasuredDates(filter) });
  const next = pick((d) => staffedDates.includes(d.date));
  const lastDemand = dayAfter(today, DEMAND_DAYS);
  const week = pick((d) => d.date <= lastDemand);
  // next.dates holds fewer than STAFFED_DAYS dates when the scan found fewer staffed days (a long closure).
  return { next: { dates: staffedDates, ...next }, week: { through: lastDemand, ...week }, techBlind };
}

/**
 * Every Google Ads campaign's recorded status and budget mode, to compare the counts with (null when unreadable). Not
 * only active ones: the local status lags Google until the next sync.
 */
async function liveAdModes(conn) {
  const rows = await conn('ad_campaigns').where({ platform: 'google_ads' }).select('id', 'status', 'budget_mode');
  return rows.map((r) => ({ id: r.id, status: r.status, mode: r.budget_mode }));
}

async function eligibility(conn, from, to) {
  const { getBlackoutDates } = require('../scheduling/blackout-dates');
  const blackout = await getBlackoutDates(from, to, conn, { strict: true });
  const techs = await applyAssignable(conn('technicians')).select('technicians.id');
  const techIds = techs.map((t) => String(t.id));
  const absent = techIds.length ? await absentTechDays(conn, { dateFrom: from, dateTo: to, technicianIds: techIds }) : new Set();
  return { blackout, techIds, absent };
}

// Every read of one run as of one moment (the FINAL_CHECK_SNAPSHOT pattern, visit-prep.js): stops, bookings, blocks
// and interviews all agree, so nothing booked, cancelled or moved between two reads is half-seen.
const RUN_SNAPSHOT = { isolationLevel: 'repeatable read', readOnly: true };

/** Runs `read` in one read-only snapshot. A transaction or a test double reads on its own connection. */
function inSnapshot(conn, read) {
  if (typeof conn.transaction !== 'function' || conn.isTransaction) return read(conn);
  return conn.transaction((trx) => read(trx), RUN_SNAPSHOT);
}

/**
 * A read whose failure the run survives, in its own savepoint inside the snapshot: PostgreSQL aborts the whole
 * transaction on a failed statement, so without it one unreadable date would fail every later read.
 */
function recoverable(conn, read) {
  if (conn.isTransaction && typeof conn.transaction === 'function') return conn.transaction((savepoint) => read(savepoint));
  return read(conn);
}

/**
 * A date's rows, read once per run; null when the read failed. The re-plan's own read, with every visit staff have
 * booked (reservation-occupancy bookedVisitOrLiveHold: a customer-linked visit counts even when it keeps its old hold
 * timestamp), the rule dispatch's commit-time checks count; an unclaimed hold counts until it expires.
 */
function rowReader(conn) {
  const cache = new Map();
  return async (day) => {
    if (!cache.has(day)) {
      try {
        cache.set(day, await recoverable(conn, (c) => replan.loadDayStops(c, day, true)));
      } catch (err) {
        logger.warn(`[route-check] ${day}: stops read failed (${err.message})`);
        cache.set(day, null);
      }
    }
    return cache.get(day);
  };
}

// The rows dispatch's capacity model keeps (arrival-route.js loadArrivalRouteContext): a window start, a time window, or
// work done or under way. Any other row is a placeholder, inert to that model and so to the check: it is not a stop, it
// staffs no Sunday and it holds no time (pre-push audit round 39).
const dispatchKeeps = (r) => Boolean(r.window_start || r.time_window || ['completed', 'en_route', 'on_site'].includes(r.status));
// A booked stop: not an unclaimed hold (no customer yet, a live expiry). Only a booked stop staffs a Sunday, as the 07:05
// notice counts Sundays only with stops booked (pre-push audit round 38); a hold still holds its time on a staffed route.
const bookedStop = (r) => r.customer_id != null || r.reservation_expires_at == null;
const techsWithStops = (rows) => new Set(rows.filter((r) => r.technician_id && bookedStop(r) && dispatchKeeps(r))
  .map((r) => String(r.technician_id)));

/**
 * Work this technician's count must hold but cannot, or null (pre-push audit rounds 35 and 36). Its date is left
 * unmeasured.
 * - UNASSIGNED_WORK: dispatch's capacity model keeps a row with a window start, a time window or work under way
 *   (en_route, on_site; loadArrivalRouteContext, pre-push audit round 37) and holds unassigned work against every route: its whole arrival promise plus its work, and a promise it cannot
 *   resolve blocks every route (arrival-route.js selectWinningOrder, fixed blocks; completed work excepted). The
 *   occupancy read holds less: the booked window only, and nothing for a legacy time window. A row with neither field
 *   is inert, there and here.
 * - LEGACY_WINDOW_ELSEWHERE: while tech-blind, every other technician's visit holds this technician's time, but one
 *   with only a legacy time window has no span in the occupancy read (listOccupiedWindows needs window_start).
 */
function unheldWork(rows, techId, techBlind) {
  if (rows.some((r) => r.technician_id == null && r.status !== 'completed' && dispatchKeeps(r))) {
    return 'UNASSIGNED_WORK';
  }
  const elsewhere = (r) => r.technician_id != null && String(r.technician_id) !== String(techId);
  if (techBlind && rows.some((r) => elsewhere(r) && !r.window_start && r.time_window)) return 'LEGACY_WINDOW_ELSEWHERE';
  return null;
}

/** One technician on one date, as booked. Never throws. */
async function measureOne(conn, env, { day, techId, rows, occupancy }) {
  try {
    // groupRouteStops reads each row's version-2 allocation (visit-capacity allocationKey). Dispatch's row read and the
    // occupancy read select it; the shared stops read does not (a booking path reads that one too, so it stays).
    const mixById = new Map(occupancy.filter((r) => r.reservation_service_mix != null).map((r) => [String(r.id), r.reservation_service_mix]));
    const own = rows.filter((r) => String(r.technician_id) === techId && dispatchKeeps(r))
      .map((r) => (r.reservation_service_mix == null && mixById.has(String(r.id)) ? { ...r, reservation_service_mix: mixById.get(String(r.id)) } : r));
    const unheld = unheldWork(rows, techId, env.techBlind);
    if (unheld) return { stops: physicalStops(own).length, skip: unheld };
    // Every block, also one with no valid span: dispatch's simulation refuses such a day, so the check leaves it
    // unmeasured (pre-push audit round 33).
    const blocks = await recoverable(conn, (c) => replan.loadBlocks(c, day, techId, { keepInvalid: true }));
    // Time held for this technician: every booked span the booking surfaces count, exact to the minute
    // (listOccupiedWindows: make-room destinations included; a window may end off the hour).
    const held = heldSpans(occupancy, techId, env.techBlind);
    return measureTechDay({
      rows: own, blocks, held, origin: homeFromMap(env.homes, techId), departureMin: env.departureMin, openMin: DAY_OPEN, closeMin: DAY_CLOSE,
      date: day,
    });
  } catch (err) {
    logger.warn(`[route-check] ${day} tech ${techId}: measure failed (${err.message})`);
    return { skip: 'FAILED' };
  }
}

/**
 * The slot rule's decision (ad budget rule v2, owner 2026-11-19 "do whatever you reccomend": any slot = full budget,
 * else the 1% floor), asked of the booking engine itself, not taken from the counts. One stated job (STANDARD_JOB_KEY,
 * at its catalog length) is asked about at each service zone's center, on each of the next staffed days the totals
 * count, through the day-agreement shadow's freeSlotsAt: find-time's findAvailableSlots (the engine /book, the
 * estimate picker and the night tool call), asked as a customer-facing caller, then the reserve gate's collision guard
 * outside capacity routing. So both shadows ask the engine the same way. A slot counts only when the customer window
 * admits its start (customerWindowAdmits: the 9:00-17:00 grid, the last customer start, the close), as every
 * customer-facing booking path checks it: find-time applies that rule itself only under capacity routing. The engine
 * reads the live tables itself, just after the snapshot.
 * Shadow only: nothing reads the decision, no budget changes, nothing is held, and nothing is paid for (no road lookup
 * is bought; a zone center is a pin, so nothing is geocoded).
 *   mode 'full': some zone has a slot. 'floor': every ask answered and none has one, or no staffed day is ahead.
 *   'unknown': no slot, and the job, the zones or an ask could not be read (`reason`, or a zone's `error`).
 */
async function decideSlotRule(conn, dates) {
  if (!dates.length) return { mode: 'floor', reason: 'no_staffed_days', dates };
  const job = await conn('services').where({ service_key: STANDARD_JOB_KEY })
    .first('name', 'default_duration_minutes', 'is_active');
  if (!job || job.is_active !== true) return { mode: 'unknown', reason: 'job_unresolved', dates };
  const { freeSlotsAt, visitIdentity } = require('../day-agreement-shadow');
  const identity = visitIdentity({ service: job });
  // A blank coordinate is no pin (Number(null) is 0), as the /book pin reader rules.
  const zones = (await conn('service_zones').select('zone_name', 'center_lat', 'center_lng'))
    .map((z) => ({ zone: z.zone_name, where: { lat: Number(z.center_lat), lng: Number(z.center_lng) } }))
    .filter(({ where }) => [where.lat, where.lng].every((v) => Number.isFinite(v) && v !== 0))
    .sort((a, b) => String(a.zone).localeCompare(String(b.zone)));
  if (!zones.length) return { mode: 'unknown', reason: 'no_zones', dates };
  const admitted = (s) => customerWindowAdmits({ startMin: parseHHMM(s.start_time), endMin: parseHHMM(s.end_time) });
  const asked = [];
  for (const { zone, where } of zones) {
    const byDate = {};
    let first = null;
    let error = null;
    for (const day of dates) {
      try {
        const starts = (await freeSlotsAt(conn, { where, day, identity })).filter(admitted).map((s) => s.start_time).sort();
        byDate[day] = starts.length;
        first ||= starts.length ? `${day} ${starts[0]}` : null;
      } catch (err) {
        byDate[day] = null;
        error = String(err.message).slice(0, 200);
      }
    }
    asked.push({ zone, byDate, first, ...(error ? { error } : {}) });
  }
  const anySlot = asked.some((z) => Object.values(z.byDate).some((n) => n > 0));
  const mode = anySlot ? 'full' : (asked.some((z) => z.error) ? 'unknown' : 'floor');
  return { mode, job: { key: STANDARD_JOB_KEY, ...identity }, dates, zones: asked };
}

/**
 * One hourly run: every read in one read-only snapshot, then one route_check_runs row written outside it. A run-wide
 * read failing (technicians, blackout days, absences, start points, departure time) still writes the hour's row,
 * status 'failed', with the error in its totals.
 *
 * One row per ET hour. runExclusive stops two instances running at the same time only: a second instance (a deploy
 * overlap) whose tick waited for a lock slot can run after the first released the lock. The unique key on
 * (service_date, run_hour) keeps the first row of the hour. The second run writes nothing and reports that row's
 * status (`duplicate: true`), so job health keeps a failed hour failed and never clears it.
 * run_hour is the hour the run starts, which is its tick's hour: a tick waits at most SLOT_WAIT_MAX_MS (10 minutes)
 * past :30 for a slot (utils/cron-lock.js).
 */
async function runRouteCheck({ conn = db, now = new Date() } = {}) {
  const today = etDateString(now);
  const hour = etParts(now).hour;
  let run;
  try {
    run = await inSnapshot(conn, (reader) => measureRun(reader, now));
  } catch (err) {
    logger.warn(`[route-check] ${today}: run failed (${err.message}); recorded`);
    run = { status: 'failed', days: [], totals: { error: String(err.message).slice(0, 200) }, ad: {} };
  }
  // A decision the run could not make, or an ask that failed, is an error of the run, as an unread campaign list is.
  if (run.status !== 'failed') {
    const decision = await decideSlotRule(conn, run.totals.next.dates).catch((err) => {
      logger.warn(`[route-check] ${today}: slot-rule decision failed (${err.message})`);
      return { mode: 'unknown', error: String(err.message).slice(0, 200) };
    });
    run.ad.decision = decision;
    if (decision.mode === 'unknown' || decision.zones?.some((z) => z.error)) run.status = 'completed_with_errors';
  }
  const written = await conn(TABLE).insert({
    run_at: now, service_date: today, run_hour: hour, status: run.status,
    days: JSON.stringify(run.days), totals: JSON.stringify(run.totals), ad_shadow: JSON.stringify(run.ad),
  }).onConflict(['service_date', 'run_hour']).ignore().returning('id');
  if (!written.length) {
    const recorded = await conn(TABLE).where({ service_date: today, run_hour: hour }).first('status');
    const status = recorded?.status || 'failed';
    logger.info(`[route-check] ${today} ${hour}:00 already recorded (${status}) by another instance; this run wrote nothing`);
    return { status, duplicate: true, totals: {}, days: 0 };
  }
  if (run.status !== 'failed') {
    logger.info(`[route-check] ${run.status}: next ${run.totals.next.dates.length} staffed days slots=${run.totals.next.slots}`
      + ` decision=${run.ad.decision.mode}`);
  }
  return { status: run.status, totals: run.totals, days: run.days.length };
}

async function measureRun(conn, now) {
  const today = etDateString(now);
  const elig = await eligibility(conn, today, dayAfter(today, SCAN_DAYS));
  // A failed read marks what it affects (FAILED), never loses the row.
  const rowsOn = rowReader(conn);
  // The technicians with a stop that day (null when the read failed).
  const withStopsOn = async (day) => {
    const rows = await rowsOn(day);
    return rows ? techsWithStops(rows) : null;
  };
  const stopsOn = new Map();
  for (const day of scanDates(today).filter((d) => weekday(d) === 0)) stopsOn.set(day, await withStopsOn(day));
  const env = {
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
      if (working.length) occupancy = await recoverable(conn, (c) => loadOccupancy(c, day));
    } catch (err) {
      // One date's read failing marks that date, never loses the hour's row.
      logger.warn(`[route-check] ${day}: occupancy read failed (${err.message})`);
      for (const techId of working) days.push({ date: day, technician_id: techId, staffed: true, skip: 'FAILED' });
      continue;
    }
    for (const techId of working) {
      days.push({ date: day, technician_id: techId, staffed: true, ...(await measureOne(conn, env, { day, techId, rows, occupancy })) });
    }
  }
  const totals = summarize(days, today, { techBlind: env.techBlind });
  // The read throws inside its savepoint (rolled back there), and only then is caught. An unread list is an error of
  // the run, with its message: never a list with no campaigns.
  const ad = await recoverable(conn, async (c) => ({ live: await liveAdModes(c) })).catch((err) => {
    logger.warn(`[route-check] ad campaigns unread (${err.message})`);
    return { live: null, error: String(err.message).slice(0, 200) };
  });
  const failed = ad.live === null || days.some((d) => d.skip === 'FAILED');
  return { status: failed ? 'completed_with_errors' : 'completed', days, totals, ad };
}

module.exports = {
  runRouteCheck,
  _internals: {
    recoverable, physicalStops, heldSpans, unheldWork, hourSlots, simulateBookedDay, latestHomeDeparture, measureTechDay, staffed,
    datesToMeasure, summarize, unmeasurable, DISPATCH_DAY_END, decideSlotRule,
    STAFFED_DAYS, DEMAND_DAYS, STANDARD_JOB_KEY,
  },
};
