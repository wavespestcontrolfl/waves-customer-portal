/**
 * ROUTE-TIERS nightly intra-day reorder pass (tier 3: 72h–7d band).
 *
 * For each tech-day in the band it loads the day's stops (shared day-stops
 * scaffold — the same query the trusted /optimize endpoints use), runs the
 * shared optimizeRoute, and — only when the distance saving clears the
 * configured floor — rewrites route_order transactionally using the exact
 * write the trusted admin /optimize path performs (route_order = position).
 * DAY-MOVES NEVER HAPPEN HERE: this pass only reorders stops within a day.
 *
 * Freeze rules for distance optimization:
 *   - A day containing ANY frozen visit is skipped whole — frozen = the visit
 *     starts within 72 hours OR its 72-hour reminder is recorded as sent
 *     (appointment_reminders.reminder_72h_sent; the reminder is the hard gate
 *     because its SMS promises an arrival window). Unreadable reminder status
 *     freezes the run's every day (fail closed).
 *   - Today is never touched (band starts tomorrow; the 8am day-open plus the
 *     72h clock already exclude it — the band floor makes it structural).
 *   - >25 geocoded stops for one tech-day = Google Routes cap → distance
 *     optimization is SKIPPED AND LOGGED, never silently truncated. A wholly
 *     in-process chronological repair does not call Google or use its cap.
 *
 * Zero communication sends: route_order controls the board and the tracker's
 * day-of stops-ahead count. Nothing here changes dates, arrival promises,
 * statuses, or technicians; today is excluded.
 *
 * Every run writes ONE ledger row to route_optimization_planner_runs
 * (run_type 'route_tiers_nightly') summarizing the reorders it applied/skipped
 * plus the same night's auto-dispatch day-move run (from auto_dispatch_runs /
 * auto_dispatch_audit_logs). IDs and dates only — never customer PII.
 *
 * Gates: GATE_ROUTE_REORDER (this pass) — separate from GATE_ROUTE_TIERS
 * (day-move eligibility inside auto-dispatch); both dark by default.
 * GATE_ROUTE_REORDER_REPAIR + GATE_DRIVE_TIME_CALIBRATION opt into a narrow
 * near-term repair: insert null-position timed stops into an already
 * chronological route only when this restores all existing arrival promises.
 * It uses the same fenced writer, never moves a date/window, and needs no
 * mileage gain. Unreadable reminder state and staff pins still stop repairs.
 */
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { etDateString, etParts, addETDays, parseETDateTime, validCalendarDate } = require('../utils/datetime-et');
const { dayStopsQuery, guardedCoordSelects } = require('./scheduling/day-stops');
const { toDateStr } = require('./auto-dispatch/dates');
const { effectiveServiceAddress } = require('./stamped-address');
const { loadReminderFreeze, FREEZE_HOURS, TIER2_MIN_DAYS_OUT } = require('./auto-dispatch/route-tiers');
const { computeWindowFitOrder, effectiveWindowRange, currentOrder, computeChronologicalRepair, workDuration,
  simulateArrivalRoute, isCoVisitPair, advanceCoVisit, startCoVisitChain } = require('./route-reorder-window-fit');

const GOOGLE_WAYPOINT_CAP = 25;
// The reorder pass models future days, where en_route/on_site can't occur;
// excluding them anyway keeps the set correct even on a manual re-run.
// 'rescheduled' phantoms and 'skipped' visits are not real stops (mirrors
// the candidate-slots neighbor exclusion).
// no_show included (codex GitHub round P2): it is terminal everywhere else
// (dispatch-assignment TERMINAL_STATUSES), but the admin details editor can
// still rewrite a terminal row's scheduled_date into the reorder band — an
// old missed visit must not distort savings or receive a route_order.
const EXCLUDE_STATUSES = ['cancelled', 'completed', 'skipped', 'rescheduled', 'en_route', 'on_site', 'no_show'];

// Live-hold predicate — the occupancy convention (scheduling/occupancy.js):
// an estimate-slot hold with reservation_expires_at in the past is dead
// weight awaiting the */15 cleanup DELETE and must not count as a stop.
// Between expiry and cleanup (worst case ~15 min) the nightly pass would
// otherwise route around a visit that will never happen (codex GitHub round
// P2). Applied to BOTH the membership load and the commit-time re-read so
// the two reads agree on membership.
const LIVE_HOLD_SQL = '(scheduled_services.reservation_expires_at IS NULL OR scheduled_services.reservation_expires_at > NOW())';

function intEnv(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function getRouteReorderConfig(overrides = {}) {
  return {
    // Minimum distance saving (vs the CURRENT stop order) required to apply a
    // reorder. Default 805 m ≈ 0.5 mi — modest but non-trivial, so the board
    // isn't reshuffled nightly for noise. Distance is the threshold metric
    // because optimizeRoute reports unoptimized DISTANCE (not duration) for
    // the before-side; duration is still recorded in the ledger.
    minSavingsMeters: overrides.minSavingsMeters
      ?? intEnv('ROUTE_REORDER_MIN_SAVINGS_METERS', 805, { min: 0, max: 1000000 }),
    // Blast-radius cap on applied tech-day reorders per run (auto-dispatch's
    // change-cap idea applied to this pass's unit of change).
    maxAppliesPerRun: overrides.maxAppliesPerRun
      ?? intEnv('ROUTE_REORDER_MAX_APPLIES_PER_RUN', 20, { min: 0, max: 1000 }),
  };
}

/**
 * Effective chronology anchor for a stop: window_start when set, else the
 * legacy `time_window` band mapped to its start ('morning' → 08:00,
 * 'afternoon' → 12:00 — same mapping the IB parseTimeWindowStart uses), else
 * a literal HH:MM stored in time_window. Null = genuinely unconstrained.
 * Legacy-band stops carry a real customer promise (the reminder says the
 * band), so they MUST participate in the chronology guard — window_start-only
 * left them unconstrained and a distance-optimal order could run an
 * afternoon-promised stop first (codex GitHub round P1).
 */
function effectiveWindowStart(stop) {
  if (stop.window_start) return String(stop.window_start).slice(0, 5);
  const raw = String(stop.time_window || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'morning') return '08:00';
  if (raw === 'afternoon') return '12:00';
  // Legacy rows store a literal clock, sometimes WITH a meridiem: reading
  // '4:00 PM' as 04:00 turns an afternoon promise into a morning one, which
  // can reject every order as infeasible on a future date and — on today's
  // route — mark a still-upcoming promise as already elapsed (codex round 4
  // P1). Same am/pm semantics the IB's parseTimeWindowStart uses.
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null; // 'any' / free text — no chronology promise to enforce
  let hour = parseInt(m[1], 10);
  const minute = m[2] || '00';
  if (m[3] === 'pm' && hour < 12) hour += 12;
  if (m[3] === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

/**
 * True when the proposed order provably CANNOT be driven (codex GitHub round
 * P1): the chronology guard proves timed stops stay in window-start order,
 * but the optimizer can still wedge untimed stops BETWEEN fixed windows —
 * 09:00 stop → three 60-minute untimed stops → 10:00 stop passes chronology
 * yet the tech cannot make the second window. Simulate the day under the ONE
 * best travel truth available: the optimizer's ACTUAL per-leg durations
 * (Google road minutes) when the returned legs align with the geocoded
 * sequence — the fallback haversine model is documented as underestimating
 * some trips, so preferring real legs is what makes a "pass" trustworthy
 * (uncapped audit P1) — else the shared fallback leg model. Depart HQ at
 * `startMin` (default 08:00, the nightly day-open — the admin optimize
 * endpoints pass the caller's actual ET minute-of-day for a day already in
 * progress, codex GitHub round P1: simulating from 8am when it is really
 * mid-afternoon can pass a stop that is no longer reachable in time), each
 * stop takes estimated_duration_minutes (default 60), a promised stop may
 * wait for its window to OPEN but must START no later than its arrival
 * deadline (effectiveWindowRange — the actual customer promise). The
 * simulation is optimistic (no buffers), so a failure here is a real
 * impossibility — and rejection only SKIPS the day (safe direction), never
 * writes.
 */
function violatesWindowFeasibility(RouteOptimizer, orderedStops, sourceStops, legs, startMin = 8 * 60, origin = RouteOptimizer.HQ) {
  const byId = new Map(sourceStops.map((s) => [s.id, s]));
  const geocodedCount = orderedStops.filter((o) => {
    const s = byId.get(o.id) || o;
    return parseFloat(s.lat) && parseFloat(s.lng);
  }).length;
  // legs[0] = HQ→stop1, legs[i] = stop(i)→stop(i+1) over the GEOCODED
  // sequence (coordless stops are appended with no legs); usable only when
  // every arrival leg is present and numeric.
  const useLegs = Array.isArray(legs)
    && legs.length >= geocodedCount
    && legs.slice(0, geocodedCount).every((l) => Number.isFinite(l?.durationMinutes));
  let clock = startMin; // minute-of-day, caller-supplied day open
  let prev = origin; // HQ, or the truck's real position on a day in progress
  let prevStop = null; // for the co-visit check below (route-reorder-window-fit.js)
  let prevArrivalMin = null;
  let coFloor = 0; // longest window-derived duration in the current co-visit chain
  let coEstimates = 0; // sum of that chain's real estimates — see coVisitWork
  let coMerged = 0; // minutes already charged for the chain, so advanceCoVisit adds only the delta
  let geoIdx = 0;
  for (const stop of orderedStops) {
    const s = byId.get(stop.id) || stop;
    const lat = parseFloat(s.lat);
    const lng = parseFloat(s.lng);
    let travelMin = 0;
    if (lat && lng) {
      // Still consumed even for a co-visit continuation below: legs[] is
      // Google's ACTUAL per-waypoint sequence (it drove the co-visit's
      // second waypoint too, typically a ~0 leg since the coords match) —
      // skipping the index here would misalign every leg after it.
      travelMin = useLegs
        ? legs[geoIdx].durationMinutes
        : (RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(prev.lat, prev.lng, lat, lng)).minutes || 0);
      geoIdx += 1;
      prev = { lat, lng };
    }
    // PHANTOM-HOUR FIX (Sat 2026-09-12, two same-slot pest+lawn pairs):
    // one customer's two same-slot service rows were each charged a full
    // workDuration and summed, simulating 2h on site for a 1h promise —
    // mirrors advanceSim's co-visit branch in route-reorder-window-fit.js.
    // No new leg is consumed for TIMING (travelMin above is computed only
    // to keep geoIdx aligned); arrival stays pinned to the sibling's
    // already-proven arrival, and the chain's on-site time is the sum of its
    // real estimates floored by the longest window-derived duration — see
    // coVisitWork in route-reorder-window-fit.js for why neither the plain
    // sum (the phantom hour) nor the plain max (under-counted real work) is
    // the honest number.
    if (prevStop && isCoVisitPair(effectiveWindowRange, prevStop, s)) {
      // One shared arithmetic, not a second copy of it — this loop walks
      // Google's legs itself so it cannot call advanceSim wholesale, but the
      // merge's timing comes from the same function advanceSim uses.
      const merged = advanceCoVisit({ clock, arrivalMin: prevArrivalMin, coFloor, coEstimates, coMerged }, s);
      ({ clock, coFloor, coEstimates, coMerged } = merged);
      prevStop = s;
      continue; // prevArrivalMin stays pinned to the sibling's arrival
    }
    let startMin = clock + travelMin;
    const range = effectiveWindowRange(s);
    if (range) {
      if (startMin > range.endMin) return true; // provably misses the promise
      startMin = Math.max(startMin, range.startMin); // waiting for open is fine
    }
    ({ coFloor, coEstimates, coMerged } = startCoVisitChain(s));
    clock = startMin + coMerged;
    prevStop = s;
    prevArrivalMin = startMin;
  }
  return false;
}

/**
 * Distance of an ordered stop sequence (HQ → stops → HQ) under the ONE shared
 * in-house model (route-optimizer's haversine legs through fallbackLegMetrics,
 * which is gate-consistent for meters). Savings decisions must compare BEFORE
 * and AFTER under the SAME model: optimizeRoute's own reported numbers mix
 * models (unoptimized = raw straight-line, optimized = Google road meters or
 * the road-factored fallback), so subtracting them is not a like-for-like
 * saving (codex round-2 P1). Google/fallback still choose the ORDER; this
 * model decides whether that order is worth writing. Coordless stops
 * contribute nothing on either side.
 */
function modelDistanceMeters(RouteOptimizer, orderedStops, origin = RouteOptimizer.HQ) {
  let prev = origin;
  let total = 0;
  for (const s of orderedStops) {
    const lat = parseFloat(s.lat);
    const lng = parseFloat(s.lng);
    if (!lat || !lng) continue;
    total += RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(prev.lat, prev.lng, lat, lng)).meters;
    prev = { lat, lng };
  }
  total += RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(prev.lat, prev.lng, RouteOptimizer.HQ.lat, RouteOptimizer.HQ.lng)).meters;
  return total;
}

