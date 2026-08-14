/**
 * WINDOW-FIT FALLBACK for the nightly route-reorder pass (follow-up to
 * ROUTE-TIERS #3388, owner-ruled 2026-08-14).
 *
 * The nightly pass asks Google for the distance-optimal stop order and then
 * refuses to write any order that contradicts promised arrival windows
 * (chronology guard) or provably cannot be driven (feasibility guard). On
 * days where timed promises pin the route, Google's unconstrained order
 * fails those guards EVERY night and the day's savings are structurally
 * unreachable (first prod night: 3 of 5 days skipped WINDOW_ORDER_CONFLICT,
 * ~22 mi/night left on the table). This module computes the best LEGAL
 * order in-process instead:
 *
 *   - Backbone: stops with a promised window, in chronological order of
 *     their effective window start (the same anchor the chronology guard
 *     enforces). Distinct starts are never permuted — any other relative
 *     order is exactly what the guard exists to reject. EQUAL starts are a
 *     tie the guard explicitly permits in any order, so the exhaustive
 *     search explores every within-group permutation too (a specific tie
 *     order can be the only feasible or the cheapest one); the greedy path
 *     keeps ties in the caller-supplied current running order, which is
 *     deterministic and operator-visible.
 *   - Untimed stops: interleaved around the backbone. Small days get an
 *     exhaustive search over every backbone-preserving interleaving with
 *     infeasible-prefix pruning; days whose sequence count exceeds the
 *     cap get greedy cheapest-feasible insertion (globally cheapest
 *     feasible (stop, position) pair each round).
 *   - Every surviving candidate is scored under the ONE shared in-house
 *     leg model (modelDistanceMeters — the same model the savings floor is
 *     measured with), and the winner is re-checked against BOTH production
 *     guards before it is returned (owner ruling: model-authored orders are
 *     acceptable BECAUSE the guards are identical).
 *
 * This module is pure computation: no db, no gates, no writes. The caller
 * (route-reorder.js) owns the gate check, the savings floor, the ledger,
 * and the fenced SERIALIZABLE write — a window-fit order rejoins the exact
 * write path the Google order would have taken (zero new writers).
 *
 * The feasibility simulation here mirrors violatesWindowFeasibility's
 * model path minute-for-minute (HQ depart 08:00, fallback leg minutes,
 * estimated_duration_minutes default 60, waiting for a window to open is
 * fine, starting past the arrival deadline is not). The mirror is only a
 * search heuristic — the caller-supplied production guard has the final
 * word on the returned order.
 */

// Sequence-count ceiling for the exhaustive search. n stops with k timed in
// g equal-start groups have (n!/k!)·∏ gᵢ! backbone-preserving sequences
// (interleavings × within-tie permutations); beyond this we fall back to
// greedy insertion. 20k full-day simulations is comfortably sub-second at
// the 25-stop Google cap the caller already enforces.
const EXHAUSTIVE_SEQUENCE_CAP = 20000;

function sequenceCount(total, timed, groupSizes) {
  // (n!/k!)·∏ gᵢ! with an early cap so a 25-stop day never overflows.
  let count = 1;
  for (let i = timed + 1; i <= total; i++) {
    count *= i;
    if (count > EXHAUSTIVE_SEQUENCE_CAP) return count;
  }
  for (const g of groupSizes) {
    for (let i = 2; i <= g; i++) {
      count *= i;
      if (count > EXHAUSTIVE_SEQUENCE_CAP) return count;
    }
  }
  return count;
}

function stopDuration(stop) {
  return Number(stop.estimated_duration_minutes) > 0 ? Number(stop.estimated_duration_minutes) : 60;
}

/**
 * Advance the day simulation by one stop. state = { clock (minute-of-day),
 * prev ({lat,lng}), travelMin (cumulative) }. Returns the next state, or
 * null when the stop provably misses its promised arrival deadline —
 * making prefixes prunable: the clock only moves forward, so no suffix can
 * rescue a missed window.
 */
