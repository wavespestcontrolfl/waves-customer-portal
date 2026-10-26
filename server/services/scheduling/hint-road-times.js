/**
 * Real-road drive times for the best-times chips (owner 2026-10-06): the
 * engine still decides which hours fit with the straight-line model; this
 * re-prices only the few chips a picker shows, on Google's traffic-aware
 * route matrix at each leg's departure hour.
 *
 * Per chip, three legs: previous stop → this stop (the drive in), this stop
 * → next stop (the drive out) and previous → next (the drive the van makes
 * anyway). The day number is in + out − base, the same formula the engine
 * scores with. A chip whose legs do not ALL come back from Google keeps the
 * model's numbers and says so (`drive_source: 'estimate'`).
 *
 * Spend is bounded three ways: the hint's own allowance in route-optimizer
 * (hintTravelBudget — never customer booking's), a short deadline, and a
 * process cache of Google answers keyed by pin pair + date + departure
 * minute, so a re-pick of the same day asks Google for nothing.
 *
 * Behind GATE_BEST_TIMES_ROAD_TIMES, read at call time. Off (default): the
 * chips carry the model's numbers exactly as before.
 */

const { gateEnvValue } = require('../../config/feature-gates');
const { GAP_LEGS } = require('./find-time');
const logger = require('../logger');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
const DEADLINE_MS = 2500;
const roadCache = new Map();

function toMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// Route rows carry their pins as numeric strings (PostgreSQL numeric).
const pinKey = (p) => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;
const legKey = (leg) => `${leg.date}|${Math.ceil(leg.departureMin)}|${pinKey(leg.from)}>${pinKey(leg.to)}`;

function cachedMinutes(leg, now) {
  const hit = roadCache.get(legKey(leg));
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) { roadCache.delete(legKey(leg)); return null; }
  return hit.minutes;
}

function remember(leg, minutes, now) {
  if (roadCache.size >= CACHE_MAX) roadCache.delete(roadCache.keys().next().value);
  roadCache.set(legKey(leg), { minutes, at: now });
}

// A leg cannot leave in the past: Google refuses a past departure, so a
// same-day leg whose stop already ended leaves a minute from now instead
// (Codex #6045 r1). `nowEt` = { date, minute } in ET.
function notBefore(leg, nowEt) {
  if (!nowEt || leg.date !== nowEt.date || leg.departureMin > nowEt.minute) return leg;
  return { ...leg, departureMin: nowEt.minute + 1 };
}

// The three legs of one chip, or null when a neighbour has no pin (the
// engine already reports that chip's drive as unknown).
function chipLegs(chip, nowEt = null) {
  const g = chip[GAP_LEGS];
  const startMin = toMin(chip.start_time);
  if (!g || !g.prev || !g.next || !g.newStop || startMin == null) return null;
  const modelIn = Number(chip.drive_in_minutes) || 0;
  // From home base the van leaves just in time; from a stop it leaves when
  // that stop's window ends.
  const leaveForIn = g.prevIsHome ? Math.max(0, startMin - modelIn) : g.prevEndMin;
  return {
    in: notBefore({ date: chip.date, from: g.prev, to: g.newStop, departureMin: leaveForIn }, nowEt),
    out: notBefore({ date: chip.date, from: g.newStop, to: g.next, departureMin: startMin + (g.durationMinutes || 0) }, nowEt),
    // From home base the van leaves just in time for the next stop, so the
    // drive it makes anyway is priced at that hour, like the candidate's.
    base: notBefore({ date: chip.date, from: g.prev, to: g.next, departureMin: baseDeparture(g) }, nowEt),
  };
}

function baseDeparture(g) {
  if (!g.prevIsHome || !Number.isFinite(g.nextStartMin)) return g.prevEndMin;
  return Math.max(0, g.nextStartMin - (Number(g.baselineDriveMinutes) || 0));
}