/** Drive MINUTES for the same HQ → stops → HQ loop under the same shared
 *  model — the duration mirror of modelDistanceMeters, so a caller that sums
 *  a bucket's mileage can report its driving time from the same legs rather
 *  than charging it zero (codex round 4 P1). */
function modelDriveMinutes(RouteOptimizer, orderedStops, origin = RouteOptimizer.HQ) {
  let prev = origin;
  let total = 0;
  for (const s of orderedStops) {
    const lat = parseFloat(s.lat);
    const lng = parseFloat(s.lng);
    if (!lat || !lng) continue;
    total += RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(prev.lat, prev.lng, lat, lng)).minutes || 0;
    prev = { lat, lng };
  }
  total += RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(prev.lat, prev.lng, RouteOptimizer.HQ.lat, RouteOptimizer.HQ.lng)).minutes || 0;
  return total;
}

/**
 * True when the proposed stop order contradicts the stops' window chronology:
 * any stop with a fixed effective start (window_start OR legacy time_window
 * band) placed AFTER a stop whose effective start is later. Stops with no
 * effective start are unconstrained. Ties are fine (same window = same band,
 * any order works). Band starts vs exact starts compare coarsely — a false
 * positive only skips the day's reorder (safe direction), never writes an
 * order the tech cannot drive.
 */
function violatesWindowChronology(orderedStops, sourceStops) {
  const windowById = new Map(sourceStops.map((s) => [s.id, effectiveWindowStart(s)]));
  let lastWindow = null;
  for (const stop of orderedStops) {
    const win = windowById.get(stop.id);
    if (!win) continue;
    if (lastWindow != null && win < lastWindow) return true;
    lastWindow = win;
  }
  return false;
}

/** True when the visit starts within FREEZE_HOURS of `now` (windowless visits
 *  freeze off the canonical 08:00 slot time the reminder system uses). */
function withinFreezeClock(dateStr, windowStart, now) {
  const start = String(windowStart || '08:00').slice(0, 5);
  const appt = parseETDateTime(`${dateStr}T${start}:00`);
  if (!appt || Number.isNaN(appt.getTime())) return true; // unparseable ⇒ frozen (fail closed)
  return appt.getTime() - now.getTime() < FREEZE_HOURS * 3600000;
}

/**
 * Simulation clock for a date that may be ALREADY IN PROGRESS — null for any
 * date other than today, which is byte-for-byte the pre-fix behavior. Shared
 * by every caller that can be asked to optimize "today" (the two admin
 * optimize endpoints and the Intelligence Bar's two route tools); the nightly
 * pass never runs today, so it passes nothing.
 */
function inProgressStartMin(dateStr, now = new Date()) {
  if (dateStr !== etDateString(now)) return null;
  const { hour, minute } = etParts(now);
  return hour * 60 + minute;
}

/**
 * Statuses that are DONE with (dispatch-assignment.js's own terminal set,
 * plus the board-hidden 'rescheduled'): they are not part of the route to
 * drive, so they must not be guarded, scored, or allowed to veto the day.
 * The callers' queries exclude only cancelled/completed, so a stale skipped
 * or no_show row without coordinates would otherwise disable optimization
 * for every live stop on that tech-day (codex round 4 P2).
 */
const OFF_ROUTE_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled']);

function onRoute(stop) {
  return !OFF_ROUTE_STATUSES.has(stop.status);
}

/** A stop the technician has already started. The staff picker refuses to
 *  verify a route containing one (arrival-route.js's own `own.some(...)`
 *  check) for the same reason the guard does below: the simulation restarts
 *  at HQ and recharges the full service, so it can move the stop being
 *  worked or call the rest of the day infeasible. */
function isLiveStop(stop) {
  return ['en_route', 'on_site'].includes(stop.status);
}

/**
 * A promised window whose deadline has ALREADY PASSED relative to `startMin`
 * (the admin optimize endpoints' "today, already in progress" simulation
 * clock — see chooseWindowSafeOrder) is not a promise the chosen order can
 * still keep OR break: forcing it ahead of a still-achievable later window
 * (the chronology guard's whole job) only sinks that later promise for
 * nothing, and holding it to a deadline that is already unreachable rejects
 * every candidate order on an already-lost cause (codex GitHub round P1 — the
 * concrete case: 15:30, an overdue 09:00 stop, an achievable 16:00 stop).
 * Relaxed to unconstrained for GUARD purposes only — the stop is still
 * visited and still costs travel/service time, it just no longer dictates
 * order or a deadline. A no-op (returns `sourceStops` unchanged) when
 * `startMin` is null — the nightly pass never passes it, since today is
 * structurally excluded from its band and every future-day call already
 * starts fresh at 08:00.
 */
function relaxElapsedWindows(sourceStops, startMin) {
  if (startMin == null) return sourceStops;
  return sourceStops.map((s) => {
    const range = effectiveWindowRange(s);
    // STRICTLY past: the feasibility rule lets a stop START at endMin, so a
    // promise is still keepable at its deadline minute itself (codex round 5
    // P2) — relaxing it there would let another stop take its place.
    if (!range || range.endMin >= startMin) return s;
    // Only the ARRIVAL constraint is relaxed. workDuration falls back to the
    // window SPAN when a row has no estimate (or a shorter one), so clearing
    // the window fields would also shrink a 09:00-12:00 job to an hour and
    // let the repair declare a later promise reachable that is not (codex
    // round 2 P1). Carry the span forward as the stop's duration first.
    // raw_estimate_minutes goes with it: the carried-forward SPAN is not a
    // real service estimate, and a relaxed co-visit pair would otherwise sum
    // two of them straight back into the phantom hour (#4435's coVisitWork).
    return { ...s,
      // The window SPAN becomes the duration (so relaxing a deadline cannot
      // shrink the work), while the row's REAL estimate travels untouched:
      // nulling it made a bundle of two genuine 60-minute services count as
      // 60 minutes rather than 120 (codex #4430 r5 P1). Span-only rows have
      // no real estimate, so nothing is invented for them either.
      estimated_duration_minutes: workDuration(s),
      raw_estimate_minutes: Number(s.estimated_duration_minutes) || 0,
      // The promise itself is gone, but the fact that these rows SHARED one
      // is what makes a bundle a single physical stop — carry it across, or
      // an overdue pest+lawn pair is charged two hours again (#4435's
      // isCoVisitPair; codex #4430 r5 P1).
      co_visit_window_key: `${range.startMin}-${range.endMin}`,
      window_start: null, window_end: null, time_window: null };
  });
}

/** True only when the optimizer returned REAL road durations: a Google
 *  source, a non-empty leg list, and a finite duration on every leg. The
 *  nearest-neighbour and single_stop paths return model-derived legs, which
 *  are exactly what the calibration gate exists to distrust. */
function hasLiveLegs(googleSource, legs, orderedStops, sourceById) {
  if (!String(googleSource || '').startsWith('google')) return false;
  if (!Array.isArray(legs) || legs.length === 0) return false;
  // ENOUGH legs, not merely some: violatesWindowFeasibility refuses a list
  // shorter than the geocoded stop count and silently falls back to the
  // model, so a short list is not the live evidence it looks like (codex
  // round 5 P1). Same count that guard computes.
  const geocoded = orderedStops.filter((stop) => {
    const row = (sourceById && sourceById.get(stop.id)) || stop;
    return parseFloat(row.lat) && parseFloat(row.lng);
  }).length;
  if (legs.length < geocoded) return false;
  return legs.slice(0, geocoded).every((leg) => Number.isFinite(leg?.durationMinutes));
}

/**
 * What the guard is actually allowed to reason about: the stops that will be
 * DRIVEN, and the travel numbers that describe them.
 *
 * Terminal rows ride along in every caller's day query but are not driven, so
 * they are filtered out entirely — not guarded, not scored, not reordered.
 * Google's legs are POSITIONAL against the sequence it returned and measured
 * FROM HQ, so either dropping a stop from that sequence (codex round 4 P1) or
 * simulating from the truck's real position (round 5 P1) makes them describe
 * a drive nobody takes; in both cases the shared fallback leg model is the
 * honest answer.
 */
