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
 *   - the slot rule's decision (`ad_shadow.decision`, decideSlotRule): full or the 1% floor, from the finder that offers
 *     a lead its times (routes/booking.js availabilityForPin), and for today from the list the office books a same-day
 *     caller from (New Appointment's open times, routes/admin-schedule-find-time.js).
 * It measures only: nothing here changes a visit, a time, a budget or a message. Every opening's start and length are
 * stored, so a rule can be counted again from the rows.
 *
 * The counts are room in the route as booked, not a booking engine's answer. A count has no customer address, so it
 * cannot say whether the dispatch picker (scheduling/arrival-route.js) or the /book page would place a job. Either can
 * refuse a counted job (a stop already late, a route through unassigned work) or place one the count leaves out (a
 * customer near the route, a reordered route). So the decision is not taken from the counts: decideSlotRule asks the
 * booking engine's own offer finder about one stated job at stated addresses (each service zone's center).
 *
 * Today is not measured here: its room depends on where the van is now. The /book page's first day is
 * advance_days_min days out (1 by default), so the room an ad click can book online starts after today. Today's room
 * is the office's to book, so the decision asks the office's own finder about it (decideSlotRule), which continues the
 * day from the stop under way (scheduling/arrival-route.js) and offers nothing on a route it cannot verify.
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
const { pickerRoadCheckLive, _internals: { groupRouteStops, storedOrderStale, clockOrder } } = require('../scheduling/arrival-route');
const {
  promisedWindowOrder, currentOrder, effectiveWindowRange, simulateArrivalRoute, workDuration,
} = require('../route-reorder-window-fit');
const { SHIFT, capacityEnabled } = require('../scheduling/policy');
const { allocationKey } = require('../scheduling/visit-capacity');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');

const TABLE = 'route_check_runs';
const STAFFED_DAYS = 3;
const DEMAND_DAYS = 7;
// How far ahead to look for STAFFED_DAYS staffed days (a holiday week can close several in a row).
const SCAN_DAYS = 14;
// The slot rule's stated job (decideSlotRule): the /book funnel's pest control visit, at its funnel length.
const STANDARD_SERVICE_KEY = 'pest_control';
// The slot rule's own label on its asks (availabilityForPin `surface`): the customer route check logs them as
// surface=route_check, apart from a customer's /book search, and applies the same rules.
const PROBE_SURFACE = 'route_check';
// A job slot's parts (close-gaps SLOT_MIN: the 60-minute median job and its added drive). The drive comes first, so
// the service can start on the hour (AGENTS.md).
const JOB_MIN = 60;
const DRIVE_MIN = SLOT_MIN - JOB_MIN;
// Dispatch's capacity day end (arrival-route.js evaluateArrivalPlacement: its 20:00 default, capped at the shift end).
// The van is home by then.
const DISPATCH_DAY_END = Math.min(20 * 60, SHIFT.endMinutes);
// The office's New Appointment finder offers a same-day start this long after the current minute at the earliest,
// rounded up to the hour (find-time.js findArrivalWindowSlots: its same-day floor).
const STAFF_SAME_DAY_LEAD_MIN = 30;
// The open-times list's step: appointment windows start on the hour (find-time-hints hintSearchPlan, and the box's own
// request, client useBestTimes).
const OFFICE_STEP_MIN = 60;

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

/**
 * Who works today, a Sunday: a technician with a stop booked (`booked`, the day's stops read) or a stop already done,
 * which that read leaves out (replan.loadDayStops: completed visits excluded). A technician whose last stop today is
 * done still works it, and the office's finder still offers that route (its route stops keep completed work). null when
 * either read failed: who works today is unknown.
 */