function etNow(ms) {
  const { etParts, etDateString } = require('../../utils/datetime-et');
  const d = new Date(ms);
  const p = etParts(d);
  return { date: etDateString(d), minute: p.hour * 60 + p.minute };
}

/**
 * Re-price `chips` (summary hour rows that still carry GAP_LEGS). Returns new
 * objects with drive_in_minutes / detour_minutes from Google and
 * drive_source 'google', or the input numbers with drive_source 'estimate'.
 * Never throws.
 */
async function priceChipsOnRoads(chips, { travelFactory, now = () => Date.now() } = {}) {
  // Only gap chips (GAP_LEGS) are re-priced; a capacity chip stays an
  // estimate (Codex #6045 r9: its admission and numbers stay on the model).
  // An hour the route check already drove on Google (GATE_PICKER_ROAD_CHECK)
  // keeps that label.
  const estimate = (c) => ({ ...c, drive_source: c.drive_source === 'google' ? 'google' : 'estimate' });
  if (!Array.isArray(chips) || !chips.length) return [];
  if (!gateEnvValue('GATE_BEST_TIMES_ROAD_TIMES')) return chips.map(estimate);
  try {
    const t = now();
    const nowEt = etNow(t);
    const plans = chips.map((chip) => chipLegs(chip, nowEt));
    const missing = [];
    for (const legs of plans) {
      if (!legs) continue;
      for (const leg of Object.values(legs)) if (cachedMinutes(leg, t) == null) missing.push(leg);
    }
    let travel = null;
    if (missing.length) {
      const factory = travelFactory || (() => {
        const RouteOptimizer = require('../route-optimizer');
        return RouteOptimizer.createSchedulingTravel({
          maxRequests: 30, maxElements: 60, budgetMs: DEADLINE_MS, sharedBudget: RouteOptimizer.hintTravelBudget,
        });
      });
      travel = factory();
      await travel.preload(missing);
    }
    const minutesFor = (leg) => {
      const hit = cachedMinutes(leg, t);
      if (hit != null) return hit;
      const answer = travel?.lookup(leg);
      if (answer?.source !== 'google_traffic' || !Number.isFinite(answer.minutes)) return null;
      remember(leg, answer.minutes, t);
      return answer.minutes;
    };
    return chips.map((chip, i) => {
      const legs = plans[i];
      if (!legs) return estimate(chip);
      const inMin = minutesFor(legs.in);
      const outMin = minutesFor(legs.out);
      const baseMin = minutesFor(legs.base);
      if (inMin == null || outMin == null || baseMin == null) return estimate(chip);
      return {
        ...chip,
        drive_in_minutes: inMin,
        detour_minutes: Math.max(0, inMin + outMin - baseMin),
        drive_source: 'google',
      };
    });
  } catch (err) {
    logger.warn(`[find-time] road re-price failed (estimates kept): ${err.message}`);
    return chips.map(estimate);
  }
}

// The open-times list's own spend (owner 2026-10-26, "make it as accurate as
// possible, raise the limits if you have to"): four weeks of route gaps, not
// a handful of chips, so more requests in flight and a longer deadline than
// the chips' — still on the picker's allowance (hintTravelBudget).
const OPEN_TIMES_TRAVEL = { maxRequests: 240, maxElements: 600, budgetMs: 6000, workers: 12 };

function openTimesTravel() {
  const RouteOptimizer = require('../route-optimizer');
  return RouteOptimizer.createSchedulingTravel({ ...OPEN_TIMES_TRAVEL, sharedBudget: RouteOptimizer.hintTravelBudget });
}

// The route gap an hour sits in: same day, technician and neighbours.
function gapKey(date, hour) {
  const g = hour[GAP_LEGS];
  if (!g || !g.prev || !g.next || !g.newStop) return null;
  return `${date}|${hour.technician?.id ?? ''}|${pinKey(g.prev)}|${pinKey(g.next)}|${g.prevEndMin}`;
}