function advanceSim(RouteOptimizer, effectiveWindowRange, state, stop) {
  const lat = parseFloat(stop.lat);
  const lng = parseFloat(stop.lng);
  let travel = 0;
  let prev = state.prev;
  if (lat && lng) {
    travel = RouteOptimizer.fallbackLegMetrics(
      RouteOptimizer.haversine(prev.lat, prev.lng, lat, lng),
    ).minutes || 0;
    prev = { lat, lng };
  }
  let startMin = state.clock + travel;
  const range = effectiveWindowRange(stop);
  if (range) {
    if (startMin > range.endMin) return null;
    startMin = Math.max(startMin, range.startMin);
  }
  return { clock: startMin + stopDuration(stop), prev, travelMin: state.travelMin + travel };
}

/** Simulate a full sequence; null when infeasible, else total travel
 *  minutes including the return leg to HQ. */
function simulateSequence(RouteOptimizer, effectiveWindowRange, seq) {
  let state = { clock: 8 * 60, prev: RouteOptimizer.HQ, travelMin: 0 };
  for (const stop of seq) {
    state = advanceSim(RouteOptimizer, effectiveWindowRange, state, stop);
    if (!state) return null;
  }
  const returnMin = RouteOptimizer.fallbackLegMetrics(
    RouteOptimizer.haversine(state.prev.lat, state.prev.lng, RouteOptimizer.HQ.lat, RouteOptimizer.HQ.lng),
  ).minutes || 0;
  return state.travelMin + returnMin;
}

/** Exhaustive backbone-preserving interleaving search with prefix pruning.
 *  `groups` = the backbone as equal-start groups in chronological order:
 *  order BETWEEN groups is fixed (the chronology guard's rule); order
 *  WITHIN a group is explored (the guard permits any tie order, and a
 *  specific one can be the only feasible or the cheapest sequence —
 *  pre-push audit P1). */
function exhaustiveSearch(RouteOptimizer, guards, groups, untimed) {
  let best = null;
  let bestMeters = Infinity;
  const total = groups.reduce((n, g) => n + g.length, 0) + untimed.length;
  const used = new Array(untimed.length).fill(false);
  const groupUsed = groups.map((g) => new Array(g.length).fill(false));
  const seq = [];
  const recurse = (groupIdx, groupRemaining, state) => {
    if (seq.length === total) {
      const meters = guards.modelDistanceMeters(RouteOptimizer, seq);
      if (meters < bestMeters) {
        bestMeters = meters;
        best = [...seq];
      }
      return;
    }
    // Next stop is either any unused member of the CURRENT tie group (the
    // group must fully precede the next one) or any unused untimed stop.
    if (groupIdx < groups.length) {
      const group = groups[groupIdx];
      for (let i = 0; i < group.length; i++) {
        if (groupUsed[groupIdx][i]) continue;
        const next = advanceSim(RouteOptimizer, guards.effectiveWindowRange, state, group[i]);
        if (!next) continue;
        groupUsed[groupIdx][i] = true;
        seq.push(group[i]);
        if (groupRemaining === 1) recurse(groupIdx + 1, (groups[groupIdx + 1] || []).length, next);
        else recurse(groupIdx, groupRemaining - 1, next);
        seq.pop();
        groupUsed[groupIdx][i] = false;
      }
    }
    for (let i = 0; i < untimed.length; i++) {
      if (used[i]) continue;
      const next = advanceSim(RouteOptimizer, guards.effectiveWindowRange, state, untimed[i]);
      if (!next) continue;
      used[i] = true;
      seq.push(untimed[i]);
      recurse(groupIdx, groupRemaining, next);
      seq.pop();
      used[i] = false;
    }
  };
  recurse(0, (groups[0] || []).length, { clock: 8 * 60, prev: RouteOptimizer.HQ, travelMin: 0 });
  return best;
}

/** Greedy cheapest-feasible insertion for days above the exhaustive cap:
 *  start from the backbone (which must itself be feasible), then each round
 *  insert the globally cheapest feasible (untimed stop, position) pair. */
function greedyInsertion(RouteOptimizer, guards, backbone, untimed) {
  let seq = [...backbone];
  if (simulateSequence(RouteOptimizer, guards.effectiveWindowRange, seq) == null) return null;
  const remaining = [...untimed];
  while (remaining.length > 0) {
    let bestPick = null;
    for (let r = 0; r < remaining.length; r++) {
      for (let pos = 0; pos <= seq.length; pos++) {
        const candidate = [...seq.slice(0, pos), remaining[r], ...seq.slice(pos)];
        if (simulateSequence(RouteOptimizer, guards.effectiveWindowRange, candidate) == null) continue;
        const meters = guards.modelDistanceMeters(RouteOptimizer, candidate);
        if (!bestPick || meters < bestPick.meters) bestPick = { r, candidate, meters };
      }
    }
    if (!bestPick) return null; // some stop has no feasible position
    seq = bestPick.candidate;
    remaining.splice(bestPick.r, 1);
  }
  return seq;
}