function driveableInputs({ rawGoogleOrder, rawSourceStops, rawLegs, origin }) {
  const sourceStops = rawSourceStops.filter(onRoute);
  const liveIds = new Set(sourceStops.map((s) => s.id));
  const googleOrder = rawGoogleOrder.filter((s) => liveIds.has(s.id));
  const aligned = googleOrder.length === rawGoogleOrder.length && !origin;
  return { sourceStops, googleOrder, legs: aligned ? rawLegs : null };
}

/** Which gate stands the window-fit repair down, or null when both are on.
 *  WINDOW_FIT is reported first: it is the switch for the repair itself,
 *  while CALIBRATION is the model the repair's safety case rests on. */
function gateOffReason() {
  if (!gateEnvValue('GATE_ROUTE_REORDER_WINDOW_FIT')) return 'WINDOW_FIT';
  if (!gateEnvValue('GATE_DRIVE_TIME_CALIBRATION')) return 'CALIBRATION';
  return null;
}

/**
 * Reasons a day cannot be certified at all — checked before any order is
 * accepted or repaired, because none of them are about the ORDER:
 *  - a tech-day already being driven has a real truck position and unknown
 *    remaining work, and every order here would renumber the live stop (the
 *    same call arrival-route.js's own route check makes);
 *  - an ungeocoded stop's travel counts as zero in both the simulation and
 *    the distance model, so "feasible" is not knowable;
 *  - a pass without LIVE road durations rests on the in-house model, which
 *    the fallback's owner ruling requires to be calibrated.
 */
function uncertifiableReason({ sourceStops, startMin, googleSource, legs, requireCalibratedModel, googleOrder, sourceById }) {
  if (startMin != null && sourceStops.some(isLiveStop)) return 'LIVE_STOP_IN_PROGRESS';
  if (sourceStops.some((s) => !(parseFloat(s.lat) && parseFloat(s.lng)))) return 'COORDLESS_STOPS';
  if (requireCalibratedModel && !hasLiveLegs(googleSource, legs, googleOrder, sourceById)
    && !gateEnvValue('GATE_DRIVE_TIME_CALIBRATION')) return 'MODEL_UNCALIBRATED';
  return null;
}

/**
 * Shared "never write an order that breaks a promise" decision — pulled out
 * so the trusted admin buttons (POST /optimize, /optimize-route in
 * admin-schedule.js) apply the EXACT SAME chronology + feasibility guards
 * and window-fit fallback as this nightly pass, instead of writing Google's
 * shortest loop unchecked. Motivating defect: a 2026-09-12/13/14 read-only
 * preview of the admin buttons showed Google's order putting a 16:00-promised
 * stop FIRST and a 10:00 stop SIXTH — 5-19 mi WORSE than window order — while
 * the endpoint reported it as a "savings". This function is pure (no gates
 * read beyond GATE_ROUTE_REORDER_WINDOW_FIT / GATE_DRIVE_TIME_CALIBRATION,
 * no db, no writes) so both callers — this pass's runRouteReorder below AND
 * the admin routes — stay on the SAME decision (codex GitHub round P1: an
 * earlier revision left runRouteReorder running its own parallel chronology
 * /feasibility/fallback implementation instead of calling this).
 *
 * `googleOrder` = the ordered stops to validate (Google's/optimizeRoute's
 * result, or — for a multi-tech admin call — one technician's slice of it).
 * `sourceStops` = that SAME tech-day's full stop rows (guard + fallback
 * input: id, window_start, window_end, time_window,
 * estimated_duration_minutes, route_order, created_at, lat, lng — the
 * nightly pass's own day-load select). `legs` = Google's per-leg durations,
 * ONLY when they align 1:1 with `googleOrder` (a multi-tech flat sequence's
 * legs do NOT align to one tech's extracted slice — pass null there; see
 * violatesWindowFeasibility's own alignment check for why a misaligned leg
 * list must never be trusted). `startMin` (default null ⇒ 08:00, the nightly
 * day-open) is the admin-only "day already in progress" simulation clock —
 * pass the caller's actual ET minute-of-day only when the requested date IS
 * today; leave it null for every future-day call (nightly and admin alike),
 * which reproduces today's behavior exactly. It is used two ways, and they
 * are NOT the same number: the simulation clock is floored at the 08:00 day
 * open, while whether a promise has already elapsed is judged on the raw
 * minute.
 *
 * Returns one of:
 *   { orderedStops, source, conflict: null }                    — write it
 *   { orderedStops: null, reason, conflict, beforeMeters }       — DO NOT WRITE
 * `reason` is 'WINDOW_FIT_GATE_OFF' (either gate is off — no repair was even
 * attempted; `gateOff` says which: 'WINDOW_FIT' or 'CALIBRATION' — nightly-only
 * bookkeeping, admin's response contract keeps using the combined `reason`),
 * 'COORDLESS_STOPS' (a source stop lacks usable coordinates — both the
 * feasibility simulation and the distance model would treat its travel as
 * zero, so a fallback built on it is not trustworthy; fail closed before
 * attempting the repair, codex GitHub round P1), or 'NO_FEASIBLE_IMPROVEMENT'
 * (gates on, coordinates present, the search ran, no legal order exists) —
 * the actionable "why didn't this get fixed". `conflict` — always present,
 * null when Google's order was legal — is 'WINDOW_ORDER_CONFLICT' or
 * 'WINDOW_FIT_CONFLICT': which guard Google's order actually failed, for the
 * UI detail line (admin) and the skip reason (nightly, which additionally
 * applies its own min-savings floor on top of this decision — see
 * runRouteReorder).
 */
function chooseWindowSafeOrder({
  RouteOptimizer, googleOrder: rawGoogleOrder, sourceStops: rawSourceStops, googleSource, legs: rawLegs = null,
  startMin = null, origin = null, requireCalibratedModel = false, elapsedCutoffMin,
}) {
  const { sourceStops, googleOrder, legs } = driveableInputs({ rawGoogleOrder, rawSourceStops, rawLegs, origin });
  // beforeMeters (current running order, same model as the nightly ledger's
  // before_distance_meters) rides on EVERY return — a caller aggregating
  // several tech-days in one response (the multi-tech /optimize endpoint)
  // can always sum per-tech-day beforeMeters/afterMeters/afterSeconds
  // straight from this return, rather than falling back to a flat,
  // truck-blind list that conflates separate trucks into one fictitious
  // route (pre-push audit P1 — the exact "wrong savings number" defect
  // class this whole change exists to close).
  const from = origin || RouteOptimizer.HQ;
  const beforeMeters = modelDistanceMeters(RouteOptimizer, currentOrder(sourceStops), from);
  // The simulation clock never runs EARLIER than the 08:00 day open — a
  // 07:00 request must not be told the truck can spend that hour driving and
  // mark an 08:00 promise reachable (codex round 2 P1). The elapsed-window
  // test below deliberately keeps the RAW minute instead: a 06:00-07:30
  // promise is not elapsed at 07:00 just because the model's day starts at
  // 08:00.
  const simStart = startMin == null ? 8 * 60 : Math.max(8 * 60, startMin);
  // A promise that expires WHILE we wait for locks must not become
  // unconstrained: a commit-time recheck advances the simulation clock but
  // keeps the cutoff the decision was made under (codex round 5 P1).
  const guardStops = relaxElapsedWindows(sourceStops, elapsedCutoffMin === undefined ? startMin : elapsedCutoffMin);
  // Every guard AND every figure below reads windows through this, never
  // through effectiveWindowRange directly: a stop whose promise already
  // elapsed was accepted under the relaxed range, so re-simulating it under
  // its true (unreachable) deadline would return null for an order the same
  // function just declared legal — and a null afterSeconds is summed as zero
  // by the multi-tech caller, silently under-reporting a truck's drive time
  // (round-0 fallback audit P1).
  const relaxedById = new Map(guardStops.map((s) => [s.id, s]));
  const sourceById = new Map(sourceStops.map((s) => [s.id, s]));
  const guardRange = (s) => effectiveWindowRange(relaxedById.get(s.id) || s);
  const relaxed = (order) => order.map((stop) => relaxedById.get(stop.id) || stop);
  const chronoConflict = violatesWindowChronology(googleOrder, guardStops);
  const fitConflict = !chronoConflict && violatesWindowFeasibility(RouteOptimizer, googleOrder, guardStops, legs, simStart, from);
  const conflict = chronoConflict ? 'WINDOW_ORDER_CONFLICT' : (fitConflict ? 'WINDOW_FIT_CONFLICT' : null);
  // Reasons this day cannot be certified AT ALL, whatever the order says.
  const blocked = uncertifiableReason({ sourceStops, startMin, googleSource, legs, requireCalibratedModel, googleOrder, sourceById });
  if (blocked) return { orderedStops: null, reason: blocked, conflict, beforeMeters };
  if (!chronoConflict && !fitConflict) {
    // Google's order is legal — still score it under the shared model (NOT
    // Google's own road-routed numbers) so a caller that has to AGGREGATE
    // this tech-day alongside a repaired one is comparing apples to apples;
    // a single-tech caller that wants Google's own reported numbers for an
    // unrepaired day keeps using its own `result.*` fields, unaffected by
    // these — see admin-schedule.js's two callers.
    // The RELAXED rows, not the stored ones: advanceSim reads the co-visit
    // identity off the stop objects it is handed, so simulating the originals
    // makes an overdue bundle look like separate visits, and a null sim is
    // reported as zero drive time for that whole truck (codex round 5 P1).
    const sim = simulateArrivalRoute(RouteOptimizer, guardRange, relaxed(googleOrder), { startMin: simStart, origin: from });
    return {
      orderedStops: googleOrder,
      source: googleSource,
      conflict,
      beforeMeters,
      afterMeters: modelDistanceMeters(RouteOptimizer, googleOrder, from),
      // null only if a legal order somehow fails the same-model simulation
      // the guards themselves already vetted — belt and suspenders.
      afterSeconds: sim ? Math.round(sim.travelMin * 60) : null,
    };
  }
  const gatesOff = gateOffReason();
  if (gatesOff) {
    return { orderedStops: null, reason: 'WINDOW_FIT_GATE_OFF', conflict, beforeMeters, gateOff: gatesOff };
  }
  const fallback = computeWindowFitOrder(RouteOptimizer, currentOrder(guardStops), {
    effectiveWindowStart, effectiveWindowRange: guardRange, violatesWindowChronology, violatesWindowFeasibility, modelDistanceMeters,
  }, { startMin: simStart, origin: from });
  if (!fallback) {
    return { orderedStops: null, reason: 'NO_FEASIBLE_IMPROVEMENT', conflict, beforeMeters };
  }
  return {
    // The winner is mapped back to the STORED rows: the relaxed copies exist
    // only for simulation, and serializing one would tell the caller an
    // appointment has no promised window when the database still holds it
    // (codex round 5 P2).
    orderedStops: fallback.orderedStops.map((stop) => sourceById.get(stop.id) || stop),
    source: 'window_constrained',
    conflict,
    beforeMeters,
    afterMeters: fallback.afterMeters,
    afterSeconds: fallback.afterSeconds,
  };
}