async function sundayWorkToday(conn, today, booked) {
  if (booked === null) return null;
  try {
    const done = await recoverable(conn, (c) => c('scheduled_services')
      .where({ scheduled_date: today, status: 'completed' })
      .select('technician_id', 'customer_id', 'reservation_expires_at', 'status'));
    return new Set([...booked, ...techsWithStops(done)]);
  } catch (err) {
    logger.warn(`[route-check] ${today}: completed stops read failed (${err.message})`);
    return null;
  }
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
 * else the 1% floor), asked of the booking engine, not taken from the counts. It asks the finder that offers a lead its
 * times: routes/booking.js availabilityForPin, the one pin reader that /book's offers, the lead reply agent's
 * next-available check and the text drafter's OPEN TIMES share (scheduling/text-offer-times.js), with the stated job
 * (STANDARD_SERVICE_KEY) at each service zone's center. So every rule a /book offer keeps is in the answer: the
 * customer window, the notice window, the zone route days, the occupancy mirror, the customer route check.
 * A slot counts on one of the next staffed days the totals count, searched through the last of them (`through`), and
 * only from a technician the run counts that day: the finder gets the run's `crew` (from `staffed`: a Sunday only with
 * a stop booked) and offers each date only from it, before it picks one technician per start. A Sunday whose stops
 * read failed has no known crew: its slots are not counted (byDate null). The finder reads the live tables itself,
 * just after the snapshot.
 * One database, one clock. The finder reads the shared handle (models/db) in every module it calls (find-time, the
 * occupancy mirror, the zone route days, the customer route check), and none of them takes a connection. So the run
 * reads that handle too (runRouteCheck has no other), and the crew and the bookings come from one database. The finder
 * gets the run's clock (`now`: the offer window and the notice window). Its own wall-clock reads (find-time's same-day
 * floor, the van's place today) touch only the wall clock's today, which the decision never takes from /book. A run on
 * another ET day than the wall clock's (a test or replay clock, a run that crossed midnight) gets no decision:
 * 'unknown', reason 'other_day', with no ask.
 * Today (page D2: "today only while a job ends by 18:00"). /book offers nothing today, so today's answer is the list
 * the office books a same-day caller from: New Appointment's open times (sameDayStarts: that box's technicians, finder
 * ask and guard), at each zone's center, for each technician the run counts today. A start counts when its job ends by
 * the day's end (DISPATCH_DAY_END), from the van's modeled arrival: the office's start is an arrival window, and the
 * van can come after it (a 5 PM start reached at 6:09 PM ends at 7:09 PM). Today is asked only while a job can end in
 * time (sameDayOpen). That finder takes no clock: it reads the wall clock, and so does the window (both on the run's
 * day, by the other-day rule). A technician's failed ask or unverifiable route gives today no answer (null) unless
 * another technician has a start. The office's finder drives today's best hours on Google road times and this ask buys
 * none, so `sameDay.travel` marks the answer as the free drive model's.
 * The asks carry their own label (PROBE_SURFACE): the customer route check logs them apart from customer searches.
 * Openings only. The asks take no fallback list (`verifiedOnly`): where /book would serve a list it could not check (an
 * unreadable closed-day list, service-line map or territory; a failed occupancy read; a customer route check that
 * failed, ran out of time or could not score a route), the ask throws and the zone has no answer. The crew's ask keeps
 * no floor: the customer route check keeps a whole week when none of its slots survive, but over the crew's slots that
 * is not /book's floor. So when the crew has no slot, the zone also asks /book's own pool (no crew): if /book's check
 * would keep its whole week (every slot in it would make a customer late, and /book shows them anyway), that ask
 * throws and the zone has no answer. Else its starts from a day's crew count as the crew's do (one can open between
 * the two reads), and with none the crew's zero stands. A crew slot needs no such ask: /book offers that start either
 * way (its own pick there is the same technician, or one with no stop that day, whom the check never removes). Today's
 * list is strict too: its occupancy guard throws where the office's box would list unchecked hours.
 * Shadow only: nothing reads the decision, no budget changes, nothing is held, and nothing is paid for (paidLookups
 * false buys no road lookup and reads no forecast; a zone center is a pin, so nothing is geocoded). Under capacity
 * routing /book itself buys road times, so there the answer is the free drive model's (`travel: 'modeled'`): a
 * borderline slot can differ from /book's.
 *   mode 'full': some zone has a slot. 'floor': every zone answered for every date and none has a slot, or no staffed
 *   day is ahead (today included while it counts). 'unknown': no slot, and the zones, a zone's answer or a date's crew could not be read (`reason`, a
 *   zone's `error`, or a null in byDate), or the run is not on the wall clock's day (reason 'other_day'). A zone with
 *   no pin, or /book off, gets no answer (`no_offer`): an error, never "no slot".
 */
async function decideSlotRule({ now, dates, crew }) {
  if (etDateString(new Date()) !== etDateString(now)) return { mode: 'unknown', reason: 'other_day', dates };
  const today = etDateString(now);
  const todayCrew = crew.get(today);
  // Today joins while the office can still book a job there that ends by the day's end, and someone works it (or who
  // does is unknown: a Sunday whose stops read failed).
  const sameDay = sameDayOpen(new Date()) && (todayCrew === null || todayCrew?.size > 0);
  // The office lists open times only while its box is shown (find-time-hints openTimesBoxLive). Hidden, today has no
  // answer and nothing is asked: the list counted is not there to book from.
  const listed = sameDay && require('../scheduling/find-time-hints').openTimesBoxLive();
  const counted = sameDay ? [today, ...dates] : dates;
  if (!counted.length) return { mode: 'floor', reason: 'no_staffed_days', dates: counted };
  const zones = (await db('service_zones').select('zone_name', 'center_lat', 'center_lng'))
    .sort((a, b) => String(a.zone_name).localeCompare(String(b.zone_name)));
  if (!zones.length) return { mode: 'unknown', reason: 'no_zones', dates: counted };
  const asked = [];
  const todayAsk = { sameDay, techs: listed ? todayCrew : null };
  for (const zone of zones) asked.push(await zoneAnswer(zone, { now, today, todayAsk, dates, crew }));
  const anySlot = asked.some((z) => Object.values(z.byDate).some((n) => n > 0));
  const unread = asked.some((z) => z.error || Object.values(z.byDate).includes(null));
  const mode = anySlot ? 'full' : (unread ? 'unknown' : 'floor');
  return {
    mode, service: STANDARD_SERVICE_KEY, ...(capacityEnabled() ? { travel: 'modeled' } : {}), dates: counted,
    ...(sameDay ? { sameDay: { date: today, ...(listed ? sameDayTravel() : { box: 'off' }) } } : {}),
    zones: asked,
  };
}

/**
 * One zone's answer (decideSlotRule): today's starts from the office's finder (sameDayStarts) while today counts, then
 * the next staffed days' from /book (availabilityForPin). Each finder answers apart: one failing (`error`) leaves the
 * other's answer standing, as any slot is full. byDate: a date's start count, null when that date has no answer;
 * first: the zone's first slot, the dates in order.
 */
async function zoneAnswer(zone, { now, today, todayAsk, dates, crew }) {
  const byDate = {};
  const errors = [];
  let first = null;
  const record = (day, starts) => {
    byDate[day] = starts ? starts.length : null;
    first ||= starts?.length ? `${day} ${starts[0]}` : null;
  };
  if (todayAsk.sameDay) {
    try {
      const answer = await sameDayStarts(zone, today, todayAsk.techs);
      record(today, answer.starts);
      errors.push(...answer.errors);
    } catch (err) {
      record(today, null);
      errors.push(String(err.message));
    }
  }
  // An offer's starts per date from that date's crew; a date with no known crew counts nothing (null).
  const tally = (offer) => {
    for (const day of dates) {
      const works = crew.get(day);
      record(day, works ? (offer.days.find((d) => d.date === day)?.slots || [])
        .filter((s) => works.has(String(s.technician_id))).map((s) => s.start_time).sort() : null);
    }
  };
  if (dates.length) {
    const { availabilityForPin } = require('../../routes/booking')._internals;
    try {
      const ask = async (extra) => {
        const offer = await availabilityForPin({
          lat: zone.center_lat, lng: zone.center_lng, serviceKey: STANDARD_SERVICE_KEY, paidLookups: false,
          through: dates[dates.length - 1], now, surface: PROBE_SURFACE, verifiedOnly: true, ...extra,
        });
        if (!offer) throw new Error('no_offer');
        return offer;
      };
      tally(await ask({ crew }));
      // No slot yet (today's or the crew's): /book's own pool says whether its check would keep the whole week (the ask
      // throws), and a crew start it offers (one that opened between the two reads) counts.
      if (!first) tally(await ask({}));
    } catch (err) {
      errors.push(String(err.message));
    }
  }
  return { zone: zone.zone_name, byDate, first, ...(errors.length ? { error: [...new Set(errors)].join('; ').slice(0, 200) } : {}) };
}

/**
 * True while the office's New Appointment finder can still offer a start today whose job ends by the day's end (page
 * D2: "today only while a job ends by 18:00"): its earliest same-day start, on `clock`, is STAFF_SAME_DAY_LEAD_MIN out,
 * rounded up to the hour.
 */
// The office's finder drives today's best hours on Google road times; this ask buys none, so the answer is the free drive
// model's. Under capacity routing that finder buys none either.
function sameDayTravel() {
  return pickerRoadCheckLive() ? { travel: 'modeled' } : {};
}

function sameDayOpen(clock) {
  const { hour, minute } = etParts(clock);
  return ceilHour(hour * 60 + minute + STAFF_SAME_DAY_LEAD_MIN) + JOB_MIN <= DISPATCH_DAY_END;
}

/**
 * Today's open starts at one zone's center, as the office's New Appointment box lists them (admin-schedule-find-time.js,
 * its open-times list), for each technician of today's crew. A start counts when its job, begun at the van's modeled
 * arrival, ends by the day's end. Returns { starts, errors }: starts sorted, each start once. The box's chain:
 * - its technicians: one who cannot do the service is never listed (techsLacking);
 * - its finder ask (find-time findAvailableSlots): a new stop at the pin, hourly starts, the technician's start point,
 *   every weekday, blackout days shown (the crew already leaves them out), and today's route continuing from the stop
 *   under way exactly when the office's finder does so (pickerRoadCheckLive). No road purchase: no pickerRoadCheck and
 *   no provider travel;
 * - its guard (find-time-hints guardHintStarts): every start that fits, one per technician. A gap of the legacy finder
 *   is walked hourly and an occupied hour (an unassigned visit too) is vetoed. `strict`: an unreadable snapshot throws,
 *   never the box's fail-open list.
 * starts null (no answer): who works today is unknown (`techs` null: a Sunday whose stops read failed; no ask), or no
 * start while a technician's ask failed (`errors`) or its route could not be verified (the finder offers nothing on
 * it: two stops under way, a stop done with no time), so the zero is not an answer. One technician's failure leaves the
 * others' starts standing.
 */
async function sameDayStarts(zone, today, techs) {
  if (techs === null) return { starts: null, errors: [] };
  const { findAvailableSlots } = require('../scheduling/find-time');
  const { guardHintStarts } = require('../scheduling/find-time-hints');
  const lacking = await techsLacking(techs);
  const errors = [];
  const slots = [];
  let unverified = false;
  for (const technicianId of techs) {
    if (lacking.has(String(technicianId))) continue;
    try {
      const found = await findAvailableSlots({
        lat: zone.center_lat, lng: zone.center_lng, durationMinutes: JOB_MIN, serviceKey: STANDARD_SERVICE_KEY,
        dateFrom: today, dateTo: today, technicianId, techStartPoints: true, includeWeekends: true, includeBlackoutDates: true,
        topN: Number.POSITIVE_INFINITY, providerTravel: false, fromActiveStop: pickerRoadCheckLive(), slotStepMinutes: OFFICE_STEP_MIN,
        arrivalWindow: { prospective: { lat: zone.center_lat, lng: zone.center_lng, estimated_duration_minutes: JOB_MIN } },
      });
      if (found.error) throw new Error(found.error);
      slots.push(...found.slots);
      unverified ||= Boolean(found.rejections_by_date?.[today]?.route_unverified);
    } catch (err) {
      errors.push(String(err.message));
    }
  }
  const { every } = await guardHintStarts(slots, {
    today, step: OFFICE_STEP_MIN, spanMin: JOB_MIN, excluded: [], every: true, perTech: true, strict: true,
  });
  const starts = new Set();
  for (const slot of every) {
    // The job begins when the van gets there (the arrival search's estimated_arrival: a start is an arrival window, so
    // the van may come after it), never before its start; the legacy finder's start is its arrival.
    const begins = Math.max(toMin(slot.start_time), slot.estimated_arrival ? toMin(slot.estimated_arrival) : 0);
    if (begins + JOB_MIN <= DISPATCH_DAY_END) starts.add(slot.start_time);
  }
  return { starts: starts.size || !(unverified || errors.length) ? [...starts].sort() : null, errors };
}

/**
 * The technicians among `techs` who cannot do the standard service, by the office list's own rule (its
 * techsLackingServices: the capability rows for the service's name; a failed read throws).
 */
async function techsLacking(techs) {
  const ids = [...techs].map(String);
  const { inactiveCapabilitiesForServices } = require('../technician-capabilities');
  const inactive = await inactiveCapabilitiesForServices(db, ids, [{ service_type: STANDARD_SERVICE_KEY }]);
  return new Set(inactive.map((row) => String(row.technician_id)));
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
 * The run reads the shared handle only, the one the decision's finder reads (decideSlotRule): it takes no connection.
 */
async function runRouteCheck({ now = new Date() } = {}) {
  const today = etDateString(now);
  const hour = etParts(now).hour;
  let run;
  try {
    run = await inSnapshot(db, (reader) => measureRun(reader, now));
  } catch (err) {
    logger.warn(`[route-check] ${today}: run failed (${err.message}); recorded`);
    run = { status: 'failed', days: [], totals: { error: String(err.message).slice(0, 200) }, ad: {} };
  }
  // A decision the run could not make, or an ask that failed, is an error of the run, as an unread campaign list is.
  if (run.status !== 'failed') {
    const decision = await decideSlotRule({ now, dates: run.totals.next.dates, crew: run.crew }).catch((err) => {
      logger.warn(`[route-check] ${today}: slot-rule decision failed (${err.message})`);
      return { mode: 'unknown', error: String(err.message).slice(0, 200) };
    });
    run.ad.decision = decision;
    if (decision.mode === 'unknown' || decision.zones?.some((z) => z.error)) run.status = 'completed_with_errors';
  }
  const written = await db(TABLE).insert({
    run_at: now, service_date: today, run_hour: hour, status: run.status,
    days: JSON.stringify(run.days), totals: JSON.stringify(run.totals), ad_shadow: JSON.stringify(run.ad),
  }).onConflict(['service_date', 'run_hour']).ignore().returning('id');
  if (!written.length) {
    const recorded = await db(TABLE).where({ service_date: today, run_hour: hour }).first('status');
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
  // Who works each measured date, for the slot-rule decision. A Sunday whose stops read failed counts every technician
  // above (its room unknown, never left out), but who works it is unknown: null.
  const crew = new Map();
  // Today's crew too, for the decision's same-day ask, by the same rule. Only a Sunday reads today's stops, its work done
  // included (sundayWorkToday).
  const todayStops = weekday(today) === 0 ? await sundayWorkToday(conn, today, await withStopsOn(today)) : new Set();
  crew.set(today, todayStops === null ? null
    : new Set(elig.techIds.filter((techId) => staffed(elig, today, techId, todayStops.has(techId)))));
  for (const day of datesToMeasure(elig, today, stopsOn)) {
    const rows = await rowsOn(day);
    const withStops = await withStopsOn(day);
    const working = elig.techIds.filter((techId) => staffed(elig, day, techId, !withStops || withStops.has(techId)));
    crew.set(day, !withStops && weekday(day) === 0 ? null : new Set(working.map(String)));
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
  return { status: failed ? 'completed_with_errors' : 'completed', days, totals, ad, crew };
}

module.exports = {
  runRouteCheck,
  _internals: {
    recoverable, physicalStops, heldSpans, unheldWork, hourSlots, simulateBookedDay, latestHomeDeparture, measureTechDay, staffed,
    datesToMeasure, summarize, unmeasurable, DISPATCH_DAY_END, decideSlotRule,
    STAFFED_DAYS, DEMAND_DAYS, STANDARD_SERVICE_KEY, PROBE_SURFACE,
  },
};
