/**
 * Day re-plan planner (owner ruling 2026-11-03, PR 1 of 3): pure, deterministic, no database.
 *
 * Given one technician-day's stops it asks: if every movable stop could take a new arrival hour,
 * what order and hours drive the least? It simulates an order the same way the owner's 25-day
 * replay did (see simulate rules below), searches orders, and reports the best plan against the
 * day as it stands.
 *
 * Stop: { id, lat, lng, slotStartMin, slotWidthMin, workMin, movable, pref: null | {startMin, endMin} }
 *   slotStartMin  the stop's arrival hour today, in minutes from midnight (the promise is that hour
 *                 plus options.promiseMin).
 *   slotWidthMin  the booked window width. A fixed stop holds every hour its window covers
 *                 (floor(start/60) through ceil((start+width)/60) - 1, at least one); a movable stop
 *                 needs ceil(width/60) free hours from its new hour and holds them all, keeping its width.
 *   workMin       planned minutes on site.
 *   movable       false = FIXED: keeps slotStartMin and its arrival bound.
 *   pref          explicit customer time window (hard filter), or null.
 *
 * Simulation of an order (t = clock, prev = last point, drive = minutes driven):
 *   for each stop: d = legMin(prev, stop); drive += d; t += d.
 *   FIXED: slot = slotStartMin; infeasible when t > slot + promiseMin - marginMin.
 *   MOVABLE: h0 = floor(t / 60). Try hours h0-1 and h0: inside [firstHour, last start hour for closeMin], not held by
 *     another stop (all the hours its window covers), pref ok, t at or after the hour, and t - hour <= promiseMin - marginMin; take the
 *     first that passes. Else the first later hour (from max(firstHour, h0+1)) that is free and pref ok
 *     (the van waits). None = infeasible.
 *   Then t = max(t, slot); t += workMin; infeasible when t > dayEndMin. The drive back to the origin
 *   is added at the end. Hours held by FIXED stops are taken before the first stop (fixed stops may
 *   share an hour as booked); each movable stop takes one hour of its own.
 *
 * The current plan is every stop at its current slot (all treated fixed), in slot order, with
 * lateness allowed and reported. The search never ends later than the current plan.
 *
 * options.baselines ([{ name, order: [ids] }]): the orders the app reads the day in (stored route order, clock
 * order). Each is simulated as the current plan and the one that drives LEAST is used; the result's
 * current.baseline names it and current.baselineDrives lists all.
 *
 * options.blocks ([{ startMin, endMin }], the technician's unavailable intervals): a stop's service interval
 * [start, start + workMin) may not overlap one. A movable stop moves to a later legal hour; a fixed stop that
 * already overlapped a block as booked keeps its hour (listed in `grandfathered`) but the plan adds no new
 * overlap. options.closeMin: a movable stop's window (start + slotWidthMin) must end by it; firstHour is the
 * earliest start hour.
 *
 * options.blockedHours (array of hours 0..23) are held by rows that are not route stops; no movable stop takes
 * them, and they add no drive.
 *
 * Search: up to exactLimit stops, every order (depth-first, pruning prefixes that cannot win);
 * above it, local search (move one stop, reverse a segment) from the current order and from a
 * nearest-neighbour order. Tie-break: less drive, earlier end, fewer changed hours, then ids.
 */

const DEFAULT_OPTIONS = Object.freeze({
  promiseMin: 120,
  marginMin: 15,
  firstHour: 8,
  // The day closes here (minutes): a movable stop's window must end by it. The runner passes the night pass's
  // own DAY_CLOSE (candidate-slots.js after_hours); this is only the fallback for a bare call.
  closeMin: 17 * 60,
  minSavingMin: 10,
  exactLimit: 9,
});

const MAX_LOCAL_PASSES = 500;

// Hours held by stops are a bitmask (hour h = bit h); hours are 0..23.
function hourBit(hour) {
  return 1 << hour;
}

/** Mask of `count` hours starting at `startHour`. */
function hoursMask(startHour, count) {
  let mask = 0;
  for (let h = startHour; h < startHour + count; h += 1) mask |= hourBit(h);
  return mask;
}

/** Whole hours a booked window of this width covers when it starts on the hour (at least 1). */
function widthHours(stop) {
  return Math.max(1, Math.ceil((Number(stop.slotWidthMin) || 60) / 60));
}

/** The hours a FIXED stop's booked window covers: floor(start/60) through ceil((start+width)/60) - 1, at least 1. */
function fixedHoursMask(stop) {
  const first = Math.floor(stop.slotStartMin / 60);
  const last = Math.ceil((stop.slotStartMin + (Number(stop.slotWidthMin) || 60)) / 60) - 1;
  return hoursMask(first, Math.max(1, last - first + 1));
}