/**
 * Guard-input columns EVERY route_order writer loads and re-reads under the
 * tech-day lock, and the signature over them. Kept as one list so the
 * day-load snapshot and the post-lock re-read can never disagree about which
 * columns exist (a column present on one side only would read as a permanent
 * "changed" and abort every write).
 */
const ROUTE_WRITE_GUARD_COLUMNS = ['window_start', 'window_end', 'time_window',
  'estimated_duration_minutes', 'auto_dispatch_locked', 'auto_dispatch_excluded', 'visit_id',
  // status: a stop that goes en_route/on_site mid-optimize makes the order
  // unwritable (chooseWindowSafeOrder refuses a live tech-day for today).
  'status',
  // route_order too, exactly as the nightly fence snapshots it: the CURRENT
  // running order is a guard input, not just a thing being overwritten — it
  // is the window-fit repair's backbone and the `unoptimizedDistanceMeters`
  // the response reports. An operator drag landing in the gap would
  // otherwise be clobbered by an order computed against the sequence it
  // replaced (round-0 fallback audit P1).
  'route_order',
  // The co-visit merge's own identity inputs (#4435's isCoVisitPair): without
  // them the guard counts a customer's two same-slot rows at one property as
  // two full visits and can refuse a legal day — and a signature that hashes
  // them must find them on BOTH sides of the lock, or every write aborts as
  // stale (codex round 5 P1).
  'customer_id', 'service_address_line1', 'service_address_line2',
  'service_address_city', 'service_address_zip'];

/** The customer's primary premise, aliased the way effectiveServiceAddress
 *  (and stampedAddressDiverges) expect. An UNSTAMPED row resolves its premise
 *  through these, so every query feeding the guard or the fence selects them
 *  alongside ROUTE_WRITE_GUARD_COLUMNS. */
const CUSTOMER_PREMISE_ALIASES = [{
  customer_address_line1: 'customers.address_line1',
  customer_address_line2: 'customers.address_line2',
  customer_city: 'customers.city',
  customer_state: 'customers.state',
  customer_zip: 'customers.zip',
}];

/**
 * The signature a route_order writer snapshots at day-load and compares under
 * the tech-day lock: the window guard's own inputs plus the running order,
 * the live status, and the effective pin. An appointment re-promised, dragged,
 * started, or re-geocoded in that gap invalidates the order computed for it.
 */
function routeWriteGuardSignature(stop) {
  // Effective coordinates too, exactly as the nightly fence snapshots them:
  // an address edit or a fresh geocode landing in the lock gap changes both
  // the distance the response reports and the arrival feasibility the guard
  // just certified (codex round 3 P2).
  const num = (v) => (v == null || v === '' ? '' : parseFloat(v));
  return [windowGuardSignature(stop), stop.route_order == null ? '' : Number(stop.route_order),
    stop.status ?? '', num(stop.lat), num(stop.lng)].join('|');
}

/**
 * Where each technician's truck ACTUALLY is when a day already in progress is
 * re-optimized. A completed stop is excluded from every caller's day query, so
 * without this the guard would model the first remaining leg from HQ and could
 * certify an order that cannot make its next promise (codex round 5 P1).
 *
 * Returns { origins, unknown }: the last completed stop's coordinates per
 * technician, and the technicians whose day has started but whose position
 * cannot be established (completed rows exist, none geocoded) — those refuse
 * rather than pretend the truck is at HQ. Empty for any date but today, where
 * every route starts at HQ by definition.
 */
async function loadTechDayOrigins(conn, dateStr, { technicianId = null, now = new Date(), lock = false } = {}) {
  const origins = new Map();
  const unknown = new Set();
  if (dateStr !== etDateString(now)) return { origins, unknown };
  const rows = await conn('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.scheduled_date', dateStr)
    .where('scheduled_services.status', 'completed')
    .whereNotNull('scheduled_services.technician_id')
    .modify((q) => (technicianId ? q.where('scheduled_services.technician_id', technicianId) : q))
    .select('scheduled_services.id', 'scheduled_services.technician_id', 'scheduled_services.route_order',
      'scheduled_services.check_out_time', 'scheduled_services.actual_end_time', 'scheduled_services.completed_at',
      ...guardedCoordSelects(conn))
    // Inside the write transaction the completed rows are LOCKED and stay
    // locked through the route_order writes: the time-on-site correction
    // endpoint takes only that row's lock, not the tech-day advisory lock, so
    // an unlocked re-read could still be overtaken between check and commit
    // (codex round 5 P1).
    .modify((q) => (lock ? q.forUpdate('scheduled_services') : q));
  const byTech = new Map();
  for (const row of rows) {
    if (!byTech.has(row.technician_id)) byTech.set(row.technician_id, []);
    byTech.get(row.technician_id).push(row);
  }
  for (const [techId, techRows] of byTech) {
    // SAME rule arrival-route.js's own current-day resolver applies: a
    // completed row with no completion time makes the order of completions
    // unprovable, and route_order is commonly null — guessing from query
    // order could start the route at a stop the truck left hours ago (codex
    // round 5 P1). Any unstamped completion ⇒ the position is unknown.
    const completed = techRows.map((row) => ({
      ...row, completionTime: row.actual_end_time || row.check_out_time || row.completed_at,
    }));
    if (completed.some((row) => !row.completionTime)) { unknown.add(techId); continue; }
    completed.sort((a, b) => new Date(b.completionTime) - new Date(a.completionTime));
    // The LATEST completion is where the truck is. No pin there means the
    // position is unknown too — an earlier stop is where it USED to be, and
    // driving from there is a guess the guard must not make.
    const last = completed[0];
    if (last && parseFloat(last.lat) && parseFloat(last.lng)) {
      origins.set(techId, { id: last.id, completionTime: String(last.completionTime), lat: parseFloat(last.lat), lng: parseFloat(last.lng) });
    } else {
      unknown.add(techId);
    }
  }
  return { origins, unknown };
}

/**
 * Re-read the completed rows the origins were derived from, inside the write
 * transaction, and confirm they still point at the same truck positions. A
 * completed visit is NOT in the freshness fence's locked set (that reads the
 * live day), so an after-the-fact time-on-site correction can change WHICH
 * completion is latest between the origin read and the commit, leaving the
 * order certified from a stop the truck left earlier (codex round 5 P2).
 * Throws the caller's stale error when anything moved.
 */
async function assertTechDayOriginsFresh(trx, dateStr, techDayOrigins, { technicianId = null, now = new Date(), stale } = {}) {
  if (!techDayOrigins || (techDayOrigins.origins.size === 0 && techDayOrigins.unknown.size === 0)) return;
  const fresh = await loadTechDayOrigins(trx, dateStr, { technicianId, now, lock: true });
  const result = fresh;
  const same = (a, b) => (!a && !b)
    || Boolean(a && b && a.id === b.id && a.completionTime === b.completionTime
      && a.lat === b.lat && a.lng === b.lng);
  const techIds = new Set([...techDayOrigins.origins.keys(), ...techDayOrigins.unknown,
    ...fresh.origins.keys(), ...fresh.unknown]);
  for (const techId of techIds) {
    if (techDayOrigins.unknown.has(techId) !== fresh.unknown.has(techId)
      || !same(techDayOrigins.origins.get(techId), fresh.origins.get(techId))) {
      throw stale ? stale(techId) : Object.assign(new Error('completed-stop origin changed while optimizing'), { code: 'STALE_OPTIMIZE' });
    }
  }
  return result;
}

/**
 * THE per-tech-day application of chooseWindowSafeOrder — one mechanism for
 * every writer that hands Google a whole board and writes route_order back
 * (the two admin optimize endpoints and the Intelligence Bar's two route
 * tools). A promised arrival window is a promise to whichever truck drives
 * it, so Google's flat multi-tech sequence has to be sliced into tech-days
 * before the chronology/feasibility guards mean anything; each tech's
 * resolved slice is substituted back into its own slots, so untouched techs
 * and unassigned stops keep their exact positions.
 *
 * `orderedStops` may be trimmed optimizer objects — the guard reads its
 * window inputs from `sourceStops` by id, and the result is returned as
 * `orderedIds` so each caller can rebuild its own row shape.
 *
 * One unrepairable tech-day refuses the WHOLE request ({ refusal }) rather
 * than half-writing another tech's fine segment.
 */
function resolveWindowSafeOrderByTechDay({ RouteOptimizer, orderedStops, sourceStops, googleSource, legs = null,
  startMin = null, techDayOrigins = null, requireCalibratedModel = true, elapsedCutoffMin }) {
  const sourceById = new Map(sourceStops.map((s) => [s.id, s]));
  const byTech = new Map();
  for (const s of sourceStops) {
    // Terminal rows are not driven — they keep their slot and are neither
    // guarded nor reordered (see OFF_ROUTE_STATUSES).
    if (!s.technician_id || !onRoute(s)) continue;
    if (!byTech.has(s.technician_id)) byTech.set(s.technician_id, []);
    byTech.get(s.technician_id).push(s);
  }
  // Google's legs describe the FLAT sequence — they line up with a
  // technician's extracted slice only when that slice IS the flat sequence:
  // one tech on the call AND no unassigned stops interleaved (an unassigned
  // stop shifts every leg after it, and the feasibility guard's length check
  // is >=, so a longer flat list would be indexed positionally). Misaligned
  // legs are never trusted — the guard uses the shared fallback model.
  const legsAlign = byTech.size <= 1 && sourceStops.every((s) => s.technician_id && onRoute(s)) ? legs : null;
  const resolvedByTech = new Map();
  for (const [techId, techStops] of byTech) {
    const ids = new Set(techStops.map((s) => s.id));
    const slice = orderedStops.filter((s) => ids.has(s.id)).map((s) => sourceById.get(s.id));
    if (techDayOrigins && techDayOrigins.unknown.has(techId)) {
      // The day has started but the truck cannot be located — see
      // loadTechDayOrigins.
      return { refusal: { technicianId: techId, orderedStops: null, reason: 'PROGRESS_ORIGIN_UNKNOWN', conflict: null, beforeMeters: 0 } };
    }
    const outcome = chooseWindowSafeOrder({
      RouteOptimizer, googleOrder: slice, sourceStops: techStops, googleSource, legs: legsAlign, startMin,
      origin: techDayOrigins ? techDayOrigins.origins.get(techId) || null : null,
      requireCalibratedModel, elapsedCutoffMin,
    });
    if (!outcome.orderedStops) return { refusal: { technicianId: techId, ...outcome } };
    resolvedByTech.set(techId, outcome);
  }
  const queues = new Map([...resolvedByTech].map(([id, o]) => [id, [...o.orderedStops]]));
  const orderedIds = orderedStops.map((s) => {
    const source = sourceById.get(s.id);
    const queue = source && onRoute(source) && source.technician_id && queues.get(source.technician_id);
    return queue && queue.length ? queue.shift().id : s.id;
  });
  return {
    orderedIds,
    resolvedByTech,
    anyWindowConstrained: [...resolvedByTech.values()].some((o) => o.source === 'window_constrained'),
    // TRUE whenever the route we will write is not the route the optimizer
    // scored — a terminal stop dropped out of it, or it starts from the truck
    // instead of HQ. Google's own totals and legs then describe a different
    // drive, so the caller must report OUR model's figures even when no
    // window repair happened (codex round 5 P1).
    scoredRouteChanged: sourceStops.some((s) => !onRoute(s))
      || Boolean(techDayOrigins && techDayOrigins.origins.size > 0),
    // In written order, for windowSafeFigures' unassigned bucket.
    unassigned: {
      RouteOptimizer,
      stops: orderedIds.map((id) => sourceById.get(id))
        .filter((s) => s && onRoute(s) && !s.technician_id && parseFloat(s.lat) && parseFloat(s.lng)),
    },
  };
}