/**
 * Compute the shortest LEGAL order for a tech-day whose Google order failed
 * the window guards. `stops` is the tech-day (the caller has already
 * ensured every stop is geocoded); `guards` supplies the production guard
 * functions and the shared distance model so this module can never drift
 * from what route-reorder.js actually enforces:
 *   { effectiveWindowStart, effectiveWindowRange, violatesWindowChronology,
 *     violatesWindowFeasibility, modelDistanceMeters }
 * Returns { orderedStops, afterMeters, afterSeconds } or null when no
 * feasible order exists (or the winner fails a production guard — belt and
 * suspenders; by construction it should not).
 */
function computeWindowFitOrder(RouteOptimizer, stops, guards) {
  if (!Array.isArray(stops) || stops.length < 2) return null;
  const timed = [];
  const untimed = [];
  for (const s of stops) {
    if (guards.effectiveWindowStart(s) != null) timed.push(s);
    else untimed.push(s);
  }
  // Backbone in promised-start order, as equal-start GROUPS. The sort is
  // stable, so within a group stops keep the caller-supplied order — the
  // caller passes the CURRENT RUNNING order (currentOrder), making the
  // greedy path's tie order deterministic and operator-visible; the
  // exhaustive path explores tie permutations regardless.
  const backbone = [...timed].sort((a, b) => {
    const wa = guards.effectiveWindowStart(a);
    const wb = guards.effectiveWindowStart(b);
    if (wa !== wb) return wa < wb ? -1 : 1;
    return 0;
  });
  const groups = [];
  for (const s of backbone) {
    const start = guards.effectiveWindowStart(s);
    const last = groups[groups.length - 1];
    if (last && last.start === start) last.stops.push(s);
    else groups.push({ start, stops: [s] });
  }
  const groupStops = groups.map((g) => g.stops);

  const winner = sequenceCount(stops.length, backbone.length, groupStops.map((g) => g.length)) <= EXHAUSTIVE_SEQUENCE_CAP
    ? exhaustiveSearch(RouteOptimizer, guards, groupStops, untimed)
    : greedyInsertion(RouteOptimizer, guards, backbone, untimed);
  if (!winner) return null;

  // Owner ruling (2026-08-14): model-authored orders are acceptable BECAUSE
  // every candidate passes the SAME guards a Google order must pass —
  // re-check with the production functions before handing the order back.
  // legs = null is DELIBERATE, not a downgrade (pre-push audit P1 rebutted):
  // Google's legs describe ITS order's sequence — they do not exist for a
  // different permutation, and fetching routed legs per candidate is the
  // fleet-API spend this lane scoped out. The model path is the calibrated
  // two-term drive-time fit under GATE_DRIVE_TIME_CALIBRATION (live in
  // prod, MAE 3.89 min — the underestimation note on the guard describes
  // the LEGACY 30 mph constant), and the promises being protected are
  // 2-hour arrival windows, so the model's error is an order of magnitude
  // inside the slack. Any residual miss is also self-limiting: route_order
  // is a board ordering, the day re-evaluates every night, and dispatch
  // remains human-driven.
  if (guards.violatesWindowChronology(winner, stops)) return null;
  if (guards.violatesWindowFeasibility(RouteOptimizer, winner, stops, null)) return null;

  const travelMin = simulateSequence(RouteOptimizer, guards.effectiveWindowRange, winner);
  if (travelMin == null) return null;
  return {
    orderedStops: winner,
    afterMeters: guards.modelDistanceMeters(RouteOptimizer, winner),
    afterSeconds: Math.round(travelMin * 60),
  };
}

module.exports = {
  computeWindowFitOrder,
  _internals: { sequenceCount, simulateSequence, exhaustiveSearch, greedyInsertion, EXHAUSTIVE_SEQUENCE_CAP },
};