function resolveOptions(options) {
  const merged = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (options && options[key] != null && Number.isFinite(Number(options[key]))) merged[key] = Number(options[key]);
  }
  return merged;
}

/** Leg matrix: leg[i][j] for stops 0..n-1 and the origin as index n. */
function buildLegs(stops, origin, legMin) {
  const points = [...stops, origin];
  return points.map((a, i) => points.map((b, j) => (i === j ? 0 : Number(legMin(a, b)) || 0)));
}

/** Sorted, valid { startMin, endMin } intervals the technician is unavailable. */
function cleanBlocks(blocks) {
  return (blocks || [])
    .filter((b) => b && Number.isFinite(b.startMin) && Number.isFinite(b.endMin) && b.endMin > b.startMin)
    .sort((a, b) => a.startMin - b.startMin);
}

/** True when a service interval [start, start + work) overlaps any block. */
function hitsBlock(blocks, start, work) {
  return blocks.some((b) => start < b.endMin && start + work > b.startMin);
}

function buildContext(stops, origin, departureMin, legMin, options) {
  const opts = resolveOptions(options);
  const blocks = cleanBlocks(options && options.blocks);
  // A fixed stop that already overlaps a block as booked keeps its hour (grandfathered); a plan may not add overlaps.
  const grandfathered = new Set();
  stops.forEach((s, i) => {
    if (!s.movable && hitsBlock(blocks, s.slotStartMin, s.workMin)) grandfathered.add(i);
  });
  let fixedMask = 0;
  for (const s of stops) {
    if (!s.movable) fixedMask |= fixedHoursMask(s);
  }
  // Hours held by rows that are NOT this day's route stops (unassigned visits, other technicians' visits):
  // no movable stop may take them, and they add no drive.
  for (const hour of (options && options.blockedHours) || []) {
    if (Number.isInteger(hour) && hour >= 0 && hour < 31) fixedMask |= hourBit(hour);
  }
  return {
    stops,
    n: stops.length,
    leg: buildLegs(stops, origin, legMin),
    departureMin,
    opts,
    bound: opts.promiseMin - opts.marginMin,
    fixedMask,
    blocks,
    grandfathered,
    dayEndMin: Infinity,
  };
}

function prefAllows(pref, hour) {
  if (!pref) return true;
  return hour * 60 >= pref.startMin && hour * 60 < pref.endMin;
}

/** Last start hour whose window still ends by the day's close (the night pass's after_hours rule). */
function lastStartHour(ctx, stop) {
  return Math.floor((ctx.opts.closeMin - (Number(stop.slotWidthMin) || 60)) / 60);
}

function hourUsable(ctx, stop, hour, used) {
  if (hour < ctx.opts.firstHour || hour > lastStartHour(ctx, stop)) return false;
  // A movable stop holds every hour its own window covers, so all of them must be free.
  return (used & hoursMask(hour, widthHours(stop))) === 0 && prefAllows(stop.pref, hour);
}

/** The arrival hour (minutes) a movable stop takes when the van gets there at t, or null. */
function pickHour(ctx, stop, t, used) {
  const h0 = Math.floor(t / 60);
  // The service itself ([start, start + work)) may not run through a block.
  const clear = (hour) => !hitsBlock(ctx.blocks, Math.max(t, hour * 60), stop.workMin);
  for (const hour of [h0 - 1, h0]) {
    if (hourUsable(ctx, stop, hour, used) && t >= hour * 60 && t - hour * 60 <= ctx.bound && clear(hour)) return hour * 60;
  }
  for (let hour = Math.max(ctx.opts.firstHour, h0 + 1); hour <= lastStartHour(ctx, stop); hour += 1) {
    if (hourUsable(ctx, stop, hour, used) && clear(hour)) return hour * 60;
  }
  return null;
}

/** One stop appended to a partial plan; null when that makes the plan infeasible. */
function step(ctx, state, idx) {
  const stop = ctx.stops[idx];
  const d = ctx.leg[state.prev][idx];
  let t = state.t + d;
  let used = state.used;
  let slot;
  if (stop.movable) {
    slot = pickHour(ctx, stop, t, used);
    if (slot == null) return null;
    used |= hoursMask(slot / 60, widthHours(stop));
  } else {
    slot = stop.slotStartMin;
    if (t > slot + ctx.bound) return null;
    if (!ctx.grandfathered.has(idx) && hitsBlock(ctx.blocks, Math.max(t, slot), stop.workMin)) return null;
  }
  if (t < slot) t = slot;
  t += stop.workMin;
  if (t > ctx.dayEndMin) return null;
  return { t, prev: idx, drive: state.drive + d, used, slot };
}