/**
 * The distance/duration figures a route-writing caller reports. When every tech-day passed the
 * guards unchanged they are Google's own reported numbers, byte-identical to
 * before the guard existed. When any tech-day was window-fit-repaired they
 * are summed PER TECH-DAY from chooseWindowSafeOrder's own before/after
 * figures under the SAME shared model the repair scored against: Google's
 * numbers describe an order that was never written, and scoring the flat
 * multi-tech list as one route would chain truck A's last stop to truck B's
 * first and report a leg nobody drives. Unassigned stops have no tech-day and
 * are left out of the sum, exactly as they are left out of the guards.
 */
function windowSafeFigures(result, resolvedByTech, ownFigures, unassigned = null) {
  // `ownFigures`: report OUR model rather than Google's — true when a
  // tech-day was repaired AND when the scored route changed under us (see
  // resolveWindowSafeOrderByTechDay's scoredRouteChanged).
  const anyWindowConstrained = ownFigures;
  const outcomes = [...resolvedByTech.values()];
  // Geocoded stops with no technician have no tech-day to guard, but they ARE
  // in the order that gets written and displayed, so leaving their legs out
  // of a repaired day's totals understates what is driven (codex round 4 P2).
  // Scored as their own bucket under the same shared model, before and after
  // alike — their sequence is untouched by the repair, so the two cancel in
  // `saved`, which is exactly right: no saving is claimed for them.
  const hasUnassigned = anyWindowConstrained && unassigned && unassigned.stops.length > 0;
  const unassignedMeters = hasUnassigned ? modelDistanceMeters(unassigned.RouteOptimizer, unassigned.stops) : 0;
  // Its driving TIME too, from the same legs — reporting the bucket's mileage
  // while charging it zero minutes understates the day (codex round 4 P1).
  const unassignedMinutes = hasUnassigned ? modelDriveMinutes(unassigned.RouteOptimizer, unassigned.stops) : 0;
  const totalDistanceMeters = anyWindowConstrained
    ? outcomes.reduce((sum, o) => sum + (o.afterMeters || 0), 0) + unassignedMeters
    : result.totalDistanceMeters;
  const unoptimizedDistanceMeters = anyWindowConstrained
    ? outcomes.reduce((sum, o) => sum + (o.beforeMeters || 0), 0) + unassignedMeters
    : result.unoptimizedDistanceMeters;
  const totalDurationMinutes = Math.round(anyWindowConstrained
    ? outcomes.reduce((sum, o) => sum + (o.afterSeconds || 0), 0) / 60 + unassignedMinutes
    : result.totalDurationSeconds / 60);
  // SIGNED: the admin paths apply any legal repair without a savings floor,
  // so a board whose current order is itself infeasible can be repaired into
  // a LONGER route. Clamping that to "saving ~0 miles" hides an increase from
  // the operator being asked to confirm it (codex round 5 P2). savedDistance
  // stays clamped for the existing response contract; distanceChange carries
  // the truth.
  const distanceChangeMeters = totalDistanceMeters - unoptimizedDistanceMeters;
  const savedDistanceMeters = Math.max(0, -distanceChangeMeters);
  return {
    totalDurationMinutes,
    totalDistanceMeters,
    unoptimizedDistanceMeters,
    savedDistanceMeters,
    distanceChangeMeters,
    addedDistanceMeters: Math.max(0, distanceChangeMeters),
    savedPercent: unoptimizedDistanceMeters > 0
      ? Math.round((savedDistanceMeters / unoptimizedDistanceMeters) * 100) : 0,
  };
}

/**
 * Full guard-input signature for the commit-time staleness fence: window
 * RANGE + service duration + the staff-pin flags + the linked visit — the
 * chronology AND feasibility guards (and, for a linked visit, its identity)
 * were evaluated against these, so any mid-run change invalidates the order
 * that was computed for it. Shared by this pass's own commit-time re-read
 * (below) and the admin optimize endpoints' post-lock re-validation (codex
 * GitHub round P2: those endpoints previously compared only id/date/
 * technician, so a window edited after the day-load but before the lock
 * could commit a stale order). `repairDurationFallback` mirrors this pass's
 * own `repair`-mode duration convention (0, not the flat-60 default) — admin
 * callers never set it, since neither admin endpoint runs the chronological-
 * repair path.
 */
function windowGuardSignature(stop, { repairDurationFallback = false } = {}) {
  const range = effectiveWindowRange(stop);
  const dur = workDuration(stop, repairDurationFallback ? 0 : 60);
  const locked = (stop.auto_dispatch_locked || stop.auto_dispatch_excluded) ? 'L' : '-';
  // Customer, EFFECTIVE premise and the RAW estimate ride along: they are
  // isCoVisitPair's own inputs and the merged on-site clock (#4435), and two
  // rows can hold workDuration steady while changing both — 20+20 → 20+50 is
  // 60 → 70 minutes on site with every span still 60. The premise is the
  // effective one because an unstamped row resolves through the customer's
  // primary address, which can be edited while stamped columns stay put.
  const eff = effectiveServiceAddress(stop, {
    address_line1: stop.customer_address_line1,
    address_line2: stop.customer_address_line2,
    city: stop.customer_city,
    state: stop.customer_state,
    zip: stop.customer_zip,
  });
  const premise = [eff.line1, eff.line2, eff.city, eff.zip]
    .map((v) => String(v ?? '').trim().toLowerCase()).join(',');
  const raw = Number(stop.estimated_duration_minutes) || 0;
  return `${range ? `${range.startMin}-${range.endMin}` : 'open'}|${dur}|${raw}|${locked}|${stop.visit_id || ''}|${stop.customer_id ?? ''}|${premise}`;
}

