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

// Google inside the staff pickers' route check (GATE_PICKER_ROAD_CHECK).
// Owner 2026-10-26: "we need to run Google inside the scheduling check
// itself"; 2026-10-27: run it on every create, reschedule and move, "we just
// have to make sure costs are appropriate". Measured on real routes (10-27
// replay, one technician): asking for every leg at every departure hour for
// seven days bought ~500 lookups (~$5) a search, 95-100% of them legs to and
// from the searched customer, which no cache can share between customers.
// So each leg gets the cheapest Google answer that still fits its day:
//   - today and tomorrow (PICKER_ROAD_TRAFFIC_DAYS, default 2): traffic-aware
//     (Google's "Pro" price, 1 cent a lookup) at three departure times a day
//     (09:00 before 11:00, 12:00 before 14:00, 16:00 after) instead of every
//     hour, so one answer serves every simulation leaving in that part of
//     the day; today never earlier than the next whole hour;
//   - the next days (PICKER_ROAD_PLAIN_DAYS, default 5): road time without
//     traffic ("Essentials", half a cent), one lookup per pair of places
//     whatever the hour;
//   - later days: the app's model ("~").
// Every lookup is reserved first against the per-request budget and the
// durable daily / monthly ceilings (picker-road-spend.js); refused, or a
// closed picker (the request's abort signal), = the model.
const TRAFFIC_TIMES = [9 * 60, 12 * 60, 16 * 60];
const TRAFFIC_EDGES = [11 * 60, 14 * 60];
// Per request (every travel source the request builds shares one budget):
// about five times a one-technician cold search (~31 traffic, ~60 plain).
const REQUEST_MAX = { traffic: 150, plain: 300 };
const TRAFFIC_TRAVEL = { maxRequests: 150, maxElements: REQUEST_MAX.traffic, budgetMs: 8000, workers: 8 };
const PLAIN_TRAVEL = { maxRequests: 60, maxElements: REQUEST_MAX.plain, budgetMs: 8000, workers: 4, traffic: false };
// A road time without traffic does not change from hour to hour.
const PLAIN_TTL_MS = 24 * 60 * 60 * 1000;
const PLAIN_CACHE_MAX = 20000;
const plainCache = new Map();

const pairKey = (leg) => `${pinKey(leg.from)}>${pinKey(leg.to)}`;

function plainCached(key, now) {
  const hit = plainCache.get(key);
  if (!hit) return null;
  if (now - hit.at > PLAIN_TTL_MS) { plainCache.delete(key); return null; }
  return hit.minutes;
}

function rememberPlain(key, minutes, now) {
  if (plainCache.size >= PLAIN_CACHE_MAX) plainCache.delete(plainCache.keys().next().value);
  plainCache.set(key, { minutes, at: now });
}

function envDays(name, fallback) {
  const raw = process.env[name];
  if (raw !== undefined && /^\s*\d+\s*$/.test(String(raw))) {
    const n = parseInt(raw, 10);
    if (n >= 0 && n <= 28) return n;
  }
  return fallback;
}

/** { traffic, plain } days from today on Google (read at call time). */
function roadWindows() {
  return { traffic: envDays('PICKER_ROAD_TRAFFIC_DAYS', 2), plain: envDays('PICKER_ROAD_PLAIN_DAYS', 5) };
}

function dayOffset(ymd, todayYmd) {
  return Math.round((Date.parse(`${ymd}T12:00:00Z`) - Date.parse(`${todayYmd}T12:00:00Z`)) / 86400000);
}

/** Whether `ymd` gets any Google answer (the finder attaches travel only then). */
function onRoads(ymd, todayYmd, windows = roadWindows()) {
  const offset = dayOffset(ymd, todayYmd);
  return offset >= 0 && offset < windows.traffic + windows.plain;
}

// 'traffic', 'plain', or null: the model.
function legMode(leg, nowEt, windows) {
  const offset = dayOffset(leg.date, nowEt.date);
  if (offset < 0) return null;
  if (offset < windows.traffic) {
    // A leg that has already left today: Google answers no past departure.
    return offset === 0 && leg.departureMin <= nowEt.minute ? null : 'traffic';
  }
  return offset < windows.traffic + windows.plain ? 'plain' : null;
}

// The departure Google is asked for (the cache key uses it too, in preload and
// lookup alike): the leg's part of the day; today never before the next whole
// hour.
function trafficLeg(leg, nowEt) {
  const at = leg.departureMin < TRAFFIC_EDGES[0] ? TRAFFIC_TIMES[0]
    : leg.departureMin < TRAFFIC_EDGES[1] ? TRAFFIC_TIMES[1] : TRAFFIC_TIMES[2];
  const floor = leg.date === nowEt.date ? (Math.floor(nowEt.minute / 60) + 1) * 60 : 0;
  return { ...leg, departureMin: Math.max(at, floor) };
}