function startState(ctx) {
  return { t: ctx.departureMin, prev: ctx.n, drive: 0, used: ctx.fixedMask, slot: null };
}

/** Full simulation of one order (array of stop indexes); null when infeasible. */
function evaluate(ctx, order) {
  let state = startState(ctx);
  const slots = new Array(ctx.n);
  for (const idx of order) {
    state = step(ctx, state, idx);
    if (!state) return null;
    slots[idx] = state.slot;
  }
  return finish(ctx, state, order, slots);
}

function finish(ctx, state, order, slots) {
  return {
    driveMin: state.drive + ctx.leg[state.prev][ctx.n],
    endMin: state.t,
    order: order.slice(),
    slots: slots.slice(),
  };
}

function changedCount(ctx, plan) {
  let count = 0;
  for (let i = 0; i < ctx.n; i += 1) {
    if (plan.slots[i] !== ctx.stops[i].slotStartMin) count += 1;
  }
  return count;
}

function compareIds(ctx, a, b) {
  for (let i = 0; i < a.order.length; i += 1) {
    const x = String(ctx.stops[a.order[i]].id);
    const y = String(ctx.stops[b.order[i]].id);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Negative when plan a beats plan b. */
function comparePlans(ctx, a, b) {
  if (a.driveMin !== b.driveMin) return a.driveMin - b.driveMin;
  if (a.endMin !== b.endMin) return a.endMin - b.endMin;
  const changed = changedCount(ctx, a) - changedCount(ctx, b);
  if (changed !== 0) return changed;
  return compareIds(ctx, a, b);
}

function betterPlan(ctx, candidate, best) {
  return !best || comparePlans(ctx, candidate, best) < 0;
}

/** Every order, depth first. A prefix is pruned when it is infeasible or already drives more than the best plan. */
function exhaustiveSearch(ctx) {
  let best = null;
  const order = [];
  const slots = new Array(ctx.n);
  const taken = new Array(ctx.n).fill(false);
  const visit = (state) => {
    if (order.length === ctx.n) {
      const plan = finish(ctx, state, order, slots);
      if (betterPlan(ctx, plan, best)) best = plan;
      return;
    }
    for (let idx = 0; idx < ctx.n; idx += 1) {
      if (taken[idx]) continue;
      const next = step(ctx, state, idx);
      // Strictly more: an equal prefix can still tie on drive and win on the later tie-breaks.
      if (!next || (best && next.drive > best.driveMin)) continue;
      taken[idx] = true;
      order.push(idx);
      slots[idx] = next.slot;
      visit(next);
      order.pop();
      taken[idx] = false;
    }
  };
  visit(startState(ctx));
  return best;
}

function* neighbours(order) {
  const n = order.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const moved = order.filter((_, k) => k !== i);
      moved.splice(j, 0, order[i]);
      yield moved;
    }
  }
  for (let i = 0; i < n - 1; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      yield [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
    }
  }
}