async function runRouteReorder(opts = {}, conn = db) {
  const config = getRouteReorderConfig(opts);
  const now = opts.now || new Date();
  const today = etDateString(now);
  const repairGates = ['GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION'];
  // Change-triggered runs can only repair the explicitly affected dates.
  // They never fall through to Google's discretionary distance optimizer.
  if (opts.repairOnly) repairGates.push('GATE_ROUTE_REORDER');
  const repairEnabled = repairGates.every(gateEnvValue);
  if (opts.repairOnly && !repairEnabled) return { status: 'gate_off' };
  const lastDate = etDateString(addETDays(now, 30));
  const dates = opts.repairOnly
    ? [...new Set((opts.dates || []).map(toDateStr))].filter(date => validCalendarDate(date) && date > today && date <= lastDate).sort()
    : Array.from({ length: TIER2_MIN_DAYS_OUT - 1 }, (_, index) => etDateString(addETDays(now, index + 1)));
  if (!dates.length) return { status: 'outside_planning_horizon' };
  const bandStart = dates[0];
  const bandEnd = dates.at(-1);
  const summary = {
    run_type: opts.repairOnly ? 'route_repair_change' : 'route_tiers_nightly',
    band: { start: bandStart, end: bandEnd },
    applied: [],
    skipped: [],
    failed: [],
  };
  const techIds = new Set();
  const qualityEnabled = gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS');
  if (qualityEnabled) summary.measurements = [];
  let status = 'completed';

  try {
    for (const dateStr of dates) {
      let stops;
      try {
        stops = await dayStopsQuery(conn, {
          dateStr,
          excludeStatuses: EXCLUDE_STATUSES,
          select: [
            'scheduled_services.id', 'scheduled_services.technician_id',
            'scheduled_services.customer_id',
            // Stamped street line: two units in one building share a parcel
            // centroid, so coordinates alone must not collapse them into one
            // physical stop (Codex #4435 r1 P1 — see isCoVisitPair).
            'scheduled_services.service_address_line1', 'scheduled_services.service_address_line2',
            'scheduled_services.service_address_city', 'scheduled_services.service_address_zip',
            // The customer's primary premise too: an UNSTAMPED row inherits
            // it, and comparing a bare stamp against nothing finds no
            // conflict where a real one exists (Codex #4435 r3 P1).
            {
              customer_address_line1: 'customers.address_line1',
              customer_address_line2: 'customers.address_line2',
              customer_city: 'customers.city',
              customer_state: 'customers.state',
              customer_zip: 'customers.zip',
            },
            'scheduled_services.route_order', 'scheduled_services.window_start',
            'scheduled_services.window_end', 'scheduled_services.visit_id',
            'scheduled_services.time_window',
            'scheduled_services.estimated_duration_minutes',
            'scheduled_services.auto_dispatch_locked', 'scheduled_services.auto_dispatch_excluded',
            'scheduled_services.service_type',
            'scheduled_services.zone', 'scheduled_services.created_at',
            ...guardedCoordSelects(conn),
          ],
        }).whereRaw(LIVE_HOLD_SQL);
      } catch (loadErr) {
        status = 'completed_with_errors';
        summary.failed.push({ date: dateStr, reason: 'LOAD_FAILED', error: loadErr.message });
        continue;
      }
      if (!stops || stops.length === 0) continue;

      const byTech = new Map();
      for (const s of stops) {
        if (!s.technician_id) continue;
        if (!byTech.has(s.technician_id)) byTech.set(s.technician_id, []);
        byTech.get(s.technician_id).push(s);
      }
      if (qualityEnabled) {
        const { measureDayQuality } = require('./scheduling/day-quality');
        const RouteOptimizer = require('./route-optimizer');
        for (const [techId, techStops] of byTech) {
          summary.measurements.push({ date: dateStr, technician_id: techId, as_of: now.toISOString(), snapshot_phase: 'loaded_schedule',
            drive_model: gateEnvValue('GATE_DRIVE_TIME_CALIBRATION') ? 'calibrated' : 'legacy',
            ...measureDayQuality(RouteOptimizer, techStops) });
        }
      }

      // ── Day-level freeze: ANY frozen visit freezes the whole day. ──
      const clockFrozen = stops.some((s) => withinFreezeClock(dateStr, s.window_start, now));
      if (clockFrozen && !repairEnabled) {
        summary.skipped.push({ date: dateStr, reason: 'WITHIN_72H', stops: stops.length });
        continue;
      }
      const freeze = await loadReminderFreeze(conn, stops.map((s) => s.id), now);
      if (freeze.failed) {
        // Fail closed AND fail loud — cannot prove no reminder went out for
        // this day, and an outage that silently disables the whole pass must
        // not leave the nightly run green (status + failed_count surface it
        // as an exception on the dispatch card).
        status = 'completed_with_errors';
        summary.failed.push({ date: dateStr, reason: 'REMINDER_STATUS_UNKNOWN', stops: stops.length });
        logger.error(`[route-reorder] ${dateStr}: reminder-freeze read failed — day frozen (fail closed)`);
        continue;
      }
      const reminderFrozen = stops.some((s) => freeze.frozen.has(s.id));
      if (reminderFrozen && !repairEnabled) {
        summary.skipped.push({ date: dateStr, reason: 'REMINDER_SENT_FROZEN', stops: stops.length });
        continue;
      }

      // ── Per tech-day reorder. Unassigned stops (no tech) have no route to
      // reorder within — they are left untouched and noted. ──
      const unassigned = stops.filter((s) => !s.technician_id).length;
      if (unassigned > 0) {
        summary.skipped.push({ date: dateStr, reason: 'UNASSIGNED_STOPS_LEFT_IN_PLACE', stops: unassigned });
      }

      for (const [techId, techStops] of byTech) {
        techIds.add(techId);
        const entryBase = { date: dateStr, technician_id: techId, stops: techStops.length };
        try {
          // Staff controls are absolute: auto_dispatch_locked (temporary)
          // and auto_dispatch_excluded (permanent) mark visits the
          // autonomous systems may not touch. Keep the WHOLE tech-day fixed
          // rather than reorder around a pinned stop (codex GitHub round
          // P2) — rewriting its neighbors would still change the pinned
          // visit's real position in the run.
          if (techStops.some((s) => s.auto_dispatch_locked || s.auto_dispatch_excluded)) {
            summary.skipped.push({ ...entryBase, reason: 'LOCKED_STOP' });
            continue;
          }
          const withCoords = techStops.filter((s) => parseFloat(s.lat) && parseFloat(s.lng));
          if (withCoords.length < 2) {
            summary.skipped.push({ ...entryBase, reason: 'TOO_FEW_GEOCODED_STOPS', geocoded: withCoords.length });
            continue;
          }
          if (withCoords.length !== techStops.length) {
            // A stop without usable coordinates has no defensible position in
            // an autonomously computed order (optimizeRoute would push it to
            // the end with zero evidence that's driveable). An operator can
            // make that call on the board; this pass skips the tech-day.
            summary.skipped.push({ ...entryBase, reason: 'COORDLESS_STOPS', geocoded: withCoords.length });
            continue;
          }
          if (summary.applied.length >= config.maxAppliesPerRun) {
            summary.skipped.push({ ...entryBase, reason: 'MAX_APPLIES_REACHED' });
            continue;
          }

          const RouteOptimizer = require('./route-optimizer');
          // Baseline = the current running order. Every stop must survive
          // the repair or optimizer; neither path may silently truncate it.
          const ordered = currentOrder(techStops);
          const repair = repairEnabled ? computeChronologicalRepair(RouteOptimizer, ordered) : null;
          if (!repair && withCoords.length > GOOGLE_WAYPOINT_CAP) {
            // The pure repair never reaches Google's waypoint-limited API.
            logger.warn(`[route-reorder] ${dateStr} tech ${techId}: ${withCoords.length} geocoded stops exceeds the ${GOOGLE_WAYPOINT_CAP}-waypoint cap — day skipped, not truncated`);
            summary.skipped.push({ ...entryBase, reason: 'OVER_WAYPOINT_CAP', geocoded: withCoords.length });
            continue;
          }
          if (opts.repairOnly && !repair) {
            summary.skipped.push({ ...entryBase, reason: 'NO_SAFE_INSERTION' });
            continue;
          }
          if ((clockFrozen || reminderFrozen) && !repair) {
            summary.skipped.push({ ...entryBase, reason: clockFrozen ? 'WITHIN_72H' : 'REMINDER_SENT_FROZEN', repair: 'NO_SAFE_INSERTION' });
            continue;
          }
          const result = repair ? {
            orderedStops: repair.orderedStops,
            totalDistanceMeters: modelDistanceMeters(RouteOptimizer, repair.orderedStops),
            totalDurationSeconds: Math.round(repair.simulation.travelMin * 60),
            source: 'chronological_repair',
          } : await RouteOptimizer.optimizeRoute(
            ordered.map((s) => ({ id: s.id, lat: parseFloat(s.lat) || null, lng: parseFloat(s.lng) || null, serviceType: s.service_type })),
            { startLat: RouteOptimizer.HQ.lat, startLng: RouteOptimizer.HQ.lng, endAtStart: true, techId },
          );
          // PERMUTATION GUARD (uncapped audit P1): orderedStops is built from
          // the external API's waypoint-index list, and route-optimizer
          // defaults a missing list to [] — a missing/partial/duplicated
          // response would yield artificial "savings" against a truncated
          // route and then rewrite only a subset of the day's rows. Require
          // an exact, duplicate-free permutation of the input before any
          // savings math or write; anything else is a contract violation and
          // fails LOUD (degrades run status), never a quiet skip.
          const returnedIds = (result.orderedStops || []).map((s) => s.id);
          const returnedSet = new Set(returnedIds);
          if (returnedIds.length !== techStops.length
              || returnedSet.size !== returnedIds.length
              || techStops.some((s) => !returnedSet.has(s.id))) {
            status = 'completed_with_errors';
            summary.failed.push({ ...entryBase, reason: 'OPTIMIZER_RESULT_MISMATCH', returned: returnedIds.length });
            logger.error(`[route-reorder] ${dateStr} tech ${techId}: optimizer returned ${returnedIds.length} stops for ${techStops.length} — not a permutation, day untouched`);
            continue;
          }
          // SAME-MODEL before/after — never subtract Google road meters from a
          // straight-line baseline (codex round-2 P1).
          const beforeMeters = modelDistanceMeters(RouteOptimizer, ordered);
          const afterMeters = modelDistanceMeters(RouteOptimizer, result.orderedStops);
          const savedMeters = Math.max(0, beforeMeters - afterMeters);
          const metrics = {
            before_distance_meters: beforeMeters,
            after_distance_meters: afterMeters,
            optimizer_distance_meters: result.totalDistanceMeters || 0,
            after_duration_seconds: result.totalDurationSeconds || 0,
            saved_meters: savedMeters,
            source: result.source,
            ...(repair ? { before_window_feasible: false, after_window_feasible: true,
              distance_change_meters: afterMeters - beforeMeters } : {}),
          };
          // Window chronology + feasibility guard, THE SAME decision
          // chooseWindowSafeOrder makes for the admin optimize endpoints
          // (codex GitHub round P1 — this used to be a second, independent
          // implementation of the same safety decision): Google's order
          // passes both guards ⇒ kept; it fails and GATE_ROUTE_REORDER_WINDOW_FIT
          // + GATE_DRIVE_TIME_CALIBRATION are on ⇒ handed to the in-process
          // window-fit fallback; either gate off ⇒ byte-for-byte the
          // pre-fallback skip. `startMin` stays null (nightly never runs
          // today — the band starts tomorrow — so every call starts at the
          // shared 08:00 day-open, unlike the admin "day in progress" case).
          let finalOrdered = result.orderedStops;
          let appliedMetrics = metrics;
          const guardOutcome = chooseWindowSafeOrder({
            RouteOptimizer, googleOrder: result.orderedStops, sourceStops: techStops, googleSource: result.source, legs: result.legs,
          });
          // Savings floor for GOOGLE's order. Fallback ON + a guard conflict
          // defers the floor to the fallback's own check below: Google
          // optimizes ROUTED distance, so its (illegal) permutation can score
          // below the 805 m model floor while a legal permutation clears it —
          // exiting here would record BELOW_MIN_SAVINGS and never consult the
          // fallback (pre-push audit r3 P1). Exactly the original
          // `!windowFitEnabled || (!chronoConflict && !fitConflict)`, where
          // `windowFitEnabled` read GATE_ROUTE_REORDER_WINDOW_FIT ALONE:
          // true when Google's order was legal (conflict null) regardless of
          // the gates, or when that one flag is off. Calibration-off with a
          // conflict deliberately does NOT short-circuit here — it falls
          // through to the skip below so the ledger still records the
          // conflict plus `fallback: 'CALIBRATION_OFF'`.
          const gateStoodDown = guardOutcome.reason === 'WINDOW_FIT_GATE_OFF';
          if (!repair && savedMeters < config.minSavingsMeters
              && (guardOutcome.conflict === null || guardOutcome.gateOff === 'WINDOW_FIT')) {
            summary.skipped.push({ ...entryBase, reason: 'BELOW_MIN_SAVINGS', ...metrics });
            continue;
          }
          if (guardOutcome.orderedStops == null) {
            // guardOutcome.conflict is always set here — orderedStops is only
            // null inside the shared decision's post-conflict branch.
            const tag = gateStoodDown
              ? (guardOutcome.gateOff === 'CALIBRATION' ? { fallback: 'CALIBRATION_OFF' } : {})
              // NO_FEASIBLE_IMPROVEMENT (or, in principle, COORDLESS_STOPS —
              // this pass's own earlier COORDLESS_STOPS day-skip already
              // guarantees every stop reaching here is geocoded, so that
              // branch is unreachable in practice, same as before this
              // refactor).
              : { fallback: guardOutcome.reason };
            summary.skipped.push({ ...entryBase, reason: guardOutcome.conflict, ...metrics, ...tag });
            continue;
          }
          if (guardOutcome.source === 'window_constrained') {
            // The shared decision writes ANY legal repair it finds (the admin
            // buttons have no savings floor); this pass only ever reorders
            // when it is worth it — apply ITS OWN floor to the found order
            // before accepting it (nightly-only bookkeeping, not a duplicate
            // safety decision).
            const fallbackSaved = Math.max(0, guardOutcome.beforeMeters - guardOutcome.afterMeters);
            if (fallbackSaved < config.minSavingsMeters) {
              // The day stays skipped under its ORIGINAL reason — the
              // fallback tag records that the legal-order search ran and
              // found nothing worth writing (same 805 m floor, owner-ruled).
              summary.skipped.push({
                ...entryBase,
                reason: guardOutcome.conflict,
                ...metrics,
                fallback: 'NO_FEASIBLE_IMPROVEMENT',
                fallback_saved_meters: fallbackSaved,
              });
              continue;
            }
            // Legal order clears the same floor: apply it through the exact
            // fenced write below (zero new writers). unconstrained_saved_meters
            // records what Google's illegal order would have saved — the gap
            // the promises cost us, for the ledger/observability.
            finalOrdered = guardOutcome.orderedStops;
            appliedMetrics = {
              before_distance_meters: guardOutcome.beforeMeters,
              after_distance_meters: guardOutcome.afterMeters,
              optimizer_distance_meters: result.totalDistanceMeters || 0,
              after_duration_seconds: guardOutcome.afterSeconds,
              saved_meters: fallbackSaved,
              source: 'window_constrained',
              unconstrained_saved_meters: savedMeters,
            };
          }
          // else: Google's order (or, when `repair` is set, the already
          // chronologically-repaired order — guaranteed conflict-free by
          // computeChronologicalRepair, so it always lands here) was legal —
          // finalOrdered/appliedMetrics keep their defaults set above.

          // Same write as the trusted /optimize path (route_order = position),
          // but transactional AND revalidated at COMMIT time: the optimizer
          // call can take seconds, so inside the transaction the tech-day is
          // row-locked and re-read, and the write only proceeds when it still
          // matches the optimized snapshot — same membership (nothing added,
          // moved, cancelled, reassigned), same window_starts (the chronology
          // guard's inputs), and still unfrozen (the 15-min reminder cron may
          // have sent during the gap; freeze state is re-read on the trx).
          // Any drift rolls the whole tech-day back untouched.
          const stale = (msg) => Object.assign(new Error(msg), { code: 'STALE_TECH_DAY' });
          try {
            // SERIALIZABLE: FOR UPDATE locks existing rows but cannot stop a
            // phantom — a stop INSERTED/reassigned into this tech-day after
            // the membership SELECT. Serializable isolation predicate-locks
            // the read; a concurrent membership change aborts THIS transaction
            // with a serialization failure (40001), which is handled below as
            // a stale tech-day skip. Especially relevant while the 4:10
            // auto-dispatch run may still be applying moves under its own
            // advisory lock.
            await conn.transaction(async (trx) => {
              // MEMBERSHIP FENCE (codex GitHub round P1): the writers that can
              // add/reassign a stop onto this tech-day already serialize on
              // the tech-scoped 'slot-reserve' advisory xact lock — the
              // rebooker's move transaction (rebooker.js kept-tech lock),
              // slot-reservation.js estimate reserves, and createSelfBooking
              // all take `hashtext('slot-reserve'), hashtext('tech:date')`.
              // Taking the SAME lock here (blocking, xact-scoped) before the
              // membership read fences those writers for the duration of the
              // reorder commit: they queue behind us; anything that committed
              // before we got the lock is visible to the re-read below.
              // Single lock per trx (one tech-day), taken before any row
              // locks — no ordering inversion with the date→tech contract in
              // scheduling/occupancy.js (tech-lock-only is the accepted
              // slot-reservation pattern). The IB assign/swap/move tools hold
              // the same fence via scheduling/tech-day-lock.js AND null the
              // stop's route_order on entry.
              //
              // Deliberately NOT fenced: pure INSERT paths (appointment
              // creation, recurring top-ups, estimate acceptance). No insert
              // path anywhere sets route_order — only optimizer paths write
              // it — and every consumer orders COALESCE(route_order, 999),
              // so a stop inserted after this commit appends AFTER the
              // ordered run: deterministic, never interleaved, identical to
              // a booking landing after the shipped manual /optimize, and
              // folded in by the next nightly pass while the day is in band.
              // The fence's real job is writers that can CARRY or CLOBBER a
              // non-null route_order (reassign/move/swap/rebooker/manual
              // reorder mid-run — the latter caught by the commit guard's
              // route_order re-check).
              await trx.raw(
                'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
                ['slot-reserve', `${techId}:${dateStr}`],
              );
              const live = await trx('scheduled_services')
                .where('scheduled_services.scheduled_date', dateStr)
                .where('scheduled_services.technician_id', techId)
                .whereNotIn('scheduled_services.status', EXCLUDE_STATUSES)
                .whereRaw(LIVE_HOLD_SQL)
                // Lock the scheduled_services rows only — FOR UPDATE cannot
                // target the nullable side of the customers left join.
                .forUpdate('scheduled_services')
                .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
                .select('scheduled_services.id', 'scheduled_services.window_start',
                  'scheduled_services.window_end', 'scheduled_services.visit_id',
                  'scheduled_services.time_window',
                  'scheduled_services.estimated_duration_minutes',
                  'scheduled_services.auto_dispatch_locked', 'scheduled_services.auto_dispatch_excluded',
                  // Co-visit inputs: two rows can keep identical
                  // workDurations while their RAW estimates change the
                  // merged clock (20+20 → 20+50 is 60 → 70 minutes on site),
                  // and the merge itself keys on customer + premise (Codex
                  // #4435 r2 P1).
                  'scheduled_services.customer_id',
                  'scheduled_services.service_address_line1', 'scheduled_services.service_address_line2',
                  'scheduled_services.service_address_city', 'scheduled_services.service_address_zip',
                  // The customer's primary premise too — an unstamped row's
                  // merge identity lives there.
                  { customer_address_line1: 'customers.address_line1',
                    customer_address_line2: 'customers.address_line2',
                    customer_city: 'customers.city',
                    customer_state: 'customers.state',
                    customer_zip: 'customers.zip' },
                  'scheduled_services.route_order', ...guardedCoordSelects(trx));
              const num = (v) => (v == null || v === '' ? null : parseFloat(v));
              // Full guard-input signature (shared with the admin optimize
              // endpoints' own post-lock re-validation — see
              // windowGuardSignature above): window RANGE + service duration —
              // the chronology AND feasibility guards were evaluated against
              // these, so any mid-run change invalidates the order.
              const windowSig = (s) => windowGuardSignature(s, { repairDurationFallback: !!repair });
              const snapshot = new Map(techStops.map((s) => [s.id, {
                window: windowSig(s),
                routeOrder: s.route_order == null ? null : Number(s.route_order),
                lat: num(s.lat),
                lng: num(s.lng),
              }]));
              if (live.length !== techStops.length) throw stale('tech-day membership changed during the run');
              for (const row of live) {
                const snap = snapshot.get(row.id);
                if (!snap) throw stale(`stop ${row.id} joined the tech-day during the run`);
                const win = windowSig(row);
                if (win !== snap.window) throw stale(`stop ${row.id} window changed during the run`);
                // route_order too: a dispatcher's manual reorder landing while
                // the optimizer ran must WIN — never overwrite the operator's
                // newer order with the autonomous one (codex round-3 P1).
                const ro = row.route_order == null ? null : Number(row.route_order);
                if (ro !== snap.routeOrder) throw stale(`stop ${row.id} route_order changed during the run`);
                // Effective (divergence-guarded) coordinates too — the order
                // was computed FOR those points; an address/coord change
                // mid-optimization invalidates it (codex round-12 P1).
                if (num(row.lat) !== snap.lat || num(row.lng) !== snap.lng) {
                  throw stale(`stop ${row.id} coordinates changed during the run`);
                }
              }
              // Freeze re-check at commit time (fail closed on unreadable).
              const commitNow = opts.now || new Date();
              const commitFreeze = await loadReminderFreeze(trx, techStops.map((s) => s.id), commitNow);
              if (commitFreeze.failed) {
                // Guard OUTAGE, not a superseded day — must fail LOUD like the
                // day-level read (recorded as a failure, degrades run status),
                // while the throw still rolls the write back.
                throw Object.assign(new Error('reminder status unreadable at commit'), { code: 'REMINDER_GUARD_OUTAGE' });
              }
              if (repair && !repairGates.every(gateEnvValue)) {
                throw stale('route repair was disabled during the run');
              }
              if (etDateString(commitNow) >= dateStr) throw stale('the service day started during the run');
              if (!repair && techStops.some((s) => commitFreeze.frozen.has(s.id))) throw stale('a 72h reminder was sent during the run');
              if (!repair && techStops.some((s) => withinFreezeClock(dateStr, s.window_start, commitNow))) {
                throw stale('day entered the 72h freeze window during the run');
              }
              for (let i = 0; i < finalOrdered.length; i++) {
                const updated = await trx('scheduled_services')
                  .where({ id: finalOrdered[i].id })
                  .where('scheduled_date', dateStr)
                  .where('technician_id', techId)
                  .whereNotIn('status', EXCLUDE_STATUSES)
                  .update({ route_order: i + 1 });
                if (updated !== 1) throw stale(`stop ${finalOrdered[i].id} changed during the run`);
              }
            }, { isolationLevel: 'serializable' });
          } catch (writeErr) {
            if (writeErr.code === 'REMINDER_GUARD_OUTAGE') {
              // Fail closed AND loud: the reorder rolled back, and the outage
              // is a FAILURE (status + failed_count), never a quiet skip.
              status = 'completed_with_errors';
              summary.failed.push({ ...entryBase, reason: 'REMINDER_STATUS_UNKNOWN', error: writeErr.message });
              logger.error(`[route-reorder] ${dateStr} tech ${techId}: reminder-freeze read failed at commit — rolled back (fail closed)`);
              continue;
            }
            // 40001 = serialization_failure: a concurrent transaction touched
            // (or inserted into) this tech-day — same treatment as any other
            // superseded day: roll back, skip, never retry blindly.
            if (writeErr.code === '40001') {
              summary.skipped.push({ ...entryBase, reason: 'STALE_TECH_DAY', detail: 'serialization conflict — tech-day changed concurrently' });
              logger.warn(`[route-reorder] ${dateStr} tech ${techId}: serialization conflict — rolled back`);
              continue;
            }
            if (writeErr.code === 'STALE_TECH_DAY') {
              summary.skipped.push({ ...entryBase, reason: 'STALE_TECH_DAY', detail: writeErr.message });
              logger.warn(`[route-reorder] ${dateStr} tech ${techId}: superseded during the run — rolled back (${writeErr.message})`);
              continue;
            }
            throw writeErr;
          }
          summary.applied.push({ ...entryBase, ...appliedMetrics });
          if (qualityEnabled) {
            // Record the order that actually committed as well as the loaded
            // baseline, so later performance does not compare against the
            // defect this same run repaired.
            const finalIds = finalOrdered.map(stop => stop.id);
            summary.measurements.push({ date: dateStr, technician_id: techId, as_of: (opts.now || new Date()).toISOString(),
              snapshot_phase: 'applied_reorder', drive_model: gateEnvValue('GATE_DRIVE_TIME_CALIBRATION') ? 'calibrated' : 'legacy',
              ...require('./scheduling/day-quality').measureDayQuality(RouteOptimizer,
                techStops.map(stop => ({ ...stop, route_order: finalIds.indexOf(stop.id) + 1 }))) });
          }
          logger.info(`[route-reorder] ${dateStr} tech ${techId}: reordered ${withCoords.length} stops, saved ~${Math.round(appliedMetrics.saved_meters)} m (${appliedMetrics.source})`);
        } catch (techErr) {
          status = 'completed_with_errors';
          summary.failed.push({ ...entryBase, reason: 'ERROR', error: techErr.message });
          logger.error(`[route-reorder] ${dateStr} tech ${techId} failed: ${techErr.message}`);
        }
      }
    }
  } catch (fatal) {
    status = 'failed';
    summary.fatal_error = fatal.message;
    logger.error(`[route-reorder] run fatal: ${fatal.message}`);
  }

  // The existing nightly pass refreshes unresolved future-route cards.
  // Change-triggered repairs are followed by this check in their caller.
  if (!opts.repairOnly && qualityEnabled && gateEnvValue('GATE_SCHEDULE_QUALITY_ALERTS')) {
    const alerts = await require('./scheduling/quality-alerts').refreshScheduleQualityAlerts({ dates, now: opts.now }, conn);
    if (alerts.status === 'failed') {
      if (status === 'completed') status = 'completed_with_errors';
      summary.failed.push({ reason: 'QUALITY_ALERT_REFRESH_FAILED' });
    }
  }
  // ── Ledger: one route_optimization_planner_runs row per run. ──
  const ledger = await writeLedgerRow({ status, today, bandStart, bandEnd, techIds, config, summary }, conn);
  // A lost ledger row means the promised audit record is missing — the run
  // must surface as an exception, never report green (codex round-13 P1).
  const finalStatus = ledger == null && status === 'completed' ? 'completed_with_errors' : status;
  return { status: finalStatus, ledgerId: ledger, applied: summary.applied.length, skipped: summary.skipped.length, failed: summary.failed.length };
}

