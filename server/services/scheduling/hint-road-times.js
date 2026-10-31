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
const { parkedMinutes, withDriveClockPark } = require('./drive-clock');

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

// A travel source's stored answer: createSchedulingTravel's lookupRaw keeps
// Google's own minutes (GATE_DRIVE_CLOCK adds its park minutes only when a
// caller reads, never into the caches below); a source without one is raw.
function rawLookup(source, leg) {
  return (source.lookupRaw || source.lookup).call(source, leg);
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

// Reserves `pro` traffic-aware and `plain` road-time lookups for `spender`
// against the durable ceilings (picker-road-spend.js), runs `send` (which
// returns { pro, plain } it never sent: its burst allowance, its deadline, a
// closed picker), and gives those back on the reservation's day. A refusal
// returns { allowed: false, reason } and `send` never runs.
async function buyWithinCeilings({ spender, pro = 0, plain = 0 }, send) {
  const spend = require('./picker-road-spend');
  const reserved = await spend.reserveRoadSpend({ spender, pro, plain });
  if (!reserved.allowed) return reserved;
  const unsent = await send();
  await spend.releaseRoadSpend({ spender, ...unsent, day: reserved.day });
  return { allowed: true, unsent };
}

/**
 * Re-price `chips` (summary hour rows that still carry GAP_LEGS). Returns new
 * objects with drive_in_minutes / detour_minutes from Google and
 * drive_source 'google', or the input numbers with drive_source 'estimate'.
 * Never throws.
 */
async function priceChipsOnRoads(chips, { travelFactory, now = () => Date.now(), paid = false, spender = null } = {}) {
  // Only gap chips (GAP_LEGS) are re-priced; a capacity chip stays an
  // estimate (Codex #6045 r9: its admission and numbers stay on the model).
  // An hour the route check already drove on Google (GATE_PICKER_ROAD_CHECK)
  // keeps that label.
  const estimate = (c) => ({ ...c, drive_source: c.drive_source === 'google' ? 'google' : 'estimate' });
  if (!Array.isArray(chips) || !chips.length) return [];
  // Staff only (Codex #6881 security): a technician's chips keep the model.
  if (!paid || !gateEnvValue('GATE_BEST_TIMES_ROAD_TIMES')) return chips.map(estimate);
  try {
    const t = now();
    const nowEt = etNow(t);
    const plans = chips.map((chip) => chipLegs(chip, nowEt));
    const missing = new Map();
    for (const legs of plans) {
      if (!legs) continue;
      for (const leg of Object.values(legs)) if (cachedMinutes(leg, t) == null) missing.set(legKey(leg), leg);
    }
    let travel = null;
    if (missing.size) {
      const factory = travelFactory || (() => {
        const RouteOptimizer = require('../route-optimizer');
        return RouteOptimizer.createSchedulingTravel({
          maxRequests: 30, maxElements: 60, budgetMs: DEADLINE_MS, sharedBudget: RouteOptimizer.hintTravelBudget,
        });
      });
      travel = factory();
      // Counted against the pickers' durable ceilings, like the route check.
      const bought = await buyWithinCeilings({ spender, pro: missing.size }, async () => {
        await travel.preload([...missing.values()]);
        return { pro: missing.size - travel.diagnostics().elements, plain: 0 };
      });
      if (!bought.allowed) return chips.map(estimate);
    }
    const minutesFor = (leg) => {
      const hit = cachedMinutes(leg, t);
      // GATE_DRIVE_CLOCK: the park minutes join a Google leg here, once.
      if (hit != null) return parkedMinutes(hit);
      const answer = travel && rawLookup(travel, leg);
      if (answer?.source !== 'google_traffic' || !Number.isFinite(answer.minutes)) return null;
      remember(leg, answer.minutes, t);
      return parkedMinutes(answer.minutes);
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
  if (offset < windows.traffic) return 'traffic';
  return offset < windows.traffic + windows.plain ? 'plain' : null;
}

// The departure Google is asked for (the cache key uses it too, in preload and
// lookup alike): the leg's part of the day; today never before the next whole
// hour. Every drive in today's simulation is still to come (the route goes on
// from the stop the tech is at), even one the simulation starts this minute or
// at an on-site job's estimated end already past (Codex #6881): Google answers
// no past departure, so it is asked for the next hour.
function trafficLeg(leg, nowEt) {
  const at = leg.departureMin < TRAFFIC_EDGES[0] ? TRAFFIC_TIMES[0]
    : leg.departureMin < TRAFFIC_EDGES[1] ? TRAFFIC_TIMES[1] : TRAFFIC_TIMES[2];
  const floor = leg.date === nowEt.date ? (Math.floor(nowEt.minute / 60) + 1) * 60 : 0;
  return { ...leg, departureMin: Math.max(at, floor) };
}

/**
 * One per request (or per batch of checks): what its travel sources may buy,
 * whether it was closed, and the legs one of them is already buying
 * (`claimed`: key -> settled when that purchase ends), so concurrent checks
 * never oversubscribe it or buy the same leg twice.
 */
function createPickerBudget({ signal = null, maxLookups = null } = {}) {
  // `maxLookups` = a cap on the request's lookups in all (a staff save's
  // purchase, GATE_SAVE_ROAD_BUY); unset = only the per-mode REQUEST_MAX.
  return { traffic: 0, plain: 0, signal, refused: null, claimed: new Map(), ...(maxLookups != null ? { maxLookups } : {}) };
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
 * `cacheOnly` = a staff save's check (GATE_SAVE_ROAD_TIMES): read the road
 * times the pickers already bought and buy nothing, so no Google call runs
 * inside a save's transaction.
 */
function createPickerTravel({ spender = null, budget = createPickerBudget(), factories = {}, now = () => Date.now(), cacheOnly = false } = {}) {
  const RouteOptimizer = require('../route-optimizer');
  const travelFor = { traffic: TRAFFIC_TRAVEL, plain: PLAIN_TRAVEL };
  const sources = {};
  for (const mode of Object.keys(MODES)) {
    sources[mode] = (factories[mode] || (() => RouteOptimizer.createSchedulingTravel({
      ...travelFor[mode], sharedBudget: RouteOptimizer.pickerTravelBudget, signal: budget.signal,
    })))();
  }
  // Read once per source, not per leg: lookup runs for every leg of every order
  // a search simulates, and reading the Eastern clock (two Intl formatters) per
  // leg made searches take 8-10 s in production (audit 10-28). The clock's
  // answer changes once a minute (Eastern offsets are whole hours), so one read
  // a minute gives the same keys.
  const windows = roadWindows();
  let clock = { minute: null, et: null };
  const etAt = (t) => {
    const minute = Math.floor(t / 60000);
    if (minute !== clock.minute) clock = { minute, et: etNow(t) };
    return clock.et;
  };
  // The leg as Google is asked for it, with its mode and key; null = the model.
  const resolve = (leg, nowEt) => {
    const mode = legMode(leg, nowEt, windows);
    if (!mode) return null;
    const asLeg = MODES[mode].shape(leg, nowEt);
    return { mode, asLeg, key: MODES[mode].key(asLeg) };
  };
  function lookup(leg) {
    const t = now();
    const r = resolve(leg, etAt(t));
    // Past legs and later days: never asked, so the conservative model.
    if (!r) return sources.traffic.lookup(leg);
    const m = MODES[r.mode];
    const hit = m.cached(r.key, r.asLeg, t);
    // GATE_DRIVE_CLOCK: the park minutes join a Google leg on this read only;
    // both caches hold Google's own minutes.
    if (hit != null) return withDriveClockPark({ minutes: hit, source: m.source, reason: null });
    const answer = rawLookup(sources[r.mode], r.asLeg);
    if (answer?.source === m.source && Number.isFinite(answer.minutes)) m.remember(r.key, r.asLeg, answer.minutes, t);
    return withDriveClockPark(answer);
  }
  // Buys `entries` ([key, leg as Google is asked for it]) from the mode's
  // source; returns how many it never sent and how many Google answered.
  async function buy(mode, entries) {
    if (!entries.length) return { unsent: 0, answered: 0 };
    const m = MODES[mode];
    const before = sources[mode].diagnostics().elements;
    await sources[mode].preload(entries.map(([, leg]) => leg));
    // Keep what Google answered in the process cache under the key it was
    // bought for (the leg is already shaped: never shape it twice), so the
    // other checks of this request, the next search, or the next picker for
    // this visit ask nothing (pre-push audit #6881).
    const t = now();
    let answered = 0;
    for (const [key, leg] of entries) {
      const answer = rawLookup(sources[mode], leg);
      if (answer?.source !== m.source || !Number.isFinite(answer.minutes)) continue;
      m.remember(key, leg, answer.minutes, t);
      answered += 1;
    }
    return { unsent: entries.length - (sources[mode].diagnostics().elements - before), answered };
  }
  // Buys the claimed legs within the durable ceilings; what was never bought
  // (refused, or never sent) leaves the request's budget too. A sent lookup is
  // paid whether Google answered it or not (an error or a timeout keeps the
  // model), so each purchase logs both counts.
  async function purchase(want) {
    let answered = 0;
    const bought = await buyWithinCeilings({ spender, pro: want.traffic.length, plain: want.plain.length }, async () => {
      const [pro, plain] = await Promise.all([buy('traffic', want.traffic), buy('plain', want.plain)]);
      answered = pro.answered + plain.answered;
      return { pro: pro.unsent, plain: plain.unsent };
    });
    const unsent = bought.allowed ? bought.unsent : { pro: want.traffic.length, plain: want.plain.length };
    if (!bought.allowed) budget.refused = bought.reason;
    budget.traffic -= unsent.pro;
    budget.plain -= unsent.plain;
    const sent = want.traffic.length + want.plain.length - unsent.pro - unsent.plain;
    if (sent > 0) logger.info(`[picker-road] ${sent} lookups sent, ${answered} answered by Google`);
  }
  return {
    async preload(legs) {
      if (cacheOnly || budget.signal?.aborted || budget.refused) return;
      const t = now();
      const nowEt = etAt(t);
      const want = { traffic: [], plain: [] };
      const waits = new Set();
      let settle;
      const settled = new Promise((done) => { settle = done; });
      for (const leg of legs) {
        const r = resolve(leg, nowEt);
        if (!r || MODES[r.mode].cached(r.key, r.asLeg, t) != null) continue;
        // Another check of this request is buying it: wait for that answer.
        if (budget.claimed.has(r.key)) { waits.add(budget.claimed.get(r.key)); continue; }
        if (budget[r.mode] >= REQUEST_MAX[r.mode]) continue;
        if (budget.maxLookups != null && budget.traffic + budget.plain >= budget.maxLookups) continue;
        // Claimed before any await, so concurrent checks cannot oversubscribe.
        budget[r.mode] += 1;
        budget.claimed.set(r.key, settled);
        want[r.mode].push([r.key, r.asLeg]);
      }
      try {
        if (want.traffic.length || want.plain.length) await purchase(want);
      } finally {
        settle();
      }
      await Promise.all(waits);
    },
    lookup,
  };
}

module.exports = {
  priceChipsOnRoads, createPickerTravel, createPickerBudget, roadWindows, onRoads,
  _test: { roadCache, plainCache, chipLegs, trafficLeg, legMode, REQUEST_MAX },
};