/** First-improvement descent from one starting order; null when the start is infeasible. */
function descend(ctx, startOrder) {
  let best = evaluate(ctx, startOrder);
  if (!best) return null;
  for (let pass = 0; pass < MAX_LOCAL_PASSES; pass += 1) {
    let improved = false;
    for (const candidate of neighbours(best.order)) {
      const plan = evaluate(ctx, candidate);
      if (plan && comparePlans(ctx, plan, best) < 0) {
        best = plan;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  return best;
}

function nearestNeighbourOrder(ctx) {
  const left = new Set(ctx.stops.map((_, i) => i));
  const order = [];
  let prev = ctx.n;
  while (left.size) {
    let pick = null;
    for (const idx of left) {
      if (pick === null || ctx.leg[prev][idx] < ctx.leg[prev][pick]) pick = idx;
    }
    order.push(pick);
    left.delete(pick);
    prev = pick;
  }
  return order;
}

function currentOrderIndexes(stops) {
  return stops.map((_, i) => i).sort((a, b) => (stops[a].slotStartMin - stops[b].slotStartMin) || (a - b));
}

function localSearch(ctx) {
  const starts = [ctx.baseOrder, nearestNeighbourOrder(ctx)];
  let best = null;
  for (const start of starts) {
    const plan = descend(ctx, start);
    if (plan && betterPlan(ctx, plan, best)) best = plan;
  }
  return best;
}

/** The day as it stands: every stop fixed at its slot, slot order, lateness allowed and reported. */
/** The day as it stands, visited in `order` (stop indexes): every stop fixed at its slot, lateness reported. */
function simulateCurrent(ctx, order) {
  let t = ctx.departureMin;
  let prev = ctx.n;
  let drive = 0;
  const late = [];
  for (const idx of order) {
    const stop = ctx.stops[idx];
    const d = ctx.leg[prev][idx];
    drive += d;
    t += d;
    const over = t - (stop.slotStartMin + ctx.bound);
    if (over > 0) late.push({ id: stop.id, lateMin: over });
    if (t < stop.slotStartMin) t = stop.slotStartMin;
    t += stop.workMin;
    prev = idx;
  }
  return {
    driveMin: drive + ctx.leg[prev][ctx.n],
    endMin: t,
    order: order.map((i) => ctx.stops[i].id),
    slots: Object.fromEntries(ctx.stops.map((s) => [s.id, s.slotStartMin])),
    late,
  };
}

/**
 * The candidate current orders as stop indexes. Callers pass the orders the app itself reads (options.baselines:
 * [{ name, order: [ids] }], e.g. the stored route order and the clock order); one that does not name every stop
 * exactly once is ignored. With none left the day is read in slot order (ties by the caller's order).
 */
function baselineCandidates(ctx, baselines) {
  const byId = new Map(ctx.stops.map((s, i) => [String(s.id), i]));
  const out = [];
  for (const b of baselines || []) {
    const order = (b.order || []).map((id) => byId.get(String(id)));
    if (order.length === ctx.n && order.every((i) => i !== undefined) && new Set(order).size === ctx.n) out.push({ name: b.name, order });
  }
  return out.length ? out : [{ name: 'slot_order', order: currentOrderIndexes(ctx.stops) }];
}

/** Simulates every candidate and keeps the one that drives LEAST (never measure savings against the worse of two
 *  plausible current routes). A tie keeps the first listed, so the choice is deterministic. */
function chooseCurrent(ctx, baselines) {
  let chosen = null;
  const drives = {};
  for (const candidate of baselineCandidates(ctx, baselines)) {
    const sim = simulateCurrent(ctx, candidate.order);
    drives[candidate.name] = sim.driveMin;
    if (!chosen || sim.driveMin < chosen.sim.driveMin) chosen = { ...candidate, sim };
  }
  ctx.baseOrder = chosen.order;
  return { ...chosen.sim, baseline: chosen.name, baselineDrives: drives };
}

function describePlan(ctx, plan) {
  return {
    driveMin: plan.driveMin,
    endMin: plan.endMin,
    order: plan.order.map((i) => ctx.stops[i].id),
    slots: Object.fromEntries(ctx.stops.map((s, i) => [s.id, plan.slots[i]])),
  };
}

function slotChanges(ctx, plan) {
  return ctx.stops
    .map((s, i) => ({ id: s.id, fromMin: s.slotStartMin, toMin: plan.slots[i] }))
    .filter((c) => c.fromMin !== c.toMin);
}

function decide(current, best, minSavingMin) {
  if (!best) return { accepted: false, reason: 'no_feasible_order' };
  if (best.driveMin <= current.driveMin - minSavingMin) return { accepted: true, reason: 'accepted' };
  return { accepted: false, reason: 'saving_below_floor' };
}

/**
 * @param {{stops: object[], origin: {lat:number,lng:number}, departureMin: number,
 *          legMin: (a: object, b: object) => number, options?: object}} input
 * @returns {{current: object, best: object|null, accepted: boolean, reason: string,
 *            savedMin: number, changes: {id: string, fromMin: number, toMin: number}[]}}
 */
function planDay({ stops, origin, departureMin, legMin, options = {} }) {
  const ctx = buildContext(stops, origin, departureMin, legMin, options);
  const current = chooseCurrent(ctx, options.baselines);
  ctx.dayEndMin = current.endMin;
  const found = ctx.n <= ctx.opts.exactLimit ? exhaustiveSearch(ctx) : localSearch(ctx);
  const best = found ? describePlan(ctx, found) : null;
  const verdict = decide(current, best, ctx.opts.minSavingMin);
  return {
    current,
    best,
    ...verdict,
    savedMin: best ? current.driveMin - best.driveMin : 0,
    grandfathered: [...ctx.grandfathered].sort((a, b) => a - b).map((i) => ctx.stops[i].id),
    changes: found && verdict.accepted ? slotChanges(ctx, found) : [],
  };
}

module.exports = { planDay, DEFAULT_OPTIONS };