/** Summarize the same night's auto-dispatch day-move run for the ledger
 *  (best-effort — a read failure must not lose the reorder ledger row). */
async function loadAutoDispatchSummary(today, conn = db) {
  try {
    // THAT NIGHT'S CRON run specifically — a manual (possibly dry_run) run
    // started after 4:10 must not shadow it, or the ledger reports the wrong
    // (often zero) day-moves. triggered_by='cron' is stamped by audit.startRun
    // from the scheduler's runAutoDispatch({ triggeredBy: 'cron' }).
    // Latest cron run of ANY status — filtering to successful statuses let a
    // failed 4:10 run vanish from the ledger (run:null) or be shadowed by an
    // earlier successful run from the same day; a failed night must be
    // VISIBLE in the ledger, status preserved.
    const run = await conn('auto_dispatch_runs')
      .where('triggered_by', 'cron')
      .orderBy('created_at', 'desc')
      .first('id', 'status', 'mode', 'total_evaluated', 'total_skipped', 'total_recommended', 'total_changed', 'total_failed', 'created_at');
    if (!run || toDateStr(run.created_at) !== today) return { run: null, moves: [] };
    const moves = await conn('auto_dispatch_audit_logs')
      .where({ auto_dispatch_run_id: run.id, action: 'changed' })
      .select('scheduled_service_id', 'old_scheduled_date', 'new_scheduled_date', 'old_technician_id', 'new_technician_id', 'score_improvement')
      .limit(500);
    return {
      run: {
        id: run.id,
        status: run.status,
        mode: run.mode,
        evaluated: run.total_evaluated,
        skipped: run.total_skipped,
        recommended: run.total_recommended,
        changed: run.total_changed,
        failed: run.total_failed,
      },
      moves: moves.map((m) => ({
        scheduled_service_id: m.scheduled_service_id,
        from: toDateStr(m.old_scheduled_date),
        to: toDateStr(m.new_scheduled_date),
        old_technician_id: m.old_technician_id,
        new_technician_id: m.new_technician_id,
        improvement: m.score_improvement,
      })),
    };
  } catch (e) {
    return { run: null, moves: [], error: e.message };
  }
}

