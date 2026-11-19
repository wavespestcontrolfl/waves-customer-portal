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
 *   - the live ad rule's campaigns at that hour (`ad_shadow.live`), to compare the counts with.
 * It measures only: nothing here changes a visit, a time, a budget or a message. Every opening's start and length are
 * stored, so a rule can be counted again from the rows.
 *
 * The counts are room in the route as booked, not a booking engine's answer. This check has no customer address, so
 * it cannot ask the dispatch picker (scheduling/arrival-route.js) or the /book page whether a job fits. Either can
 * refuse a counted job (a stop already late, a route through unassigned work) or place one the count leaves out (a
 * customer near the route, a reordered route). So no budget decision is made here: that follows in its own build,
 * which checks openings with the booking engine.
 *
 * Today is not measured here. Its room depends on where the van is now, which comes in a follow-up that reuses the
 * staff placement's own reading of the stop under way (scheduling/arrival-route.js) and leaves every state it cannot
 * read unmeasured. The /book page's first day is advance_days_min days out (1 by default), so the room an ad click can
 * book online starts after today too.
 * Each day is measured as booked, from the start point at the departure minute, the way the 04:40 re-plan measures it
 * (close-gaps openTime). Drive minutes come from the scheduling drive clock (no paid map call). It runs every hour, so a
 * booking or a cancellation made during the day shows at the next hour.
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
const { simulate, coVisitGroups } = require('./app-sim');
const { promisedWindowOrder, currentOrder, staleOrderReasons, effectiveWindowRange } = require('../route-reorder-window-fit');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');

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
 * counts as its resolved interval (withResolvedWindow).
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
  return stops;
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
 * The order the technician drives (pure), the app's own rule (arrival-route.js, the 04:40 re-plan's stored baseline):
 * the stored route_order when it is a real plan (staleOrderReasons finds none), else each physical stop at its own
 * promised start, each stop's rows together.
 */
function routeOrder(rows) {
  if (rows.length && !staleOrderReasons(rows, rows, { futureDay: true }).length) return currentOrder(rows);
  const startOf = (stop) => Math.min(...stop.flat().map((r) => promisedStart(r) ?? Infinity));
  return physicalStops(rows).map((stop, i) => ({ stop, i })).sort((a, b) => startOf(a.stop) - startOf(b.stop) || a.i - b.i)
    .flatMap(({ stop }) => stop.flat());
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
 * One tech-day's openings (pure). rows: the day's stops, in any order (they run in the order the technician drives,
 * routeOrder); blocks: the technician's schedule blocks; held: booked time, as intervals; origin: the start point,
 * where the van sets off and returns. slots: jobs that start on the hour after their drive (hourSlots);
 * noticeSlots: the 07:05 notice's own count (close-gaps: whole SLOT_MIN slots), so the two can be compared.
 */
function measureTechDay({ rows, blocks, held, origin, departureMin, openMin, closeMin }) {
  // Physical stops, not services: one visit's services at one place are one stop (physicalStops).
  const stops = physicalStops(rows).length;
  const skip = unmeasurable(rows);
  if (skip) return { stops, skip };
  const sim = simulate(routeOrder(rows), { origin, departureMin, blockedIntervals: serviceBlocks(blocks) });
  if (!sim) return { stops, skip: 'NO_SIMULATION' };
  const open = openMin < closeMin
    ? gaps.openBlocks(sim, { departureMin, openMin, closeMin, unavailable: [...blocks, ...held], driveBlocks: serviceBlocks(blocks) })
    : [];
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

/** A date's live rows (the re-plan's own read: expired holds out), read once per run; null when the read failed. */
function rowReader(conn) {
  const cache = new Map();
  return async (day) => {
    if (!cache.has(day)) {
      try {
        cache.set(day, await recoverable(conn, (c) => replan.loadDayStops(c, day)));
      } catch (err) {
        logger.warn(`[route-check] ${day}: stops read failed (${err.message})`);
        cache.set(day, null);
      }
    }
    return cache.get(day);
  };
}

const techsWithStops = (rows) => new Set(rows.filter((r) => r.technician_id).map((r) => String(r.technician_id)));

/** One technician on one date, as booked. Never throws. */
async function measureOne(conn, env, { day, techId, rows, occupancy }) {
  try {
    const own = rows.filter((r) => String(r.technician_id) === techId);
    const blocks = await recoverable(conn, (c) => replan.loadBlocks(c, day, techId));
    // Time held for this technician: every booked span the booking surfaces count, exact to the minute
    // (listOccupiedWindows: make-room destinations included; a window may end off the hour).
    const held = heldSpans(occupancy, techId, env.techBlind);
    return measureTechDay({
      rows: own, blocks, held, origin: homeFromMap(env.homes, techId), departureMin: env.departureMin, openMin: DAY_OPEN, closeMin: DAY_CLOSE,
    });
  } catch (err) {
    logger.warn(`[route-check] ${day} tech ${techId}: measure failed (${err.message})`);
    return { skip: 'FAILED' };
  }
}

/**
 * One hourly run: every read in one read-only snapshot, then one route_check_runs row written outside it. A run-wide
 * read failing (technicians, blackout days, absences, start points, departure time) still writes the hour's row,
 * status 'failed', with the error in its totals.
 *
 * One row per ET hour. runExclusive stops two instances running at the same time only: a second instance (a deploy
 * overlap) whose tick waited for a lock slot can run after the first released the lock. The unique key on
 * (service_date, run_hour) keeps the first row of the hour; the second run writes nothing and returns 'duplicate'.
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
  const written = await conn(TABLE).insert({
    run_at: now, service_date: today, run_hour: hour, status: run.status,
    days: JSON.stringify(run.days), totals: JSON.stringify(run.totals), ad_shadow: JSON.stringify(run.ad),
  }).onConflict(['service_date', 'run_hour']).ignore().returning('id');
  if (!written.length) {
    logger.info(`[route-check] ${today} ${hour}:00 already recorded by another instance; this run wrote nothing`);
    return { status: 'duplicate', totals: run.totals, days: run.days.length };
  }
  if (run.status !== 'failed') {
    logger.info(`[route-check] ${run.status}: next ${run.totals.next.dates.length} staffed days slots=${run.totals.next.slots}`);
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
    recoverable, physicalStops, heldSpans, hourSlots, routeOrder, measureTechDay, staffed, datesToMeasure, summarize, unmeasurable,
    STAFFED_DAYS, DEMAND_DAYS,
  },
};
