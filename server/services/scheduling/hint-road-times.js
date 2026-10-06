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

const pinKey = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
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
    out: notBefore({
      date: chip.date, from: g.newStop, to: g.next,
      departureMin: Number.isFinite(g.outDepartureMin) ? g.outDepartureMin : startMin + (g.durationMinutes || 0),
    }, nowEt),
    base: notBefore({ date: chip.date, from: g.prev, to: g.next, departureMin: g.prevEndMin }, nowEt),
  };
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
  const estimate = (c) => ({ ...c, drive_source: 'estimate' });
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

module.exports = { priceChipsOnRoads, _test: { roadCache, chipLegs } };