async function writeLedgerRow({ status, today, bandStart, bandEnd, techIds, config, summary }, conn = db) {
  try {
    const autoDispatch = summary.run_type === 'route_tiers_nightly' ? await loadAutoDispatchSummary(today, conn) : null;
    const includeMeasurements = summary.measurements && gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS');
    const [row] = await conn('route_optimization_planner_runs')
      .insert({
        run_type: summary.run_type,
        status,
        start_date: bandStart,
        end_date: bandEnd,
        technician_ids: JSON.stringify([...techIds]),
        service_types: JSON.stringify([]),
        constraints: JSON.stringify({
          gate: summary.run_type === 'route_repair_change' ? 'GATE_ROUTE_REORDER_REPAIR' : 'GATE_ROUTE_REORDER',
          repair_only: summary.run_type === 'route_repair_change',
          window_fit: gateEnvValue('GATE_ROUTE_REORDER_WINDOW_FIT'),
          min_savings_meters: config.minSavingsMeters,
          max_applies_per_run: config.maxAppliesPerRun,
          waypoint_cap: GOOGLE_WAYPOINT_CAP,
          freeze_hours: FREEZE_HOURS,
          repair_enabled: gateEnvValue('GATE_ROUTE_REORDER_REPAIR'),
          ...(includeMeasurements ? { day_quality_version: 2, code_revision: process.env.RAILWAY_GIT_COMMIT_SHA || null } : {}),
        }),
        result: JSON.stringify({
          reorders: summary.applied,
          skips: summary.skipped,
          failures: summary.failed,
          auto_dispatch: autoDispatch,
          ...(includeMeasurements ? { route_quality: summary.measurements } : {}),
          ...(summary.fatal_error ? { fatal_error: summary.fatal_error } : {}),
        }),
        applied_count: summary.applied.length,
        skipped_count: summary.skipped.length,
        failed_count: summary.failed.length,
      })
      .returning(['id']);
    return (row && (row.id || row)) || null;
  } catch (e) {
    logger.error(`[route-reorder] ledger insert failed: ${e.message}`);
    return null;
  }
}

/** Cron entry — double-checks the gate so a stale scheduler can never run it. */
async function runRouteReorderIfEnabled() {
  if (!gateEnvValue('GATE_ROUTE_REORDER')) return { status: 'gate_off' };
  return runRouteReorder();
}

/**
 * With GATE_ROUTE_REORDER off, runRouteReorder (and the nightly alert
 * reconciliation folded into it, just above) never runs at all — so with
 * the measurement + alert gates ON but reorder off, existing route-quality
 * defects never get an initial card and no card ever expires (codex #4295
 * r2 P2). This is the standalone nightly trigger for that case: same
 * six-date band as the full pass, no repair, no distance optimization, no
 * route_optimization_planner_runs row — just the alert reconciliation.
 * The scheduler calls this INSTEAD OF the reorder pass, never alongside
 * it, so a date is never reconciled twice by the same tick.
 */
async function runScheduleQualityAlertsOnly(now = new Date(), conn = db) {
  if (!gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS') || !gateEnvValue('GATE_SCHEDULE_QUALITY_ALERTS')) {
    return { status: 'gate_off' };
  }
  const dates = Array.from({ length: TIER2_MIN_DAYS_OUT - 1 }, (_, index) => etDateString(addETDays(now, index + 1)));
  return require('./scheduling/quality-alerts').refreshScheduleQualityAlerts({ dates, now }, conn);
}

/** Same fenced writer, limited to narrow repairs on affected future dates. */
async function runRouteRepairAfterChange({ dates, now } = {}, conn = db) {
  return runRouteReorder({ dates, now, repairOnly: true }, conn);
}

/**
 * Ledger a tick that could not run because the shared writer lock was held
 * (e.g. the 4:10 auto-dispatch run still active at 4:20). Without this row
 * the night looks identical to a successful run in job health — a skipped
 * tick must be visible as skipped, never as success-with-no-output.
 */
async function recordSkippedTick(reason, now = new Date()) {
  const bandStart = etDateString(addETDays(now, 1));
  const bandEnd = etDateString(addETDays(now, TIER2_MIN_DAYS_OUT - 1));
  try {
    const [row] = await db('route_optimization_planner_runs')
      .insert({
        run_type: 'route_tiers_nightly',
        status: 'skipped',
        start_date: bandStart,
        end_date: bandEnd,
        technician_ids: JSON.stringify([]),
        service_types: JSON.stringify([]),
        constraints: JSON.stringify({ gate: 'GATE_ROUTE_REORDER' }),
        result: JSON.stringify({ skip_reason: reason, reorders: [], skips: [], failures: [] }),
        applied_count: 0,
        skipped_count: 0,
        failed_count: 0,
      })
      .returning(['id']);
    return (row && (row.id || row)) || null;
  } catch (e) {
    logger.error(`[route-reorder] skipped-tick ledger insert failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  inProgressStartMin,
  loadTechDayOrigins,
  assertTechDayOriginsFresh,
  driveableStop: onRoute,
  ROUTE_WRITE_GUARD_COLUMNS,
  CUSTOMER_PREMISE_ALIASES,
  routeWriteGuardSignature,
  resolveWindowSafeOrderByTechDay,
  windowSafeFigures,
  runRouteReorder,
  runRouteReorderIfEnabled,
  runRouteRepairAfterChange,
  runScheduleQualityAlertsOnly,
  recordSkippedTick,
  getRouteReorderConfig,
  chooseWindowSafeOrder,
  // Real production callers: admin-schedule.js's post-lock staleness
  // re-validation reuses this SAME signature the shared decision was
  // evaluated against (codex GitHub round P2) rather than re-deriving it.
  windowGuardSignature,
  _internals: { currentOrder, modelDriveMinutes, effectiveWindowStart, effectiveWindowRange, violatesWindowFeasibility, withinFreezeClock, violatesWindowChronology, modelDistanceMeters, loadAutoDispatchSummary, EXCLUDE_STATUSES, GOOGLE_WAYPOINT_CAP },
};