/** One per request: what its travel sources may buy, and whether it was closed. */
function createPickerBudget({ signal = null } = {}) {
  return { traffic: 0, plain: 0, signal, refused: null };
}

// The two Google answers a leg can get: how it is keyed and cached.
const MODES = {
  traffic: {
    source: 'google_traffic',
    shape: trafficLeg,
    key: (leg) => legKey(leg),
    cached: (_key, leg, t) => cachedMinutes(leg, t),
    remember: (_key, leg, minutes, t) => remember(leg, minutes, t),
  },
  plain: {
    source: 'google_road',
    shape: (leg) => leg,
    key: pairKey,
    cached: (key, _leg, t) => plainCached(key, t),
    remember: (key, _leg, minutes, t) => rememberPlain(key, minutes, t),
  },
};

/**
 * A travel source for loadArrivalRouteContext ({ preload, lookup }, the
 * createSchedulingTravel shape). `spender` = the staff user the lookups are
 * reserved for; `budget` = the request's shared budget. A leg Google did not
 * answer gets the inner source's conservative model, labelled as such.
 */
function createPickerTravel({ spender = null, budget = createPickerBudget(), factories = {}, now = () => Date.now() } = {}) {
  const RouteOptimizer = require('../route-optimizer');
  const travelFor = { traffic: TRAFFIC_TRAVEL, plain: PLAIN_TRAVEL };
  const sources = {};
  for (const mode of Object.keys(MODES)) {
    sources[mode] = (factories[mode] || (() => RouteOptimizer.createSchedulingTravel({
      ...travelFor[mode], sharedBudget: RouteOptimizer.hintTravelBudget, signal: budget.signal,
    })))();
  }
  const asked = new Set();
  // The leg as Google is asked for it, with its mode and key; null = the model.
  const resolve = (leg, nowEt) => {
    const mode = legMode(leg, nowEt, roadWindows());
    if (!mode) return null;
    const asLeg = MODES[mode].shape(leg, nowEt);
    return { mode, asLeg, key: MODES[mode].key(asLeg) };
  };
  function lookup(leg) {
    const t = now();
    const r = resolve(leg, etNow(t));
    // Past legs and later days: never asked, so the conservative model.
    if (!r) return sources.traffic.lookup(leg);
    const m = MODES[r.mode];
    const hit = m.cached(r.key, r.asLeg, t);
    if (hit != null) return { minutes: hit, source: m.source, reason: null };
    const answer = sources[r.mode].lookup(r.asLeg);
    if (answer?.source === m.source && Number.isFinite(answer.minutes)) m.remember(r.key, r.asLeg, answer.minutes, t);
    return answer;
  }
  async function buy(mode, entries) {
    budget[mode] += entries.length;
    entries.forEach(([key]) => asked.add(key));
    await sources[mode].preload(entries.map(([, leg]) => leg));
    // Keep what Google answered in the process cache (lookup remembers), so
    // the next search, or the next picker for this visit, asks nothing.
    entries.forEach(([, leg]) => lookup(leg));
  }
  return {
    async preload(legs) {
      if (budget.signal?.aborted || budget.refused) return;
      const t = now();
      const nowEt = etNow(t);
      const want = { traffic: new Map(), plain: new Map() };
      for (const leg of legs) {
        const r = resolve(leg, nowEt);
        if (r && !asked.has(r.key) && MODES[r.mode].cached(r.key, r.asLeg, t) == null) want[r.mode].set(r.key, r.asLeg);
      }
      const take = (mode) => [...want[mode]].slice(0, Math.max(0, REQUEST_MAX[mode] - budget[mode]));
      const entries = { traffic: take('traffic'), plain: take('plain') };
      if (!entries.traffic.length && !entries.plain.length) return;
      const { reserveRoadSpend } = require('./picker-road-spend');
      const reserved = await reserveRoadSpend({ spender, pro: entries.traffic.length, plain: entries.plain.length });
      if (!reserved.allowed) { budget.refused = reserved.reason; return; }
      if (budget.signal?.aborted) return;
      await Promise.all(Object.keys(entries).filter((mode) => entries[mode].length).map((mode) => buy(mode, entries[mode])));
    },
    lookup,
  };
}

module.exports = {
  priceChipsOnRoads, createPickerTravel, createPickerBudget, roadWindows, onRoads,
  _test: { roadCache, plainCache, chipLegs, trafficLeg, legMode, REQUEST_MAX },
};