/**
 * The open-times list's day rows (GATE_OPEN_TIMES_BOX) priced on real roads:
 * every gap on the list, so Best ranks every date on Google's numbers rather
 * than on the straight-line model. A gap's hours share its neighbours — the
 * same drive in and the same drive the van makes anyway; only the drive out
 * leaves later — so the gap's first hour is priced and its numbers given to
 * the rest. Every hour carries drive_source: 'google', or 'estimate' when the
 * gate is off or a leg did not come back. Never throws.
 */
async function priceOpenTimesOnRoads(days, { travelFactory = openTimesTravel, now } = {}) {
  const firstOfGap = new Map();
  for (const day of days || []) {
    for (const hour of day.hours || []) {
      const key = gapKey(day.date, hour);
      if (key && !firstOfGap.has(key)) firstOfGap.set(key, { ...hour, date: day.date });
    }
  }
  const keys = [...firstOfGap.keys()];
  const priced = await priceChipsOnRoads([...firstOfGap.values()], { travelFactory, now });
  const byGap = new Map(keys.map((key, i) => [key, priced[i]]));
  return (days || []).map((day) => ({
    ...day,
    hours: (day.hours || []).map((hour) => {
      const p = byGap.get(gapKey(day.date, hour));
      if (p?.drive_source !== 'google') return { ...hour, drive_source: hour.drive_source === 'google' ? 'google' : 'estimate' };
      return { ...hour, drive_in_minutes: p.drive_in_minutes, detour_minutes: p.detour_minutes, drive_source: 'google' };
    }),
  }));
}

// Google inside the staff pickers' route check (GATE_PICKER_ROAD_CHECK, owner
// 2026-10-26: "we need to run Google inside the scheduling check itself").
// The check simulates every hour at every place on the route, so each leg
// leaves at many slightly different minutes. Departures are rounded up to
// the hour (never earlier, so a leg never asks for the past): one Google
// answer serves every simulation leaving in that hour. Answers live in the
// same 6-hour process cache as the chips, so a second look costs nothing.
// Per search: up to 1,200 legs (Google bills per leg; ~$12 at the traffic
// rate), so one search never spends more than that.
const PICKER_CHECK_TRAVEL = { maxRequests: 400, maxElements: 1200, budgetMs: 8000, workers: 16 };
const DEPARTURE_STEP_MIN = 60;

/**
 * A travel source for loadArrivalRouteContext ({ preload, lookup }, the
 * createSchedulingTravel shape) on the picker's allowance. A leg Google did
 * not answer gets the inner source's conservative model, labelled as such.
 */
function createPickerTravel({ factory, now = () => Date.now() } = {}) {
  const inner = (factory || (() => {
    const RouteOptimizer = require('../route-optimizer');
    return RouteOptimizer.createSchedulingTravel({ ...PICKER_CHECK_TRAVEL, sharedBudget: RouteOptimizer.hintTravelBudget });
  }))();
  const bucket = (leg) => ({ ...leg, departureMin: Math.ceil(leg.departureMin / DEPARTURE_STEP_MIN) * DEPARTURE_STEP_MIN });
  return {
    async preload(legs) {
      const t = now();
      const missing = legs.map(bucket).filter((leg) => cachedMinutes(leg, t) == null);
      if (missing.length) await inner.preload(missing);
    },
    lookup(leg) {
      const b = bucket(leg);
      const t = now();
      const hit = cachedMinutes(b, t);
      if (hit != null) return { minutes: hit, source: 'google_traffic', reason: null };
      const answer = inner.lookup(b);
      if (answer?.source === 'google_traffic' && Number.isFinite(answer.minutes)) remember(b, answer.minutes, t);
      return answer;
    },
  };
}

module.exports = { priceChipsOnRoads, priceOpenTimesOnRoads, createPickerTravel, _test: { roadCache, chipLegs } };
